/**
 * Integration test for the opencode provider's HOST-side reach-in: the self-registration
 * import in the src/providers/index.ts barrel. Importing the barrel runs opencode.ts's
 * top-level registerProviderContainerConfig('opencode', …); without that import line the
 * host never wires the provider's per-session mounts / env passthrough.
 *
 * Behavior, not structural, and BARREL-ONLY: it imports the real barrel (./index.js),
 * never ./opencode.js directly, then asserts the registry actually contains the provider.
 * Importing the provider module directly (as opencode.factory.test.ts does) self-registers
 * it and would stay GREEN even if the barrel line were deleted — that is a unit test,
 * not a registration guard. This test goes red if the barrel import is deleted/drifts,
 * or the barrel fails to evaluate.
 *
 * A provider is a MULTI-POINT integration: this guards the HOST barrel; the CONTAINER
 * barrel is guarded by the sibling bun test; the SDK/CLI dependency + Dockerfile install
 * are guarded by the build/container legs (see the skill's validate step).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect } from 'vitest';

import { getProviderContainerConfig, listProviderContainerConfigNames } from './provider-container-registry.js';
import './index.js'; // the real host provider barrel — triggers each provider's self-registration

describe('opencode provider host registration', () => {
  it('registers opencode host container-config via the barrel', () => {
    expect(listProviderContainerConfigNames()).toContain('opencode');
  });

  it('turns the group-selected model and provider settings into per-container env', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-opencode-registration-'));
    try {
      const contribution = await getProviderContainerConfig('opencode')!({
        sessionDir: root,
        agentGroupId: 'selected-group',
        groupDir: root,
        selectedSkills: [],
        model: 'openai/selected-live-model',
        providerSettings: {
          opencode: {
            modelProvider: 'openai',
            baseUrl: 'http://host.docker.internal:8891/v1',
            contextLimit: 65536,
          },
        },
        hostEnv: {
          OPENCODE_MODEL: 'openai/global-default',
          OPENCODE_NATIVE_ATTACHMENT_MAX_COUNT: '4',
          OPENCODE_NATIVE_ATTACHMENT_MAX_BYTES: '10485760',
        },
      });
      expect(contribution.env).toMatchObject({
        OPENCODE_MODEL: 'openai/selected-live-model',
        OPENCODE_PROVIDER: 'openai',
        ANTHROPIC_BASE_URL: 'http://host.docker.internal:8891/v1',
        OPENCODE_MODEL_CONTEXT_LIMIT: '65536',
        OPENCODE_NATIVE_ATTACHMENT_MAX_COUNT: '4',
        OPENCODE_NATIVE_ATTACHMENT_MAX_BYTES: '10485760',
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('clears inherited local endpoint defaults for a selected cloud provider', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-opencode-cloud-registration-'));
    try {
      const contribution = await getProviderContainerConfig('opencode')!({
        sessionDir: root,
        agentGroupId: 'cloud-group',
        groupDir: root,
        selectedSkills: [],
        model: 'openrouter/provider/model',
        providerSettings: {
          opencode: {
            modelProvider: 'openrouter',
            baseUrl: null,
            smallModel: 'openrouter/provider/model',
            contextLimit: null,
            outputLimit: null,
            inputModalities: '',
          },
        },
        hostEnv: {
          ANTHROPIC_BASE_URL: 'http://host.docker.internal:8891/v1',
          OPENCODE_MODEL_CONTEXT_LIMIT: '65536',
          OPENCODE_MODEL_OUTPUT_LIMIT: '8192',
        },
      });
      expect(contribution.env).toMatchObject({
        OPENCODE_MODEL: 'openrouter/provider/model',
        OPENCODE_PROVIDER: 'openrouter',
      });
      expect(contribution.env?.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(contribution.env?.OPENCODE_MODEL_CONTEXT_LIMIT).toBeUndefined();
      expect(contribution.env?.OPENCODE_MODEL_OUTPUT_LIMIT).toBeUndefined();
      expect(contribution.env?.OPENCODE_MODEL_INPUT_MODALITIES).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
