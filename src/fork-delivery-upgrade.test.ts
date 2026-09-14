/**
 * Upgrade the schema shipped by the fork before reconciliation. Delivery was
 * declared as migration 024 there, but "delivery-mode" is its permanent
 * identity; the current 026 must not add the same column again.
 */
import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  root: `/tmp/nanoclaw-test-fork-delivery-upgrade-${process.pid}-${Date.now()}`,
}));
vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, GROUPS_DIR: `${fixture.root}/groups` };
});

import { backfillContainerConfigs } from './backfill-container-configs.js';
import { materializeContainerJson } from './container-config.js';
import { createAgentGroup } from './db/agent-groups.js';
import { closeDb, getDb, initTestDb } from './db/connection.js';
import { ensureContainerConfig, getContainerConfig } from './db/container-configs.js';
import { migrations, runMigrations, type Migration } from './db/migrations/index.js';

const legacyDeliveryMigration: Migration = {
  version: 24,
  name: 'delivery-mode',
  async up(db) {
    await db.exec('ALTER TABLE container_configs ADD COLUMN delivery_mode TEXT;');
  },
};
const LEGACY_GROUP = 'legacy-opencode';
const LEGACY_SETTINGS = JSON.stringify({
  opencode: {
    modelProvider: 'openai',
    baseUrl: 'http://localhost:8891/v1',
    contextLimit: 32768,
  },
});

beforeEach(async () => {
  fs.mkdirSync(fixture.root);
  fs.mkdirSync(path.join(fixture.root, 'groups', 'legacy'), { recursive: true });
  const db = await initTestDb();
  // Preserve the old order, including its independent second migration 024.
  await runMigrations(db, [
    ...migrations.filter((migration) => migration.version < 24),
    legacyDeliveryMigration,
    ...migrations.filter((migration) => migration.version === 24),
  ]);
  // The old optional provisioning module added this column. Retaining its
  // data is distinct from supporting its experimental routes in the runtime.
  await db.exec("ALTER TABLE container_configs ADD COLUMN provider_settings TEXT NOT NULL DEFAULT '{}';");
  await createAgentGroup({
    id: LEGACY_GROUP,
    name: 'Legacy',
    folder: 'legacy',
    agent_provider: 'opencode',
    created_at: new Date().toISOString(),
  });
  await ensureContainerConfig(LEGACY_GROUP, 'opencode');
  await db.run(
    'UPDATE container_configs SET delivery_mode = ?, provider_settings = ? WHERE agent_group_id = ?',
    'tools-only',
    LEGACY_SETTINGS,
    LEGACY_GROUP,
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeDb();
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

function materialized(folder: string): { deliveryMode?: string } {
  return JSON.parse(fs.readFileSync(path.join(fixture.root, 'groups', folder, 'container.json'), 'utf8'));
}

async function legacySettings(): Promise<string | undefined> {
  return (
    await getDb().get<{ provider_settings: string }>(
      'SELECT provider_settings FROM container_configs WHERE agent_group_id = ?',
      LEGACY_GROUP,
    )
  )?.provider_settings;
}

describe('fork delivery migration upgrade', () => {
  it('recognizes historical 024 by name and preserves delivery and legacy route data', async () => {
    const db = getDb();
    const recorded = await db.get<{ version: number; name: string; applied: string }>(
      'SELECT version, name, applied FROM schema_version WHERE name = ?',
      'delivery-mode',
    );
    expect(recorded).toBeDefined();
    expect((await db.columnOwners?.('speed')) ?? []).not.toContain('container_configs');
    const exec = vi.spyOn(db, 'exec');

    await expect(runMigrations(db)).resolves.toBeUndefined();
    await expect(runMigrations(db)).resolves.toBeUndefined();

    expect(
      exec.mock.calls.some(([sql]) => /ALTER\s+TABLE\s+container_configs\s+ADD\s+COLUMN\s+delivery_mode/i.test(sql)),
    ).toBe(false);
    expect(await db.all('SELECT version, name, applied FROM schema_version WHERE name = ?', 'delivery-mode')).toEqual([
      recorded,
    ]);
    expect(await db.columnOwners?.('speed')).toContain('container_configs');
    expect((await getContainerConfig(LEGACY_GROUP))?.delivery_mode).toBe('tools-only');

    await materializeContainerJson(LEGACY_GROUP);
    await backfillContainerConfigs();
    expect(materialized('legacy').deliveryMode).toBe('tools-only');
    expect((await getContainerConfig(LEGACY_GROUP))?.delivery_mode).toBe('tools-only');
    expect(await legacySettings()).toBe(LEGACY_SETTINGS);
  });

  it('recovers a rowless tools-only group from its retained file after upgrading', async () => {
    await createAgentGroup({
      id: 'recovered-group',
      name: 'Recovered',
      folder: 'recovered',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    fs.mkdirSync(path.join(fixture.root, 'groups', 'recovered'));
    fs.writeFileSync(
      path.join(fixture.root, 'groups', 'recovered', 'container.json'),
      JSON.stringify({ provider: 'opencode', deliveryMode: 'tools-only' }),
    );

    await runMigrations(getDb());
    await backfillContainerConfigs();
    await backfillContainerConfigs();
    await materializeContainerJson('recovered-group');

    expect((await getContainerConfig('recovered-group'))?.delivery_mode).toBe('tools-only');
    expect(materialized('recovered').deliveryMode).toBe('tools-only');
    expect(await legacySettings()).toBe(LEGACY_SETTINGS);
  });
});
