import { describe, expect, it, vi } from 'vitest';
import './tests/browserGlobals.js';
import { liveStore } from './tests/liveStore.js';
import { loadCommandCenter, stubProps } from './tests/renderCommandCenter.js';
import { chatSession, renderChatPane, withProvider } from './tests/renderChatPane.js';
import { newAgentSetup } from './newAgentSetup.js';
import { getCachedSession } from './sessionCache.js';

vi.mock('./store.js', (original) => liveStore(original as never));
vi.mock('./liveRuns.js', async (original) => ({ ...(await original<object>()), useLiveRun: () => undefined }));

describe('new agent setup calls', () => {
  it('opens a plain new agent without extra host round trips', () => {
    expect(newAgentSetup({}, { chatType: 'multimodal' })).toEqual({ options: false, supporting: false });
    // Toolbar New agent with saved default folders: one folder, nothing to support.
    expect(newAgentSetup({}, { chatType: 'multimodal', workspaceIds: ['w1'] })).toEqual({ options: false, supporting: false });
  });

  it('still configures what the picker changed', () => {
    expect(newAgentSetup({}, { chatType: 'image' }).options).toBe(true);
    expect(newAgentSetup({}, { providerId: 'p' }).options).toBe(true);
    expect(newAgentSetup({}, { modelId: 'm' }).options).toBe(true);
    expect(newAgentSetup({}, { workspaceIds: ['w1', 'w2'] }).supporting).toBe(true);
    // A reused session that already has supporting folders is cleared to the new choice.
    expect(newAgentSetup({ supportingWorkspaceIds: ['old'] }, { workspaceIds: ['w1'] }).supporting).toBe(true);
    // A reused image session asked to be a chat again.
    expect(newAgentSetup({ chatType: 'image' }, { chatType: 'multimodal' }).options).toBe(true);
  });

  it('seeds the cache and the list so the new window paints the created chat on its first frame', async () => {
    const page = await loadCommandCenter();
    // The detailed picker is the toolbar's; the page never hands the wall an add tile.
    expect(page.render()).toContain('data-stub="wall" data-add-content="false"');
    const created = chatSession({ title: 'Fresh agent', messages: [] });
    const nekko = (globalThis as unknown as { window: { nekko: Record<string, unknown> } }).window.nekko;
    const createSession = vi.fn(async () => created);
    (globalThis as unknown as { window: { nekko: unknown } }).window.nekko = new Proxy({ createSession }, { get: (t, k) => (t as Record<string | symbol, unknown>)[k] ?? (() => new Promise(() => {})) });
    try {
      const onNewChat = stubProps.wall!.onNewChat as () => Promise<string>;
      await expect(onNewChat()).resolves.toBe(created.id);
      expect(createSession).toHaveBeenCalledOnce();
      expect(getCachedSession(created.id)).toBe(created);
      expect(page.useStore.getState().sessions.some((s) => s.id === created.id)).toBe(true);
    } finally {
      (globalThis as unknown as { window: { nekko: unknown } }).window.nekko = nekko;
    }
  });

  it('lets the wall window reveal be the only entrance animation', () => {
    withProvider();
    const welcome = (commandCenter: boolean) => renderChatPane(chatSession({ messages: [] }), { commandCenter }).match(/<div class="([^"]*)" data-chat-welcome/)?.[1];
    expect(welcome(false)).toMatch(/\bfade-in\b/);
    expect(welcome(true)).toBeDefined();
    expect(welcome(true)).not.toMatch(/\bfade-in\b/);
  });
});
