/**
 * wireApprovedChannel commits the wiring, the triggering sender's admission,
 * and the consumption of the pending approval as one central transaction.
 *
 * A host restart or a thrown insert between those writes must not leave a
 * half-connected channel: a wiring whose sender is still gated, or a wiring
 * whose registration card is still live (and would wire the channel again).
 * These tests fail the step after the wiring insert and assert that nothing
 * of the wiring survives while the approval stays actionable.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { addMember } from './db/agent-group-members.js';
import {
  createPendingChannelApproval,
  deletePendingChannelApproval,
  type PendingChannelApproval,
} from './db/pending-channel-approvals.js';
import { upsertUser } from './db/users.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../../delivery.js', () => ({
  getDeliveryAdapter: () => ({ deliver: vi.fn().mockResolvedValue('plat-msg-id') }),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-channel-approval-atomic',
    GROUPS_DIR: '/tmp/nanoclaw-test-channel-approval-atomic/groups',
  };
});

// Real implementations wrapped in spies so one test can make the step after
// the wiring insert throw while the others keep the real behavior.
vi.mock('./db/agent-group-members.js', async () => {
  const actual = await vi.importActual<typeof import('./db/agent-group-members.js')>('./db/agent-group-members.js');
  return { ...actual, addMember: vi.fn(actual.addMember) };
});
vi.mock('./db/pending-channel-approvals.js', async () => {
  const actual = await vi.importActual<typeof import('./db/pending-channel-approvals.js')>(
    './db/pending-channel-approvals.js',
  );
  return { ...actual, deletePendingChannelApproval: vi.fn(actual.deletePendingChannelApproval) };
});

const TEST_DIR = '/tmp/nanoclaw-test-channel-approval-atomic';
const now = () => new Date().toISOString();

const originEvent = {
  channelType: 'fixture',
  platformId: 'room-1',
  threadId: null,
  message: {
    id: 'origin-mention',
    kind: 'chat-sdk' as const,
    content: JSON.stringify({ senderId: 'caller', senderName: 'Caller', text: '@bot hello' }),
    timestamp: now(),
    isMention: true,
    isGroup: true,
  },
};

async function count(table: string): Promise<number> {
  return (await getDb().get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`))!.c;
}

async function snapshot() {
  return {
    wirings: await count('messaging_group_agents'),
    destinations: await count('agent_destinations'),
    members: await count('agent_group_members'),
    approvals: await count('pending_channel_approvals'),
  };
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
  vi.mocked(addMember).mockClear();
  vi.mocked(deletePendingChannelApproval).mockClear();

  await createAgentGroup({ id: 'ag-1', name: 'Andy', folder: 'andy', agent_provider: null, created_at: now() });
  await upsertUser({ id: 'fixture:owner', kind: 'fixture', display_name: 'Owner', created_at: now() });
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
    agent_group_id: 'ag-1',
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

async function pendingRow(): Promise<PendingChannelApproval> {
  return (await getDb().get<PendingChannelApproval>(
    'SELECT * FROM pending_channel_approvals WHERE messaging_group_id = ?',
    'origin',
  ))!;
}

describe('wireApprovedChannel atomicity', () => {
  it('commits wiring, sender admission, and approval consumption together', async () => {
    const { wireApprovedChannel } = await import('./index.js');
    await expect(wireApprovedChannel(await pendingRow(), 'ag-1', 'fixture:owner')).resolves.toBe(true);
    expect(await snapshot()).toEqual({ wirings: 1, destinations: 1, members: 1, approvals: 0 });
  });

  it('a failure admitting the sender rolls the wiring back and keeps the approval actionable', async () => {
    const { wireApprovedChannel } = await import('./index.js');
    vi.mocked(addMember).mockRejectedValueOnce(new Error('host died after the wiring insert'));

    await expect(wireApprovedChannel(await pendingRow(), 'ag-1', 'fixture:owner')).rejects.toThrow(
      'host died after the wiring insert',
    );

    // No half-connected channel: the wiring (and its destination) is gone,
    // nobody was admitted, and the card can still be acted on.
    expect(await snapshot()).toEqual({ wirings: 0, destinations: 0, members: 0, approvals: 1 });

    // The approval is still live: the retry wires the channel completely.
    await expect(wireApprovedChannel(await pendingRow(), 'ag-1', 'fixture:owner')).resolves.toBe(true);
    expect(await snapshot()).toEqual({ wirings: 1, destinations: 1, members: 1, approvals: 0 });
  });

  it('a failure consuming the approval rolls the wiring and the admission back', async () => {
    const { wireApprovedChannel } = await import('./index.js');
    vi.mocked(deletePendingChannelApproval).mockRejectedValueOnce(
      new Error('host died before the approval was consumed'),
    );

    await expect(wireApprovedChannel(await pendingRow(), 'ag-1', 'fixture:owner')).rejects.toThrow(
      'host died before the approval was consumed',
    );

    expect(await snapshot()).toEqual({ wirings: 0, destinations: 0, members: 0, approvals: 1 });
  });
});
