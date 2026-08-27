import { describe, expect, it } from 'vitest';
import {
  getChannelAgentProvisioner,
  registerChannelAgentProvisioner,
  type ChannelAgentProvisioner,
} from './channel-agent-provisioner.js';

function fixture(provider: string): ChannelAgentProvisioner {
  return {
    provider,
    start: async () => {},
    handleResponse: async () => false,
    pendingTextInputFor: async () => undefined,
    handleText: async () => false,
  };
}

describe('channel agent provisioner registry', () => {
  it('resolves a provider-specific continuation without coupling core to it', () => {
    const provider = `fixture-${Date.now()}`;
    const provisioner = fixture(provider);
    registerChannelAgentProvisioner(provisioner);
    expect(getChannelAgentProvisioner(provider.toUpperCase())).toBe(provisioner);
    expect(getChannelAgentProvisioner('not-installed')).toBeUndefined();
  });

  it('rejects duplicate registrations', () => {
    const provider = `duplicate-${Date.now()}`;
    registerChannelAgentProvisioner(fixture(provider));
    expect(() => registerChannelAgentProvisioner(fixture(provider))).toThrow(/already registered/);
  });
});
