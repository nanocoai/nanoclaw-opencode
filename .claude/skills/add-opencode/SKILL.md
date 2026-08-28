---
name: add-opencode
description: Install OpenCode as a NanoClaw agent provider, including host/container runtime code, setup integration, exact CLI/SDK pins, and OpenAI-compatible backend configuration.
---

# OpenCode agent provider

Install OpenCode from the payload carried by this skill. The skill is the
canonical source: it does not fetch or merge the historical `providers` branch.
Re-running the install refreshes every skill-owned file and pin.

## Install

### 1. Copy the provider payload

```nc:copy
payload/src/providers/opencode.ts -> src/providers/opencode.ts
payload/src/providers/opencode-registration.test.ts -> src/providers/opencode-registration.test.ts
payload/src/modules/opencode-channel-provisioning/index.ts -> src/modules/opencode-channel-provisioning/index.ts
payload/src/modules/opencode-channel-provisioning/types.ts -> src/modules/opencode-channel-provisioning/types.ts
payload/src/modules/opencode-channel-provisioning/db.ts -> src/modules/opencode-channel-provisioning/db.ts
payload/src/modules/opencode-channel-provisioning/migration.ts -> src/modules/opencode-channel-provisioning/migration.ts
payload/src/modules/opencode-channel-provisioning/model-discovery.ts -> src/modules/opencode-channel-provisioning/model-discovery.ts
payload/src/modules/opencode-channel-provisioning/readiness-probe.ts -> src/modules/opencode-channel-provisioning/readiness-probe.ts
payload/src/modules/opencode-channel-provisioning/readiness-probe.test.ts -> src/modules/opencode-channel-provisioning/readiness-probe.test.ts
payload/src/modules/opencode-channel-provisioning/cli-resource.ts -> src/modules/opencode-channel-provisioning/cli-resource.ts
payload/src/modules/opencode-channel-provisioning/model-discovery.test.ts -> src/modules/opencode-channel-provisioning/model-discovery.test.ts
payload/src/modules/opencode-channel-provisioning/provisioning.test.ts -> src/modules/opencode-channel-provisioning/provisioning.test.ts
payload/container/agent-runner/src/providers/mcp-to-opencode.ts -> container/agent-runner/src/providers/mcp-to-opencode.ts
payload/container/agent-runner/src/providers/mcp-to-opencode.test.ts -> container/agent-runner/src/providers/mcp-to-opencode.test.ts
payload/container/agent-runner/src/providers/opencode.ts -> container/agent-runner/src/providers/opencode.ts
payload/container/agent-runner/src/providers/opencode-registration.test.ts -> container/agent-runner/src/providers/opencode-registration.test.ts
payload/container/agent-runner/src/providers/opencode.attachments.test.ts -> container/agent-runner/src/providers/opencode.attachments.test.ts
payload/container/agent-runner/src/providers/opencode.compaction.test.ts -> container/agent-runner/src/providers/opencode.compaction.test.ts
payload/container/agent-runner/src/providers/opencode.config.test.ts -> container/agent-runner/src/providers/opencode.config.test.ts
payload/container/agent-runner/src/providers/opencode.empty-resume.test.ts -> container/agent-runner/src/providers/opencode.empty-resume.test.ts
payload/container/agent-runner/src/providers/opencode.factory.test.ts -> container/agent-runner/src/providers/opencode.factory.test.ts
payload/container/agent-runner/src/providers/opencode.memory.test.ts -> container/agent-runner/src/providers/opencode.memory.test.ts
payload/container/agent-runner/src/providers/opencode.question.test.ts -> container/agent-runner/src/providers/opencode.question.test.ts
payload/setup/providers/opencode.ts -> setup/providers/opencode.ts
payload/setup/providers/opencode.test.ts -> setup/providers/opencode.test.ts
payload/setup/providers/opencode-registration.test.ts -> setup/providers/opencode-registration.test.ts
payload/opencode-cli-tools.test.ts -> src/opencode-cli-tools.test.ts
```

`cwd-shim.ts` remains core-owned because built-in providers use it too.

### 2. Register all three provider surfaces

```nc:append to:src/providers/index.ts
import './opencode.js';
```

```nc:append to:src/modules/index.ts
import './opencode-channel-provisioning/index.js';
```

```nc:append to:container/agent-runner/src/providers/index.ts
import './opencode.js';
```

```nc:append to:setup/providers/index.ts
import './opencode.js';
```

### 3. Install the matched runtime

The CLI and SDK are one tested pair. OpenCode's package requires its trusted
postinstall so the platform binary is present in the image.

```nc:dep manager:bun cwd:container/agent-runner
@opencode-ai/sdk@1.18.21
```

```nc:json-merge into:container/cli-tools.json key:name
{ "name": "opencode-ai", "version": "1.18.21", "onlyBuilt": true }
```

### 4. Build and validate

```nc:run effect:build
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
```

```nc:run effect:test
pnpm exec vitest run src/providers/opencode-registration.test.ts src/modules/opencode-channel-provisioning/model-discovery.test.ts src/modules/opencode-channel-provisioning/readiness-probe.test.ts src/modules/opencode-channel-provisioning/provisioning.test.ts src/opencode-cli-tools.test.ts setup/providers/opencode.test.ts setup/providers/opencode-registration.test.ts
cd container/agent-runner && bun test src/providers/opencode-registration.test.ts src/providers/opencode.config.test.ts src/providers/opencode.empty-resume.test.ts src/providers/opencode.memory.test.ts
```

```nc:run effect:build
./container/build.sh
```

### 5. Configure and authenticate

```nc:run effect:external
pnpm exec tsx setup/index.ts --step provider-auth opencode
```

The setup module offers ChatGPT Plus/Pro through OpenCode's native browser or
device-pairing flow, local/self-hosted OpenAI-compatible endpoints, OpenRouter,
DeepSeek, and a custom provider. ChatGPT login runs in the pinned agent image
with an isolated temporary XDG directory. The live OAuth record is moved into
OneCLI, the temporary directory is deleted, and runtime receives only a
read-only `onecli-managed` stub. API keys are stored in OneCLI; `.env` contains
only provider, model, typed auth mode, and optional base-URL configuration.
On the next host start, the OpenCode module mirrors that non-secret backend
configuration into an `Environment default` model-provider connection. Extra
connections can be managed with `ncl opencode-model-providers`.

## Use it

```bash
ncl groups config update --id <group-id> --provider opencode
ncl groups restart --id <group-id>
```

Every provider reads the same group memory tree, so switching providers does
not require a memory migration. `/migrate-memory` is only for legacy formats.

When an unknown channel chooses **Connect new agent** and OpenCode is the
instance default, the shared channel flow delegates to this skill. It asks for
the name, then offers configured connections and common recommended providers
first. The complete paginated live OpenCode provider catalog remains available
behind **More providers…**, with optional search, alongside an inline local/custom endpoint path. It discovers models
live and presents them as a paginated list; model search is an optional fallback,
not a required step. It requires explicit confirmation, then stores the chosen
model and provider settings on that new group before the first container starts. Catalog providers
expect their credentials to be available through OneCLI; secrets never enter
the wizard state. The durable wizard row survives host restarts and works
through every channel adapter using the generic approval flow.

OpenCode runs in `/workspace/agent`, explicitly reads the composed
`CLAUDE.md`, and keeps its SDK client scoped to that same directory. Session
state is isolated per NanoClaw session under `opencode-xdg`.

Host-staged image/PDF attachments travel through NanoClaw's message-bound
provider seam on both opening prompts and follow-up pushes. OpenCode rechecks
that each file is a regular file inside the source message's inbox before
creating a native file part. Native media defaults to at most 8 files and 25
MiB total per prompt; `OPENCODE_NATIVE_ATTACHMENT_MAX_COUNT` and
`OPENCODE_NATIVE_ATTACHMENT_MAX_BYTES` override those positive-integer limits.
Rejected, remote-only, or unsupported attachments remain described in prompt
text and are never fetched implicitly.

## Troubleshooting

- `Unknown provider: opencode`: re-run this skill; a barrel import is missing.
- `spawn opencode ENOENT`: rebuild the image after applying the skill.
- Custom endpoint fails after the first turn: include `/v1` and use provider `openai`.
- Version mismatch: reapply the skill so CLI and SDK both return to 1.18.21.

To uninstall the provider, follow [REMOVE.md](REMOVE.md).
