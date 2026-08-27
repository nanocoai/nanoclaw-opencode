import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commandGuardSpec } from './cli/guard.js';
import { lookup } from './cli/registry.js';
import './cli/resources/groups.js';
import { configFromDb } from './container-config.js';
import { createAgentGroup } from './db/agent-groups.js';
import { closeDb, initTestDb } from './db/connection.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigScalars } from './db/container-configs.js';
import { runMigrations } from './db/migrations/index.js';
import type { AgentGroup } from './types.js';

const group: AgentGroup = {
  id: 'delivery-group',
  name: 'Delivery Group',
  folder: 'delivery-group',
  agent_provider: null,
  created_at: new Date().toISOString(),
};

beforeEach(async () => {
  await runMigrations(await initTestDb());
  await createAgentGroup(group);
  await ensureContainerConfig(group.id);
});

afterEach(closeDb);

describe('delivery mode host plumbing', () => {
  it('keeps existing groups on the implicit envelope default and materializes tools-only when selected', async () => {
    let row = (await getContainerConfig(group.id))!;
    expect(row.delivery_mode).toBeNull();
    expect(configFromDb(row, group).deliveryMode).toBeUndefined();

    await updateContainerConfigScalars(group.id, { delivery_mode: 'tools-only' });
    row = (await getContainerConfig(group.id))!;
    expect(configFromDb(row, group).deliveryMode).toBe('tools-only');

    await updateContainerConfigScalars(group.id, { delivery_mode: 'not-a-mode' });
    row = (await getContainerConfig(group.id))!;
    expect(configFromDb(row, group).deliveryMode).toBeUndefined();
  });

  it('allows the host CLI to select the mode but denies a group-scoped agent changing it', async () => {
    const command = lookup('groups-config-update')!;
    const handlerResult = (await command.handler(
      { id: group.id, 'delivery-mode': 'tools-only' },
      { caller: 'host' } as never,
    )) as Record<string, unknown>;
    expect(handlerResult.delivery_mode).toBe('tools-only');

    const decision = await commandGuardSpec(command).decide({
      actor: { kind: 'agent', agentGroupId: group.id, sessionId: 'session-1' },
      payload: { id: group.id, delivery_mode: 'envelope' },
    });
    expect(decision.effect).toBe('deny');
    expect(decision.reason).toContain('delivery_mode');
  });

  it('rejects invalid CLI values', async () => {
    const command = lookup('groups-config-update')!;
    await expect(
      command.handler({ id: group.id, 'delivery-mode': 'sometimes' }, { caller: 'host' } as never),
    ).rejects.toThrow(/delivery-mode must be one of: envelope, tools-only/);
  });
});
