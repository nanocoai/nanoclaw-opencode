/**
 * Host-side container config for the `opencode` provider.
 *
 * OpenCode's `opencode serve` process stores state under XDG_DATA_HOME, which
 * we pin to a per-session host directory mounted at /opencode-xdg. The
 * OPENCODE_* env vars tell the CLI which provider/model to use at runtime
 * (read on the host, injected into the container). NO_PROXY / no_proxy are
 * merged with host values so the in-container OpenCode client can talk to
 * 127.0.0.1 even when HTTPS_PROXY is set by OneCLI.
 */
import fs from 'fs';
import path from 'path';

import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

const PASSTHROUGH_KEYS = [
  'OPENCODE_PROVIDER',
  'OPENCODE_MODEL',
  'OPENCODE_SMALL_MODEL',
  'ANTHROPIC_BASE_URL',
  'OPENCODE_MODEL_CONTEXT_LIMIT',
  'OPENCODE_MODEL_OUTPUT_LIMIT',
  'OPENCODE_MODEL_INPUT_MODALITIES',
] as const;

function mergeNoProxy(current: string | undefined, additions: string): string {
  if (!current?.trim()) return additions;
  const parts = new Set(
    current
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const addition of additions.split(',')) {
    const trimmed = addition.trim();
    if (trimmed) parts.add(trimmed);
  }
  return [...parts].join(',');
}

registerProviderContainerConfig('opencode', (ctx) => {
  const opencodeDir = path.join(ctx.sessionDir, 'opencode-xdg');
  fs.mkdirSync(opencodeDir, { recursive: true });

  const env: Record<string, string> = {
    XDG_DATA_HOME: '/opencode-xdg',
    NO_PROXY: mergeNoProxy(ctx.hostEnv.NO_PROXY, '127.0.0.1,localhost'),
    no_proxy: mergeNoProxy(ctx.hostEnv.no_proxy, '127.0.0.1,localhost'),
  };
  // The host process does not load `.env` into process.env (readEnvFile keeps
  // file values out of child processes), and the service units set no
  // EnvironmentFile — so under launchd/systemd, ctx.hostEnv carries none of
  // these. Fall back to the `.env` file the way the claude provider does;
  // a real exported variable still wins over the file.
  const dotenv = readEnvFile([...PASSTHROUGH_KEYS]);
  for (const key of PASSTHROUGH_KEYS) {
    const value = ctx.hostEnv[key] ?? dotenv[key];
    if (value) env[key] = value;
  }

  const settings =
    typeof ctx.providerSettings === 'object' && ctx.providerSettings !== null
      ? (ctx.providerSettings as Record<string, unknown>).opencode
      : undefined;
  const opencode =
    typeof settings === 'object' && settings !== null ? (settings as Record<string, unknown>) : undefined;
  if (ctx.model) env.OPENCODE_MODEL = ctx.model;
  if (typeof opencode?.modelProvider === 'string') env.OPENCODE_PROVIDER = opencode.modelProvider;
  if (typeof opencode?.baseUrl === 'string' && opencode.baseUrl) env.ANTHROPIC_BASE_URL = opencode.baseUrl;
  if (typeof opencode?.smallModel === 'string') env.OPENCODE_SMALL_MODEL = opencode.smallModel;
  if (typeof opencode?.contextLimit === 'number') env.OPENCODE_MODEL_CONTEXT_LIMIT = String(opencode.contextLimit);
  if (typeof opencode?.outputLimit === 'number') env.OPENCODE_MODEL_OUTPUT_LIMIT = String(opencode.outputLimit);
  if (typeof opencode?.inputModalities === 'string') {
    env.OPENCODE_MODEL_INPUT_MODALITIES = opencode.inputModalities;
  }

  return {
    mounts: [{ hostPath: opencodeDir, containerPath: '/opencode-xdg', readonly: false }],
    env,
  };
});
