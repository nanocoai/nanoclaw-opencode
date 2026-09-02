/**
 * Provider-provisioned "Connect new agent" on a multi-instance install.
 *
 * With one Slack app per agent group nothing is registered under the bare
 * `slack` key. The registration card goes out through the instance that
 * received the mention (`pickApprovalDelivery(..., originInstance)`), and the
 * provisioner's follow-up prompts and cards must address the same instance —
 * `ensureUserDm` without an instance hint resolves "first registered wins"
 * and lands in a different bot's DM (or nowhere). The approver's reply then
 * has to be recognised on that instance too: the user_dms cache holds only
 * default-instance rows, so `isApproverDm` cannot rely on it alone.
 */
import fs from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import type { ChannelAdapter, ChannelDefaults, InboundEvent } from '../../channels/adapter.js';
import {
  initChannelAdapters,
  registerChannelAdapter,
  teardownChannelAdapters,
} from '../../channels/channel-registry.js';
import { registerChannelAgentProvisioner } from './channel-agent-provisioner.js';
import { upsertUser } from './db/users.js';
import { grantRole } from './db/user-roles.js';

const TEST_DIR = '/tmp/nanoclaw-test-channel-approval-instance';
const PROVIDER = 'fixture-instance-provisioner';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

interface Delivered {
  channelType: string;
  platformId: string;
  instance: string | undefined;
  content: Record<string, unknown>;
}
const delivered: Delivered[] = [];
vi.mock('../../delivery.js', () => ({
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
    DATA_DIR: '/tmp/nanoclaw-test-channel-approval-instance',
    GROUPS_DIR: '/tmp/nanoclaw-test-channel-approval-instance/groups',
    DEFAULT_AGENT_PROVIDER: 'fixture-instance-provisioner',
  };
});

const slackDefaults: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

function slackInstance(instance: string): ChannelAdapter {
  return {
    name: instance,
    channelType: 'slack',
    instance,
    supportsThreads: true,
    async setup() {},
    async teardown() {},
    isConnected: () => true,
    async deliver() {
      return undefined;
    },
    // Each bot opens its own DM with the same human — distinct channel ids.
    openDM: async (handle: string) => `D-${instance}-${handle}`,
    defaults: slackDefaults,
  };
}

// Two named instances of one platform; nothing under the bare `slack` key.
// `slack-a` registers first, so a channelType-only lookup resolves to it.
registerChannelAdapter('slack-a', { factory: () => slackInstance('slack-a'), defaults: slackDefaults });
registerChannelAdapter('slack-b', { factory: () => slackInstance('slack-b'), defaults: slackDefaults });

// Minimal provisioner standing in for a provider wizard: a text prompt on
// start, a card on its own button, and it records what isApproverDm said
// about each reply it was handed.
const pendingByApprover = new Map<string, string>();
const approverDmVerdicts: boolean[] = [];
registerChannelAgentProvisioner({
  provider: PROVIDER,
  async start(context) {
    pendingByApprover.set(context.row.approver_user_id, context.row.messaging_group_id);
    await context.deliverText('Reply with the name for your new agent:');
  },
  async handleResponse(context, payload) {
    if (payload.value !== 'fixture_card') return false;
    await context.deliverQuestion('Pick', 'Pick one', [{ label: 'One', value: 'fixture_one' }]);
    return true;
  },
  pendingTextInputFor: async (approverUserId) => pendingByApprover.get(approverUserId),
  async handleText(context, event) {
    approverDmVerdicts.push(await context.isApproverDm(event));
    return true;
  },
});

beforeAll(async () => {
  await initChannelAdapters(() => ({
    onInbound() {},
    onInboundEvent() {},
    onMetadata() {},
    onAction() {},
  }));
});

afterAll(async () => {
  await teardownChannelAdapters();
});

function now() {
  return new Date().toISOString();
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
  await import('./index.js');

  await createAgentGroup({ id: 'ag-1', name: 'Andy', folder: 'andy', agent_provider: null, created_at: now() });
  await upsertUser({ id: 'slack:owner', kind: 'slack', display_name: 'Owner', created_at: now() });
  await grantRole({ user_id: 'slack:owner', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });

  delivered.length = 0;
  pendingByApprover.clear();
  approverDmVerdicts.length = 0;
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

function mentionOn(instance: string, platformId: string): InboundEvent {
  return {
    channelType: 'slack',
    instance,
    platformId,
    threadId: null,
    message: {
      id: `msg-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat-sdk',
      content: JSON.stringify({ senderId: 'U_ALICE', senderName: 'Alice', text: '<@bot> hello' }),
      timestamp: now(),
      isMention: true,
      isGroup: true,
    },
  };
}

function ownerReplyOn(instance: string, platformId: string, text: string): InboundEvent {
  return {
    channelType: 'slack',
    instance,
    platformId,
    threadId: null,
    message: {
      id: `msg-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat-sdk',
      content: JSON.stringify({ senderId: 'owner', senderName: 'Owner', text }),
      timestamp: now(),
    },
  };
}

async function click(questionId: string, value: string, platformId: string): Promise<void> {
  const { getResponseHandlers } = await import('../../response-registry.js');
  for (const handler of getResponseHandlers()) {
    if (await handler({ questionId, value, userId: 'owner', channelType: 'slack', platformId, threadId: null })) {
      return;
    }
  }
  throw new Error(`no handler claimed ${value}`);
}

describe('provider-provisioned new agent on a multi-instance install', () => {
  it('prompts, cards, and hears the reply through the instance that received the mention', async () => {
    const { routeInbound } = await import('../../router.js');

    // Mention arrives on the second bot; the card goes out through it.
    await routeInbound(mentionOn('slack-b', 'C-B-room'));
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    expect(delivered[0]).toMatchObject({ instance: 'slack-b', platformId: 'D-slack-b-owner' });
    expect(delivered[0].content.type).toBe('ask_question');
    const questionId = delivered[0].content.questionId as string;

    // "Connect new agent" → the provisioner's name prompt must come from the same bot.
    await click(questionId, 'new_agent', 'D-slack-b-owner');
    expect(delivered).toHaveLength(2);
    expect(delivered[1]).toMatchObject({ instance: 'slack-b', platformId: 'D-slack-b-owner' });
    expect(delivered[1].content.text).toContain('name for your new agent');

    // The owner's reply in that bot's DM is recognised as the approver DM.
    await routeInbound(ownerReplyOn('slack-b', 'D-slack-b-owner', 'Bravo'));
    expect(approverDmVerdicts).toEqual([true]);

    // A reply in the OTHER bot's DM is not.
    await routeInbound(ownerReplyOn('slack-a', 'D-slack-a-owner', 'Not for you'));
    expect(approverDmVerdicts).toEqual([true, false]);

    // Provisioner cards keep addressing the originating instance.
    await click(questionId, 'fixture_card', 'D-slack-b-owner');
    expect(delivered).toHaveLength(3);
    expect(delivered[2]).toMatchObject({ instance: 'slack-b', platformId: 'D-slack-b-owner' });
    expect(delivered[2].content.type).toBe('ask_question');
  });
});
