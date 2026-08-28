export interface OpenCodeModelProvider {
  id: string;
  name: string;
  provider_id: string;
  discovery_type: 'models-dev' | 'openai-compatible';
  base_url: string | null;
  models_url: string | null;
  context_limit: number | null;
  output_limit: number | null;
  input_modalities: string;
  instructions: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface DiscoveredOpenCodeModel {
  id: string;
  name: string;
  contextLimit: number | null;
  outputLimit: number | null;
  inputModalities: string;
}

export interface DiscoveredOpenCodeProvider {
  id: string;
  name: string;
}

export type OpenCodeAuthentication =
  | { kind: 'keyless' }
  | {
      kind: 'api_key';
      credentialRef: string;
      injection:
        | { kind: 'http_header'; name: string; format: 'bearer' | 'raw' }
        | { kind: 'provider_native' };
    }
  | {
      kind: 'chatgpt_oauth';
      credentialRef: string;
      accountId?: string;
      materializer: 'opencode_openai_auth_v1';
    };

export type OpenCodeTransport =
  | { kind: 'openai_compatible'; apiMode: 'chat_completions' | 'responses'; baseUrl: string }
  | { kind: 'opencode_native'; providerId: string; baseUrl?: string };

export type OpenCodeDiscovery =
  | { kind: 'models_dev'; providerId: string }
  | { kind: 'models_endpoint'; url: string }
  | { kind: 'curated'; catalogueId: string }
  | { kind: 'provider_native' };

export interface OpenCodeConnectionV1 {
  schemaVersion: 1;
  id: string;
  displayName: string;
  providerId: string;
  auth: OpenCodeAuthentication;
  transport: OpenCodeTransport;
  discovery: OpenCodeDiscovery;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type OpenCodeReadiness =
  | { state: 'unverified' }
  | { state: 'ready'; probedAt: string; probeRevision: string }
  | {
      state: 'authentication_required' | 'unavailable';
      checkedAt: string;
      diagnosticCode: string;
    };

/**
 * A complete group-owned route. Runtime code must treat the presence of this
 * object as an all-or-nothing shadow over service-level OPENCODE_* defaults.
 */
export interface OpenCodeRouteV1 {
  schemaVersion: 1;
  connectionId: string;
  providerId: string;
  modelId: string;
  modelRef: string;
  transport: OpenCodeTransport;
  auth: OpenCodeAuthentication;
  limits?: { context?: number; output?: number };
  inputModalities?: Array<'text' | 'image' | 'audio' | 'video' | 'pdf'>;
  readiness: OpenCodeReadiness;
}

export type ProvisioningStep =
  | 'awaiting_name'
  | 'awaiting_provider'
  | 'awaiting_model_query'
  | 'awaiting_model'
  | 'awaiting_confirmation';

export interface OpenCodeProvisioningState {
  messaging_group_id: string;
  approver_user_id: string;
  step: ProvisioningStep;
  agent_name: string | null;
  provider_id: string | null;
  model_id: string | null;
  agent_group_id: string | null;
  created_at: string;
  updated_at: string;
}
