import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { InstallTarget, InstallTargetInfo, InstalledSkillRecord, MarketplaceSkill, SkillDef } from '@nekko-agent/shared';
import { getMarketSkill, marketToSkillDef, normalizeInstallTarget, skillToMarkdown } from '@nekko-agent/shared';
import { dataDir } from './store.js';

/**
 * Skills marketplace installs. Records live in skills.json under the data dir.
 * The `nekko-agent` target is purely a record (installed skills join the `/` menu
 * and the Skills tab); `claude`/`codex` write a SKILL.md folder into the app's
 * user-level skills directory so other agents pick the skill up too.
 */

function file(): string {
  const dir = dataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'skills.json');
}

function load(): InstalledSkillRecord[] {
  try {
    return JSON.parse(readFileSync(file(), 'utf8')) as InstalledSkillRecord[];
  } catch {
    return [];
  }
}

function save(records: InstalledSkillRecord[]): void {
  writeFileSync(file(), JSON.stringify(records, null, 2), 'utf8');
}

/** User-level skills directory for a file-based target. */
function targetDir(target: InstallTarget): string | undefined {
  if (target === 'claude') return join(homedir(), '.claude', 'skills');
  if (target === 'codex') return join(homedir(), '.codex', 'skills');
  return undefined;
}

/**
 * The installed records without the self-heal write: what this host reads
 * for its own use (workflow skill steps, external-skill exclusions). Under
 * the engine daemon skills.json is the daemon's to write (`skill:*`).
 */
export function readInstalledSkills(): InstalledSkillRecord[] {
  return load().filter((r) => !r.path || existsSync(r.path));
}

export function listInstalledSkills(): InstalledSkillRecord[] {
  // Self-heal: drop records whose file-based install was deleted out-of-band.
  const records = load();
  const alive = records.filter((r) => !r.path || existsSync(r.path));
  if (alive.length !== records.length) save(alive);
  return alive;
}

/**
 * Nekko Agent-target installs as runnable skills. Non-catalog installs (Vaizer)
 * carry their own snapshot on the record; catalog ones resolve by id. Used by a
 * workflow's skill step to find what it should run.
 */
export function listInstalledSkillDefs(): SkillDef[] {
  return readInstalledSkills()
    .filter((r) => normalizeInstallTarget(r.target) === 'nekko-agent')
    .map((r) => r.skill ?? getMarketSkill(r.skillId))
    .filter((m): m is MarketplaceSkill => !!m)
    .map(marketToSkillDef);
}

export function skillTargets(): InstallTargetInfo[] {
  const claudeDir = join(homedir(), '.claude');
  const codexDir = join(homedir(), '.codex');
  return [
    { id: 'nekko-agent', label: 'Nekko Agent', hint: 'joins the / menu and Skills tab', available: true },
    {
      id: 'claude',
      label: 'Claude Code',
      hint: '~/.claude/skills/<name>/SKILL.md',
      available: existsSync(claudeDir),
      dir: targetDir('claude'),
    },
    {
      id: 'codex',
      label: 'Codex',
      hint: '~/.codex/skills/<name>/SKILL.md',
      available: existsSync(codexDir),
      dir: targetDir('codex'),
    },
  ];
}

export function installSkill(
  skillId: string,
  rawTarget: InstallTarget,
  payload?: MarketplaceSkill,
): { ok: boolean; message?: string; installed: InstalledSkillRecord[] } {
  // A caller (or an older stored record being reinstalled) may still name a
  // previous brand; everything below works with the current name.
  const target = normalizeInstallTarget(rawTarget);
  // Skills outside the built-in catalog (e.g. Vaizer) arrive as a payload
  // snapshot; built-in ones resolve from the catalog.
  const builtIn = getMarketSkill(skillId);
  const skill = builtIn ?? (payload?.id === skillId ? payload : undefined);
  if (!skill) return { ok: false, message: 'Unknown skill.', installed: listInstalledSkills() };
  if (!/^[a-z0-9._-]+$/i.test(skill.name)) {
    return { ok: false, message: 'Invalid skill name.', installed: listInstalledSkills() };
  }

  const records = load();
  if (records.some((r) => r.skillId === skillId && r.target === target)) {
    return { ok: true, message: 'Already installed.', installed: listInstalledSkills() };
  }

  let path: string | undefined;
  if (target !== 'nekko-agent') {
    const base = targetDir(target)!;
    path = join(base, skill.name);
    // Never clobber a skill folder we didn't create (no record for it).
    if (existsSync(path)) {
      return { ok: false, message: `A skill named "${skill.name}" already exists there.`, installed: listInstalledSkills() };
    }
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'SKILL.md'), skillToMarkdown(skill), 'utf8');
  }

  // Persist the snapshot for non-catalog skills so they stay resolvable.
  records.push({ skillId, target, path, installedAt: Date.now(), skill: builtIn ? undefined : skill });
  save(records);
  return { ok: true, installed: listInstalledSkills() };
}

export function uninstallSkill(skillId: string, target: InstallTarget): InstalledSkillRecord[] {
  const records = load();
  const rec = records.find((r) => r.skillId === skillId && r.target === target);
  if (rec?.path && existsSync(rec.path)) {
    try {
      rmSync(rec.path, { recursive: true });
    } catch {
      /* leave the folder; still drop the record */
    }
  }
  save(records.filter((r) => !(r.skillId === skillId && r.target === target)));
  return listInstalledSkills();
}
