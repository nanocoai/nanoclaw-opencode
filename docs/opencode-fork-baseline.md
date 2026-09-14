# OpenCode fork development baseline

This fork's `main` reconciles the refreshed OpenCode setup stack at `24c7af0bda37f94fa387abe5fad29a9892800a86`,
upstream NanoClaw at `3f9ed607b7e7a4872747295f75286f1c377d7c33`, and the applicable
work preserved in the older fork and local development branches. The former
fork main `72a2c4537243f102b8d6e1b89a904f9f08243a83` and the earlier reconciliation
`67f0b5edaca627f4b7b35d886869c6c935fdd7c9` remain ancestors; their histories are not rewritten. The original refreshed delivery commits are also
retained as `archive/delivery-modes-before-reconcile`. This is a source development baseline, not a claim
that an existing instance has been upgraded or that every account and platform
has passed live acceptance.

## What is included

| Source | Disposition |
| --- | --- |
| Refreshed stack: `3c242b73`, `33c179a5`, `24c7af0b` | Current core prerequisites, OpenCode runtime/auth/model payload, setup registration and host assistance. The installed runtime explicitly implements contract seam v1; the host regression proves document and state mounts are realized exactly once through core. |
| Original reviewed stack: `ec3006c4`, `59ddbd81`, `436abf59` | Preserved in the refreshed branches' ancestry. |
| Fork `67f0b5ed` | Existing delivery modes, atomic channel wiring, migration safeguards and shared-registry CI resolution retained. The refreshed fork adds failure/cancellation parity without replacing its delivery accounting. |
| Upstream `3f9ed607` | Current shared setup, channel-copy, certificate staging, interactive-card and provider-picker repairs. |
| Delivery `d7cdb310`, `e1ea82da`, `a43da6f1`, `3bde925a` | Per-group delivery mode, tools-only enforcement, reply accounting and private provider diagnostics. Replaces the earlier fork delivery implementation. |
| Old fork `d96f546c` | Atomic channel wiring, sender admission and approval consumption carried forward. Empty-resume runtime behavior is covered by the current provider implementation and tests. |
| Local `4590760e` | Obsolete `src/opencode-dockerfile.test.ts` cleanup included in refresh and removal. |
| Older installed provider/channel snapshots | Preserved in old main's ancestry. Source now carries the provider in its skill payload; install selected channels and providers through their current skills. |
| Old channel wizard | Preserved in old main history. Its per-group `provider_settings` routing disagrees with the current instance-wide backend contract; the wizard is deferred. |
| Local `8211af2f` setup catalog experiment | Preserved as `archive/provider-discovery-2026-08-28`. Dynamic catalog UX remains a reference; its older instance endpoint, OAuth and arbitrary auth-header implementation is superseded by the reviewed credential boundary. |
| Earlier host framework and memory plugin candidates | Superseded by the existing setup hooks, host contract v1 and container-owned auth placeholders. |

This choice keeps one provider implementation to develop and test. Keeping both
the old installed tree and a newer payload would allow setup refresh to replace
a working implementation with a different one. Saved connections, atomic
per-group backend routing, arbitrary provider auth schemes and the old wizard
need a separate implementation decision; this reconciliation does not restore
them indirectly.

## Start or extend an instance

For a new development install, clone this fork and run `bash nanoclaw.sh`.
Choose the provider in setup. The provider skill builds a local image; OpenCode
requires that image rather than the published hardened image.

For an existing Claude instance whose core has been brought onto this baseline,
run from the instance checkout:

```bash
pnpm exec tsx setup/index.ts --step provider-auth opencode
```

This installs a missing OpenCode payload, builds its image and runs auth. The
standalone command preserves the default provider for new groups. Read
[the skill](../.claude/skills/add-opencode/SKILL.md) for credential grants and
service/container restart requirements. Use `--refresh` only when intentionally
updating an installed payload after preserving local edits.

Select a provider and delivery mode per group through the host CLI:

```bash
ncl groups config update --id <group-id> --provider opencode
ncl groups config update --id <group-id> --delivery-mode tools-only
ncl groups restart --id <group-id>
```

Claude groups can remain on `claude`. Backend/auth defaults for OpenCode are
instance-wide; model and reasoning effort have per-group overrides. OpenCode's
endpoint uses `OPENCODE_BASE_URL`, leaving Claude's `ANTHROPIC_BASE_URL` independent.

Delivery defaults to `envelope` when unset. `tools-only` requires explicit
messaging tools for channel delivery, corrects an undelivered chat turn once,
and sends a bounded failure notice if a reply still cannot be delivered.
Model scratchpad and raw provider diagnostics stay out of chat. Thrown failures
notify each still-unanswered address once; an already delivered reply is not
followed by a duplicate notice. A failed notice write does not mask the original
provider exception or stop notices to other addresses. If delivery state cannot
be read, the loop preserves the original exception for session recovery without
guessing which requests need notices. Explicit stop and slash-command cancellation
do not send provider failure notices. Existing
`tools-only` values retain their migration identity and survive materialization
and configuration backfill. Agents cannot change their own delivery mode.

## Upgrading an older experimental fork

**Detect before changing the checkout or restarting a service.** Record the exact
old commit, installed provider/channel modules, service identity and image. Use
the existing backup procedure to preserve the checkout's uncommitted changes,
`.env`, central/session databases, group directories and OneCLI state. Database
backups must be consistent; a filesystem copy of an active SQLite database alone
is insufficient.

Inspect the existing `container_configs` schema for `provider_settings`, and the
installed source for `src/modules/opencode-channel-provisioning`. If the column
exists, identify groups with nonempty settings locally. Do not publish those
settings: they can contain private endpoints. Preserve the column and its data.
A legacy group with a custom backend, auth mode or endpoint cannot be silently
restamped onto this baseline: the runtime reads the instance-wide OpenCode route.

**Why:** old main included installed payloads, Mattermost and an experimental
channel wizard. This main is a skill-based source baseline. The current provider
does not consume the wizard's `provider_settings` JSON. Merely retaining the
column does not retain that routing behavior.

**Fix:** prepare a separate retained checkout of the candidate, replay the desired
channel skills and `/add-opencode`, and reconcile the instance configuration.
Keep affected legacy groups on the old instance until their intended backend is
represented by the supported instance-wide route or a separately implemented
per-group route. Do not delete wizard tables, credential records or sessions.
Resolve or cancel pending wizard requests on the old instance before retiring
that workflow. Preserve local provider customizations before explicit refresh.

**Verify before switching the service:** check final image/provider registration,
credential grants and container-origin backend reachability. Then exercise a
Claude group and an OpenCode group, a real tool call, two-turn continuity, a
queued follow-up and a host restart. Confirm any existing tools-only groups
still use tools-only and their channels receive the replies. A build or a saved
credential is not sufficient evidence. Test source migration and behavioral
acceptance separately.

**Rollback:** retain the old checkout, image and consistent database/group backup.
Return the service to that checkout and its matching state if acceptance fails.
Do not run an old binary against a newer database merely because Git can move
backwards. This source reconciliation does not switch a service or alter live
credentials, databases or containers.

## Remaining acceptance limits

OpenCode CLI and SDK stay pinned to 1.18.25. The supported gateway remains OneCLI
1.41.0, whose ChatGPT token renewal limitation requires manual reauthentication.
Do not upgrade the gateway as an incidental fix: newer releases change credential
assignment APIs and need their own migration and acceptance.

Fresh-machine installation, current real-account login paths, anonymous native
Zen, all container drivers, ARM64/macOS behavior and sustained operation require
revision-specific live evidence. The source suites and native runtime fixtures
can validate their covered behavior without establishing those wider claims.
