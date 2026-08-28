import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import * as p from '@clack/prompts';

import { brightSelect } from '../lib/bright-select.js';
import { brandBody } from '../lib/theme.js';
import * as setupLog from '../logs.js';
import { removeEnvVar, upsertEnvVar } from '../set-env.js';
import { registerSetupProvider } from './registry.js';
import { CONTAINER_IMAGE } from '../../src/config.js';
import { CONTAINER_RUNTIME_BIN } from '../../src/container-runtime.js';

type Backend = 'catalog' | 'local' | 'custom' | 'skip';
type ChatGptLoginMethod = 'browser' | 'device';

export interface OpenCodeCatalogModel {
  id: string;
  name: string;
}

export interface OpenCodeCatalogProvider {
  id: string;
  name: string;
  api?: string;
  npm?: string;
  models: OpenCodeCatalogModel[];
}

export interface CredentialRoute {
  host: string;
  headerName: string;
  valueFormat: string;
}

const MAX_MODEL_DISCOVERY_BYTES = 1024 * 1024;
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const MODELS_DEV_URL = 'https://models.dev/api.json';
const MANUAL_MODEL = '__manual_model__';
const OPENCODE_AUTH_MODE = 'OPENCODE_AUTH_MODE';
const OPENCODE_CHATGPT_STUB = path.join('data', 'opencode', 'openai-auth-stub.json');
const ONECLI_SENTINEL = 'onecli-managed';
export const OPENCODE_CHATGPT_MODELS = ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.5', 'gpt-5.3-codex-spark'] as const;
// Far enough in the future that OpenCode never tries to exchange the sentinel
// refresh token. OneCLI owns refresh and replaces the sentinel bearer in flight.
const STUB_EXPIRES_AT = Date.UTC(2100, 0, 1);

function answer<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel('Setup cancelled.');
    process.exit(1);
  }
  return value as T;
}

function validHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return undefined;
  } catch {
    // handled below
  }
  return 'Enter an absolute http(s) URL.';
}

/** Clack returns undefined when an optional password prompt is submitted blank. */
export function normalizeOptionalInput(value: string | undefined): string {
  return value?.trim() ?? '';
}

/** Probe a container-facing OpenAI-compatible URL from the host setup process. */
export async function discoverLocalModelIds(
  baseUrl: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<string[]> {
  const url = new URL(baseUrl);
  if (url.hostname === 'host.docker.internal') url.hostname = '127.0.0.1';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/models`;
  url.search = '';
  url.hash = '';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_MODEL_DISCOVERY_BYTES) {
      throw new Error('response is too large');
    }
    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > MAX_MODEL_DISCOVERY_BYTES) throw new Error('response is too large');
    const payload = JSON.parse(body) as unknown;
    if (!payload || typeof payload !== 'object' || !Array.isArray((payload as Record<string, unknown>).data)) {
      throw new Error('response has no data array');
    }
    return [
      ...new Set(
        ((payload as Record<string, unknown>).data as unknown[])
          .flatMap((entry) => {
            if (!entry || typeof entry !== 'object') return [];
            const id = (entry as Record<string, unknown>).id;
            return typeof id === 'string' && id.trim() ? [id.trim()] : [];
          })
          .sort((a, b) => a.localeCompare(b)),
      ),
    ];
  } finally {
    clearTimeout(timeout);
  }
}

function saveKey(name: string, key: string, route: CredentialRoute): void {
  execFileSync(
    'onecli',
    [
      'secrets',
      'create',
      '--name',
      name,
      '--type',
      'generic',
      '--value',
      key,
      '--host-pattern',
      route.host,
      '--header-name',
      route.headerName,
      '--value-format',
      route.valueFormat,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

export async function discoverOpenCodeCatalog(
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<OpenCodeCatalogProvider[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetchImpl(MODELS_DEV_URL, { signal: controller.signal });
    if (!response.ok) throw new Error(`catalog returned HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_CATALOG_BYTES) throw new Error('catalog is too large');
    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > MAX_CATALOG_BYTES) throw new Error('catalog is too large');
    const payload = JSON.parse(body) as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('catalog is not an object');

    return Object.entries(payload as Record<string, unknown>)
      .flatMap(([catalogId, raw]) => {
        if (!raw || typeof raw !== 'object') return [];
        const entry = raw as Record<string, unknown>;
        const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : catalogId;
        const models = entry.models;
        if (!models || typeof models !== 'object') return [];
        const usable = Object.entries(models as Record<string, unknown>)
          .flatMap(([modelKey, value]) => {
            if (!value || typeof value !== 'object') return [];
            const model = value as Record<string, unknown>;
            const output = (model.modalities as Record<string, unknown> | undefined)?.output;
            if (Array.isArray(output) && !output.includes('text')) return [];
            const modelId = typeof model.id === 'string' && model.id.trim() ? model.id.trim() : modelKey;
            return [
              {
                id: `${id}/${modelId}`,
                name: typeof model.name === 'string' && model.name.trim() ? model.name.trim() : modelId,
              },
            ];
          })
          .sort((a, b) => a.name.localeCompare(b.name));
        if (!usable.length) return [];
        return [
          {
            id,
            name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : id,
            ...(typeof entry.api === 'string' && entry.api.trim() ? { api: entry.api.trim() } : {}),
            ...(typeof entry.npm === 'string' && entry.npm.trim() ? { npm: entry.npm.trim() } : {}),
            models: usable,
          },
        ];
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    clearTimeout(timeout);
  }
}

export function catalogCredentialDefaults(provider: OpenCodeCatalogProvider): CredentialRoute | undefined {
  const known: Record<string, CredentialRoute> = {
    anthropic: { host: 'api.anthropic.com', headerName: 'x-api-key', valueFormat: '{value}' },
    deepseek: { host: 'api.deepseek.com', headerName: 'Authorization', valueFormat: 'Bearer {value}' },
    google: { host: 'generativelanguage.googleapis.com', headerName: 'x-goog-api-key', valueFormat: '{value}' },
    groq: { host: 'api.groq.com', headerName: 'Authorization', valueFormat: 'Bearer {value}' },
    mistral: { host: 'api.mistral.ai', headerName: 'Authorization', valueFormat: 'Bearer {value}' },
    opencode: { host: 'opencode.ai', headerName: 'Authorization', valueFormat: 'Bearer {value}' },
    openai: { host: 'api.openai.com', headerName: 'Authorization', valueFormat: 'Bearer {value}' },
    openrouter: { host: 'openrouter.ai', headerName: 'Authorization', valueFormat: 'Bearer {value}' },
    xai: { host: 'api.x.ai', headerName: 'Authorization', valueFormat: 'Bearer {value}' },
  };
  return known[provider.id];
}

export function catalogCredentialHost(provider: OpenCodeCatalogProvider): string | undefined {
  if (!provider.api) return undefined;
  try {
    return new URL(provider.api).hostname;
  } catch {
    return undefined;
  }
}

function runInherit(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit', env });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

export function buildOpenCodeLoginArgs(loginDir: string, method: ChatGptLoginMethod, interactive: boolean): string[] {
  const label = method === 'device' ? 'ChatGPT Pro/Plus (headless)' : 'ChatGPT Pro/Plus (browser)';
  return [
    'run',
    '--rm',
    ...(interactive ? ['-i', '-t'] : ['-i']),
    '-v',
    `${loginDir}:/opencode-login`,
    ...(method === 'browser' ? ['-p', '127.0.0.1:1455:1455'] : []),
    '-e',
    'XDG_DATA_HOME=/opencode-login/data',
    '-e',
    'XDG_CONFIG_HOME=/opencode-login/config',
    '-e',
    'XDG_CACHE_HOME=/opencode-login/cache',
    '--entrypoint',
    'opencode',
    CONTAINER_IMAGE,
    'auth',
    'login',
    '--provider',
    'openai',
    '--method',
    label,
  ];
}

/** Replace live OpenCode OAuth tokens with OneCLI sentinels while retaining routing metadata. */
export function buildOpenCodeOAuthStub(authJson: unknown): Record<string, unknown> {
  if (!authJson || typeof authJson !== 'object') throw new Error('OpenCode auth.json is not an object');
  const openai = (authJson as Record<string, unknown>).openai;
  if (!openai || typeof openai !== 'object') throw new Error('OpenCode auth.json has no OpenAI entry');
  const record = openai as Record<string, unknown>;
  if (record.type !== 'oauth' || typeof record.access !== 'string' || typeof record.refresh !== 'string') {
    throw new Error('OpenCode did not create an OpenAI OAuth credential');
  }
  return {
    openai: {
      ...record,
      access: ONECLI_SENTINEL,
      refresh: ONECLI_SENTINEL,
      expires: STUB_EXPIRES_AT,
    },
  };
}

export async function runOpenCodeChatGptAuth(method: ChatGptLoginMethod): Promise<void> {
  const loginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-vault-login-'));
  const removeLoginDir = (): void => fs.rmSync(loginDir, { recursive: true, force: true });

  p.log.step(brandBody(method === 'device' ? 'Starting ChatGPT device pairing…' : 'Opening ChatGPT sign-in…'));
  const code = await runInherit(
    CONTAINER_RUNTIME_BIN,
    buildOpenCodeLoginArgs(loginDir, method, Boolean(process.stdin.isTTY && process.stdout.isTTY)),
    process.env,
  );
  if (code !== 0) {
    removeLoginDir();
    throw new Error('OpenCode ChatGPT sign-in did not complete');
  }

  const authPath = path.join(loginDir, 'data', 'opencode', 'auth.json');
  if (!fs.existsSync(authPath)) {
    removeLoginDir();
    throw new Error('OpenCode sign-in completed without writing auth.json');
  }

  try {
    const authJson = JSON.parse(fs.readFileSync(authPath, 'utf8')) as unknown;
    const stub = buildOpenCodeOAuthStub(authJson);
    execFileSync(
      'onecli',
      [
        'secrets',
        'create',
        '--name',
        'OpenCode ChatGPT',
        '--type',
        'openai',
        '--file',
        authPath,
        '--host-pattern',
        'chatgpt.com',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const stubPath = path.join(process.cwd(), OPENCODE_CHATGPT_STUB);
    fs.mkdirSync(path.dirname(stubPath), { recursive: true });
    fs.writeFileSync(stubPath, `${JSON.stringify(stub, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(stubPath, 0o600);
  } finally {
    removeLoginDir();
  }
}

export async function runOpenCodeAuthStep(): Promise<void> {
  const backend = answer(
    await brightSelect<Backend>({
      message: 'Which model backend should OpenCode use?',
      options: [
        {
          value: 'catalog',
          label: 'OpenCode provider catalog',
          hint: 'live providers and models from OpenCode’s catalog',
        },
        {
          value: 'local',
          label: 'Local or self-hosted',
          hint: 'vLLM, llama.cpp, or another OpenAI-compatible endpoint',
        },
        { value: 'custom', label: 'Custom provider', hint: 'provider id, model, optional base URL' },
        { value: 'skip', label: 'Skip for now', hint: 'configure OpenCode later' },
      ],
    }),
  );
  setupLog.userInput('opencode_backend', backend);

  if (backend === 'skip') {
    setupLog.step('auth', 'skipped', 0, { PROVIDER: 'opencode', REASON: 'user-skipped' });
    p.log.warn(brandBody('OpenCode configuration skipped. Re-run /add-opencode before using OpenCode groups.'));
    return;
  }

  let provider = '';
  let baseUrl = '';
  let catalogProvider: OpenCodeCatalogProvider | undefined;
  let chatgpt = false;
  if (backend === 'catalog') {
    let catalog: OpenCodeCatalogProvider[];
    try {
      catalog = await discoverOpenCodeCatalog();
    } catch (error) {
      setupLog.step('auth', 'failed', 0, {
        PROVIDER: 'opencode',
        BACKEND: backend,
        ERROR: error instanceof Error ? error.message : String(error),
      });
      p.log.error(
        brandBody(
          `Could not load OpenCode’s live provider catalog (${error instanceof Error ? error.message : String(error)}). Try again or choose Custom provider.`,
        ),
      );
      process.exit(1);
    }
    const selectedProvider = answer(
      await p.autocomplete<string>({
        message: 'Which provider should OpenCode connect to?',
        options: catalog.map((entry) => ({ value: entry.id, label: entry.name, hint: entry.id })),
        maxItems: 8,
      }),
    );
    catalogProvider = catalog.find((entry) => entry.id === selectedProvider)!;
    provider = catalogProvider.id;

    if (provider === 'openai') {
      const method = answer(
        await brightSelect<'chatgpt' | 'api_key'>({
          message: 'How would you like to connect OpenAI?',
          options: [
            { value: 'chatgpt', label: 'ChatGPT subscription', hint: 'Plus or Pro via OAuth' },
            { value: 'api_key', label: 'OpenAI API key', hint: 'pay-per-use platform API' },
          ],
        }),
      );
      chatgpt = method === 'chatgpt';
    }
  } else if (backend === 'local') {
    provider = 'openai';
    baseUrl = answer(
      await p.text({
        message: 'OpenAI-compatible base URL (include /v1)',
        placeholder: 'http://host.docker.internal:8000/v1',
        validate: (value) => validHttpUrl(String(value ?? '').trim()),
      }),
    ).trim();
  } else {
    provider = answer(
      await p.text({
        message: 'OpenCode provider id',
        placeholder: 'my-provider',
        validate: (v) => (String(v ?? '').trim() ? undefined : 'Required.'),
      }),
    )
      .trim()
      .toLowerCase();
    baseUrl = answer(
      await p.text({
        message: 'Custom API base URL (leave blank for OpenCode native configuration)',
        placeholder: 'https://api.example.com/v1',
        validate: (value) => (String(value ?? '').trim() ? validHttpUrl(String(value).trim()) : undefined),
      }),
    ).trim();
  }

  if (chatgpt) {
    const method = answer(
      await brightSelect<ChatGptLoginMethod>({
        message: 'How would you like to connect ChatGPT?',
        options: [
          { value: 'device', label: 'Device pairing', hint: 'recommended over SSH — shows a URL and code' },
          { value: 'browser', label: 'Browser sign-in', hint: 'opens a browser on this machine' },
        ],
      }),
    );
    setupLog.userInput('opencode_chatgpt_auth_method', method);
    try {
      await runOpenCodeChatGptAuth(method);
    } catch (error) {
      setupLog.step('auth', 'failed', 0, {
        PROVIDER: 'opencode',
        BACKEND: backend,
        ERROR: error instanceof Error ? error.message : String(error),
      });
      p.log.error(
        brandBody(
          `Could not connect ChatGPT (${error instanceof Error ? error.message : String(error)}). Re-run setup and try again.`,
        ),
      );
      process.exit(1);
    }
  }

  let discoveredModels: OpenCodeCatalogModel[] = [];
  if (chatgpt) {
    discoveredModels = OPENCODE_CHATGPT_MODELS.map((id) => ({ id: `${provider}/${id}`, name: id }));
  } else if (catalogProvider) {
    discoveredModels = catalogProvider.models;
  } else if (backend === 'local') {
    try {
      discoveredModels = (await discoverLocalModelIds(baseUrl)).map((id) => ({ id: `${provider}/${id}`, name: id }));
    } catch (error) {
      p.log.warn(
        brandBody(
          `Could not list models from this endpoint (${error instanceof Error ? error.message : String(error)}). Enter the model id manually.`,
        ),
      );
    }
  }

  let model = '';
  if (discoveredModels.length > 0) {
    const selected = answer(
      await p.autocomplete<string>({
        message: 'Which model should OpenCode use?',
        options: [
          ...discoveredModels.map((entry) => ({ value: entry.id, label: entry.name, hint: entry.id })),
          { value: MANUAL_MODEL, label: 'Enter a model id manually', hint: 'use a model not listed above' },
        ],
        maxItems: 8,
      }),
    );
    if (selected !== MANUAL_MODEL) model = selected;
  }
  if (!model) {
    model = answer(
      await p.text({
        message: 'Model id in provider/model form',
        placeholder: provider === 'openai' ? 'openai/my-model' : `${provider}/model-id`,
        validate: (value) => (String(value ?? '').includes('/') ? undefined : 'Use provider/model-id form.'),
      }),
    ).trim();
  }

  upsertEnvVar('OPENCODE_PROVIDER', provider);
  upsertEnvVar('OPENCODE_MODEL', model);
  upsertEnvVar('OPENCODE_SMALL_MODEL', model);
  if (baseUrl) upsertEnvVar('ANTHROPIC_BASE_URL', baseUrl);
  else removeEnvVar('ANTHROPIC_BASE_URL');
  let authMode = chatgpt ? 'chatgpt' : 'keyless';
  let key = '';
  if (!chatgpt) {
    const credentialMode = answer(
      await brightSelect<'enter' | 'existing' | 'keyless'>({
        message: 'How should this provider authenticate?',
        options: [
          { value: 'enter', label: 'Enter an API key', hint: 'save it to OneCLI now' },
          { value: 'existing', label: 'Already configured in OneCLI', hint: 'reuse a matching vault secret' },
          { value: 'keyless', label: 'No credential required', hint: 'local or explicitly keyless endpoint' },
        ],
      }),
    );
    authMode = credentialMode === 'keyless' ? 'keyless' : 'api_key';
    if (credentialMode === 'enter') {
      key = normalizeOptionalInput(
        answer(
          await p.password({
            message: 'API key',
            validate: (value) => (String(value ?? '').trim() ? undefined : 'Required.'),
          }),
        ),
      );
    }
  }
  if (key) {
    let route = catalogProvider ? catalogCredentialDefaults(catalogProvider) : undefined;
    if (!route) {
      const host =
        (catalogProvider ? catalogCredentialHost(catalogProvider) : undefined) ??
        (baseUrl
          ? new URL(baseUrl).hostname
          : answer(
              await p.text({
                message: 'Credential host pattern',
                placeholder: 'api.example.com',
                validate: (v) => (String(v ?? '').trim() ? undefined : 'Required.'),
              }),
            ).trim());
      const style = answer(
        await brightSelect<'bearer' | 'x-api-key' | 'x-goog-api-key' | 'custom'>({
          message: 'How does this provider send its API key?',
          options: [
            { value: 'bearer', label: 'Authorization: Bearer', hint: 'most OpenAI-compatible providers' },
            { value: 'x-api-key', label: 'x-api-key', hint: 'Anthropic-compatible providers' },
            { value: 'x-goog-api-key', label: 'x-goog-api-key', hint: 'Google-compatible providers' },
            { value: 'custom', label: 'Custom header', hint: 'enter the header and format' },
          ],
        }),
      );
      if (style === 'custom') {
        const headerName = answer(
          await p.text({
            message: 'Credential header name',
            placeholder: 'Authorization',
            validate: (v) => (String(v ?? '').trim() ? undefined : 'Required.'),
          }),
        ).trim();
        const valueFormat = answer(
          await p.text({
            message: 'Header value format (include {value})',
            placeholder: 'Bearer {value}',
            validate: (v) => (String(v ?? '').includes('{value}') ? undefined : 'Include {value}.'),
          }),
        ).trim();
        route = { host, headerName, valueFormat };
      } else {
        route = {
          host,
          headerName: style === 'bearer' ? 'Authorization' : style,
          valueFormat: style === 'bearer' ? 'Bearer {value}' : '{value}',
        };
      }
    }
    saveKey(`OpenCode ${provider}`, key, route);
  }
  upsertEnvVar(OPENCODE_AUTH_MODE, authMode);

  setupLog.step('auth', 'success', 0, { PROVIDER: 'opencode', BACKEND: backend });
  p.log.success(brandBody('OpenCode configured. Credentials, when supplied, live in OneCLI.'));
}

export async function checkOpenCodeInstall(): Promise<void> {
  const required = [
    'src/providers/opencode.ts',
    'container/agent-runner/src/providers/opencode.ts',
    'container/agent-runner/src/providers/mcp-to-opencode.ts',
  ];
  for (const file of required) {
    if (!fs.existsSync(path.join(process.cwd(), file))) throw new Error(`OpenCode payload is missing ${file}`);
  }
  const tools = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'container/cli-tools.json'), 'utf8')) as Array<{
    name: string;
    version: string;
    onlyBuilt?: boolean;
  }>;
  const cli = tools.find((entry) => entry.name === 'opencode-ai');
  if (cli?.version !== '1.18.21' || cli.onlyBuilt !== true) {
    throw new Error('OpenCode CLI must be pinned to 1.18.21 with trusted postinstall enabled');
  }
}

registerSetupProvider({
  value: 'opencode',
  label: 'OpenCode',
  hint: 'live OpenCode provider catalog or a local/custom endpoint',
  runAuth: runOpenCodeAuthStep,
  runInstallCheck: checkOpenCodeInstall,
});
