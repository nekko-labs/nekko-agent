import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_WALL_STATE, openWallPane, tileTree, wallPane } from './commandWall.js';
import { allPanes } from './layout.js';
import { restoredDraftImages } from './composerDrafts.js';

describe('guarded wall selection', () => {
  for (const mode of ['focus', 'grid', 'fixed'] as const) {
    it(`keeps the tree and no-ops a reselect in ${mode}`, () => {
      const root = tileTree([wallPane('chat', 'a'), wallPane('chat', 'b')]);
      const state = { ...DEFAULT_WALL_STATE, root, hero: 'a', layout: { ...DEFAULT_WALL_STATE.layout, mode } };
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

  it('sends a sidebar pick through the single guarded update and keeps archived chats apart', () => {
    const source = readFileSync(new URL('./views/CommandCenterView.tsx', import.meta.url), 'utf8');
    const handler = source.slice(source.indexOf('onOpenChat={(id) => {'), source.indexOf('onOpenTerminal={(id)'));
    expect(handler).toContain('?.archivedAt) setCompletedId(id)');
    expect(handler).toContain("void addFromToolbar('chat', id)");
    expect(handler).not.toContain('selectAgent(id)');
    expect(handler).not.toContain('setWall(');
    expect(source).toContain('setWall((w) => openWallPane(w, kind, ref, aspectRef.current))');
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

  it('keeps last-keystroke flushing and per-chat restore boundaries', () => {
    const source = readFileSync(new URL('./components/ChatPane.tsx', import.meta.url), 'utf8');
    expect(source.match(/setPendingImages\(\(current\) => restoredDraftImages\(current, parked\?\.images\)\)/g)).toHaveLength(2);
    expect(source).toContain('const flush = () => saveDraft(sessionId, latestDraft.current)');
    expect(source).toContain("window.removeEventListener('beforeunload', flush); flush();");
    expect(source).toContain('if (draftLoadedFor.current === sessionId) return;');
  });
});
