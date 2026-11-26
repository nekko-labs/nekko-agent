import { describe, expect, it, vi } from 'vitest';
import '../tests/browserGlobals.js';
import { AGENT_GROUP_LIMIT } from './agentGroupRows.js';
import { compareCards } from './agentPanelView.js';
import {
  buildChatGroupIndex, chatGroupLabel, clusterByChatGroup, isChatGroupId, newChatGroupId, normalizeChatGroup, pageChatGroupClusters, saveChatGroups, MAX_CHAT_GROUP_LENGTH, sortChatGroups,
  assignChatGroupPlan, createChatGroup, deleteChatGroupPlan, emptyChatGroups, ensureDefinedGroup, parseDefinedChatGroups, renameChatGroupPlan, untitledChatGroupLabel,
  MAX_SAVED_CUSTOM_COLORS, SAVED_CUSTOM_COLORS_KEY, addSavedCustomColor, parseSavedCustomColors, readSavedCustomColors, rememberCustomColor, removeSavedCustomColor,
  CHAT_GROUP_COLORS, normalizeHexColor, parseChatGroupColor, chatGroupColorValue, defaultChatGroupColor, type DefinedChatGroup,
} from './chatGroups.js';

/** Predictable ids for the tests: g_test0001, g_test0002, ... */
const counter = () => { let n = 0; return () => 'g_test' + String(++n).padStart(4, '0'); };

type Row = { id: string; group?: string | null };
const rows = (...spec: Array<[string, string?]>): Row[] => spec.map(([id, group]) => ({ id, group }));
const ids = (list: Row[]) => list.map((r) => r.id);

describe('normalizeChatGroup', () => {
  it('trims, folds spaces and caps the length', () => {
    expect(normalizeChatGroup('  Frontend   fixes ')).toBe('Frontend fixes');
    expect(normalizeChatGroup('x'.repeat(100))).toHaveLength(MAX_CHAT_GROUP_LENGTH);
  });
  it('is null for nothing', () => {
    expect(normalizeChatGroup('   ')).toBeNull();
    expect(normalizeChatGroup(null)).toBeNull();
    expect(normalizeChatGroup(undefined)).toBeNull();
  });
});

describe('group ids', () => {
  it('makes ids of the g_ shape, each different', () => {
    const ids = new Set(Array.from({ length: 50 }, newChatGroupId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(isChatGroupId(id)).toBe(true);
  });
  it('tells an id from a legacy name', () => {
    expect(isChatGroupId('g_abcdef12')).toBe(true);
    for (const name of ['Frontend fixes', 'g_', 'g_ab', 'G_abcdef12', 'g_abc def', '', null, 3]) expect(isChatGroupId(name)).toBe(false);
  });
});

describe('resolving a stored chatGroup', () => {
  const defined: DefinedChatGroup[] = [{ id: 'g_docs0001', name: 'Docs', color: 3 }, { id: 'g_blank001', color: 0 }];
  const index = buildChatGroupIndex([{ chatGroup: 'g_docs0001' }, { chatGroup: 'docs' }, { chatGroup: 'API' }, { chatGroup: 'api ' }, { chatGroup: 'g_gone0001' }, { chatGroup: null }, {}, { chatGroup: ' ' }], defined);
  it('finds a group by id', () => {
    expect(index.resolve('g_docs0001')).toMatchObject({ key: 'g_docs0001', id: 'g_docs0001', value: 'g_docs0001', name: 'Docs', color: 3, defined: true });
  });
  it('treats a value that is no id as a legacy name: a defined group with that name (ignoring case) is that group', () => {
    expect(index.resolve('  DOCS ')).toBe(index.resolve('g_docs0001'));
  });
  it('shows a legacy name with no defined group as that name alone, once, in the first spelling seen', () => {
    const api = index.resolve('API')!;
    expect(api).toMatchObject({ id: null, value: 'API', name: 'API', defined: false, key: 'n:api' });
    expect(index.resolve('api')).toBe(api);
    expect(api.color).toBe(defaultChatGroupColor('API'));
  });
  it('shows an id nobody here defined as an unnamed group', () => {
    expect(index.resolve('g_gone0001')).toMatchObject({ id: 'g_gone0001', name: null, defined: false });
  });
  it('is no group for nothing', () => {
    for (const none of [null, undefined, '', '  ']) expect(index.resolve(none)).toBeNull();
  });
  it('lists the defined groups, then those only chats mention', () => {
    expect(index.groups.map((g) => g.key)).toEqual(['g_docs0001', 'g_blank001', 'n:api', 'g_gone0001']);
  });
  it('colours a defined group with no colour by its name, or its id when it has none', () => {
    const i = buildChatGroupIndex([], [{ id: 'g_aaaaaa01', name: 'Zed' }]);
    expect(i.groups[0].color).toBe(defaultChatGroupColor('Zed'));
  });
});

describe('group labels and order', () => {
  it('names an unnamed group by its colour for a preset, and plainly for a custom hex', () => {
    expect(chatGroupLabel({ name: null, color: 0 })).toBe('Untitled group (Teal)');
    expect(chatGroupLabel({ name: null, color: 5 })).toBe('Untitled group (Lime)');
    expect(chatGroupLabel({ name: null, color: '#123456' })).toBe('Untitled group');
    expect(untitledChatGroupLabel('#abcdef')).toBe('Untitled group');
    expect(chatGroupLabel({ name: 'Docs', color: 1 })).toBe('Docs');
  });
  it('sorts named groups A to Z ignoring case, then unnamed ones in palette order', () => {
    const g = (key: string, name: string | null, color: number | string) => ({ key, name, color });
    expect(sortChatGroups([g('1', null, '#fff000'), g('2', 'beta', 0), g('3', null, 2), g('4', 'Alpha', 1), g('5', null, 0)]).map((x) => x.key)).toEqual(['4', '2', '5', '3', '1']);
  });
});

describe('clusterByChatGroup', () => {
  it('puts a cluster where its first entry was and leaves ungrouped chats last, in order', () => {
    const clusters = clusterByChatGroup(rows(['1', 'B'], ['2'], ['3', 'A'], ['4', 'b'], ['5'], ['6', 'A']), (r) => r.group);
    expect(clusters.map((c) => [c.key, c.group?.name, ids(c.items)])).toEqual([
      ['n:b', 'B', ['1', '4']],
      ['n:a', 'A', ['3', '6']],
      [null, undefined, ['2', '5']],
    ]);
  });
  it('gathers a group by id with the chats that stored its name', () => {
    const { resolve } = buildChatGroupIndex([], [{ id: 'g_docs0001', name: 'Docs', color: 1 }]);
    const clusters = clusterByChatGroup(rows(['1', 'g_docs0001'], ['2', 'docs'], ['3']), (r) => r.group, resolve);
    expect(clusters.map((c) => [c.key, ids(c.items)])).toEqual([['g_docs0001', ['1', '2']], [null, ['3']]]);
  });
  it('clusters unnamed groups by id', () => {
    const { resolve } = buildChatGroupIndex([], [{ id: 'g_aaaaaa01', color: 0 }, { id: 'g_aaaaaa02', color: 0 }]);
    const clusters = clusterByChatGroup(rows(['1', 'g_aaaaaa01'], ['2', 'g_aaaaaa02'], ['3', 'g_aaaaaa01']), (r) => r.group, resolve);
    expect(clusters.map((c) => [c.group?.name, ids(c.items)])).toEqual([[null, ['1', '3']], [null, ['2']]]);
  });
  it('is one ungrouped cluster when no chat has a group, in the order given', () => {
    const list: Row[] = [{ id: '1' }, { id: '2', group: null }, { id: '3' }];
    const clusters = clusterByChatGroup(list, (r) => r.group);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].key).toBeNull();
    expect(ids(clusters[0].items)).toEqual(['1', '2', '3']);
  });
  it('is stable inside a cluster', () => {
    const list = rows(['3', 'x'], ['1', 'x'], ['2', 'x']);
    expect(ids(clusterByChatGroup(list, (r) => r.group)[0].items)).toEqual(['3', '1', '2']);
  });
  it('is empty for no entries', () => {
    expect(clusterByChatGroup([], (r: Row) => r.group)).toEqual([]);
  });
  it('keeps most recent first inside a cluster whatever the chats are tagged', () => {
    type Chat = { id: string; group: string; updatedAt: number; tags: string[] };
    const chats: Chat[] = [
      { id: 'old-tagged', group: 'x', updatedAt: 10, tags: ['bug', 'review'] },
      { id: 'new-untagged', group: 'x', updatedAt: 30, tags: [] },
      { id: 'mid-tagged', group: 'x', updatedAt: 20, tags: ['bug'] },
    ];
    const clusterOrder = (list: Chat[]) => {
      const byRecency = compareCards({ sortBy: 'updated', direction: 'desc' });
      const sorted = [...list].sort((a, b) => byRecency({ title: a.id, updatedAt: a.updatedAt, createdAt: 0 }, { title: b.id, updatedAt: b.updatedAt, createdAt: 0 }));
      return clusterByChatGroup(sorted, (c) => c.group)[0].items.map((c) => c.id);
    };
    expect(clusterOrder(chats)).toEqual(['new-untagged', 'mid-tagged', 'old-tagged']);
    // Removing every tag, or reversing them, changes nothing.
    expect(clusterOrder(chats.map((c) => ({ ...c, tags: [] })))).toEqual(['new-untagged', 'mid-tagged', 'old-tagged']);
    expect(clusterOrder(chats.map((c) => ({ ...c, tags: c.tags.length ? [] : ['bug'] })))).toEqual(['new-untagged', 'mid-tagged', 'old-tagged']);
  });
});

describe('pageChatGroupClusters', () => {
  const many = (n: number, group: string | undefined, prefix: string) => Array.from({ length: n }, (_, i): Row => ({ id: `${prefix}${i}`, group }));

  it('shows everything at or under the limit', () => {
    const clusters = clusterByChatGroup(many(AGENT_GROUP_LIMIT, 'g', 'a'), (r) => r.group);
    expect(pageChatGroupClusters(clusters, false, () => false)).toEqual(clusters);
  });
  it('counts the clustered order, dropping clusters left with no row', () => {
    const list = [...many(AGENT_GROUP_LIMIT, 'g', 'a'), ...many(3, 'h', 'b'), ...many(2, undefined, 'c')];
    const paged = pageChatGroupClusters(clusterByChatGroup(list, (r) => r.group), false, () => false);
    expect(paged.map((c) => c.key)).toEqual(['n:g']);
    expect(paged[0].items).toHaveLength(AGENT_GROUP_LIMIT);
  });
  it('keeps the open chat in reach when it sits in a later cluster', () => {
    const list = [...many(AGENT_GROUP_LIMIT, 'g', 'a'), ...many(3, 'h', 'b')];
    const paged = pageChatGroupClusters(clusterByChatGroup(list, (r) => r.group), false, (r) => r.id === 'b2');
    expect(paged.map((c) => [c.key, ids(c.items).length])).toEqual([['n:g', AGENT_GROUP_LIMIT - 1], ['n:h', 1]]);
    expect(ids(paged[1].items)).toEqual(['b2']);
  });
  it('shows all of it once expanded', () => {
    const list = [...many(AGENT_GROUP_LIMIT, 'g', 'a'), ...many(3, 'h', 'b'), ...many(2, undefined, 'c')];
    const paged = pageChatGroupClusters(clusterByChatGroup(list, (r) => r.group), true, () => false);
    expect(paged.flatMap((c) => c.items)).toHaveLength(list.length);
  });
});

describe('saveChatGroups', () => {
  it('saves { chatGroup } on every chat and reports only the failures', async () => {
    const save = vi.fn(async (id: string) => { if (id === 'b') throw new Error('disk full'); return id === 'c' ? null : { id }; });
    const saved: string[] = [];
    const failed = await saveChatGroups(['a', 'b', 'c'], 'Frontend fixes', save, (id) => saved.push(id));
    expect(save.mock.calls).toEqual([['a', { chatGroup: 'Frontend fixes' }], ['b', { chatGroup: 'Frontend fixes' }], ['c', { chatGroup: 'Frontend fixes' }]]);
    expect(saved).toEqual(['a']);
    expect(failed.map((f) => f.id)).toEqual(['b', 'c']);
  });
  it('clears with null', async () => {
    const save = vi.fn(async (id: string) => ({ id }));
    expect(await saveChatGroups(['a'], null, save)).toEqual([]);
    expect(save).toHaveBeenCalledWith('a', { chatGroup: null });
  });
});

describe('defined groups', () => {
  const chats = [{ id: 'a', chatGroup: 'Docs' }, { id: 'b', chatGroup: 'docs' }, { id: 'c', chatGroup: 'API' }, { id: 'd' }];
  const parse = (raw: unknown) => parseDefinedChatGroups(JSON.stringify(raw), counter());

  it('reads a saved list and drops what is not a group', () => {
    expect(parseDefinedChatGroups(null)).toEqual({ groups: [], changed: false });
    expect(parseDefinedChatGroups('nope')).toEqual({ groups: [], changed: false });
    expect(parseDefinedChatGroups('{"a":1}')).toEqual({ groups: [], changed: false });
    const { groups } = parse([{ id: 'g_keepme01', name: 'A', color: 2 }, { id: 'g_keepme02', name: 'a', color: 3 }, { id: 'g_keepme03', name: ' ' }, { id: 'g_keepme04' }, 3, { id: 'g_keepme05', name: ' B  b ', color: 99 }, { id: 'g_keepme01', name: 'Dup', color: 1 }]);
    expect(groups).toEqual([{ id: 'g_keepme01', name: 'A', color: 2 }, { id: 'g_keepme05', name: 'B b' }]);
  });
  it('keeps a group with no name when it has a colour', () => {
    expect(parse([{ id: 'g_keepme01', color: 4 }]).groups).toEqual([{ id: 'g_keepme01', color: 4 }]);
  });
  it('is unchanged when every entry already has an id', () => {
    expect(parse([{ id: 'g_keepme01', name: 'A', color: 2 }]).changed).toBe(false);
  });
  it('migrates { name, color } entries by giving each an id, keeping name and colour', () => {
    expect(parse([{ name: 'Docs', color: 4 }, { name: 'Old' }])).toEqual({ groups: [{ id: 'g_test0001', name: 'Docs', color: 4 }, { id: 'g_test0002', name: 'Old' }], changed: true });
  });
  it('migrates the first version, a list of names, keeping the names', () => {
    expect(parse(['A', 'a', ' ', 3, ' B  b ']).groups).toEqual([{ id: 'g_test0001', name: 'A' }, { id: 'g_test0004', name: 'B b' }]);
    expect(parse(['A']).changed).toBe(true);
  });
  it('replaces an id that is not one with a new id', () => {
    expect(parse([{ id: 'nope', name: 'A' }]).groups).toEqual([{ id: 'g_test0001', name: 'A' }]);
  });
  it('keeps a migrated group\'s chats, which store its name, in it', () => {
    const { groups } = parse([{ name: 'Docs', color: 4 }]);
    const index = buildChatGroupIndex(chats, groups);
    expect(index.resolve('docs')?.id).toBe('g_test0001');
    expect(index.groups.map((g) => g.key)).toEqual(['g_test0001', 'n:api']);
  });

  it('makes a group with a colour and an optional name, with an id', () => {
    const made = createChatGroup([], { name: '  new   one ', color: 4 }, counter())!;
    expect(made.entry).toEqual({ id: 'g_test0001', name: 'new one', color: 4 });
    expect(made.defined).toEqual([made.entry]);
    expect(createChatGroup([], { color: '#ABCDEF' }, counter())!.entry).toEqual({ id: 'g_test0001', color: '#abcdef' });
    expect(createChatGroup([], { name: '   ', color: 0 }, counter())!.entry).toEqual({ id: 'g_test0001', color: 0 });
  });
  it('needs a colour: none comes back with nothing made', () => {
    expect(createChatGroup([], { name: 'Docs', color: null })).toBeNull();
    expect(createChatGroup([], { name: 'Docs', color: undefined })).toBeNull();
    expect(createChatGroup([], { name: 'Docs', color: 99 })).toBeNull();
  });
  it('reuses a group with the same name, taking the new colour', () => {
    const made = createChatGroup([{ id: 'g_docs0001', name: 'Docs', color: 1 }], { name: 'DOCS', color: 2 })!;
    expect(made.defined).toEqual([{ id: 'g_docs0001', name: 'Docs', color: 2 }]);
  });
  it('gives a legacy group an entry when it is assigned, keeping its colour, and stores the id', () => {
    const api = buildChatGroupIndex(chats, []).resolve('API')!;
    const plan = assignChatGroupPlan([], api, counter());
    expect(plan).toEqual({ defined: [{ id: 'g_test0001', name: 'API', color: defaultChatGroupColor('API') }], value: 'g_test0001' });
    expect(buildChatGroupIndex(chats, plan.defined).resolve('API')?.key).toBe('g_test0001');
    expect(assignChatGroupPlan([], null)).toEqual({ defined: [], value: null });
  });
  it('assigns a defined group by its id without changing the list', () => {
    const defined: DefinedChatGroup[] = [{ id: 'g_docs0001', name: 'Docs', color: 1 }];
    const docs = buildChatGroupIndex([], defined).resolve('g_docs0001')!;
    expect(assignChatGroupPlan(defined, docs)).toEqual({ defined, value: 'g_docs0001' });
  });
  it('ensures an entry for an id made on another device, unnamed', () => {
    const gone = buildChatGroupIndex([{ chatGroup: 'g_gone0001' }], []).resolve('g_gone0001')!;
    expect(ensureDefinedGroup([], gone).entry).toEqual({ id: 'g_gone0001', color: gone.color });
  });
  it('lists defined groups no chat is in, archived chats counting as in, A to Z', () => {
    const defined: DefinedChatGroup[] = [{ id: 'g_docs0001', name: 'Docs' }, { id: 'g_old00001', name: 'Old' }, { id: 'g_fresh001', name: 'Fresh' }, { id: 'g_api00001', name: 'api' }, { id: 'g_blank001', color: 2 }];
    const withArchived = [...chats, { id: 'e', chatGroup: 'g_old00001' }];
    expect(emptyChatGroups(defined, withArchived).map((g) => g.key)).toEqual(['g_fresh001', 'g_blank001']);
  });

  describe('rename', () => {
    const defined: DefinedChatGroup[] = [{ id: 'g_docs0001', name: 'Docs', color: 4 }, { id: 'g_fresh001', name: 'Fresh' }];
    const stored = [{ id: 'a', chatGroup: 'g_docs0001' }, { id: 'b', chatGroup: 'g_docs0001' }, { id: 'c', chatGroup: 'g_fresh001' }, { id: 'd' }];
    const group = (key: string, list = defined, sessions: Array<{ id: string; chatGroup?: string }> = stored) => buildChatGroupIndex(sessions, list).groups.find((g) => g.key === key)!;

    it('renames an id group in the list only: its chats already store the id', () => {
      const plan = renameChatGroupPlan(defined, stored, group('g_docs0001'), ' Documentation ');
      expect(plan).toEqual({ defined: [{ id: 'g_docs0001', name: 'Documentation', color: 4 }, defined[1]], ids: [], value: 'g_docs0001' });
    });
    it('can clear the name, leaving an unnamed group with its colour', () => {
      expect(renameChatGroupPlan(defined, stored, group('g_docs0001'), '  ').defined[0]).toEqual({ id: 'g_docs0001', color: 4 });
      expect(renameChatGroupPlan(defined, stored, group('g_docs0001'), null).defined[0]).toEqual({ id: 'g_docs0001', color: 4 });
    });
    it('can name an unnamed group', () => {
      const unnamed: DefinedChatGroup[] = [{ id: 'g_blank001', color: 2 }];
      expect(renameChatGroupPlan(unnamed, [], group('g_blank001', unnamed, []), 'Named').defined).toEqual([{ id: 'g_blank001', name: 'Named', color: 2 }]);
    });
    it('keeps the colour a group shows with, the default one included', () => {
      const plain: DefinedChatGroup[] = [{ id: 'g_fresh001', name: 'Fresh' }];
      expect(renameChatGroupPlan(plain, [], group('g_fresh001', plain, []), 'Other').defined).toEqual([{ id: 'g_fresh001', name: 'Other', color: defaultChatGroupColor('Fresh') }]);
    });
    it('moves the chats of a legacy group that stored its name to its id', () => {
      const legacy = [{ id: 'a', chatGroup: 'Docs' }, { id: 'b', chatGroup: 'docs' }, { id: 'c', chatGroup: 'g_docs0001' }];
      const plan = renameChatGroupPlan(defined, legacy, group('g_docs0001', defined, legacy), 'Guides');
      expect(plan.ids).toEqual(['a', 'b']);
      expect(plan.value).toBe('g_docs0001');
    });
    it('gives a legacy chat-only group an id on rename, keeping its colour, and moves its chats', () => {
      const plan = renameChatGroupPlan([], chats, group('n:api', [], chats), 'Backend', counter());
      expect(plan).toEqual({ defined: [{ id: 'g_test0001', name: 'Backend', color: defaultChatGroupColor('API') }], ids: ['c'], value: 'g_test0001' });
    });
    it('merges into a group that has the name, keeping its id and colour, and moves the chats over', () => {
      const plan = renameChatGroupPlan(defined, stored, group('g_docs0001'), 'fresh');
      expect(plan).toEqual({ defined: [{ id: 'g_fresh001', name: 'Fresh' }], ids: ['a', 'b'], value: 'g_fresh001' });
    });
    it('merges into a legacy chat-only group by giving it an entry', () => {
      const plan = renameChatGroupPlan(defined, [...stored, { id: 'e', chatGroup: 'API' }], group('g_docs0001', defined, [...stored, { id: 'e', chatGroup: 'API' }]), 'api', counter());
      expect(plan.defined.map((d) => d.name)).toEqual(['Fresh', 'API']);
      expect(plan.value).toBe('g_test0001');
      expect(plan.ids).toEqual(['a', 'b']);
    });
    it('is not a merge to change only the case of its own name', () => {
      const plan = renameChatGroupPlan(defined, stored, group('g_docs0001'), 'DOCS');
      expect(plan.defined[0]).toEqual({ id: 'g_docs0001', name: 'DOCS', color: 4 });
      expect(plan.ids).toEqual([]);
    });
  });

  it('plans a delete by id: its entry goes, its chats (and ones that stored its name) are cleared', () => {
    const defined: DefinedChatGroup[] = [{ id: 'g_docs0001', name: 'Docs', color: 2 }, { id: 'g_fresh001', name: 'Fresh' }];
    const sessions = [{ id: 'a', chatGroup: 'g_docs0001' }, { id: 'b', chatGroup: 'DOCS' }, { id: 'c', chatGroup: 'g_fresh001' }];
    const docs = buildChatGroupIndex(sessions, defined).resolve('g_docs0001')!;
    expect(deleteChatGroupPlan(defined, sessions, docs)).toEqual({ defined: [defined[1]], ids: ['a', 'b'] });
    const fresh = buildChatGroupIndex([], defined).resolve('g_fresh001')!;
    expect(deleteChatGroupPlan(defined, [], fresh).ids).toEqual([]);
  });
});

describe('group colours', () => {
  it('picks a stable default from the palette by seed, ignoring case', () => {
    for (const name of ['Docs', 'Frontend fixes', 'API', 'x']) {
      const c = defaultChatGroupColor(name);
      expect(Number.isInteger(c) && c >= 0 && c < CHAT_GROUP_COLORS.length).toBe(true);
      expect(defaultChatGroupColor(name.toUpperCase())).toBe(c);
      expect(defaultChatGroupColor(name)).toBe(c);
    }
    expect(new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map(defaultChatGroupColor)).size).toBeGreaterThan(1);
  });
  it('uses the picked colour, else the default', () => {
    expect(buildChatGroupIndex([], [{ id: 'g_docs0001', name: 'Docs', color: 3 }]).groups[0].color).toBe(3);
    expect(buildChatGroupIndex([], [{ id: 'g_docs0001', name: 'Docs' }]).groups[0].color).toBe(defaultChatGroupColor('Docs'));
  });
  it('edits a chat-only group by adding it with the new name and colour, and a defined one in place', () => {
    const chats = [{ id: 'x', chatGroup: 'API' }];
    const api = buildChatGroupIndex(chats, []).resolve('API')!;
    const plan = renameChatGroupPlan([], chats, api, 'Backend', counter(), 2);
    expect(plan.defined).toEqual([{ id: 'g_test0001', name: 'Backend', color: 2 }]);
    expect(plan.ids).toEqual(['x']);
    const defined: DefinedChatGroup[] = [{ id: 'g_aaaaaa01', name: 'A' }, { id: 'g_bbbbbb01', name: 'B' }];
    const b = buildChatGroupIndex([], defined).resolve('b')!;
    expect(renameChatGroupPlan(defined, [], b, 'B', undefined, 5).defined).toEqual([defined[0], { id: 'g_bbbbbb01', name: 'B', color: 5 }]);
    expect(renameChatGroupPlan(defined, [], b, '', undefined, 5).defined[1]).toEqual({ id: 'g_bbbbbb01', color: 5 });
    expect(renameChatGroupPlan(defined, [], b, 'B', undefined, 9).defined[1].color).toBe(b.color);
  });
  it('is made of design tokens only', () => {
    for (const c of CHAT_GROUP_COLORS) expect(chatGroupColorValue(CHAT_GROUP_COLORS.indexOf(c))).toBe(`var(${c.token})`);
    expect(chatGroupColorValue(99)).toBe(`var(${CHAT_GROUP_COLORS[0].token})`);
  });
});

describe('custom group colours', () => {
  it('reads a hex as #rrggbb in lower case, and rejects the rest', () => {
    expect(normalizeHexColor('#A1B2C3')).toBe('#a1b2c3');
    expect(normalizeHexColor(' abc ')).toBe('#aabbcc');
    for (const bad of ['', '#12', '#12345', '#1234567', '#ggg', 'red', 'var(--x)', null, 5, undefined]) expect(normalizeHexColor(bad)).toBeNull();
  });
  it('keeps a palette index or a hex and nothing else', () => {
    expect(parseChatGroupColor(3)).toBe(3);
    expect(parseChatGroupColor('#FF00AA')).toBe('#ff00aa');
    for (const bad of [6, -1, 1.5, 'nope', {}, null]) expect(parseChatGroupColor(bad)).toBeNull();
  });
  it('shows a hex as itself and a preset as its token', () => {
    expect(chatGroupColorValue('#ff00aa')).toBe('#ff00aa');
    expect(chatGroupColorValue(1)).toBe('var(--zone-tint-1)');
  });
  it('saves and reads both forms, ignoring a bad colour and migrating old prefs', () => {
    const saved = JSON.stringify([{ name: 'A', color: '#ABCDEF' }, { name: 'B', color: 2 }, { name: 'C', color: '#xyz' }, { name: 'D', color: 'red' }, 'E']);
    expect(parseDefinedChatGroups(saved, counter()).groups).toEqual([{ id: 'g_test0001', name: 'A', color: '#abcdef' }, { id: 'g_test0002', name: 'B', color: 2 }, { id: 'g_test0003', name: 'C' }, { id: 'g_test0004', name: 'D' }, { id: 'g_test0005', name: 'E' }]);
  });
  it('picks and renames with a hex like with a preset', () => {
    const defined: DefinedChatGroup[] = [{ id: 'g_docs0001', name: 'Docs' }];
    const docs = buildChatGroupIndex([], defined).resolve('docs')!;
    const colored = renameChatGroupPlan(defined, [], docs, 'Docs', undefined, '#123456').defined;
    expect(colored).toEqual([{ id: 'g_docs0001', name: 'Docs', color: '#123456' }]);
    expect(renameChatGroupPlan(colored, [], docs, 'Docs', undefined, '#nope').defined[0].color).toBe(docs.color);
    expect(createChatGroup([], { name: 'New', color: '#ABCDEF' }, counter())!.entry).toEqual({ id: 'g_test0001', name: 'New', color: '#abcdef' });
    const sessions = [{ id: 'a', chatGroup: 'g_docs0001' }];
    expect(renameChatGroupPlan(colored, sessions, buildChatGroupIndex(sessions, colored).groups[0], 'Guides').defined).toEqual([{ id: 'g_docs0001', name: 'Guides', color: '#123456' }]);
  });
});

describe('saved custom colours', () => {
  it('reads a saved list: valid hexes, lower case, once each, newest first, capped', () => {
    expect(parseSavedCustomColors(null)).toEqual([]);
    expect(parseSavedCustomColors('nope')).toEqual([]);
    expect(parseSavedCustomColors('{"a":1}')).toEqual([]);
    expect(parseSavedCustomColors(JSON.stringify(['#ABCDEF', '#abcdef', 'red', 3, 'FFF', null]))).toEqual(['#abcdef', '#ffffff']);
    const many = Array.from({ length: 14 }, (_, i) => `#0000${(i + 16).toString(16)}`);
    expect(parseSavedCustomColors(JSON.stringify(many))).toEqual(many.slice(0, MAX_SAVED_CUSTOM_COLORS));
  });
  it('adds a colour first, ignoring case, so it is never in the list twice', () => {
    expect(addSavedCustomColor(['#111111', '#222222'], '#333333')).toEqual(['#333333', '#111111', '#222222']);
    expect(addSavedCustomColor(['#111111', '#222222'], '#222222')).toEqual(['#222222', '#111111']);
    expect(addSavedCustomColor(['#abcdef'], '#ABCDEF')).toEqual(['#abcdef']);
  });
  it('drops the oldest past ten', () => {
    const full = Array.from({ length: 10 }, (_, i) => `#00000${i}`);
    const next = addSavedCustomColor(full, '#ffffff');
    expect(next).toHaveLength(10);
    expect(next[0]).toBe('#ffffff');
    expect(next).not.toContain('#000009');
  });
  it('ignores an invalid hex and a colour a preset already is', () => {
    expect(addSavedCustomColor(['#111111'], 'nope')).toEqual(['#111111']);
    expect(addSavedCustomColor(['#111111'], '#2FAE86', ['#2fae86', '#e0952a'])).toEqual(['#111111']);
  });
  it('removes a colour, ignoring case', () => {
    expect(removeSavedCustomColor(['#abcdef', '#111111'], '#ABCDEF')).toEqual(['#111111']);
    expect(removeSavedCustomColor(['#111111'], '#222222')).toEqual(['#111111']);
  });
  it('remembers only a custom hex, in storage, leaving groups alone', () => {
    localStorage.removeItem(SAVED_CUSTOM_COLORS_KEY);
    expect(rememberCustomColor(3)).toEqual([]);
    expect(rememberCustomColor('#ABCDEF')).toEqual(['#abcdef']);
    expect(rememberCustomColor('#123456')).toEqual(['#123456', '#abcdef']);
    expect(readSavedCustomColors()).toEqual(['#123456', '#abcdef']);
    expect(removeSavedCustomColor(readSavedCustomColors(), '#123456')).toEqual(['#abcdef']);
    localStorage.removeItem(SAVED_CUSTOM_COLORS_KEY);
  });
});
