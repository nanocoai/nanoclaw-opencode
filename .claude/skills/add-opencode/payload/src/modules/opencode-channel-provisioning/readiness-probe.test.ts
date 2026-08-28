import { describe, expect, it } from 'vitest';

import { assistantTextEventCount, routeProbeRevision, runtimeConfigForRoute } from './readiness-probe.js';
import type { OpenCodeRouteV1 } from './types.js';

const route: OpenCodeRouteV1 = {
  schemaVersion: 1,
  connectionId: 'local',
  providerId: 'openai',
  modelId: 'qwen-local',
  modelRef: 'openai/qwen-local',
  auth: { kind: 'keyless' },
  transport: { kind: 'openai_compatible', apiMode: 'chat_completions', baseUrl: 'http://host.docker.internal:8891/v1' },
  readiness: { state: 'unverified' },
};

describe('OpenCode runtime readiness probe', () => {
  it('materializes a keyless route without an API-key sentinel', () => {
    const config = runtimeConfigForRoute(route);
    expect(config).toMatchObject({ model: 'openai/qwen-local', enabled_providers: ['openai'] });
    expect(JSON.stringify(config)).not.toContain('onecli-managed');
  });

  it('changes the revision when any runtime route field changes', () => {
    expect(routeProbeRevision(route)).not.toBe(
      routeProbeRevision({ ...route, modelId: 'other', modelRef: 'openai/other' }),
    );
  });

  it('keeps the revision stable when only readiness changes', () => {
    expect(routeProbeRevision(route)).toBe(
      routeProbeRevision({
        ...route,
        readiness: { state: 'ready', probedAt: '2026-08-28T00:00:00.000Z', probeRevision: 'old' },
      }),
    );
  });

  it('requires exactly one assistant text event', () => {
    expect(assistantTextEventCount('{"type":"text","part":{"text":"READY"}}\n')).toBe(1);
    expect(
      assistantTextEventCount(
        '{"type":"text","part":{"text":"READY"}}\n{"type":"text","part":{"text":"duplicate"}}\n',
      ),
    ).toBe(2);
  });
});
