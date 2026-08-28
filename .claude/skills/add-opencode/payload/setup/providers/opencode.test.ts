import fs from 'fs';
import path from 'path';

import { describe, expect, it, vi } from 'vitest';

import {
  buildOpenCodeLoginArgs,
  buildOpenCodeOAuthStub,
  catalogCredentialDefaults,
  catalogCredentialHost,
  discoverOpenCodeCatalog,
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

  it('discovers the live provider catalog and keeps only text-capable models', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            xai: {
              id: 'xai',
              name: 'xAI',
              api: 'https://api.x.ai/v1',
              npm: '@ai-sdk/xai',
              models: {
                'grok-z': { id: 'grok-z', name: 'Grok Z', modalities: { output: ['text'] } },
                image: { id: 'image', name: 'Image', modalities: { output: ['image'] } },
                'grok-a': { id: 'grok-a', name: 'Grok A' },
              },
            },
            empty: { id: 'empty', name: 'Empty', models: {} },
          }),
        ),
    );

    await expect(discoverOpenCodeCatalog(fetchImpl)).resolves.toEqual([
      {
        id: 'xai',
        name: 'xAI',
        api: 'https://api.x.ai/v1',
        npm: '@ai-sdk/xai',
        models: [
          { id: 'xai/grok-a', name: 'Grok A' },
          { id: 'xai/grok-z', name: 'Grok Z' },
        ],
      },
    ]);
  });

  it('rejects malformed live provider catalogs', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([])));
    await expect(discoverOpenCodeCatalog(fetchImpl)).rejects.toThrow('catalog is not an object');
  });

  it('uses provider-specific OneCLI injection defaults without guessing for future providers', () => {
    expect(catalogCredentialDefaults({ id: 'anthropic', name: 'Anthropic', models: [] })).toEqual({
      host: 'api.anthropic.com',
      headerName: 'x-api-key',
      valueFormat: '{value}',
    });
    expect(
      catalogCredentialDefaults({
        id: 'future-provider',
        name: 'Future',
        api: 'https://api.future.test/v1',
        models: [],
      }),
    ).toBeUndefined();
    expect(
      catalogCredentialHost({
        id: 'future-provider',
        name: 'Future',
        api: 'https://api.future.test/v1',
        models: [],
      }),
    ).toBe('api.future.test');
    expect(catalogCredentialDefaults({ id: 'manual-provider', name: 'Manual', models: [] })).toBeUndefined();
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
    expect(OPENCODE_CHATGPT_MODELS).toEqual(['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.5', 'gpt-5.3-codex-spark']);
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
    expect(cli).toEqual({ name: 'opencode-ai', version: '1.18.21', onlyBuilt: true });
    expect(runner.dependencies?.['@opencode-ai/sdk']).toBe('1.18.21');
  });
});
