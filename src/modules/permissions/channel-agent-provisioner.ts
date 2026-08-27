import type { RawOption } from '../../channels/ask-question.js';
import type { InboundEvent } from '../../channels/adapter.js';
import type { ResponsePayload } from '../../response-registry.js';
import type { AgentGroup } from '../../types.js';
import type { PendingChannelApproval } from './db/pending-channel-approvals.js';

export interface ProvisionedAgentInput {
  name: string;
  provider: string;
  model: string;
  instructions?: string;
}

export interface ChannelAgentProvisioningContext {
  row: PendingChannelApproval;
  isApproverDm(event: InboundEvent): Promise<boolean>;
  deliverQuestion(title: string, question: string, options: RawOption[]): Promise<boolean>;
  deliverText(text: string): Promise<void>;
  createAgent(input: ProvisionedAgentInput): Promise<AgentGroup>;
  wireAgent(agentGroupId: string, approverId: string): Promise<boolean>;
  cancel(): Promise<void>;
}

/** Provider-owned continuation for the generic "Connect new agent" path. */
export interface ChannelAgentProvisioner {
  readonly provider: string;
  start(context: ChannelAgentProvisioningContext): Promise<void>;
  handleResponse(context: ChannelAgentProvisioningContext, payload: ResponsePayload): Promise<boolean>;
  pendingTextInputFor(approverUserId: string): Promise<string | undefined>;
  handleText(context: ChannelAgentProvisioningContext, event: InboundEvent, approverUserId: string): Promise<boolean>;
}

const provisioners = new Map<string, ChannelAgentProvisioner>();

export function registerChannelAgentProvisioner(provisioner: ChannelAgentProvisioner): void {
  const provider = provisioner.provider.trim().toLowerCase();
  if (!provider) throw new Error('Channel agent provisioner must declare a provider');
  if (provisioners.has(provider)) throw new Error(`Channel agent provisioner already registered: ${provider}`);
  provisioners.set(provider, provisioner);
}

export function getChannelAgentProvisioner(provider: string | null | undefined): ChannelAgentProvisioner | undefined {
  return provider ? provisioners.get(provider.toLowerCase()) : undefined;
}

export function getChannelAgentProvisioners(): readonly ChannelAgentProvisioner[] {
  return [...provisioners.values()];
}
