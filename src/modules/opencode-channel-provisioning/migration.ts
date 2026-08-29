import type { ModuleMigration } from '../../db/migrations/index.js';

export const opencodeChannelProvisioningMigration: ModuleMigration = {
  version: 1,
  name: 'module:opencode:channel-provisioning-v1',
  async up(db) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS opencode_model_providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        provider_id TEXT NOT NULL,
        discovery_type TEXT NOT NULL DEFAULT 'models-dev'
          CHECK (discovery_type IN ('models-dev', 'openai-compatible')),
        base_url TEXT,
        models_url TEXT,
        context_limit INTEGER,
        output_limit INTEGER,
        input_modalities TEXT NOT NULL DEFAULT '',
        instructions TEXT,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_opencode_model_providers_enabled
        ON opencode_model_providers(enabled, name);

      CREATE TABLE IF NOT EXISTS opencode_channel_provisioning (
        messaging_group_id TEXT PRIMARY KEY REFERENCES pending_channel_approvals(messaging_group_id) ON DELETE CASCADE,
        approver_user_id TEXT NOT NULL,
        step TEXT NOT NULL CHECK (step IN (
          'awaiting_name', 'awaiting_provider', 'awaiting_model_query',
          'awaiting_model', 'awaiting_confirmation'
        )),
        agent_name TEXT,
        provider_id TEXT,
        model_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_opencode_provisioning_approver
        ON opencode_channel_provisioning(approver_user_id, created_at);
    `);
    const owners = await db.columnOwners?.('provider_settings');
    if (!owners?.includes('container_configs')) {
      await db.exec(`ALTER TABLE container_configs ADD COLUMN provider_settings TEXT NOT NULL DEFAULT '{}';`);
    }
  },
};
