import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

import {
  destroySharedRuntime,
  OpenCodeProvider,
  setSharedRuntimeDepsForTesting,
  type OpenCodeMemorySessionHook,
  type OpenCodeSharedRuntimeDeps,
  type QuestionClient,
} from './opencode.js';
import type { ProviderEvent } from './types.js';

/**
 * The shared `opencode serve` lifecycle, driven through the
 * `setSharedRuntimeDepsForTesting` seam so no server process is ever spawned.
 *
 * Covers three review findings against the provider:
 *  - a failed or half-failed runtime init must never be cached, and a server
 *    that dies must drop out of the cache, so the next turn respawns it
 *    instead of every later message failing instantly with the same error;
 *  - `isSessionInvalid` must only fire on OpenCode's own session-not-found
 *    signal, never on backend/model errors, so a mistyped model id or a proxy
 *    hiccup does not wipe the stored conversation;
 *  - `abort()` stops one session and keeps the server; the in-turn watchdog
 *    treats the server's 10-second `server.heartbeat` as liveness.
 */

type Ev = { type: string; properties: Record<string, unknown> };

const MEMORY_HOOK: OpenCodeMemorySessionHook = {
  command: 'true',
  legacyCommands: [],
  sources: ['startup', 'compact'],
};

const CWD = '/tmp/opencode-shared-runtime-test';

function assistantReply(sessionID: string, text: string): Ev[] {
  return [
    { type: 'message.updated', properties: { info: { id: `msg_${text}`, role: 'assistant', sessionID } } },
    {
      type: 'message.part.updated',
      properties: { part: { type: 'text', messageID: `msg_${text}`, sessionID, text } },
    },
    { type: 'session.idle', properties: { sessionID } },
  ];
}

type FakeProc = ChildProcess & { kill: ReturnType<typeof mock>; emitExit(code: number): void };

/**
 * One fake server: a process handle whose `kill` ends the event stream (the
 * way SIGKILL drops a real SSE connection), plus a client whose `promptAsync`
 * hands the session id to the test so it decides what the server "emits".
 */
function fakeServer(onPrompt: (sessionId: string, promptIndex: number) => void) {
  const END = Symbol('end');
  const queue: Array<Ev | typeof END> = [];
  const waiters: Array<() => void> = [];
  const push = (events: Ev[]): void => {
    queue.push(...events);
    while (waiters.length > 0 && queue.length > 0) waiters.shift()!();
  };
  const endStream = (): void => {
    queue.push(END);
    while (waiters.length > 0) waiters.shift()!();
  };
  async function* stream(): AsyncGenerator<Ev, void, void> {
    while (true) {
      if (queue.length === 0) await new Promise<void>((resolve) => waiters.push(resolve));
      const ev = queue.shift()!;
      if (ev === END) return;
      yield ev;
    }
  }

  const emitter = new EventEmitter();
  const proc = Object.assign(emitter, {
    pid: undefined,
    exitCode: null as number | null,
    signalCode: null,
    // A real SIGKILL closes the socket but the SDK's SSE client reconnects
    // forever; only the subscription's abort signal ends the stream. Mirror
    // that: kill alone leaves the stream parked.
    kill: mock(() => true),
    emitExit(code: number) {
      proc.exitCode = code;
      emitter.emit('exit', code, null);
    },
  }) as unknown as FakeProc;

  let sessionCount = 0;
  let promptCount = 0;
  // A live server answers an abort with that session's own error event.
  const abort = mock(async (params: { path: { id: string } }) => {
    push([
      {
        type: 'session.error',
        properties: {
          sessionID: params.path.id,
          error: { name: 'MessageAbortedError', data: { message: 'aborted' } },
        },
      },
    ]);
    return {};
  });
  const subscribe = mock(async (opts?: { signal?: AbortSignal }) => {
    opts?.signal?.addEventListener('abort', () => endStream(), { once: true });
    return { stream: stream() };
  });
  const client = {
    event: { subscribe },
    session: {
      async create() {
        sessionCount += 1;
        return { data: { id: `ses_${sessionCount}` } };
      },
      async promptAsync(params: { path: { id: string }; body: { parts: unknown[] } }) {
        promptCount += 1;
        onPrompt(params.path.id, promptCount);
        return {};
      },
      abort,
    },
  };
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

  return { proc, client, questionClient, push, endStream, abort, subscribe };
}

function installDeps(servers: Array<ReturnType<typeof fakeServer>>, spawnFailures: Error[] = []) {
  let spawned = 0;
  let current: ReturnType<typeof fakeServer> | undefined;
  const spawnServer = mock(async () => {
    const failure = spawnFailures.shift();
    if (failure) throw failure;
    current = servers[spawned];
    if (!current) throw new Error(`test: no fake server for spawn #${spawned + 1}`);
    spawned += 1;
    return { url: `http://127.0.0.1:0/${spawned}`, proc: current.proc };
  });
  const deps: OpenCodeSharedRuntimeDeps = {
    spawnServer,
    createClient: () => current!.client,
    createQuestionClient: () => current!.questionClient,
  };
  setSharedRuntimeDepsForTesting(deps);
  return { spawnServer };
}

function newProvider(): OpenCodeProvider {
  const provider = new OpenCodeProvider({});
  provider.registerMemorySessionHook(MEMORY_HOOK);
  return provider;
}

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function runOneTurn(provider: OpenCodeProvider, continuation?: string): Promise<ProviderEvent[]> {
  const query = provider.query({ prompt: 'hi', cwd: CWD, continuation });
  query.end();
  return collect(query.events);
}

const resultText = (events: ProviderEvent[]) =>
  events.filter((e) => e.type === 'result').map((e) => (e as { text: string | null }).text);

beforeEach(() => {
  destroySharedRuntime();
});
afterEach(() => {
  destroySharedRuntime();
  setSharedRuntimeDepsForTesting(undefined);
});

describe('shared runtime recovery', () => {
  it('retries the spawn on the next query instead of caching the rejection', async () => {
    const server = fakeServer((sid) => server.push(assistantReply(sid, 'back')));
    const { spawnServer } = installDeps([server], [new Error('Timeout waiting for OpenCode server to start')]);
    const provider = newProvider();

    await expect(runOneTurn(provider)).rejects.toThrow('Timeout waiting for OpenCode server');
    expect(resultText(await runOneTurn(provider))).toEqual(['back']);
    expect(spawnServer).toHaveBeenCalledTimes(2);
  });

  it('kills a server whose client setup fails after the spawn, and respawns next time', async () => {
    const broken = fakeServer(() => {});
    broken.subscribe.mockImplementationOnce(async () => {
      throw new Error('subscribe exploded');
    });
    const healthy = fakeServer((sid) => healthy.push(assistantReply(sid, 'ok')));
    const { spawnServer } = installDeps([broken, healthy]);
    const provider = newProvider();

    await expect(runOneTurn(provider)).rejects.toThrow('subscribe exploded');
    expect(broken.proc.kill).toHaveBeenCalledTimes(1);

    expect(resultText(await runOneTurn(provider))).toEqual(['ok']);
    expect(spawnServer).toHaveBeenCalledTimes(2);
  });

  it('respawns after the server process exits between turns', async () => {
    const first = fakeServer((sid) => first.push(assistantReply(sid, 'one')));
    const second = fakeServer((sid) => second.push(assistantReply(sid, 'two')));
    const { spawnServer } = installDeps([first, second]);
    const provider = newProvider();

    expect(resultText(await runOneTurn(provider))).toEqual(['one']);
    first.proc.emitExit(137);

    expect(resultText(await runOneTurn(provider))).toEqual(['two']);
    expect(spawnServer).toHaveBeenCalledTimes(2);
  });

  it('server exit mid-turn fails the in-flight query promptly, keeps the continuation, and respawns', async () => {
    const dying = fakeServer(() => {
      // Prompt accepted, then the server is SIGKILLed before any event.
      setTimeout(() => dying.proc.emitExit(137), 20);
    });
    const healthy = fakeServer((sid) => healthy.push(assistantReply(sid, 'ok')));
    const { spawnServer } = installDeps([dying, healthy]);
    const provider = newProvider();

    let thrown: unknown;
    const started = Date.now();
    await runOneTurn(provider, 'ses_kept').catch((err: unknown) => {
      thrown = err;
    });
    expect((thrown as Error).message).toBe('OpenCode SSE stream ended unexpectedly');
    expect(Date.now() - started).toBeLessThan(2000);
    // The session on disk is intact: a dead server is not a stale session.
    expect(provider.isSessionInvalid(thrown)).toBe(false);
    // The subscription was opened with an abort signal and it was aborted.
    expect(dying.subscribe.mock.calls[0][0]?.signal?.aborted).toBe(true);
    // No retry cap: the SDK counts attempts cumulatively per subscription, so
    // a cap would end a long-lived stream on the Nth transient hiccup.
    expect((dying.subscribe.mock.calls[0][0] as { sseMaxRetryAttempts?: number })?.sseMaxRetryAttempts).toBeUndefined();

    expect(resultText(await runOneTurn(provider))).toEqual(['ok']);
    expect(spawnServer).toHaveBeenCalledTimes(2);
  });

  it('drops the runtime when the event stream ends mid-turn so the next query respawns', async () => {
    const dying = fakeServer(() => dying.endStream());
    const healthy = fakeServer((sid) => healthy.push(assistantReply(sid, 'ok')));
    const { spawnServer } = installDeps([dying, healthy]);
    const provider = newProvider();

    await expect(runOneTurn(provider)).rejects.toThrow('OpenCode SSE stream ended unexpectedly');
    expect(dying.proc.kill).toHaveBeenCalledTimes(1);

    expect(resultText(await runOneTurn(provider))).toEqual(['ok']);
    expect(spawnServer).toHaveBeenCalledTimes(2);
  });

  it('reuses one server across queries when nothing went wrong', async () => {
    const server = fakeServer((sid, n) => server.push(assistantReply(sid, `r${n}`)));
    const { spawnServer } = installDeps([server]);
    const provider = newProvider();

    expect(resultText(await runOneTurn(provider))).toEqual(['r1']);
    expect(resultText(await runOneTurn(provider, 'ses_1'))).toEqual(['r2']);
    expect(spawnServer).toHaveBeenCalledTimes(1);
    expect(server.proc.kill).not.toHaveBeenCalled();
  });
});

describe('isSessionInvalid', () => {
  const provider = newProvider();

  it("fires only on OpenCode's own NotFoundError for the session", () => {
    expect(
      provider.isSessionInvalid(
        new Error(
          'OpenCode promptAsync: {"name":"NotFoundError","data":{"message":"Session not found: ses_gone"}}',
        ),
      ),
    ).toBe(true);
  });

  it('keeps the continuation on backend, proxy and watchdog errors', () => {
    for (const msg of [
      '404 No endpoints found',
      'OpenCode retry limit (3): 404 No endpoints found',
      'read ECONNRESET',
      'connection reset by peer',
      'OpenCode event stream silent for 60000ms; server dropped',
      'OpenCode turn produced no activity for 900000ms; aborted',
      'OpenCode SSE stream ended unexpectedly',
      'OpenCode promptAsync: {}',
    ]) {
      expect(provider.isSessionInvalid(new Error(msg))).toBe(false);
    }
  });

  it('a backend 404 surfaced as session.error is a turn error, not a stale session', async () => {
    const server = fakeServer((sid) =>
      server.push([
        {
          type: 'session.error',
          properties: { sessionID: sid, error: { name: 'APIError', data: { message: '404 No endpoints found' } } },
        },
      ]),
    );
    installDeps([server]);
    const provider = newProvider();

    let thrown: unknown;
    await runOneTurn(provider, 'ses_1').catch((err: unknown) => {
      thrown = err;
    });
    expect((thrown as Error).message).toBe('404 No endpoints found');
    expect(provider.isSessionInvalid(thrown)).toBe(false);
  });

  it('a promptAsync NotFoundError for the resumed id is a stale session', async () => {
    const server = fakeServer(() => {});
    server.client.session.promptAsync = async () => ({
      error: { name: 'NotFoundError', data: { message: 'Session not found: ses_gone' } },
    });
    installDeps([server]);
    const provider = newProvider();

    let thrown: unknown;
    await runOneTurn(provider, 'ses_gone').catch((err: unknown) => {
      thrown = err;
    });
    expect(provider.isSessionInvalid(thrown)).toBe(true);
  });
});

describe('abort and watchdog', () => {
  it('abort() stops the in-flight session and keeps the shared server', async () => {
    const server = fakeServer(() => {});
    const { spawnServer } = installDeps([server]);
    const provider = newProvider();

    const query = provider.query({ prompt: 'work', cwd: CWD });
    const iterator = query.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: 'init', continuation: 'ses_1' });

    // The generator is now parked on stream.next() with a prompt in flight.
    const pendingNext = iterator.next();
    query.abort();
    expect(server.abort).toHaveBeenCalledTimes(1);
    expect(server.abort.mock.calls[0][0]).toEqual({ path: { id: 'ses_1' } });

    // What the server sends back for the aborted session (the fake abort
    // emits it) must not become this query's error.
    expect((await pendingNext).done).toBe(true);
    expect(server.proc.kill).not.toHaveBeenCalled();

    // The next query lands on the same server.
    const again = provider.query({ prompt: 'again', cwd: CWD });
    again.end();
    const promptedOn: string[] = [];
    server.client.session.promptAsync = async (params) => {
      promptedOn.push(params.path.id);
      server.push(assistantReply(params.path.id, 'fresh'));
      return {};
    };
    expect(resultText(await collect(again.events))).toEqual(['fresh']);
    expect(promptedOn).toEqual(['ses_2']);
    expect(spawnServer).toHaveBeenCalledTimes(1);
  });

  it('abort() while parked in session.create() stops the session it produces and sends no prompt', async () => {
    const server = fakeServer(() => {});
    let releaseCreate: (() => void) | undefined;
    const realCreate = server.client.session.create;
    server.client.session.create = async () => {
      await new Promise<void>((resolve) => {
        releaseCreate = resolve;
      });
      return realCreate();
    };
    const promptAsync = mock(server.client.session.promptAsync);
    server.client.session.promptAsync = promptAsync;
    installDeps([server]);
    const provider = newProvider();

    const query = provider.query({ prompt: 'work', cwd: CWD });
    const iterator = query.events[Symbol.asyncIterator]();
    const first = iterator.next();
    while (!releaseCreate) await new Promise((r) => setTimeout(r, 1));

    query.abort();
    releaseCreate();
    expect((await first).done).toBe(true);

    expect(promptAsync).not.toHaveBeenCalled();
    expect(server.abort).toHaveBeenCalledTimes(1);
    expect(server.abort.mock.calls[0][0]).toEqual({ path: { id: 'ses_1' } });
  });

  it('abort() while parked in promptAsync() re-aborts once the turn exists and processes nothing', async () => {
    const server = fakeServer(() => {});
    let releasePrompt: (() => void) | undefined;
    server.client.session.promptAsync = async (params) => {
      await new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });
      // The prompt registered server-side after the first abort; the model
      // starts answering.
      server.push(assistantReply(params.path.id, 'should never be delivered'));
      return {};
    };
    installDeps([server]);
    const provider = newProvider();

    const query = provider.query({ prompt: 'work', cwd: CWD });
    const iterator = query.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: 'init', continuation: 'ses_1' });
    const second = iterator.next();
    while (!releasePrompt) await new Promise((r) => setTimeout(r, 1));

    query.abort();
    releasePrompt();
    expect((await second).done).toBe(true);

    // Once at abort() time, once more after promptAsync resolved.
    expect(server.abort).toHaveBeenCalledTimes(2);
    for (const call of server.abort.mock.calls) expect(call[0]).toEqual({ path: { id: 'ses_1' } });
  });

  describe('with short watchdog budgets', () => {
    const saved: Record<string, string | undefined> = {};
    const KEYS = ['OPENCODE_IDLE_TIMEOUT_MS', 'OPENCODE_STREAM_SILENCE_MS'] as const;
    beforeEach(() => {
      for (const k of KEYS) saved[k] = process.env[k];
    });
    afterEach(() => {
      for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });

    it('stream tier: heartbeats keep a quiet tool run alive; only agent events count as activity', async () => {
      process.env.OPENCODE_STREAM_SILENCE_MS = '150';
      process.env.OPENCODE_IDLE_TIMEOUT_MS = '10000';
      const server = fakeServer((sid) => {
        // A tool that streams nothing for well over the silence budget while
        // the server's heartbeat keeps ticking, then the reply.
        let ticks = 0;
        const beat = setInterval(() => {
          server.push([{ type: 'server.heartbeat', properties: {} }]);
          ticks += 1;
          if (ticks >= 12) {
            clearInterval(beat);
            server.push(assistantReply(sid, 'done after a long tool'));
          }
        }, 40);
      });
      installDeps([server]);
      const provider = newProvider();

      const events = await runOneTurn(provider);
      expect(resultText(events)).toEqual(['done after a long tool']);
      expect(server.proc.kill).not.toHaveBeenCalled();
      expect(server.abort).not.toHaveBeenCalled();
      expect(events.filter((e) => e.type === 'activity').length).toBe(3);
    });

    it('stream tier: silence including heartbeats drops the server as genuine death', async () => {
      process.env.OPENCODE_STREAM_SILENCE_MS = '150';
      process.env.OPENCODE_IDLE_TIMEOUT_MS = '10000';
      const server = fakeServer(() => {});
      installDeps([server]);
      const provider = newProvider();

      await expect(runOneTurn(provider)).rejects.toThrow('OpenCode event stream silent for 150ms');
      expect(server.proc.kill).toHaveBeenCalledTimes(1);
      expect(server.abort).not.toHaveBeenCalled();
    });

    it('activity tier: a wedged backend on a live stream aborts the session and keeps the server', async () => {
      process.env.OPENCODE_STREAM_SILENCE_MS = '10000';
      process.env.OPENCODE_IDLE_TIMEOUT_MS = '150';
      const server = fakeServer(() => {
        const beat = setInterval(() => server.push([{ type: 'server.heartbeat', properties: {} }]), 40);
        setTimeout(() => clearInterval(beat), 2000);
      });
      const { spawnServer } = installDeps([server]);
      const provider = newProvider();

      await expect(runOneTurn(provider)).rejects.toThrow('OpenCode turn produced no activity for 150ms; aborted');
      expect(server.abort).toHaveBeenCalledTimes(1);
      expect(server.abort.mock.calls[0][0]).toEqual({ path: { id: 'ses_1' } });
      expect(server.proc.kill).not.toHaveBeenCalled();
      // A backend wedge is not a stale session: the continuation must survive.
      expect(provider.isSessionInvalid(new Error('OpenCode turn produced no activity for 150ms; aborted'))).toBe(
        false,
      );

      // The server is still the one we had.
      server.client.session.promptAsync = async (params) => {
        server.push(assistantReply(params.path.id, 'recovered'));
        return {};
      };
      expect(resultText(await runOneTurn(provider))).toEqual(['recovered']);
      expect(spawnServer).toHaveBeenCalledTimes(1);
    });
  });
});
