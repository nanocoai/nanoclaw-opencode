import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { applyProviderSkill } from './install.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; skillDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-install-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'container/agent-runner'), { recursive: true });
  fs.writeFileSync(path.join(root, 'container/Dockerfile'), 'ARG BUN_VERSION=1.3.12\n');
  const skillDir = path.join(root, '.claude/skills/add-fixture');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: add-fixture',
      'description: fixture',
      '---',
      '',
      '```nc:dep manager:bun cwd:container/agent-runner',
      '@fixture/sdk@1.2.3',
      '```',
      '',
    ].join('\n'),
  );
  return { root, skillDir };
}

describe('applyProviderSkill dependency portability', () => {
  it('uses the Dockerfile-pinned Bun through pnpm when Bun is absent on the host', async () => {
    const { root, skillDir } = fixture();
    const commands: string[] = [];

    const result = await applyProviderSkill(skillDir, root, {
      commandAvailable: (command) => command !== 'bun',
      exec: (command) => {
        commands.push(command);
      },
    });

    expect(result.blockers).toEqual([]);
    expect(commands).toEqual(['cd container/agent-runner && pnpm --package=bun@1.3.12 dlx bun add @fixture/sdk@1.2.3']);
  });

  it('uses a host Bun directly when one is available', async () => {
    const { root, skillDir } = fixture();
    const commands: string[] = [];

    await applyProviderSkill(skillDir, root, {
      commandAvailable: () => true,
      exec: (command) => {
        commands.push(command);
      },
    });

    expect(commands).toEqual(['cd container/agent-runner && bun add @fixture/sdk@1.2.3']);
  });

  it('recovers when a dependency install failed after earlier directives were applied', async () => {
    const { root, skillDir } = fixture();

    const failed = await applyProviderSkill(skillDir, root, {
      commandAvailable: () => false,
      exec: () => {
        throw new Error('simulated interrupted dependency install');
      },
    });
    expect(failed.blockers).toEqual([expect.stringContaining('simulated interrupted dependency install')]);

    const retryCommands: string[] = [];
    const retried = await applyProviderSkill(skillDir, root, {
      commandAvailable: () => false,
      exec: (command) => {
        retryCommands.push(command);
      },
    });

    expect(retried.blockers).toEqual([]);
    expect(retryCommands).toEqual([
      'cd container/agent-runner && pnpm --package=bun@1.3.12 dlx bun add @fixture/sdk@1.2.3',
    ]);
  });
});
