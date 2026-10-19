import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeTextAtomic } from './secure-file.js';

/**
 * Folding duplicate providers and folders into one, everywhere they are named.
 *
 * Every earlier install minted its own provider id for the same subscription
 * and its own folder id for the same path, and a merge of those installs keeps
 * all of them: one Claude account showed up as four providers, `C:\code` as
 * four folders. The merge cannot tell them apart by id, so this decides by
 * what they point at and then rewrites the ids in sessions, usage and quota
 * history, so nothing that belonged to a dropped id is lost or mislabelled.
 */

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

export interface ProviderLike { id: string; kind?: string; baseUrl?: string; auth?: string; tokenKey?: string; accountId?: string; label?: string }
export interface FolderLike { id: string; path: string; name?: string }

/** How a token store says which account a sign-in belongs to, when it can. */
export type AccountOf = (tokenKey: string) => string | undefined;

const normUrl = (u?: string) => (u ?? '').trim().toLowerCase().replace(/\/+$/, '').replace(/\/v1$/, '').replace('://localhost', '://127.0.0.1');

/**
 * Two providers are the same when they reach the same place as the same
 * account. A subscription with no known account is grouped by kind alone only
 * when `sameAccount` says so (the caller checked the tokens); local servers are
 * grouped by address.
 */
export function providerIdentity(p: ProviderLike, accountOf?: AccountOf): string {
  const kind = (p.kind ?? '').toLowerCase();
  if (p.auth === 'subscription') {
    const account = p.accountId ?? (p.tokenKey ? accountOf?.(p.tokenKey) : undefined);
    return `${kind}|sub|${account ?? `token:${p.tokenKey ?? p.id}`}`;
  }
  // A provider that names no server is not a duplicate of anything; only
  // entries pointing at the same address can be folded.
  if (!p.baseUrl) return `id:${p.id}`;
  return `${kind}|${normUrl(p.baseUrl)}|${p.tokenKey ?? ''}`;
}

/** Folder identity: the resolved path, case-insensitive on Windows and macOS. */
export function folderIdentity(path: string, platform: NodeJS.Platform = process.platform): string {
  const p = resolve(path).replace(/[\\/]+$/, '');
  return platform === 'win32' || platform === 'darwin' ? p.toLowerCase() : p;
}

export interface Plan {
  /** Dropped id -> kept id. */
  providers: Record<string, string>;
  folders: Record<string, string>;
  /** Provider ids removed outright (not merged), e.g. a server the user chose to forget. */
  removeProviders: string[];
}

/**
 * Pick one survivor per group. `prefer` ranks ids (higher wins), typically by
 * how much history each has, so the id most chats already use is the one kept.
 */
export function planDedupe(
  settings: { providers?: ProviderLike[]; workspaces?: FolderLike[] },
  opts: { accountOf?: AccountOf; prefer?: (id: string) => number; platform?: NodeJS.Platform; keepProvider?: Record<string, string> } = {},
): Plan {
  const plan: Plan = { providers: {}, folders: {}, removeProviders: [] };
  const rank = opts.prefer ?? (() => 0);
  const group = <T extends { id: string }>(items: T[], key: (t: T) => string, out: Record<string, string>, pinned?: (k: string) => string | undefined) => {
    const groups = new Map<string, T[]>();
    for (const it of items) { const k = key(it); groups.set(k, [...(groups.get(k) ?? []), it]); }
    for (const [k, members] of groups) {
      if (members.length < 2) continue;
      const pin = pinned?.(k);
      const keep = (pin && members.find((m) => m.id === pin)) || [...members].sort((a, b) => rank(b.id) - rank(a.id) || items.indexOf(a) - items.indexOf(b))[0];
      for (const m of members) if (m.id !== keep.id) out[m.id] = keep.id;
    }
  };
  const providers = settings.providers ?? [];
  const pins = new Map<string, string>();
  for (const [, keepId] of Object.entries(opts.keepProvider ?? {})) {
    const p = providers.find((x) => x.id === keepId);
    if (p) pins.set(providerIdentity(p, opts.accountOf), keepId);
  }
  group(providers, (p) => providerIdentity(p, opts.accountOf), plan.providers, (k) => pins.get(k));
  group(settings.workspaces ?? [], (f) => folderIdentity(f.path, opts.platform), plan.folders);
  return plan;
}

/** Rewrite ids inside any JSON value: exact-match strings, and `<provider>::<model>` keys. */
export function remapIds(value: unknown, plan: Plan): unknown {
  const map = { ...plan.providers, ...plan.folders };
  const one = (s: string): string => {
    if (map[s]) return map[s];
    const i = s.indexOf('::');
    if (i > 0 && plan.providers[s.slice(0, i)]) return plan.providers[s.slice(0, i)] + s.slice(i);
    return s;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return one(v);
    if (Array.isArray(v)) {
      const mapped = v.map(walk);
      // A list of ids that now repeats (two folders folded into one) keeps one.
      return mapped.every((x) => typeof x === 'string') ? [...new Set(mapped as string[])] : mapped;
    }
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [one(k), walk(x)]));
    return v;
  };
  return walk(value);
}

/** Apply a plan to settings: drop folded/removed entries, rewrite references. */
export function applyToSettings(settings: Json, plan: Plan): Json {
  const dropped = new Set([...Object.keys(plan.providers), ...plan.removeProviders]);
  const droppedFolders = new Set(Object.keys(plan.folders));
  const next = remapIds(settings, plan) as Json;
  if (Array.isArray(settings.providers)) next.providers = (settings.providers as ProviderLike[]).filter((p) => !dropped.has(p.id)).map((p) => remapIds(p, plan));
  if (Array.isArray(settings.workspaces)) next.workspaces = (settings.workspaces as FolderLike[]).filter((w) => !droppedFolders.has(w.id));
  if (Array.isArray(next.favoriteModels)) next.favoriteModels = (next.favoriteModels as string[]).filter((k) => !plan.removeProviders.some((id) => k.startsWith(`${id}::`)));
  if (typeof settings.defaultProviderId === 'string' && plan.removeProviders.includes(settings.defaultProviderId)) { delete next.defaultProviderId; delete next.defaultModelId; }
  return next;
}

export interface RepairReport { sessions: number; usage: number; files: string[] }

/** Rewrite every file under a data root that names an id in the plan. */
export function applyToDataRoot(root: string, plan: Plan): RepairReport {
  const report: RepairReport = { sessions: 0, usage: 0, files: [] };
  const settingsPath = join(root, 'settings.json');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Json;
  writeTextAtomic(settingsPath, JSON.stringify(applyToSettings(settings, plan), null, 2));
  report.files.push('settings.json');
  const ids = [...Object.keys(plan.providers), ...Object.keys(plan.folders)];
  if (!ids.length) return report;
  const mentions = (text: string) => ids.some((id) => text.includes(`"${id}"`) || text.includes(`"${id}::`));
  const jsonl = (name: string) => {
    const path = join(root, name);
    let text: string;
    try { text = readFileSync(path, 'utf8'); } catch { return 0; }
    if (!mentions(text)) return 0;
    let changed = 0;
    const out = text.split(/\r?\n/).map((line) => {
      if (!line.trim() || !mentions(line)) return line;
      try { const next = JSON.stringify(remapIds(JSON.parse(line), plan)); if (next !== line) changed++; return next; } catch { return line; }
    });
    writeTextAtomic(path, out.join('\n'));
    report.files.push(name);
    return changed;
  };
  report.usage = jsonl('usage.jsonl');
  for (const f of ['quota-history.jsonl', 'replies.jsonl']) jsonl(f);
  for (const f of ['tasks.json', 'agent-watches.json', 'training.json', 'design.json', 'dojo.json']) {
    const path = join(root, f);
    try { const text = readFileSync(path, 'utf8'); if (mentions(text)) { writeTextAtomic(path, JSON.stringify(remapIds(JSON.parse(text), plan), null, 2)); report.files.push(f); } } catch { /* absent */ }
  }
  let entries: string[] = [];
  try { entries = readdirSync(join(root, 'sessions')); } catch { /* none */ }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const path = join(root, 'sessions', name);
    const text = readFileSync(path, 'utf8');
    if (!mentions(text)) continue;
    try { writeTextAtomic(path, JSON.stringify(remapIds(JSON.parse(text), plan), null, text.includes('\n  ') ? 2 : undefined)); report.sessions++; } catch { /* leave an unreadable file alone */ }
  }
  return report;
}
