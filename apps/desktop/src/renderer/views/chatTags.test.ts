import { describe, expect, it } from 'vitest';
import '../tests/browserGlobals.js';
import { buildChatGroupIndex, type DefinedChatGroup } from './chatGroups.js';
import {
  CHAT_TAGS_KEY, MAX_CHAT_TAG_LENGTH, addStoredChatTag, breadcrumbParts, chatTagState, knownChatTags, matchesPickerQuery, movePickerIndex, normalizeChatTag, normalizeChatTags,
  parseStoredChatTags, pickerOptions, pickerSections, readStoredChatTags, saveStoredChatTags, toggleChatTag, visibleChatTags,
} from './chatTags.js';

const group = (id: string, name: string | null, color: number | string = 0) => buildChatGroupIndex([], [{ id, ...(name ? { name } : {}), color } as DefinedChatGroup]).groups[0];

describe('normalizeChatTag', () => {
  it('trims, drops leading #s, turns inner spaces into dashes and caps the length', () => {
    expect(normalizeChatTag('  #bug fix  ')).toBe('bug-fix');
    expect(normalizeChatTag('##x')).toBe('x');
    expect(normalizeChatTag('x'.repeat(80))).toHaveLength(MAX_CHAT_TAG_LENGTH);
    expect(normalizeChatTag('a'.repeat(31) + ' b')).toBe('a'.repeat(31));
  });
  it('is null for nothing', () => {
    for (const none of ['', '  ', '#', '# #', null, undefined]) expect(normalizeChatTag(none)).toBeNull();
  });
});

describe('normalizeChatTags', () => {
  it('keeps each tag once ignoring case, the first spelling, in order, and drops the rest', () => {
    expect(normalizeChatTags(['Bug', ' #bug ', 'API', '', 3, null, 'api', 'ui'])).toEqual(['Bug', 'API', 'ui']);
    expect(normalizeChatTags(undefined)).toEqual([]);
  });
});

describe('known tags', () => {
  it('are every chat\'s tags plus the saved list, once each, A to Z ignoring case', () => {
    expect(knownChatTags([{ tags: ['zeta', 'Alpha'] }, { tags: ['alpha', 'beta'] }, {}, { tags: null }], ['Gamma', 'ZETA'])).toEqual(['Alpha', 'beta', 'Gamma', 'zeta']);
  });
  it('lets a saved tag exist before any chat uses it', () => {
    expect(knownChatTags([], ['later'])).toEqual(['later']);
  });
  it('adds to the saved list once, keeping a spelling already there', () => {
    expect(addStoredChatTag(['Docs'], ' #docs ')).toEqual(['Docs']);
    expect(addStoredChatTag(['Docs'], 'api')).toEqual(['Docs', 'api']);
  });
  it('reads and saves the list in storage, dropping junk', () => {
    expect(parseStoredChatTags(null)).toEqual([]);
    expect(parseStoredChatTags('nope')).toEqual([]);
    expect(parseStoredChatTags('{"a":1}')).toEqual([]);
    expect(parseStoredChatTags(JSON.stringify(['a', 'A', '#b', 3, ' ']))).toEqual(['a', 'b']);
    localStorage.removeItem(CHAT_TAGS_KEY);
    saveStoredChatTags(['x', 'X', 'y']);
    expect(localStorage.getItem(CHAT_TAGS_KEY)).toBe('["x","y"]');
    expect(readStoredChatTags()).toEqual(['x', 'y']);
    localStorage.removeItem(CHAT_TAGS_KEY);
  });
});

describe('toggling a tag over chats', () => {
  it('adds it to one chat, and removes it when the chat has it, ignoring case', () => {
    expect(toggleChatTag([{ tags: ['a'] }], 'b')).toEqual([['a', 'b']]);
    expect(toggleChatTag([{ tags: ['a', 'B'] }], 'b')).toEqual([['a']]);
    expect(toggleChatTag([{}], '#new')).toEqual([['new']]);
  });
  it('adds it to every chat that lacks it when only some have it', () => {
    const chats = [{ tags: ['x'] }, { tags: ['y'] }, {}];
    expect(chatTagState(chats, 'x')).toBe('some');
    expect(toggleChatTag(chats, 'x')).toEqual([null, ['y', 'x'], ['x']]);
  });
  it('removes it from all of them when every chat has it', () => {
    const chats = [{ tags: ['x', 'k'] }, { tags: ['X'] }];
    expect(chatTagState(chats, 'x')).toBe('all');
    expect(toggleChatTag(chats, 'x')).toEqual([['k'], []]);
  });
  it('does nothing for an empty tag or no chats', () => {
    expect(toggleChatTag([{ tags: ['a'] }], '  #  ')).toEqual([null]);
    expect(toggleChatTag([], 'a')).toEqual([]);
    expect(chatTagState([{}], 'a')).toBe('none');
  });
});

describe('the picker', () => {
  const groups = [group('g_zeta0001', 'Zeta', 1), group('g_alpha001', 'alpha', 2), group('g_blank002', null, 2), group('g_blank001', null, 0), group('g_beta0001', 'Beta', 3)];
  it('sorts groups A to Z ignoring case, unnamed ones after in palette order, and tags A to Z', () => {
    const s = pickerSections(groups, ['zed', 'Alpha', 'beta']);
    expect(s.groups.map((g) => g.key)).toEqual(['g_alpha001', 'g_beta0001', 'g_zeta0001', 'g_blank001', 'g_blank002']);
    expect(s.tags).toEqual(['Alpha', 'beta', 'zed']);
  });
  it('filters by a search of words, ignoring case and a leading #, across names and an unnamed group\'s label', () => {
    expect(matchesPickerQuery('Frontend fixes', 'front FIX')).toBe(true);
    expect(matchesPickerQuery('Frontend fixes', 'back')).toBe(false);
    expect(matchesPickerQuery('bug', '#bug')).toBe(true);
    expect(matchesPickerQuery('anything', '')).toBe(true);
    const s = pickerSections(groups, ['bug', 'docs'], 'teal');
    expect(s.groups.map((g) => g.key)).toEqual(['g_blank001']);
    expect(s.tags).toEqual([]);
    expect(pickerSections(groups, ['bug', 'docs'], '#do').tags).toEqual(['docs']);
  });
  it('lists the options in keyboard order: Create first, then No group (only when a chat has a group), the groups, the tags', () => {
    const s = pickerSections(groups.slice(0, 2), ['t']);
    expect(pickerOptions(s, false).map((o) => o.kind)).toEqual(['create', 'group', 'group', 'tag']);
    expect(pickerOptions(s, true).map((o) => o.kind)).toEqual(['create', 'no-group', 'group', 'group', 'tag']);
  });
  it('wraps the arrow keys round', () => {
    expect(movePickerIndex(0, -1, 4)).toBe(3);
    expect(movePickerIndex(3, 1, 4)).toBe(0);
    expect(movePickerIndex(1, 1, 4)).toBe(2);
    expect(movePickerIndex(0, 1, 0)).toBe(0);
    // From none highlighted: down to the first, up to the last.
    expect(movePickerIndex(-1, 1, 4)).toBe(0);
    expect(movePickerIndex(-1, -1, 4)).toBe(3);
  });
});

describe('card chips and breadcrumb parts', () => {
  it('shows a few tags and counts the rest', () => {
    expect(visibleChatTags(['a', 'b'])).toEqual({ shown: ['a', 'b'], more: 0 });
    expect(visibleChatTags(['a', 'b', 'c', 'd', 'e'])).toEqual({ shown: ['a', 'b', 'c'], more: 2 });
    expect(visibleChatTags(['a', 'A', ' '])).toEqual({ shown: ['a'], more: 0 });
    expect(visibleChatTags(undefined)).toEqual({ shown: [], more: 0 });
    expect(visibleChatTags(['a', 'b', 'c'], 2)).toEqual({ shown: ['a', 'b'], more: 1 });
  });
  it('is group / tags / title, leaving out a part with no value', () => {
    const g = group('g_docs0001', 'Docs');
    const kinds = (input: Parameters<typeof breadcrumbParts>[0]) => breadcrumbParts(input).map((p) => p.kind);
    expect(kinds({ group: g, tags: ['a'], title: 'T' })).toEqual(['group', 'tags', 'title']);
    expect(kinds({ group: g, tags: [], title: 'T' })).toEqual(['group', 'title']);
    expect(kinds({ group: null, tags: ['a'], title: 'T' })).toEqual(['tags', 'title']);
    expect(kinds({ group: null, tags: undefined, title: 'T' })).toEqual(['title']);
    expect(kinds({ group: null, tags: [' ', '#'], title: 'T' })).toEqual(['title']);
  });
});
