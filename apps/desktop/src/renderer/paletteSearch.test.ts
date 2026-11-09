import { describe, expect, it } from 'vitest';
import { expandTerm, highlight, paletteTerms, scoreDoc, searchPalette, snippetFor, type PaletteDoc } from './paletteSearch.js';

const doc = (over: Partial<PaletteDoc> & Pick<PaletteDoc, 'id' | 'kind' | 'title'>): PaletteDoc => ({ crumbs: [], ...over });

const DOCS: PaletteDoc[] = [
  doc({ id: 'command:go-settings', kind: 'command', title: 'Go to Settings', crumbs: ['Commands'], context: 'Every preference, in one page' }),
  doc({ id: 'command:new-chat', kind: 'command', title: 'New agent', crumbs: ['Commands'], context: 'Start a new chat with an agent' }),
  doc({ id: 'page:customize', kind: 'page', title: 'Customize', crumbs: ['Settings'], context: 'Covers theme appearance fonts' }),
  doc({ id: 'setting:text-size', kind: 'setting', title: 'Text size', crumbs: ['Settings', 'Customize'], context: 'Also matches font scale zoom' }),
  doc({ id: 'chat:a', kind: 'chat', title: 'Fix the theme picker', crumbs: ['Chats'], context: 'the dropdown flickers', body: [{ text: 'the dropdown flickers' }], at: 10 }),
  doc({ id: 'message:a', kind: 'message', title: 'Fix the theme picker', crumbs: ['Messages'], bodyOnly: true, body: [{ text: 'try the dark theme first', id: 'm1' }], at: 10 }),
  doc({ id: 'message:b', kind: 'message', title: 'Release notes', crumbs: ['Messages'], bodyOnly: true, body: [{ text: 'hello', id: 'm2' }, { text: 'the theme switch shipped', id: 'm3' }], at: 20 }),
  doc({ id: 'artifact:x', kind: 'artifact', title: 'Theme tokens', crumbs: ['Artifacts', 'Fix the theme picker'], context: 'tokens.css · C:/p/tokens.css', at: 5 }),
];

const ids = (q: string, filter?: Parameters<typeof searchPalette>[2]) => searchPalette(DOCS, q, filter).hits.map((h) => h.doc.id);

describe('synonyms', () => {
  it('expands a word to its group, and a 4+ letter start too', () => {
    expect(expandTerm('prefs').alts).toContain('settings');
    expect(expandTerm('config').alts).toContain('preferences');
    expect(expandTerm('pref').alts).toContain('options');
    expect(expandTerm('prefe').alts).toContain('settings');
  });
  it('leaves short starts and unknown words alone', () => {
    expect(expandTerm('se').alts).toEqual(['se']);
    expect(expandTerm('zebra').alts).toEqual(['zebra']);
  });
  it('finds Settings for preferences, prefs and config, ranked above the pages under it', () => {
    for (const q of ['preferences', 'prefs', 'config']) expect(ids(q)[0]).toBe('command:go-settings');
  });
  it('ranks a literal match over a synonym match', () => {
    const lit = scoreDoc(DOCS[0], paletteTerms('settings'), 'settings')!.score;
    const syn = scoreDoc(DOCS[0], paletteTerms('prefs'), 'prefs')!.score;
    expect(lit).toBeGreaterThan(syn);
  });
  it('never applies synonyms inside message bodies', () => {
    // "new" stands for "start"/"create"/"add", which would match nearly every message.
    const d = doc({ id: 'message:z', kind: 'message', title: 'x', bodyOnly: true, body: [{ text: 'we should start over' }] });
    expect(scoreDoc(d, paletteTerms('new'))).toBeNull();
  });
});

describe('ranking and filters', () => {
  it('puts every message result after every other kind', () => {
    const order = ids('theme');
    const firstMessage = order.findIndex((id) => id.startsWith('message:'));
    expect(firstMessage).toBeGreaterThan(0);
    expect(order.slice(firstMessage).every((id) => id.startsWith('message:'))).toBe(true);
  });
  it('ranks a title match above a context match', () => {
    const order = ids('theme');
    expect(order.indexOf('chat:a')).toBeLessThan(order.indexOf('page:customize'));
  });
  it('drops a message hit for a chat already found as a chat in All, keeps it under Messages', () => {
    expect(ids('theme')).not.toContain('message:a');
    expect(ids('theme', 'message')).toEqual(expect.arrayContaining(['message:a', 'message:b']));
  });
  it('filters by type and counts every type', () => {
    const r = searchPalette(DOCS, 'theme', 'artifact');
    expect(r.hits.map((h) => h.doc.id)).toEqual(['artifact:x']);
    expect(r.counts).toMatchObject({ chat: 1, message: 2, artifact: 1, setting: 1 });
  });
  it('counts pages as settings', () => {
    expect(ids('customize', 'setting')).toEqual(['page:customize', 'setting:text-size']);
  });
  it('does not match the type label every result of a kind carries', () => {
    // "agent" is a synonym of "chats", but it must not list every chat.
    expect(ids('agent')).toEqual(['command:new-chat']);
    expect(ids('prefs', 'setting')).toEqual(['page:customize']);
  });
  it('needs every word somewhere', () => {
    expect(ids('text size')).toEqual(['setting:text-size']);
    expect(ids('text purple')).toEqual([]);
  });
  it('caps messages in All and reports the rest', () => {
    const many = Array.from({ length: 12 }, (_, i) => doc({ id: `message:${i}`, kind: 'message', title: `c${i}`, bodyOnly: true, body: [{ text: 'needle here' }] }));
    const r = searchPalette(many, 'needle', 'all', { messageCap: 8 });
    expect(r.hits).toHaveLength(8);
    expect(r.moreMessages).toBe(4);
    expect(searchPalette(many, 'needle', 'message').hits).toHaveLength(12);
  });
  it('lists docs in the given order with no messages when nothing is typed', () => {
    expect(ids('')).toEqual(DOCS.filter((d) => d.kind !== 'message').map((d) => d.id));
  });
});

describe('the second row', () => {
  it('is a snippet from the message that holds the words, with a count', () => {
    const hit = scoreDoc(DOCS[6], paletteTerms('theme'))!;
    expect(hit.bodyIndex).toBe(1);
    expect(hit.bodyCount).toBe(1);
    expect(hit.context).toBe('the theme switch shipped');
  });
  it('is the context when the title already shows the match', () => {
    expect(scoreDoc(DOCS[4], paletteTerms('theme'))!.context).toBe('the dropdown flickers');
  });
  it('cuts a long text around the match, on a word boundary', () => {
    const text = `${'lorem ipsum dolor sit amet '.repeat(4)}the needle is here ${'and more words '.repeat(20)}`;
    const s = snippetFor(text, paletteTerms('needle'));
    expect(s.startsWith('…')).toBe(true);
    expect(s).toContain('the needle is here');
    expect(s.endsWith('…')).toBe(true);
    expect(s.slice(1, 2)).not.toBe(' ');
  });
});

describe('highlight', () => {
  it('marks every match, case-insensitively, merging overlaps', () => {
    expect(highlight('Theme and THEME tokens', paletteTerms('theme'))).toEqual([
      { text: 'Theme', hit: true }, { text: ' and ', hit: false }, { text: 'THEME', hit: true }, { text: ' tokens', hit: false },
    ]);
    expect(highlight('settings', paletteTerms('set sett'))).toEqual([{ text: 'sett', hit: true }, { text: 'ings', hit: false }]);
  });
  it('marks the synonym that matched', () => {
    expect(highlight('Go to Settings', paletteTerms('prefs')).filter((s) => s.hit).map((s) => s.text)).toEqual(['Settings']);
  });
  it('returns the text unmarked when nothing matches', () => {
    expect(highlight('abc', paletteTerms('z'))).toEqual([{ text: 'abc', hit: false }]);
  });
});
