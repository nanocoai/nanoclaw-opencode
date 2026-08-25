import { describe, expect, it } from 'vitest';

import './index.js';
import { getSetupProvider } from './registry.js';

describe('OpenCode setup registration', () => {
  it('registers through the real setup provider barrel', () => {
    expect(getSetupProvider('opencode')).toMatchObject({ value: 'opencode', label: 'OpenCode' });
  });
});
