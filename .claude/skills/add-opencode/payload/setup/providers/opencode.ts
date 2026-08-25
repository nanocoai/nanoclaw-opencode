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

  const model = answer(
    await p.text({
      message: 'Model id in provider/model form',
      placeholder: provider === 'openai' ? 'openai/my-model' : `${provider}/model-id`,
      validate: (value) => (String(value ?? '').includes('/') ? undefined : 'Use provider/model-id form.'),
    }),
  ).trim();

  upsertEnvVar('OPENCODE_PROVIDER', provider);
  upsertEnvVar('OPENCODE_MODEL', model);
  upsertEnvVar('OPENCODE_SMALL_MODEL', model);
  if (baseUrl) upsertEnvVar('ANTHROPIC_BASE_URL', baseUrl);
  else removeEnvVar('ANTHROPIC_BASE_URL');

  const key = answer(
    await p.password({
      message: backend === 'local' ? 'API key (leave blank if this endpoint is keyless)' : 'API key',
      validate: (value) =>
        (backend !== 'openrouter' && backend !== 'deepseek') || String(value ?? '').trim() ? undefined : 'Required.',
    }),
  ).trim();
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
