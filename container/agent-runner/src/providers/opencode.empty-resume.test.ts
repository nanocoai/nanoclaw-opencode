import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  isEmptyOpenCodeResume,
  OpenCodeProvider,
  type OpenCodeMemorySessionHook,
  type OpenCodeRuntimeHandle,
  type QuestionClient,
} from './opencode.js';
import type { ProviderEvent } from './types.js';

describe('isEmptyOpenCodeResume', () => {
  it('falls back only on a first empty resume', () => {
    expect(
      isEmptyOpenCodeResume({
        resumedExistingSession: true,
        alreadyFellBack: false,
        sawAssistantWork: false,
      }),
    ).toBe(true);
  });

  it('does not rotate a brand-new session that stays dry', () => {
    expect(
      isEmptyOpenCodeResume({
        resumedExistingSession: false,
        alreadyFellBack: false,
        sawAssistantWork: false,
      }),
    ).toBe(false);
  });

  it('does not rotate when the resume produced assistant work', () => {
    expect(
      isEmptyOpenCodeResume({
        resumedExistingSession: true,
        alreadyFellBack: false,
        sawAssistantWork: true,
      }),
    ).toBe(false);
  });

  it('falls back at most once per query', () => {
    expect(
      isEmptyOpenCodeResume({
        resumedExistingSession: true,
        alreadyFellBack: true,
        sawAssistantWork: false,
      }),
    ).toBe(false);
  });
});

const MEMORY_HOOK: OpenCodeMemorySessionHook = {
  command: 'true',
  legacyCommands: [],
  sources: ['startup', 'clear', 'compact'],
};

function userIdle(sessionID: string): Array<{ type: string; properties: Record<string, unknown> }> {
  return [
    { type: 'message.updated', properties: { info: { id: 'msg_user', role: 'user' } } },
    {
      type: 'message.part.updated',
      properties: { part: { type: 'text', messageID: 'msg_user', text: 'hey' } },
    },
    { type: 'session.idle', properties: { sessionID } },
  ];
}

function assistantReply(sessionID: string, text: string): Array<{ type: string; properties: Record<string, unknown> }> {
  return [
    { type: 'message.updated', properties: { info: { id: 'msg_asst', role: 'assistant' } } },
    {
      type: 'message.part.updated',
      properties: { part: { type: 'text', messageID: 'msg_asst', text } },
    },
    { type: 'session.idle', properties: { sessionID } },
  ];
}

function permissionOnly(sessionID: string): Array<{ type: string; properties: Record<string, unknown> }> {
  return [
    { type: 'permission.updated', properties: { id: 'perm_1', sessionID } },
    { type: 'session.idle', properties: { sessionID } },
  ];
}

function createFakeRuntime(script: Array<Array<{ type: string; properties: Record<string, unknown> }>>): {
  runtime: { getRuntime: () => Promise<OpenCodeRuntimeHandle> };
  promptIds: string[];
  created: string[];
} {
  const promptIds: string[] = [];
  const created: string[] = [];
  let nextCreate = 0;
  const queue: Array<{ type: string; properties: Record<string, unknown> }> = [];
  const waiters: Array<() => void> = [];

  const pushEvents = (events: Array<{ type: string; properties: Record<string, unknown> }>) => {
    queue.push(...events);
    while (waiters.length > 0 && queue.length > 0) waiters.shift()!();
  };

  async function* stream(): AsyncGenerator<{ type: string; properties: Record<string, unknown> }, void, void> {
    while (true) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
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
          nextCreate += 1;
          const id = `ses_fresh_${nextCreate}`;
          created.push(id);
          return { data: { id } };
        },
        async promptAsync(params) {
          promptIds.push(params.path.id);
          const events = script[promptIds.length - 1];
          if (!events) throw new Error(`no scripted events for prompt #${promptIds.length}`);
          pushEvents(events);
          return {};
        },
      },
    },
  };

  return {
    promptIds,
    created,
    runtime: { getRuntime: async () => handle },
  };
}

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('OpenCodeProvider empty-resume fallback', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-empty-resume-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('passes the query cwd into runtime creation', async () => {
    const fake = createFakeRuntime([assistantReply('ses_fresh_1', 'in the right directory')]);
    let runtimeCwd: string | undefined;
    const provider = new OpenCodeProvider(
      {},
      {
        getRuntime: async (options, cwd) => {
          runtimeCwd = cwd;
          return fake.runtime.getRuntime(options, cwd);
        },
      },
    );
    provider.registerMemorySessionHook(MEMORY_HOOK);
    const query = provider.query({ prompt: 'pwd', cwd: dir });
    query.end();
    await collect(query.events);

    expect(runtimeCwd).toBe(dir);
  });

  it('starts a fresh session when a resume idles with only the user echo', async () => {
    const fake = createFakeRuntime([userIdle('ses_stale'), assistantReply('ses_fresh_1', 'Hey!')]);
    const provider = new OpenCodeProvider({}, fake.runtime);
    provider.registerMemorySessionHook(MEMORY_HOOK);
    const query = provider.query({
      prompt: 'hey',
      cwd: dir,
      continuation: 'ses_stale',
    });
    const done = collect(query.events);
    query.end();
    const events = await done;

    expect(fake.promptIds).toEqual(['ses_stale', 'ses_fresh_1']);
    expect(fake.created).toEqual(['ses_fresh_1']);
    expect(events.filter((e) => e.type === 'init')).toEqual([
      { type: 'init', continuation: 'ses_stale' },
      { type: 'init', continuation: 'ses_fresh_1' },
    ]);
    expect(events.filter((e) => e.type === 'result')).toEqual([{ type: 'result', text: 'Hey!' }]);
  });

  it('keeps a resume that produced assistant text', async () => {
    const fake = createFakeRuntime([assistantReply('ses_ok', 'still here')]);
    const provider = new OpenCodeProvider({}, fake.runtime);
    provider.registerMemorySessionHook(MEMORY_HOOK);
    const query = provider.query({
      prompt: 'hey',
      cwd: dir,
      continuation: 'ses_ok',
    });
    const done = collect(query.events);
    query.end();
    const events = await done;

    expect(fake.promptIds).toEqual(['ses_ok']);
    expect(fake.created).toEqual([]);
    expect(events.filter((e) => e.type === 'init')).toEqual([{ type: 'init', continuation: 'ses_ok' }]);
    expect(events.filter((e) => e.type === 'result')).toEqual([{ type: 'result', text: 'still here' }]);
  });

  it('treats a permission grant as assistant work — tools-only send is not an empty resume', async () => {
    const fake = createFakeRuntime([permissionOnly('ses_ok')]);
    const provider = new OpenCodeProvider({}, fake.runtime);
    provider.registerMemorySessionHook(MEMORY_HOOK);
    const query = provider.query({
      prompt: 'hey',
      cwd: dir,
      continuation: 'ses_ok',
    });
    const done = collect(query.events);
    query.end();
    const events = await done;

    expect(fake.created).toEqual([]);
    expect(events.filter((e) => e.type === 'result')).toEqual([{ type: 'result', text: null }]);
  });

  it('does not create a second session when a new conversation stays dry', async () => {
    const fake = createFakeRuntime([userIdle('ses_fresh_1')]);
    const provider = new OpenCodeProvider({}, fake.runtime);
    provider.registerMemorySessionHook(MEMORY_HOOK);
    const query = provider.query({ prompt: 'hey', cwd: dir });
    const done = collect(query.events);
    query.end();
    const events = await done;

    expect(fake.created).toEqual(['ses_fresh_1']);
    expect(fake.promptIds).toEqual(['ses_fresh_1']);
    expect(events.filter((e) => e.type === 'init')).toEqual([{ type: 'init', continuation: 'ses_fresh_1' }]);
    expect(events.filter((e) => e.type === 'result')).toEqual([{ type: 'result', text: null }]);
  });

  it('does not mistake an empty pushed turn for a persisted resume', async () => {
    const fake = createFakeRuntime([assistantReply('ses_ok', 'first'), userIdle('ses_ok')]);
    const provider = new OpenCodeProvider({}, fake.runtime);
    provider.registerMemorySessionHook(MEMORY_HOOK);
    const query = provider.query({ prompt: 'first', cwd: dir, continuation: 'ses_ok' });
    query.push('follow-up');
    query.end();
    await collect(query.events);

    expect(fake.created).toEqual([]);
    expect(fake.promptIds).toEqual(['ses_ok', 'ses_ok']);
  });

  it('does not create a replacement session after abort', async () => {
    const fake = createFakeRuntime([userIdle('ses_stale')]);
    const provider = new OpenCodeProvider({}, fake.runtime);
    provider.registerMemorySessionHook(MEMORY_HOOK);
    const query = provider.query({ prompt: 'hey', cwd: dir, continuation: 'ses_stale' });
    const iterator = query.events[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toEqual({ type: 'init', continuation: 'ses_stale' });
    expect((await iterator.next()).value).toEqual({ type: 'activity' });
    query.abort();
    expect((await iterator.next()).done).toBe(true);
    expect(fake.created).toEqual([]);
  });

  it('does not count an echoed user attachment as assistant work', async () => {
    const fake = createFakeRuntime([
      [
        { type: 'message.updated', properties: { info: { id: 'msg_user', role: 'user' } } },
        { type: 'message.part.updated', properties: { part: { type: 'file', messageID: 'msg_user' } } },
        { type: 'session.idle', properties: { sessionID: 'ses_stale' } },
      ],
      assistantReply('ses_fresh_1', 'recovered'),
    ]);
    const provider = new OpenCodeProvider({}, fake.runtime);
    provider.registerMemorySessionHook(MEMORY_HOOK);
    const query = provider.query({ prompt: 'inspect this', cwd: dir, continuation: 'ses_stale' });
    query.end();
    await collect(query.events);

    expect(fake.created).toEqual(['ses_fresh_1']);
  });

  it('ignores foreign assistant events on the shared stream', async () => {
    const fake = createFakeRuntime([
      [
        {
          type: 'message.updated',
          properties: { info: { id: 'msg_foreign', role: 'assistant', sessionID: 'ses_other' } },
        },
        ...userIdle('ses_stale'),
      ],
      assistantReply('ses_fresh_1', 'recovered'),
    ]);
    const provider = new OpenCodeProvider({}, fake.runtime);
    provider.registerMemorySessionHook(MEMORY_HOOK);
    const query = provider.query({ prompt: 'hey', cwd: dir, continuation: 'ses_stale' });
    query.end();
    await collect(query.events);

    expect(fake.created).toEqual(['ses_fresh_1']);
  });
});
