import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FinderChatText, Session, SessionSummary } from '@nekko-agent/shared';
import { __resetChatIndex, chatIndex, indexChat, refreshChatIndex, staleChats } from './chatFinderIndex.js';

const summary = (id: string, updatedAt: number): SessionSummary => ({ id, title: id, updatedAt, createdAt: 1 } as unknown as SessionSummary);

const full = (id: string, updatedAt: number): Session => ({
  id, title: id, updatedAt, createdAt: 1, workspaceId: 'w1',
  gitWorktrees: { w1: { sourceRoot: '/repo', root: '/repo/.worktrees/x', path: '/repo/.worktrees/x', branch: 'b', notice: '' } },
  messages: [
    { id: 'u', role: 'user', content: `find ${id}`, images: ['data:image/png;base64,AAAA'], skill: { name: 's', input: 'more words' }, createdAt: 1 },
    { id: 'a', role: 'assistant', content: `see [d](nekko-designs/${id}.html)`, reasoning: 'hidden', createdAt: 2,
      toolCalls: [{ id: 't', name: 'write_file', input: { path: `/repo/notes/${id}.md`, content: 'BODY' } }] },
    { id: 'r', role: 'tool', content: 'OUT', createdAt: 3 },
  ],
} as unknown as Session);

/** What the daemon's `sessions:finderText` sends for a chat (nekko-store's finder). */
const textOf = (s: Session): FinderChatText => ({
  id: s.id, title: s.title, updatedAt: s.updatedAt, workspaceId: s.workspaceId,
  gitWorktrees: s.workspaceId && s.gitWorktrees ? { [s.workspaceId]: { path: s.gitWorktrees[s.workspaceId].path } } : undefined,
  messages: s.messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({
    id: m.id, role: m.role as 'user' | 'assistant', content: m.content, createdAt: m.createdAt,
    ...(m.skill ? { skill: { input: m.skill.input } } : {}),
    ...(m.toolCalls?.length ? { toolCalls: m.toolCalls.map((c) => ({ name: c.name, input: { path: (c.input as { path?: string }).path } })) } : {}),
  })),
});

let finderChatText: ReturnType<typeof vi.fn>;
let getSession: ReturnType<typeof vi.fn>;
const chats = new Map<string, Session>();

beforeEach(() => {
  __resetChatIndex();
  chats.clear();
  finderChatText = vi.fn(async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, chats.has(id) ? textOf(chats.get(id)!) : null])));
  getSession = vi.fn(async (id: string) => chats.get(id) ?? null);
  (globalThis as { window?: unknown }).window = { nekko: { finderChatText, getSession } };
});
afterEach(() => { delete (globalThis as { window?: unknown }).window; });

const add = (n: number) => Array.from({ length: n }, (_, i) => { const s = full(`c${i}`, 100 + i); chats.set(s.id, s); return summary(s.id, s.updatedAt); });

describe('refreshChatIndex', () => {
  it('indexes from the text-only channel, never fetching a whole transcript', async () => {
    const sessions = add(60);
    const progress: number[] = [];
    await refreshChatIndex(sessions, [{ id: 'w1', path: '/repo' }], (p) => progress.push(p.done));
    expect(getSession).not.toHaveBeenCalled();
    expect(finderChatText.mock.calls.map((c) => c[0].length)).toEqual([25, 25, 10]);
    expect(chatIndex().size).toBe(60);
    expect(progress.at(-1)).toBe(60);
    expect(staleChats(sessions)).toEqual([]);
  });

  it('gives the same entry the full transcript would', async () => {
    const [s] = add(1);
    await refreshChatIndex([s], [{ id: 'w1', path: '/repo' }], () => {});
    const expected = indexChat(chats.get('c0')!, '/repo/.worktrees/x');
    expect(chatIndex().get('c0')).toEqual(expected);
    expect(chatIndex().get('c0')!.artifacts.map((a) => a.filename).sort()).toEqual(['c0.html', 'c0.md']);
    expect(chatIndex().get('c0')!.messages[0].text).toBe('find c0\nmore words');
  });

  it('asks for the newest chats first and not again until a chat changes', async () => {
    const sessions = add(30);
    await refreshChatIndex(sessions, [], () => {});
    expect(finderChatText.mock.calls[0][0][0]).toBe('c29');
    finderChatText.mockClear();
    await refreshChatIndex(sessions, [], () => {});
    expect(finderChatText).not.toHaveBeenCalled();
    const changed = sessions.map((s) => (s.id === 'c3' ? { ...s, updatedAt: 999 } : s));
    await refreshChatIndex(changed, [], () => {});
    expect(finderChatText).toHaveBeenCalledTimes(1);
    expect(finderChatText.mock.calls[0][0]).toEqual(['c3']);
  });

  it('skips a chat the daemon could not read, and falls back to the whole chat on an older daemon', async () => {
    const sessions = add(2);
    finderChatText.mockImplementationOnce(async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, id === 'c0' ? null : textOf(chats.get(id)!)])));
    await refreshChatIndex(sessions, [], () => {});
    expect([...chatIndex().keys()]).toEqual(['c1']);
    expect(getSession).not.toHaveBeenCalled();

    __resetChatIndex();
    finderChatText.mockRejectedValueOnce(new Error('unknown channel'));
    await refreshChatIndex(sessions, [], () => {});
    expect(chatIndex().size).toBe(2);
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it('stops when aborted and keeps what was read', async () => {
    const sessions = add(100);
    const ctl = new AbortController();
    await refreshChatIndex(sessions, [], (p) => { if (p.done >= 25) ctl.abort(); }, ctl.signal);
    expect(chatIndex().size).toBeGreaterThanOrEqual(25);
    expect(chatIndex().size).toBeLessThan(100);
  });
});
