// Payload parity for self-contained skills.
//
// A skill that carries its own code under `.claude/skills/<name>/payload/`
// (an `nc:copy` fence with no `from-branch:`) is the canonical source for the
// files it installs: `/update-skills` (refresh mode) overwrites the tree copy
// with the payload copy, and a fresh `/add-<name>` installs the payload as-is.
// A fix landed only on the tree side is therefore silently reverted by the
// next refresh. This test makes that drift fail CI instead:
//
//   1. discover every skill whose SKILL.md carries a local-payload copy fence
//      (discovery-based, like skill-conformance — a new self-contained skill is
//      covered the day it lands);
//   2. every mapped payload source must exist (a mapping to a missing file is
//      a broken install);
//   3. every file under payload/ must be mapped by some copy line (an orphan
//      payload file is never installed — the reverse drift);
//   4. when the skill is installed in this tree (any destination present),
//      EVERY destination must exist and be byte-identical to its payload copy.
//      A skill with no destination present is not installed here and is
//      skipped, not failed.
//
// Pure file reads — no engine run, no network — so it stays in the normal
// vitest CI step.

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { parseDirectives } from './skill-directives.js';

const ROOT = process.cwd();
const SKILLS_DIR = join(ROOT, '.claude/skills');

interface CopyMapping {
  src: string; // relative to the skill directory (e.g. payload/src/x.ts)
  dst: string; // relative to the project root
  line: number; // 1-based line of the fence, for actionable failures
}

// Same split the engine uses (scripts/skill-apply.ts srcOf/destOf): `SRC -> DST`
// or a bare `PATH` where source == destination.
function parseCopyLine(line: string): { src: string; dst: string } {
  if (!line.includes('->')) return { src: line.trim(), dst: line.trim() };
  const [src, dst] = line.split('->');
  return { src: src.trim(), dst: dst.trim() };
}

/** Local-payload copy mappings of one skill (from-branch fences are registry-sourced, not payload). */
function localCopyMappings(skillName: string): CopyMapping[] {
  const markdown = readFileSync(join(SKILLS_DIR, skillName, 'SKILL.md'), 'utf8');
  return parseDirectives(markdown)
    .filter((d) => d.kind === 'copy' && d.attrs['from-branch'] === undefined)
    .flatMap((d) => d.body.map((body) => ({ ...parseCopyLine(body), line: d.line })));
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const SKILLS = existsSync(SKILLS_DIR)
  ? readdirSync(SKILLS_DIR).filter(
      (name) => existsSync(join(SKILLS_DIR, name, 'SKILL.md')) && localCopyMappings(name).length > 0,
    )
  : [];

describe('skill payload parity', () => {
  it('discovers at least one self-contained skill', () => {
    // add-opencode carries its payload in-tree; if this ever goes to zero the
    // suite below would silently vacuously pass.
    expect(SKILLS.length).toBeGreaterThan(0);
  });

  describe.each(SKILLS)('%s', (skillName) => {
    const skillDir = join(SKILLS_DIR, skillName);
    const mappings = localCopyMappings(skillName);

    it('maps only payload files that exist', () => {
      const missing = mappings.filter((m) => !existsSync(join(skillDir, m.src)));
      expect(missing.map((m) => `${m.src} (SKILL.md line ${m.line})`)).toEqual([]);
    });

    it('maps every file under payload/', () => {
      const mapped = new Set(mappings.map((m) => m.src));
      const orphans = walk(join(skillDir, 'payload'))
        .map((full) => relative(skillDir, full))
        .filter((rel) => !mapped.has(rel));
      expect(orphans).toEqual([]);
    });

    const installed = mappings.some((m) => existsSync(join(ROOT, m.dst)));
    const parity = installed ? it : it.skip;

    parity('installed tree files are byte-identical to the payload', () => {
      const drift: string[] = [];
      for (const m of mappings) {
        const payloadPath = join(skillDir, m.src);
        const treePath = join(ROOT, m.dst);
        if (!existsSync(payloadPath)) continue; // reported by the mapping test above
        if (!existsSync(treePath)) {
          drift.push(`${m.dst}: missing in tree (partial install)`);
          continue;
        }
        if (!readFileSync(payloadPath).equals(readFileSync(treePath))) {
          drift.push(`${m.dst}: differs from ${skillName}/${m.src}`);
        }
      }
      // A tree-side fix must be mirrored into the skill payload (or the payload
      // fix installed via /update-skills) — otherwise the next refresh reverts it.
      expect(drift).toEqual([]);
    });
  });
});
