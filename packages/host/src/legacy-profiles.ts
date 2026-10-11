import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CLI_LINK_FILE, modelModality } from '@nekko-agent/shared';
import { writeTextAtomic } from './secure-file.js';
import { defaultUserDataDir } from './user-data.js';
import { applyToDataRoot, planDedupe, providerIdentity, type AccountOf, type FolderLike, type Plan, type ProviderLike } from './profile-repair.js';

/**
 * Finding, merging and removing what earlier names of this app left behind.
 *
 * The app has been renamed several times (Nekko Paw, Open Paw, Kotrain, Agent
 * Nekko) and each name wrote its own data folder, install and updater cache.
 * `migrateUserData` (user-data.ts) moves ONE profile into an empty
 * `~/.nekko-agent`. This module covers what it refuses to: several profiles,
 * or a profile when `~/.nekko-agent` already has data. Everything here is
 * additive (nothing in the target is overwritten) and cleanup only deletes a
 * folder after `unmerged()` finds nothing in it that the target lacks.
 *
 * Detection is existence-only so the desktop app can run it on every launch.
 */

export interface LegacyEnv {
  home: string;
  appData: string;
  localAppData: string;
  tmp: string;
  platform: NodeJS.Platform;
  /** The current data root, `~/.nekko-agent` unless overridden. */
  target: string;
}

export type LegacyKind = 'data' | 'app-data' | 'install' | 'updater' | 'temp';

export interface LegacyItem {
  id: string;
  kind: LegacyKind;
  path: string;
  label: string;
  /** Folders inside `path` that hold Nekko data (settings, sessions, usage). */
  dataRoots: string[];
}

// Names this app has shipped under. `Nekko Paw` is deliberately absent: it is
// listed in the PR notes as an open question, and `Nekko Notes`, APFS and the
// agent-nekko-pr-* evidence folders are other products or current workflows.
const HOME_DIRS = ['.nekko', '.agent-nekko', '.kotrain', '.open-paw'];
const APPDATA_DIRS = ['@agent-nekko', '@kotrain', '@open-paw', '@nekko', 'Agent Nekko', 'Kotrain', 'Open Paw', 'Nekko Agent'];
const INSTALL_NAMES = ['Kotrain', 'Open Paw'];
const UPDATER_DIRS = ['@agent-nekkodesktop-updater', '@kotraindesktop-updater', '@open-pawdesktop-updater', '@nekkodesktop-updater'];
const TEMP_PREFIXES = ['kotrain-'];
/** Chromium folders that are never a Nekko data root, so probing skips them. */
const BROWSER_DIRS = new Set(['Cache', 'Code Cache', 'GPUCache', 'Local Storage', 'Session Storage', 'Network', 'Service Worker', 'blob_storage', 'backups']);
/** Root files that describe one machine's running state; never merged. */
const SKIP_JSON = new Set(['window-state.json', 'cli-link.json', 'migration.json']);
const MAX_JSON_BYTES = 32 * 1024 * 1024;

export function legacyEnv(over: Partial<LegacyEnv> = {}): LegacyEnv {
  const home = over.home ?? homedir();
  const platform = over.platform ?? process.platform;
  const appData = over.appData ?? (platform === 'win32' ? process.env.APPDATA || join(home, 'AppData', 'Roaming') : platform === 'darwin' ? join(home, 'Library', 'Application Support') : join(home, '.config'));
  const localAppData = over.localAppData ?? (platform === 'win32' ? process.env.LOCALAPPDATA || join(home, 'AppData', 'Local') : appData);
  return { home, appData, localAppData, tmp: over.tmp ?? tmpdir(), platform, target: over.target ?? defaultUserDataDir() };
}

const isDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p: string): boolean => { try { return statSync(p).isFile(); } catch { return false; } };
const same = (a: string, b: string, ci: boolean): boolean => (ci ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));
const dirEntries = (dir: string) => { try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; } };

function inside(path: string, root: string, ci: boolean): boolean {
  const rel = relative(ci ? resolve(root).toLowerCase() : resolve(root), ci ? resolve(path).toLowerCase() : resolve(path));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function hasAnyFile(dir: string, budget = { n: 5000 }): boolean {
  for (const e of dirEntries(dir)) {
    if (budget.n-- <= 0) return true;
    if (e.isFile()) return true;
    if (e.isDirectory() && hasAnyFile(join(dir, e.name), budget)) return true;
  }
  return false;
}

function isDataRoot(dir: string): boolean {
  return isFile(join(dir, 'settings.json')) || isDir(join(dir, 'sessions')) || isFile(join(dir, 'usage.jsonl'));
}

function findDataRoots(wrapper: string): string[] {
  const roots: string[] = [];
  for (const base of [wrapper, join(wrapper, 'desktop')]) {
    if (!isDir(base)) continue;
    if (isDataRoot(base)) roots.push(base);
    for (const e of dirEntries(base)) {
      if (e.isDirectory() && !BROWSER_DIRS.has(e.name) && isDataRoot(join(base, e.name))) roots.push(join(base, e.name));
    }
  }
  return roots;
}

/**
 * What earlier installs left on this machine. Cheap enough to call on every
 * launch: only existence checks and one early-exit walk per candidate.
 */
export function detectLegacy(env: LegacyEnv = legacyEnv()): LegacyItem[] {
  const ci = env.platform === 'win32' || env.platform === 'darwin';
  const items: LegacyItem[] = [];
  const add = (kind: LegacyKind, path: string, label: string, dataRoots: string[] = []) => {
    if (inside(path, env.target, ci) || inside(env.target, path, ci)) return;
    items.push({ id: `${kind}:${path}`, kind, path, label, dataRoots });
  };
  for (const name of HOME_DIRS) {
    const path = join(env.home, name);
    if (isDir(path) && hasAnyFile(path)) add('data', path, name, findDataRoots(path));
  }
  for (const name of APPDATA_DIRS) {
    const path = join(env.appData, name);
    if (!isDir(path) || !hasAnyFile(path)) continue; // Electron recreates an empty one every launch
    add('app-data', path, name, findDataRoots(path));
  }
  if (env.platform === 'win32') {
    for (const name of INSTALL_NAMES) {
      const path = join(env.localAppData, 'Programs', name);
      if (isDir(path)) add('install', path, `${name} (installed app)`);
    }
    for (const name of UPDATER_DIRS) {
      const path = join(env.localAppData, name);
      if (isDir(path)) add('updater', path, name);
    }
  } else if (env.platform === 'darwin') {
    for (const name of INSTALL_NAMES) {
      const path = join(env.home, 'Applications', `${name}.app`);
      if (isDir(path)) add('install', path, `${name} (installed app)`);
    }
  }
  for (const e of dirEntries(env.tmp)) {
    if (e.isDirectory() && TEMP_PREFIXES.some((p) => e.name.startsWith(p))) add('temp', join(env.tmp, e.name), e.name);
  }
  return items;
}

/** Sessions and size for a dry run. Walks the folder, so not for launch-time use. */
export function describeItem(item: LegacyItem): { sessions: number; bytes: number } {
  let bytes = 0;
  const budget = { n: 200_000 };
  const walk = (dir: string) => {
    for (const e of dirEntries(dir)) {
      if (budget.n-- <= 0) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { try { bytes += statSync(p).size; } catch { /* vanished */ } }
    }
  };
  walk(item.path);
  const sessions = item.dataRoots.reduce((n, r) => n + dirEntries(join(r, 'sessions')).filter((e) => e.isFile() && e.name.endsWith('.json')).length, 0);
  return { sessions, bytes };
}

/** The pid of another running Nekko process using `root`, or null. */
export function liveInstance(root: string, ignorePids: number[] = []): number | null {
  try {
    const link = JSON.parse(readFileSync(join(root, CLI_LINK_FILE), 'utf8')) as { pid?: number; enabled?: boolean };
    if (!link.enabled || !Number.isInteger(link.pid) || link.pid! <= 0) return null;
    if (link.pid === process.pid || ignorePids.includes(link.pid!)) return null;
    try { process.kill(link.pid!, 0); return link.pid!; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' ? link.pid! : null; }
  } catch { return null; }
}

type Pairs = Array<[string, string]>;

function startsWithPath(value: string, from: string, ci: boolean): boolean {
  const v = ci ? value.toLowerCase() : value;
  const f = ci ? from.toLowerCase() : from;
  return v === f || (v.startsWith(f) && (value[from.length] === '\\' || value[from.length] === '/'));
}

function remap(value: unknown, pairs: Pairs, ci: boolean): unknown {
  if (typeof value === 'string') {
    for (const [from, to] of pairs) if (startsWithPath(value, from, ci)) return to + value.slice(from.length);
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => remap(v, pairs, ci));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remap(v, pairs, ci)]));
  return value;
}

const sortPairs = (pairs: Pairs): Pairs => [...pairs].sort((a, b) => b[0].length - a[0].length);

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')); } catch { return undefined; }
}

function writeJson(path: string, value: unknown, pretty = true): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeTextAtomic(path, JSON.stringify(value, null, pretty ? 2 : undefined));
}

/** Copy one JSON file, rewriting paths that pointed into the old root. Raw copy when it will not parse. */
function copyJson(src: string, dst: string, pairs: Pairs, ci: boolean): void {
  mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
  if (statSync(src).size > MAX_JSON_BYTES) return void copyFileSync(src, dst);
  const text = readFileSync(src, 'utf8');
  let value: unknown;
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { return void copyFileSync(src, dst); }
  writeTextAtomic(dst, JSON.stringify(remap(value, pairs, ci), null, text.includes('\n  ') ? 2 : undefined));
}

function copyMissing(src: string, dst: string, pairs: Pairs, ci: boolean): number {
  let copied = 0;
  mkdirSync(dst, { recursive: true, mode: 0o700 });
  for (const e of dirEntries(src)) {
    if (e.isSymbolicLink()) continue;
    const from = join(src, e.name), to = join(dst, e.name);
    if (e.isDirectory()) copied += copyMissing(from, to, pairs, ci);
    else if (e.isFile() && !existsSync(to)) {
      if (e.name.endsWith('.json')) copyJson(from, to, pairs, ci); else copyFileSync(from, to);
      copied++;
    }
  }
  return copied;
}

/** Move what the target lacks. Same-name files are conflicts and stay in the source. */
function moveMissing(src: string, dst: string, moved: string[], conflicts: string[]): void {
  mkdirSync(dst, { recursive: true, mode: 0o700 });
  for (const e of dirEntries(src)) {
    if (e.isSymbolicLink()) continue;
    const from = join(src, e.name), to = join(dst, e.name);
    if (!existsSync(to)) {
      try { renameSync(from, to); } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
        cpSync(from, to, { recursive: true });
        rmSync(from, { recursive: true, force: true });
      }
      moved.push(to);
    } else if (e.isDirectory() && isDir(to)) moveMissing(from, to, moved, conflicts);
    else conflicts.push(from);
  }
}

function jsonFilesUnder(path: string): string[] {
  if (isFile(path)) return path.endsWith('.json') ? [path] : [];
  return dirEntries(path).flatMap((e) => (e.isSymbolicLink() ? [] : jsonFilesUnder(join(path, e.name))));
}

const lines = (path: string): string[] => (isFile(path) ? readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => l.trim()) : []);

/** Union two JSONL logs by exact line, ordered by `ts` when every line has one. */
function unionLines(src: string, dst: string): number {
  const have = lines(dst);
  const seen = new Set(have);
  const added = lines(src).filter((l) => !seen.has(l) && (seen.add(l), true));
  if (!added.length) return 0;
  const all = [...have, ...added];
  const stamps = all.map((l) => { try { const ts = (JSON.parse(l) as { ts?: unknown }).ts; return typeof ts === 'number' ? ts : NaN; } catch { return NaN; } });
  const order = all.map((_, i) => i);
  if (stamps.every((t) => !Number.isNaN(t))) order.sort((a, b) => stamps[a] - stamps[b] || a - b);
  mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
  writeTextAtomic(dst, `${order.map((i) => all[i]).join('\n')}\n`);
  return added.length;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

const itemKey = (item: unknown): string => {
  if (typeof item === 'string') return item;
  if (isObj(item)) for (const k of ['id', 'path', 'name']) if (typeof item[k] === 'string') return `${k}:${(item[k] as string).toLowerCase()}`;
  return JSON.stringify(item);
};

function unionArray(a: unknown[], b: unknown[]): unknown[] {
  const seen = new Set(a.map(itemKey));
  return [...a, ...b.filter((x) => !seen.has(itemKey(x)) && (seen.add(itemKey(x)), true))];
}

/** Settings arrays that are lists of independent things; the rest follow "target wins". */
const UNION_KEYS = new Set(['providers', 'workspaces', 'favoriteModels', 'prompts', 'connectors', 'mcpServers']);

function mergeSettings(target: Json, source: Json): Json {
  const out: Json = { ...target };
  for (const [k, v] of Object.entries(source)) {
    if (!(k in out)) out[k] = v;
    else if (UNION_KEYS.has(k) && Array.isArray(out[k]) && Array.isArray(v)) out[k] = unionArray(out[k] as unknown[], v);
    else if (UNION_KEYS.has(k) && isObj(out[k]) && isObj(v)) out[k] = { ...v, ...(out[k] as Json) };
  }
  return out;
}

function mergeTokens(target: Json, source: Json): Json {
  const out: Json = { ...target };
  const stamp = (v: unknown) => (isObj(v) ? Number(v.obtainedAt ?? v.updatedAt ?? 0) : 0);
  for (const [k, v] of Object.entries(source)) if (!(k in out) || stamp(v) > stamp(out[k])) out[k] = v;
  return out;
}

/** A workspace pointing at a folder an earlier name used (`code/kotrain`) follows the rename when the new folder exists. */
function followRepoRename(path: string): string {
  if (existsSync(path)) return path;
  if (['agent-nekko', 'kotrain', 'open-paw'].includes(basename(path).toLowerCase())) {
    const candidate = join(dirname(path), 'nekko-agent');
    if (existsSync(candidate)) return candidate;
  }
  return path;
}

function fixWorkspaces(settings: Json): Json {
  if (!Array.isArray(settings.workspaces)) return settings;
  return { ...settings, workspaces: settings.workspaces.map((w) => (isObj(w) && typeof w.path === 'string' ? { ...w, path: followRepoRename(w.path) } : w)) };
}

const MODEL_TYPES = /^(chat|vision|embedding|image|audio|draft|unknown)$/;

export interface RootReport {
  source: string;
  sessions: number;
  usageRecords: number;
  files: string[];
  moved: string[];
  conflicts: string[];
}

export interface ConsolidateReport {
  backupDir: string;
  roots: RootReport[];
  /** Duplicate providers and folders folded after the merge (dropped id -> kept id). */
  deduped?: Plan;
}

/**
 * Fold duplicate folders (same path) and providers (same server, or the same
 * subscription account when the token store records the account) in a data
 * root, rewriting every reference. A subscription whose account cannot be
 * read is never folded on a guess. Ranked by usage so the id most history
 * already uses survives.
 */
export function dedupeProfile(root: string, platform: NodeJS.Platform = process.platform, extra: { accountOf?: AccountOf; keepProvider?: Record<string, string>; removeProviders?: string[] } = {}): Plan | undefined {
  const settings = readJson(join(root, 'settings.json'));
  if (!isObj(settings)) return undefined;
  const tokens = readJson(join(root, 'tokens.json'));
  const accountOf: AccountOf = (key) => extra.accountOf?.(key) ?? (isObj(tokens) && isObj(tokens[key]) && typeof tokens[key].accountId === 'string' ? tokens[key].accountId as string : undefined);
  const uses = new Map<string, number>();
  for (const line of lines(join(root, 'usage.jsonl'))) {
    try { const id = (JSON.parse(line) as { providerId?: string }).providerId; if (id) uses.set(id, (uses.get(id) ?? 0) + 1); } catch { /* skip */ }
  }
  for (const e of dirEntries(join(root, 'sessions'))) {
    if (!e.name.endsWith('.json')) continue;
    try {
      const s = JSON.parse(readFileSync(join(root, 'sessions', e.name), 'utf8')) as { workspaceId?: string };
      if (s.workspaceId) uses.set(s.workspaceId, (uses.get(s.workspaceId) ?? 0) + 1);
    } catch { /* skip */ }
  }
  const plan = planDedupe(settings as { providers?: ProviderLike[]; workspaces?: FolderLike[] }, { accountOf, prefer: (id) => uses.get(id) ?? 0, platform, keepProvider: extra.keepProvider });
  // Removing a duplicate of a provider that stays is a fold (its chats and
  // usage follow the survivor); removing a survivor removes its whole group.
  const removing = new Set(extra.removeProviders ?? []);
  for (const [from, to] of Object.entries(plan.providers)) {
    if (removing.has(to)) { removing.add(from); delete plan.providers[from]; }
    else removing.delete(from);
  }
  plan.removeProviders = [...removing];
  if (!Object.keys(plan.providers).length && !Object.keys(plan.folders).length && !plan.removeProviders.length) return plan;
  applyToDataRoot(root, plan);
  return plan;
}

function backupSmallFiles(dirs: Array<{ label: string; dir: string }>, backupDir: string): void {
  for (const { label, dir } of dirs) {
    if (!isDir(dir)) continue;
    for (const e of dirEntries(dir)) {
      const from = join(dir, e.name), to = join(backupDir, label, e.name);
      if (e.isFile()) { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); }
      else if (e.isDirectory() && (e.name === 'sessions' || e.name === 'memory')) cpSync(from, to, { recursive: true });
    }
  }
}

/** Merge every data root in `items` into `env.target`. Throws before changing anything if another Nekko process is running. */
export function consolidate(items: LegacyItem[], env: LegacyEnv = legacyEnv(), opts: { now?: number; ignorePids?: number[] } = {}): ConsolidateReport {
  const ci = env.platform === 'win32' || env.platform === 'darwin';
  const roots = [...new Set(items.flatMap((i) => i.dataRoots))].filter((r) => !same(r, env.target, ci));
  for (const dir of [...roots, env.target]) {
    const pid = liveInstance(dir, opts.ignorePids);
    if (pid) throw new Error(`Nekko Agent is still running (process ${pid}). Close it before merging old data.`);
  }
  const target = env.target;
  const backupDir = join(target, 'backups', `legacy-${new Date(opts.now ?? Date.now()).toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  backupSmallFiles([{ label: 'current', dir: target }, ...roots.map((r, i) => ({ label: `source-${i + 1}-${basename(r)}`, dir: r }))], backupDir);
  const reports = roots.map((root) => mergeRoot(root, target, ci));
  // Each install minted its own ids for the same folder and the same server;
  // fold those now so the merged profile does not list them twice.
  const deduped = dedupeProfile(target, env.platform);
  return { backupDir, roots: reports, deduped };
}

function mergeRoot(src: string, target: string, ci: boolean): RootReport {
  const report: RootReport = { source: src, sessions: 0, usageRecords: 0, files: [], moved: [], conflicts: [] };
  const pairs: Pairs = [[src, target]];
  const modelMoves: Pairs = [];
  const srcModels = join(src, 'models');
  const tgtModels = join(target, 'models');

  // Managed model folders first: the rest of the merge needs to know where they landed.
  if (isDir(srcModels)) {
    const library = readJson(join(srcModels, 'library.json')) as { models?: Record<string, { file?: string; name?: string; architecture?: string; readable?: boolean; hasProjector?: boolean }> } | undefined;
    for (const e of dirEntries(srcModels)) {
      if (e.name === 'library.json' || e.isSymbolicLink()) continue;
      const from = join(srcModels, e.name);
      if (!e.isDirectory() || e.name === '.companions' || MODEL_TYPES.test(e.name)) {
        const to = join(tgtModels, e.name);
        if (e.isDirectory()) moveMissing(from, to, report.moved, report.conflicts);
        else report.conflicts.push(from);
        continue;
      }
      let type = modelModality({ name: e.name });
      for (const m of Object.values(library?.models ?? {})) {
        if (m.file && startsWithPath(m.file, from, ci)) { const t = modelModality(m); if (type === 'chat' || t !== 'chat') type = t; }
      }
      const to = join(tgtModels, type, e.name);
      if (existsSync(to)) { report.conflicts.push(from); continue; }
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      try { renameSync(from, to); } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
        cpSync(from, to, { recursive: true });
        rmSync(from, { recursive: true, force: true });
      }
      modelMoves.push([from, to]);
      report.moved.push(to);
    }
  }
  const allPairs = sortPairs([...modelMoves, ...pairs]);

  for (const e of dirEntries(src)) {
    if (!e.isFile()) continue;
    const from = join(src, e.name), to = join(target, e.name);
    if (e.name === 'settings.json' || e.name === 'tokens.json') {
      const incoming = readJson(from);
      if (!isObj(incoming)) continue;
      const current = readJson(to);
      const mapped = remap(incoming, allPairs, ci) as Json;
      const merged = isObj(current)
        ? (e.name === 'settings.json' ? mergeSettings(current, mapped) : mergeTokens(current, mapped))
        : mapped;
      writeJson(to, e.name === 'settings.json' ? fixWorkspaces(merged) : merged);
      report.files.push(e.name);
    } else if (e.name.endsWith('.jsonl')) {
      const added = unionLines(from, to);
      if (e.name === 'usage.jsonl') report.usageRecords += added;
      if (added) report.files.push(e.name);
    } else if (e.name.endsWith('.json') && !SKIP_JSON.has(e.name)) {
      if (!existsSync(to)) { copyJson(from, to, allPairs, ci); report.files.push(e.name); continue; }
      const a = readJson(to), b = remap(readJson(from), allPairs, ci);
      if (Array.isArray(a) && Array.isArray(b)) { const u = unionArray(a, b); if (u.length !== a.length) { writeJson(to, u); report.files.push(e.name); } }
      else if (isObj(a) && isObj(b)) { const u = { ...b, ...a }; if (Object.keys(u).length !== Object.keys(a).length) { writeJson(to, u); report.files.push(e.name); } }
    }
  }

  const before = new Set(dirEntries(join(target, 'sessions')).map((e) => e.name));
  copyMissing(join(src, 'sessions'), join(target, 'sessions'), allPairs, ci);
  // Count chats, not the .commands.log files that ride along with some of them.
  report.sessions = dirEntries(join(target, 'sessions')).filter((e) => e.isFile() && e.name.endsWith('.json') && !before.has(e.name) && existsSync(join(src, 'sessions', e.name))).length;

  if (isDir(srcModels)) {
    const incoming = readJson(join(srcModels, 'library.json')) as { models?: Record<string, unknown> } | undefined;
    if (incoming?.models) {
      const lib = join(tgtModels, 'library.json');
      const current = (readJson(lib) as { models?: Record<string, unknown> } | undefined) ?? { models: {} };
      const mapped = remap(incoming.models, allPairs, ci) as Record<string, unknown>;
      writeJson(lib, { ...current, models: { ...mapped, ...(current.models ?? {}) } });
      report.files.push('models/library.json');
    }
  }

  for (const dir of ['memory', 'engine']) {
    const from = join(src, dir);
    if (!isDir(from)) continue;
    const moved: string[] = [];
    moveMissing(from, join(target, dir), moved, report.conflicts);
    for (const path of moved.flatMap(jsonFilesUnder)) copyJson(path, path, allPairs, ci);
    report.moved.push(...moved);
  }
  return report;
}

/** Files in a data root that the target does not already have. Empty means the root is safe to delete. */
export function unmerged(root: string, target: string): string[] {
  const missing: string[] = [];
  for (const e of dirEntries(root)) {
    const from = join(root, e.name), to = join(target, e.name);
    if (e.isFile()) {
      if (e.name.endsWith('.jsonl')) {
        const have = new Set(lines(to));
        if (lines(from).some((l) => !have.has(l))) missing.push(e.name);
      } else if (e.name === 'settings.json') {
        const a = readJson(from), b = readJson(to);
        if (isObj(a) && (!isObj(b) || !coversSettings(a, b))) missing.push(e.name);
      } else if (e.name === 'tokens.json') {
        const a = readJson(from), b = readJson(to);
        if (isObj(a) && (!isObj(b) || Object.keys(a).some((k) => !(k in b)))) missing.push(e.name);
      } else if (e.name.endsWith('.json') && !SKIP_JSON.has(e.name) && !existsSync(to)) missing.push(e.name);
    } else if (e.isDirectory() && e.name === 'sessions') {
      for (const f of dirEntries(from)) if (f.isFile() && !existsSync(join(to, f.name))) missing.push(`sessions/${f.name}`);
    } else if (e.isDirectory() && (e.name === 'models' || e.name === 'engine' || e.name === 'memory')) {
      const leftover = (dir: string, rel: string): string[] => dirEntries(dir).flatMap((f) => {
        const p = join(dir, f.name);
        if (f.isDirectory()) return leftover(p, `${rel}/${f.name}`);
        if (e.name === 'models' && rel === 'models' && f.name === 'library.json') return [];
        const counterpart = join(target, rel, f.name);
        return isFile(counterpart) && statSync(counterpart).size === statSync(p).size ? [] : [`${rel}/${f.name}`];
      });
      missing.push(...leftover(from, e.name));
    }
  }
  return missing;
}

function coversSettings(src: Json, dst: Json): boolean {
  const ids = (v: unknown) => new Set((Array.isArray(v) ? v : []).map(itemKey));
  // A provider folded into a duplicate after the merge is covered by the one it became.
  const folded = new Set<string>();
  if (Array.isArray(dst.providers)) {
    const keep = (dst.providers as ProviderLike[]).map((p) => providerIdentity(p));
    for (const p of (Array.isArray(src.providers) ? src.providers : []) as ProviderLike[]) if (p?.baseUrl && keep.includes(providerIdentity(p))) folded.add(itemKey(p));
  }
  for (const key of ['providers', 'mcpServers']) {
    if (key === 'providers' && Array.isArray(src[key])) { const have = ids(dst[key]); if ((src[key] as unknown[]).some((x) => !have.has(itemKey(x)) && !folded.has(itemKey(x)))) return false; continue; }
    if (Array.isArray(src[key])) { const have = ids(dst[key]); if ((src[key] as unknown[]).some((x) => !have.has(itemKey(x)))) return false; }
    else if (isObj(src[key]) && Object.keys(src[key] as Json).some((k) => !isObj(dst[key]) || !(k in (dst[key] as Json)))) return false;
  }
  return true;
}

export interface CleanupReport {
  removed: string[];
  kept: Array<{ path: string; reason: string }>;
  failed: Array<{ path: string; error: string }>;
}

/**
 * Delete what `consolidate` merged. A data folder is kept (with the reason) if
 * anything in it is not in the target; an install is uninstalled first when it
 * ships an uninstaller. `uninstall` is injectable so tests never run one.
 */
export function cleanup(items: LegacyItem[], env: LegacyEnv = legacyEnv(), opts: { uninstall?: (item: LegacyItem) => void } = {}): CleanupReport {
  const report: CleanupReport = { removed: [], kept: [], failed: [] };
  const ci = env.platform === 'win32' || env.platform === 'darwin';
  for (const item of items) {
    if (inside(item.path, env.target, ci) || inside(env.target, item.path, ci)) continue;
    const left = item.dataRoots.filter((r) => !same(r, env.target, ci)).flatMap((r) => unmerged(r, env.target).map((f) => `${basename(r)}/${f}`));
    if (left.length) { report.kept.push({ path: item.path, reason: `${left.length} item(s) not yet in ${env.target}, e.g. ${left.slice(0, 3).join(', ')}` }); continue; }
    try {
      if (item.kind === 'install') (opts.uninstall ?? defaultUninstall)(item);
      rmSync(item.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      report.removed.push(item.path);
    } catch (err) {
      report.failed.push({ path: item.path, error: (err as Error).message });
    }
  }
  return report;
}

/** Windows installs ship `Uninstall <name>.exe`; `/S` is silent and `_?=` makes it wait. Data is kept by its own default. */
function defaultUninstall(item: LegacyItem): void {
  if (process.platform !== 'win32') return;
  const exe = dirEntries(item.path).find((e) => e.isFile() && /^uninstall .*\.exe$/i.test(e.name));
  if (exe) spawnSync(join(item.path, exe.name), ['/S', `_?=${item.path}`], { stdio: 'ignore', timeout: 120_000 });
}

export interface SummaryRow {
  kind: LegacyKind | 'cache';
  /** One path, or a description when several items were folded into one row. */
  text: string;
  sessions: number;
  bytes: number;
  count: number;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * One row per thing a person would recognise. Temp leftovers come in the
 * hundreds (every test run leaves one), so they fold into a single row;
 * everything else keeps its own line.
 */
export function summarize(items: LegacyItem[], describe: (item: LegacyItem) => { sessions: number; bytes: number } = describeItem): SummaryRow[] {
  const rows: SummaryRow[] = [];
  const temp = items.filter((i) => i.kind === 'temp');
  for (const item of items) {
    if (item.kind === 'temp') continue;
    const d = describe(item);
    const cacheOnly = (item.kind === 'data' || item.kind === 'app-data') && !item.dataRoots.length;
    rows.push({ kind: cacheOnly ? 'cache' : item.kind, text: item.path, sessions: d.sessions, bytes: d.bytes, count: 1 });
  }
  if (temp.length) {
    const bytes = temp.reduce((n, i) => n + describe(i).bytes, 0);
    rows.push({ kind: 'temp', text: `${plural(temp.length, 'temporary folder')} in ${dirname(temp[0].path)}`, sessions: 0, bytes, count: temp.length });
  }
  return rows;
}

