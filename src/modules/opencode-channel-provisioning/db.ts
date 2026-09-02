import { getDb } from '../../db/connection.js';
import { isUniqueViolation } from '../../db/errors.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import type { OpenCodeModelProvider, OpenCodeProvisioningState, ProvisioningStep } from './types.js';

/**
 * The connection that mirrors the setup-selected .env backend. Owned by .env:
 * every host start re-asserts its values and `enabled = 1`, so `ncl
 * opencode-model-providers update/delete` refuse it (an operator edit would be
 * silently reverted on the next restart). Unsetting OPENCODE_PROVIDER disables
 * it; creating a separate connection is the way to keep a custom one.
 */
export const ENVIRONMENT_PROVIDER_ID = 'environment-default';
/** Display name, then the fallback used when an operator connection already holds it. */
const ENVIRONMENT_PROVIDER_NAMES = ['Environment default', 'Environment default (.env)'] as const;

export async function listProviders(): Promise<OpenCodeModelProvider[]> {
  return getDb().all<OpenCodeModelProvider>(
    'SELECT * FROM opencode_model_providers WHERE enabled = 1 ORDER BY name, id',
  );
}

/**
 * Keep the setup-selected .env backend available as a stored connection.
 * Runs from onHostStart, where a throw crash-loops the host — so a
 * UNIQUE(name) collision with an operator-created connection falls back to
 * the suffixed name, and if that is taken too, logs and leaves the rows alone.
 */
export async function syncEnvironmentProvider(values: {
  providerId: string;
  baseUrl?: string;
  contextLimit?: number;
  outputLimit?: number;
  inputModalities?: string;
}): Promise<void> {
  const now = new Date().toISOString();
  for (const name of ENVIRONMENT_PROVIDER_NAMES) {
    try {
      await getDb().run(
        `INSERT INTO opencode_model_providers
           (id, name, provider_id, discovery_type, base_url, models_url,
            context_limit, output_limit, input_modalities, instructions, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, 1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name, provider_id = excluded.provider_id,
           discovery_type = excluded.discovery_type, base_url = excluded.base_url,
           context_limit = excluded.context_limit, output_limit = excluded.output_limit,
           input_modalities = excluded.input_modalities, enabled = 1, updated_at = excluded.updated_at`,
        ENVIRONMENT_PROVIDER_ID,
        name,
        values.providerId,
        values.baseUrl ? 'openai-compatible' : 'models-dev',
        values.baseUrl ?? null,
        values.contextLimit ?? null,
        values.outputLimit ?? null,
        values.inputModalities ?? '',
        now,
        now,
      );
      return;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
  log.warn('OpenCode environment-default connection not synced — operator connections hold every name it can use', {
    names: ENVIRONMENT_PROVIDER_NAMES,
    hint: 'rename the operator connection with `ncl opencode-model-providers update --id <id> --name <new name>`',
  });
}

/** .env no longer selects an OpenCode backend: hide the mirror row from registration. */
export async function disableEnvironmentProvider(): Promise<void> {
  await getDb().run(
    'UPDATE opencode_model_providers SET enabled = 0, updated_at = ? WHERE id = ? AND enabled = 1',
    new Date().toISOString(),
    ENVIRONMENT_PROVIDER_ID,
  );
}

export async function getProvider(id: string): Promise<OpenCodeModelProvider | undefined> {
  return getDb().get<OpenCodeModelProvider>('SELECT * FROM opencode_model_providers WHERE id = ? AND enabled = 1', id);
}

export async function getState(messagingGroupId: string): Promise<OpenCodeProvisioningState | undefined> {
  return getDb().get<OpenCodeProvisioningState>(
    'SELECT * FROM opencode_channel_provisioning WHERE messaging_group_id = ?',
    messagingGroupId,
  );
}

export async function pendingTextInputFor(approverUserId: string): Promise<string | undefined> {
  const row = await getDb().get<{ messaging_group_id: string }>(
    `SELECT messaging_group_id FROM opencode_channel_provisioning
      WHERE approver_user_id = ? AND (
        step IN ('awaiting_name', 'awaiting_model_query')
        OR (step = 'awaiting_provider' AND provider_id IN (
          '__catalog_search__', '__catalog_search_explicit__', '__inline_local_url__'
        ))
      )
      ORDER BY created_at, messaging_group_id LIMIT 1`,
    approverUserId,
  );
  return row?.messaging_group_id;
}

export async function beginState(messagingGroupId: string, approverUserId: string): Promise<void> {
  const now = new Date().toISOString();
  await getDb().run(
    `INSERT INTO opencode_channel_provisioning
       (messaging_group_id, approver_user_id, step, agent_name, provider_id, model_id, created_at, updated_at)
     VALUES (?, ?, 'awaiting_name', NULL, NULL, NULL, ?, ?)
     ON CONFLICT (messaging_group_id) DO UPDATE SET
       approver_user_id = excluded.approver_user_id, step = 'awaiting_name',
       agent_name = NULL, provider_id = NULL, model_id = NULL, updated_at = excluded.updated_at`,
    messagingGroupId,
    approverUserId,
    now,
    now,
  );
}

export async function updateState(
  messagingGroupId: string,
  values: { step: ProvisioningStep; agentName?: string | null; providerId?: string | null; modelId?: string | null },
): Promise<void> {
  await getDb().run(
    `UPDATE opencode_channel_provisioning SET
       step = ?, agent_name = COALESCE(?, agent_name), provider_id = COALESCE(?, provider_id),
       model_id = ?, updated_at = ? WHERE messaging_group_id = ?`,
    values.step,
    values.agentName ?? null,
    values.providerId ?? null,
    values.modelId ?? null,
    new Date().toISOString(),
    messagingGroupId,
  );
}

export async function deleteState(messagingGroupId: string): Promise<void> {
  await getDb().run('DELETE FROM opencode_channel_provisioning WHERE messaging_group_id = ?', messagingGroupId);
}

export async function persistProviderSettings(
  agentGroupId: string,
  provider: OpenCodeModelProvider,
  model: { id: string; contextLimit: number | null; outputLimit: number | null; inputModalities: string },
): Promise<void> {
  const env = readEnvFile(['OPENCODE_AUTH_MODE']);
  const authMode =
    provider.id === ENVIRONMENT_PROVIDER_ID
      ? (process.env.OPENCODE_AUTH_MODE ?? env.OPENCODE_AUTH_MODE)?.trim() || undefined
      : undefined;
  await getDb().run(
    'UPDATE container_configs SET provider_settings = ?, updated_at = ? WHERE agent_group_id = ?',
    JSON.stringify({
      opencode: {
        authMode,
        modelProvider: provider.provider_id,
        baseUrl: provider.base_url,
        smallModel: model.id,
        contextLimit: model.contextLimit,
        outputLimit: model.outputLimit,
        inputModalities: model.inputModalities,
      },
    }),
    new Date().toISOString(),
    agentGroupId,
  );
}
