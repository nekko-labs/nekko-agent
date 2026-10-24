import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session, SessionSummary } from '@nekko-agent/shared';

vi.hoisted(() => {
  (globalThis as { window?: unknown }).window = { innerWidth: 1280, addEventListener() {} };
});
const { useStore, addCreatedSession } = await import('./store.js');

const older: SessionSummary = { id: 'old', title: 'Old', createdAt: 1, updatedAt: 1 } as SessionSummary;
const created: Session = { id: 'new_chat', title: 'New chat', createdAt: 2, updatedAt: 2, messages: [] };

beforeEach(() => {
  useStore.setState({ sessions: [older], workspaces: [], activeWorkspaceId: null, activeSessionId: 'old' });
});

describe('a chat created while the session list is loading', () => {
  it('survives a list request that started before it existed', async () => {
    let answer!: (list: SessionSummary[]) => void;
    window.nekko = { listSessionSummaries: vi.fn(() => new Promise<SessionSummary[]>((r) => { answer = r; })) } as unknown as typeof window.nekko;
    const refresh = useStore.getState().refreshSessions();
    addCreatedSession(created);
    answer([older]); // stale: read before the new chat was written
    await refresh;
    expect(useStore.getState().sessions.map((s) => s.id)).toEqual(['new_chat', 'old']);
  });

  it('lets a list requested after the chat was created drop it (deleted elsewhere)', async () => {
    addCreatedSession(created);
    window.nekko = { listSessionSummaries: vi.fn().mockResolvedValue([older]) } as unknown as typeof window.nekko;
    await useStore.getState().refreshSessions();
    expect(useStore.getState().sessions.map((s) => s.id)).toEqual(['old']);
  });

  it('takes the host copy once the list includes the chat', async () => {
    addCreatedSession(created);
    const fresh = { ...created, title: 'Named' } as unknown as SessionSummary;
    window.nekko = { listSessionSummaries: vi.fn().mockResolvedValue([fresh, older]) } as unknown as typeof window.nekko;
    await useStore.getState().refreshSessions();
    expect(useStore.getState().sessions.map((s) => s.title)).toEqual(['Named', 'Old']);
  });
});
