import { execFile } from 'child_process';
import type { DiscoveredOpenCodeModel, DiscoveredOpenCodeProvider, OpenCodeModelProvider } from './types.js';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const MAX_DISCOVERY_BYTES = 8 * 1024 * 1024;
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type JsonFetchLike = (url: string) => Promise<unknown>;

function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function modalities(value: unknown, fallback: string): string {
  const list = Array.isArray(value) ? value : [];
  const normalized = list
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  return normalized.length ? [...new Set(normalized)].join(',') : fallback;
}

async function fetchJson(url: string, authenticated: boolean, fetchImpl: FetchLike): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: authenticated ? { Authorization: 'Bearer placeholder' } : undefined,
    });
    if (!response.ok) throw new Error(`model discovery returned HTTP ${response.status}`);
    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > MAX_DISCOVERY_BYTES) throw new Error('model discovery response is too large');
    return JSON.parse(body) as unknown;
  } finally {
    clearTimeout(timeout);
  }
}

function fetchJsonViaOneCli(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      'onecli',
      [
        'run',
        '--',
        'curl',
        '--fail',
        '--silent',
        '--show-error',
        '--max-time',
        '10',
        '--proto',
        '=http,https',
        '--header',
        'Authorization: Bearer placeholder',
        url,
      ],
      { encoding: 'utf8', maxBuffer: MAX_DISCOVERY_BYTES + 1, timeout: 15_000 },
      (error, stdout) => {
        if (error) return reject(new Error('model discovery through OneCLI failed'));
        try {
          resolve(JSON.parse(stdout) as unknown);
        } catch {
          reject(new Error('model discovery returned invalid JSON'));
        }
      },
    );
  });
}

function modelsDev(provider: OpenCodeModelProvider, payload: unknown): DiscoveredOpenCodeModel[] {
  if (typeof payload !== 'object' || payload === null) throw new Error('Models.dev returned an invalid catalog');
  const entry = (payload as Record<string, unknown>)[provider.provider_id] as Record<string, unknown> | undefined;
  const models = entry?.models;
  if (typeof models !== 'object' || models === null)
    throw new Error(`OpenCode catalog has no provider named ${provider.provider_id}`);
  return Object.entries(models as Record<string, unknown>)
    .flatMap(([catalogId, raw]) => {
      if (typeof raw !== 'object' || raw === null) return [];
      const item = raw as Record<string, unknown>;
      const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : catalogId;
      const modal = item.modalities as Record<string, unknown> | undefined;
      const outputs = Array.isArray(modal?.output) ? modal.output : ['text'];
      const contextLimit = positiveInteger((item.limit as Record<string, unknown> | undefined)?.context);
      if (!outputs.includes('text') || contextLimit === null) return [];
      return [
        {
          id: `${provider.provider_id}/${id}`,
          name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : id,
          contextLimit,
          outputLimit:
            positiveInteger((item.limit as Record<string, unknown> | undefined)?.output) ?? provider.output_limit,
          inputModalities: modalities(modal?.input, provider.input_modalities),
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function providerCatalog(payload: unknown): DiscoveredOpenCodeProvider[] {
  if (typeof payload !== 'object' || payload === null) throw new Error('Models.dev returned an invalid catalog');
  return Object.entries(payload as Record<string, unknown>)
    .flatMap(([id, raw]) => {
      if (typeof raw !== 'object' || raw === null) return [];
      const entry = raw as Record<string, unknown>;
      const models = entry.models;
      if (typeof models !== 'object' || models === null) return [];
      const hasUsableTextModel = Object.values(models).some((model) => {
        if (typeof model !== 'object' || model === null) return false;
        const item = model as Record<string, unknown>;
        const outputs = ((item.modalities as Record<string, unknown> | undefined)?.output ?? ['text']) as unknown;
        return (
          Array.isArray(outputs) &&
          outputs.includes('text') &&
          positiveInteger((item.limit as Record<string, unknown> | undefined)?.context) !== null
        );
      });
      if (!hasUsableTextModel) return [];
      return [{ id, name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : id }];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function openAi(provider: OpenCodeModelProvider, payload: unknown): DiscoveredOpenCodeModel[] {
  const data = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>).data : undefined;
  if (!Array.isArray(data)) throw new Error('OpenAI-compatible model discovery must return a data array');
  return data
    .flatMap((raw) => {
      if (typeof raw !== 'object' || raw === null) return [];
      const item = raw as Record<string, unknown>;
      const rawId = typeof item.id === 'string' ? item.id.trim() : '';
      if (!rawId) return [];
      return [
        {
          id: `${provider.provider_id}/${rawId}`,
          name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : rawId,
          contextLimit:
            positiveInteger(item.context_length) ?? positiveInteger(item.context_window) ?? provider.context_limit,
          outputLimit: positiveInteger(item.max_completion_tokens) ?? provider.output_limit,
          inputModalities: modalities(
            (item.architecture as Record<string, unknown> | undefined)?.input_modalities,
            provider.input_modalities,
          ),
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function modelListUrl(provider: OpenCodeModelProvider): string {
  if (provider.models_url) return provider.models_url;
  if (!provider.base_url) throw new Error('OpenAI-compatible discovery has no base URL');
  return `${provider.base_url.replace(/\/$/, '')}/models`;
}

export async function discoverOpenCodeModels(
  provider: OpenCodeModelProvider,
  fetchImpl?: FetchLike,
  oneCliFetchImpl: JsonFetchLike = fetchJsonViaOneCli,
): Promise<DiscoveredOpenCodeModel[]> {
  const result =
    provider.discovery_type === 'models-dev'
      ? modelsDev(provider, await fetchJson(MODELS_DEV_URL, false, fetchImpl ?? globalThis.fetch))
      : openAi(
          provider,
          fetchImpl
            ? await fetchJson(modelListUrl(provider), true, fetchImpl)
            : await oneCliFetchImpl(modelListUrl(provider)),
        );
  if (!result.length) throw new Error(`No text models were discovered for ${provider.name}`);
  return result;
}

export async function discoverOpenCodeProviders(
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<DiscoveredOpenCodeProvider[]> {
  return providerCatalog(await fetchJson(MODELS_DEV_URL, false, fetchImpl));
}
