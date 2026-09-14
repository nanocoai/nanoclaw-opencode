import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { DeliveryMode } from './config.js';
import { getPendingMessages } from './db/messages-in.js';
import { getUndeliveredMessages, writeMessageOut } from './db/messages-out.js';
import { clearCurrentReplyRoute, clearTurnOutboundBaseline, getCurrentInReplyTo } from './db/session-state.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { runPollLoop, TOOLS_ONLY_ERROR_NOTICE } from './poll-loop.js';
import type { AgentProvider, ProviderEvent, ProviderExchange } from './providers/types.js';

const CHANNEL = { platformId: 'channel-1', channelType: 'mattermost' };
const DIAGNOSTIC = 'Native provider failed with private upstream diagnostic';
const ENVELOPE_ERROR_NOTICE = 'The agent run failed. Check the logs for details.';

function insertInbound(id: string, threadId: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in
       (id, kind, timestamp, status, trigger, platform_id, channel_type, thread_id, content)
       VALUES (?, 'chat', ?, 'pending', 1, ?, ?, ?, ?)`,
    )
    .run(id, new Date().toISOString(), CHANNEL.platformId, CHANNEL.channelType, threadId, JSON.stringify({ text: id }));
}

function answer(id: string, threadId: string): Promise<number> {
  return writeMessageOut({
    id: `answer-${id}`,
    in_reply_to: id,
    kind: 'chat',
    platform_id: CHANNEL.platformId,
    channel_type: CHANNEL.channelType,
    thread_id: threadId,
    content: JSON.stringify({ text: `Answered ${id}` }),
  });
}

function visibleRows() {
  return getUndeliveredMessages().filter((row) => row.kind === 'chat');
}

beforeEach(() => {
  initTestSessionDb();
  getInboundDb().exec(
    `CREATE TABLE session_routing (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       channel_type TEXT,
       platform_id TEXT,
       thread_id TEXT
     );
     INSERT INTO session_routing VALUES (1, 'mattermost', 'channel-1', NULL)`,
  );
});

afterEach(() => {
  clearCurrentReplyRoute();
  clearTurnOutboundBaseline();
  closeSessionDb();
});

/** A is answered, then a real active poll claims the follow-ups before the provider throws. */
async function failAfterFollowups(
  deliveryMode: DeliveryMode,
  followups: Array<{ id: string; threadId: string }>,
  answered = false,
  openingResult = true,
) {
  insertInbound('request-a', 'thread-a');
  const controller = new AbortController();
  const exchanges: ProviderExchange[] = [];
  const pushes: string[] = [];
  let routeAtFailure: string | null = null;
  let acceptPush: (() => void) | undefined;
  const pushed = new Promise<void>((resolve) => {
    acceptPush = resolve;
  });
  const failure = new Error(DIAGNOSTIC);
  const provider: AgentProvider = {
    registerMemorySessionHook: () => {},
    isSessionInvalid: () => false,
    onExchangeComplete: (exchange) => {
      exchanges.push(exchange);
      if (exchange.status === 'error') controller.abort();
    },
    query: () => {
      async function* events(): AsyncGenerator<ProviderEvent> {
        await answer('request-a', 'thread-a');
        if (openingResult) yield { type: 'result', text: '' };
        for (const followup of followups) insertInbound(followup.id, followup.threadId);
        await pushed;
        routeAtFailure = getCurrentInReplyTo();
        if (answered) {
          for (const followup of followups) await answer(followup.id, followup.threadId);
        }
        throw failure;
      }
      return {
        events: events(),
        push: (text) => {
          pushes.push(text);
          acceptPush?.();
        },
        end: () => {},
        abort: () => {},
      };
    },
  };
  const timeout = setTimeout(() => {
    controller.abort();
    acceptPush?.();
  }, 3000);
  try {
    await runPollLoop({
      provider,
      providerName: 'mock',
      cwd: '/workspace/agent',
      deliveryMode,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  expect(pushes).toHaveLength(1);
  for (const followup of followups) expect(pushes[0]).toContain(followup.id);
  expect(routeAtFailure).toBe(openingResult ? followups.at(-1)!.id : 'request-a');
  expect(exchanges.filter((exchange) => exchange.status === 'error')).toHaveLength(1);
  expect(exchanges.at(-1)!.result).toContain(DIAGNOSTIC);
  expect(getPendingMessages()).toEqual([]);
  expect(
    visibleRows()
      .map((row) => row.content)
      .join('\n'),
  ).not.toContain(DIAGNOSTIC);
}

for (const mode of ['envelope', 'tools-only'] as const) {
  describe(`${mode} thrown provider failure after a follow-up`, () => {
    const notice = mode === 'tools-only' ? TOOLS_ONLY_ERROR_NOTICE : ENVELOPE_ERROR_NOTICE;

    for (const threadId of ['thread-a', 'thread-b']) {
      it(`notifies the unanswered follow-up in ${threadId}, without re-notifying the answered opening request`, async () => {
        await failAfterFollowups(mode, [{ id: 'request-b', threadId }]);
        expect(visibleRows().map((row) => JSON.parse(row.content).text)).toEqual(['Answered request-a', notice]);
        expect(visibleRows()[1]).toMatchObject({
          in_reply_to: 'request-b',
          platform_id: CHANNEL.platformId,
          channel_type: CHANNEL.channelType,
          thread_id: threadId,
        });
      });
    }

    it('also notices a follow-up still queued behind an opening turn whose result never arrived', async () => {
      await failAfterFollowups(mode, [{ id: 'request-b', threadId: 'thread-b' }], false, false);
      expect(visibleRows().map((row) => JSON.parse(row.content).text)).toEqual(['Answered request-a', notice]);
      expect(visibleRows()[1]).toMatchObject({ in_reply_to: 'request-b', thread_id: 'thread-b' });
    });

    it('sends no failure notice when the follow-up already delivered before throwing', async () => {
      await failAfterFollowups(mode, [{ id: 'request-b', threadId: 'thread-b' }], true);
      expect(visibleRows().map((row) => JSON.parse(row.content).text)).toEqual([
        'Answered request-a',
        'Answered request-b',
      ]);
    });

    it('notifies every still-waiting address once when the claimed batch has several requests', async () => {
      await failAfterFollowups(mode, [
        { id: 'request-b', threadId: 'thread-b' },
        { id: 'request-c', threadId: 'thread-b' },
        { id: 'request-d', threadId: 'thread-d' },
      ]);
      expect(visibleRows().map((row) => JSON.parse(row.content).text)).toEqual(['Answered request-a', notice, notice]);
      expect(
        visibleRows()
          .slice(1)
          .map((row) => row.thread_id),
      ).toEqual(['thread-b', 'thread-d']);
    });
  });
}
