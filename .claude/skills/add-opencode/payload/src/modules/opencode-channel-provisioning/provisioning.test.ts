import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./model-discovery.js', () => ({
  discoverOpenCodeProviders: vi.fn().mockResolvedValue([
    { id: 'opencode', name: 'OpenCode' },
    { id: 'anthropic', name: 'Anthropic' },
    { id: 'cerebras', name: 'Cerebras' },
    { id: 'openrouter', name: 'OpenRouter' },
    { id: 'deepseek', name: 'DeepSeek' },
    { id: 'google', name: 'Google' },
    { id: 'groq', name: 'Groq' },
    { id: 'ollama', name: 'Ollama' },
  ]),
  discoverOpenCodeModels: vi.fn().mockImplementation(async (provider: { provider_id: string }) => [
    {
      id: `${provider.provider_id}/selected-live-model`,
      name: 'Selected Live Model',
      contextLimit: 65536,
      outputLimit: 8192,
      inputModalities: 'text,image',
    },
    ...Array.from({ length: 5 }, (_, index) => ({
      id: `${provider.provider_id}/browsable-model-${index + 2}`,
      name: `Browsable Model ${index + 2}`,
      contextLimit: 32768,
      outputLimit: 4096,
      inputModalities: 'text',
    })),
  ]),
}));

vi.mock('./readiness-probe.js', () => ({
  probeOpenCodeRoute: vi.fn().mockResolvedValue({
    probedAt: '2026-08-28T00:00:00.000Z',
    probeRevision: 'test-probe-revision',
  }),
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
    const cards: Array<{ title: string; options?: Array<{ label?: string; value?: string }> }> = [];
    let createdBeforeConfirmation = false;
    const context: ChannelAgentProvisioningContext = {
      row,
      isApproverDm: async (event) =>
        event.channelType === 'fixture' &&
        (event.instance ?? event.channelType) === 'fixture' &&
        event.platformId === 'owner-dm',
      deliverQuestion: async (title, _question, options) => {
        cards.push({ title, options: options as Array<{ label?: string; value?: string }> });
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
    await expect(
      provisioner.handleText(
        context,
        {
          channelType: 'fixture',
          platformId: 'different-surface',
          threadId: null,
          message: {
            id: 'wrong-surface-name',
            kind: 'chat-sdk',
            content: JSON.stringify({ text: 'Must Not Be Consumed' }),
            timestamp: now(),
          },
        },
        'fixture:owner',
      ),
    ).resolves.toBe(false);
    expect(
      await getDb().get<{ step: string; agent_name: string | null }>(
        'SELECT step, agent_name FROM opencode_channel_provisioning WHERE messaging_group_id = ?',
        'origin',
      ),
    ).toEqual({ step: 'awaiting_name', agent_name: null });
    await expect(
      provisioner.handleText(
        context,
        {
          channelType: 'fixture',
          instance: 'fixture-secondary',
          platformId: 'owner-dm',
          threadId: null,
          message: {
            id: 'wrong-instance-name',
            kind: 'chat-sdk',
            content: JSON.stringify({ text: 'Must Not Be Consumed Either' }),
            timestamp: now(),
          },
        },
        'fixture:owner',
      ),
    ).resolves.toBe(false);
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
    expect(cards.at(-1)?.options?.map((option) => option.label)).toEqual(
      expect.arrayContaining([
        'Local MLX',
        'OpenCode Zen',
        'OpenRouter',
        'More providers…',
        'Local or custom endpoint',
      ]),
    );
    expect(cards.at(-1)?.options).toHaveLength(8);

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
    expect(cards.at(-1)?.title).toContain('Local MLX');
    expect(cards.at(-1)?.options?.map((option) => option.label)).toEqual(
      expect.arrayContaining(['Selected Live Model', 'Next models', 'Search models', 'Change provider']),
    );
    expect(cards.at(-1)?.options).toHaveLength(7);
    expect(createdBeforeConfirmation).toBe(false);
    await provisioner.handleResponse(context, response('opencode_model_page:1'));
    expect(cards.at(-1)?.options?.map((option) => option.label)).toEqual(
      expect.arrayContaining(['Browsable Model 6', 'Previous models', 'Search models']),
    );
    await provisioner.handleResponse(context, response('opencode_model_page:0'));
    await getDb().run(
      `UPDATE opencode_channel_provisioning
       SET step = 'awaiting_model_query', provider_id = 'local'
       WHERE messaging_group_id = 'origin'`,
    );
    await provisioner.handleText(
      context,
      {
        channelType: 'fixture',
        platformId: 'owner-dm',
        threadId: null,
        message: {
          id: 'legacy-query',
          kind: 'chat-sdk',
          content: JSON.stringify({ text: 'old forced search input' }),
          timestamp: now(),
        },
      },
      'fixture:owner',
    );
    expect(cards.at(-1)?.options?.map((option) => option.label)).toContain('Next models');
    await provisioner.handleResponse(context, response('opencode_search_models'));
    await provisioner.handleText(
      context,
      {
        channelType: 'fixture',
        platformId: 'owner-dm',
        threadId: null,
        message: {
          id: 'explicit-query',
          kind: 'chat-sdk',
          content: JSON.stringify({ text: 'selected' }),
          timestamp: now(),
        },
      },
      'fixture:owner',
    );
    expect(cards.at(-1)?.options?.map((option) => option.label)).toContain('Search again');
    await provisioner.handleResponse(context, response('opencode_change_provider'));
    expect(cards.at(-1)?.title).toContain('provider');
    await provisioner.handleResponse(context, response('opencode_provider:local'));
    expect(await provisioner.handleResponse(context, response('connect:anchor'))).toBe(true);
    expect(createdBeforeConfirmation).toBe(false);

    await provisioner.handleResponse(context, response('opencode_model:openai%2Fselected-live-model'));
    expect(cards.at(-1)?.title).toContain('Confirm');
    expect(createdBeforeConfirmation).toBe(false);

    await provisioner.handleResponse(context, response('opencode_confirm_agent'));
    const config = await getContainerConfig('created');
    expect(config).toMatchObject({ provider: 'opencode', model: 'openai/selected-live-model' });
    expect(JSON.parse(config!.provider_settings!)).toMatchObject({
      opencode: {
        modelProvider: 'openai',
        baseUrl: 'http://host.docker.internal:8891/v1',
        contextLimit: 65536,
        route: {
          schemaVersion: 1,
          connectionId: 'local',
          providerId: 'openai',
          modelId: 'selected-live-model',
          modelRef: 'openai/selected-live-model',
          auth: { kind: 'keyless' },
          readiness: {
            state: 'ready',
            probedAt: '2026-08-28T00:00:00.000Z',
            probeRevision: 'test-probe-revision',
          },
        },
      },
    });
    await expect(
      getDb().get('SELECT connection_id, route_json FROM opencode_group_routes WHERE agent_group_id = ?', 'created'),
    ).resolves.toMatchObject({ connection_id: 'local' });
  });

  it('searches the live provider catalog and persists a provider that was not preconfigured', async () => {
    const row = (await getDb().get<PendingChannelApproval>(
      'SELECT * FROM pending_channel_approvals WHERE messaging_group_id = ?',
      'origin',
    ))!;
    const cards: Array<{ title: string; options: Array<{ value?: string }> }> = [];
    const texts: string[] = [];
    const context: ChannelAgentProvisioningContext = {
      row,
      isApproverDm: async (event) =>
        event.channelType === 'fixture' &&
        (event.instance ?? event.channelType) === 'fixture' &&
        event.platformId === 'owner-dm',
      deliverQuestion: async (title, _question, options) => {
        cards.push({ title, options: options as Array<{ value?: string }> });
        return true;
      },
      deliverText: async (text) => void texts.push(text),
      createAgent: async ({ name, provider, model }) => {
        await createAgentGroup({
          id: 'catalog-created',
          name,
          folder: 'catalog',
          agent_provider: null,
          created_at: now(),
        });
        await ensureContainerConfig('catalog-created', provider);
        await updateContainerConfigScalars('catalog-created', { provider, model });
        return (await getDb().get('SELECT * FROM agent_groups WHERE id = ?', 'catalog-created'))!;
      },
      wireAgent: async () => true,
      cancel: async () => {},
    };
    const provisioner = getChannelAgentProvisioner('opencode')!;
    const response = (value: string) => ({
      questionId: 'origin',
      value,
      channelType: 'fixture',
      platformId: 'owner-dm',
      threadId: null,
      userId: 'owner',
    });
    const textEvent = (id: string, text: string) => ({
      channelType: 'fixture',
      platformId: 'owner-dm',
      threadId: null,
      message: { id, kind: 'chat-sdk' as const, content: JSON.stringify({ text }), timestamp: now() },
    });

    await provisioner.start(context);
    await provisioner.handleText(context, textEvent('name-catalog', 'Catalog Agent'), 'fixture:owner');
    expect(cards.at(-1)?.options.some((option) => option.value === 'opencode_catalog_provider:opencode')).toBe(true);
    expect(cards.at(-1)?.options.some((option) => option.value === 'opencode_catalog_provider:openrouter')).toBe(true);
    await provisioner.handleResponse(context, response('opencode_browse_providers'));
    expect(cards.at(-1)?.options.some((option) => option.value === 'opencode_provider_page:1')).toBe(true);
    expect(cards.at(-1)?.options.some((option) => option.value === 'opencode_search_providers')).toBe(true);
    expect(texts).toHaveLength(1);
    await getDb().run(
      `UPDATE opencode_channel_provisioning
       SET step = 'awaiting_provider', provider_id = '__catalog_search__'
       WHERE messaging_group_id = 'origin'`,
    );
    await provisioner.handleText(
      context,
      textEvent('legacy-provider-query', 'old forced search input'),
      'fixture:owner',
    );
    expect(cards.at(-1)?.options.some((option) => option.value === 'opencode_provider_page:1')).toBe(true);
    await provisioner.handleResponse(context, response('opencode_provider_page:1'));
    expect(cards.at(-1)?.options.some((option) => option.value === 'opencode_provider_page:0')).toBe(true);
    await provisioner.handleResponse(context, response('opencode_search_providers'));
    expect(texts.at(-1)).toContain('provider name');
    expect(await provisioner.pendingTextInputFor('fixture:owner')).toBe('origin');

    await provisioner.handleText(context, textEvent('provider-search', 'router'), 'fixture:owner');
    expect(cards.at(-1)?.options.some((option) => option.value === 'opencode_catalog_provider:openrouter')).toBe(true);
    await provisioner.handleResponse(context, response('opencode_catalog_provider:openrouter'));
    await provisioner.handleResponse(context, response('opencode_model:openrouter%2Fselected-live-model'));
    await expect(
      getDb().get(
        'SELECT provider_id, model_id FROM opencode_channel_provisioning WHERE messaging_group_id = ?',
        'origin',
      ),
    ).resolves.toMatchObject({ provider_id: '__catalog__:openrouter', model_id: 'openrouter/selected-live-model' });
    await provisioner.handleResponse(context, response('opencode_confirm_agent'));

    const config = await getContainerConfig('catalog-created');
    expect(config).toMatchObject({ provider: 'opencode', model: 'openrouter/selected-live-model' });
    expect(JSON.parse(config!.provider_settings!)).toMatchObject({
      opencode: { modelProvider: 'openrouter', baseUrl: null },
    });
  });

  it('keeps inline local endpoint input durable and snapshots it into the new group', async () => {
    const row = (await getDb().get<PendingChannelApproval>(
      'SELECT * FROM pending_channel_approvals WHERE messaging_group_id = ?',
      'origin',
    ))!;
    const texts: string[] = [];
    const context: ChannelAgentProvisioningContext = {
      row,
      isApproverDm: async (event) =>
        event.channelType === 'fixture' &&
        (event.instance ?? event.channelType) === 'fixture' &&
        event.platformId === 'owner-dm',
      deliverQuestion: async () => true,
      deliverText: async (text) => void texts.push(text),
      createAgent: async ({ name, provider, model }) => {
        await createAgentGroup({
          id: 'inline-created',
          name,
          folder: 'inline',
          agent_provider: null,
          created_at: now(),
        });
        await ensureContainerConfig('inline-created', provider);
        await updateContainerConfigScalars('inline-created', { provider, model });
        return (await getDb().get('SELECT * FROM agent_groups WHERE id = ?', 'inline-created'))!;
      },
      wireAgent: async () => true,
      cancel: async () => {},
    };
    const provisioner = getChannelAgentProvisioner('opencode')!;
    const response = (value: string) => ({
      questionId: 'origin',
      value,
      channelType: 'fixture',
      platformId: 'owner-dm',
      threadId: null,
      userId: 'owner',
    });
    const textEvent = (id: string, text: string) => ({
      channelType: 'fixture',
      platformId: 'owner-dm',
      threadId: null,
      message: { id, kind: 'chat-sdk' as const, content: JSON.stringify({ text }), timestamp: now() },
    });

    await provisioner.start(context);
    await provisioner.handleText(context, textEvent('name-inline', 'Inline Agent'), 'fixture:owner');
    await provisioner.handleResponse(context, response('opencode_inline_local'));
    await provisioner.handleText(
      context,
      textEvent('url-inline', 'http://host.docker.internal:9911/v1'),
      'fixture:owner',
    );
    expect(texts.at(-1)).toContain('context window');
    expect(await provisioner.pendingTextInputFor('fixture:owner')).toBe('origin');
    await provisioner.handleText(context, textEvent('context-inline', '131072'), 'fixture:owner');
    await provisioner.handleResponse(context, response('opencode_model:openai%2Fselected-live-model'));
    await provisioner.handleResponse(context, response('opencode_confirm_agent'));

    const config = await getContainerConfig('inline-created');
    expect(JSON.parse(config!.provider_settings!)).toMatchObject({
      opencode: {
        modelProvider: 'openai',
        baseUrl: 'http://host.docker.internal:9911/v1',
        contextLimit: 65536,
      },
    });
  });
});
