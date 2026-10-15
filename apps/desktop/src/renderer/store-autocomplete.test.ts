import { beforeEach, describe, expect, it, vi } from 'vitest';
import { summarizeSession, type Session } from '@nekko-agent/shared';

vi.hoisted(() => {
  (globalThis as { window?: unknown }).window = { innerWidth: 1280, addEventListener() {} };
});
vi.mock('./components/DeleteConfirmation.js', () => ({ confirmDeletion: vi.fn().mockResolvedValue(true) }));
const { useStore } = await import('./store.js');

const DAY = 24 * 60 * 60 * 1000;
const NOW = 400 * DAY;
const chat = (id: string, idleDays: number, extra: Partial<Session> = {}): Session =>
  ({ id, title: id, createdAt: 1, updatedAt: NOW - idleDays * DAY, messages: [], ...extra });

let saved: Record<string, unknown>;
function engine({ running = [] as string[], pending = {} as Record<string, unknown>, fail = '' } = {}) {
  saved = {};
  window.nekko = {
    runningSessions: vi.fn().mockResolvedValue(running),
    pendingInput: vi.fn().mockResolvedValue(pending),
    setSessionOptions: vi.fn(async (id: string, opts: { archivedAt: number }) => {
      if (id === fail) throw new Error('disk full');
      saved[id] = opts.archivedAt;
      return { ...chat(id, 0), archivedAt: opts.archivedAt };
    }),
    listSessionSummaries: vi.fn(async () => useStore.getState().sessions.map((s) => (saved[s.id] ? { ...s, archivedAt: saved[s.id] } : s))),
  } as unknown as typeof window.nekko;
}
function seed(sessions: Session[], autoCompleteAfterDays?: number) {
  useStore.setState({
    settings: { autoCompleteAfterDays } as never,
    sessions: sessions.map(summarizeSession), toasts: [], activeSessionId: 'old',
    workspaces: [{ id: 'ws_old', anchor: { kind: 'chat', refId: 'old' }, root: { id: 'p_old', kind: 'chat', refId: 'old' }, activePaneId: 'p_old' }],
    activeWorkspaceId: 'ws_old',
  });
}

beforeEach(() => engine());

describe('completing idle agents', () => {
  it('completes agents idle past a month by default, and closes their windows', async () => {
    seed([chat('old', 31), chat('recent', 29)]);
    expect(await useStore.getState().autoCompleteIdle(NOW)).toBe(1);
    expect(Object.keys(saved)).toEqual(['old']);
    const s = useStore.getState();
    expect(s.workspaces).toHaveLength(0);
    expect(s.activeSessionId).not.toBe('old');
    expect(s.toasts.at(-1)?.message).toContain('Completed 1 agent idle for over 1 month');
  });
  it('honours the chosen window and Never', async () => {
    seed([chat('old', 10)], 7);
    expect(await useStore.getState().autoCompleteIdle(NOW)).toBe(1);
    engine();
    seed([chat('old', 1000)], 0);
    expect(await useStore.getState().autoCompleteIdle(NOW)).toBe(0);
    expect(window.nekko.setSessionOptions).not.toHaveBeenCalled();
  });
  it('skips pinned, sub-agent, task, running and waiting agents', async () => {
    engine({ running: ['live'], pending: { asking: { question: {} } } });
    seed([chat('pinned', 90, { pinned: true }), chat('child', 90, { parentSessionId: 'p' }), chat('task', 90, { taskId: 't' }),
      chat('live', 90), chat('asking', 90), chat('gone', 90, { archivedAt: NOW - DAY })]);
    expect(await useStore.getState().autoCompleteIdle(NOW)).toBe(0);
  });
  it('does nothing when it cannot tell what is running', async () => {
    engine();
    (window.nekko.runningSessions as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('offline'));
    seed([chat('old', 90)]);
    expect(await useStore.getState().autoCompleteIdle(NOW)).toBe(0);
  });
  it('keeps a chat whose save failed open and retries it next time', async () => {
    engine({ fail: 'old' });
    seed([chat('old', 90), chat('other', 90)]);
    expect(await useStore.getState().autoCompleteIdle(NOW)).toBe(1);
    expect(useStore.getState().workspaces.map((w) => w.anchor.refId)).toEqual(['old']);
  });
});
