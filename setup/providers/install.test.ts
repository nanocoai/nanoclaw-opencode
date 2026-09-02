import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyProviderSkill } from './install.js';

/**
 * `applyProviderSkill` is the install step behind the setup picker and the
 * standalone `--step provider-auth <name>` re-auth entry point. Re-auth runs it
 * on every invocation (an expired ChatGPT token, a second backend), so it must
 * be a no-op over an already-installed provider: a locally patched payload file
 * is left alone and `changed` stays false so the caller does not rebuild the
 * container image. The upgrade path that deliberately overwrites payload files
 * is `/update-skills` (`scripts/update-skills.ts`, refresh mode), which
 * requires a clean working tree first — not the auth step.
 *
 * The fixture mirrors a provider SKILL.md: a self-contained payload copy, a
 * registry-branch copy (the codex shape), barrel appends, a CLI-manifest merge,
 * and the build/test/auth runs the surrounding flow owns. Every run body is a
 * flow-owned command, so nothing is actually executed.
 */
const SKILL = `# demo provider

## 1. Copy the payload
\`\`\`nc:copy
payload/src/providers/demo.ts -> src/providers/demo.ts
\`\`\`

\`\`\`nc:copy from-branch:providers
src/providers/demo-branch.ts
\`\`\`

## 2. Register it
\`\`\`nc:append to:src/providers/index.ts
import './demo.js';
\`\`\`

## 3. Pin the CLI
\`\`\`nc:json-merge into:container/cli-tools.json key:name
{ "name": "demo-cli", "version": "1.0.0" }
\`\`\`

## 4. Build and validate
\`\`\`nc:run effect:build
pnpm run build
\`\`\`

\`\`\`nc:run effect:test
pnpm exec vitest run src/providers/demo-registration.test.ts
\`\`\`

## 5. Authenticate
\`\`\`nc:run effect:external
pnpm exec tsx setup/index.ts --step provider-auth demo
\`\`\`
`;

let root: string;
let skillDir: string;

beforeEach(() => {
  skillDir = mkdtempSync(join(tmpdir(), 'nc-provider-skill-'));
  root = mkdtempSync(join(tmpdir(), 'nc-provider-root-'));
  mkdirSync(join(skillDir, 'payload/src/providers'), { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), SKILL);
  writeFileSync(join(skillDir, 'payload/src/providers/demo.ts'), 'export const demo = "canonical";\n');
  mkdirSync(join(root, 'src/providers'), { recursive: true });
  mkdirSync(join(root, 'container'), { recursive: true });
  writeFileSync(join(root, 'src/providers/index.ts'), "import './claude.js';\n");
  writeFileSync(join(root, 'container/cli-tools.json'), '[]\n');
  writeFileSync(join(root, 'package.json'), '{"name":"scratch"}\n');
  // The branch-copied file is "already installed" — there is no git remote in
  // this fixture, so any attempt to re-fetch it would surface as a blocker.
  writeFileSync(join(root, 'src/providers/demo-branch.ts'), 'export const branch = "installed";\n');
});

afterEach(() => {
  rmSync(skillDir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('applyProviderSkill', () => {
  it('installs a missing payload and reports it as a change (fresh install rebuilds)', async () => {
    const res = await applyProviderSkill(skillDir, root);

    expect(res.blockers).toEqual([]);
    expect(res.changed).toBe(true);
    expect(readFileSync(join(root, 'src/providers/demo.ts'), 'utf8')).toContain('canonical');
    expect(readFileSync(join(root, 'src/providers/index.ts'), 'utf8')).toContain("import './demo.js';");
    expect(readFileSync(join(root, 'container/cli-tools.json'), 'utf8')).toContain('"demo-cli"');
    // The flow owns build/test/auth: they are skipped, not run and not counted.
    expect(res.apply.applied.some((s) => s.startsWith('run:'))).toBe(false);
    expect(res.apply.skipped.filter((s) => s.includes('owned by the caller'))).toHaveLength(3);
  });

  it('re-auth over an installed provider keeps a local patch and reports no change (no rebuild)', async () => {
    await applyProviderSkill(skillDir, root);
    // The operator patched the installed payload locally.
    writeFileSync(join(root, 'src/providers/demo.ts'), 'export const demo = "locally patched";\n');

    const again = await applyProviderSkill(skillDir, root);

    expect(again.blockers).toEqual([]);
    expect(readFileSync(join(root, 'src/providers/demo.ts'), 'utf8')).toContain('locally patched');
    expect(readFileSync(join(root, 'src/providers/demo-branch.ts'), 'utf8')).toContain('installed');
    expect(again.apply.applied).toEqual([]);
    expect(again.apply.journal).toEqual([]);
    expect(again.changed).toBe(false);
  });

  it('does not re-fetch a registry-branch payload that is already present', async () => {
    // Only the branch-copied file is installed; the self-contained payload is
    // absent, so the run applies something — but never touches git for the
    // present file (this fixture has no remote, so a fetch would be a blocker).
    const res = await applyProviderSkill(skillDir, root);

    expect(res.blockers).toEqual([]);
    expect(existsSync(join(root, 'src/providers/demo.ts'))).toBe(true);
    expect(readFileSync(join(root, 'src/providers/demo-branch.ts'), 'utf8')).toContain('installed');
    expect(res.apply.skipped.some((s) => s.includes('src/providers/demo-branch.ts present'))).toBe(true);
  });
});
