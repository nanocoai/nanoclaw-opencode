import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { DependencyCommandRequest } from './skill-apply.js';

export function commandAvailable(command: string, cwd: string): boolean {
  try {
    execFileSync(command, ['--version'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

function pinnedBunVersion(root: string): string {
  const dockerfile = fs.readFileSync(path.join(root, 'container/Dockerfile'), 'utf8');
  const match = dockerfile.match(/^ARG BUN_VERSION=([^\s#]+)$/m);
  if (!match) throw new Error('container/Dockerfile does not declare an exact BUN_VERSION');
  return match[1];
}

export function portableDependencyCommand(root: string, bunOnHost: boolean, request: DependencyCommandRequest): string {
  const prefix = request.cwd ? `cd ${request.cwd} && ` : '';
  const manager =
    request.manager === 'bun' && !bunOnHost ? `pnpm --package=bun@${pinnedBunVersion(root)} dlx bun` : request.manager;
  return `${prefix}${manager} ${request.action} ${request.packages.join(' ')}`;
}
