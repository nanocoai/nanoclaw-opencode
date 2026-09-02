import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { buildCompactInstructions } from '../compact-instructions.js';
import { registerAgentMailbox, resetAgentMailboxForTesting, type AgentMailboxFactory } from '../mailbox/index.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { SqliteAgentMailbox } from '../mailbox/sqlite/index.js';
import {
  OpenCodeProvider,
  buildPostCompactionReminder,
  type OpenCodeMemorySessionHook,
  type OpenCodeRuntimeHandle,
  type QuestionClient,
} from './opencode.js';
import type { ProviderEvent } from './types.js';

/**
 * The post-compaction reminder must teach the delivery contract the poll-loop
 * actually enforces for this session. `compact-instructions.ts` (the Claude
 * PreCompact path) is mode-aware; this is the OpenCode provider's parallel
 * path, and the provisioning wizard creates every OpenCode group as
 * `tools-only` — where `<message to>` blocks are inert scratchpad, so a
 * reminder to wrap replies in them costs a nudge round trip per compaction.
 */

const TOOLS_ONLY_SENTENCE = 'Only real outbound tool calls deliver.';

describe('buildPostCompactionReminder delivery mode', () => {
  it('teaches the tools-only contract instead of <message to> wrapping', () => {
    const text = buildPostCompactionReminder(['ops'], 'tools-only');
    expect(text).toContain('compacted');
    expect(text).toContain(TOOLS_ONLY_SENTENCE);
    expect(text).toContain('`ops`');
    expect(text).not.toContain('<message to="name">');
  });

  it('keeps the envelope contract by default', () => {
    expect(buildPostCompactionReminder(['ops'])).toContain('<message to="name">');
    expect(buildPostCompactionReminder(['ops'], 'envelope')).toContain('<message to="name">');
  });

  it('shares its wording with the PreCompact instructions so the two paths cannot drift', () => {
    expect(buildCompactInstructions(['ops'], null, 'tools-only')).toContain(TOOLS_ONLY_SENTENCE);
    expect(buildCompactInstructions(['ops'], null, 'envelope')).toContain(
      'You MUST wrap all responses in <message to="name">...</message> blocks.',
    );
    expect(buildPostCompactionReminder(['ops'], 'envelope')).toContain(
      'You MUST wrap all responses in <message to="name">...</message> blocks.',
    );
  });

  it('teaches the one-door task contract for a task session, whatever the mode', () => {
    for (const mode of ['envelope', 'tools-only'] as const) {
      const text = buildPostCompactionReminder(['ops'], mode, 'daily-digest-a1b2');
      expect(text).toContain('send_message with an explicit to destination');
      expect(text).toContain('tasks/daily-digest-a1b2.md');
      expect(text).not.toContain('<message to="name">');
      expect(text).not.toContain(TOOLS_ONLY_SENTENCE);
    }
  });
});

// --- Provider wiring: the mode reaches the reminder through ProviderOptions ---

const MEMORY_HOOK: OpenCodeMemorySessionHook = {
  command: 'true',
  legacyCommands: [],
  sources: ['startup', 'clear', 'compact'],
};

type FakeEvent = { type: string; properties: Record<string, unknown> };

function assistantTurn(sessionID: string, text: string, compacts = false): FakeEvent[] {
  return [
    { type: 'message.updated', properties: { info: { id: 'msg_asst', role: 'assistant' } } },
    { type: 'message.part.updated', properties: { part: { type: 'text', messageID: 'msg_asst', text } } },
    ...(compacts ? [{ type: 'session.compacted', properties: { sessionID } }] : []),
    { type: 'session.idle', properties: { sessionID } },
  ];
}

function createFakeRuntime(script: FakeEvent[][]): {
  runtime: { getRuntime: () => Promise<OpenCodeRuntimeHandle> };
  prompts: string[];
} {
  const prompts: string[] = [];
  const queue: FakeEvent[] = [];
  const waiters: Array<() => void> = [];

  const pushEvents = (events: FakeEvent[]) => {
    queue.push(...events);
    while (waiters.length > 0 && queue.length > 0) waiters.shift()!();
  };

  async function* stream(): AsyncGenerator<FakeEvent, void, void> {
    while (true) {
      if (queue.length === 0) await new Promise<void>((resolve) => waiters.push(resolve));
      yield queue.shift()!;
    }
  }

  const questionClient: QuestionClient = {
    question: {
      async reply() {
        return { data: true };
      },
      async list() {
        return { data: [] };
      },
    },
  };

  const handle: OpenCodeRuntimeHandle = {
    questionClient,
    stream: stream(),
    client: {
      session: {
        async create() {
          return { data: { id: 'ses_1' } };
        },
        async promptAsync(params) {
          const first = params.body.parts[0] as { type: string; text?: string };
          prompts.push(first.text ?? '');
          const events = script[prompts.length - 1];
          if (!events) throw new Error(`no scripted events for prompt #${prompts.length}`);
          pushEvents(events);
          return {};
        },
      },
    },
  };

  return { prompts, runtime: { getRuntime: async () => handle } };
}

/** Drive a query through one compacting turn and one follow-up push; return the prompts sent. */
async function promptsAcrossCompaction(
  provider: OpenCodeProvider,
  fake: ReturnType<typeof createFakeRuntime>,
  cwd: string,
) {
  provider.registerMemorySessionHook(MEMORY_HOOK);
  const query = provider.query({ prompt: 'first question', cwd });
  const iterator = query.events[Symbol.asyncIterator]();
  const untilResult = async (): Promise<void> => {
    let next: IteratorResult<ProviderEvent>;
    do next = await iterator.next();
    while (!next.done && next.value.type !== 'result');
  };
  await untilResult();
  query.push('second question');
  await untilResult();
  query.end();
  while (!(await iterator.next()).done) {
    /* drain */
  }
  return fake.prompts;
}

describe('OpenCodeProvider post-compaction reminder', () => {
  let dir: string;
  let previousMailbox: AgentMailboxFactory | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-delivery-mode-'));
    previousMailbox = resetAgentMailboxForTesting();
    initTestSessionDb();
    registerAgentMailbox(() => new SqliteAgentMailbox());
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('mattermost-test', 'Mattermost', 'channel', 'mattermost', 'chan-1', NULL)`,
      )
      .run();
  });
  afterEach(() => {
    resetAgentMailboxForTesting();
    closeSessionDb();
    // Hand the process-wide slot back to whatever was registered before this
    // file ran, so later test files keep their mailbox.
    if (previousMailbox) registerAgentMailbox(previousMailbox);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('re-states the tools-only contract after a compaction when the group delivers via tools only', async () => {
    const fake = createFakeRuntime([assistantTurn('ses_1', 'ok', true), assistantTurn('ses_1', 'ok again')]);
    const provider = new OpenCodeProvider({ deliveryMode: 'tools-only' }, fake.runtime);

    const prompts = await promptsAcrossCompaction(provider, fake, dir);

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain('compacted');
    expect(prompts[1]).toContain('compacted');
    expect(prompts[1]).toContain(TOOLS_ONLY_SENTENCE);
    expect(prompts[1]).toContain('`mattermost-test`');
    expect(prompts[1]).not.toContain('<message to="name">');
    expect(prompts[1]).toContain('second question');
  });

  it('keeps the envelope contract for groups that deliver through <message to> blocks', async () => {
    const fake = createFakeRuntime([assistantTurn('ses_1', 'ok', true), assistantTurn('ses_1', 'ok again')]);
    const provider = new OpenCodeProvider({}, fake.runtime);

    const prompts = await promptsAcrossCompaction(provider, fake, dir);

    expect(prompts[1]).toContain('<message to="name">');
    expect(prompts[1]).not.toContain(TOOLS_ONLY_SENTENCE);
  });

  it('re-states the one-door task contract in an isolated task session, even for a tools-only group', async () => {
    // A task session is identified by its canonical thread id in
    // session_routing (host-written at wake) — the same read the Claude
    // PreCompact hook makes via getTaskSeriesId().
    const db = getInboundDb();
    db.exec(
      `CREATE TABLE session_routing (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         channel_type TEXT,
         platform_id TEXT,
         thread_id TEXT
       )`,
    );
    db.prepare(
      `INSERT INTO session_routing (id, channel_type, platform_id, thread_id)
       VALUES (1, 'mattermost', 'chan-1', 'system:tasks:daily-digest-a1b2')`,
    ).run();
    const fake = createFakeRuntime([assistantTurn('ses_1', 'ok', true), assistantTurn('ses_1', 'ok again')]);
    const provider = new OpenCodeProvider({ deliveryMode: 'tools-only' }, fake.runtime);

    const prompts = await promptsAcrossCompaction(provider, fake, dir);

    expect(prompts[1]).toContain('compacted');
    expect(prompts[1]).toContain('send_message with an explicit to destination');
    expect(prompts[1]).toContain('tasks/daily-digest-a1b2.md');
    expect(prompts[1]).toContain('`mattermost-test`');
    expect(prompts[1]).not.toContain('<message to="name">');
    expect(prompts[1]).not.toContain(TOOLS_ONLY_SENTENCE);
  });
});
