/**
 * Chat groups: a group the user makes ("Frontend fixes", or just a colour) so
 * chats of the same kind sit together wherever the Agents panel files them.
 * Pure helpers, apart from the view so the clustering can be tested on its own.
 *
 * A group has an id (`g_...`), an optional name and a colour. The defined groups
 * live in a per-window preference (`nekko.chatGroups`) and a chat stores its
 * group's id in `chatGroup`. Chats from before groups had ids store a name
 * instead: a stored value that matches no id is a legacy group, resolved by
 * matching a defined group's name (ignoring case) or shown as that name alone.
 */

import { agentGroupRows } from './agentGroupRows.js';

/** The longest group name kept. */
export const MAX_CHAT_GROUP_LENGTH = 40;

/** What a typed name is saved as: trimmed, runs of spaces folded, capped. Null when nothing is left. */
export function normalizeChatGroup(name: string | null | undefined): string | null {
  const cleaned = (name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHAT_GROUP_LENGTH).trim();
  return cleaned || null;
}

/** The key two spellings of one name share. */
export function chatGroupKey(name: string): string {
  return name.toLocaleLowerCase();
}

type Grouped = { chatGroup?: string | null };

/** A palette index, or a colour the user picked as `#rrggbb` (their data, not a style token). */
export type ChatGroupColor = number | string;

/** A group the user made. `color` indexes `CHAT_GROUP_COLORS` or is a hex; a name is optional. */
export type DefinedChatGroup = { id: string; name?: string; color?: ChatGroupColor };

// --- Ids ---

const ID_PATTERN = /^g_[a-z0-9]{6,32}$/;

/** Whether a stored `chatGroup` value looks like a group id rather than a legacy name. */
export function isChatGroupId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

/** A fresh group id: `g_` and ten random lower-case letters or digits. */
export function newChatGroupId(): string {
  const bytes = new Uint8Array(10);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return 'g_' + [...bytes].map((b) => (b % 36).toString(36)).join('');
}

// --- Resolving a stored value ---

/**
 * A group as the UI sees it. `value` is what a chat stores (`id`, or the name of
 * a legacy group not yet given an id); `key` tells groups apart (the id, else
 * `n:` and the lower-case name); `name` is null for an unnamed group.
 */
export type ChatGroup = { key: string; id: string | null; value: string; name: string | null; color: ChatGroupColor; defined: boolean };

export type ChatGroupIndex = {
  /** Every group: the defined ones, then those only chats mention. */
  groups: ChatGroup[];
  /** The group a stored `chatGroup` value means; null for none. */
  resolve: (raw: string | null | undefined) => ChatGroup | null;
};

const compareText = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });

/** Resolve stored values against the defined groups (ids first, then names ignoring case, else a legacy group). */
export function buildChatGroupIndex(sessions: ReadonlyArray<Grouped>, defined: ReadonlyArray<DefinedChatGroup>): ChatGroupIndex {
  const byId = new Map<string, ChatGroup>();
  const byName = new Map<string, ChatGroup>();
  const extra = new Map<string, ChatGroup>();
  for (const d of defined) {
    const name = normalizeChatGroup(d.name);
    const g: ChatGroup = { key: d.id, id: d.id, value: d.id, name, color: parseChatGroupColor(d.color) ?? defaultChatGroupColor(name ?? d.id), defined: true };
    byId.set(d.id, g);
    if (name && !byName.has(chatGroupKey(name))) byName.set(chatGroupKey(name), g);
  }
  const resolve = (raw: string | null | undefined): ChatGroup | null => {
    const v = (raw ?? '').trim();
    if (!v) return null;
    const hit = byId.get(v);
    if (hit) return hit;
    if (isChatGroupId(v)) {
      // An id this window has no entry for (made on another device): an unnamed group.
      if (!extra.has(v)) extra.set(v, { key: v, id: v, value: v, name: null, color: defaultChatGroupColor(v), defined: false });
      return extra.get(v)!;
    }
    const name = normalizeChatGroup(v)!;
    const named = byName.get(chatGroupKey(name));
    if (named) return named;
    const key = 'n:' + chatGroupKey(name);
    if (!extra.has(key)) extra.set(key, { key, id: null, value: name, name, color: defaultChatGroupColor(name), defined: false });
    return extra.get(key)!;
  };
  for (const s of sessions) resolve(s.chatGroup);
  return { groups: [...byId.values(), ...extra.values()], resolve };
}

/** What a group is called: its name, else "Untitled group" and its colour's name when it is a preset. */
export function chatGroupLabel(group: Pick<ChatGroup, 'name' | 'color'>): string {
  return group.name ?? untitledChatGroupLabel(group.color);
}

export function untitledChatGroupLabel(color: ChatGroupColor): string {
  return typeof color === 'number' && CHAT_GROUP_COLORS[color] ? `Untitled group (${CHAT_GROUP_COLORS[color].label})` : 'Untitled group';
}

/** Groups A to Z by name (ignoring case); unnamed ones follow, in palette order. */
export function sortChatGroups<G extends Pick<ChatGroup, 'name' | 'color' | 'key'>>(groups: ReadonlyArray<G>): G[] {
  const rank = (g: G) => (typeof g.color === 'number' ? g.color : CHAT_GROUP_COLORS.length);
  return [...groups].sort((a, b) => {
    if (a.name && b.name) return compareText(a.name, b.name);
    if (a.name || b.name) return a.name ? -1 : 1;
    return rank(a) - rank(b) || a.key.localeCompare(b.key);
  });
}

/** Some chats that share a group, in the order they were given. `key` and `group` are null for the chats with no group. */
export type ChatGroupCluster<T> = { key: string | null; group: ChatGroup | null; items: T[]; /** How many entries the cluster holds, before paging. */ total: number };

/**
 * Gather entries (already in the order the view chose) by chat group. A cluster
 * sits where its first, best-sorted entry was; inside a cluster the order is
 * kept; the entries with no group come last, in their own order. With no group
 * on any entry the result is the one ungrouped cluster, so nothing changes.
 */
export function clusterByChatGroup<T>(
  entries: ReadonlyArray<T>,
  groupOf: (entry: T) => string | null | undefined,
  resolve: ChatGroupIndex['resolve'] = buildChatGroupIndex([], []).resolve,
): Array<ChatGroupCluster<T>> {
  const clusters = new Map<string, ChatGroupCluster<T>>();
  const ungrouped: T[] = [];
  for (const entry of entries) {
    const group = resolve(groupOf(entry));
    if (!group) { ungrouped.push(entry); continue; }
    const cluster = clusters.get(group.key);
    if (cluster) { cluster.items.push(entry); cluster.total += 1; }
    else clusters.set(group.key, { key: group.key, group, items: [entry], total: 1 });
  }
  const result = [...clusters.values()];
  if (ungrouped.length > 0) result.push({ key: null, group: null, items: ungrouped, total: ungrouped.length });
  return result;
}

/**
 * Page clusters like a flat list: the first rows of the clustered order up to
 * the limit, unless expanded, and the entry that `isKept` (the open chat)
 * always stays in reach, even when it sits in a later cluster. Clusters left
 * with no row on show are dropped.
 */
export function pageChatGroupClusters<T>(
  clusters: ReadonlyArray<ChatGroupCluster<T>>,
  expanded: boolean,
  isKept: (entry: T) => boolean,
): Array<ChatGroupCluster<T>> {
  const flat = clusters.flatMap((c) => c.items);
  const shown = new Set(agentGroupRows(flat, expanded, flat.findIndex(isKept)));
  if (shown.size === flat.length) return clusters.slice();
  return clusters
    .map((c) => ({ ...c, items: c.items.filter((item) => shown.has(item)) }))
    .filter((c) => c.items.length > 0);
}

/**
 * Save a chat group (null removes it) on each chat. One failure does not stop
 * the rest; the failures come back for the caller to report.
 */
export async function saveChatGroups<S>(
  ids: ReadonlyArray<string>,
  chatGroup: string | null,
  save: (id: string, patch: { chatGroup: string | null }) => Promise<S | null | undefined>,
  onSaved?: (id: string, saved: S) => void,
): Promise<Array<{ id: string; reason: unknown }>> {
  const results = await Promise.allSettled(ids.map(async (id) => {
    const saved = await save(id, { chatGroup });
    if (!saved) throw new Error('Chat no longer exists');
    onSaved?.(id, saved);
  }));
  return results.flatMap((r, i) => (r.status === 'rejected' ? [{ id: ids[i], reason: r.reason }] : []));
}

// --- Colours ---

/**
 * The colours a group can have: the board's zone tints (`--zone-tint-0` to `-5`,
 * mid tones that hold on light and dark themes and are none of them the accent).
 */
export const CHAT_GROUP_COLORS = [
  { label: 'Teal', token: '--zone-tint-0' },
  { label: 'Amber', token: '--zone-tint-1' },
  { label: 'Coral', token: '--zone-tint-2' },
  { label: 'Blue', token: '--zone-tint-3' },
  { label: 'Pink', token: '--zone-tint-4' },
  { label: 'Lime', token: '--zone-tint-5' },
] as const;

/** A hex colour as `#rrggbb` in lower case, from `#rgb`, `rgb`, `#rrggbb` or `rrggbb`; null for anything else. */
export function normalizeHexColor(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
  if (!m) return null;
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return `#${hex.toLowerCase()}`;
}

/** A saved or picked colour as it is kept: a palette index, or lower-case `#rrggbb`; null when it is neither. */
export function parseChatGroupColor(color: unknown): ChatGroupColor | null {
  if (typeof color === 'number') return Number.isInteger(color) && color >= 0 && color < CHAT_GROUP_COLORS.length ? color : null;
  return normalizeHexColor(color);
}

/** The CSS value of a group colour: a palette token, or the hex the user picked. */
export function chatGroupColorValue(color: ChatGroupColor): string {
  if (typeof color === 'string') return normalizeHexColor(color) ?? `var(${CHAT_GROUP_COLORS[0].token})`;
  return `var(${CHAT_GROUP_COLORS[color]?.token ?? CHAT_GROUP_COLORS[0].token})`;
}

/** The colour a group has until one is picked (groups from before colours were required): stable, from a seed such as its name. */
export function defaultChatGroupColor(seed: string): number {
  let hash = 0;
  for (const ch of chatGroupKey(seed)) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
  return hash % CHAT_GROUP_COLORS.length;
}

// --- Groups the user defined, which can have no chats yet ---

/** Where the defined groups are kept (a per-window preference, like the panel's view). */
export const DEFINED_CHAT_GROUPS_KEY = 'nekko.chatGroups';
/** Fired on `window` when a chat group or tag preference is saved, so every view of it re-reads. */
export const CHAT_GROUP_PREFS_EVENT = 'nekko-chat-group-prefs';

/** Normalised entries: each id and each name (ignoring case) once, in order; an entry needs a name or a colour. */
function uniqueGroups(groups: ReadonlyArray<DefinedChatGroup>): DefinedChatGroup[] {
  const ids = new Set<string>();
  const names = new Set<string>();
  return groups.flatMap((g) => {
    const name = normalizeChatGroup(g.name);
    const color = parseChatGroupColor(g.color);
    if (ids.has(g.id) || (!name && color === null)) return [];
    if (name && names.has(chatGroupKey(name))) return [];
    ids.add(g.id);
    if (name) names.add(chatGroupKey(name));
    return [{ id: g.id, ...(name ? { name } : {}), ...(color !== null ? { color } : {}) }];
  });
}

/**
 * Read a saved list. Entries are `{ id, name?, color }`. Older saves migrate:
 * `{ name, color? }` entries and the first version's plain names each get a new
 * id (`changed` says the list should be saved back so the ids stay put). The
 * chats of such a group keep storing its name, which still resolves to it.
 */
export function parseDefinedChatGroups(raw: string | null, makeId: () => string = newChatGroupId): { groups: DefinedChatGroup[]; changed: boolean } {
  if (!raw) return { groups: [], changed: false };
  try {
    const saved: unknown = JSON.parse(raw);
    if (!Array.isArray(saved)) return { groups: [], changed: false };
    let changed = false;
    const items = saved.flatMap((item): DefinedChatGroup[] => {
      if (typeof item === 'string') { changed = true; return [{ id: makeId(), name: item }]; }
      if (!item || typeof item !== 'object') return [];
      const { id, name, color } = item as { id?: unknown; name?: unknown; color?: unknown };
      const hasId = isChatGroupId(id);
      if (!hasId) changed = true;
      return [{ id: hasId ? id : makeId(), ...(typeof name === 'string' ? { name } : {}), ...(parseChatGroupColor(color) !== null ? { color: parseChatGroupColor(color)! } : {}) }];
    });
    return { groups: uniqueGroups(items), changed };
  } catch { return { groups: [], changed: false }; }
}

/** The saved groups, migrating an old list (and saving the migration) the first time. */
export function readDefinedChatGroups(): DefinedChatGroup[] {
  try {
    const { groups, changed } = parseDefinedChatGroups(localStorage.getItem(DEFINED_CHAT_GROUPS_KEY));
    if (changed) localStorage.setItem(DEFINED_CHAT_GROUPS_KEY, JSON.stringify(groups));
    return groups;
  } catch { return []; }
}

export function saveDefinedChatGroups(groups: ReadonlyArray<DefinedChatGroup>): void {
  try { localStorage.setItem(DEFINED_CHAT_GROUPS_KEY, JSON.stringify(groups)); } catch { /* private mode */ }
  announceChatGroupPrefs();
}

export function announceChatGroupPrefs(): void {
  try { window.dispatchEvent(new Event(CHAT_GROUP_PREFS_EVENT)); } catch { /* no window */ }
}

/**
 * The defined list with an entry for a group, and that entry. A legacy group
 * (a name chats store, or an id from another device) gets one here, keeping the
 * colour it shows with.
 */
export function ensureDefinedGroup(defined: ReadonlyArray<DefinedChatGroup>, group: ChatGroup, makeId: () => string = newChatGroupId): { defined: DefinedChatGroup[]; entry: DefinedChatGroup } {
  const existing = group.id === null ? undefined : defined.find((d) => d.id === group.id);
  if (existing) return { defined: [...defined], entry: existing };
  const entry: DefinedChatGroup = { id: group.id ?? makeId(), ...(group.name ? { name: group.name } : {}), color: group.color };
  return { defined: [...defined, entry], entry };
}

/**
 * Make a group. The colour is required (null comes back without one); the name
 * is optional. A name a defined group already has reuses that group and takes the colour.
 */
export function createChatGroup(defined: ReadonlyArray<DefinedChatGroup>, input: { name?: string | null; color: ChatGroupColor | null | undefined }, makeId: () => string = newChatGroupId): { defined: DefinedChatGroup[]; entry: DefinedChatGroup } | null {
  const color = parseChatGroupColor(input.color);
  if (color === null) return null;
  const name = normalizeChatGroup(input.name);
  const same = name ? defined.find((d) => d.name && chatGroupKey(normalizeChatGroup(d.name) ?? '') === chatGroupKey(name)) : undefined;
  if (same) {
    const entry = { ...same, color };
    return { defined: defined.map((d) => (d === same ? entry : d)), entry };
  }
  const entry: DefinedChatGroup = { id: makeId(), ...(name ? { name } : {}), color };
  return { defined: [...defined, entry], entry };
}

/** The defined groups that no chat, active or archived, is in: the empty buckets, A to Z. */
export function emptyChatGroups(defined: ReadonlyArray<DefinedChatGroup>, sessions: ReadonlyArray<Grouped>): ChatGroup[] {
  const index = buildChatGroupIndex(sessions, defined);
  const used = new Set(sessions.flatMap((s) => { const g = index.resolve(s.chatGroup); return g ? [g.key] : []; }));
  return sortChatGroups(index.groups.filter((g) => g.defined && !used.has(g.key)));
}

/** What assigning a group to chats stores: the group's id (made first when it was only a name), and the list to save. */
export function assignChatGroupPlan(defined: ReadonlyArray<DefinedChatGroup>, group: ChatGroup | null, makeId: () => string = newChatGroupId): { defined: DefinedChatGroup[]; value: string | null } {
  if (!group) return { defined: [...defined], value: null };
  const { defined: next, entry } = ensureDefinedGroup(defined, group, makeId);
  return { defined: next, value: entry.id };
}

/**
 * What editing a group (its name and colour together) changes: the new defined list, the chats to patch and the
 * value to give them (the group's id). A blank name leaves the group unnamed. The
 * group takes the `color` picked (a bad one is ignored), else keeps its own. A name another group has merges into it, which keeps its
 * own colour. Chats that stored the old name (or another id) move to the id.
 */
export function renameChatGroupPlan<S extends Grouped & { id: string }>(
  defined: ReadonlyArray<DefinedChatGroup>, sessions: ReadonlyArray<S>, group: ChatGroup, typed: string | null, makeId: () => string = newChatGroupId, picked?: ChatGroupColor | null,
): { defined: DefinedChatGroup[]; ids: string[]; value: string } {
  const name = normalizeChatGroup(typed);
  const color = parseChatGroupColor(picked) ?? group.color;
  const index = buildChatGroupIndex(sessions, defined);
  const withEntry = ensureDefinedGroup(defined, group, makeId);
  const other = name ? index.groups.find((g) => g.key !== group.key && g.name !== null && chatGroupKey(g.name) === chatGroupKey(name)) : undefined;
  let next: DefinedChatGroup[];
  let value: string;
  if (other) {
    const target = ensureDefinedGroup(withEntry.defined, other, makeId);
    next = target.defined.filter((d) => d.id !== withEntry.entry.id);
    value = target.entry.id;
  } else {
    value = withEntry.entry.id;
    next = withEntry.defined.map((d) => {
      if (d.id !== value) return d;
      const { name: _old, ...rest } = d;
      return { ...rest, ...(name ? { name } : {}), color };
    });
  }
  const ids = sessions.filter((s) => index.resolve(s.chatGroup)?.key === group.key && (s.chatGroup ?? '').trim() !== value).map((s) => s.id);
  return { defined: uniqueGroups(next), ids, value };
}

/** What deleting a group changes: its entry goes and its chats (archived too) lose the group. */
export function deleteChatGroupPlan<S extends Grouped & { id: string }>(
  defined: ReadonlyArray<DefinedChatGroup>, sessions: ReadonlyArray<S>, group: ChatGroup,
): { defined: DefinedChatGroup[]; ids: string[] } {
  const index = buildChatGroupIndex(sessions, defined);
  return { defined: defined.filter((d) => d.id !== group.id), ids: sessions.filter((s) => index.resolve(s.chatGroup)?.key === group.key).map((s) => s.id) };
}

// --- Saved custom colours ---

/** Where the custom colours the user has used are kept, next to the group prefs. */
export const SAVED_CUSTOM_COLORS_KEY = 'nekko.chatGroupColors';
/** How many custom colours are kept; the oldest go first. */
export const MAX_SAVED_CUSTOM_COLORS = 10;

/** Read a saved list of hex colours: valid ones only, lower case, once each, newest first, at most the cap. */
export function parseSavedCustomColors(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const saved: unknown = JSON.parse(raw);
    return Array.isArray(saved) ? dedupeColors(saved.map(normalizeHexColor)) : [];
  } catch { return []; }
}

function dedupeColors(colors: ReadonlyArray<string | null>, skip: ReadonlyArray<string> = []): string[] {
  const seen = new Set(skip.map((c) => c.toLowerCase()));
  const out: string[] = [];
  for (const c of colors) {
    if (c === null || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out.slice(0, MAX_SAVED_CUSTOM_COLORS);
}

/**
 * The list with a colour put first, ignoring case, the oldest dropped past the cap.
 * An invalid hex, or one a preset already is (`presets`, as hex), changes nothing.
 */
export function addSavedCustomColor(saved: ReadonlyArray<string>, color: string, presets: ReadonlyArray<string> = []): string[] {
  const hex = normalizeHexColor(color);
  if (!hex || presets.some((p) => p.toLowerCase() === hex)) return [...saved];
  return dedupeColors([hex, ...saved.map(normalizeHexColor)]);
}

/** The list without a colour, ignoring case. */
export function removeSavedCustomColor(saved: ReadonlyArray<string>, color: string): string[] {
  const hex = normalizeHexColor(color);
  return saved.filter((c) => normalizeHexColor(c) !== hex);
}

export function readSavedCustomColors(): string[] {
  try { return parseSavedCustomColors(localStorage.getItem(SAVED_CUSTOM_COLORS_KEY)); } catch { return []; }
}

export function saveSavedCustomColors(colors: ReadonlyArray<string>): void {
  try { localStorage.setItem(SAVED_CUSTOM_COLORS_KEY, JSON.stringify(colors)); } catch { /* private mode */ }
}

/** Remember a custom colour that was committed (a group made with it, or a colour applied); returns the new list. */
export function rememberCustomColor(color: ChatGroupColor, presets: ReadonlyArray<string> = []): string[] {
  const next = typeof color === 'string' ? addSavedCustomColor(readSavedCustomColors(), color, presets) : readSavedCustomColors();
  if (typeof color === 'string') saveSavedCustomColors(next);
  return next;
}
