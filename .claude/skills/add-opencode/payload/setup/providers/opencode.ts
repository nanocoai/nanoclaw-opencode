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

type Backend = 'chatgpt' | 'local' | 'openrouter' | 'deepseek' | 'custom' | 'skip';
type ChatGptLoginMethod = 'browser' | 'device';

const MAX_MODEL_DISCOVERY_BYTES = 1024 * 1024;
const MANUAL_MODEL = '__manual_model__';
const OPENCODE_AUTH_MODE = 'OPENCODE_AUTH_MODE';
const OPENCODE_CHATGPT_STUB = path.join('data', 'opencode', 'openai-auth-stub.json');
const ONECLI_SENTINEL = 'onecli-managed';
export const OPENCODE_CHATGPT_MODELS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6', 'gpt-5.5'] as const;
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

function saveKey(name: string, key: string, host: string): void {
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
      host,
      '--header-name',
      'Authorization',
      '--value-format',
      'Bearer {value}',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
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

/**
 * Translate OpenCode's `auth.json` into the Codex-shaped OAuth record OneCLI recognises.
 *
 * OneCLI's ingest classifier and its gateway injector both key off
 * `tokens.access_token` / `tokens.refresh_token`; OpenCode writes
 * `openai.access` / `openai.refresh` / `openai.accountId` instead. Vaulting the
 * OpenCode file verbatim is classified as an opaque api-key, so the gateway
 * injects the whole JSON blob as a bearer and never refreshes it. Emitting this
 * shape instead is what makes the ChatGPT credential an `oauth` secret.
 */
export function buildOneCliOAuthSecret(authJson: unknown, now: Date = new Date()): Record<string, unknown> {
  if (!authJson || typeof authJson !== 'object') throw new Error('OpenCode auth.json is not an object');
  const openai = (authJson as Record<string, unknown>).openai;
  if (!openai || typeof openai !== 'object') throw new Error('OpenCode auth.json has no OpenAI entry');
  const record = openai as Record<string, unknown>;
  if (record.type !== 'oauth' || typeof record.access !== 'string' || typeof record.refresh !== 'string') {
    throw new Error('OpenCode did not create an OpenAI OAuth credential');
  }
  if (typeof record.accountId !== 'string' || !record.accountId.trim()) {
    // Without an account id the gateway cannot set `chatgpt-account-id`, and every
    // ChatGPT request fails auth. Fail loudly rather than vault a broken record.
    throw new Error('OpenCode ChatGPT credential has no account id — sign in again and pick a ChatGPT plan');
  }
  return {
    tokens: {
      access_token: record.access,
      refresh_token: record.refresh,
      account_id: record.accountId,
    },
    OPENAI_API_KEY: null,
    last_refresh: now.toISOString(),
  };
}

export function parseChatGptModelList(output: string): string[] {
  const ids = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^openai\/gpt-/.test(line))
    .map((line) => line.slice('openai/'.length));
  return [...new Set(ids)];
}

function discoverChatGptModels(): string[] {
  // Host CLI first: it is signed in, so the openai provider is registered.
  // The bare container has no auth, and an unauthenticated opencode reports
  // "Provider not found: openai" — that path stays as a silenced fallback.
  const attempts: Array<[string, string[]]> = [
    ['opencode', ['models', 'openai']],
    [CONTAINER_RUNTIME_BIN, ['run', '--rm', '--entrypoint', 'opencode', CONTAINER_IMAGE, 'models', 'openai']],
  ];
  for (const [command, args] of attempts) {
    try {
      const output = execFileSync(command, args, {
        encoding: 'utf8',
        timeout: 60_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const ids = parseChatGptModelList(output);
      if (ids.length > 0) return ids;
    } catch {
      // try the next source
    }
  }
  return [...OPENCODE_CHATGPT_MODELS];
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

  const vaultPath = path.join(loginDir, 'onecli-openai-oauth.json');
  const removeVaultFile = (): void => fs.rmSync(vaultPath, { force: true });

  try {
    const authJson = JSON.parse(fs.readFileSync(authPath, 'utf8')) as unknown;
    const stub = buildOpenCodeOAuthStub(authJson);
    const secret = buildOneCliOAuthSecret(authJson);
    fs.writeFileSync(vaultPath, `${JSON.stringify(secret, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(vaultPath, 0o600);
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
        vaultPath,
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
    removeVaultFile();
    removeLoginDir();
  }
}

export async function runOpenCodeAuthStep(): Promise<void> {
  const backend = answer(
    await brightSelect<Backend>({
      message: 'Which model backend should OpenCode use?',
      options: [
        {
          value: 'chatgpt',
          label: 'ChatGPT subscription',
          hint: 'Plus or Pro via browser sign-in or device pairing',
        },
        {
          value: 'local',
          label: 'Local or self-hosted',
          hint: 'vLLM, llama.cpp, or another OpenAI-compatible endpoint',
        },
        { value: 'openrouter', label: 'OpenRouter', hint: 'API key stored in OneCLI' },
        { value: 'deepseek', label: 'DeepSeek', hint: 'API key stored in OneCLI' },
        { value: 'custom', label: 'Something else', hint: 'provider id, model, optional base URL' },
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

  let provider: string = backend;
  let baseUrl = '';
  let host = '';
  if (backend === 'chatgpt') {
    provider = 'openai';
    host = 'chatgpt.com';
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
  } else if (backend === 'local') {
    provider = 'openai';
    baseUrl = answer(
      await p.text({
        message: 'OpenAI-compatible base URL (include /v1)',
        placeholder: 'http://host.docker.internal:8000/v1',
        validate: (value) => validHttpUrl(String(value ?? '').trim()),
      }),
    ).trim();
    host = new URL(baseUrl).hostname;
  } else if (backend === 'openrouter') {
    provider = 'openrouter';
    host = 'openrouter.ai';
  } else if (backend === 'deepseek') {
    provider = 'deepseek';
    host = 'api.deepseek.com';
  } else {
    provider = answer(
      await p.text({
        message: 'OpenCode provider id',
        placeholder: 'google',
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
    host = baseUrl ? new URL(baseUrl).hostname : '';
  }

  let discoveredModels: string[] = [];
  if (backend === 'chatgpt') {
    discoveredModels = discoverChatGptModels();
  } else if (backend === 'local') {
    try {
      discoveredModels = await discoverLocalModelIds(baseUrl);
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
      await brightSelect<string>({
        message: 'Which model should OpenCode use?',
        options: [
          ...discoveredModels.map((id) => ({ value: id, label: id })),
          { value: MANUAL_MODEL, label: 'Enter a model id manually', hint: 'use a model not listed above' },
        ],
      }),
    );
    if (selected !== MANUAL_MODEL) model = `${provider}/${selected}`;
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
  if (backend === 'chatgpt') upsertEnvVar(OPENCODE_AUTH_MODE, 'chatgpt');
  else removeEnvVar(OPENCODE_AUTH_MODE);

  const key =
    backend === 'chatgpt'
      ? ''
      : normalizeOptionalInput(
          answer(
            await p.password({
              message: backend === 'local' ? 'API key (leave blank if this endpoint is keyless)' : 'API key',
              validate: (value) =>
                (backend !== 'openrouter' && backend !== 'deepseek') || String(value ?? '').trim()
                  ? undefined
                  : 'Required.',
            }),
          ),
        );
  if (key) {
    if (!host) {
      host = answer(
        await p.text({
          message: 'Credential host pattern',
          placeholder: 'api.example.com',
          validate: (v) => (String(v ?? '').trim() ? undefined : 'Required.'),
        }),
      ).trim();
    }
    saveKey(`OpenCode ${provider}`, key, host);
  }

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
  if (cli?.version !== '1.18.25' || cli.onlyBuilt !== true) {
    throw new Error('OpenCode CLI must be pinned to 1.18.25 with trusted postinstall enabled');
  }
}

registerSetupProvider({
  value: 'opencode',
  label: 'OpenCode',
  hint: 'OpenAI, OpenRouter, DeepSeek, or a local OpenAI-compatible model',
  runAuth: runOpenCodeAuthStep,
  runInstallCheck: checkOpenCodeInstall,
});
