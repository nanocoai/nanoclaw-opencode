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
import { discoverOpenCodeModels } from './model-discovery.js';
import { opencodeChannelProvisioningMigration } from './migration.js';
import type { DiscoveredOpenCodeModel, OpenCodeModelProvider } from './types.js';
import './cli-resource.js';

const PROVIDER_PREFIX = 'opencode_provider:';
const MODEL_PREFIX = 'opencode_model:';
const CONFIRM = 'opencode_confirm_agent';
const CANCEL = 'opencode_cancel_agent';
const MAX_OPTIONS = 8;

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

async function offerModels(
  context: ChannelAgentProvisioningContext,
  provider: OpenCodeModelProvider,
  models: DiscoveredOpenCodeModel[],
): Promise<void> {
  if (models.length > MAX_OPTIONS) {
    await updateState(context.row.messaging_group_id, {
      step: 'awaiting_model_query',
      providerId: provider.id,
      modelId: null,
    });
    await context.deliverText(
      `${provider.name} has ${models.length} models. Reply with part of the model name or ID to search.`,
    );
    return;
  }
  const state = await getState(context.row.messaging_group_id);
  await updateState(context.row.messaging_group_id, { step: 'awaiting_model', providerId: provider.id, modelId: null });
  await context.deliverQuestion('🧠 Choose an OpenCode model', `Which model should "${state?.agent_name}" use?`, [
    ...models.map((model) => ({
      label: model.name,
      selectedLabel: `✅ ${model.name}`,
      value: `${MODEL_PREFIX}${encodeURIComponent(model.id)}`,
    })),
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
    const state = await getState(context.row.messaging_group_id);
    if (!state) return false;
    const text = messageText(event);
    if (!text) return true;
    if (text.toLowerCase() === 'cancel') {
      await cancel(context);
      return true;
    }
    if (state.step === 'awaiting_name') {
      const providers = await listProviders();
      if (!providers.length) {
        await context.deliverText(
          'No OpenCode model-provider connections are configured. Add one with ncl opencode-model-providers create, then mention the bot again.',
        );
        await cancel(context);
        return true;
      }
      await updateState(context.row.messaging_group_id, { step: 'awaiting_provider', agentName: text, modelId: null });
      await context.deliverQuestion('☁️ Choose an OpenCode provider', `Which provider should "${text}" use?`, [
        ...providers.map((provider) => ({
          label: provider.name,
          selectedLabel: `✅ ${provider.name}`,
          value: `${PROVIDER_PREFIX}${encodeURIComponent(provider.id)}`,
        })),
        { label: 'Cancel', selectedLabel: '🙅 Cancelled', value: CANCEL },
      ]);
      return true;
    }
    if (state.step === 'awaiting_model_query' && state.provider_id) {
      const provider = await getProvider(state.provider_id);
      if (!provider) return true;
      const models = await discover(context, provider);
      if (!models) return true;
      const query = text.toLowerCase();
      const matches = models.filter(
        (model) => model.id.toLowerCase().includes(query) || model.name.toLowerCase().includes(query),
      );
      if (!matches.length) {
        await context.deliverText('No matching models. Reply with a different search term.');
        return true;
      }
      await offerModels(context, provider, matches.slice(0, MAX_OPTIONS));
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
    if (payload.value.startsWith(PROVIDER_PREFIX)) {
      if (state.step !== 'awaiting_provider') return true;
      const provider = await getProvider(decodeURIComponent(payload.value.slice(PROVIDER_PREFIX.length)));
      if (!provider) return true;
      const models = await discover(context, provider);
      if (models) await offerModels(context, provider, models);
      return true;
    }
    if (payload.value.startsWith(MODEL_PREFIX)) {
      if (state.step !== 'awaiting_model' || !state.provider_id || !state.agent_name) return true;
      const provider = await getProvider(state.provider_id);
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
      const provider = await getProvider(state.provider_id);
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
