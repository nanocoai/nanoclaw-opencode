import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { getUndeliveredMessages, writeMessageOut } from './db/messages-out.js';
import { clearCurrentInReplyTo, getCurrentInReplyTo, setCurrentInReplyTo } from './db/session-state.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { sendMessage } from './mcp-tools/core.js';
import { processQuery } from './poll-loop.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';
import type { RoutingContext } from './formatter.js';

/**
 * Tools-only reply reconciliation across a follow-up push, in the shape the
 * OpenCode provisioning wizard creates: a `tools-only` group on a shared
 * Mattermost wiring with threads enabled. Two facts of that shape drive
 * these tests:
 *
 *  - the session is not thread-bound (`session_routing.thread_id` is NULL),
 *    so a `send_message` row carries `thread_id` NULL even though the inbound
 *    row carries the thread the user posted in;
 *  - the provider keeps one query open for the container's lifetime, so every
 *    later user message is a follow-up push, never a new outer batch.
 *
 * The tool sends below go through the real `send_message` handler so the rows
 * carry exactly the `in_reply_to` / `thread_id` production stamps on them.
 */

const CHANNEL = { platformId: 'channel-1', channelType: 'mattermost' };

function routingFor(id: string, threadId: string | null): RoutingContext {
  return {
    ...CHANNEL,
    threadId,
    inReplyTo: id,
    taskRun: false,
    replyTargets: [{ ...CHANNEL, threadId, inReplyTo: id }],
  };
}

/** A shared (non-thread-bound) session on one Mattermost channel destination. */
function seedSharedSession(): void {
  const db = getInboundDb();
  db.exec(
    `CREATE TABLE session_routing (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       channel_type TEXT,
       platform_id TEXT,
       thread_id TEXT
     )`,
  );
  db.prepare('INSERT INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, ?, ?, NULL)').run(
    CHANNEL.channelType,
    CHANNEL.platformId,
  );
  db.prepare(
    `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
     VALUES ('mattermost-test', 'Mattermost', 'channel', ?, ?, NULL)`,
  ).run(CHANNEL.channelType, CHANNEL.platformId);
}

function insertInbound(id: string, threadId: string, text: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in
       (id, kind, timestamp, status, trigger, platform_id, channel_type, thread_id, content)
       VALUES (?, 'chat', ?, 'pending', 1, ?, ?, ?, ?)`,
    )
    .run(id, new Date().toISOString(), CHANNEL.platformId, CHANNEL.channelType, threadId, JSON.stringify({ text }));
}

async function waitForPush(pushes: string[], marker: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!pushes.some((text) => text.includes(marker)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function queryOver(events: AsyncGenerator<ProviderEvent>, pushes: string[]): AgentQuery {
  return { events, push: (text) => pushes.push(text), end: () => {}, abort: () => {} };
}

function visibleRows() {
  return getUndeliveredMessages().filter((row) => row.kind === 'chat' || row.kind === 'chat-sdk');
}

function visibleTexts(): string[] {
  return visibleRows().map((row) => JSON.parse(row.content).text);
}

function nudges(pushes: string[]): string[] {
  return pushes.filter((text) => text.includes('No user-visible message'));
}

beforeEach(() => {
  initTestSessionDb();
  seedSharedSession();
});
afterEach(() => {
  clearCurrentInReplyTo();
  closeSessionDb();
});

describe('tools-only reconciliation across a follow-up push', () => {
  it('attributes a tool send made after a follow-up push to the follow-up — no duplicate coax, no placeholder', async () => {
    const pushes: string[] = [];
    const stampAtSecondSend: Array<string | null> = [];
    // What runPollLoop publishes at batch start.
    setCurrentInReplyTo('request-1');

    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'continuation-1' };
      await sendMessage.handler({ to: 'mattermost-test', text: 'ALPHA' });
      yield { type: 'result', text: 'sent alpha' };

      // The user replies in a different thread while the query stays open.
      insertInbound('request-2', 'thread-2', 'second question');
      await waitForPush(pushes, 'second question');
      stampAtSecondSend.push(getCurrentInReplyTo());
      await sendMessage.handler({ to: 'mattermost-test', text: 'BETA' });
      yield { type: 'result', text: 'sent beta' };

      // A trailing dry turn: this is where an unmatched request-2 would be
      // paid off with the fixed placeholder.
      yield { type: 'result', text: 'nothing further' };
    }

    await processQuery(
      queryOver(events(), pushes),
      routingFor('request-1', 'thread-1'),
      ['request-1'],
      'mock',
      undefined,
      'prompt',
      undefined,
      false,
      'tools-only',
    );

    expect(stampAtSecondSend).toEqual(['request-2']);
    expect(nudges(pushes)).toEqual([]);
    expect(visibleTexts()).toEqual(['ALPHA', 'BETA']);
    expect(visibleRows()[1].in_reply_to).toBe('request-2');
    expect(visibleRows()[1].thread_id).toBeNull();
  });

  it('re-points the tool stamp at each follow-up in envelope mode too', async () => {
    const pushes: string[] = [];
    const stamps: Array<string | null> = [];
    setCurrentInReplyTo('request-1');

    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'result', text: '<message to="mattermost-test">one</message>' };
      insertInbound('request-2', 'thread-2', 'second question');
      await waitForPush(pushes, 'second question');
      stamps.push(getCurrentInReplyTo());
      yield { type: 'result', text: '<message to="mattermost-test">two</message>' };
    }

    await processQuery(queryOver(events(), pushes), routingFor('request-1', 'thread-1'), ['request-1'], 'mock');

    expect(stamps).toEqual(['request-2']);
    expect(visibleTexts()).toEqual(['one', 'two']);
  });

  it('accepts a thread-less tool send on the requesting chat as the reply to a threaded request', async () => {
    const pushes: string[] = [];
    async function* events(): AsyncGenerator<ProviderEvent> {
      // The shape of a `send_message` row in a shared session whose stamp is
      // stale: an older batch's id and the session's NULL thread.
      await writeMessageOut({
        id: 'tool-send-1',
        in_reply_to: 'request-0',
        kind: 'chat',
        platform_id: CHANNEL.platformId,
        channel_type: CHANNEL.channelType,
        thread_id: null,
        content: JSON.stringify({ text: 'Answered on the channel.' }),
      });
      yield { type: 'result', text: 'sent' };
    }

    await processQuery(
      queryOver(events(), pushes),
      routingFor('request-1', 'thread-1'),
      ['request-1'],
      'mock',
      undefined,
      'prompt',
      undefined,
      false,
      'tools-only',
    );

    expect(nudges(pushes)).toEqual([]);
    expect(visibleTexts()).toEqual(['Answered on the channel.']);
  });

  it('lets one thread-less send satisfy only the oldest of two threaded requests in one batch', async () => {
    const pushes: string[] = [];
    const twoThreads: RoutingContext = {
      ...routingFor('request-1', 'thread-1'),
      replyTargets: [
        { ...CHANNEL, threadId: 'thread-1', inReplyTo: 'request-1' },
        { ...CHANNEL, threadId: 'thread-2', inReplyTo: 'request-2' },
      ],
    };
    async function* events(): AsyncGenerator<ProviderEvent> {
      await writeMessageOut({
        id: 'tool-send-1',
        in_reply_to: 'request-0',
        kind: 'chat',
        platform_id: CHANNEL.platformId,
        channel_type: CHANNEL.channelType,
        thread_id: null,
        content: JSON.stringify({ text: 'One answer.' }),
      });
      yield { type: 'result', text: 'sent one' };
      yield { type: 'result', text: 'retry remained dry' };
    }

    await processQuery(
      queryOver(events(), pushes),
      twoThreads,
      ['request-1', 'request-2'],
      'mock',
      undefined,
      'prompt',
      undefined,
      false,
      'tools-only',
    );

    expect(nudges(pushes)).toHaveLength(1);
    const rows = visibleRows();
    expect(rows.map((row) => JSON.parse(row.content).text)).toEqual([
      'One answer.',
      "I couldn't put a reply together for that one. Try asking again.",
    ]);
    expect(rows[1].in_reply_to).toBe('request-2');
    expect(rows[1].thread_id).toBe('thread-2');
  });

  it('attributes by exact stamp first: a send stamped for the newer request leaves the older one open', async () => {
    const pushes: string[] = [];
    const twoThreads: RoutingContext = {
      ...routingFor('request-1', 'thread-1'),
      replyTargets: [
        { ...CHANNEL, threadId: 'thread-1', inReplyTo: 'request-1' },
        { ...CHANNEL, threadId: 'thread-2', inReplyTo: 'request-2' },
      ],
    };
    async function* events(): AsyncGenerator<ProviderEvent> {
      await writeMessageOut({
        id: 'tool-send-1',
        in_reply_to: 'request-2',
        kind: 'chat',
        platform_id: CHANNEL.platformId,
        channel_type: CHANNEL.channelType,
        thread_id: null,
        content: JSON.stringify({ text: 'Answer for two.' }),
      });
      yield { type: 'result', text: 'sent two' };
      yield { type: 'result', text: 'retry remained dry' };
    }

    await processQuery(
      queryOver(events(), pushes),
      twoThreads,
      ['request-1', 'request-2'],
      'mock',
      undefined,
      'prompt',
      undefined,
      false,
      'tools-only',
    );

    expect(nudges(pushes)).toHaveLength(1);
    const rows = visibleRows();
    expect(rows).toHaveLength(2);
    expect(rows[1].in_reply_to).toBe('request-1');
    expect(rows[1].thread_id).toBe('thread-1');
  });

  it('keeps two rows stamped for one asker on that asker: send_message then send_file never pays off the other', async () => {
    const pushes: string[] = [];
    const twoThreads: RoutingContext = {
      ...routingFor('request-1', 'thread-1'),
      replyTargets: [
        { ...CHANNEL, threadId: 'thread-1', inReplyTo: 'request-1' },
        { ...CHANNEL, threadId: 'thread-2', inReplyTo: 'request-2' },
      ],
    };
    async function* events(): AsyncGenerator<ProviderEvent> {
      for (const [id, text] of [
        ['tool-send-1', 'Here is the summary.'],
        ['tool-file-1', 'And the file.'],
      ]) {
        await writeMessageOut({
          id,
          in_reply_to: 'request-1',
          kind: 'chat',
          platform_id: CHANNEL.platformId,
          channel_type: CHANNEL.channelType,
          thread_id: null,
          content: JSON.stringify({ text }),
        });
      }
      yield { type: 'result', text: 'sent both to one' };
      yield { type: 'result', text: 'retry remained dry' };
    }

    await processQuery(
      queryOver(events(), pushes),
      twoThreads,
      ['request-1', 'request-2'],
      'mock',
      undefined,
      'prompt',
      undefined,
      false,
      'tools-only',
    );

    expect(nudges(pushes)).toHaveLength(1);
    const rows = visibleRows();
    expect(rows).toHaveLength(3);
    expect(rows[2].in_reply_to).toBe('request-2');
    expect(rows[2].thread_id).toBe('thread-2');
  });

  it('does not let a late row stamped for an already-answered request pay off a newer follow-up', async () => {
    const pushes: string[] = [];
    async function* events(): AsyncGenerator<ProviderEvent> {
      await writeMessageOut({
        id: 'tool-send-1',
        in_reply_to: 'request-1',
        kind: 'chat',
        platform_id: CHANNEL.platformId,
        channel_type: CHANNEL.channelType,
        thread_id: null,
        content: JSON.stringify({ text: 'Answer one.' }),
      });
      yield { type: 'result', text: 'sent one' };
      // request-1 is now settled. A follow-up arrives, and the next row still
      // carries request-1's stamp (read by the tool subprocess before the
      // refresh) — it belongs to request-1's thread of work, not to request-2.
      insertInbound('request-2', 'thread-2', 'second question');
      await waitForPush(pushes, 'second question');
      await writeMessageOut({
        id: 'tool-file-1',
        in_reply_to: 'request-1',
        kind: 'chat',
        platform_id: CHANNEL.platformId,
        channel_type: CHANNEL.channelType,
        thread_id: null,
        content: JSON.stringify({ text: 'Attachment for one.' }),
      });
      yield { type: 'result', text: 'sent file' };
      yield { type: 'result', text: 'retry remained dry' };
    }

    await processQuery(
      queryOver(events(), pushes),
      routingFor('request-1', 'thread-1'),
      ['request-1'],
      'mock',
      undefined,
      'prompt',
      undefined,
      false,
      'tools-only',
    );

    expect(nudges(pushes)).toHaveLength(1);
    const rows = visibleRows();
    expect(rows).toHaveLength(3);
    expect(rows[2].in_reply_to).toBe('request-2');
    expect(rows[2].thread_id).toBe('thread-2');
  });

  it('still holds a request open when the only sends are pinned to another thread or another chat', async () => {
    const pushes: string[] = [];
    async function* events(): AsyncGenerator<ProviderEvent> {
      await writeMessageOut({
        id: 'other-thread',
        in_reply_to: 'request-0',
        kind: 'chat',
        platform_id: CHANNEL.platformId,
        channel_type: CHANNEL.channelType,
        thread_id: 'thread-9',
        content: JSON.stringify({ text: 'Different thread.' }),
      });
      await writeMessageOut({
        id: 'other-chat',
        in_reply_to: 'request-0',
        kind: 'chat',
        platform_id: 'channel-2',
        channel_type: 'slack',
        thread_id: null,
        content: JSON.stringify({ text: 'Different chat.' }),
      });
      yield { type: 'result', text: 'sent elsewhere' };
    }

    await processQuery(
      queryOver(events(), pushes),
      routingFor('request-1', 'thread-1'),
      ['request-1'],
      'mock',
      undefined,
      'prompt',
      undefined,
      false,
      'tools-only',
    );

    expect(nudges(pushes)).toHaveLength(1);
  });
});
