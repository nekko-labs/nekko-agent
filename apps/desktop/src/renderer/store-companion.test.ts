import { beforeEach, describe, expect, it, vi } from 'vitest';
import { allPanes } from './layout.js';

vi.hoisted(() => {
  (globalThis as { window?: unknown }).window = { innerWidth: 1280, addEventListener() {} };
});
const { useStore } = await import('./store.js');

const chatWorkspace = { id: 'ws_a', anchor: { kind: 'chat' as const, refId: 'chat_a' }, root: { id: 'pane_a', kind: 'chat' as const, refId: 'chat_a' }, activePaneId: 'pane_a' };

beforeEach(() => {
  useStore.setState({ view: 'command', workspaces: [chatWorkspace], activeWorkspaceId: null, activeSessionId: null });
});

describe('wall companions', () => {
  it.each([['diff', 'chat_a'], ['browser', 'about:blank'], ['files', '']] as const)('opens %s beside the chat without leaving the Agent board', (kind, refId) => {
    expect(useStore.getState().openCompanion('chat_a', kind)).toBe(true);
    const s = useStore.getState();
    expect(s.view).toBe('command');
    expect(s.activeWorkspaceId).toBeNull();
    const panes = allPanes(s.workspaces[0].root);
    expect(panes.map((p) => [p.kind, p.refId])).toEqual([['chat', 'chat_a'], [kind, refId]]);
  });
  it('keeps one of each per chat', () => {
    useStore.getState().openCompanion('chat_a', 'browser');
    expect(useStore.getState().openCompanion('chat_a', 'browser')).toBe(true);
    expect(allPanes(useStore.getState().workspaces[0].root).filter((p) => p.kind === 'browser')).toHaveLength(1);
  });
  it('gives a chat with no workspace one of its own, still on the wall', () => {
    expect(useStore.getState().openCompanion('chat_b', 'diff')).toBe(true);
    const s = useStore.getState();
    expect(s.view).toBe('command');
    const ws = s.workspaces.find((w) => w.anchor.refId === 'chat_b')!;
    expect(allPanes(ws.root).map((p) => p.kind)).toEqual(['chat', 'diff']);
  });
});
