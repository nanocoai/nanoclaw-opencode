import { registerResource } from '../../cli/crud.js';

function text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const result = String(value).trim();
  return result || undefined;
}

function url(value: unknown, field: string): string | null {
  const valueText = text(value);
  if (!valueText) return null;
  const parsed = new URL(valueText);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`${field} must be an HTTP(S) URL`);
  return parsed.toString().replace(/\/$/, '');
}

function validate(values: Record<string, unknown>): void {
  values.name = text(values.name);
  values.provider_id = text(values.provider_id)?.toLowerCase();
  if (!values.name) throw new Error('name must not be blank');
  if (!values.provider_id) throw new Error('provider_id must not be blank');
  const discovery = text(values.discovery_type) ?? 'models-dev';
  if (discovery !== 'models-dev' && discovery !== 'openai-compatible') {
    throw new Error('discovery_type must be models-dev or openai-compatible');
  }
  values.discovery_type = discovery;
  values.base_url = url(values.base_url, 'base_url');
  values.models_url = url(values.models_url, 'models_url');
  if (discovery === 'openai-compatible' && !values.base_url && !values.models_url) {
    throw new Error('openai-compatible discovery requires base_url or models_url');
  }
  for (const field of ['context_limit', 'output_limit']) {
    if (values[field] === undefined || values[field] === null || values[field] === '') values[field] = null;
    else {
      const number = Number(values[field]);
      if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${field} must be a positive integer`);
      values[field] = number;
    }
  }
  values.input_modalities = text(values.input_modalities) ?? '';
  values.instructions = text(values.instructions) ?? null;
  values.enabled = Number(values.enabled ?? 1);
  if (values.enabled !== 0 && values.enabled !== 1) throw new Error('enabled must be 0 or 1');
}

registerResource({
  name: 'OpenCode model provider',
  plural: 'opencode-model-providers',
  table: 'opencode_model_providers',
  description: 'Credential-free OpenCode connections used for live model discovery during channel registration.',
  idColumn: 'id',
  columns: [
    { name: 'id', type: 'string', description: 'Generated connection ID.', generated: true },
    { name: 'name', type: 'string', description: 'Name shown during registration.', required: true, updatable: true },
    { name: 'provider_id', type: 'string', description: 'OpenCode provider ID.', required: true, updatable: true },
    {
      name: 'discovery_type',
      type: 'string',
      description: 'Discovery protocol.',
      enum: ['models-dev', 'openai-compatible'],
      default: 'models-dev',
      updatable: true,
    },
    { name: 'base_url', type: 'string', description: 'Optional API base URL.', updatable: true },
    { name: 'models_url', type: 'string', description: 'Optional explicit /models URL.', updatable: true },
    { name: 'context_limit', type: 'number', description: 'Fallback context limit.', updatable: true },
    { name: 'output_limit', type: 'number', description: 'Fallback output limit.', updatable: true },
    {
      name: 'input_modalities',
      type: 'string',
      description: 'Fallback input modalities.',
      default: '',
      updatable: true,
    },
    { name: 'instructions', type: 'string', description: 'Optional initial instructions.', updatable: true },
    {
      name: 'enabled',
      type: 'number',
      description: 'Whether registration offers this connection.',
      default: 1,
      updatable: true,
    },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
    { name: 'updated_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  operations: { list: 'open', get: 'open', create: 'approval', update: 'approval', delete: 'approval' },
  naturalKey: ['name'],
  resolveDefaults: validate,
  preUpdate: (updates, current) => {
    const merged = { ...current, ...updates };
    validate(merged);
    for (const key of Object.keys(updates)) updates[key] = merged[key];
    updates.updated_at = new Date().toISOString();
  },
});
