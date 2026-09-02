import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DIR = '/tmp/nanoclaw-test-opencode-provisioning';

// Outbound deliveries captured across the real core registration flow
// (hoisted: the delivery mock factory runs during module import).
const delivered = vi.hoisted(
  () => [] as Array<{ channelType: string; platformId: string; instance?: string; content: Record<string, unknown> }>,
);

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../../delivery.js', () => ({
  onDeliveryAdapterReady: () => {},
  getDeliveryAdapter: () => ({
    deliver: async (
      channelType: string,
      platformId: string,
      _threadId: string | null,
      _kind: string,
      content: string,
      _files: unknown,
      instance?: string,
    ) => {
      delivered.push({ channelType, platformId, instance, content: JSON.parse(content) });
      return 'plat-msg-id';
    },
  }),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-opencode-provisioning',
    GROUPS_DIR: '/tmp/nanoclaw-test-opencode-provisioning/groups',
    DEFAULT_AGENT_PROVIDER: 'opencode',
  };
});

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
  discoverOpenCodeModels: vi.fn().mockResolvedValue([
    {
      id: 'openai/selected-live-model',
      name: 'Selected Live Model',
      contextLimit: 65536,
      outputLimit: 8192,
      inputModalities: 'text,image',
    },
    ...Array.from({ length: 5 }, (_, index) => ({
      id: `openai/browsable-model-${index + 2}`,
      name: `Browsable Model ${index + 2}`,
      contextLimit: 32768,
      outputLimit: 4096,
      inputModalities: 'text',
    })),
  ]),
}));

import { dispatch } from '../../cli/dispatch.js';
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { getHostStartCallbacks } from '../../host-lifecycle.js';
import {
  getChannelAgentProvisioner,
  type ChannelAgentProvisioningContext,
} from '../permissions/channel-agent-provisioner.js';
import {
  createPendingChannelApproval,
  type PendingChannelApproval,
} from '../permissions/db/pending-channel-approvals.js';
import { upsertUser } from '../permissions/db/users.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { getProvider, persistProviderSettings, syncEnvironmentProvider } from './db.js';
import { opencodeChannelProvisioningMigration } from './migration.js';
import './index.js';

const now = () => new Date().toISOString();

/** Run the module's real host-start hook (the .env → environment-default mirror). */
async function runHostStart(): Promise<void> {
  for (const start of getHostStartCallbacks()) {
    await start({ db: getDb(), signal: new AbortController().signal });
  }
}

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

  afterEach(async () => {
    delete process.env.OPENCODE_AUTH_MODE;
    delete process.env.OPENCODE_PROVIDER;
    await closeDb();
  });

  it('can adopt the tables and provider_settings column left by the first-class implementation', async () => {
    if (opencodeChannelProvisioningMigration.sqliteOnly) throw new Error('expected a portable migration');
    await expect(opencodeChannelProvisioningMigration.up(getDb())).resolves.toBeUndefined();
  });

  it('snapshots ChatGPT auth only onto the environment-default connection', async () => {
    process.env.OPENCODE_AUTH_MODE = 'chatgpt';
    await ensureContainerConfig('anchor');
    await syncEnvironmentProvider({ providerId: 'openai' });
    const provider = await getProvider('environment-default');
    expect(provider).toBeDefined();
    await persistProviderSettings('anchor', provider!, {
      id: 'openai/gpt-5.4',
      contextLimit: 32768,
      outputLimit: 8192,
      inputModalities: 'text,image',
    });
    const config = await getContainerConfig('anchor');
    expect(JSON.parse(config!.provider_settings!)).toMatchObject({
      opencode: { authMode: 'chatgpt', modelProvider: 'openai' },
    });
  });

  it('keeps the host booting when an operator connection already holds the "Environment default" name', async () => {
    await getDb().run(
      `INSERT INTO opencode_model_providers
       (id, name, provider_id, discovery_type, base_url, models_url, context_limit, output_limit, input_modalities, instructions, enabled, created_at, updated_at)
       VALUES ('mine', 'Environment default', 'openrouter', 'models-dev', NULL, NULL, NULL, NULL, '', NULL, 1, ?, ?)`,
      now(),
      now(),
    );
    process.env.OPENCODE_PROVIDER = 'openai';
    // Before the fix this rejected with UNIQUE(name) → startHostModules rethrew → process.exit(1) on every boot.
    await expect(runHostStart()).resolves.toBeUndefined();
    expect(await getProvider('environment-default')).toMatchObject({
      provider_id: 'openai',
      name: 'Environment default (.env)',
    });
    expect(await getProvider('mine')).toMatchObject({ name: 'Environment default', provider_id: 'openrouter' });
  });

  it('the environment-default connection mirrors .env: ncl refuses to edit it, unsetting OPENCODE_PROVIDER disables it', async () => {
    process.env.OPENCODE_PROVIDER = 'openai';
    await runHostStart();

    const update = await dispatch(
      { id: 'u', command: 'opencode-model-providers-update', args: { id: 'environment-default', enabled: 0 } },
      { caller: 'host' },
    );
    expect(update).toMatchObject({ ok: false, error: { message: expect.stringContaining('.env') } });
    const remove = await dispatch(
      { id: 'd', command: 'opencode-model-providers-delete', args: { id: 'environment-default' } },
      { caller: 'host' },
    );
    expect(remove).toMatchObject({ ok: false, error: { message: expect.stringContaining('.env') } });
    expect(await getProvider('environment-default')).toMatchObject({ enabled: 1, provider_id: 'openai' });

    // Operator-created connections are unaffected.
    expect(
      await dispatch(
        { id: 'o', command: 'opencode-model-providers-update', args: { id: 'local', enabled: 0 } },
        { caller: 'host' },
      ),
    ).toMatchObject({ ok: true });
    expect(
      await dispatch({ id: 'x', command: 'opencode-model-providers-delete', args: { id: 'local' } }, { caller: 'host' }),
    ).toMatchObject({ ok: true, data: { deleted: 'local' } });
    expect(
      await dispatch({ id: 'n', command: 'opencode-model-providers-delete', args: { id: 'nope' } }, { caller: 'host' }),
    ).toMatchObject({ ok: false, error: { message: expect.stringContaining('not found') } });

    // The row follows .env: clearing OPENCODE_PROVIDER hides it from the wizard.
    delete process.env.OPENCODE_PROVIDER;
    await runHostStart();
    expect(await getProvider('environment-default')).toBeUndefined();
    expect(
      await getDb().get('SELECT enabled FROM opencode_model_providers WHERE id = ?', 'environment-default'),
    ).toEqual({ enabled: 0 });
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
      createAgent: async ({ name, provider, model, deliveryMode }) => {
        createdBeforeConfirmation = true;
        await createAgentGroup({
          id: 'created',
          name,
          folder: 'nanoclaw-jester',
          agent_provider: null,
          created_at: now(),
        });
        await ensureContainerConfig('created', provider);
        await updateContainerConfigScalars('created', { provider, model, delivery_mode: deliveryMode });
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
    // A stale OpenCode button from an earlier step is claimed and ignored — it
    // must never create anything ahead of confirmation.
    expect(await provisioner.handleResponse(context, response('opencode_confirm_agent'))).toBe(true);
    expect(createdBeforeConfirmation).toBe(false);

    await provisioner.handleResponse(context, response('opencode_model:openai%2Fselected-live-model'));
    expect(cards.at(-1)?.title).toContain('Confirm');
    expect(createdBeforeConfirmation).toBe(false);

    await provisioner.handleResponse(context, response('opencode_confirm_agent'));
    const config = await getContainerConfig('created');
    expect(config).toMatchObject({
      provider: 'opencode',
      model: 'openai/selected-live-model',
      delivery_mode: 'tools-only',
    });
    expect(JSON.parse(config!.provider_settings!)).toMatchObject({
      opencode: { modelProvider: 'openai', baseUrl: 'http://host.docker.internal:8891/v1', contextLimit: 65536 },
    });
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
    await provisioner.handleResponse(context, response('opencode_model:openai%2Fselected-live-model'));
    await provisioner.handleResponse(context, response('opencode_confirm_agent'));

    const config = await getContainerConfig('catalog-created');
    expect(config).toMatchObject({ provider: 'opencode', model: 'openai/selected-live-model' });
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

/**
 * Drives the real core registration handlers (permissions module) with the
 * OpenCode provisioner installed as the instance default. The original
 * card's buttons stay live on Slack/Discord/Mattermost after "Create new
 * agent" is clicked, so a change of mind ("Connect to existing X") must still
 * land — not vanish into the wizard's durable state.
 */
describe('OpenCode wizard hands core registration buttons back', () => {
  const originEvent = {
    channelType: 'fixture',
    platformId: 'room-1',
    threadId: null,
    message: {
      id: 'origin-mention',
      kind: 'chat-sdk' as const,
      content: JSON.stringify({ senderId: 'alice', senderName: 'Alice', text: '@bot hello' }),
      timestamp: now(),
      isMention: true,
      isGroup: true,
    },
  };

  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = await initTestDb();
    await runMigrations(db);
    await import('../permissions/index.js');
    delivered.length = 0;

    await createAgentGroup({ id: 'anchor', name: 'Anchor', folder: 'anchor', agent_provider: null, created_at: now() });
    await upsertUser({ id: 'fixture:owner', kind: 'fixture', display_name: 'Owner', created_at: now() });
    await grantRole({
      user_id: 'fixture:owner',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });
    await createMessagingGroup({
      id: 'mg-dm-owner',
      channel_type: 'fixture',
      platform_id: 'owner-dm',
      name: 'Owner DM',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    await getDb().run(
      'INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at) VALUES (?, ?, ?, ?)',
      'fixture:owner',
      'fixture',
      'mg-dm-owner',
      now(),
    );
    await createMessagingGroup({
      id: 'origin',
      channel_type: 'fixture',
      platform_id: 'room-1',
      name: 'Room',
      is_group: 1,
      unknown_sender_policy: 'request_approval',
      created_at: now(),
    });
    await createPendingChannelApproval({
      messaging_group_id: 'origin',
      agent_group_id: 'anchor',
      original_message: JSON.stringify(originEvent),
      approver_user_id: 'fixture:owner',
      created_at: now(),
      title: 'title',
      question: 'question',
      options_json: '[]',
    });
  });

  afterEach(async () => {
    await closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  async function click(value: string): Promise<void> {
    const { getResponseHandlers } = await import('../../response-registry.js');
    for (const handler of getResponseHandlers()) {
      const payload = {
        questionId: 'origin',
        value,
        userId: 'owner',
        channelType: 'fixture',
        platformId: 'owner-dm',
        threadId: null,
      };
      if (await handler(payload)) return;
    }
    throw new Error(`no response handler claimed ${value}`);
  }

  it('"Create new agent" then "Connect to existing" wires the existing agent and clears the wizard', async () => {
    await click('new_agent');
    expect(
      await getDb().get('SELECT step FROM opencode_channel_provisioning WHERE messaging_group_id = ?', 'origin'),
    ).toEqual({ step: 'awaiting_name' });
    expect(delivered.at(-1)?.content.text).toContain('name for your new agent');

    await click('connect:anchor');

    expect(
      await getDb().get(
        'SELECT agent_group_id FROM messaging_group_agents WHERE messaging_group_id = ?',
        'origin',
      ),
    ).toEqual({ agent_group_id: 'anchor' });
    expect(
      await getDb().get('SELECT 1 AS x FROM opencode_channel_provisioning WHERE messaging_group_id = ?', 'origin'),
    ).toBeUndefined();
    expect(
      await getDb().get('SELECT 1 AS x FROM pending_channel_approvals WHERE messaging_group_id = ?', 'origin'),
    ).toBeUndefined();
    // The approver is told the wizard was abandoned, through their DM.
    const notice = delivered.find((d) => String(d.content.text ?? '').includes('cancelled'));
    expect(notice).toMatchObject({ channelType: 'fixture', platformId: 'owner-dm' });
  });
});
