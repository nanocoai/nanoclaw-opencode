import { describe, expect, it, vi } from 'vitest';
import { discoverOpenCodeModels, discoverOpenCodeProviders } from './model-discovery.js';
import type { OpenCodeModelProvider } from './types.js';

function provider(overrides: Partial<OpenCodeModelProvider> = {}): OpenCodeModelProvider {
  return {
    id: 'connection-1',
    name: 'Local',
    provider_id: 'openai',
    discovery_type: 'openai-compatible',
    base_url: 'http://host.docker.internal:8891/v1',
    models_url: null,
    context_limit: 32768,
    output_limit: 4096,
    input_modalities: 'text',
    instructions: null,
    enabled: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('OpenCode live model discovery', () => {
  it('discovers a local OpenAI-compatible endpoint through the credential gateway path', async () => {
    const viaOneCli = vi.fn().mockResolvedValue({ data: [{ id: 'qwen-local', context_window: 65536 }] });
    const models = await discoverOpenCodeModels(provider(), undefined, viaOneCli);
    expect(viaOneCli).toHaveBeenCalledWith('http://host.docker.internal:8891/v1/models');
    expect(models[0]).toMatchObject({ id: 'openai/qwen-local', contextLimit: 65536 });
  });

  it('sends no placeholder authorization header for a typed keyless connection', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'qwen-local' }] }), { status: 200 }));
    await discoverOpenCodeModels(provider(), fetchImpl, undefined, {
      schemaVersion: 1,
      id: 'connection-1',
      displayName: 'Local',
      providerId: 'openai',
      auth: { kind: 'keyless' },
      transport: {
        kind: 'openai_compatible',
        apiMode: 'chat_completions',
        baseUrl: 'http://host.docker.internal:8891/v1',
      },
      discovery: { kind: 'models_endpoint', url: 'http://host.docker.internal:8891/v1/models' },
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://host.docker.internal:8891/v1/models',
      expect.objectContaining({ headers: undefined }),
    );
  });

  it('discovers provider models live from Models.dev', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          openai: {
            models: {
              'gpt-live': {
                id: 'gpt-live',
                name: 'GPT Live',
                modalities: { input: ['text'], output: ['text'] },
                limit: { context: 128000, output: 8192 },
              },
            },
          },
        }),
        { status: 200 },
      ),
    );
    const models = await discoverOpenCodeModels(provider({ discovery_type: 'models-dev', base_url: null }), fetchImpl);
    expect(models).toEqual([
      { id: 'openai/gpt-live', name: 'GPT Live', contextLimit: 128000, outputLimit: 8192, inputModalities: 'text' },
    ]);
  });

  it('discovers and sorts the live OpenCode provider catalog from Models.dev', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          zeta: { name: 'Zeta', models: { one: { limit: { context: 32000 } } } },
          empty: { name: 'Empty', models: {} },
          audio: {
            name: 'Audio only',
            models: { speech: { modalities: { output: ['audio'] }, limit: { context: 32000 } } },
          },
          alpha: { name: 'Alpha AI', models: { two: { limit: { context: 128000 } } } },
        }),
        { status: 200 },
      ),
    );
    await expect(discoverOpenCodeProviders(fetchImpl)).resolves.toEqual([
      { id: 'alpha', name: 'Alpha AI' },
      { id: 'zeta', name: 'Zeta' },
    ]);
  });
});
