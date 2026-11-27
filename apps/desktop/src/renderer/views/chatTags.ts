/**
 * Chat tags and the group/tag picker's pure logic: tag normalisation, the known
 * tags, toggling tags across several chats, the picker's sections and search,
 * and the parts of the chat header's breadcrumb. Groups are in `chatGroups.ts`.
 */

import { CHAT_GROUP_PREFS_EVENT, announceChatGroupPrefs, chatGroupLabel, sortChatGroups, type ChatGroup } from './chatGroups.js';

/** The longest tag kept. */
export const MAX_CHAT_TAG_LENGTH = 32;

/** What a typed tag is saved as: leading #s dropped, trimmed, inner spaces become dashes, capped. Null when nothing is left. */
export function normalizeChatTag(raw: string | null | undefined): string | null {
  const cleaned = (raw ?? '').trim().replace(/^[#\s]+/, '').replace(/\s+/g, '-').slice(0, MAX_CHAT_TAG_LENGTH).replace(/-+$/, '');
  return cleaned || null;
}

/** The key two spellings of one tag share. */
export const chatTagKey = (tag: string): string => tag.toLocaleLowerCase();

const compareText = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });

/** A chat's tags as they are kept: normalised, each once ignoring case (the first spelling stays), in order. */
export function normalizeChatTags(tags: ReadonlyArray<unknown> | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags ?? []) {
    const tag = typeof t === 'string' ? normalizeChatTag(t) : null;
    if (!tag || seen.has(chatTagKey(tag))) continue;
    seen.add(chatTagKey(tag));
    out.push(tag);
  }
  return out;
}

type Tagged = { tags?: string[] | null };

/** Every tag in use or kept in the tag list, once each ignoring case (a chat's spelling wins), A to Z. */
export function knownChatTags(sessions: ReadonlyArray<Tagged>, stored: ReadonlyArray<string> = []): string[] {
  return normalizeChatTags([...sessions.flatMap((s) => s.tags ?? []), ...stored]).sort(compareText);
}

/** The list with a tag added (a spelling already there stays). */
export function addStoredChatTag(stored: ReadonlyArray<string>, tag: string): string[] {
  return normalizeChatTags([...stored, tag]);
}

/** How many of the chats carry a tag. */
export function chatTagState(chats: ReadonlyArray<Tagged>, tag: string): 'all' | 'some' | 'none' {
  const has = chats.filter((c) => (c.tags ?? []).some((t) => chatTagKey(t) === chatTagKey(tag))).length;
  return has === 0 ? 'none' : has === chats.length ? 'all' : 'some';
}

/**
 * Toggle a tag over one or several chats: when every chat has it, it comes off
 * all of them; otherwise it goes on all of them. One new tag list per chat, in
 * order; a chat whose tags do not change comes back as null.
 */
export function toggleChatTag(chats: ReadonlyArray<Tagged>, tag: string): Array<string[] | null> {
  const name = normalizeChatTag(tag);
  if (!name || chats.length === 0) return chats.map(() => null);
  const remove = chatTagState(chats, name) === 'all';
  return chats.map((c) => {
    const current = normalizeChatTags(c.tags);
    const has = current.some((t) => chatTagKey(t) === chatTagKey(name));
    if (remove) return has ? current.filter((t) => chatTagKey(t) !== chatTagKey(name)) : null;
    return has ? null : [...current, name];
  });
}

// --- Saved tag list: tags that exist before any chat uses them ---

export const CHAT_TAGS_KEY = 'nekko.chatTags';

export function parseStoredChatTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const saved: unknown = JSON.parse(raw);
    return Array.isArray(saved) ? normalizeChatTags(saved) : [];
  } catch { return []; }
}

export function readStoredChatTags(): string[] {
  try { return parseStoredChatTags(localStorage.getItem(CHAT_TAGS_KEY)); } catch { return []; }
}

export function saveStoredChatTags(tags: ReadonlyArray<string>): void {
  try { localStorage.setItem(CHAT_TAGS_KEY, JSON.stringify(normalizeChatTags(tags))); } catch { /* private mode */ }
  announceChatGroupPrefs();
}

export { CHAT_GROUP_PREFS_EVENT };

// --- The picker ---

export type PickerSections = { groups: ChatGroup[]; tags: string[] };

/** Whether a search matches: every word of it is somewhere in the text, ignoring case. A leading # is ignored. */
export function matchesPickerQuery(text: string, query: string): boolean {
  const words = query.toLocaleLowerCase().replace(/#/g, ' ').split(/\s+/).filter(Boolean);
  const haystack = text.toLocaleLowerCase();
  return words.every((w) => haystack.includes(w));
}

/** The picker's two sections: groups (named A to Z, then unnamed ones) and tags (A to Z), filtered by the search. */
export function pickerSections(groups: ReadonlyArray<ChatGroup>, tags: ReadonlyArray<string>, query = ''): PickerSections {
  return {
    groups: sortChatGroups(groups).filter((g) => matchesPickerQuery(chatGroupLabel(g), query)),
    tags: [...tags].sort(compareText).filter((t) => matchesPickerQuery(t, query)),
  };
}

/** One keyboard-reachable row of the picker, in order: Create first, then No group, the groups, the tags. */
export type PickerOption =
  | { kind: 'create' }
  | { kind: 'no-group' }
  | { kind: 'group'; group: ChatGroup }
  | { kind: 'tag'; tag: string };

export function pickerOptions(sections: PickerSections, showNoGroup: boolean): PickerOption[] {
  return [
    { kind: 'create' },
    ...(showNoGroup ? [{ kind: 'no-group' } as const] : []),
    ...sections.groups.map((group): PickerOption => ({ kind: 'group', group })),
    ...sections.tags.map((tag): PickerOption => ({ kind: 'tag', tag })),
  ];
}

/** Arrow-key movement over `count` options, wrapping round. From none (-1), down goes to the first and up to the last. */
export function movePickerIndex(index: number, step: 1 | -1, count: number): number {
  if (count <= 0) return 0;
  if (index < 0) return step === 1 ? 0 : count - 1;
  return (index + step + count) % count;
}

// --- Cards and the header breadcrumb ---

/** The tags a quiet row has room for, and how many are left out (shown as "+N"). */
export function visibleChatTags(tags: ReadonlyArray<string> | null | undefined, max = 3): { shown: string[]; more: number } {
  const all = normalizeChatTags(tags);
  return { shown: all.slice(0, max), more: Math.max(0, all.length - max) };
}

export type BreadcrumbPart = { kind: 'group'; group: ChatGroup } | { kind: 'tags'; tags: string[] } | { kind: 'title'; title: string };

/** The header's crumb: group, then tags, then the title; a part with no value is left out. */
export function breadcrumbParts(input: { group: ChatGroup | null; tags: ReadonlyArray<string> | null | undefined; title: string }): BreadcrumbPart[] {
  const tags = normalizeChatTags(input.tags);
  return [
    ...(input.group ? [{ kind: 'group', group: input.group } as const] : []),
    ...(tags.length > 0 ? [{ kind: 'tags', tags } as const] : []),
    { kind: 'title', title: input.title },
  ];
}
