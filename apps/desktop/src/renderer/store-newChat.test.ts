import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@nekko-agent/shared';
import { __resetSessionCache, getCachedSession } from './sessionCache.js';

vi.hoisted(() => {
  (globalThis as { window?: unknown }).window = { innerWidth: 1280, addEventListener() {} };
});
const { useStore } = await import('./store.js');
const created: Session = { id: 'new_chat', title: 'New chat', createdAt: 1, updatedAt: 1, messages: [], providerId: 'p', modelId: 'm' };

beforeEach(() => {
  __resetSessionCache();
  useStore.setState({ settingsLoaded: false, sessions: [], workspaces: [], activeWorkspaceId: null, activeProjectId: null, providers: [], models: [], activeProviderId: null, activeModelId: null });
});

describe('new-chat first frame', () => {
  it('selects the new chat on the wall in the current layout, its record already cached', async () => {
    window.nekko = { createSession: vi.fn().mockResolvedValue(created), listProviders: vi.fn().mockResolvedValue([{ id: 'p', kind: 'chatgpt', enabled: true }]), listModels: vi.fn().mockResolvedValue([]) } as unknown as typeof window.nekko;
    useStore.setState({ view: 'settings', focusRequest: null, settings: { workspaces: [] } as any });
    const open = vi.spyOn(useStore.getState(), 'openChatPane');
    try {
      await useStore.getState().newChat();
      expect(open).not.toHaveBeenCalled();
      expect(getCachedSession(created.id)).toBe(created);
      expect(useStore.getState().activeSessionId).toBe(created.id);
      expect(useStore.getState().view).toBe('command');
      expect(useStore.getState().focusRequest).toEqual({ sessionId: created.id, keepLayout: true });
      expect(useStore.getState().sessions[0]?.id).toBe(created.id);
    } finally { open.mockRestore(); useStore.setState({ settings: null }); }
  });
  it('caches image options rather than the unconfigured creation record', async () => {
    const image = { ...created, chatType: 'image' as const, imageParams: { modelId: 'image-model' } };
    window.nekko = {
      createSession: vi.fn().mockResolvedValue(created),
      setSessionOptions: vi.fn().mockResolvedValue(image),
    } as unknown as typeof window.nekko;
    const open = vi.spyOn(useStore.getState(), 'openChatPane').mockImplementation((id) => {
      expect(getCachedSession(id)).toBe(image);
    });
    try { await useStore.getState().newImageChat('image-model'); }
    finally { open.mockRestore(); }
  });
});

it('routes an unconfigured first agent to setup without creating an empty session', async () => {
  window.nekko = { listProviders: vi.fn().mockResolvedValue([{ id: 'nekko-engine', kind: 'llamacpp', enabled: true }]), listModels: vi.fn().mockResolvedValue([]), createSession: vi.fn() } as unknown as typeof window.nekko;
  await useStore.getState().newChat();
  expect(useStore.getState().view).toBe('models');
  expect(window.nekko.createSession).not.toHaveBeenCalled();
});

describe('last explicit primary folder', () => {
  it('persists folders and No folder for startup restoration', async () => {
    const data = new Map<string, string>();
    Object.assign(globalThis, { localStorage: { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) } });
    const { readLastFolder } = await import('./store.js');
    useStore.getState().setActiveProject('folder-b');
    expect(readLastFolder()).toBe('folder-b');
    useStore.getState().setActiveProject(null);
    expect(data.get('nekko.lastPrimaryFolder')).toBe('null');
    expect(readLastFolder()).toBeNull();
  });
  it('never selects the first folder on settings refresh', async () => {
    window.nekko = { getSettings: vi.fn().mockResolvedValue({ workspaces: [{ id: 'a' }] }) } as unknown as typeof window.nekko;
    const theme = vi.spyOn(useStore.getState(), 'applyTheme').mockImplementation(() => {});
    try {
      await useStore.getState().refreshSettings();
      expect(useStore.getState().activeProjectId).toBeNull();
      useStore.getState().setActiveProject('b');
      await useStore.getState().refreshSettings();
      expect(useStore.getState().activeProjectId).toBe('b');
    } finally { theme.mockRestore(); }
  });
  it('creates chats with the explicit default, including No folder', async () => {
    window.nekko = { createSession: vi.fn().mockResolvedValue(created), listProviders: vi.fn().mockResolvedValue([{ id: 'p', kind: 'chatgpt', enabled: true }]), listModels: vi.fn().mockResolvedValue([]) } as unknown as typeof window.nekko;
    useStore.getState().setActiveProject('b');
    await useStore.getState().newChat();
    expect(window.nekko.createSession).toHaveBeenLastCalledWith('b');
    useStore.setState({ settingsLoaded: true, settings: { workspaces: [] } as any });
    await useStore.getState().newChat();
    expect(window.nekko.createSession).toHaveBeenLastCalledWith(undefined);
    expect(useStore.getState().activeProjectId).toBe('b');
    useStore.getState().setActiveProject(null);
    await useStore.getState().newChat();
    expect(window.nekko.createSession).toHaveBeenLastCalledWith(undefined);
  });
});

it('explicit repository overrides active and saved default folders without changing them', async () => {
  window.nekko = { createSession: vi.fn().mockResolvedValue(created), listProviders: vi.fn().mockResolvedValue([{ id: 'p', kind: 'chatgpt', enabled: true }]), listModels: vi.fn().mockResolvedValue([]) } as unknown as typeof window.nekko;
  useStore.setState({ activeProjectId: 'a', settings: { workspaces: [{ id: 'a' }], defaultWorkspaceIds: ['a'] } as any });
  await useStore.getState().newChat('b');
  expect(window.nekko.createSession).toHaveBeenCalledWith('b');
  expect(useStore.getState().activeProjectId).toBe('a');
});
