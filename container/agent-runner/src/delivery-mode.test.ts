import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { buildCompactInstructions } from './compact-instructions.js';
import { writeMessageOut, getUndeliveredMessages } from './db/messages-out.js';
import { buildSystemPromptAddendum } from './destinations.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { dispatchResultText, processQuery } from './poll-loop.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';
import type { RoutingContext } from './formatter.js';

const routing: RoutingContext = {
  platformId: 'channel-1',
  channelType: 'mattermost',
  threadId: 'thread-1',
  inReplyTo: 'request-1',
  taskRun: false,
  replyTargets: [
    {
      platformId: 'channel-1',
      channelType: 'mattermost',
      threadId: 'thread-1',
      inReplyTo: 'request-1',
    },
  ],
};

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());

function queryFor(
  ...results: Array<{ text: string | null; isError?: boolean }>
): { query: AgentQuery; pushes: string[] } {
  const pushes: string[] = [];
  async function* events(): AsyncGenerator<ProviderEvent> {
    yield { type: 'init', continuation: 'continuation-1' };
    for (const result of results) yield { type: 'result', ...result };
  }
  return {
    pushes,
    query: { events: events(), push: (text) => pushes.push(text), end: () => {}, abort: () => {} },
  };
}

function visibleRows() {
  return getUndeliveredMessages().filter((row) => row.kind === 'chat' || row.kind === 'chat-sdk');
}

describe('tools-only delivery', () => {
  it('keeps prose and message envelopes inert, corrects once, then uses a fixed exact-target placeholder', async () => {
    const { query, pushes } = queryFor(
      { text: '<message to="somewhere">private draft</message>' },
      { text: 'still only prose' },
    );

    await processQuery(query, routing, ['request-1'], 'mock', undefined, 'prompt', undefined, false, 'tools-only');

    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain('outbound messaging tool');
    expect(visibleRows()).toHaveLength(1);
    const row = visibleRows()[0];
    expect(JSON.parse(row.content).text).toBe("I couldn't put a reply together for that one. Try asking again.");
    expect(row.in_reply_to).toBe('request-1');
    expect(row.channel_type).toBe('mattermost');
    expect(row.thread_id).toBe('thread-1');
    expect(row.content).not.toContain('private draft');
  });

  it('accepts a real outbound tool write and does not coax a duplicate', async () => {
    const pushes: string[] = [];
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'continuation-1' };
      await writeMessageOut({
        id: 'tool-send-1',
        in_reply_to: 'request-1',
        kind: 'chat',
        platform_id: 'channel-1',
        channel_type: 'mattermost',
        thread_id: 'thread-1',
        content: JSON.stringify({ text: 'Delivered by the tool.' }),
      });
      yield { type: 'result', text: 'ordinary unwrapped summary' };
    }
    const query: AgentQuery = {
      events: events(),
      push: (text) => pushes.push(text),
      end: () => {},
      abort: () => {},
    };

    await processQuery(query, routing, ['request-1'], 'mock', undefined, 'prompt', undefined, false, 'tools-only');

    expect(pushes).toEqual([]);
    expect(visibleRows().map((row) => JSON.parse(row.content).text)).toEqual(['Delivered by the tool.']);
  });

  it('does not let a send on one route erase a different waiting route', async () => {
    const splitRouting: RoutingContext = {
      ...routing,
      replyTargets: [
        routing.replyTargets![0],
        { platformId: 'channel-2', channelType: 'slack', threadId: 'thread-2', inReplyTo: 'request-2' },
        { platformId: 'channel-3', channelType: 'discord', threadId: 'thread-3', inReplyTo: 'request-3' },
      ],
    };
    const pushes: string[] = [];
    async function* events(): AsyncGenerator<ProviderEvent> {
      await writeMessageOut({
        id: 'only-first-route',
        kind: 'chat',
        platform_id: 'channel-1',
        channel_type: 'mattermost',
        thread_id: 'thread-1',
        content: JSON.stringify({ text: 'Answer for route one.' }),
      });
      yield { type: 'result', text: 'sent one' };
      yield { type: 'result', text: 'retry remained dry' };
    }
    const query: AgentQuery = {
      events: events(),
      push: (text) => pushes.push(text),
      end: () => {},
      abort: () => {},
    };

    await processQuery(query, splitRouting, ['request-1', 'request-2', 'request-3'], 'mock', undefined, 'prompt', undefined, false, 'tools-only');

    expect(pushes).toHaveLength(1);
    const rows = visibleRows();
    expect(rows).toHaveLength(3);
    expect(rows[1].platform_id).toBe('channel-2');
    expect(rows[1].in_reply_to).toBe('request-2');
    expect(rows[2].platform_id).toBe('channel-3');
    expect(rows[2].in_reply_to).toBe('request-3');
  });

  it('does not add an error notice when a stream throws after a successful send', async () => {
    async function* events(): AsyncGenerator<ProviderEvent> {
      await writeMessageOut({
        id: 'before-throw',
        kind: 'chat',
        platform_id: 'channel-1',
        channel_type: 'mattermost',
        thread_id: 'thread-1',
        content: JSON.stringify({ text: 'Already answered.' }),
      });
      throw new Error('private provider failure');
    }
    const query: AgentQuery = { events: events(), push: () => {}, end: () => {}, abort: () => {} };

    await expect(
      processQuery(query, routing, ['request-1'], 'mock', undefined, 'prompt', undefined, false, 'tools-only', 0),
    ).rejects.toThrow('private provider failure');
    expect(visibleRows().map((row) => JSON.parse(row.content).text)).toEqual(['Already answered.']);
  });

  it('terminates an older dry request even when a fresh follow-up arrives before its retry result', async () => {
    const pushes: string[] = [];
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'result', text: 'dry first result' };
      getInboundDb()
        .prepare(
          `INSERT INTO messages_in
           (id, kind, timestamp, status, trigger, platform_id, channel_type, thread_id, content)
           VALUES (?, 'chat', ?, 'pending', 1, ?, ?, ?, ?)`,
        )
        .run(
          'request-2',
          new Date().toISOString(),
          'channel-2',
          'slack',
          'thread-2',
          JSON.stringify({ text: 'new question' }),
        );
      const deadline = Date.now() + 3000;
      while (!pushes.some((text) => text.includes('new question')) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      yield { type: 'result', text: 'old retry still dry' };
      yield { type: 'result', text: 'new retry still dry' };
    }
    const query: AgentQuery = {
      events: events(),
      push: (text) => pushes.push(text),
      end: () => {},
      abort: () => {},
    };

    await processQuery(query, routing, ['request-1'], 'mock', undefined, 'prompt', undefined, false, 'tools-only');

    const rows = visibleRows();
    expect(rows.map((row) => row.in_reply_to)).toEqual(['request-1', 'request-2']);
    expect(pushes.filter((text) => text.includes('No user-visible message'))).toHaveLength(2);
  });

  it('replaces provider error text with a fixed notice and stays silent for non-human wakes', async () => {
    const first = queryFor({ text: 'secret upstream failure detail', isError: true });
    await processQuery(first.query, routing, ['request-1'], 'mock', undefined, 'prompt', undefined, false, 'tools-only');
    expect(JSON.parse(visibleRows()[0].content).text).toBe(
      "Something went wrong on my side and I couldn't finish that one.",
    );
    expect(visibleRows()[0].content).not.toContain('upstream');

    closeSessionDb();
    initTestSessionDb();
    const background = queryFor({ text: 'another secret failure', isError: true });
    await processQuery(
      background.query,
      { ...routing, replyTargets: [], agentWake: true },
      ['agent-wake'],
      'mock',
      undefined,
      'prompt',
      undefined,
      false,
      'tools-only',
    );
    expect(visibleRows()).toEqual([]);
  });

  it('leaves the default envelope contract unchanged', async () => {
    const result = await dispatchResultText('<message to="missing">hello</message>', routing, {
      deliveryMode: 'tools-only',
    });
    expect(result.sent).toBe(0);
    expect(result.hasUnwrapped).toBe(false);

    const plain = await dispatchResultText('scratchpad', routing);
    expect(plain.hasUnwrapped).toBe(true);
  });

  it('teaches the same contract in the full and compact prompts', () => {
    expect(buildSystemPromptAddendum('Test Agent', { kind: 'chat' }, 'tools-only')).toContain('calling `send_message`');
    expect(buildCompactInstructions(['mattermost-test'], null, 'tools-only')).toContain('real outbound tool calls');
    expect(buildCompactInstructions(['mattermost-test'], null, 'envelope')).toContain('MUST wrap all responses');
  });
});
