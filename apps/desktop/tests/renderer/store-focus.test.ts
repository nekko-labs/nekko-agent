import { beforeEach, expect, it, vi } from 'vitest';
import { allPanes } from '../../src/renderer/layout.js';

vi.hoisted(() => {
  Object.assign(globalThis, { window: { innerWidth: 1280, addEventListener() {} }, localStorage: { getItem: () => null } });
});
const { useStore } = await import('../../src/renderer/store.js');

beforeEach(() => {
  useStore.setState({ sessions: [], activeWorkspaceId: 'one', activeSessionId: 'chat-one', workspaces: [
    { id: 'one', anchor: { kind: 'chat', refId: 'chat-one' }, activePaneId: 'pane-one', root: { id: 'pane-one', kind: 'chat', refId: 'chat-one' } },
    { id: 'two', anchor: { kind: 'chat', refId: 'chat-two' }, activePaneId: 'pane-two', root: { id: 'pane-two', kind: 'chat', refId: 'chat-two' } },
  ] });
});

it('switches to a selected pane without invalidating workspace layout subscribers', () => {
  const before = useStore.getState().workspaces;
  useStore.getState().openChatPane('chat-two');
  expect(useStore.getState().activeWorkspaceId).toBe('two');
  expect(useStore.getState().activeSessionId).toBe('chat-two');
  expect(useStore.getState().workspaces).toBe(before);
});

it('updates the layout when selecting a different pane while retaining other workspaces', () => {
  const before = useStore.getState().workspaces;
  useStore.setState({ workspaces: [before[0], { ...before[1], activePaneId: null }] });
  useStore.getState().openChatPane('chat-two');
  expect(useStore.getState().workspaces[1].activePaneId).toBe('pane-two');
  expect(useStore.getState().workspaces[0]).toBe(before[0]);
});

const filePath = 'C:/project/report.md';

function seedFileInFirstChat() {
  useStore.getState().openFilePane(filePath);
  return useStore.getState().workspaces[0];
}

it('opens a separate file in the originating chat instead of jumping to a foreign workspace', () => {
  const foreign = seedFileInFirstChat();
  useStore.getState().setActiveWorkspace('two');
  useStore.getState().openFilePane(filePath, 'chat-two');
  const state = useStore.getState();
  expect(state.activeWorkspaceId).toBe('two');
  expect(state.activeSessionId).toBe('chat-two');
  expect(state.workspaces[0]).toBe(foreign);
  const files = allPanes(state.workspaces[1].root).filter((p) => p.kind === 'file');
  expect(files).toHaveLength(1);
  expect(files[0].refId).toBe(filePath);
  expect(state.workspaces[1].activePaneId).toBe(files[0].id);
});

it('reuses only the originating chat file when both workspaces show the same path', () => {
  const foreign = seedFileInFirstChat();
  useStore.getState().setActiveWorkspace('two');
  useStore.getState().openFilePane(filePath, 'chat-two');
  const localFile = allPanes(useStore.getState().workspaces[1].root).find((p) => p.kind === 'file')!;
  useStore.getState().openChatPane('chat-two');
  const before = useStore.getState().workspaces[1].root;
  useStore.getState().openFilePane(filePath, 'chat-two');
  const state = useStore.getState();
  expect(state.activeWorkspaceId).toBe('two');
  expect(state.activeSessionId).toBe('chat-two');
  expect(state.workspaces[0]).toBe(foreign);
  expect(state.workspaces[1].root).toBe(before);
  expect(state.workspaces[1].activePaneId).toBe(localFile.id);
  expect(allPanes(state.workspaces[1].root).filter((p) => p.kind === 'file')).toHaveLength(1);
});

it('routes to the originating chat even when a different workspace is active', () => {
  const foreign = seedFileInFirstChat();
  useStore.getState().openFilePane(filePath, 'chat-two');
  expect(useStore.getState().activeWorkspaceId).toBe('two');
  expect(useStore.getState().activeSessionId).toBe('chat-two');
  expect(useStore.getState().workspaces[0]).toBe(foreign);
  expect(allPanes(useStore.getState().workspaces[1].root).some((p) => p.kind === 'file' && p.refId === filePath)).toBe(true);
});

it('creates the originating chat workspace if it is not open yet', () => {
  const foreign = seedFileInFirstChat();
  useStore.getState().openFilePane(filePath, 'chat-three');
  const state = useStore.getState();
  const workspace = state.workspaces.find((w) => w.id === state.activeWorkspaceId)!;
  expect(state.activeSessionId).toBe('chat-three');
  expect(workspace.anchor).toEqual({ kind: 'chat', refId: 'chat-three' });
  expect(allPanes(workspace.root).map((p) => [p.kind, p.refId])).toEqual([
    ['chat', 'chat-three'], ['file', filePath],
  ]);
  expect(state.workspaces[0]).toBe(foreign);
});

it('preserves global file reuse when no originating chat is supplied', () => {
  const foreign = seedFileInFirstChat();
  useStore.getState().setActiveWorkspace('two');
  useStore.getState().openFilePane(filePath);
  expect(useStore.getState().activeWorkspaceId).toBe('one');
  expect(useStore.getState().workspaces[0]).toBe(foreign);
  expect(allPanes(useStore.getState().workspaces[1].root)).toHaveLength(1);
});
