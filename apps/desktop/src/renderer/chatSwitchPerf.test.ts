import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_WALL_STATE, openWallPane, tileTree, wallPane } from './commandWall.js';
import { allPanes } from './layout.js';
import { restoredDraftImages } from './composerDrafts.js';

describe('guarded wall selection', () => {
  for (const mode of ['focus', 'grid', 'fixed'] as const) {
    it(`preserves the tree and no-ops reselect in ${mode}`, () => {
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
  it('adds a missing chat once and leaves the hero alone for terminals', () => {
    const state = openWallPane(DEFAULT_WALL_STATE, 'chat', 'a');
    const next = openWallPane(state, 'chat', 'b');
    expect(allPanes(next.root).map((p) => p.refId)).toEqual(['a', 'b']);
    expect(openWallPane(next, 'chat', 'b')).toBe(next);
    const terminal = openWallPane(next, 'terminal', 't');
    expect(terminal.hero).toBe('b');
    expect(openWallPane(terminal, 'terminal', 't')).toBe(terminal);
  });
  it('keeps archived sidebar selection separate and schedules one active wall update', () => {
    const source = readFileSync(new URL('./views/CommandCenterView.tsx', import.meta.url), 'utf8');
    const handler = source.slice(source.indexOf('selectedId={completedId ?? selected}'), source.indexOf('onOpenTerminal={(id)'));
    expect(handler).toContain('?.archivedAt) setCompletedId(id)');
    expect(handler).toContain("void addFromToolbar('chat', id)");
    expect(handler).not.toContain('selectAgent(id)');
    expect(handler).not.toContain('setWall(');
    expect(source).toContain('setWall((w) => openWallPane(w, kind, ref, aspectRef.current))');
  });
});

describe('draft restoration identity', () => {
  it('reuses empty and equal nonempty state, including duplicate attachments', () => {
    const empty: string[] = [];
    expect(restoredDraftImages(empty)).toBe(empty);
    const images = ['a', 'a', 'b'];
    expect(restoredDraftImages(images, [...images])).toBe(images);
  });
  it('restores additions, removals and ordering rather than retaining another chat attachments', () => {
    for (const images of [[], ['b'], ['b', 'a'], ['a', 'b', 'c']]) {
      expect(restoredDraftImages(['a', 'b'], images)).toBe(images);
    }
  });
  it('retains last-keystroke flushing and per-session persistence boundaries', () => {
    const source = readFileSync(new URL('./components/ChatPane.tsx', import.meta.url), 'utf8');
    expect(source.match(/setPendingImages\(\(current\) => restoredDraftImages\(current, parked\?\.images\)\)/g)).toHaveLength(2);
    expect(source).toContain('latestDraft.current = { text: draft, images: pendingImages }');
    expect(source).toContain('const flush = () => saveDraft(sessionId, latestDraft.current)');
    expect(source).toContain("window.removeEventListener('beforeunload', flush); flush();");
    expect(source).toContain('if (draftLoadedFor.current === sessionId) return;');
  });
});
