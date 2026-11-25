import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '@nekko-agent/shared';

vi.hoisted(() => {
  (globalThis as { window?: unknown }).window = { innerWidth: 1280, addEventListener() {} };
});
const { useStore, reuseSessions } = await import('./store.js');

const chat = (id: string, updatedAt: number, extra: Partial<SessionSummary> = {}) => ({ id, title: id, createdAt: 1, updatedAt, ...extra }) as SessionSummary;

describe('reuseSessions', () => {
  it('returns the previous array when nothing changed', () => {
    const prev = [chat('a', 1), chat('b', 2)];
    expect(reuseSessions(prev, [chat('a', 1), chat('b', 2)])).toBe(prev);
  });

  it('keeps the object of every chat whose id and updatedAt match, and takes the new one for the rest', () => {
    const prev = [chat('a', 1), chat('b', 2), chat('c', 3)];
    const next = [chat('a', 1), chat('b', 5), chat('c', 3)];
    const merged = reuseSessions(prev, next);
    expect(merged).not.toBe(prev);
    expect(merged[0]).toBe(prev[0]);
    expect(merged[1]).toBe(next[1]);
    expect(merged[2]).toBe(prev[2]);
  });

  it('takes the new object when a field changed without updatedAt moving', () => {
    const prev = [chat('a', 1, { title: 'x' })];
    const next = [chat('a', 1, { title: 'renamed' })];
    expect(reuseSessions(prev, next)[0]).toBe(next[0]);
  });

  it('follows the new order and length', () => {
    const prev = [chat('a', 1), chat('b', 2)];
    expect(reuseSessions(prev, [chat('b', 2), chat('a', 1)]).map((s) => s.id)).toEqual(['b', 'a']);
    expect(reuseSessions(prev, [chat('a', 1)])).toHaveLength(1);
  });
});

describe('refreshSessions', () => {
  beforeEach(() => { useStore.setState({ sessions: [chat('a', 1), chat('b', 2)] }); });

  it('does not notify subscribers when the list came back unchanged', async () => {
    window.nekko = { listSessionSummaries: vi.fn().mockResolvedValue([chat('a', 1), chat('b', 2)]) } as unknown as typeof window.nekko;
    const before = useStore.getState().sessions;
    const seen = vi.fn();
    const off = useStore.subscribe((s, p) => { if (s.sessions !== p.sessions) seen(); });
    await useStore.getState().refreshSessions();
    off();
    expect(useStore.getState().sessions).toBe(before);
    expect(seen).not.toHaveBeenCalled();
  });
});
