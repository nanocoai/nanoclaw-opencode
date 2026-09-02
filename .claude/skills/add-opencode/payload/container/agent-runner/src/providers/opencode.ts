import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { lstatSync, realpathSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

import { createOpencodeClient, type FilePartInput } from '@opencode-ai/sdk';
// The root client has no `.question` surface; reply/reject/list for the
// interactive `question` tool live on the `/v2` subpath client. Import it
// separately so the session/event client above is untouched.
import { createOpencodeClient as createOpencodeQuestionClient } from '@opencode-ai/sdk/v2';

import { registerProvider } from './provider-registry.js';
import type {
  AgentProvider,
  AgentQuery,
  PromptAttachment,
  ProviderEvent,
  ProviderOptions,
  QueryInput,
} from './types.js';
import { mcpServersToOpenCodeConfig } from './mcp-to-opencode.js';
import { buildDeliveryReminder } from '../compact-instructions.js';
import type { DeliveryMode } from '../config.js';
import { getTaskSeriesId } from '../db/session-routing.js';
import { getAllDestinations } from '../destinations.js';

function log(msg: string): void {
  console.error(`[opencode-provider] ${msg}`);
}

// The input modalities OpenCode's config schema accepts on a model entry
// (@opencode-ai/sdk types.gen.d.ts `modalities.input`). Anything outside this
// set makes OpenCode reject the whole config, so operator input is validated
// against it rather than passed through.
const MODEL_INPUT_MODALITIES = ['text', 'audio', 'image', 'video', 'pdf'] as const;

const SESSION_STATUS_RETRY_ERROR_AFTER = 3;

/**
 * In-turn watchdog defaults (see the two tiers in `query()`). Env overrides:
 * `OPENCODE_STREAM_SILENCE_MS` and `OPENCODE_IDLE_TIMEOUT_MS`. The server
 * heartbeats every 10 s, so 60 s of total silence is six missed beats; the
 * activity budget is generous because a single tool call (a long build, a
 * browser session) legitimately streams nothing for many minutes.
 */
const DEFAULT_STREAM_SILENCE_MS = 60_000;
const DEFAULT_IDLE_TIMEOUT_MS = 900_000;

const AGENT_DIR = '/workspace/agent';
const DEFAULT_NATIVE_ATTACHMENT_MAX_COUNT = 8;
const DEFAULT_NATIVE_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * The one signal that a stored continuation names a session the OpenCode
 * server no longer has. The server's session lookup fails with its
 * `NotFoundError` (`{ name: "NotFoundError", data: { message: "Session not
 * found: <id>" } }`, HTTP 404 — @opencode-ai/sdk types.gen.d.ts
 * `SessionPromptAsyncErrors[404]`), and the SDK's result tuple hands that body
 * back unchanged, so it reaches the poll-loop JSON-stringified inside the
 * `OpenCode promptAsync:` / `failed to create session:` errors thrown below.
 *
 * Deliberately NOT matched: bare `404`, `connection reset`, `ECONNRESET`, or
 * the watchdog's `event timeout`. Those describe the model backend, the local
 * proxy, or this process's SSE stream — the on-disk session is intact and the
 * next turn should resume it. A `session.error` event can only carry
 * `ProviderAuthError | UnknownError | MessageOutputLengthError |
 * MessageAbortedError | ApiError` (never `NotFoundError`), and
 * `sessionErrorMessage` forwards just its `data.message`, so a backend reply
 * such as "404 No endpoints found" never reaches this predicate as a stale
 * session. Same posture as the Claude provider's narrow `STALE_SESSION_RE`.
 */
const STALE_SESSION_RE = /"name":"NotFoundError"/;

/**
 * Codex `startOrResumeCodexThread` starts a fresh thread when `thread/resume`
 * reports the id gone. OpenCode's equivalent failure is quieter: a poisoned
 * session accepts `promptAsync`, emits `session.idle` at step 0 with no
 * assistant work, and the runner treats that as a finished turn. Only a
 * *resume* that produced no assistant work should fall back, and only once
 * per query — a brand-new session that stays dry is a model/tools miss, not
 * a dead continuation.
 */
export function isEmptyOpenCodeResume(opts: {
  resumedExistingSession: boolean;
  alreadyFellBack: boolean;
  sawAssistantWork: boolean;
}): boolean {
  return opts.resumedExistingSession && !opts.alreadyFellBack && !opts.sawAssistantWork;
}

function killProcessTree(proc: ChildProcess): void {
  if (proc.pid) {
    try {
      process.kill(-proc.pid, 'SIGKILL');
      return;
    } catch {
      /* fall through to the single-process kill */
    }
  }
  // No pid (spawn never produced one) or the group signal failed: best-effort
  // on the handle itself. A ChildProcess without a pid returns false here.
  try {
    proc.kill('SIGKILL');
  } catch {
    /* ignore */
  }
}

function spawnOpencodeServer(
  config: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<{ url: string; proc: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const hostname = '127.0.0.1';
    const port = 4096;
    const proc = spawn('opencode', ['serve', `--hostname=${hostname}`, `--port=${port}`], {
      // `opencode serve` has no directory flag. Its cwd is the project root
      // used by native document discovery and built-in filesystem tools.
      cwd: AGENT_DIR,
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      },
      detached: true,
    });

    const id = setTimeout(() => {
      killProcessTree(proc);
      reject(new Error(`Timeout waiting for OpenCode server to start after ${timeoutMs}ms`));
    }, timeoutMs);

    let output = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      for (const line of output.split('\n')) {
        if (line.startsWith('opencode server listening')) {
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
          if (match) {
            clearTimeout(id);
            resolve({ url: match[1], proc });
          }
        }
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    proc.on('exit', (code) => {
      clearTimeout(id);
      let msg = `OpenCode server exited with code ${code}`;
      if (output.trim()) msg += `\nServer output: ${output}`;
      reject(new Error(msg));
    });
    proc.on('error', (err) => {
      clearTimeout(id);
      reject(err);
    });
  });
}

/**
 * The shared attachment contract carries only host-staged files, bound to the
 * source message whose inbox owns them. Remote URLs remain prompt text and are
 * never fetched implicitly.
 *
 * Attachments are ALSO described inline in the prompt text the formatter
 * produces, and that text rendering stays the contract every provider relies
 * on. Everything below is an additive view for OpenCode's file parts: when no
 * structured attachment arrives, the provider behaves exactly as it did before.
 */
type OpenCodePromptAttachment = PromptAttachment;

/** Extension → MIME fallback, for adapters that report no `mimeType`. */
const ATTACHMENT_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.pdf': 'application/pdf',
};

function attachmentMime(att: OpenCodePromptAttachment): string | undefined {
  if (att.mime) return att.mime;
  const name = att.path || att.filename || '';
  const dot = name.lastIndexOf('.');
  return dot < 0 ? undefined : ATTACHMENT_MIME_BY_EXT[name.slice(dot).toLowerCase()];
}

export interface NativeAttachmentLimits {
  maxCount: number;
  maxBytes: number;
}

export interface NativeAttachmentFileInfo {
  realPath: string;
  size: number;
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  const parsed = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    log(`Ignoring invalid ${name}: "${raw}"`);
    return fallback;
  }
  return parsed;
}

export function resolveNativeAttachmentLimits(): NativeAttachmentLimits {
  return {
    maxCount: positiveIntegerEnv('OPENCODE_NATIVE_ATTACHMENT_MAX_COUNT', DEFAULT_NATIVE_ATTACHMENT_MAX_COUNT),
    maxBytes: positiveIntegerEnv('OPENCODE_NATIVE_ATTACHMENT_MAX_BYTES', DEFAULT_NATIVE_ATTACHMENT_MAX_BYTES),
  };
}

function inspectNativeAttachment(filePath: string): NativeAttachmentFileInfo | null {
  try {
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return { realPath: realpathSync(filePath), size: stat.size };
  } catch {
    return null;
  }
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isSafeComponent(value: string): boolean {
  return (
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0')
  );
}

/**
 * Turn a turn's attachments into OpenCode file parts, so the model sees the
 * media itself rather than only the `[image: cat.png — saved to …]` line the
 * formatter already renders into the prompt text.
 *
 * The URL is a `file://` path, NOT a data: URI, deliberately: OpenCode resolves
 * a file: part server-side and converts supported local media for the model.
 * Base64-ing here would duplicate that work and inflate the request body. The
 * server shares this container's filesystem (spawnOpencodeServer), so the path
 * resolves.
 *
 * Only images and PDFs are forwarded; PDFs go through even though a given
 * backend may reject them, since the alternative is silently withholding a
 * document the user did send. Anything skipped is still described in the
 * prompt text, so it is never lost — just not handed over as media.
 *
 * `exists` is injectable so tests can drive resolvability without touching disk.
 */
export function buildAttachmentFileParts(
  attachments: OpenCodePromptAttachment[] | undefined,
  inspect: (path: string) => NativeAttachmentFileInfo | null = inspectNativeAttachment,
  limits: NativeAttachmentLimits = resolveNativeAttachmentLimits(),
): FilePartInput[] {
  const parts: FilePartInput[] = [];
  let totalBytes = 0;
  for (const att of attachments ?? []) {
    if (parts.length >= limits.maxCount) {
      log(`Native attachment count limit reached (${limits.maxCount}); remaining files stay prompt text only`);
      break;
    }
    if (!isSafeComponent(att.sourceMessageId) || !isSafeComponent(att.filename)) continue;
    const expectedRoot = `/workspace/inbox/${att.sourceMessageId}`;
    const expectedPath = `${expectedRoot}/${att.filename}`;
    if (path.resolve(att.path) !== expectedPath) {
      log(`Attachment path is not bound to its source message, not sent as media: ${att.filename}`);
      continue;
    }
    const mime = attachmentMime(att);
    if (!mime) continue;
    if (!mime.startsWith('image/') && mime !== 'application/pdf') continue;
    const info = inspect(att.path);
    if (!info || !isPathInside(expectedRoot, info.realPath) || path.basename(info.realPath) !== att.filename) {
      log(`Attachment has no safe regular file, not sent as media: ${att.filename}`);
      continue;
    }
    if (info.size < 0 || totalBytes + info.size > limits.maxBytes) {
      log(`Native attachment byte limit reached (${limits.maxBytes}); ${att.filename} stays prompt text only`);
      continue;
    }
    totalBytes += info.size;
    // OpenCode appends file parts after the combined batch text. Prefix the
    // display name with the source id so two messages carrying `image.png`
    // remain unambiguous to the model; the prompt text keeps the original name.
    parts.push({
      type: 'file',
      mime,
      filename: `${att.sourceMessageId}--${att.filename}`,
      url: pathToFileURL(info.realPath).href,
    });
  }
  return parts;
}

/**
 * The prompt body for one turn: the text the formatter produced, plus any
 * media that came with it. Both the opening prompt and every mid-turn push go
 * through here, so an attachment reaches the model the same way whichever path
 * carried it — OpenCode holds one query open per session, so in practice most
 * real messages arrive as pushes.
 */
export function buildPromptParts(
  text: string,
  attachments?: OpenCodePromptAttachment[],
  inspect: (path: string) => NativeAttachmentFileInfo | null = inspectNativeAttachment,
  limits: NativeAttachmentLimits = resolveNativeAttachmentLimits(),
): Array<{ type: 'text'; text: string } | FilePartInput> {
  return [{ type: 'text', text }, ...buildAttachmentFileParts(attachments, inspect, limits)];
}

function wrapPromptWithContext(text: string, systemInstructions?: string): string {
  let out = text;
  if (systemInstructions) {
    out = `<system>\n${systemInstructions}\n</system>\n\n${out}`;
  }
  return out;
}

// A limit env var must be a bare positive integer (a token count) — units
// ("64k"), blank strings, zero, and negatives are rejected rather than
// coerced: Number() would turn blank into 0 (silently disables compaction,
// see below) and "64k" into NaN (the emitted config becomes unparseable
// JSON, and OpenCode fails to start). Invalid input is treated as unset.
function parseLimitEnv(varName: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed) || Number(trimmed) <= 0) {
    log(`Ignoring invalid ${varName}: "${raw}"`);
    return undefined;
  }
  return Number(trimmed);
}

export function buildOpenCodeConfig(options: ProviderOptions): Record<string, unknown> {
  const provider = process.env.OPENCODE_PROVIDER || 'anthropic';
  const model = options.model ?? process.env.OPENCODE_MODEL;
  const smallModel = process.env.OPENCODE_SMALL_MODEL;
  // Reasoning effort from the group's container config (ncl groups config
  // update --effort). OpenCode forwards a free-form per-model `options` object
  // to the ai-sdk provider, which maps reasoningEffort onto reasoning_effort in
  // the request body.
  const effort = options.effort;
  const proxyUrl = process.env.ANTHROPIC_BASE_URL;

  const providerModelId = model ? model.replace(new RegExp(`^${provider}/`), '') : undefined;
  const providerSmallModelId = smallModel ? smallModel.replace(new RegExp(`^${provider}/`), '') : undefined;
  const modelsToRegister = [providerModelId, providerSmallModelId]
    .filter(Boolean)
    .filter((mid, i, a) => a.indexOf(mid as string) === i);

  // OpenCode auto-compacts a session once tokens >= limit.context - maxOutputTokens.
  // Undeclared custom models resolve limit.context to 0, which silently disables
  // compaction and kills long sessions against a fixed-window backend (e.g. vLLM).
  // Absent these env vars, behavior is unchanged (no `limit` key emitted).
  const contextLimitEnv = process.env.OPENCODE_MODEL_CONTEXT_LIMIT;
  const outputLimitEnv = process.env.OPENCODE_MODEL_OUTPUT_LIMIT;
  const contextLimit = parseLimitEnv('OPENCODE_MODEL_CONTEXT_LIMIT', contextLimitEnv);
  const outputLimit = parseLimitEnv('OPENCODE_MODEL_OUTPUT_LIMIT', outputLimitEnv);
  if (outputLimitEnv !== undefined && contextLimit === undefined) {
    log('Ignoring OPENCODE_MODEL_OUTPUT_LIMIT: no valid OPENCODE_MODEL_CONTEXT_LIMIT to pair it with');
  }
  const modelLimit =
    contextLimit !== undefined
      ? { context: contextLimit, ...(outputLimit !== undefined ? { output: outputLimit } : {}) }
      : undefined;

  // OpenCode drops every non-text file part whose modality the model does not
  // declare: the provider transform keeps a part only when the model advertises
  // that input modality, and otherwise substitutes
  // `ERROR: Cannot read … (this model does not support <modality> input)`.
  // A registry-unknown custom model resolves each of those flags to false
  // (provider/provider.ts:1154-1158), so an image reaches the session store but
  // never the model — live-confirmed on a vLLM-hosted model, which answered
  // that it does not support image input while the prompt carried zero image
  // tokens. Declaring the modalities is the only thing that opens that gate;
  // `attachment` is a registry/UI flag rather than a pipeline gate, but it is
  // set alongside so the entry stays internally consistent.
  // Absent this env var, behavior is unchanged (no capability keys emitted).
  const modalityEnv = process.env.OPENCODE_MODEL_INPUT_MODALITIES;
  const requestedModalities = (modalityEnv ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .filter((entry, i, a) => a.indexOf(entry) === i)
    .filter((entry) => {
      if ((MODEL_INPUT_MODALITIES as readonly string[]).includes(entry)) return true;
      log(`Ignoring unknown OPENCODE_MODEL_INPUT_MODALITIES entry: ${entry}`);
      return false;
    })
    .filter((entry) => entry !== 'text');
  const modelModalities =
    requestedModalities.length > 0 ? { input: ['text', ...requestedModalities], output: ['text'] } : undefined;

  const providerOptions: Record<string, unknown> = proxyUrl
    ? {
        [provider]: {
          // A custom base URL on the `openai` provider means a self-hosted
          // OpenAI-compatible endpoint (vLLM, llama.cpp, …). The stock openai
          // SDK package speaks the Responses API, whose multi-turn history
          // vLLM rejects (assistant items lack id/status) — pin the Chat
          // Completions transport. Scoped to `openai` only: other providers
          // (e.g. `openrouter`, set alongside ANTHROPIC_BASE_URL per the
          // documented OpenRouter config) ship their own native ai-sdk
          // package and must keep OpenCode's default transport resolution.
          ...(provider === 'openai' && proxyUrl ? { npm: '@ai-sdk/openai-compatible' } : {}),
          options: { apiKey: 'placeholder', baseURL: proxyUrl },
          ...(modelsToRegister.length > 0
            ? {
                models: Object.fromEntries(
                  modelsToRegister.map((mid) => {
                    // limit/modalities describe the MAIN model only — the env
                    // vars name no small-model equivalent. Spreading them onto
                    // a distinct OPENCODE_SMALL_MODEL entry would falsely
                    // declare its context window and media support as the
                    // main model's own. A small model that differs from the
                    // main one gets a bare entry instead, which resolves
                    // through OpenCode's own undeclared-model default.
                    const isMainModel = mid === providerModelId;
                    return [
                      mid,
                      {
                        id: mid,
                        name: mid,
                        tool_call: true,
                        ...(isMainModel && effort ? { options: { reasoningEffort: effort } } : {}),
                        ...(isMainModel && modelLimit ? { limit: modelLimit } : {}),
                        ...(isMainModel && modelModalities ? { attachment: true, modalities: modelModalities } : {}),
                      },
                    ];
                  }),
                ),
              }
            : {}),
        },
      }
    : {};

  const mcp = mcpServersToOpenCodeConfig(options.mcpServers);

  // Name the current trunk-composed project document explicitly. OpenCode
  // otherwise stops at the first AGENTS.md / CLAUDE.md / CONTEXT.md it finds,
  // so a stale provider document could shadow the freshly composed contract.
  //
  // Memory deliberately does NOT ride this array. OpenCode's instruction
  // pipeline calls instruction.system() on every model request and rereads
  // each file raw, so memory files listed here would be re-read (uncapped,
  // unrendered) on every request instead of following the shared
  // startup/clear/compact lifecycle. Memory is delivered by the registered
  // memory session hook instead — see createMemoryLifecycle below.
  const instructions = [`${AGENT_DIR}/CLAUDE.md`, `${AGENT_DIR}/CLAUDE.local.md`];

  return {
    ...(model ? { model } : {}),
    ...(smallModel ? { small_model: smallModel } : {}),
    enabled_providers: [provider],
    // A flat `permission: 'allow'` string leaves every category — including
    // `question`, OpenCode's built-in interactive multi-choice tool — to
    // whatever OpenCode's own default/merge resolves it to. Server logs from
    // a live session showed that resolution land on BOTH `question -> deny *`
    // and `question -> allow *` for the same session: internally
    // contradictory, and whichever rule wins last, `allow` sometimes does —
    // and a headless container has no human to answer an interactive
    // question, so any path that lets it fire wedges the session forever
    // (see OpenCodeProvider's question.asked handling below for the runtime
    // belt-and-suspenders). Enumerate every known permission category
    // explicitly instead of relying on the wildcard string, so `question`
    // resolves to a single deterministic value — `deny` — that can never
    // contradict itself, while every other category keeps the prior
    // "allow everything" behavior.
    // A category OpenCode adds after this list was written is absent from it,
    // and so resolves to OpenCode's own default rather than to `allow`.
    permission: {
      read: 'allow',
      edit: 'allow',
      glob: 'allow',
      grep: 'allow',
      list: 'allow',
      bash: 'allow',
      task: 'allow',
      external_directory: 'allow',
      todowrite: 'allow',
      question: 'deny',
      webfetch: 'allow',
      websearch: 'allow',
      codesearch: 'allow',
      lsp: 'allow',
      doom_loop: 'allow',
      skill: 'allow',
    },
    autoupdate: false,
    snapshot: false,
    provider: providerOptions,
    instructions,
    mcp,
  };
}

type OpenCodeEvent = { type: string; properties: Record<string, unknown> };

/**
 * The client surface a shared runtime is built from: the per-turn session
 * calls `OpenCodeRuntimeHandle` already narrows, plus the event subscription
 * that only the shared (production) path opens. The real `OpencodeClient`
 * satisfies it structurally; tests hand in a fake.
 */
/**
 * The subset of the SDK's SSE options this module drives. `subscribe` spreads
 * them through `get.sse` → `beforeRequest` → `createSseClient` (verified in
 * @opencode-ai/sdk 1.18.25 dist/gen). Without a `signal`, that client swallows
 * a closed socket and reconnects forever with backoff, so a killed server
 * never ends the stream and an in-flight turn never learns it died.
 */
export interface SseSubscribeOptions {
  signal?: AbortSignal;
  sseSleepFn?: (ms: number) => Promise<void>;
}

type SharedRuntimeClient = OpenCodeRuntimeHandle['client'] & {
  event: { subscribe(options?: SseSubscribeOptions): Promise<{ stream: AsyncGenerator<OpenCodeEvent, void, void> }> };
};


/** The SDK's retry backoff, made to return the moment the runtime is released. */
function abortableSleep(signal: AbortSignal): (ms: number) => Promise<void> {
  return (ms) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      }
      signal.addEventListener('abort', done, { once: true });
    });
}

type SharedRuntime = {
  proc: ChildProcess;
  client: SharedRuntimeClient;
  questionClient: QuestionClient;
  stream: AsyncGenerator<OpenCodeEvent, void, void>;
  streamRelease: () => void;
};

/**
 * What `ensureSharedRuntime` needs from the outside world, injectable so the
 * shared-server lifecycle (spawn failure, init failure after spawn, server
 * death, stream death) can be driven in tests without an `opencode serve`
 * process. `OpenCodeRuntimeDeps` on the provider bypasses this whole path;
 * this seam exercises it.
 */
export interface OpenCodeSharedRuntimeDeps {
  spawnServer(config: Record<string, unknown>): Promise<{ url: string; proc: ChildProcess }>;
  createClient(url: string, cwd: string): SharedRuntimeClient;
  createQuestionClient(url: string): QuestionClient;
}

const defaultSharedRuntimeDeps: OpenCodeSharedRuntimeDeps = {
  spawnServer: (config) => spawnOpencodeServer(config),
  // OpenCode scopes sessions and tool execution by the directory carried by
  // the SDK client. The server process cwd is not sufficient: without this
  // option the SDK defaults requests to the server's launch directory.
  // The cast bridges one declared gap: the handle types `promptAsync` parts as
  // `unknown[]` so fakes stay light, while the SDK types them as its part
  // union. Every call site passes `buildPromptParts` output, which is the
  // SDK's own union, so the runtime shapes agree.
  createClient: (url, cwd) => createOpencodeClient({ baseUrl: url, directory: cwd }) as unknown as SharedRuntimeClient,
  createQuestionClient: (url) => createOpencodeQuestionClient({ baseUrl: url }),
};

let sharedRuntimeDeps: OpenCodeSharedRuntimeDeps = defaultSharedRuntimeDeps;

export function setSharedRuntimeDepsForTesting(deps?: OpenCodeSharedRuntimeDeps): void {
  sharedRuntimeDeps = deps ?? defaultSharedRuntimeDeps;
}

let sharedRuntime: SharedRuntime | null = null;
let sharedConfigKey: string | null = null;
let sharedInit: Promise<SharedRuntime> | null = null;

function runtimeConfigKey(options: ProviderOptions, cwd: string): string {
  return JSON.stringify({
    mcp: mcpServersToOpenCodeConfig(options.mcpServers),
    model: options.model ?? process.env.OPENCODE_MODEL,
    small: process.env.OPENCODE_SMALL_MODEL,
    op: process.env.OPENCODE_PROVIDER,
    cwd,
  });
}

/**
 * One `opencode serve` per container, reused across queries. Every failure
 * mode leaves the module in a state the NEXT call can recover from: a failed
 * init is never cached (so a slow listen line or a stolen port costs one turn,
 * not the container's lifetime), a spawned server whose client setup fails is
 * reaped rather than orphaned on its port, and a server that exits out from
 * under us drops itself from the cache so the next turn respawns instead of
 * failing instantly forever.
 */
async function ensureSharedRuntime(options: ProviderOptions, cwd: string): Promise<SharedRuntime> {
  const key = runtimeConfigKey(options, cwd);
  if (sharedRuntime && sharedConfigKey === key) return sharedRuntime;

  if (sharedInit) return sharedInit;

  const deps = sharedRuntimeDeps;
  const init = (async (): Promise<SharedRuntime> => {
    if (sharedRuntime) {
      destroySharedRuntime();
    }
    const config = buildOpenCodeConfig(options);
    const { url, proc } = await deps.spawnServer(config);

    let runtime: SharedRuntime;
    // Owns the SSE subscription. Aborting it is the one thing that reliably
    // wakes a `stream.next()` parked on a dead or wedged server: the SDK
    // cancels its reader, skips the backoff (abortableSleep), sees the aborted
    // signal at its loop top and returns — the generator yields `done` and
    // the in-flight turn throws its stream-ended error.
    const streamAbort = new AbortController();
    try {
      const client = deps.createClient(url, cwd);
      const questionClient = deps.createQuestionClient(url);
      // Deliberately no `sseMaxRetryAttempts`: the SDK counts attempts
      // cumulatively per subscription and never resets after a successful
      // reconnect, so a cap would end a long-lived container's stream for
      // good on the Nth transient /event hiccup. The abort signal (server
      // exit, teardown) and the stream-silence watchdog are the stops.
      const sub = await client.event.subscribe({
        signal: streamAbort.signal,
        sseSleepFn: abortableSleep(streamAbort.signal),
      });
      const stream = sub.stream;
      // Belt-and-suspenders drain before this runtime serves any turn — see
      // drainPendingQuestions doc comment.
      await drainPendingQuestions(questionClient);
      runtime = {
        proc,
        client,
        questionClient,
        stream,
        streamRelease: () => {
          streamAbort.abort();
          void stream.return?.(undefined);
        },
      };
    } catch (err) {
      // The server came up and is holding its port; nothing downstream will
      // ever hold a handle to it, so this is the only place it can be reaped.
      streamAbort.abort();
      killProcessTree(proc);
      throw err;
    }

    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (sharedRuntime?.proc !== proc) return;
      log(`OpenCode server exited (code=${String(code)}, signal=${String(signal)}); next turn will respawn it`);
      try {
        runtime.streamRelease();
      } catch {
        /* ignore */
      }
      sharedRuntime = null;
      sharedConfigKey = null;
    };
    proc.once('exit', onExit);
    if (proc.exitCode !== null || proc.signalCode !== null) {
      // Died between the listen line and the listener — the event is gone.
      try {
        runtime.streamRelease();
      } catch {
        /* ignore */
      }
      throw new Error(`OpenCode server exited during startup (code=${String(proc.exitCode)})`);
    }

    sharedRuntime = runtime;
    sharedConfigKey = key;
    return runtime;
  })();

  sharedInit = init;
  const release = (): void => {
    if (sharedInit === init) sharedInit = null;
  };
  init.then(release, release);
  return init;
}

export function destroySharedRuntime(): void {
  if (sharedRuntime) {
    try {
      sharedRuntime.streamRelease();
    } catch {
      /* ignore */
    }
    killProcessTree(sharedRuntime.proc);
    sharedRuntime = null;
    sharedConfigKey = null;
  }
  sharedInit = null;
}

/**
 * The shared runtime's event stream died under a turn (SSE ended or threw).
 * Only the shared runtime is dropped, and only if `rt` is still it — a
 * test-injected handle or a runtime that was already replaced is untouched.
 */
function discardDeadSharedRuntime(rt: unknown): void {
  if (sharedRuntime && rt === sharedRuntime) {
    log('OpenCode event stream died; dropping shared runtime so the next turn respawns it');
    destroySharedRuntime();
  }
}

function sessionErrorMessage(props: { error?: unknown }): string {
  const err = props.error as { data?: { message?: string } } | undefined;
  if (err && typeof err === 'object' && err.data && typeof err.data.message === 'string') {
    return err.data.message;
  }
  return JSON.stringify(props.error) || 'OpenCode session error';
}

// Steers the model rather than just silently declining: nothing in this
// container can answer an interactive question, so tell it to decide on its
// own or fall back to nanoclaw's own blocking MCP tool (mcp-tools/interactive.ts,
// registered as `ask_user_question`), which actually reaches the human through
// the chat channel instead of OpenCode's headless-dead-end question tool.
export const QUESTION_STEERING_TEXT =
  'Interactive questions are not available in this environment. Decide autonomously based on your best judgment, or use the ask_user_question MCP tool to ask the human through the chat channel.';

/**
 * Delivery-discipline reminder injected on the first prompt AFTER OpenCode
 * auto-compacts the active session. Compaction rewrites the transcript into a
 * summary, and the delivery contract the poll-loop enforces — `envelope`:
 * every reply that should reach a human is wrapped in <message to="name">…
 * </message> blocks; `tools-only`: only outbound tool calls deliver and such
 * blocks are inert scratchpad — is exactly the kind of standing instruction a
 * summary can quietly drop. Once it is gone, replies stop reaching anyone (or
 * cost a nudge round trip per compaction). Re-state it, with the live
 * destination list, so the next turn delivers correctly.
 *
 * The wording is shared with the Claude PreCompact path
 * (`buildDeliveryReminder` in compact-instructions.ts) so the two cannot
 * drift; the mode comes from `ProviderOptions.deliveryMode`, i.e. the same
 * container config the poll-loop reads.
 *
 * OpenCode 1.18.25 exposes no compaction-prompt/customInstructions config API,
 * so unlike the Claude provider's PreCompact hook we cannot steer the summary
 * itself. We re-inject on the next prompt instead. Destinations are read fresh
 * at injection time.
 */
export function buildPostCompactionReminder(
  names: string[] = getAllDestinations().map((d) => d.name),
  deliveryMode: DeliveryMode = 'envelope',
  // An isolated task session (`system:tasks:<id>` thread) is one-door
  // regardless of mode: only send_message delivers and the final text becomes
  // the run log. The caller reads it from session_routing at injection time
  // (see the query() call site); the default keeps explicit-argument callers
  // free of DB reads.
  taskId: string | null = null,
): string {
  const contract = buildDeliveryReminder(names, taskId, deliveryMode).join(' ');
  return (
    '<system>The conversation was just compacted into a summary. Delivery instructions can be lost in ' +
    `that summary, so as a reminder: ${contract}</system>`
  );
}

/**
 * Per-query compaction-reminder latch. `note` arms it when a
 * `session.compacted` event names the turn's active session — the OpenCode
 * server is shared across sessions, so an unrelated session's compaction must
 * never arm this query's reminder. `apply` prepends the reminder to the next
 * prompt exactly once, then disarms. `buildReminder` is injectable so tests can
 * drive the latch without touching the destinations DB.
 */
export function createCompactionReminder(buildReminder: () => string = buildPostCompactionReminder): {
  note(eventSessionId: string | undefined, activeSessionId: string | undefined): void;
  apply(message: string): string;
  readonly isArmed: boolean;
} {
  let armed = false;
  return {
    note(eventSessionId, activeSessionId) {
      if (activeSessionId !== undefined && eventSessionId === activeSessionId) armed = true;
    },
    apply(message) {
      if (!armed) return message;
      armed = false;
      return `${buildReminder()}\n\n${message}`;
    },
    get isArmed() {
      return armed;
    },
  };
}

/**
 * Structural mirror of the runner's `MemorySessionHookRegistration`
 * (`container/agent-runner/src/memory/session-hook.ts`). Declared locally for
 * the same way optional provider payloads keep their runtime boundary narrow.
 * The command is referenced by string and executed as a subprocess—never
 * imported—so rendering and per-file caps stay inside the shared hook.
 */
export interface OpenCodeMemorySessionHook {
  readonly command: string;
  readonly legacyCommands: readonly string[];
  readonly sources: readonly string[];
}

/**
 * The two lifecycle points at which this provider establishes a new context
 * window. `clear` never appears: OpenCode has no in-session clear — a cleared
 * conversation arrives as a fresh session, i.e. `startup`. `resume` never
 * appears either, by contract: memory is not re-injected when an existing
 * session continues.
 */
export type OpenCodeMemorySource = 'startup' | 'compact';

/** Matches the `timeout: 10` (seconds) the Claude provider registers for the same command. */
const MEMORY_HOOK_TIMEOUT_MS = 10_000;

/**
 * Run the registered memory session hook and return what it printed.
 *
 * The hook reads a Claude-style SessionStart payload on stdin and prints the
 * rendered memory section on stdout (`src/memory/hook.ts`), which is where the
 * per-file caps and the "resume gets nothing" rule live. Nothing is capped or
 * rewritten here — whatever the command prints is what gets injected.
 *
 * Fails closed on every failure mode (unregistered, source the registration
 * does not declare, missing command, non-zero exit, timeout, empty stdout):
 * one log line, no injection, never a thrown turn.
 */
export function runMemorySessionHook(
  hook: OpenCodeMemorySessionHook | undefined,
  source: OpenCodeMemorySource,
): string | undefined {
  if (!hook) {
    log(`No memory session hook registered; skipping ${source} memory injection`);
    return undefined;
  }
  if (!hook.sources.includes(source)) {
    log(`Memory session hook does not declare source ${source}; skipping injection`);
    return undefined;
  }

  try {
    const res = spawnSync(hook.command, {
      shell: true,
      input: JSON.stringify({ hook_event_name: 'SessionStart', source }),
      encoding: 'utf-8',
      timeout: MEMORY_HOOK_TIMEOUT_MS,
    });
    if (res.error || res.status !== 0) {
      const why = res.error ? res.error.message : `exit ${String(res.status)}`;
      log(`Memory session hook (${source}) failed (${why}); continuing without memory`);
      return undefined;
    }
    const out = (res.stdout ?? '').trim();
    if (!out) {
      log(`Memory session hook (${source}) produced no output; continuing without memory`);
      return undefined;
    }
    return out;
  } catch (err) {
    log(`Memory session hook (${source}) failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * Per-query memory lifecycle. One instance per `query()`, mirroring
 * createCompactionReminder, so nothing leaks between queries.
 *
 * `openingInstructions` covers the new-context case: an opening query with no
 * continuation is a brand-new OpenCode session (a fresh container and a cleared
 * conversation both land here), so memory joins the system instructions that
 * prompt already carries — exactly one memory block per context window, since
 * follow-up pushes re-send the plain instructions. A query that resumes a
 * continuation passes the instructions through untouched and never runs the
 * command at all.
 *
 * `pushPrefix` covers the other place a context window is rebuilt: OpenCode
 * auto-compaction. The caller passes the compaction latch's armed state, so
 * memory rides the same exactly-once next-prompt slot as the routing reminder.
 */
export function createMemoryLifecycle(
  hook: OpenCodeMemorySessionHook | undefined,
  isResume: boolean,
): {
  openingInstructions(systemInstructions?: string): string | undefined;
  pushPrefix(justCompacted: boolean): string;
} {
  return {
    openingInstructions(systemInstructions) {
      if (isResume) return systemInstructions;
      const memory = runMemorySessionHook(hook, 'startup');
      if (!memory) return systemInstructions;
      return systemInstructions ? `${memory}\n\n${systemInstructions}` : memory;
    },
    pushPrefix(justCompacted) {
      if (!justCompacted) return '';
      const memory = runMemorySessionHook(hook, 'compact');
      return memory ? `${memory}\n\n` : '';
    },
  };
}

/**
 * Minimal shape of the `/v2` SDK surface this module needs for question
 * handling — narrowed so tests can pass a fake without pulling in the real
 * `@opencode-ai/sdk/v2` client.
 */
export interface QuestionClient {
  question: {
    reply(params: { requestID: string; answers: string[][] }): Promise<{ data?: unknown; error?: unknown }>;
    list(): Promise<{ data?: Array<{ id: string; sessionID?: string; questions?: unknown[] }>; error?: unknown }>;
  };
}

/**
 * Narrow runtime surface so tests can drive `query()` without spawning
 * `opencode serve`. Production uses `ensureSharedRuntime`.
 */
export interface OpenCodeRuntimeHandle {
  client: {
    session: {
      create(): Promise<{ data?: { id?: string }; error?: unknown }>;
      promptAsync(params: { path: { id: string }; body: { parts: unknown[] } }): Promise<{ error?: unknown }>;
      /** `POST /session/{id}/abort` — stops one session, leaves the server up. */
      abort?(params: { path: { id: string } }): Promise<{ error?: unknown }>;
    };
    postSessionIdPermissionsPermissionId?(params: {
      path: { id: string; permissionID: string };
      body: { response: string };
    }): Promise<unknown>;
  };
  stream: AsyncGenerator<{ type: string; properties: Record<string, unknown> }, void, void>;
  questionClient: QuestionClient;
  /** Ends the event stream, waking any parked `stream.next()`. */
  streamRelease?(): void;
}

export interface OpenCodeRuntimeDeps {
  getRuntime(options: ProviderOptions, cwd: string): Promise<OpenCodeRuntimeHandle>;
}

/**
 * Answer a single pending question request with the steering text, one
 * custom answer per sub-question (OpenCode's `question` tool defaults
 * `custom: true`, i.e. an answer string that isn't one of the offered
 * option labels is accepted as free text). Never throws — a failed
 * auto-answer should not take down the session any more than the question
 * already threatened to.
 */
export async function autoAnswerQuestion(
  questionClient: QuestionClient,
  req: { id?: string; questions?: unknown[] },
): Promise<void> {
  if (!req.id) return;
  const count = Array.isArray(req.questions) && req.questions.length > 0 ? req.questions.length : 1;
  try {
    const res = await questionClient.question.reply({
      requestID: req.id,
      answers: Array.from({ length: count }, () => [QUESTION_STEERING_TEXT]),
    });
    if (res.error) {
      log(`Failed to auto-answer question ${req.id}: ${JSON.stringify(res.error)}`);
    }
  } catch (err) {
    log(`Failed to auto-answer question ${req.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Matches the startup-blocking budget `spawnOpencodeServer` already uses for
 * its own default `timeoutMs`. This is a startup-path call like that one, so
 * it gets the same allowance. Shared with `handleQuestionAsked` below — the
 * same fail-open budget applies whether a hung reply is discovered at
 * runtime startup or mid-turn.
 */
const DRAIN_PENDING_QUESTIONS_TIMEOUT_MS = 10_000;

/**
 * Handle a `question.asked` SSE event: always answer it, regardless of which
 * session raised it. The `question: 'deny'` config above should stop this
 * tool from ever firing, but this is the real fix for the wedge: the
 * OpenCode server is shared across every session on this runtime, and a
 * pending question wedges the whole server, not just the session that asked
 * — so a config regression or an OpenCode-side path that raises the event
 * before consulting permission must never be able to leave a question
 * unanswered, no matter whose sessionID it carries. Same rule as
 * `drainPendingQuestions`, so behavior does not depend on which path sees a
 * question first.
 *
 * Bounded the same way `drainPendingQuestions` bounds its own await: this is
 * called inline from the turn's event loop (the `question.asked` case
 * below), so a `reply()` that never resolves would stall the turn, not just
 * startup. `timeoutMs` is injectable so tests don't wait out the real
 * default; on timeout this logs one line and returns, fail-open, same as the
 * drain path.
 */
export async function handleQuestionAsked(
  questionClient: QuestionClient,
  req: { id?: string; sessionID?: string; questions?: unknown[] },
  timeoutMs = DRAIN_PENDING_QUESTIONS_TIMEOUT_MS,
): Promise<void> {
  log(`Auto-answering question ${req.id ?? '(no id)'} (sessionID=${req.sessionID ?? 'unknown'})`);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<true>((resolve) => {
    timer = setTimeout(() => resolve(true), timeoutMs);
  });

  try {
    if (await Promise.race([autoAnswerQuestion(questionClient, req).then(() => false as const), timedOut])) {
      log(`Timed out after ${timeoutMs}ms auto-answering question ${req.id ?? '(no id)'}; continuing`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Defensive belt: drain any question requests already pending when a shared
 * runtime comes up (e.g. one that raced the event subscription, or survived
 * from a prior server instance) so none of them can sit there wedging future
 * turns before the event-driven handler ever sees them.
 *
 * Bounded the same way `spawnOpencodeServer` bounds its own await: a plain
 * `Promise.race` against a timer, since (unlike that function's child-process
 * spawn) there is no cancellable handle on the in-flight SDK calls to abort.
 * A hung list()/reply() round-trip must not block runtime startup forever —
 * on timeout this logs one line and returns, fail-open, because the
 * event-driven `question.asked` handler still answers the question later if
 * the round-trip eventually completes.
 */
export async function drainPendingQuestions(
  questionClient: QuestionClient,
  timeoutMs = DRAIN_PENDING_QUESTIONS_TIMEOUT_MS,
): Promise<void> {
  const drain = (async () => {
    try {
      const res = await questionClient.question.list();
      if (res.error) {
        log(`Failed to list pending questions: ${JSON.stringify(res.error)}`);
        return;
      }
      for (const req of res.data ?? []) {
        await autoAnswerQuestion(questionClient, req);
      }
    } catch (err) {
      log(`Failed to list pending questions: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<true>((resolve) => {
    timer = setTimeout(() => resolve(true), timeoutMs);
  });

  try {
    if (await Promise.race([drain.then(() => false as const), timedOut])) {
      log(`Timed out after ${timeoutMs}ms draining pending questions; continuing startup`);
    }
  } finally {
    // A fast drain resolves before the timer fires, but the timer stays live
    // until it does — clear it here so it can't hold this call alive or fire
    // spuriously into a `timedOut` promise no one is racing against anymore.
    clearTimeout(timer);
  }
}

export class OpenCodeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly options: ProviderOptions;
  private readonly runtime?: OpenCodeRuntimeDeps;
  private activeSessionId: string | undefined;
  private memorySessionHook?: OpenCodeMemorySessionHook;

  constructor(options: ProviderOptions = {}, runtime?: OpenCodeRuntimeDeps) {
    this.options = options;
    this.runtime = runtime;
  }

  // OpenCode has no native session-start hook mechanism to hand the command to
  // (as the Claude Agent SDK's settings.json and Codex's hooks.json have), so
  // the provider stores the registration and runs the command itself at the
  // lifecycle points OpenCode does expose — see createMemoryLifecycle.
  registerMemorySessionHook(hook: OpenCodeMemorySessionHook): void {
    this.memorySessionHook = hook;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    // Same refusal as the Codex provider: the runner registers the shared hook
    // unconditionally before polling, so an unregistered provider means the
    // wiring broke — fail loudly rather than run a memoryless agent forever.
    if (!this.memorySessionHook) throw new Error('OpenCode memory session hook was not registered');

    if (input.continuation) {
      this.activeSessionId = input.continuation;
    } else {
      this.activeSessionId = undefined;
    }

    const pending: Array<{
      text: string;
      attachments?: OpenCodePromptAttachment[];
      // The unwrapped prompt, set only on an opening turn that resumed a
      // persisted continuation. Its presence is what licenses the empty-resume
      // fallback; its value is what the replay re-composes from, so the
      // replacement session gets the same prompt shape a first-time session
      // would have got instead of a second <system> block stacked on the first.
      replayPrompt?: string;
    }> = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;
    // Latch that re-injects the delivery reminder on the next prompt after the
    // active session auto-compacts (see createCompactionReminder). Per-query so
    // it never leaks a pending reminder across independent query() calls. The
    // reminder teaches the delivery contract this session actually runs under:
    // the group's mode, or the one-door task contract when this is a task
    // session — both read the same way the Claude PreCompact hook reads them.
    const compaction = createCompactionReminder(() =>
      buildPostCompactionReminder(undefined, this.options.deliveryMode, getTaskSeriesId()),
    );
    // Memory rides the same two moments a context window is (re)built: this
    // opening prompt when it starts a new session, and the first prompt after
    // a compaction. Never on a resume, never on an ordinary push.
    const memory = createMemoryLifecycle(this.memorySessionHook, Boolean(input.continuation));

    const systemInstructions = input.systemContext?.instructions;
    // Read structurally rather than off `QueryInput` directly: an agent-runner
    // that does not carry the attachment field still type-checks here, and
    // yields `undefined` — the same no-op as a turn that arrived without media.
    const openingAttachments = (input as QueryInput & { attachments?: OpenCodePromptAttachment[] }).attachments;
    pending.push({
      text: wrapPromptWithContext(input.prompt, memory.openingInstructions(systemInstructions)),
      attachments: openingAttachments,
      replayPrompt: input.continuation ? input.prompt : undefined,
    });

    const kick = (): void => {
      waiting?.();
    };

    const self = this;
    // Two watchdog tiers, both read at query() time:
    //  - stream silence: no event of ANY kind (the server's 10 s
    //    `server.heartbeat` included) for this long means the server is
    //    wedged or its SSE connection is dead. The shared server is torn down
    //    so the next turn respawns it.
    //  - activity: no agent activity event for this long while the stream is
    //    alive means the backend is wedged. Only that session is aborted; the
    //    server stays. Generous by default so long tool runs survive.
    // Bare positive integers only, like the attachment limits: a negative or
    // fractional value would otherwise become a ~1 ms interval and trip the
    // silence tier on every turn.
    const STREAM_SILENCE_MS = positiveIntegerEnv('OPENCODE_STREAM_SILENCE_MS', DEFAULT_STREAM_SILENCE_MS);
    const IDLE_TIMEOUT_MS = positiveIntegerEnv('OPENCODE_IDLE_TIMEOUT_MS', DEFAULT_IDLE_TIMEOUT_MS);
    let emptyResumeFellBack = false;
    // The runtime the generator obtained, so abort() can reach the
    // session-level abort. Unset until gen() runs — an abort before then has
    // no prompt in flight to stop.
    let runtimeHandle: Pick<OpenCodeRuntimeHandle, 'client'> | undefined;
    // The session the generator currently has a prompt in flight on. Owned by
    // the generator, not the instance-wide activeSessionId, so abort() targets
    // exactly the turn it is interrupting.
    let turnSessionInFlight: string | undefined;

    // `POST /session/{id}/abort` — stop one session, keep the shared server.
    // Fire-and-forget: the server answers with that session's own
    // session.error / session.idle, which wakes a parked stream.next().
    const abortSession = (id: string): void => {
      const session = runtimeHandle?.client.session;
      if (!session?.abort) return;
      void session.abort({ path: { id } }).then(
        (res) => {
          if (res?.error) log(`Failed to abort session ${id}: ${JSON.stringify(res.error)}`);
        },
        (err: unknown) => {
          log(`Failed to abort session ${id}: ${err instanceof Error ? err.message : String(err)}`);
        },
      );
    };

    async function* gen(): AsyncGenerator<ProviderEvent> {
      let initYielded = false;
      const rt = self.runtime
        ? await self.runtime.getRuntime(self.options, input.cwd)
        : await ensureSharedRuntime(self.options, input.cwd);
      runtimeHandle = rt;
      const { client, stream, questionClient } = rt;

      while (!aborted) {
        while (pending.length === 0 && !ended && !aborted) {
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
          waiting = null;
        }

        if (aborted) return;
        if (pending.length === 0 && ended) return;

        const { text, attachments, replayPrompt } = pending.shift()!;
        let sessionId = self.activeSessionId;

        if (!sessionId) {
          const created = await client.session.create();
          if (aborted) {
            // abort() landed while create() was parked; it had no id to
            // target, so the session it produced is ours to stop.
            if (created.data?.id) abortSession(created.data.id);
            return;
          }
          if (created.error) {
            throw new Error(`OpenCode: failed to create session: ${JSON.stringify(created.error)}`);
          }
          sessionId = created.data?.id;
          if (!sessionId) throw new Error('OpenCode: failed to create session (no id)');
          self.activeSessionId = sessionId;
        }

        if (!initYielded) {
          yield { type: 'init', continuation: sessionId };
          initYielded = true;
        }

        async function* runTurn(
          turnSessionId: string,
          turnText: string,
          turnAttachments: typeof attachments,
        ): AsyncGenerator<ProviderEvent, { resultText: string; sawAssistantWork: boolean }> {
          const empty = { resultText: '', sawAssistantWork: false };
          if (aborted) return empty;
          turnSessionInFlight = turnSessionId;
          const promptRes = await client.session.promptAsync({
            path: { id: turnSessionId },
            body: { parts: buildPromptParts(turnText, turnAttachments) },
          });
          if (aborted) {
            // abort() landed while the prompt was still registering; an abort
            // it sent may have preceded the prompt server-side, so stop the
            // session again now that the turn exists.
            abortSession(turnSessionId);
            return empty;
          }
          if (promptRes.error) {
            self.activeSessionId = undefined;
            throw new Error(`OpenCode promptAsync: ${JSON.stringify(promptRes.error)}`);
          }

          const partTextByMessageId = new Map<string, string>();
          const roleByMessageId = new Map<string, string>();
          const partMessageIds = new Set<string>();
          const erroredMessageIds = new Set<string>();
          // Set only by signals that have no message record of their own
          // (permissions, questions, compaction). Message-derived work is
          // decided once, after the turn, in the loop below.
          let sawAssistantWork = false;
          let lastEventAt = Date.now();
          let lastActivityAt = Date.now();
          let streamSilent = false;
          let activityTimedOut = false;
          const silenceError = (): Error =>
            new Error(`OpenCode event stream silent for ${STREAM_SILENCE_MS}ms; server dropped`);
          const activityError = (): Error =>
            new Error(`OpenCode turn produced no activity for ${IDLE_TIMEOUT_MS}ms; aborted`);
          const timeoutCheck = setInterval(
            () => {
              const now = Date.now();
              if (!streamSilent && now - lastEventAt > STREAM_SILENCE_MS) {
                // Not even heartbeats: the server is gone or wedged. Genuine
                // runtime death — the one case that tears the shared server
                // down. Releasing the stream aborts the SSE subscription,
                // which is what actually wakes the parked stream.next(); a
                // SIGKILL alone does not (the SDK would reconnect forever).
                // This tier has done its job: stop ticking.
                clearInterval(timeoutCheck);
                log(`OpenCode event stream silent for ${STREAM_SILENCE_MS}ms — dropping runtime, session ${turnSessionId}`);
                streamSilent = true;
                self.activeSessionId = undefined;
                discardDeadSharedRuntime(rt);
                try {
                  rt.streamRelease?.();
                } catch {
                  /* ignore */
                }
                kick();
              } else if (!activityTimedOut && now - lastActivityAt > IDLE_TIMEOUT_MS) {
                // Stream alive, backend wedged: stop this session only. The
                // server's reply for the aborted session wakes stream.next().
                log(`OpenCode turn produced no activity for ${IDLE_TIMEOUT_MS}ms — aborting session ${turnSessionId}`);
                activityTimedOut = true;
                abortSession(turnSessionId);
                kick();
              }
            },
            Math.min(5000, STREAM_SILENCE_MS, IDLE_TIMEOUT_MS),
          );

          try {
            turn: while (true) {
              if (aborted) return { resultText: '', sawAssistantWork };
              if (streamSilent) throw silenceError();
              if (activityTimedOut) throw activityError();

              let next: IteratorResult<OpenCodeEvent, void>;
              try {
                next = await stream.next();
              } catch (err) {
                if (streamSilent) throw silenceError();
                discardDeadSharedRuntime(rt);
                throw new Error(`OpenCode SSE stream failed: ${err instanceof Error ? err.message : String(err)}`);
              }
              if (next.done) {
                if (streamSilent) throw silenceError();
                discardDeadSharedRuntime(rt);
                throw new Error('OpenCode SSE stream ended unexpectedly');
              }
              // An abort or watchdog lands while this await is parked;
              // whatever woke it (the aborted session's own error/idle, or a
              // heartbeat) is not this turn's to process.
              if (aborted) return { resultText: '', sawAssistantWork };
              if (streamSilent) throw silenceError();
              if (activityTimedOut) throw activityError();
              const ev = next.value;

              if (!ev?.type || ev.type === 'server.connected') continue;
              if (ev.type === 'server.heartbeat') {
                // Liveness only: not agent activity, so neither the activity
                // tier nor the runner's own heartbeat is fed by it.
                lastEventAt = Date.now();
                continue;
              }

              lastEventAt = Date.now();
              lastActivityAt = lastEventAt;
              yield { type: 'activity' };

              switch (ev.type) {
                case 'message.updated': {
                  const info = ev.properties.info as
                    | { id?: string; role?: string; sessionID?: string; error?: unknown }
                    | undefined;
                  if (info?.sessionID && info.sessionID !== turnSessionId) break;
                  if (info?.id && info?.role) {
                    roleByMessageId.set(info.id, info.role);
                    // `message.updated` fires repeatedly for the same record, so
                    // latch the error rather than reading the last event only.
                    if (info.error) erroredMessageIds.add(info.id);
                  }
                  break;
                }
                case 'message.part.updated': {
                  const part = ev.properties.part as
                    | { type?: string; messageID?: string; sessionID?: string; text?: string }
                    | undefined;
                  if (part?.sessionID && part.sessionID !== turnSessionId) break;
                  if (part?.messageID) {
                    partMessageIds.add(part.messageID);
                    if (part.type === 'text' && part.text) {
                      partTextByMessageId.set(part.messageID, part.text);
                    }
                  }
                  break;
                }
                case 'permission.updated': {
                  const perm = ev.properties as { id?: string; sessionID?: string };
                  if (perm.sessionID === turnSessionId && perm.id) {
                    sawAssistantWork = true;
                    try {
                      await client.postSessionIdPermissionsPermissionId?.({
                        path: { id: turnSessionId, permissionID: perm.id },
                        body: { response: 'always' },
                      });
                    } catch (err) {
                      log(`Failed to auto-reply permission: ${err instanceof Error ? err.message : String(err)}`);
                    }
                  }
                  break;
                }
                case 'question.asked': {
                  const req = ev.properties as { id?: string; sessionID?: string; questions?: unknown[] };
                  if (req.sessionID === turnSessionId) sawAssistantWork = true;
                  await handleQuestionAsked(questionClient, req);
                  break;
                }
                case 'session.status': {
                  const props = ev.properties as {
                    sessionID?: string;
                    status?: { type?: string; attempt?: number; message?: string };
                  };
                  if (props.sessionID !== turnSessionId) break;
                  const st = props.status;
                  if (
                    st?.type === 'retry' &&
                    typeof st.attempt === 'number' &&
                    st.attempt >= SESSION_STATUS_RETRY_ERROR_AFTER &&
                    st.message
                  ) {
                    self.activeSessionId = undefined;
                    throw new Error(`OpenCode retry limit (${st.attempt}): ${st.message}`);
                  }
                  break;
                }
                case 'session.error': {
                  const props = ev.properties as { sessionID?: string; error?: unknown };
                  if (props.sessionID === turnSessionId || props.sessionID === undefined) {
                    self.activeSessionId = undefined;
                    throw new Error(sessionErrorMessage(props));
                  }
                  break;
                }
                case 'session.compacted': {
                  // The active session was just auto-compacted; arm the routing
                  // reminder for the next prompt. Filter by sessionID like the
                  // other cases — the shared server emits this for every session.
                  const sid = (ev.properties as { sessionID?: string }).sessionID;
                  compaction.note(sid, turnSessionId);
                  if (sid === turnSessionId) sawAssistantWork = true;
                  break;
                }
                case 'session.idle': {
                  const sid = (ev.properties as { sessionID?: string }).sessionID;
                  if (sid === turnSessionId) {
                    break turn;
                  }
                  break;
                }
                default:
                  break;
              }
            }
          } finally {
            clearInterval(timeoutCheck);
            turnSessionInFlight = undefined;
          }

          let resultText = '';
          for (const [msgId, role] of roleByMessageId) {
            if (role !== 'assistant') continue;
            // The bare envelope is the quiet-idle signature. OpenCode opens the
            // assistant record when the turn starts (`AssistantMessage.time` has
            // a required `created` and an optional `completed`), so the record
            // existing proves nothing on its own. Work means it produced at
            // least one part — or that it carries a provider error, which marks
            // a live session whose turn failed: replaying that on a fresh
            // session would discard the history and bury the error.
            if (partMessageIds.has(msgId) || erroredMessageIds.has(msgId)) {
              sawAssistantWork = true;
            }
            resultText = partTextByMessageId.get(msgId) ?? resultText;
          }
          return { resultText, sawAssistantWork };
        }

        let outcome = yield* runTurn(sessionId, text, attachments);
        if (aborted) return;

        if (
          isEmptyOpenCodeResume({
            resumedExistingSession: replayPrompt !== undefined,
            alreadyFellBack: emptyResumeFellBack,
            sawAssistantWork: outcome.sawAssistantWork,
          })
        ) {
          log(`Empty resume on ${sessionId}; starting fresh session.`);
          emptyResumeFellBack = true;
          self.activeSessionId = undefined;
          const created = await client.session.create();
          if (aborted) {
            if (created.data?.id) abortSession(created.data.id);
            return;
          }
          if (created.error) {
            throw new Error(`OpenCode: failed to create session: ${JSON.stringify(created.error)}`);
          }
          const freshId = created.data?.id;
          if (!freshId) throw new Error('OpenCode: failed to create session (no id)');
          sessionId = freshId;
          self.activeSessionId = freshId;
          yield { type: 'init', continuation: freshId };
          initYielded = true;
          // Compose the replay the way a first-time query composes an opening
          // prompt — one <system> block carrying memory and the instructions —
          // rather than wrapping the already-wrapped resume text a second time.
          // `replayPrompt` is defined here: it is what licensed this branch.
          const freshMemory = createMemoryLifecycle(self.memorySessionHook, false);
          const retryText = wrapPromptWithContext(replayPrompt!, freshMemory.openingInstructions(systemInstructions));
          outcome = yield* runTurn(freshId, retryText, attachments);
          if (aborted) return;
        }

        yield { type: 'result', text: outcome.resultText || null };
      }
    }

    return {
      push: (message: string, attachments?: OpenCodePromptAttachment[]) => {
        // If the active session compacted mid-conversation, memory and the
        // routing reminder both ride this next prompt (once each), then the
        // latch disarms. Read the latch BEFORE apply() consumes it. Order is
        // memory, then reminder, then the user's text.
        const justCompacted = compaction.isArmed;
        pending.push({
          text: wrapPromptWithContext(memory.pushPrefix(justCompacted) + compaction.apply(message), systemInstructions),
          attachments,
        });
        kick();
      },
      end: () => {
        ended = true;
        kick();
      },
      events: gen(),
      abort: () => {
        aborted = true;
        this.activeSessionId = undefined;
        kick();
        // Stop the session, not the server. `opencode serve` is shared by
        // every query in this container, so a /clear or /compact must not cost
        // a SIGKILL plus a respawn and its listen wait. Targets the turn the
        // generator actually has in flight; a turn still parked in create()
        // or promptAsync() re-checks `aborted` when it resumes and stops the
        // session it just obtained.
        if (turnSessionInFlight) abortSession(turnSessionInFlight);
      },
    };
  }
}

registerProvider('opencode', (opts) => new OpenCodeProvider(opts));
