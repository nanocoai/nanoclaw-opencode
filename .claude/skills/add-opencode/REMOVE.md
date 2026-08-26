# Remove OpenCode provider

This reverses every persistent change made by `/add-opencode`.

1. Delete `import './opencode.js';` from `src/providers/index.ts`,
   `container/agent-runner/src/providers/index.ts`, and
   `setup/providers/index.ts`. Delete
   `import './opencode-channel-provisioning/index.js';` from
   `src/modules/index.ts`.
2. Delete `src/providers/opencode.ts`, its registration test,
   `src/opencode-cli-tools.test.ts`, the three `setup/providers/opencode*`
   files, `mcp-to-opencode*`, and every copied `opencode*.ts` file under the
   container provider directory. Delete
   `src/modules/opencode-channel-provisioning/`.
3. From `container/agent-runner`, run `bun remove @opencode-ai/sdk`.
4. Delete the `opencode-ai` object from `container/cli-tools.json`.
5. Remove OpenCode-only `.env` keys when unused: `OPENCODE_PROVIDER`,
   `OPENCODE_MODEL`, `OPENCODE_SMALL_MODEL`, the three
   `OPENCODE_MODEL_*` capability/limit keys, and `ANTHROPIC_BASE_URL`.
6. Switch every OpenCode group to an installed provider before rebuilding:

   ```bash
   ncl groups config update --id <group-id> --provider claude
   ```

7. Rebuild the project and image, then restart NanoClaw.

Session state remains under each session directory so removal does not silently
destroy conversations or credentials. Delete it separately only when the
operator explicitly wants that data removed.

The applied module migration is intentionally retained in the central database:
provider connections and completed wizard metadata are operator data. Removing
the registration import makes the tables inert; dropping them requires a
separate explicit data-deletion decision.
