import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ home: '' }));
vi.mock('os', async (orig) => {
  const real = await orig<typeof import('os')>();
  return { ...real, homedir: () => env.home, default: { ...real, homedir: () => env.home } };
});

import {
  MARKET_SKILLS,
  SKILLS,
  VAIZER_CATALOG_URL,
  VAIZER_REPO,
  VAIZER_SNAPSHOT,
  parseSkillMarkdown,
  skillToMarkdown,
} from '@nekko-agent/shared';
import { setDataDir } from './paths.js';
import { installSkill, listInstalledSkillDefs, listInstalledSkills, skillTargets, uninstallSkill } from './skills.js';
import { discoverExternalSkills } from './external-skills.js';

/**
 * Skills, which the engine daemon's port (crates/nekko-workspace skills.rs)
 * must reproduce exactly. Writes two files: `src/skills-data.json`, the
 * catalog, built-in names and Vaizer snapshot the Rust side embeds, and
 * `tests/golden/skills.json`, what installs, uninstalls, listings, external
 * discovery, SKILL.md rendering and parsing return over a scratch home.
 * Temp paths and install times are normalized. Rewrite with UPDATE_GOLDEN=1.
 */
const crate = join(__dirname, '..', '..', '..', 'crates', 'nekko-workspace');
const golden = join(crate, 'tests', 'golden');

function build(base: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(base, rel)), { recursive: true });
    writeFileSync(join(base, rel), text, 'utf8');
  }
}

function norm(v: unknown, roots: Array<[string, string]>, key?: string): unknown {
  if (typeof v === 'string') {
    for (const [root, name] of roots) {
      if (v.includes(root)) return v.split(root).join(name).replace(/\\/g, '/');
    }
    return v;
  }
  if (typeof v === 'number' && key === 'installedAt') return 0;
  if (Array.isArray(v)) return v.map((x) => norm(x, roots));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = norm(x, roots, k);
    return out;
  }
  return v;
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('skills golden set', () => {
  it('writes the data the Rust side embeds', () => {
    const data = {
      market: MARKET_SKILLS,
      builtinNames: SKILLS.map((s) => s.name),
      vaizerSnapshot: VAIZER_SNAPSHOT,
      vaizerCatalogUrl: VAIZER_CATALOG_URL,
      vaizerRepo: VAIZER_REPO,
    };
    const text = `${JSON.stringify(data, null, 2)}\n`;
    const path = join(crate, 'src', 'skills-data.json');
    if (process.env.UPDATE_GOLDEN) writeFileSync(path, text);
    expect(readFileSync(path, 'utf8')).toBe(text);
  });

  it('matches what skills.ts and external-skills.ts return', () => {
    const c = JSON.parse(readFileSync(join(golden, 'skills-cases.json'), 'utf8'));
    const home = mkdtempSync(join(tmpdir(), 'nekko-skills-home-'));
    const project = mkdtempSync(join(tmpdir(), 'nekko-skills-project-'));
    const data = mkdtempSync(join(tmpdir(), 'nekko-skills-data-'));
    dirs.push(home, project, data);
    build(home, c.home);
    build(project, c.project);
    env.home = home;
    setDataDir(data);
    const roots: Array<[string, string]> = [[home, '<home>'], [project, '<project>'], [data, '<data>']];
    const run = ([op, ...a]: [string, ...any[]]): unknown => {
      switch (op) {
        case 'targets': return skillTargets();
        case 'list': return listInstalledSkills();
        case 'install': return installSkill(a[0], a[1], a[2]);
        case 'uninstall': return uninstallSkill(a[0], a[1]);
        case 'external': return discoverExternalSkills({
          home,
          projectRoots: [project],
          exclude: listInstalledSkills().flatMap((r) => (r.path ? [r.path] : [])),
          reserved: [...SKILLS, ...listInstalledSkillDefs()].map((s) => s.name),
        });
        case 'skillFile': return readFileSync(join(home, a[0], 'SKILL.md'), 'utf8');
        case 'exists': return existsSync(join(home, a[0]));
        case 'removeHome': rmSync(join(home, a[0]), { recursive: true, force: true }); return null;
        default: throw new Error(`unknown op ${op}`);
      }
    };
    const ops = c.ops.map((o: [string, ...unknown[]]) => {
      try {
        return { op: o[0], result: norm(run(o), roots) };
      } catch (e) {
        return { op: o[0], error: (e as Error).message };
      }
    });
    const actual = {
      ops,
      markdown: MARKET_SKILLS.map((m) => skillToMarkdown(m)),
      parse: c.parse.map((raw: string) => parseSkillMarkdown(raw)),
    };
    const text = `${JSON.stringify(actual, null, 2)}\n`;
    const path = join(golden, 'skills.json');
    if (process.env.UPDATE_GOLDEN) writeFileSync(path, text);
    expect(readFileSync(path, 'utf8')).toBe(text);
  });
});
