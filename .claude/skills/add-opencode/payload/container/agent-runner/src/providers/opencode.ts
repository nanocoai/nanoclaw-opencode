import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { lstatSync, realpathSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

import { createOpencodeClient, type FilePartInput, type OpencodeClient } from '@opencode-ai/sdk';
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

const AGENT_DIR = '/workspace/agent';
const DEFAULT_NATIVE_ATTACHMENT_MAX_COUNT = 8;
const DEFAULT_NATIVE_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/** Stale / dead OpenCode session heuristics (complement Claude-centric host patterns). */
const STALE_SESSION_RE =
  /no conversation found|ENOENT.*\.jsonl|session.*not found|NotFoundError|connection reset|ECONNRESET|404|event timeout/i;

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
  if (!proc.pid) return;
  try {
    process.kill(-proc.pid, 'SIGKILL');
  } catch {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
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

type SharedRuntime = {
  proc: ChildProcess;
  client: OpencodeClient;
  questionClient: QuestionClient;
  stream: AsyncGenerator<{ type: string; properties: Record<string, unknown> }, void, void>;
  streamRelease: () => void;
};

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

async function ensureSharedRuntime(options: ProviderOptions, cwd: string): Promise<SharedRuntime> {
  const key = runtimeConfigKey(options, cwd);
  if (sharedRuntime && sharedConfigKey === key) return sharedRuntime;

  if (sharedInit) return sharedInit;

  sharedInit = (async () => {
    if (sharedRuntime) {
      destroySharedRuntime();
    }
    const config = buildOpenCodeConfig(options);
    const { url, proc } = await spawnOpencodeServer(config);
    // OpenCode scopes sessions and tool execution by the directory carried by
    // the SDK client. The server process cwd is not sufficient: without this
    // option the SDK defaults requests to the server's launch directory.
    const client = createOpencodeClient({ baseUrl: url, directory: cwd });
    const questionClient = createOpencodeQuestionClient({ baseUrl: url });
    const sub = await client.event.subscribe();
    const stream = sub.stream as AsyncGenerator<{ type: string; properties: Record<string, unknown> }, void, void>;
    // Belt-and-suspenders drain before this runtime serves any turn — see
    // drainPendingQuestions doc comment.
    await drainPendingQuestions(questionClient);
    sharedRuntime = {
      proc,
      client,
      questionClient,
      stream,
      streamRelease: () => {
        void stream.return?.(undefined);
      },
    };
    sharedConfigKey = key;
    sharedInit = null;
    return sharedRuntime;
  })();

  return sharedInit;
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
 * Routing-discipline reminder injected on the first prompt AFTER OpenCode
 * auto-compacts the active session. Compaction rewrites the transcript into a
 * summary, and the delivery contract — every reply that should reach a human
 * must be wrapped in <message to="name">…</message> blocks, which the poll-loop
 * enforces when it dispatches the agent's final text — is exactly the kind of
 * standing instruction a summary can quietly drop. Once it is gone, replies
 * stop reaching anyone. Re-state it, with the live destination list, so the
 * next turn routes correctly.
 *
 * OpenCode 1.18.25 exposes no compaction-prompt/customInstructions config API,
 * so unlike the Claude provider's PreCompact hook we cannot steer the summary
 * itself. We re-inject on the next prompt instead. Destinations are read fresh
 * at injection time.
 */
export function buildPostCompactionReminder(names: string[] = getAllDestinations().map((d) => d.name)): string {
  const list = names.length > 0 ? names.map((n) => `\`${n}\``).join(', ') : '(none)';
  return (
    '<system>The conversation was just compacted into a summary. Routing instructions can be lost in ' +
    'that summary, so as a reminder: wrap every reply you want delivered in ' +
    '<message to="name">…</message> blocks — text outside such blocks is treated as scratchpad and is ' +
    `NOT sent. Available destinations: ${list}.</system>`
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
    };
    postSessionIdPermissionsPermissionId?(params: {
      path: { id: string; permissionID: string };
      body: { response: string };
    }): Promise<unknown>;
  };
  stream: AsyncGenerator<{ type: string; properties: Record<string, unknown> }, void, void>;
  questionClient: QuestionClient;
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
      allowEmptyResumeFallback: boolean;
    }> = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;
    // Latch that re-injects the routing reminder on the next prompt after the
    // active session auto-compacts (see createCompactionReminder). Per-query so
    // it never leaks a pending reminder across independent query() calls.
    const compaction = createCompactionReminder();
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
      allowEmptyResumeFallback: Boolean(input.continuation),
    });

    const kick = (): void => {
      waiting?.();
    };

    const self = this;
    const IDLE_TIMEOUT_MS = Number(process.env.OPENCODE_IDLE_TIMEOUT_MS) || 300_000;
    let emptyResumeFellBack = false;

    async function* gen(): AsyncGenerator<ProviderEvent> {
      let initYielded = false;
      const rt = self.runtime
        ? await self.runtime.getRuntime(self.options, input.cwd)
        : await ensureSharedRuntime(self.options, input.cwd);
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

        const { text, attachments, allowEmptyResumeFallback } = pending.shift()!;
        let sessionId = self.activeSessionId;

        if (!sessionId) {
          const created = await client.session.create();
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
          const promptRes = await client.session.promptAsync({
            path: { id: turnSessionId },
            body: { parts: buildPromptParts(turnText, turnAttachments) },
          });
          if (promptRes.error) {
            self.activeSessionId = undefined;
            throw new Error(`OpenCode promptAsync: ${JSON.stringify(promptRes.error)}`);
          }

          const partTextByMessageId = new Map<string, string>();
          const roleByMessageId = new Map<string, string>();
          const partMessageIds = new Set<string>();
          let sawAssistantWork = false;
          let lastEventAt = Date.now();
          let eventTimedOut = false;
          const timeoutCheck = setInterval(() => {
            if (Date.now() - lastEventAt > IDLE_TIMEOUT_MS) {
              log(`OpenCode event timeout (${IDLE_TIMEOUT_MS}ms) — clearing session ${turnSessionId}`);
              eventTimedOut = true;
              self.activeSessionId = undefined;
              destroySharedRuntime();
              kick();
            }
          }, 5000);

          try {
            turn: while (true) {
              if (aborted) return { resultText: '', sawAssistantWork };
              if (eventTimedOut) {
                throw new Error(`OpenCode event timeout (${IDLE_TIMEOUT_MS}ms)`);
              }

              const { value: ev, done } = await stream.next();
              if (done) {
                throw new Error('OpenCode SSE stream ended unexpectedly');
              }

              if (!ev?.type || ev.type === 'server.connected' || ev.type === 'server.heartbeat') continue;

              lastEventAt = Date.now();
              yield { type: 'activity' };

              switch (ev.type) {
                case 'message.updated': {
                  const info = ev.properties.info as { id?: string; role?: string; sessionID?: string } | undefined;
                  if (info?.sessionID && info.sessionID !== turnSessionId) break;
                  if (info?.id && info?.role) {
                    roleByMessageId.set(info.id, info.role);
                    if (info.role === 'assistant' && partMessageIds.has(info.id)) {
                      sawAssistantWork = true;
                    }
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
                    if (roleByMessageId.get(part.messageID) === 'assistant') {
                      sawAssistantWork = true;
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
          }

          let resultText = '';
          for (const [msgId, role] of roleByMessageId) {
            if (role === 'assistant') {
              sawAssistantWork = true;
              resultText = partTextByMessageId.get(msgId) ?? resultText;
            }
          }
          return { resultText, sawAssistantWork };
        }

        let outcome = yield* runTurn(sessionId, text, attachments);
        if (aborted) return;

        if (
          isEmptyOpenCodeResume({
            resumedExistingSession: allowEmptyResumeFallback,
            alreadyFellBack: emptyResumeFellBack,
            sawAssistantWork: outcome.sawAssistantWork,
          })
        ) {
          log(`Empty resume on ${sessionId}; starting fresh session.`);
          emptyResumeFellBack = true;
          self.activeSessionId = undefined;
          const created = await client.session.create();
          if (aborted) return;
          if (created.error) {
            throw new Error(`OpenCode: failed to create session: ${JSON.stringify(created.error)}`);
          }
          const freshId = created.data?.id;
          if (!freshId) throw new Error('OpenCode: failed to create session (no id)');
          sessionId = freshId;
          self.activeSessionId = freshId;
          yield { type: 'init', continuation: freshId };
          initYielded = true;
          const memory = runMemorySessionHook(self.memorySessionHook, 'startup');
          const retryText = memory ? wrapPromptWithContext(text, memory) : text;
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
          allowEmptyResumeFallback: false,
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
        destroySharedRuntime();
      },
    };
  }
}

registerProvider('opencode', (opts) => new OpenCodeProvider(opts));
