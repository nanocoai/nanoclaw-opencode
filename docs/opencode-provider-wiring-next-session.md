# OpenCode Provider and Model Wiring: Next-Session Plan

Status: investigation complete; implementation intentionally deferred.

This document captures the next piece of work for making OpenCode a first-class
NanoClaw provider. The existing channel provisioning wizard works, but recent VM
testing showed that its provider, authentication, discovery, and runtime settings
do not yet form one reliable configuration contract.

## Why this needs another pass

The current implementation models an OpenCode selection as several loosely
related values. Setup writes global `OPENCODE_*` environment variables, while
channel-created groups persist only some per-group settings. At runtime, absent
per-group fields can inherit global values.

That produced a concrete invalid combination during VM testing:

- selected model: `opencode/mimo-v2.5-free`
- inherited provider: `openai`
- result: model not found

Other observed failures exposed adjacent gaps:

- ChatGPT/OpenAI OAuth data was treated as a generic bearer-header secret.
- A model listed by Models.dev returned an upstream 404 when invoked.
- A working free model emitted three replies before we selected a model that
  produced exactly one Mattermost response.
- Setup and channel provisioning could produce different runtime configurations
  for the same apparent provider/model choice.

The central conclusion is that discovery proves that a model is catalogued; it
does not prove that the selected authenticated connection can successfully run
that model with the configured transport.

## External design comparison

Hermes models a provider as a typed profile rather than a provider name alone.
Its provider profile owns authentication type, API transport, endpoint, model
discovery, credential resolution, defaults, and setup behavior. It distinguishes
configuring/authenticating a provider from switching among already configured
models.

OpenCode similarly separates credentials established through `/connect` from
provider configuration in `opencode.json`. Provider IDs, credentials, transport,
endpoint, and model references must remain coherent.

Useful primary references:

- [Hermes provider plugin architecture](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/model-provider-plugin.md)
- [Hermes provider setup flows](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/model_setup_flows.py)
- [Hermes model configuration](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/configuring-models.md)
- [Hermes provider and authentication documentation](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/integrations/providers.md)
- [OpenCode provider documentation](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/providers.mdx)

Company Brain's current provider-seam design reached the same architectural
conclusion: provider registration should own setup, validation, runtime
resolution, and diagnostics, while core should remain provider-neutral.

## Target design

Reusable OpenCode-specific behavior should remain owned by `add-opencode`. Core
should expose only the smallest generic provisioning seam needed to invoke a
provider-owned flow and atomically persist its versioned result.

### Connection

Introduce a typed OpenCode connection concept along these lines:

```ts
type OpenCodeConnection = {
  id: string;
  providerId: string;
  displayName: string;
  auth:
    | { kind: 'keyless' }
    | { kind: 'api_key'; credentialRef: string }
    | { kind: 'oauth'; credentialRef: string }
    | { kind: 'device_code'; credentialRef: string }
    | { kind: 'external_process'; command: string };
  transport: {
    apiMode:
      | 'chat_completions'
      | 'responses'
      | 'anthropic_messages'
      | 'bedrock_converse';
    baseUrl?: string;
    headersPolicy?: string;
  };
  discovery: {
    kind: 'models_dev' | 'models_endpoint' | 'curated' | 'provider_native';
    modelsUrl?: string;
  };
};
```

Authentication material must remain separate from ordinary configuration.
OneCLI integration should use an adapter appropriate to the declared auth kind;
it must not assume every credential is a bearer token.

### Per-group route

Persist a complete, atomic route for each explicitly configured group:

```ts
type OpenCodeRoute = {
  connectionId: string;
  providerId: string;
  modelId: string;
  modelRef: string;
  validatedAt?: string;
  configVersion: number;
};
```

Once this route exists, it must completely shadow instance defaults. It must not
be combined with unrelated global provider or model values.

Prefer generating an OpenCode-native per-group configuration from the resolved
route. Environment variables should be limited to credential handoff and
deliberate transient overrides, rather than acting as the primary configuration
contract.

### Provisioning sequence

The desired generic-channel flow is:

1. Choose an existing configured provider connection, or add one.
2. Complete the provider-specific authentication flow.
3. Discover models through that exact connection.
4. Choose a model.
5. Probe the exact provider, model, auth, endpoint, and transport tuple.
6. Show an explicit confirmation containing the fully resolved route.
7. Atomically create the group, persist the route, and wire the channel.
8. Start a fresh provider session.

The flow must remain restart-safe and work for every channel using generic
approval provisioning, not only Mattermost.

Discovered models should eventually expose readiness states such as `unverified`,
`ready`, `authentication_required`, and `unavailable`. Curated or Models.dev
fallbacks may support browsing, but must be labelled unverified until the exact
route passes its probe.

## Core boundary

The provider-neutral core should do only the following:

- locate and invoke the selected provider's provisioning hook;
- allow that hook to maintain restart-safe wizard state;
- atomically persist a versioned opaque provider result with group creation;
- create/wire or restart the session only after provisioning succeeds;
- avoid interpreting OpenCode provider IDs, auth modes, endpoints, or models.

Before defining a new hook, reconcile this work with the current provider-contract
proposal so NanoClaw does not grow a second overlapping provider seam.

## Implementation priorities

### P0: correctness

1. Define the typed connection and complete per-group route schemas, including a
   migration strategy for existing provider records and environment defaults.
2. Eliminate mixed global/per-group inheritance for explicitly configured groups.
3. Implement typed authentication adapters, especially keyless OpenCode and
   ChatGPT/OpenAI OAuth materialization through OneCLI.
4. Add a bounded readiness probe for the exact resolved route before final
   confirmation and creation.
5. Materialize an OpenCode-native runtime configuration from the resolved route.

### P1: operability and UX

1. Separate adding/authenticating a provider connection from selecting a model.
2. Display configured and ready connections first; keep the complete provider
   catalogue behind an explicit add-provider path.
3. Track validation status and actionable failure reasons.
4. Invalidate or restart provider sessions when their route changes.
5. Ensure confirmation shows provider, auth mode, transport, model, validation
   result, channel, and engagement pattern.

### P2: later enhancements

- Auxiliary/small model slots.
- Capability-aware selection and filtering.
- Deliberate fallback chains.

Do not implement fallback complexity before the single-route contract is sound.

## Required regression coverage

At minimum, tests should prove:

- a group with an explicit route cannot inherit a conflicting global provider;
- provider and model IDs cannot be persisted as an incoherent tuple;
- keyless connections send no placeholder or `Authorization` header;
- OAuth credentials are materialized using their typed adapter rather than as a
  generic bearer value;
- a catalogue-listed model that fails its live probe is not presented as ready;
- a successful probe uses the same endpoint, auth, headers, and transport as the
  runtime invocation;
- wizard state survives a process restart at every provider/model step;
- confirmation precedes group creation and wiring;
- every generic approval channel receives the same provisioning behavior;
- a channel-created agent runs the selected model after restart;
- route changes start a fresh provider session;
- a Mattermost input produces exactly one expected reply.

## Suggested next-session starting point

1. Re-read the Company Brain provider-seam contract and the colleague provider
   contract/PR in its latest form.
2. Inventory the current database schema, setup path, channel wizard, runtime
   overlay, OneCLI materialization, and OpenCode config generation against the
   target connection/route contract above.
3. Write the schema and core-boundary design before editing implementation code.
4. Add failing regression tests for mixed global inheritance and keyless auth.
5. Implement the smallest vertical slice: one keyless OpenCode connection, exact
   route validation, atomic group persistence, and successful generic-channel
   provisioning.

No implementation, merge, push, or PR action is part of this handoff.
