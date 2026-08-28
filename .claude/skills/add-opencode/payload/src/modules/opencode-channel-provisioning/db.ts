import { getDb } from '../../db/connection.js';
import type {
  OpenCodeAuthentication,
  OpenCodeConnectionV1,
  OpenCodeModelProvider,
  OpenCodeProvisioningState,
  OpenCodeRouteV1,
  ProvisioningStep,
} from './types.js';

interface ConnectionRow {
  id: string;
  schema_version: number;
  display_name: string;
  provider_id: string;
  auth_json: string;
  transport_json: string;
  discovery_json: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function connectionFromRow(row: ConnectionRow): OpenCodeConnectionV1 {
  if (row.schema_version !== 1) throw new Error(`Unsupported OpenCode connection schema ${row.schema_version}`);
  return {
    schemaVersion: 1,
    id: row.id,
    displayName: row.display_name,
    providerId: row.provider_id,
    auth: JSON.parse(row.auth_json) as OpenCodeConnectionV1['auth'],
    transport: JSON.parse(row.transport_json) as OpenCodeConnectionV1['transport'],
    discovery: JSON.parse(row.discovery_json) as OpenCodeConnectionV1['discovery'],
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getConnection(id: string): Promise<OpenCodeConnectionV1 | undefined> {
  const row = await getDb().get<ConnectionRow>('SELECT * FROM opencode_connections WHERE id = ? AND enabled = 1', id);
  return row ? connectionFromRow(row) : undefined;
}

/** Adopt a v1 catalogue/provider row into the typed connection store. */
export async function ensureConnection(provider: OpenCodeModelProvider): Promise<OpenCodeConnectionV1> {
  const existing = await getConnection(provider.id);
  if (existing) return existing;
  const now = new Date().toISOString();
  const keyless = Boolean(provider.base_url) || provider.provider_id === 'opencode' || provider.provider_id === 'ollama';
  const connection: OpenCodeConnectionV1 = {
    schemaVersion: 1,
    id: provider.id,
    displayName: provider.name,
    providerId: provider.provider_id,
    auth: keyless
      ? { kind: 'keyless' }
      : {
          kind: 'api_key',
          credentialRef: `onecli:auto:${provider.provider_id}`,
          injection: { kind: 'provider_native' },
        },
    transport: provider.base_url
      ? { kind: 'openai_compatible', apiMode: 'chat_completions', baseUrl: provider.base_url }
      : { kind: 'opencode_native', providerId: provider.provider_id },
    discovery:
      provider.discovery_type === 'openai-compatible'
        ? { kind: 'models_endpoint', url: provider.models_url ?? `${provider.base_url!.replace(/\/$/, '')}/models` }
        : { kind: 'models_dev', providerId: provider.provider_id },
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
  await upsertConnection(connection);
  return connection;
}

export async function upsertConnection(connection: OpenCodeConnectionV1): Promise<void> {
  await getDb().run(
    `INSERT INTO opencode_connections
       (id, schema_version, display_name, provider_id, auth_json, transport_json,
        discovery_json, enabled, created_at, updated_at)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       display_name = excluded.display_name, provider_id = excluded.provider_id,
       auth_json = excluded.auth_json, transport_json = excluded.transport_json,
       discovery_json = excluded.discovery_json, enabled = excluded.enabled,
       updated_at = excluded.updated_at`,
    connection.id,
    connection.displayName,
    connection.providerId,
    JSON.stringify(connection.auth),
    JSON.stringify(connection.transport),
    JSON.stringify(connection.discovery),
    connection.enabled ? 1 : 0,
    connection.createdAt,
    connection.updatedAt,
  );
}

export async function listProviders(): Promise<OpenCodeModelProvider[]> {
  return getDb().all<OpenCodeModelProvider>(
    'SELECT * FROM opencode_model_providers WHERE enabled = 1 ORDER BY name, id',
  );
}

/** Keep the setup-selected .env backend available as a stored connection. */
export async function syncEnvironmentProvider(values: {
  providerId: string;
  baseUrl?: string;
  auth?: OpenCodeAuthentication;
  contextLimit?: number;
  outputLimit?: number;
  inputModalities?: string;
}): Promise<void> {
  const now = new Date().toISOString();
  await getDb().run(
    `INSERT INTO opencode_model_providers
       (id, name, provider_id, discovery_type, base_url, models_url,
        context_limit, output_limit, input_modalities, instructions, enabled, created_at, updated_at)
     VALUES ('environment-default', ?, ?, ?, ?, NULL, ?, ?, ?, NULL, 1, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       name = excluded.name, provider_id = excluded.provider_id,
       discovery_type = excluded.discovery_type, base_url = excluded.base_url,
       context_limit = excluded.context_limit, output_limit = excluded.output_limit,
       input_modalities = excluded.input_modalities, enabled = 1, updated_at = excluded.updated_at`,
    'Environment default',
    values.providerId,
    values.baseUrl ? 'openai-compatible' : 'models-dev',
    values.baseUrl ?? null,
    values.contextLimit ?? null,
    values.outputLimit ?? null,
    values.inputModalities ?? '',
    now,
    now,
  );
  await upsertConnection({
    schemaVersion: 1,
    id: 'environment-default',
    displayName: 'Environment default',
    providerId: values.providerId,
    auth: values.auth ?? { kind: 'keyless' },
    transport: values.baseUrl
      ? { kind: 'openai_compatible', apiMode: 'chat_completions', baseUrl: values.baseUrl }
      : { kind: 'opencode_native', providerId: values.providerId },
    discovery: values.baseUrl
      ? { kind: 'models_endpoint', url: `${values.baseUrl.replace(/\/$/, '')}/models` }
      : { kind: 'models_dev', providerId: values.providerId },
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
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
       agent_name = NULL, provider_id = NULL, model_id = NULL, agent_group_id = NULL,
       updated_at = excluded.updated_at`,
    messagingGroupId,
    approverUserId,
    now,
    now,
  );
}

export async function updateState(
  messagingGroupId: string,
  values: {
    step: ProvisioningStep;
    agentName?: string | null;
    providerId?: string | null;
    modelId?: string | null;
    agentGroupId?: string | null;
  },
): Promise<void> {
  await getDb().run(
    `UPDATE opencode_channel_provisioning SET
       step = ?, agent_name = COALESCE(?, agent_name), provider_id = COALESCE(?, provider_id),
       model_id = ?, agent_group_id = COALESCE(?, agent_group_id), updated_at = ? WHERE messaging_group_id = ?`,
    values.step,
    values.agentName ?? null,
    values.providerId ?? null,
    values.modelId ?? null,
    values.agentGroupId ?? null,
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
): Promise<OpenCodeRouteV1> {
  const connection = await ensureConnection(provider);
  if (model.id.split('/')[0] !== connection.providerId) {
    throw new Error(`OpenCode model ${model.id} does not belong to provider ${connection.providerId}`);
  }
  const route: OpenCodeRouteV1 = {
    schemaVersion: 1,
    connectionId: connection.id,
    providerId: connection.providerId,
    modelId: model.id.slice(connection.providerId.length + 1),
    modelRef: model.id,
    transport: connection.transport,
    auth: connection.auth,
    ...(model.contextLimit || model.outputLimit
      ? { limits: { context: model.contextLimit ?? undefined, output: model.outputLimit ?? undefined } }
      : {}),
    inputModalities: model.inputModalities
      .split(',')
      .filter((value): value is NonNullable<OpenCodeRouteV1['inputModalities']>[number] =>
        ['text', 'image', 'audio', 'video', 'pdf'].includes(value),
      ),
    readiness: { state: 'unverified' },
  };
  const now = new Date().toISOString();
  await getDb().run(
    `INSERT INTO opencode_group_routes
       (agent_group_id, schema_version, connection_id, route_json, created_at, updated_at)
     VALUES (?, 1, ?, ?, ?, ?)
     ON CONFLICT (agent_group_id) DO UPDATE SET connection_id = excluded.connection_id,
       route_json = excluded.route_json, updated_at = excluded.updated_at`,
    agentGroupId,
    connection.id,
    JSON.stringify(route),
    now,
    now,
  );
  await getDb().run(
    'UPDATE container_configs SET provider_settings = ?, updated_at = ? WHERE agent_group_id = ?',
    JSON.stringify({
      opencode: {
        route,
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
  return route;
}

export async function markRouteReady(
  agentGroupId: string,
  route: OpenCodeRouteV1,
  result: { probedAt: string; probeRevision: string },
): Promise<OpenCodeRouteV1> {
  const ready: OpenCodeRouteV1 = { ...route, readiness: { state: 'ready', ...result } };
  const now = new Date().toISOString();
  await getDb().transaction(async () => {
    await getDb().run(
      'UPDATE opencode_group_routes SET route_json = ?, updated_at = ? WHERE agent_group_id = ?',
      JSON.stringify(ready),
      now,
      agentGroupId,
    );
    const config = await getDb().get<{ provider_settings: string }>(
      'SELECT provider_settings FROM container_configs WHERE agent_group_id = ?',
      agentGroupId,
    );
    const settings = config?.provider_settings ? (JSON.parse(config.provider_settings) as Record<string, unknown>) : {};
    const opencode =
      settings.opencode && typeof settings.opencode === 'object'
        ? (settings.opencode as Record<string, unknown>)
        : {};
    settings.opencode = { ...opencode, route: ready };
    await getDb().run(
      'UPDATE container_configs SET provider_settings = ?, updated_at = ? WHERE agent_group_id = ?',
      JSON.stringify(settings),
      now,
      agentGroupId,
    );
  });
  return ready;
}
