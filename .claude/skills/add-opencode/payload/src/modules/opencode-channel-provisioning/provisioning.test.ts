import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./model-discovery.js', () => ({
  discoverOpenCodeModels: vi
    .fn()
    .mockResolvedValue([
      {
        id: 'openai/selected-live-model',
        name: 'Selected Live Model',
        contextLimit: 65536,
        outputLimit: 8192,
        inputModalities: 'text,image',
      },
    ]),
}));

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import {
  getChannelAgentProvisioner,
  type ChannelAgentProvisioningContext,
} from '../permissions/channel-agent-provisioner.js';
import type { PendingChannelApproval } from '../permissions/db/pending-channel-approvals.js';
import { opencodeChannelProvisioningMigration } from './migration.js';
import './index.js';

const now = () => new Date().toISOString();

describe('OpenCode channel-created agent provisioning', () => {
  beforeEach(async () => {
    const db = await initTestDb();
    await runMigrations(db);
    await createAgentGroup({ id: 'anchor', name: 'Anchor', folder: 'anchor', agent_provider: null, created_at: now() });
    await getDb().run(
      `INSERT INTO messaging_groups (id, channel_type, instance, platform_id, name, is_group, unknown_sender_policy, created_at)
       VALUES ('origin', 'fixture', 'fixture', 'room-1', 'Room', 1, 'request_approval', ?)`,
      now(),
    );
    await getDb().run(
      `INSERT INTO pending_channel_approvals
       (messaging_group_id, agent_group_id, original_message, approver_user_id, created_at, title, question, options_json)
       VALUES ('origin', 'anchor', '{}', 'fixture:owner', ?, 'title', 'question', '[]')`,
      now(),
    );
    await getDb().run(
      `INSERT INTO opencode_model_providers
       (id, name, provider_id, discovery_type, base_url, models_url, context_limit, output_limit, input_modalities, instructions, enabled, created_at, updated_at)
       VALUES ('local', 'Local MLX', 'openai', 'openai-compatible', 'http://host.docker.internal:8891/v1', NULL, 32768, 4096, 'text', NULL, 1, ?, ?)`,
      now(),
      now(),
    );
  });

  afterEach(closeDb);

  it('can adopt the tables and provider_settings column left by the first-class implementation', async () => {
    if (opencodeChannelProvisioningMigration.sqliteOnly) throw new Error('expected a portable migration');
    await expect(opencodeChannelProvisioningMigration.up(getDb())).resolves.toBeUndefined();
  });

  it('keeps wizard state in the DB, confirms explicitly, and persists the selected model per group', async () => {
    const row = (await getDb().get<PendingChannelApproval>(
      'SELECT * FROM pending_channel_approvals WHERE messaging_group_id = ?',
      'origin',
    ))!;
    const cards: Array<{ title: string }> = [];
    let createdBeforeConfirmation = false;
    const context: ChannelAgentProvisioningContext = {
      row,
      deliverQuestion: async (title) => {
        cards.push({ title });
        return true;
      },
      deliverText: async () => {},
      createAgent: async ({ name, provider, model }) => {
        createdBeforeConfirmation = true;
        await createAgentGroup({
          id: 'created',
          name,
          folder: 'nanoclaw-jester',
          agent_provider: null,
          created_at: now(),
        });
        await ensureContainerConfig('created', provider);
        await updateContainerConfigScalars('created', { provider, model });
        return (await getDb().get('SELECT * FROM agent_groups WHERE id = ?', 'created'))!;
      },
      wireAgent: async () => true,
      cancel: async () => {},
    };
    const provisioner = getChannelAgentProvisioner('opencode')!;

    await provisioner.start(context);
    expect(await provisioner.pendingTextInputFor('fixture:owner')).toBe('origin');
    await provisioner.handleText(
      context,
      {
        channelType: 'fixture',
        platformId: 'owner-dm',
        threadId: null,
        message: {
          id: 'name',
          kind: 'chat-sdk',
          content: JSON.stringify({ text: 'Nanoclaw Jester' }),
          timestamp: now(),
        },
      },
      'fixture:owner',
    );
    expect(cards.at(-1)?.title).toContain('provider');

    const response = (value: string) => ({
      questionId: 'origin',
      value,
      channelType: 'fixture',
      platformId: 'owner-dm',
      threadId: null,
      userId: 'owner',
    });
    await provisioner.handleResponse(context, response('opencode_provider:local'));
    expect(cards.at(-1)?.title).toContain('model');
    expect(createdBeforeConfirmation).toBe(false);
    expect(await provisioner.handleResponse(context, response('connect:anchor'))).toBe(true);
    expect(createdBeforeConfirmation).toBe(false);

    await provisioner.handleResponse(context, response('opencode_model:openai%2Fselected-live-model'));
    expect(cards.at(-1)?.title).toContain('Confirm');
    expect(createdBeforeConfirmation).toBe(false);

    await provisioner.handleResponse(context, response('opencode_confirm_agent'));
    const config = await getContainerConfig('created');
    expect(config).toMatchObject({ provider: 'opencode', model: 'openai/selected-live-model' });
    expect(JSON.parse(config!.provider_settings!)).toMatchObject({
      opencode: { modelProvider: 'openai', baseUrl: 'http://host.docker.internal:8891/v1', contextLimit: 65536 },
    });
  });
});
