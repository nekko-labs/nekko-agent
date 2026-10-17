import { describe, expect, it } from 'vitest';
import {
  FINDER_DEBOUNCE_MS, chatGroupKey, chatInRange, dayRange, facetResults, findChats, findTextFor, finderAge, finderTerms, groupFacets,
  matchChat, monthGrid, needsTranscripts, providerClass, providerFacets, providerKey, rangeLabel, searchArtifacts, searchChats,
  type IndexedChat,
} from './chatFinder.js';
import { indexChat } from './chatFinderIndex.js';
import type { ArtifactEntry } from '../artifactsIndex.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 16, 12);

describe('finderAge', () => {
  it('reads Today under a day, then days up to 30', () => {
    expect(finderAge(NOW - 5 * 60 * 1000, NOW)).toBe('Today');
    expect(finderAge(NOW - DAY, NOW)).toBe('1 day');
    expect(finderAge(NOW - 12 * DAY, NOW)).toBe('12 days');
    expect(finderAge(NOW - 30 * DAY, NOW)).toBe('30 days');
  });
  it('moves to whole months after 30 days', () => {
    expect(finderAge(NOW - 31 * DAY, NOW)).toBe('1 month');
    expect(finderAge(NOW - 59 * DAY, NOW)).toBe('1 month');
    expect(finderAge(NOW - 60 * DAY, NOW)).toBe('2 months');
    expect(finderAge(NOW - 400 * DAY, NOW)).toBe('13 months');
  });
  it('never goes negative for a clock skewed into the future', () => {
    expect(finderAge(NOW + DAY, NOW)).toBe('Today');
  });
});

it('waits one second after typing stops', () => {
  expect(FINDER_DEBOUNCE_MS).toBe(1000);
});

type Extra = Partial<{ firstUserText: string; lastReplyText: string; incognito: boolean; workspaceId: string; providerId: string; createdAgeDays: number }>;
const chat = (id: string, title: string, ageDays: number, extra: Extra = {}) => {
  const { createdAgeDays, ...rest } = extra;
  return { id, title, updatedAt: NOW - ageDays * DAY, createdAt: NOW - (createdAgeDays ?? ageDays) * DAY, ...rest };
};

describe('findChats (titles and descriptions)', () => {
  const sessions = [
    chat('old', 'Fix the login bug', 40),
    chat('new', 'Pull latest main', 0),
    chat('mid', 'Refactor sidebar', 3, { firstUserText: 'please fix the scroll bounce in the sidebar' }),
    chat('secret', 'Fix private thing', 1, { incognito: true }),
  ];

  it('lists the latest chats first when the query is empty', () => {
    expect(findChats(sessions, '').map((h) => h.session.id)).toEqual(['new', 'mid', 'old']);
  });
  it('puts title matches before body matches, newest first within each', () => {
    const hits = findChats(sessions, 'fix');
    expect(hits.map((h) => h.session.id)).toEqual(['old', 'mid']);
    expect(hits[0].snippet).toBeUndefined();
    expect(hits[1].snippet).toContain('fix the scroll bounce');
  });
  it('needs every word, in any order and case', () => {
    expect(findChats(sessions, 'SIDEBAR bounce').map((h) => h.session.id)).toEqual(['mid']);
    expect(findChats(sessions, 'sidebar login')).toEqual([]);
  });
  it('never surfaces incognito chats', () => {
    expect(findChats(sessions, 'private')).toEqual([]);
  });
  it('caps the list', () => {
    const many = Array.from({ length: 80 }, (_, i) => chat(String(i), 'chat ' + i, i));
    expect(findChats(many, '', 50)).toHaveLength(50);
  });
});

const msg = (id: string, role: 'user' | 'assistant', content: string, ageDays: number) => ({ id, role, content, createdAt: NOW - ageDays * DAY });
const artifact = (sessionId: string, path: string, ageDays: number, title = path.split('/').pop()!.replace(/\.\w+$/, '')): ArtifactEntry =>
  ({ path, title, filename: path.split('/').pop()!, kind: 'doc', sessionId, sessionTitle: sessionId, at: NOW - ageDays * DAY, source: 'linked' });

describe('searchChats over full transcripts', () => {
  const sessions = [
    chat('a', 'Refactor sidebar', 1),
    chat('b', 'Pricing table', 2, { firstUserText: 'build the pricing table' }),
    chat('c', 'Disk audit', 5),
    chat('d', 'Untouched', 6),
  ];
  const index = new Map<string, IndexedChat>([
    ['a', { updatedAt: sessions[0].updatedAt, messages: [indexed('a1', 'user', 'the virtual scroller jitters on resize', 1), indexed('a2', 'assistant', 'Fixed the jitter in VirtualTranscript', 1)], artifacts: [] }],
    ['b', { updatedAt: sessions[1].updatedAt, messages: [indexed('b1', 'assistant', 'Stripe tiers are in place', 2)], artifacts: [] }],
    ['c', { updatedAt: sessions[2].updatedAt, messages: [indexed('c1', 'user', 'audit my disk', 5)], artifacts: [artifact('c', 'C:/r/disk-audit/README.md', 5, 'Disk audit report')] }],
  ]);

  it('finds a word that only appears deep in the conversation', () => {
    const { hits, total } = searchChats(sessions, 'jitters', { scope: 'all', index });
    expect(total).toBe(1);
    expect(hits[0]).toMatchObject({ kind: 'message', messageCount: 1, messageId: 'a1', findText: 'jitters' });
    expect(hits[0].snippet).toContain('scroller jitters');
  });
  it('ranks title, then description, then messages, then artifacts', () => {
    const all = searchChats(sessions, 'audit', { scope: 'all', index }).hits.map((h) => [h.session.id, h.kind]);
    expect(all).toEqual([['c', 'title']]);
    const s = [...sessions, chat('e', 'Notes', 0)];
    const ix = new Map(index).set('e', { updatedAt: s[4].updatedAt, messages: [], artifacts: [artifact('e', '/x/stripe-plan.md', 0)] });
    expect(searchChats(s, 'stripe', { scope: 'all', index: ix }).hits.map((h) => [h.session.id, h.kind])).toEqual([['b', 'message'], ['e', 'artifact']]);
  });
  it('matches words spread across the title and messages', () => {
    expect(searchChats(sessions, 'pricing stripe', { scope: 'all', index }).hits.map((h) => h.session.id)).toEqual(['b']);
  });
  it('the Chats tab ignores transcripts; the Messages tab ignores titles', () => {
    expect(searchChats(sessions, 'jitters', { scope: 'chats', index }).total).toBe(0);
    expect(searchChats(sessions, 'sidebar', { scope: 'messages', index }).total).toBe(0);
    expect(searchChats(sessions, 'jitter', { scope: 'messages', index }).hits[0]).toMatchObject({ messageCount: 2 });
  });
  it('a chat not yet indexed can only match on its summary, never a false message hit', () => {
    expect(searchChats(sessions, 'jitters', { scope: 'all' }).total).toBe(0);
  });
  it('only offers Find-in-chat words that Find in chat (whole words) will find', () => {
    const hit = searchChats(sessions, 'jitter', { scope: 'messages', index }).hits[0];
    expect(hit.messageId).toBe('a2');
    expect(hit.findText).toBe('jitter');
    expect(findTextFor('the scroller jitters', ['jitter'])).toBeUndefined();
  });
  it('reports the full total even when drawing is capped', () => {
    const many = Array.from({ length: 70 }, (_, i) => chat(`m${i}`, `same topic ${i}`, i));
    const r = searchChats(many, 'topic', { limit: 50 });
    expect(r.hits).toHaveLength(50);
    expect(r.total).toBe(70);
  });
});

function indexed(id: string, role: 'user' | 'assistant', text: string, ageDays: number) {
  return { id, role, at: NOW - ageDays * DAY, text, lower: text.toLowerCase() };
}

describe('date ranges', () => {
  it('builds an inclusive whole-day range from two clicks in either order', () => {
    const a = new Date(2026, 2, 9, 15).getTime(), b = new Date(2026, 2, 3, 8).getTime();
    const r = dayRange(a, b);
    expect(new Date(r.from)).toEqual(new Date(2026, 2, 3, 0, 0, 0, 0));
    expect(new Date(r.to)).toEqual(new Date(2026, 2, 9, 23, 59, 59, 999));
  });
  it('keeps chats active inside the range, including long-running ones that span it', () => {
    const r = dayRange(NOW - 10 * DAY, NOW - 8 * DAY);
    expect(chatInRange({ createdAt: NOW - 9 * DAY, updatedAt: NOW - 9 * DAY }, r)).toBe(true);
    expect(chatInRange({ createdAt: NOW - 30 * DAY, updatedAt: NOW - 1 * DAY }, r)).toBe(true);
    expect(chatInRange({ createdAt: NOW - 3 * DAY, updatedAt: NOW - 1 * DAY }, r)).toBe(false);
    expect(chatInRange({ createdAt: NOW - 40 * DAY, updatedAt: NOW - 20 * DAY }, r)).toBe(false);
  });
  it('only counts messages written inside the range', () => {
    const s = [chat('x', 'Long chat', 0, { createdAgeDays: 30 })];
    const ix = new Map<string, IndexedChat>([['x', { updatedAt: s[0].updatedAt, messages: [indexed('x1', 'user', 'deploy the canary', 25), indexed('x2', 'user', 'rollback', 1)], artifacts: [] }]]);
    expect(searchChats(s, 'canary', { scope: 'all', index: ix, range: dayRange(NOW - 26 * DAY, NOW - 24 * DAY) }).total).toBe(1);
    expect(searchChats(s, 'canary', { scope: 'all', index: ix, range: dayRange(NOW - 2 * DAY, NOW) }).total).toBe(0);
  });
  it('labels a range and a single day', () => {
    expect(rangeLabel(null)).toBe('Any date');
    const d = new Date().setHours(12);
    expect(rangeLabel(dayRange(d, d))).not.toContain('–');
    expect(rangeLabel(dayRange(d - 3 * DAY, d))).toContain('–');
  });
  it('draws a six-week month grid starting on Sunday', () => {
    const g = monthGrid(2026, 1);
    expect(g).toHaveLength(42);
    expect(new Date(g[0]).getDay()).toBe(0);
    expect(g.some((t) => new Date(t).getMonth() === 1 && new Date(t).getDate() === 28)).toBe(true);
  });
});

describe('artifacts', () => {
  const sessions = [chat('a', 'Disk cleanup', 1), chat('b', 'Design pass', 2), chat('s', 'Secret', 0, { incognito: true })];
  const index = new Map<string, IndexedChat>([
    ['a', { updatedAt: 0, messages: [], artifacts: [artifact('a', 'C:/r/disk-audit.md', 1)] }],
    ['b', { updatedAt: 0, messages: [], artifacts: [artifact('b', 'C:/r/disk-audit.md', 3), artifact('b', 'C:/d/landing.html', 2)] }],
    ['s', { updatedAt: 0, messages: [], artifacts: [artifact('s', 'C:/r/hidden.md', 0)] }],
  ]);
  it('lists one row per path, owned by the newest chat, and skips incognito chats', () => {
    const r = searchArtifacts(sessions, index, '');
    expect(r.hits.map((a) => [a.filename, a.sessionId])).toEqual([['disk-audit.md', 'a'], ['landing.html', 'b']]);
  });
  it('matches the file, title or the chat it came from', () => {
    expect(searchArtifacts(sessions, index, 'landing').hits.map((a) => a.filename)).toEqual(['landing.html']);
    expect(searchArtifacts(sessions, index, 'design pass').hits.map((a) => a.filename)).toEqual(['landing.html']);
  });
});

describe('chat groups and providers', () => {
  const workspaces = [{ id: 'w1', name: 'nekko-agent' }, { id: 'w2', name: 'website' }];
  const providers = [
    { id: 'eng', label: 'Nekko Agent engine', kind: 'llamacpp' as const, baseUrl: 'http://127.0.0.1:8080' },
    { id: 'ant', label: 'Anthropic (Claude)', kind: 'anthropic' as const, baseUrl: 'https://api.anthropic.com' },
    { id: 'lan', label: 'Home box', kind: 'openai-compat' as const, baseUrl: 'http://localhost:1234/v1' },
  ];
  const sessions = [
    chat('g1', 'Plain question', 0),
    chat('n1', 'Fix sidebar', 1, { workspaceId: 'w1', providerId: 'ant' }),
    chat('n2', 'Release notes', 2, { workspaceId: 'w1', providerId: 'eng' }),
    chat('x1', 'Old folder chat', 3, { workspaceId: 'gone', providerId: 'removed' }),
  ];
  it('files chats the way the Agents panel does: missing folders fall back to General', () => {
    expect(chatGroupKey(sessions[3], workspaces)).toBe('__none');
    const r = facetResults(sessions, groupFacets(workspaces), (s) => chatGroupKey(s, workspaces), '', () => false);
    expect(r.map((f) => [f.name, f.sessions.map((s) => s.id)])).toEqual([['General', ['g1', 'x1']], ['nekko-agent', ['n1', 'n2']]]);
  });
  it('a group named by the query keeps all its chats; others keep only matching chats', () => {
    const match = (s: { title: string }) => s.title.toLowerCase().includes('nekko');
    expect(facetResults(sessions, groupFacets(workspaces), (s) => chatGroupKey(s, workspaces), 'nekko', match).map((f) => [f.name, f.sessions.length])).toEqual([['nekko-agent', 2]]);
    const fix = (s: { title: string }) => !!matchChat(s as never, finderTerms('fix'));
    expect(facetResults(sessions, groupFacets(workspaces), (s) => chatGroupKey(s, workspaces), 'fix', fix).map((f) => [f.name, f.sessions.map((s) => s.id)])).toEqual([['nekko-agent', ['n1']]]);
  });
  it('classifies providers as local or cloud; OpenAI-compatible only counts as local on loopback', () => {
    expect(providers.map(providerClass)).toEqual(['local', 'cloud', 'local']);
    expect(providerClass({ kind: 'openai-compat', baseUrl: 'https://gateway.example.com' })).toBe('cloud');
    expect(providerClass(undefined)).toBe('other');
  });
  it('lists configured providers plus removed ones, and "local" or "cloud" finds the whole section', () => {
    const facets = providerFacets(providers, sessions);
    expect(facets.map((f) => f.name)).toEqual(['Nekko Agent engine', 'Anthropic (Claude)', 'Home box', 'No model yet', 'removed (removed)']);
    const local = facetResults(sessions, facets, providerKey, 'local', () => false);
    expect(local.map((f) => [f.name, f.sessions.map((s) => s.id)])).toEqual([['Nekko Agent engine', ['n2']]]);
    const cloud = facetResults(sessions, facets, providerKey, 'cloud', () => false);
    expect(cloud.map((f) => f.name)).toEqual(['Anthropic (Claude)']);
  });
});

describe('transcript index', () => {
  it('keeps user and assistant text only, with skill input, and reads artifacts', () => {
    const ix = indexChat({
      id: 's', title: 'T', updatedAt: 9, messages: [
        { id: '1', role: 'user', content: '/review', skill: { name: 'review', input: 'check the auth flow' }, createdAt: 1 },
        { id: '2', role: 'tool', content: 'secret tool output', createdAt: 2 },
        { id: '3', role: 'assistant', content: 'Wrote [Report](/r/auth-review.md)', createdAt: 3 },
        { id: '4', role: 'assistant', content: '   ', createdAt: 4 },
      ],
    });
    expect(ix.messages.map((m) => m.id)).toEqual(['1', '3']);
    expect(ix.messages[0].lower).toContain('check the auth flow');
    expect(ix.artifacts.map((a) => a.filename)).toEqual(['auth-review.md']);
  });
});

describe('when transcripts are needed', () => {
  it('reads them for message and artifact searches only', () => {
    expect(needsTranscripts('chats', 'x')).toBe(false);
    expect(needsTranscripts('all', '')).toBe(false);
    expect(needsTranscripts('all', 'x')).toBe(true);
    expect(needsTranscripts('artifacts', '')).toBe(true);
  });
});
