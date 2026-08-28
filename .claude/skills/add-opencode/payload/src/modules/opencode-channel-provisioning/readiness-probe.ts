import { createHash } from 'crypto';
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { CONTAINER_IMAGE, DATA_DIR, INSTALL_SLUG } from '../../config.js';
import { CONTAINER_RUNTIME_BIN } from '../../container-runtime.js';
import { getSessionDriver } from '../../drivers/index.js';
import { getGatewayProvider } from '../../gateway-providers/index.js';
import type { OpenCodeRouteV1 } from './types.js';

const PROBE_TIMEOUT_MS = 45_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export function routeProbeRevision(route: OpenCodeRouteV1): string {
  const { readiness: _readiness, ...runtimeRoute } = route;
  return createHash('sha256').update(JSON.stringify(runtimeRoute)).digest('hex');
}

export function runtimeConfigForRoute(route: OpenCodeRouteV1): Record<string, unknown> {
  const providerOptions =
    route.transport.kind === 'openai_compatible'
      ? {
          [route.providerId]: {
            npm: '@ai-sdk/openai-compatible',
            name: route.providerId,
            options: {
              baseURL: route.transport.baseUrl,
              ...(route.auth.kind === 'keyless' ? {} : { apiKey: 'onecli-managed' }),
            },
            models: {
              [route.modelId]: {
                name: route.modelId,
                ...(route.limits ? { limit: route.limits } : {}),
                ...(route.inputModalities?.length
                  ? { modalities: { input: route.inputModalities, output: ['text'] } }
                  : {}),
              },
            },
          },
        }
      : {};
  return {
    model: route.modelRef,
    small_model: route.modelRef,
    enabled_providers: [route.providerId],
    autoupdate: false,
    snapshot: false,
    provider: providerOptions,
    permission: { read: 'deny', edit: 'deny', bash: 'deny', question: 'deny' },
  };
}

export function assistantTextEventCount(stdout: string): number {
  return stdout
    .split('\n')
    .filter(Boolean)
    .filter((line) => {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        return event.type === 'text' || event.type === 'message.part.updated';
      } catch {
        return false;
      }
    }).length;
}

export interface ProbeResult {
  probeRevision: string;
  probedAt: string;
}

/** Invoke the pinned OpenCode CLI with the same route and OneCLI contribution used at runtime. */
export async function probeOpenCodeRoute(
  agentGroupId: string,
  groupName: string,
  route: OpenCodeRouteV1,
): Promise<ProbeResult> {
  const probeRevision = routeProbeRevision(route);
  const probeId = `opencode-probe-${probeRevision.slice(0, 12)}`;
  const gateway = await getGatewayProvider().contribute({
    key: { installSlug: INSTALL_SLUG, agentGroupId, sessionId: probeId },
    groupName,
    capabilities: getSessionDriver().capabilities(),
  });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-opencode-probe-'));
  const args = ['run', '--rm', '--add-host=host.docker.internal:host-gateway'];
  try {
    const env = {
      ...gateway.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(runtimeConfigForRoute(route)),
      XDG_DATA_HOME: '/opencode-probe-data',
    };
    for (const [key, value] of Object.entries(env)) args.push('-e', `${key}=${value}`);
    for (const mount of gateway.mounts ?? []) {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}${mount.mode === 'ro' ? ':ro' : ''}`);
    }
    args.push('-v', `${workDir}:/opencode-probe-data`);
    if (route.auth.kind === 'chatgpt_oauth') {
      const stubPath = path.join(DATA_DIR, 'opencode', 'openai-auth-stub.json');
      if (!fs.existsSync(stubPath)) throw new Error('OpenCode ChatGPT credential stub is missing; re-run setup');
      const authTarget = path.join(workDir, 'opencode', 'auth.json');
      fs.mkdirSync(path.dirname(authTarget), { recursive: true });
      fs.closeSync(fs.openSync(authTarget, 'a'));
      args.push('-v', `${stubPath}:/opencode-probe-data/opencode/auth.json:ro`);
    }
    args.push('--entrypoint', 'opencode', CONTAINER_IMAGE, 'run', '--pure', '--format', 'json', '--model', route.modelRef);
    args.push('Reply with exactly READY and nothing else.');

    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        CONTAINER_RUNTIME_BIN,
        args,
        { encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES, timeout: PROBE_TIMEOUT_MS },
        (error, output, stderr) => {
          if (error) reject(new Error(`OpenCode readiness probe failed: ${String(stderr).trim() || error.message}`));
          else resolve(output);
        },
      );
    });
    const textEvents = assistantTextEventCount(stdout);
    if (textEvents !== 1) throw new Error(`OpenCode readiness probe produced ${textEvents} terminal text events`);
    return { probeRevision, probedAt: new Date().toISOString() };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
