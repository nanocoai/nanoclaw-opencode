import type { InboundEvent } from '../../channels/adapter.js';
import { readEnvFile } from '../../env.js';
import { onHostStart } from '../../host-lifecycle.js';
import { registerMigration } from '../../db/migrations/index.js';
import type { ResponsePayload } from '../../response-registry.js';
import {
  registerChannelAgentProvisioner,
  type ChannelAgentProvisioningContext,
} from '../permissions/channel-agent-provisioner.js';
import {
  beginState,
  deleteState,
  getProvider,
  getState,
  listProviders,
  pendingTextInputFor,
  persistProviderSettings,
  syncEnvironmentProvider,
  updateState,
} from './db.js';
import { discoverOpenCodeModels, discoverOpenCodeProviders } from './model-discovery.js';
import { opencodeChannelProvisioningMigration } from './migration.js';
import type { DiscoveredOpenCodeModel, OpenCodeModelProvider } from './types.js';
import './cli-resource.js';

const PROVIDER_PREFIX = 'opencode_provider:';
const CATALOG_PROVIDER_PREFIX = 'opencode_catalog_provider:';
const PROVIDER_PAGE_PREFIX = 'opencode_provider_page:';
const PROVIDER_SEARCH = 'opencode_search_providers';
const MODEL_PREFIX = 'opencode_model:';
const MODEL_PAGE_PREFIX = 'opencode_model_page:';
const MODEL_SEARCH = 'opencode_search_models';
const CHANGE_PROVIDER = 'opencode_change_provider';
const BROWSE_PROVIDERS = 'opencode_browse_providers';
const INLINE_LOCAL = 'opencode_inline_local';
const CONFIRM = 'opencode_confirm_agent';
const CANCEL = 'opencode_cancel_agent';
const MAX_OPTIONS = 8;
const PRIMARY_PROVIDER_SLOTS = 5;
const MODEL_PAGE_SIZE = 3;
const RECOMMENDED_PROVIDERS = [
  { id: 'opencode', name: 'OpenCode Zen' },
  { id: 'openrouter', name: 'OpenRouter' },
  { id: 'anthropic', name: 'Anthropic' },
  { id: 'openai', name: 'OpenAI' },
  { id: 'google', name: 'Google' },
  { id: 'ollama', name: 'Ollama' },
] as const;
const CATALOG_SEARCH = '__catalog_search__';
const CATALOG_SEARCH_EXPLICIT = '__catalog_search_explicit__';
const CATALOG_BROWSE = '__catalog_browse__';
const CATALOG_SELECTED_PREFIX = '__catalog__:';
const MODEL_SEARCH_PROVIDER_PREFIX = '__model_search__:';
const INLINE_URL = '__inline_local_url__';
const INLINE_CONTEXT_PREFIX = '__inline_local_context__:';
const INLINE_PROVIDER_PREFIX = '__inline_provider__:';

registerMigration(opencodeChannelProvisioningMigration);

onHostStart(async () => {
  const env = readEnvFile([
    'OPENCODE_PROVIDER',
    'ANTHROPIC_BASE_URL',
    'OPENCODE_MODEL_CONTEXT_LIMIT',
    'OPENCODE_MODEL_OUTPUT_LIMIT',
    'OPENCODE_MODEL_INPUT_MODALITIES',
  ]);
  const providerId = (process.env.OPENCODE_PROVIDER ?? env.OPENCODE_PROVIDER)?.trim().toLowerCase();
  if (!providerId) return;
  const positive = (raw: string | undefined) => {
    const value = Number(raw);
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  };
  await syncEnvironmentProvider({
    providerId,
    baseUrl: process.env.ANTHROPIC_BASE_URL ?? env.ANTHROPIC_BASE_URL,
    contextLimit: positive(process.env.OPENCODE_MODEL_CONTEXT_LIMIT ?? env.OPENCODE_MODEL_CONTEXT_LIMIT),
    outputLimit: positive(process.env.OPENCODE_MODEL_OUTPUT_LIMIT ?? env.OPENCODE_MODEL_OUTPUT_LIMIT),
    inputModalities: process.env.OPENCODE_MODEL_INPUT_MODALITIES ?? env.OPENCODE_MODEL_INPUT_MODALITIES,
  });
});

function messageText(event: InboundEvent): string {
  try {
    const parsed = JSON.parse(event.message.content) as Record<string, unknown>;
    return typeof parsed.text === 'string' ? parsed.text.trim() : '';
  } catch {
    return event.message.content.trim();
  }
}

async function discover(context: ChannelAgentProvisioningContext, provider: OpenCodeModelProvider) {
  try {
    return await discoverOpenCodeModels(provider);
  } catch {
    await context.deliverText(`Could not read models from ${provider.name}. Check the connection and try again.`);
    return undefined;
  }
}

function virtualProvider(providerId: string, name: string): OpenCodeModelProvider {
  const now = new Date().toISOString();
  return {
    id: `${CATALOG_SELECTED_PREFIX}${providerId}`,
    name,
    provider_id: providerId,
    discovery_type: 'models-dev',
    base_url: null,
    models_url: null,
    context_limit: null,
    output_limit: null,
    input_modalities: '',
    instructions: null,
    enabled: 1,
    created_at: now,
    updated_at: now,
  };
}

function encodeInlineProvider(provider: OpenCodeModelProvider): string {
  return `${INLINE_PROVIDER_PREFIX}${Buffer.from(JSON.stringify(provider)).toString('base64url')}`;
}

function decodeInlineProvider(value: string): OpenCodeModelProvider | undefined {
  if (!value.startsWith(INLINE_PROVIDER_PREFIX)) return undefined;
  try {
    const provider = JSON.parse(
      Buffer.from(value.slice(INLINE_PROVIDER_PREFIX.length), 'base64url').toString(),
    ) as OpenCodeModelProvider;
    // Keep the opaque durable state key when model search renders another card.
    provider.id = value;
    return provider;
  } catch {
    return undefined;
  }
}

async function resolveProvider(id: string): Promise<OpenCodeModelProvider | undefined> {
  if (id.startsWith(MODEL_SEARCH_PROVIDER_PREFIX)) {
    return resolveProvider(id.slice(MODEL_SEARCH_PROVIDER_PREFIX.length));
  }
  const inline = decodeInlineProvider(id);
  if (inline) return inline;
  if (id.startsWith(CATALOG_SELECTED_PREFIX)) {
    const providerId = id.slice(CATALOG_SELECTED_PREFIX.length);
    return providerId ? virtualProvider(providerId, providerId) : undefined;
  }
  return getProvider(id);
}

async function offerProviders(context: ChannelAgentProvisioningContext, agentName: string): Promise<void> {
  const providers = await listProviders();
  let catalogIds = new Set<string>();
  try {
    catalogIds = new Set((await discoverOpenCodeProviders()).map((provider) => provider.id));
  } catch {
    // Configured connections and the custom endpoint remain usable offline.
  }
  const configuredProviderIds = new Set(providers.map((provider) => provider.provider_id));
  const primaryProviders = [
    ...providers.map((provider) => ({
      label: provider.name,
      selectedLabel: `✅ ${provider.name}`,
      value: `${PROVIDER_PREFIX}${encodeURIComponent(provider.id)}`,
    })),
    ...RECOMMENDED_PROVIDERS.filter(
      (provider) => catalogIds.has(provider.id) && !configuredProviderIds.has(provider.id),
    ).map((provider) => ({
      label: provider.name,
      selectedLabel: `✅ ${provider.name}`,
      value: `${CATALOG_PROVIDER_PREFIX}${encodeURIComponent(provider.id)}`,
    })),
  ].slice(0, PRIMARY_PROVIDER_SLOTS);
  await context.deliverQuestion('☁️ Choose an OpenCode provider', `Which provider should "${agentName}" use?`, [
    ...primaryProviders,
    {
      label: 'More providers…',
      selectedLabel: '🔎 More providers…',
      value: BROWSE_PROVIDERS,
    },
    {
      label: 'Local or custom endpoint',
      selectedLabel: '✅ Local or custom endpoint',
      value: INLINE_LOCAL,
    },
    { label: 'Cancel', selectedLabel: '🙅 Cancelled', value: CANCEL },
  ]);
}

async function offerProviderSearch(context: ChannelAgentProvisioningContext, query: string): Promise<void> {
  let catalog;
  try {
    catalog = await discoverOpenCodeProviders();
  } catch {
    await context.deliverText('Could not read the OpenCode provider catalog. Check network access and try again.');
    return;
  }
  const needle = query.trim().toLowerCase();
  const matches = catalog
    .filter((provider) => provider.id.toLowerCase().includes(needle) || provider.name.toLowerCase().includes(needle))
    .slice(0, MAX_OPTIONS - 2);
  if (!matches.length) {
    await context.deliverText('No matching OpenCode providers. Reply with another provider name or ID.');
    return;
  }
  await context.deliverQuestion('☁️ Choose an OpenCode provider', `Providers matching “${query.trim()}”:`, [
    ...matches.map((provider) => ({
      label: provider.name,
      selectedLabel: `✅ ${provider.name}`,
      value: `${CATALOG_PROVIDER_PREFIX}${encodeURIComponent(provider.id)}`,
    })),
    { label: 'Search again', selectedLabel: '🔎 Search again', value: PROVIDER_SEARCH },
    { label: 'Cancel', selectedLabel: '🙅 Cancelled', value: CANCEL },
  ]);
}

async function offerProviderCatalog(context: ChannelAgentProvisioningContext, page = 0): Promise<void> {
  const configured = await listProviders();
  let catalog;
  try {
    catalog = await discoverOpenCodeProviders();
  } catch {
    await context.deliverText('Could not read the OpenCode provider catalog. Check network access and try again.');
    return;
  }
  const choices = [
    ...configured.map((provider) => ({
      label: provider.name,
      selectedLabel: `✅ ${provider.name}`,
      value: `${PROVIDER_PREFIX}${encodeURIComponent(provider.id)}`,
    })),
    ...catalog.map((provider) => ({
      label: provider.name,
      selectedLabel: `✅ ${provider.name}`,
      value: `${CATALOG_PROVIDER_PREFIX}${encodeURIComponent(provider.id)}`,
    })),
  ];
  const pageSize = 4;
  const lastPage = Math.max(0, Math.ceil(choices.length / pageSize) - 1);
  const currentPage = Math.min(Math.max(0, page), lastPage);
  const visible = choices.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  await updateState(context.row.messaging_group_id, {
    step: 'awaiting_provider',
    providerId: CATALOG_BROWSE,
    modelId: null,
  });
  await context.deliverQuestion(
    '☁️ Choose an OpenCode provider',
    `Provider page ${currentPage + 1} of ${lastPage + 1}:`,
    [
      ...visible,
      ...(currentPage > 0
        ? [
            {
              label: 'Previous providers',
              selectedLabel: '⬅️ Previous providers',
              value: `${PROVIDER_PAGE_PREFIX}${currentPage - 1}`,
            },
          ]
        : []),
      ...(currentPage < lastPage
        ? [
            {
              label: 'Next providers',
              selectedLabel: '➡️ Next providers',
              value: `${PROVIDER_PAGE_PREFIX}${currentPage + 1}`,
            },
          ]
        : []),
      { label: 'Search providers', selectedLabel: '🔎 Search providers', value: PROVIDER_SEARCH },
      { label: 'Cancel', selectedLabel: '🙅 Cancelled', value: CANCEL },
    ],
  );
}

async function offerModels(
  context: ChannelAgentProvisioningContext,
  provider: OpenCodeModelProvider,
  models: DiscoveredOpenCodeModel[],
  page = 0,
): Promise<void> {
  const lastPage = Math.max(0, Math.ceil(models.length / MODEL_PAGE_SIZE) - 1);
  const currentPage = Math.min(Math.max(0, page), lastPage);
  const visible = models.slice(currentPage * MODEL_PAGE_SIZE, (currentPage + 1) * MODEL_PAGE_SIZE);
  const state = await getState(context.row.messaging_group_id);
  await updateState(context.row.messaging_group_id, { step: 'awaiting_model', providerId: provider.id, modelId: null });
  await context.deliverQuestion(
    `🧠 Choose a ${provider.name} model`,
    `Which model should "${state?.agent_name}" use? Page ${currentPage + 1} of ${lastPage + 1}.`,
    [
      ...visible.map((model) => ({
        label: model.name,
        selectedLabel: `✅ ${model.name}`,
        value: `${MODEL_PREFIX}${encodeURIComponent(model.id)}`,
      })),
      ...(currentPage > 0
        ? [
            {
              label: 'Previous models',
              selectedLabel: '⬅️ Previous models',
              value: `${MODEL_PAGE_PREFIX}${currentPage - 1}`,
            },
          ]
        : []),
      ...(currentPage < lastPage
        ? [{ label: 'Next models', selectedLabel: '➡️ Next models', value: `${MODEL_PAGE_PREFIX}${currentPage + 1}` }]
        : []),
      { label: 'Search models', selectedLabel: '🔎 Search models', value: MODEL_SEARCH },
      { label: 'Change provider', selectedLabel: '↩️ Change provider', value: CHANGE_PROVIDER },
      { label: 'Cancel', selectedLabel: '🙅 Cancelled', value: CANCEL },
    ],
  );
}

async function offerModelSearchResults(
  context: ChannelAgentProvisioningContext,
  provider: OpenCodeModelProvider,
  models: DiscoveredOpenCodeModel[],
): Promise<void> {
  const state = await getState(context.row.messaging_group_id);
  await updateState(context.row.messaging_group_id, { step: 'awaiting_model', providerId: provider.id, modelId: null });
  await context.deliverQuestion(`🧠 Choose a ${provider.name} model`, `Search results for "${state?.agent_name}":`, [
    ...models.slice(0, MAX_OPTIONS - 3).map((model) => ({
      label: model.name,
      selectedLabel: `✅ ${model.name}`,
      value: `${MODEL_PREFIX}${encodeURIComponent(model.id)}`,
    })),
    { label: 'Search again', selectedLabel: '🔎 Search again', value: MODEL_SEARCH },
    { label: 'Change provider', selectedLabel: '↩️ Change provider', value: CHANGE_PROVIDER },
    { label: 'Cancel', selectedLabel: '🙅 Cancelled', value: CANCEL },
  ]);
}

async function cancel(context: ChannelAgentProvisioningContext): Promise<void> {
  await deleteState(context.row.messaging_group_id);
  await context.cancel();
  await context.deliverText('OpenCode agent creation cancelled. Mention the bot again to restart registration.');
}

registerChannelAgentProvisioner({
  provider: 'opencode',
  async start(context) {
    await beginState(context.row.messaging_group_id, context.row.approver_user_id);
    await context.deliverText('Reply with the name for your new agent:');
  },
  pendingTextInputFor,
  async handleText(context, event, approverUserId) {
    if (approverUserId !== context.row.approver_user_id) return false;
    if (!(await context.isApproverDm(event))) return false;
    const state = await getState(context.row.messaging_group_id);
    if (!state) return false;
    const text = messageText(event);
    if (!text) return true;
    if (text.toLowerCase() === 'cancel') {
      await cancel(context);
      return true;
    }
    if (state.step === 'awaiting_name') {
      await updateState(context.row.messaging_group_id, { step: 'awaiting_provider', agentName: text, modelId: null });
      await offerProviders(context, text);
      return true;
    }
    if (state.step === 'awaiting_provider' && state.provider_id === CATALOG_SEARCH) {
      await offerProviderCatalog(context);
      return true;
    }
    if (state.step === 'awaiting_provider' && state.provider_id === CATALOG_SEARCH_EXPLICIT) {
      await offerProviderSearch(context, text);
      return true;
    }
    if (state.step === 'awaiting_provider' && state.provider_id === INLINE_URL) {
      let baseUrl: string;
      try {
        if (text.length > 2048) throw new Error('URL too long');
        const parsed = new URL(text);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('unsupported protocol');
        parsed.hash = '';
        parsed.search = '';
        baseUrl = parsed.toString().replace(/\/$/, '');
      } catch {
        await context.deliverText('Enter a valid HTTP(S) base URL, including `/v1`.');
        return true;
      }
      await updateState(context.row.messaging_group_id, {
        step: 'awaiting_model_query',
        providerId: `${INLINE_CONTEXT_PREFIX}${Buffer.from(baseUrl).toString('base64url')}`,
        modelId: null,
      });
      await context.deliverText('Reply with the model context window in tokens (for example `32768` or `262144`).');
      return true;
    }
    if (state.step === 'awaiting_model_query' && state.provider_id?.startsWith(INLINE_CONTEXT_PREFIX)) {
      const contextLimit = Number(text);
      if (!Number.isSafeInteger(contextLimit) || contextLimit < 1024) {
        await context.deliverText('Enter a whole-number context window of at least 1024 tokens.');
        return true;
      }
      const baseUrl = Buffer.from(state.provider_id.slice(INLINE_CONTEXT_PREFIX.length), 'base64url').toString();
      const provider = virtualProvider('openai', `Local endpoint (${new URL(baseUrl).host})`);
      provider.id = '__inline_local__';
      provider.discovery_type = 'openai-compatible';
      provider.base_url = baseUrl;
      provider.context_limit = contextLimit;
      provider.output_limit = Math.min(8192, Math.max(1024, Math.floor(contextLimit / 4)));
      provider.input_modalities = 'text';
      const encoded = encodeInlineProvider(provider);
      provider.id = encoded;
      await updateState(context.row.messaging_group_id, {
        step: 'awaiting_model_query',
        providerId: encoded,
        modelId: null,
      });
      const models = await discover(context, provider);
      if (models) await offerModels(context, provider, models);
      return true;
    }
    if (state.step === 'awaiting_model_query' && state.provider_id) {
      const provider = await resolveProvider(state.provider_id);
      if (!provider) return true;
      const models = await discover(context, provider);
      if (!models) return true;
      // Versions before the model browser stored the provider directly when
      // they forced large catalogs into text search. Reopen those in-flight
      // wizards as a browsable list; only the explicit search action below
      // writes the sentinel that makes text act as a query.
      if (!state.provider_id.startsWith(MODEL_SEARCH_PROVIDER_PREFIX)) {
        await offerModels(context, provider, models);
        return true;
      }
      const query = text.toLowerCase();
      const matches = models.filter(
        (model) => model.id.toLowerCase().includes(query) || model.name.toLowerCase().includes(query),
      );
      if (!matches.length) {
        await context.deliverText('No matching models. Reply with a different search term.');
        return true;
      }
      await offerModelSearchResults(context, provider, matches);
      return true;
    }
    return false;
  },
  async handleResponse(context, payload: ResponsePayload) {
    const state = await getState(context.row.messaging_group_id);
    if (!state) return false;
    if (payload.value === CANCEL) {
      await cancel(context);
      return true;
    }
    if (payload.value === BROWSE_PROVIDERS) {
      if (state.step !== 'awaiting_provider') return true;
      await offerProviderCatalog(context);
      return true;
    }
    if (payload.value.startsWith(PROVIDER_PAGE_PREFIX)) {
      if (state.step !== 'awaiting_provider' || state.provider_id !== CATALOG_BROWSE) return true;
      const page = Number(payload.value.slice(PROVIDER_PAGE_PREFIX.length));
      await offerProviderCatalog(context, Number.isSafeInteger(page) ? page : 0);
      return true;
    }
    if (payload.value === PROVIDER_SEARCH) {
      if (state.step !== 'awaiting_provider') return true;
      await updateState(context.row.messaging_group_id, {
        step: 'awaiting_provider',
        providerId: CATALOG_SEARCH_EXPLICIT,
        modelId: null,
      });
      await context.deliverText('Reply with part of the OpenCode provider name or ID (for example `openrouter`).');
      return true;
    }
    if (payload.value === INLINE_LOCAL) {
      if (state.step !== 'awaiting_provider') return true;
      await updateState(context.row.messaging_group_id, {
        step: 'awaiting_provider',
        providerId: INLINE_URL,
        modelId: null,
      });
      await context.deliverText(
        'Reply with the local or custom OpenAI-compatible base URL, including `/v1` (for example `http://host.docker.internal:8891/v1`).',
      );
      return true;
    }
    if (payload.value === CHANGE_PROVIDER) {
      if (state.step !== 'awaiting_model' || !state.agent_name) return true;
      await updateState(context.row.messaging_group_id, { step: 'awaiting_provider', modelId: null });
      await offerProviders(context, state.agent_name);
      return true;
    }
    if (payload.value.startsWith(CATALOG_PROVIDER_PREFIX)) {
      if (state.step !== 'awaiting_provider') return true;
      const providerId = decodeURIComponent(payload.value.slice(CATALOG_PROVIDER_PREFIX.length));
      let catalog;
      try {
        catalog = await discoverOpenCodeProviders();
      } catch {
        await context.deliverText('Could not read the OpenCode provider catalog. Check network access and try again.');
        return true;
      }
      const entry = catalog.find((provider) => provider.id === providerId);
      if (!entry) return true;
      const provider = virtualProvider(entry.id, entry.name);
      await updateState(context.row.messaging_group_id, {
        step: 'awaiting_provider',
        providerId: provider.id,
        modelId: null,
      });
      const models = await discover(context, provider);
      if (models) await offerModels(context, provider, models);
      return true;
    }
    if (payload.value.startsWith(PROVIDER_PREFIX)) {
      if (state.step !== 'awaiting_provider') return true;
      const provider = await getProvider(decodeURIComponent(payload.value.slice(PROVIDER_PREFIX.length)));
      if (!provider) return true;
      const models = await discover(context, provider);
      if (models) await offerModels(context, provider, models);
      return true;
    }
    if (payload.value.startsWith(MODEL_PAGE_PREFIX)) {
      if (state.step !== 'awaiting_model' || !state.provider_id) return true;
      const provider = await resolveProvider(state.provider_id);
      if (!provider) return true;
      const models = await discover(context, provider);
      if (!models) return true;
      const page = Number(payload.value.slice(MODEL_PAGE_PREFIX.length));
      await offerModels(context, provider, models, Number.isSafeInteger(page) ? page : 0);
      return true;
    }
    if (payload.value === MODEL_SEARCH) {
      if (state.step !== 'awaiting_model' || !state.provider_id) return true;
      await updateState(context.row.messaging_group_id, {
        step: 'awaiting_model_query',
        providerId: `${MODEL_SEARCH_PROVIDER_PREFIX}${state.provider_id}`,
        modelId: null,
      });
      await context.deliverText('Reply with part of the model name or ID to search.');
      return true;
    }
    if (payload.value.startsWith(MODEL_PREFIX)) {
      if (state.step !== 'awaiting_model' || !state.provider_id || !state.agent_name) return true;
      const provider = await resolveProvider(state.provider_id);
      if (!provider) return true;
      const models = await discover(context, provider);
      if (!models) return true;
      const modelId = decodeURIComponent(payload.value.slice(MODEL_PREFIX.length));
      const model = models.find((entry) => entry.id === modelId);
      if (!model) return true;
      await updateState(context.row.messaging_group_id, { step: 'awaiting_confirmation', modelId: model.id });
      await context.deliverQuestion('✅ Confirm new OpenCode agent', `Create "${state.agent_name}" with ${model.id}?`, [
        { label: 'Create and connect', selectedLabel: '✅ Creating…', value: CONFIRM, style: 'primary' },
        { label: 'Cancel', selectedLabel: '🙅 Cancelled', value: CANCEL },
      ]);
      return true;
    }
    if (payload.value === CONFIRM) {
      if (state.step !== 'awaiting_confirmation' || !state.agent_name || !state.provider_id || !state.model_id)
        return true;
      const provider = await resolveProvider(state.provider_id);
      if (!provider) return true;
      const models = await discover(context, provider);
      const model = models?.find((entry) => entry.id === state.model_id);
      if (!model) return true;
      const agent = await context.createAgent({
        name: state.agent_name,
        provider: 'opencode',
        model: model.id,
        instructions: provider.instructions ?? undefined,
      });
      await persistProviderSettings(agent.id, provider, model);
      const approverId = payload.userId?.includes(':')
        ? payload.userId
        : `${payload.channelType}:${payload.userId ?? ''}`;
      const wired = await context.wireAgent(agent.id, approverId);
      await context.deliverText(
        wired
          ? `✅ OpenCode agent "${agent.name}" created with ${model.id} and connected.`
          : `⚠️ OpenCode agent "${agent.name}" was created but the channel could not be connected.`,
      );
      return true;
    }
    // A durable OpenCode state owns this question id. Claim stale buttons from
    // earlier cards so they cannot fall through to core and bypass confirmation.
    return true;
  },
});
