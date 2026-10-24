import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import './tests/browserGlobals.js';
import { liveStore } from './tests/liveStore.js';
import { loadCommandCenter, stubProps } from './tests/renderCommandCenter.js';
import { chatSession, renderChatPane, withProvider } from './tests/renderChatPane.js';
import { DEFAULT_WALL_STATE, openWallPane, tileTree, wallPane } from './commandWall.js';
import { allPanes } from './layout.js';
import { loadDraft, restoredDraftImages, saveDraft } from './composerDrafts.js';

vi.mock('./store.js', (original) => liveStore(original as never));
vi.mock('./liveRuns.js', async (original) => ({ ...(await original<object>()), useLiveRun: () => undefined }));

describe('guarded wall selection', () => {
  for (const mode of ['focus', 'grid', 'fixed'] as const) {
    it(`keeps the tree and no-ops a reselect in ${mode}`, () => {
      const root = tileTree([wallPane('chat', 'a'), wallPane('chat', 'b')]);
      const state = { ...DEFAULT_WALL_STATE, root, hero: 'a', layout: { ...DEFAULT_WALL_STATE.layout, mode: mode === 'fixed' ? 'grid' as const : mode, fixedGrid: mode === 'fixed' } };
      const next = openWallPane(state, 'chat', 'b');
      expect(next.root).toBe(root);
      expect(next.hero).toBe('b');
      expect(next.layout).toBe(state.layout);
      expect(openWallPane(next, 'chat', 'b')).toBe(next);
      expect(openWallPane(state, 'chat', 'a')).toBe(state);
    });
  }

  it('adds a missing chat once; a terminal takes the hero only in Focus', () => {
    const state = openWallPane(DEFAULT_WALL_STATE, 'chat', 'a');
    const next = openWallPane(state, 'chat', 'b');
    expect(allPanes(next.root).map((p) => p.refId)).toEqual(['a', 'b']);
    expect(openWallPane(next, 'chat', 'b')).toBe(next);
    const grid = { ...next, layout: { ...next.layout, mode: 'grid' as const } };
    const terminal = openWallPane(grid, 'terminal', 't');
    expect(terminal.hero).toBe('b');
    expect(openWallPane(terminal, 'terminal', 't')).toBe(terminal);
    const focus = { ...next, layout: { ...next.layout, mode: 'focus' as const } };
    expect(openWallPane(focus, 'terminal', 't').hero).toBe('t');
  });

  it('lifts a filter that would hide the opened window, and keeps one that shows it', () => {
    const state = { ...openWallPane(DEFAULT_WALL_STATE, 'chat', 'a'), filter: 'terminal' as const };
    expect(openWallPane(state, 'chat', 'a').filter).toBe('all');
    const chats = { ...state, filter: 'chat' as const };
    expect(openWallPane(chats, 'chat', 'a')).toBe(chats);
  });

  it('opens a sidebar pick of an existing chat without a host round trip', async () => {
    // The page's real sidebar callback. Where it lands (the guarded
    // openWallPane above, or the reader for a completed chat) is page state a
    // server render cannot observe; that half belongs to the chat-switch e2e
    // journey (see the PR's Unfinished work).
    const page = await loadCommandCenter();
    const active = { id: 'live', title: 'Live', archivedAt: undefined } as never;
    const done = { id: 'old', title: 'Old', archivedAt: 1 } as never;
    page.useStore.setState({ sessions: [active, done] });
    page.render({ commandWall: { agentPanel: { show: true, orientation: 'vertical' } } as never });
    const onOpenChat = stubProps.sidebar!.onOpenChat as (id: string) => void;
    const created = vi.fn();
    const nekko = (globalThis as { window: { nekko: unknown } }).window.nekko;
    (globalThis as { window: { nekko: unknown } }).window.nekko = new Proxy({}, { get: () => created });
    try {
      // An existing chat: no host round trip (nothing created), just the guarded wall update.
      onOpenChat('live');
      onOpenChat('old');
      expect(created).not.toHaveBeenCalled();
    } finally {
      (globalThis as { window: { nekko: unknown } }).window.nekko = nekko;
    }
  });
});

describe('draft restoration identity', () => {
  it('reuses empty and equal state, duplicate attachments included', () => {
    const empty: string[] = [];
    expect(restoredDraftImages(empty)).toBe(empty);
    expect(restoredDraftImages(empty, undefined)).toBe(empty);
    const images = ['a', 'a', 'b'];
    expect(restoredDraftImages(images, [...images])).toBe(images);
  });

  it('takes the restored images on any addition, removal or reorder', () => {
    for (const images of [[], ['b'], ['b', 'a'], ['a', 'b', 'c']]) {
      expect(restoredDraftImages(['a', 'b'], images)).toBe(images);
    }
    expect(restoredDraftImages(['a'], undefined)).toEqual([]);
  });

  it('restores a chat its own parked draft and attachments, never another chat\'s', () => {
    withProvider();
    const a = chatSession();
    const b = chatSession();
    saveDraft(a.id, { text: 'parked for a', images: ['data:image/png;base64,AAAA'] });
    const composerA = renderChatPane(a, { surface: 'composer' });
    expect(composerA).toContain('data-composer-attachments');
    expect(composerA).toContain('data:image/png;base64,AAAA');
    const composerB = renderChatPane(b, { surface: 'composer' });
    expect(composerB).not.toContain('data-composer-attachments');
    expect(composerB).not.toContain('data:image/png;base64,AAAA');
  });

  it('parks the newest draft text and clears an emptied one', () => {
    const id = chatSession().id;
    saveDraft(id, { text: 'first', images: [] });
    saveDraft(id, { text: 'first and last', images: [] });
    expect(loadDraft(id)?.text).toBe('first and last');
    saveDraft(id, { text: '  ', images: [] });
    expect(loadDraft(id)).toBeNull();
  });

  // Source pin, pending the chat-switch e2e journey: the flush is a layout-effect
  // cleanup and a beforeunload listener, which a server render never runs and no
  // DOM library is installed for. Losing it loses the last keystrokes.
  it('flushes the last keystrokes on unmount and on window close (source pin)', () => {
    const source = readFileSync(new URL('./components/ChatPane.tsx', import.meta.url), 'utf8');
    expect(source).toMatch(/const flush = \(\) => saveDraft\(sessionId, latestDraft\.current\);?\s*window\.addEventListener\('beforeunload', flush\);\s*return \(\) => \{\s*window\.removeEventListener\('beforeunload', flush\);\s*flush\(\);\s*\};/);
  });
});
