import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import * as p from '@clack/prompts';

import { brightSelect } from '../lib/bright-select.js';
import { brandBody } from '../lib/theme.js';
import * as setupLog from '../logs.js';
import { removeEnvVar, upsertEnvVar } from '../set-env.js';
import { registerSetupProvider } from './registry.js';

type Backend = 'local' | 'openrouter' | 'deepseek' | 'custom' | 'skip';

const MAX_MODEL_DISCOVERY_BYTES = 1024 * 1024;
const MANUAL_MODEL = '__manual_model__';

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

export async function runOpenCodeAuthStep(): Promise<void> {
  const backend = answer(
    await brightSelect<Backend>({
      message: 'Which model backend should OpenCode use?',
      options: [
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
  if (backend === 'local') {
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
  if (backend === 'local') {
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

  const key = normalizeOptionalInput(
    answer(
      await p.password({
        message: backend === 'local' ? 'API key (leave blank if this endpoint is keyless)' : 'API key',
        validate: (value) =>
          (backend !== 'openrouter' && backend !== 'deepseek') || String(value ?? '').trim() ? undefined : 'Required.',
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
  if (cli?.version !== '1.18.21' || cli.onlyBuilt !== true) {
    throw new Error('OpenCode CLI must be pinned to 1.18.21 with trusted postinstall enabled');
  }
}

registerSetupProvider({
  value: 'opencode',
  label: 'OpenCode',
  hint: 'OpenAI, OpenRouter, DeepSeek, or a local OpenAI-compatible model',
  runAuth: runOpenCodeAuthStep,
  runInstallCheck: checkOpenCodeInstall,
});
