import fs from 'fs';
import path from 'path';

import { describe, expect, it, vi } from 'vitest';

import {
  buildOneCliOAuthSecret,
  buildOpenCodeLoginArgs,
  buildOpenCodeOAuthStub,
  discoverLocalModelIds,
  normalizeOptionalInput,
  OPENCODE_CHATGPT_MODELS,
} from './opencode.js';

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
