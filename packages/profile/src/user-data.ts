import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, statfsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { brandEnv, CLI_LINK_FILE, modelModality } from '@nekko-agent/shared';
import { writeJsonAtomic } from './secure-file.js';

export function defaultUserDataDir(): string {
  return brandEnv('DATA_DIR') || join(homedir(), '.nekko-agent');
}

export function legacyUserDataDirs(home = homedir(), appData?: string): string[] {
  const profile = appData ?? (process.platform === 'win32' ? process.env.APPDATA || join(home, 'AppData', 'Roaming') : process.platform === 'darwin' ? join(home, 'Library', 'Application Support') : join(home, '.config'));
  const sources = [join(profile, 'Nekko Agent', 'nekko-agent'), join(home, '.nekko')].filter(p => existsSync(join(p, 'settings.json')));
  const journal = join(home, '.nekko-agent', 'migration.json');
  if (existsSync(journal)) {
    const pending = JSON.parse(readFileSync(journal, 'utf8')) as { from: string; phase: string };
    if (pending.phase !== 'complete' && !sources.includes(pending.from)) sources.push(pending.from);
  }
  return sources;
}

// Chromium writes these into the new desktop profile at startup, before the
// migration dialog can open; the running browser owns them, so they never move.
// The single-instance lock is `lockfile` on Windows, `Singleton*` elsewhere.
const BROWSER_STARTUP_FILES = new Set(['Local State', 'lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket']);

function inside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function remap(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string' && (value === from || value.startsWith(`${from}${sep}`))) return to + value.slice(from.length);
  if (Array.isArray(value)) return value.map(v => remap(v, from, to));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, remap(v,from,to)]));
  return value;
}

export function migrateUserData(source: string, destination: string, desktopProfile?: string): void {
  const from = resolve(source), to = resolve(destination);
  if (inside(to, from) || inside(from, to)) throw new Error('Source and destination must be separate data folders.');
  if ((existsSync(from) && lstatSync(from).isSymbolicLink()) || (existsSync(to) && lstatSync(to).isSymbolicLink())) throw new Error('Migration requires real folders, not symbolic links.');
  const roots = [from, ...(legacyUserDataDirs().some(p => resolve(p) === from) ? [join(homedir(), '.nekko')] : [])];
  for (const root of roots) {
    const linkPath = join(root, CLI_LINK_FILE);
    if (!existsSync(linkPath)) continue;
    const link = JSON.parse(readFileSync(linkPath, 'utf8')) as { pid?: number; enabled?: boolean };
    if (!link.enabled || !Number.isInteger(link.pid) || link.pid! <= 0 || link.pid === process.pid) continue;
    let live = false;
    try { process.kill(link.pid!, 0); live = true; } catch (e) { live = (e as NodeJS.ErrnoException).code === 'EPERM'; }
    if (live) throw new Error('Another Nekko Agent process is still running. Close it before moving its data.');
  }
  const journalPath = join(to, 'migration.json');
  const prior = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')) as { from: string; to: string; phase: string; desktopProfile?: string; moves?: Array<{ from: string; to: string }> } : null;
  if (prior && (prior.from !== from || prior.to !== to)) throw new Error('A different migration is pending. Resolve it before moving another profile.');
  if (!prior && existsSync(to) && readdirSync(to).some(n => n !== 'desktop')) throw new Error('The destination already contains user data. Choose which profile to keep; no files were overwritten.');
  if (!prior && !existsSync(join(from, 'settings.json'))) throw new Error('The selected source has no Nekko Agent settings.');
  mkdirSync(to, { recursive: true, mode: 0o700 });
  if (existsSync(from) && statSync(from).dev !== statSync(to).dev) throw new Error('This move crosses filesystems. Move the profile to the destination filesystem manually before continuing.');
  const disk = statfsSync(to);
  if (disk.bavail * disk.bsize < 64 * 1024 * 1024) throw new Error('Free at least 64 MB for migration metadata before continuing. Models are moved, not copied.');
  let moves = prior?.moves ?? [];
  desktopProfile ??= prior?.desktopProfile;
  if (desktopProfile) {
    if (resolve(desktopProfile) !== dirname(from) || inside(to, desktopProfile)) throw new Error('The desktop profile must be the source data folder\'s parent, separate from the destination.');
    const profileTarget = join(to, 'desktop');
    if (resolve(desktopProfile) === resolve(profileTarget) || !existsSync(desktopProfile)) throw new Error('The old desktop profile is not a separate existing folder.');
    if (!prior && existsSync(profileTarget) && readdirSync(profileTarget).some(n => !BROWSER_STARTUP_FILES.has(n))) throw new Error('The new desktop profile already contains browser data. Close the app and resolve the profile conflict before migrating.');
    mkdirSync(profileTarget, { recursive: true, mode: 0o700 });
  }
  const saveJournal = (phase: string) => writeJsonAtomic(journalPath, { from, to, phase, desktopProfile, moves });
  saveJournal('moving');
  if (existsSync(from)) for (const name of readdirSync(from)) {
    if (lstatSync(join(from, name)).isSymbolicLink()) throw new Error('Migration refuses symbolic links in the data root.');
    const target = join(to, name);
    if (existsSync(target)) throw new Error(`Migration conflict: ${name}. Nothing was overwritten. Re-run migration with the same source after resolving the conflict.`);
    renameSync(join(from, name), target);
  }
  saveJournal('references');
  const modelsRoot = join(to, 'models');
  const indexPath = join(modelsRoot, 'library.json');
  if (!moves.length && existsSync(modelsRoot)) {
    const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) as { models: Record<string, { file: string; folderId?: string; name?: string; architecture?: string; modality?: string }> } : { models: {} };
    const groups = new Map<string, string>();
    for (const model of Object.values(index.models)) {
      const file = remap(model.file, from, to) as string;
      if (!inside(file, modelsRoot) || (model.folderId && model.folderId !== 'primary')) continue;
      const dir = dirname(file), rel = relative(modelsRoot, dir);
      if (!rel || /^(chat|vision|embedding|image|audio|draft|unknown)(?:[\\/]|$)/.test(rel)) continue;
      const type = modelModality(model);
      if (!groups.has(dir) || type !== 'chat') groups.set(dir, type);
    }
    moves = [...groups].map(([dir, type]) => ({ from: dir, to: join(modelsRoot, type, relative(modelsRoot, dir)) }));
    saveJournal('models');
  }
  for (const move of moves) {
    if (!inside(move.from, modelsRoot) || !inside(move.to, modelsRoot)) throw new Error('Migration journal has an invalid model path.');
    if (!existsSync(move.from)) continue;
    if (existsSync(move.to)) throw new Error('A typed model folder already exists. Migration stopped without overwriting it.');
    mkdirSync(dirname(move.to), { recursive: true, mode: 0o700 });
    renameSync(move.from, move.to);
  }
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'desktop') walk(path);
      else if (entry.isFile() && entry.name.endsWith('.json') && statSync(path).size <= 32 * 1024 * 1024) {
        let value;
        try { value = JSON.parse(readFileSync(path, 'utf8')); } catch { continue; }
        if (path === journalPath) continue;
        let mapped = remap(value, from, to);
        for (const move of moves) mapped = remap(mapped, move.from, move.to);
        writeJsonAtomic(path, mapped);
      }
    }
  };
  walk(to);
  if (desktopProfile) {
    saveJournal('desktop');
    for (const entry of readdirSync(desktopProfile, { withFileTypes: true })) {
      const path = join(desktopProfile, entry.name);
      if (resolve(path) === from || entry.isSymbolicLink() || BROWSER_STARTUP_FILES.has(entry.name)) continue;
      const target = join(to, 'desktop', entry.name);
      if (existsSync(target)) throw new Error('A desktop-profile file already exists. Migration stopped without overwriting it.');
      renameSync(path, target);
    }
  }
  saveJournal('complete');
  chmodSync(to, 0o700);
}

export function prepareUserDataRoot(): string {
  const root = defaultUserDataDir();
  if (brandEnv('DATA_DIR')) return root;
  const journalPath = join(root, 'migration.json');
  const pending = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')) as { from: string; phase: string } : null;
  const sources = legacyUserDataDirs();
  if (pending?.phase === 'complete' || (existsSync(join(root, 'settings.json')) && !pending)) return root;
  if (!sources.length && !pending) return root;
  const selected = brandEnv('MIGRATE_FROM') || pending?.from || (sources.length === 1 ? sources[0] : undefined);
  if (brandEnv('MIGRATE_DATA') !== '1' || !selected) throw new Error(`Existing Nekko Agent data needs a confirmed move to ${root}. Close other Nekko instances, then launch the desktop app to choose a profile, or set NEKKO_MIGRATE_DATA=1 and NEKKO_MIGRATE_FROM to the source folder. Original profiles are not merged automatically.`);
  if (!pending && !sources.some(p => resolve(p) === resolve(selected))) throw new Error('The selected source is not a detected Nekko Agent profile.');
  migrateUserData(selected, root);
  return root;
}
