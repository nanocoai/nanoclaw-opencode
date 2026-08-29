import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildOneCliManagedStub,
  buildOneCliOAuthSecret,
  buildOpenCodeLoginArgs,
  buildOpenCodeOAuthStub,
  discoverLocalModelIds,
  ensureChatGptStub,
  isUsableChatGptStub,
  normalizeOptionalInput,
  OPENCODE_CHATGPT_MODELS,
  parseChatGptModelList,
  hasChatGptSecret,
  runOpenCodeChatGptAuth,
} from './opencode.js';

const proc = vi.hoisted(() => ({ execFileSync: vi.fn(), spawn: vi.fn() }));
vi.mock('child_process', async (importActual) => {
  const actual = await importActual<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => proc.execFileSync(...args),
    spawn: (...args: unknown[]) => proc.spawn(...args),
  };
});

describe('OpenCode setup payload', () => {
  it('accepts a blank optional API key for a keyless local endpoint', () => {
    expect(normalizeOptionalInput(undefined)).toBe('');
    expect(normalizeOptionalInput('  local-key  ')).toBe('local-key');
  });

  it('discovers, trims, sorts, and deduplicates OpenAI-compatible model ids', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ data: [{ id: 'qwen-b' }, { id: ' qwen-a ' }, { id: 'qwen-b' }, {}] })),
    );

    await expect(discoverLocalModelIds('http://host.docker.internal:8891/v1/', fetchImpl)).resolves.toEqual([
      'qwen-a',
      'qwen-b',
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:8891/v1/models'),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('rejects malformed model discovery responses so the wizard can fall back to manual input', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ models: [] })));
    await expect(discoverLocalModelIds('http://127.0.0.1:8891/v1', fetchImpl)).rejects.toThrow('no data array');
  });

  it('replaces live OAuth tokens with a non-expiring OneCLI stub and keeps account routing metadata', () => {
    expect(
      buildOpenCodeOAuthStub({
        openai: {
          type: 'oauth',
          access: 'live-access-token',
          refresh: 'live-refresh-token',
          expires: 1,
          accountId: 'account-123',
        },
      }),
    ).toEqual({
      openai: {
        type: 'oauth',
        access: 'onecli-managed',
        refresh: 'onecli-managed',
        expires: Date.UTC(2100, 0, 1),
        accountId: 'account-123',
      },
    });
  });

  it('vaults ChatGPT tokens in the Codex shape OneCLI classifies as oauth', () => {
    expect(
      buildOneCliOAuthSecret(
        {
          openai: {
            type: 'oauth',
            access: 'live-access-token',
            refresh: 'live-refresh-token',
            expires: 1,
            accountId: 'account-123',
          },
        },
        new Date('2026-08-29T12:00:00.000Z'),
      ),
    ).toEqual({
      tokens: {
        access_token: 'live-access-token',
        refresh_token: 'live-refresh-token',
        account_id: 'account-123',
      },
      OPENAI_API_KEY: null,
      last_refresh: '2026-08-29T12:00:00.000Z',
    });
  });

  it('refuses to vault a credential with no account id, which the gateway cannot route', () => {
    const base = { type: 'oauth', access: 'a', refresh: 'r' };
    expect(() => buildOneCliOAuthSecret({ openai: base })).toThrow('no account id');
    expect(() => buildOneCliOAuthSecret({ openai: { ...base, accountId: '  ' } })).toThrow('no account id');
  });

  it('refuses to vault a credential with no refresh token, which the gateway cannot renew', () => {
    expect(() =>
      buildOneCliOAuthSecret({ openai: { type: 'oauth', access: 'a', accountId: 'account-123' } }),
    ).toThrow('did not create an OpenAI OAuth credential');
  });

  it('rejects API-key auth records instead of misrepresenting them as subscription OAuth', () => {
    expect(() => buildOpenCodeOAuthStub({ openai: { type: 'api', key: 'sk-live' } })).toThrow(
      'did not create an OpenAI OAuth credential',
    );
  });

  it('runs the pinned container CLI with isolated XDG state for device pairing', () => {
    const args = buildOpenCodeLoginArgs('/tmp/login', 'device', false);
    expect(args).toContain('/tmp/login:/opencode-login');
    expect(args).toContain('XDG_DATA_HOME=/opencode-login/data');
    expect(args.slice(-6)).toEqual([
      'auth',
      'login',
      '--provider',
      'openai',
      '--method',
      'ChatGPT Pro/Plus (headless)',
    ]);
    expect(args).not.toContain('-t');
    expect(args).not.toContain('127.0.0.1:1455:1455');
  });

  it('publishes only the native callback port for browser sign-in', () => {
    const args = buildOpenCodeLoginArgs('/tmp/login', 'browser', true);
    expect(args).toContain('127.0.0.1:1455:1455');
    expect(args).toContain('-t');
    expect(args.at(-1)).toBe('ChatGPT Pro/Plus (browser)');
  });

  it('offers the exact ChatGPT subscription models allowed by the pinned OpenCode plugin', () => {
    expect(OPENCODE_CHATGPT_MODELS).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6', 'gpt-5.5']);
  });

  it('keeps the verified runtime pin and trusted postinstall together', () => {
    const root = process.cwd();
    const tools = JSON.parse(fs.readFileSync(path.join(root, 'container/cli-tools.json'), 'utf8')) as Array<{
      name: string;
      version: string;
      onlyBuilt?: boolean;
    }>;
    const runner = JSON.parse(fs.readFileSync(path.join(root, 'container/agent-runner/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const cli = tools.find((entry) => entry.name === 'opencode-ai');
    expect(cli).toEqual({ name: 'opencode-ai', version: '1.18.25', onlyBuilt: true });
    expect(runner.dependencies?.['@opencode-ai/sdk']).toBe('1.18.25');
  });
});

describe('parseChatGptModelList', () => {
  it('extracts and de-duplicates openai gpt model ids', () => {
    const out = 'openai/gpt-5.6-sol\nopenai/gpt-5.6-terra\nopenai/gpt-5.6-sol\nopenai/o4-mini\nnoise\n';
    expect(parseChatGptModelList(out)).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra']);
  });
  it('returns empty on unrecognized output', () => {
    expect(parseChatGptModelList('command not found')).toEqual([]);
  });
});

describe('hasChatGptSecret', () => {
  it('finds the secret in a data-wrapped list', () => {
    expect(hasChatGptSecret(JSON.stringify({ data: [{ name: 'OpenCode ChatGPT' }] }))).toBe(true);
  });
  it('is false for other secrets or bad output', () => {
    expect(hasChatGptSecret(JSON.stringify({ data: [{ name: 'Anthropic' }] }))).toBe(false);
    expect(hasChatGptSecret('not json')).toBe(false);
  });
});

describe('ChatGPT credential stub idempotency', () => {
  const roots: string[] = [];
  const makeRoot = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-stub-test-'));
    roots.push(root);
    return root;
  };
  const stubIn = (root: string): string => path.join(root, 'data', 'opencode', 'openai-auth-stub.json');

  afterEach(() => {
    while (roots.length) fs.rmSync(roots.pop() as string, { recursive: true, force: true });
    proc.execFileSync.mockReset();
    proc.spawn.mockReset();
  });

  // Black-box reproduction of the spawn loop: the only inputs are a vault that
  // already holds "OpenCode ChatGPT" and an install with no stub on disk.
  it('reproduces the loop: a vaulted secret with no stub still leaves a stub behind', async () => {
    const root = makeRoot();
    proc.execFileSync.mockReturnValue(JSON.stringify({ data: [{ name: 'OpenCode ChatGPT' }] }));

    await runOpenCodeChatGptAuth('device', { root });

    // Before the fix this file was never written, so `src/providers/opencode.ts`
    // threw "credential stub is missing; re-run setup" on every spawn — and
    // re-running setup skipped sign-in again, forever.
    expect(fs.existsSync(stubIn(root))).toBe(true);
    expect(isUsableChatGptStub(fs.readFileSync(stubIn(root), 'utf8'))).toBe(true);
    // No container sign-in was launched: the secret was already there.
    expect(proc.spawn).not.toHaveBeenCalled();
    expect(proc.execFileSync).toHaveBeenCalledTimes(1);
  });

  it('writes the stub when the vault secret exists but the stub does not, without signing in', async () => {
    const root = makeRoot();
    const signIn = vi.fn(async () => {});

    await runOpenCodeChatGptAuth('device', { root, secretExists: () => true, signIn });

    expect(signIn).not.toHaveBeenCalled();
    const contents = fs.readFileSync(stubIn(root), 'utf8');
    expect(JSON.parse(contents)).toEqual({
      openai: { type: 'oauth', access: 'onecli-managed', refresh: 'onecli-managed', expires: Date.UTC(2100, 0, 1) },
    });
    // The host provider mounts this file read-only into the container; once it
    // exists, spawn stops throwing "credential stub is missing; re-run setup".
    expect(isUsableChatGptStub(contents)).toBe(true);
  });

  it('leaves an existing stub alone so a real accountId survives re-runs of setup', async () => {
    const root = makeRoot();
    const existing = {
      openai: {
        type: 'oauth',
        access: 'onecli-managed',
        refresh: 'onecli-managed',
        expires: Date.UTC(2100, 0, 1),
        accountId: 'account-123',
      },
    };
    fs.mkdirSync(path.dirname(stubIn(root)), { recursive: true });
    fs.writeFileSync(stubIn(root), `${JSON.stringify(existing, null, 2)}\n`);

    await runOpenCodeChatGptAuth('device', { root, secretExists: () => true, signIn: async () => {} });

    expect(JSON.parse(fs.readFileSync(stubIn(root), 'utf8'))).toEqual(existing);
  });

  it('rebuilds a corrupt stub instead of leaving the container unspawnable', () => {
    const root = makeRoot();
    fs.mkdirSync(path.dirname(stubIn(root)), { recursive: true });
    fs.writeFileSync(stubIn(root), '{ truncated');

    expect(ensureChatGptStub(root)).toBe('written');
    expect(isUsableChatGptStub(fs.readFileSync(stubIn(root), 'utf8'))).toBe(true);
    expect(ensureChatGptStub(root)).toBe('present');
  });

  it('still runs sign-in when no vault secret exists', async () => {
    const root = makeRoot();
    const signIn = vi.fn(async () => {});

    await runOpenCodeChatGptAuth('browser', { root, secretExists: () => false, signIn });

    expect(signIn).toHaveBeenCalledWith('browser', root);
    expect(fs.existsSync(stubIn(root))).toBe(false);
  });

  it('omits accountId, leaving OneCLI the sole source of chatgpt-account-id', () => {
    // The pinned OpenCode CLI sets `ChatGPT-Account-Id` only when
    // `openai.accountId` is present; OneCLI injects it from the vaulted
    // `tokens.account_id`, so a sign-in-free stub needs no account id and
    // never has to read a secret value to invent one.
    expect(buildOneCliManagedStub().openai).not.toHaveProperty('accountId');
  });

  it('rejects stub contents OpenCode cannot use as an OAuth record', () => {
    expect(isUsableChatGptStub('not json')).toBe(false);
    expect(isUsableChatGptStub(JSON.stringify({ openai: { type: 'api', key: 'sk-live' } }))).toBe(false);
    expect(isUsableChatGptStub(JSON.stringify({}))).toBe(false);
  });
});
