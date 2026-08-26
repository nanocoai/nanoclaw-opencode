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
  created_at: string;
  updated_at: string;
}
