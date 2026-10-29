import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { cssRule, cssValue, stylesheet } from '../tests/css.js';
import { DEFAULT_WALL_STATE, type CommandWallState } from '../commandWall.js';
import { type WbPane, type WbSplit } from '../layout.js';
import type { Workspace } from '../store.js';

const fixture = vi.hoisted(() => ({ workspaces: [] as Workspace[] }));
vi.mock('../store.js', () => ({ useStore: (select: (s: { workspaces: Workspace[] }) => unknown) => select(fixture) }));
vi.mock('./ChatPane.js', () => ({ ChatPane: ({ sessionId, surface }: { sessionId: string; surface: string }) => <textarea data-surface={surface} defaultValue={`draft:${sessionId}`} /> }));
vi.mock('./TerminalPane.js', () => ({ TerminalPane: ({ terminalId }: { terminalId: string }) => <div data-terminal={terminalId} /> }));
vi.mock('./FilePane.js', () => ({ FilePane: ({ path }: { path: string }) => <div data-file={path} /> }));
vi.mock('./ExplorerPane.js', () => ({ ExplorerPane: ({ paneId }: { paneId: string }) => <div data-explorer={paneId} /> }));
vi.mock('./BrowserPane.js', () => ({ BrowserPane: ({ url }: { url: string }) => <div data-browser={url} /> }));
vi.mock('./DiffPane.js', () => ({ DiffPane: ({ sessionId }: { sessionId: string }) => <div data-diff={sessionId} /> }));
vi.mock('./PaneFrame.js', () => ({
  PaneFrame: ({ title, children, focusAction }: { title: string; children: React.ReactNode; focusAction?: React.ReactNode }) => <section data-title={title}>{focusAction}{children}</section>,
  PaneActions: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
import { applyWallDrop } from '../wallDrag.js';
import { CommandWall, commandWallGeometry, companionTree, resizeCompanionSplit, sameDeps, WARM_COMPOSERS, warmFront, workspaceCompanions } from './CommandWall.js';
import { leafRects } from '../commandWall.js';

const a: WbPane = { id: 'a', kind: 'chat', refId: 'chat-a' };
const b: WbPane = { id: 'b', kind: 'chat', refId: 'chat-b' };
const t: WbPane = { id: 't', kind: 'terminal', refId: 'term' };
const root: WbSplit = { id: 'split', dir: 'row', children: [a, b, t], sizes: [0.5, 0.3, 0.2] };
const state = (patch: Partial<CommandWallState> = {}): CommandWallState => ({ ...DEFAULT_WALL_STATE, root, layout: { mode: 'grid', cols: 3, rows: 2, fixedGrid: false }, folded: {}, ...patch });
/** `fixed` is Dynamic with Fixed grid on. */
const layout = (mode: 'grid' | 'focus' | 'fixed', cols = 2, rows = 1) => ({ mode: mode === 'fixed' ? 'grid' as const : mode, cols, rows, fixedGrid: mode === 'fixed' });

function wall(s: CommandWallState, addContent?: React.ReactNode) {
  return <CommandWall state={s} setState={vi.fn()} sessions={[]} terminals={[]} running={new Set()} pending={{}} childrenOf={new Map()} projects={[]} flash={null} selectedId={null} onSelect={vi.fn()} onAspect={vi.fn()} onOpenChat={vi.fn()} onOpenTerminal={vi.fn()} onNewChat={vi.fn()} onNewTerminal={vi.fn()} onAddWindow={vi.fn()} addContent={addContent} />;
}

describe('empty zone', () => {
  it('shows the sleeping Nekko and the plus menu options, Agent in the accent colour', () => {
    const z: WbPane = { id: 'z', kind: 'zone', refId: 'z', zone: 'Zone 1' };
    const html = renderToStaticMarkup(wall(state({ root: z, layout: layout('grid', 1, 1) })));
    expect(html).toContain('wall-zone-art pixel-sleeping');
    expect([...html.matchAll(/data-zone-create="(\w+)"/g)].map((m) => m[1])).toEqual(['chat', 'image', 'terminal']);
    expect(html).toMatch(/class="btn btn-ghost wall-zone-option text-accent" data-zone-create="chat"/);
    // Named by the label alone, so "Agent" stays "Agent" with its shortcut beside it (#1310 broke the e2e lookup).
    expect(html).toMatch(/data-zone-create="chat" aria-label="Agent" title="Agent \([^)]+\)"/);
    expect(html.match(/wall-zone-plus/g)).toHaveLength(3);
    expect([...html.matchAll(/<kbd class="kbd wall-zone-kbd">([^<]+)<\/kbd>/g)]).toHaveLength(3);
    expect(html).toContain('Drag in an agent chat or start a new one below.');
  });
});

describe('command wall geometry', () => {
  it('nests creation details inside the Add tile without a pane-stage offset', () => {
    const html = renderToStaticMarkup(wall(state(), <div>New chat details</div>));
    expect(html).toMatch(/command-wall-add-tile[^]*?wall-window-picker[^]*?New chat details[^]*?<\/section>/);
    expect(html).not.toContain('top:80px');
  });
  it.each(['grid', 'fixed'] as const)('fits %s windows into the space remaining above the composer', (mode) => {
    const before = JSON.stringify(root);
    const g = commandWallGeometry(state({ layout: layout(mode, 3, 2) }), 2400, 600);
    expect(g.stageHeight).toBeLessThanOrEqual(600);
    for (const pane of g.panes.values()) expect(pane.y + pane.height).toBeLessThanOrEqual(600);
    expect(JSON.stringify(root)).toBe(before);
  });
  it('converts an expanded divider resize back to saved ratios without cumulative widening', () => {
    const expanded = new Set(['a']);
    const resized = resizeCompanionSplit(root, expanded, 'split', 0, .6) as WbSplit;
    const displayed = companionTree(resized, expanded) as WbSplit;
    expect(displayed.sizes[0]).toBeCloseTo(.6);
    expect(displayed.sizes[2]).toBeCloseTo((companionTree(root, expanded) as WbSplit).sizes[2]);
    expect(companionTree(displayed, expanded, 1 / 1.9)).toEqual(resized);
    expect(root.sizes).toEqual([.5, .3, .2]);
  });
  it('keeps the Add preview separate from every existing window', () => {
    const g = commandWallGeometry(state(), 1000, 700, new Set(['a']));
    for (const pane of g.panes.values()) {
      const overlapWidth = Math.min(pane.x + pane.width, g.add.x + g.add.width) - Math.max(pane.x, g.add.x);
      const overlapHeight = Math.min(pane.y + pane.height, g.add.y + g.add.height) - Math.max(pane.y, g.add.y);
      expect(overlapWidth > 0 && overlapHeight > 0).toBe(false);
    }
  });
  it('widens companion leaves without changing saved ratios', () => {
    const before = JSON.stringify(root);
    const widened = companionTree(root, new Set(['a'])) as WbSplit;
    expect(widened.sizes[0] / widened.sizes[1]).toBeCloseTo((0.5 * 1.9) / 0.3);
    expect(JSON.stringify(root)).toBe(before);
  });

  it('does not duplicate shared companions under a secondary chat', () => {
    const shared = { ...workspace, root: { ...root, children: [a, b, ...companions], sizes: Array(7).fill(1 / 7) } };
    expect(workspaceCompanions([shared], 'chat-b')).toEqual([]);
    expect(workspaceCompanions([shared], 'chat-a')).toHaveLength(4);
  });
  it('keeps narrow Focus transcripts and approval controls above stacked companions', () => {
    const g = commandWallGeometry(state({ layout: layout('focus'), hero: 'chat-a' }), 390, 300);
    expect(g.panes.get('a')!.height).toBe(960);
    expect(g.height).toBe(960);
    expect(g.panes.get('a')!.height * .65).toBeGreaterThan(600);
  });

  it('retains saved Grid ratios and split identities without mutating the source tree', () => {
    const s = state();
    const before = JSON.stringify(s);
    const g = commandWallGeometry(s, 1000, 700);
    // No Add rail is reserved: the windows take the full measured height.
    expect(g.panes.get('a')).toEqual({ x: 0, y: 0, width: 496, height: 700 });
    expect(g.panes.get('b')).toEqual({ x: 504, y: 0, width: 292, height: 700 });
    expect(g.panes.get('t')).toEqual({ x: 804, y: 0, width: 196, height: 700 });
    expect(g.addGrid!.id).toBe(root.id);
    expect(g.deck.size).toBe(0);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('ignores companion folding in every mode, including Focus hero selection', () => {
    for (const mode of ['grid', 'fixed', 'focus'] as const) {
      const s = state({ layout: layout(mode), hero: 'chat-a' });
      const g = commandWallGeometry(s, 1000, 700);
      const folded = commandWallGeometry({ ...s, folded: { 'chat-a': true, 'chat-b': true, term: true } }, 1000, 700);
      expect(folded.panes).toEqual(g.panes);
      expect(folded.deck).toEqual(g.deck);
      expect(folded.hero).toEqual(g.hero);
      expect(folded.add).toEqual(g.add);
      expect(g.deck.size).toBe(mode === 'focus' ? 2 : 0);
    }
  });

  it.each([[1000, 700], [2400, 400], [390, 700]])('reserves no Add space until opened at %i × %i', (width, height) => {
    const before = JSON.stringify(root);
    const idle = commandWallGeometry(state(), width, height);
    const preview = commandWallGeometry(state(), width, height, new Set(), true);
    expect(idle.add.height).toBe(0);
    expect(idle.add.width).toBe(0);
    expect(preview.add.height).toBeGreaterThan(28);
    expect(preview.panes.has('__wall_add__')).toBe(false);
    expect(JSON.stringify(root)).toBe(before);
    for (const pane of preview.panes.values()) {
      const overlapWidth = Math.min(pane.x + pane.width, preview.add.x + preview.add.width) - Math.max(pane.x, preview.add.x);
      const overlapHeight = Math.min(pane.y + pane.height, preview.add.y + preview.add.height) - Math.max(pane.y, preview.add.y);
      expect(overlapWidth > 0 && overlapHeight > 0).toBe(false);
    }
  });

  it('displays a saved divider edit instead of re-balancing it on render', () => {
    const resized = resizeCompanionSplit(root, new Set(), root.id, 0, .6);
    const g = commandWallGeometry(state({ root: resized }), 1000, 700);
    expect(g.panes.get('a')!.width).toBe(596);
    expect(g.panes.get('b')!.x).toBe(604);
    expect(g.panes.get('b')!.width).toBeCloseTo(192);
    expect(g.addGrid!.id).toBe(root.id);
  });

  it('does not reserve a full Add card in a short viewport', () => {
    const g = commandWallGeometry(state(), 1000, 480);
    expect(g.height).toBe(g.add.y + g.add.height);
    expect(g.height).toBe(480);
  });

  it('uses Focus-only deck and falls back when the hero is missing or filtered', () => {
    const g = commandWallGeometry(state({ layout: layout('focus'), hero: 'chat-b' }), 1000, 700);
    expect(g.hero).toBe('b');
    expect(g.panes.get('b')).toEqual({ x: 0, y: 0, width: 1000, height: 700 });
    expect([...g.deck]).toEqual(['a', 't']);
    expect(g.add.x).toBe(0);
    expect(g.add.width).toBeLessThanOrEqual(1000);
    expect(g.add.height).toBe(240);
    expect(commandWallGeometry(state({ layout: layout('focus'), hero: 'missing' }), 1000, 700).hero).toBe('a');
    expect(commandWallGeometry(state({ layout: layout('focus'), filter: 'terminal' }), 1000, 700).hero).toBe('t');
  });

  it('keeps Grid (fixed) overflow scrollable without a deck or an Add rail', () => {
    const g = commandWallGeometry(state({ layout: layout('fixed') }), 1000, 700);
    expect(g.add).toEqual({ x: 1000, y: 1408, width: 0, height: 0 });
    expect(g.height).toBe(1408);
    expect(g.deck.size).toBe(0);
    const opened = commandWallGeometry(state({ layout: layout('fixed') }), 1000, 700, new Set(), true);
    // Opening Add takes the next free cell, beside the last window.
    expect(opened.add).toEqual({ x: 504, y: 708, width: 496, height: 700 });
  });

  it('lists the unfilled Grid squares for placeholders, and none in Dynamic or on a phone', () => {
    // Three windows in a 3×2 Grid leave the bottom row empty.
    const g = commandWallGeometry(state({ layout: layout('fixed', 3, 2) }), 1000, 700);
    expect(g.empty).toHaveLength(3);
    expect(g.empty.every((r) => r.y > 0 && r.width > 0 && r.height > 0)).toBe(true);
    for (const cell of g.empty) for (const pane of g.panes.values()) {
      const overlapW = Math.min(pane.x + pane.width, cell.x + cell.width) - Math.max(pane.x, cell.x);
      const overlapH = Math.min(pane.y + pane.height, cell.y + cell.height) - Math.max(pane.y, cell.y);
      expect(overlapW > 0 && overlapH > 0).toBe(false);
    }
    expect(commandWallGeometry(state(), 1000, 700).empty).toEqual([]);
    expect(commandWallGeometry(state({ layout: layout('fixed', 3, 2) }), 400, 700).empty).toEqual([]);
    const html = renderToStaticMarkup(wall(state({ layout: layout('fixed', 3, 2) })));
    expect(html).not.toContain('data-wall-empty-cell'); // unmeasured: nothing drawn yet
  });

  it('previews a held window at the place a board-edge drop puts it', () => {
    const stacked: WbSplit = { id: 'col', dir: 'col', children: [a, b], sizes: [0.5, 0.5] };
    const s = state({ root: stacked });
    const right = commandWallGeometry({ ...s, root: applyWallDrop(s.root, 'b', { kind: 'edge', side: 'right' }) }, 1000, 600).panes.get('b')!;
    expect(right).toMatchObject({ y: 0, height: 600 });
    expect(right.x).toBeGreaterThan(490);
    // Already the bottom row: the zone stays where the window already is.
    expect(commandWallGeometry({ ...s, root: applyWallDrop(s.root, 'b', { kind: 'edge', side: 'down' }) }, 1000, 600).panes.get('b')).toEqual(commandWallGeometry(s, 1000, 600).panes.get('b'));
    const cols = state({ root: { id: 'row', dir: 'row', children: [a, b, t], sizes: [1 / 3, 1 / 3, 1 / 3] } });
    const bottom = commandWallGeometry({ ...cols, root: applyWallDrop(cols.root, 't', { kind: 'edge', side: 'down' }) }, 900, 600).panes.get('t')!;
    expect(bottom).toMatchObject({ x: 0, width: 900 });
    expect(bottom.y).toBeGreaterThan(290);
  });

  it('stacks narrow Grid and Fixed panes and handles unmeasured empty mounts', () => {
    for (const mode of ['grid', 'fixed'] as const) {
      const g = commandWallGeometry(state({ layout: layout(mode) }), 400, 700);
      expect(g.panes.get('a')!.height).toBe(440);
      expect(g.add.y).toBe(1336);
    }
    for (const mode of ['grid', 'fixed', 'focus'] as const) {
      const g = commandWallGeometry(state({ root: null, layout: layout(mode) }), 0, 0);
      expect(g.panes.size).toBe(0);
      for (const n of Object.values(g.add)) expect(Number.isFinite(n) && n >= 0).toBe(true);
    }
  });
});

const companions: WbPane[] = [
  { id: 'file', kind: 'file', refId: '/source.ts' },
  { id: 'files', kind: 'files', refId: '/project' },
  { id: 'browser', kind: 'browser', refId: 'https://example.com' },
  { id: 'diff', kind: 'diff', refId: 'chat-a' },
  { id: 'other-diff', kind: 'diff', refId: 'chat-b' },
];
const workspace: Workspace = { id: 'workspace', anchor: { kind: 'chat', refId: 'chat-a' }, activePaneId: 'a', root: { ...root, children: [a, ...companions], sizes: Array(6).fill(1 / 6) } };

describe('workspace companions and stable bodies', () => {
  it('reads the anchored workspace or containing layout without copying pane records', () => {
    expect(workspaceCompanions([workspace], 'chat-a')).toEqual(companions.slice(0, 4));
    expect(workspaceCompanions([workspace], 'chat-a')[0]).toBe(companions[0]);
    expect(workspaceCompanions([{ ...workspace, anchor: { kind: 'terminal', refId: 'term' } }], 'chat-a')).toEqual(companions.slice(0, 4));
    expect(workspaceCompanions([workspace], 'missing')).toEqual([]);
  });

  it('counts companions, has no whole-chat collapse control, and keeps all bodies mounted', () => {
    fixture.workspaces = [workspace];
    try {
      const html = renderToStaticMarkup(wall(state({ folded: { 'chat-a': true }, filter: 'chat' })));
      expect(html).not.toContain('Expand companions');
    expect(html).toContain('title="Zen: focus this window (Ctrl+Shift+1)"');
      // The focus action wears the target ring: outer ring, inner ring, centre dot.
      const focus = html.slice(html.indexOf('agent-zen-action'));
      expect(focus.slice(0, focus.indexOf('</button>'))).toMatch(/<circle cx="12" cy="12" r="9"><\/circle><circle cx="12" cy="12" r="5"><\/circle><circle cx="12" cy="12" r="1.5" fill="currentColor"><\/circle>/);
      expect(html).not.toContain('Collapse Chat');
      expect(html).not.toContain('command-wall-folded');
      expect(html).toContain('draft:chat-a');
      expect(html).toContain('draft:chat-b');
      expect(html).toContain('data-terminal="term"');
      expect(html).toContain('data-explorer="files"');
      expect(html).toContain('data-browser="https://example.com"');
      expect(html).toContain('data-diff="chat-a"');
      // Add window is the composer's; the wall itself has no edge + rails.
      expect(html).not.toContain('command-wall-add-rail');
      expect(html).not.toContain('aria-label="Add window"');
      expect(html).toContain('aria-label="Focus Chat"');
      expect(html).not.toContain('aria-label="Open Chat in the Agent tab"');
    } finally { fixture.workspaces = []; }
  });

  it('keeps every window body under one stage parent in every layout, so switching layout never remounts a chat', () => {
    for (const mode of ['grid', 'fixed', 'focus'] as const) {
      const html = renderToStaticMarkup(wall(state({ layout: layout(mode), hero: 'chat-a' })));
      const stage = html.slice(html.indexOf('class="command-wall-pane-stage"'));
      // All three windows are siblings in the stage, in tree order, whatever the mode.
      expect([...stage.matchAll(/data-wall-pane="([^"]+)"/g)].map((m) => m[1]), mode).toEqual(['a', 'b', 't']);
      expect(stage).toContain('draft:chat-a');
      expect(stage).toContain('draft:chat-b');
      expect(stage).toContain('data-terminal="term"');
      // Only the Focus hero is the full chat; every other chat window shows its transcript.
      expect(stage.match(/data-surface="full"/g)?.length ?? 0, mode).toBe(mode === 'focus' ? 1 : 0);
    }
  });

  it('closes a companion through the store, and folding never makes a window inert', () => {
    fixture.workspaces = [workspace];
    try {
      const html = renderToStaticMarkup(wall(state({ folded: { 'chat-a': true, 'chat-b': true } })));
      // Only the absent-box and deck-card cases make content inert; folding is not one of them.
      expect(html).not.toMatch(/class="command-wall-content"[^>]*inert/);
      expect(html).toMatch(/aria-label="Close (?:Changes|Files|Browser)"/);
    } finally { fixture.workspaces = []; }
  });

  it('slides windows by position only, in step with the push timing, and stops under reduced motion', () => {
    const css = stylesheet('components/commandWallLayouts.css');
    const move = cssRule(css, '.command-wall-window').transition;
    expect(move).toBe(cssValue('left var(--wall-push-ms) var(--wall-push-ease), top var(--wall-push-ms) var(--wall-push-ease)'));
    expect(move).not.toMatch(/width|height/);
    expect(cssRule(css, '.command-wall-layout')).toMatchObject({ '--wall-push-ms': '280ms', '--wall-push-ease': cssValue('cubic-bezier(.22, 1, .36, 1)') });
    for (const selector of ['.command-wall-window', '.command-wall-add']) {
      expect(cssRule(css, selector, { media: 'prefers-reduced-motion: reduce' }).transition, selector).toBe('none');
    }
  });
});

describe('click-only wall insertion and composer framing', () => {
  it('reserves an Add card only when the add content is open, never on hover or focus', () => {
    // Idle: no add tile, no preview slot, and no hover handlers anywhere on the wall.
    const idle = renderToStaticMarkup(wall(state()));
    expect(idle).not.toContain('command-wall-add');
    expect(idle).not.toContain('data-preview');
    const open = renderToStaticMarkup(wall(state(), <div>Pick a window</div>));
    expect(open).toMatch(/<section class="command-wall-add command-wall-add-tile" data-preview="true"/);
    // Only an empty wall's call-to-action still opens Add from inside the wall.
    expect(idle).not.toContain('aria-label="Add window"');
    expect(renderToStaticMarkup(wall(state({ root: null })))).toContain('aria-label="Add window"');
  });
  it('offers Add from an empty wall', () => {
    const html = renderToStaticMarkup(wall(state({ root: null })));
    expect(html).toContain('aria-label="Add window"');
    // The empty wall shows its illustration, centred, above the call to action.
    expect(html).toContain('data-wall-empty');
    expect(html).toContain('wall-empty-art');
    expect(html).toContain('The wall is empty');
  });
  it('paints one composer fill: the card takes the window surface and the panel around it stays clear', () => {
    // The rail's own brand row (only without app chrome) is covered by the
    // App render in boardRailSpacing.test.ts; the title bar carries it otherwise.
    const css = stylesheet('styles.css');
    expect(cssRule(css, '.wall-composer')).toMatchObject({ position: 'relative', width: '75%', 'max-width': '100%', 'flex-shrink': '0', background: 'transparent', 'box-shadow': 'none' });
    expect(cssRule(css, '.wall-composer .composer').background).toBe('var(--win)');
    expect(cssRule(css, '.send-avatar')['margin-right']).toBe('4px');
  });
});

describe('focus full-height chat', () => {
  it('keeps the hero full height and moves other agents out of the stage', () => {
    const g = commandWallGeometry(state({ layout: layout('focus'), hero: 'chat-a' }), 1000, 700);
    expect(g.height).toBe(700);
    expect(g.panes.get('a')?.height).toBe(700);
    expect(g.panes.has('b')).toBe(false);
  });
  it('renders the composer inside the focused chat only', () => {
    const html = renderToStaticMarkup(wall(state({ layout: layout('focus'), hero: 'chat-a' })));
    expect(html).toContain('data-surface="full"');
    expect(html).toContain('data-focus-chat="true"');
  });
  it('parks the other Focus windows under the hero instead of display: none', () => {
    const html = renderToStaticMarkup(wall(state({ layout: layout('focus'), hero: 'chat-a' })));
    const windows = html.match(/<div class="command-wall-window[^>]*>/g) ?? [];
    const hero = windows.find((w) => w.includes('data-wall-pane="a"'))!;
    const parked = windows.find((w) => w.includes('data-wall-pane="b"'))!;
    expect(hero).not.toContain('data-wall-parked');
    expect(parked).toContain('data-wall-parked="true"');
    // At the hero's box, so a switch changes no geometry; and without the deck
    // styling, so it restyles nothing inside the window.
    expect(parked.match(/style="[^"]*"/)?.[0]).toBe(hero.match(/style="[^"]*"/)?.[0]);
    expect(parked).not.toContain('display:none');
    expect(parked).not.toContain('command-wall-deck-window');
    // Never drawn and never hit, and pointer-events stops at the window: it
    // inherits, so letting it reach the transcript restyles every element.
    const css = stylesheet('components/commandWallLayouts.css');
    expect(cssRule(css, '.command-wall-window[data-wall-parked]')).toMatchObject({ 'content-visibility': 'hidden', 'pointer-events': 'none', transition: 'none' });
    expect(cssRule(css, ':where(.command-wall-window) > :where(*)')['pointer-events']).toBe('auto');
    // Leaving Focus they jump to their places: sliding a dozen full-size
    // windows down at once rastered them all whole.
    expect(cssRule(css, '.command-wall-window[data-wall-snap]').transition).toBe('none');
  });
  it('keeps the composer of a recent hero while parked, for a bounded few', () => {
    expect(warmFront([], 'a')).toEqual(['a']);
    const ids = ['a', 'b'];
    expect(warmFront(ids, 'a')).toBe(ids);
    expect(warmFront(ids, 'b')).toEqual(['b', 'a']);
    expect(warmFront(['a', 'b', 'c', 'd'], 'e')).toEqual(['e', 'a', 'b', 'c']);
    expect(WARM_COMPOSERS).toBe(4);
  });
  it('skips re-rendering a window whose inputs are the same values', () => {
    const pane = { id: 'p' };
    expect(sameDeps([pane, 1, 'x', undefined], [pane, 1, 'x', undefined])).toBe(true);
    expect(sameDeps([pane, 1], [{ id: 'p' }, 1])).toBe(false);
    expect(sameDeps([1], [1, 2])).toBe(false);
    expect(sameDeps([NaN], [NaN])).toBe(true);
  });
  // Source pin, pending the wall e2e journey: an approval arrives from the
  // host (a promise or an agent event), which a server render never applies.
  it('suppresses approvals on composer-only surfaces (source pin)', () => {
    const source = readFileSync(new URL('./ChatPane.tsx', import.meta.url), 'utf8');
    expect(source).toMatch(/approval && surface !== 'composer' && <ApprovalBar\b/);
  });
});

// Source pin, pending the chat-switch e2e journey: the save and the flush are
// effects (a timer and a layout cleanup) that a server render never runs.
it('never saves or flushes a draft from a transcript surface (source pin)', () => {
  const source = readFileSync(new URL('./ChatPane.tsx', import.meta.url), 'utf8');
  expect(source).toMatch(/if \(readOnly \|\| surface === 'transcript'\) return;\s*const t = setTimeout\(\(\) => saveDraft\(/);
  expect(source).toMatch(/if \(surface === 'transcript' \|\| readOnly\) return;[^]{0,400}const flush = \(\) => saveDraft\(/);
});
