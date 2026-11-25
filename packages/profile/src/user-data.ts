import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, statfsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { brandEnv, CLI_LINK_FILE, modelModality } from '@nekko-agent/shared';
import { writeJsonAtomic } from './secure-file.js';

function agentHome(home: string): string {
  return join(home, '.nekko', 'nekko-agent');
}

export function defaultUserDataDir(): string {
  return brandEnv('DATA_DIR') || agentHome(homedir());
}

export function legacyUserDataDirs(home = homedir(), appData?: string): string[] {
  const profile = appData ?? (process.platform === 'win32' ? process.env.APPDATA || join(home, 'AppData', 'Roaming') : process.platform === 'darwin' ? join(home, 'Library', 'Application Support') : process.env.XDG_CONFIG_HOME || join(home, '.config'));
  const sources = [join(home, '.nekko-agent'), join(profile, 'Nekko Agent', 'nekko-agent'), join(home, '.nekko')].filter(p => existsSync(join(p, 'settings.json')));
  const journal = join(agentHome(home), 'migration.json');
  if (existsSync(journal)) {
    const pending = JSON.parse(readFileSync(journal, 'utf8')) as { from: string; phase: string };
    if (pending.phase !== 'complete') return [pending.from];
  }
  return sources;
}

// Only these known Agent entries move from the old shared parent. Unknown files
// and other products remain in ~/.nekko; the new destination is never traversed.
const LEGACY_PROFILE_ENTRIES = new Set([
  'settings.json', 'sessions', 'tokens.json', 'secrets.json', 'security.json',
  'models', 'engine', 'desktop', 'logs', 'memory', 'memory.json', 'scratch',
  'attachments', 'changes', 'commands', 'audit', 'audit.jsonl', 'backups',
  'fonts', 'bin', 'runtime', 'harness', 'plugins', 'skills', 'skills.json',
  'skill-sources.json', 'agent-pictures', 'agent-browser', 'voice', 'images',
  'computers', 'computers.json', 'computers-secrets.json', 'cloud',
  'usage.jsonl', 'quota-history.jsonl', 'install-id',
  'agent-watches.json', 'watches.json', 'runners.json', 'training.json',
  'simulators.json', 'updates.json', 'network-visibility.json', 'remote.json',
  'resource-queue.json', 'runtime-calibration.json', 'workflows.json',
  'workflow-cursors.json', 'workflow-runs.json', 'workflow-checkouts',
  'sandboxes', 'vms', 'subagents', 'tasks.json', 'local-relay.json',
  'settings-keystore.json', 'tokens-keystore.json', 'keystore.json',
  'comments.json', 'design.json', 'display-windows.json', 'machine-profile.json',
  'recommendations-seen.json', 'remote-activity.json', 'remote-hello-keys.json',
  'replies.jsonl', 'run', 'runners', 'vaizer.json', 'window-state.json',
  'claude-policy.json', 'dojo.json', 'measured-speeds.json', 'messaging-state.json',
  'provider-seal.key',
]);

// The running Electron instance may already own these at the destination.
const BROWSER_STARTUP_FILES = new Set(['lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket']);

function inside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

type Move = { from: string; to: string };

function remap(value: unknown, paths: Move[]): unknown {
  if (typeof value === 'string') {
    const path = paths.find(({ from }) => value === from || value.startsWith(`${from}${sep}`));
    return path ? path.to + value.slice(path.from.length) : value;
  }
  if (Array.isArray(value)) return value.map(v => remap(v, paths));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remap(v, paths)]));
  return value;
}

function entryAt(path: string) {
  return lstatSync(path, { throwIfNoEntry: false });
}

function assertProfileStopped(root: string): void {
  const assertPidStopped = (pid: number | undefined) => {
    if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff || pid === process.pid) return;
    try { process.kill(pid, 0); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') return; }
    throw new Error('Another Nekko Agent process may still be running. Close it before moving its data.');
  };
  const lockPath = join(root, 'nekkod.lock');
  const lock = entryAt(lockPath);
  if (lock) {
    // Daemons that do not offer a CLI link still publish their PID here.
    if (!lock.isFile()) throw new Error('The daemon lock is not a regular file.');
    try { assertPidStopped(Number(readFileSync(lockPath, 'utf8').trim())); }
    catch { throw new Error('The Nekko Agent daemon may still be running. Close it before moving its data.'); }
  }
  const linkPath = join(root, CLI_LINK_FILE);
  const linkEntry = entryAt(linkPath);
  if (!linkEntry) return;
  if (!linkEntry.isFile()) throw new Error('The CLI link is not a regular file.');
  const link = JSON.parse(readFileSync(linkPath, 'utf8')) as { pid?: number; enabled?: boolean };
  if (link.enabled) assertPidStopped(link.pid);
}

function browserMoves(source: string, target: string, resume: boolean, skipSource?: string): Move[] {
  const src = entryAt(source), dest = entryAt(target);
  if (!src?.isDirectory() || (dest && !dest.isDirectory())) throw new Error('Migration requires real desktop profile folders.');
  if (!resume && dest && readdirSync(target).some(n => !BROWSER_STARTUP_FILES.has(n) && n !== 'Local State')) {
    throw new Error('The new desktop profile already contains browser data. Close the app and resolve the profile conflict before migrating.');
  }
  return readdirSync(source, { withFileTypes: true }).flatMap(entry => {
    const from = join(source, entry.name), to = join(target, entry.name);
    if (from === skipSource || BROWSER_STARTUP_FILES.has(entry.name) || (entry.name === 'Local State' && entryAt(to))) return [];
    if (entry.isSymbolicLink()) throw new Error('Migration refuses symbolic links in the desktop profile.');
    if (entryAt(to)) throw new Error(`Migration conflict: desktop/${entry.name}. Nothing was overwritten.`);
    return [{ from, to }];
  });
}

export function migrateUserData(source: string, destination: string, desktopProfile?: string): void {
  const from = resolve(source), to = resolve(destination);
  const nestedLegacy = from.endsWith(`${sep}.nekko`) && to === join(from, 'nekko-agent');
  if ((!nestedLegacy && inside(to, from)) || inside(from, to)) throw new Error('Source and destination must be separate data folders.');
  for (const folder of [from, to]) {
    const entry = entryAt(folder);
    if (entry && !entry.isDirectory()) throw new Error('Migration requires real folders, not symbolic links.');
  }
  for (const root of [from, to]) assertProfileStopped(root);
  const journalPath = join(to, 'migration.json');
  const journal = entryAt(journalPath);
  if (journal && !journal.isFile()) throw new Error('Migration requires a regular journal file.');
  const prior = journal ? JSON.parse(readFileSync(journalPath, 'utf8')) as { from: string; to: string; phase: string; desktopProfile?: string; moves?: Move[] } : null;
  if (prior && (prior.from !== from || prior.to !== to)) throw new Error('A different migration is pending. Resolve it before moving another profile.');
  if (prior?.phase === 'complete') return;
  if (!prior && existsSync(to) && readdirSync(to).some(n => n !== 'desktop')) throw new Error('The destination already contains user data. Choose which profile to keep; no files were overwritten.');
  if (!prior && !entryAt(join(from, 'settings.json'))?.isFile()) throw new Error('The selected source has no Nekko Agent settings.');
  mkdirSync(to, { recursive: true, mode: 0o700 });
  if (existsSync(from) && statSync(from).dev !== statSync(to).dev) throw new Error('This move crosses filesystems. Move the profile to the destination filesystem manually before continuing.');
  const disk = statfsSync(to);
  if (disk.bavail * disk.bsize < 64 * 1024 * 1024) throw new Error('Free at least 64 MB for migration metadata before continuing. Models are moved, not copied.');
  let moves = prior?.moves ?? [];
  desktopProfile ??= prior?.desktopProfile;
  const profileTarget = join(to, 'desktop');
  if (desktopProfile) {
    desktopProfile = resolve(desktopProfile);
    if (desktopProfile !== dirname(from) || inside(to, desktopProfile)) throw new Error('The desktop profile must be the source data folder\'s parent, separate from the destination.');
  }
  const scopeFile = 'keystore-scope.json';
  const scopePath = join(to, scopeFile);
  const scopeEntry = entryAt(scopePath);
  if (scopeEntry && !scopeEntry.isFile()) throw new Error('The destination credential scope is not a regular file.');
  const sourceScope = join(from, scopeFile);
  const sourceScopeEntry = entryAt(sourceScope);
  if (sourceScopeEntry && !sourceScopeEntry.isFile()) throw new Error('The source credential scope is not a regular file.');
  const scope = sourceScopeEntry ? JSON.parse(readFileSync(sourceScope, 'utf8')) as { path?: string } : { path: from };
  if (typeof scope.path !== 'string' || !isAbsolute(scope.path)) throw new Error('Invalid source credential scope.');
  const ownMoves: Move[] = [];
  const browserFromData = join(from, 'desktop');
  const splitBrowser = Boolean(entryAt(browserFromData) && (entryAt(profileTarget) || desktopProfile));
  if (existsSync(from)) for (const name of readdirSync(from)) {
    if (name === 'migration.json' || name === scopeFile || name === 'nekkod.lock' || name === CLI_LINK_FILE || (nestedLegacy && !LEGACY_PROFILE_ENTRIES.has(name))) continue;
    const src = join(from, name), dest = join(to, name);
    if (name === 'desktop' && splitBrowser) continue;
    if (lstatSync(src).isSymbolicLink()) throw new Error('Migration refuses symbolic links in the data root.');
    if (entryAt(dest)) throw new Error(`Migration conflict: ${name}. Nothing was overwritten. Re-run migration with the same source after resolving the conflict.`);
    ownMoves.push({ from: src, to: dest });
  }
  const browser = [
    ...(splitBrowser ? browserMoves(browserFromData, profileTarget, Boolean(prior)) : []),
    ...(desktopProfile ? browserMoves(desktopProfile, profileTarget, Boolean(prior), from) : []),
  ];
  if (new Set(browser.map(move => move.to)).size !== browser.length) throw new Error('The old desktop profiles contain conflicting browser data.');
  const saveJournal = (phase: string) => writeJsonAtomic(journalPath, { from, to, phase, desktopProfile, moves });
  // The OS keystore hashes the original directory. Preserve that scope without
  // reading or exporting any secrets. Resume keeps the scope saved on the first run.
  saveJournal('moving');
  if (!scopeEntry) writeJsonAtomic(scopePath, scope);
  for (const move of ownMoves) renameSync(move.from, move.to);
  if (browser.length) mkdirSync(profileTarget, { recursive: true, mode: 0o700 });
  for (const move of browser) renameSync(move.from, move.to);
  saveJournal('references');
  const profilePaths = nestedLegacy
    ? [...LEGACY_PROFILE_ENTRIES].map(name => ({ from: join(from, name), to: join(to, name) }))
    : [{ from, to }];
  const modelsRoot = join(to, 'models');
  const indexPath = join(modelsRoot, 'library.json');
  if (!moves.length && existsSync(modelsRoot)) {
    const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) as { models: Record<string, { file: string; folderId?: string; name?: string; architecture?: string; modality?: string }> } : { models: {} };
    const groups = new Map<string, string>();
    for (const model of Object.values(index.models)) {
      const file = remap(model.file, profilePaths) as string;
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
        if (path === journalPath || path === scopePath) continue;
        const mapped = remap(remap(value, profilePaths), moves);
        if (JSON.stringify(mapped) !== JSON.stringify(value)) writeJsonAtomic(path, mapped);
      }
    }
  };
  walk(to);
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
  // For the AppData layout the browser profile is the data folder's parent.
  const inHome = dirname(resolve(selected)) === resolve(homedir());
  const desktopProfile = inHome ? undefined : dirname(selected);
  migrateUserData(selected, root, desktopProfile);
  return root;
}
