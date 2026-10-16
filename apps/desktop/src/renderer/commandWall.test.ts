import { describe, expect, it } from 'vitest';
import type { PendingInput, SessionSummary, TerminalInfo } from '@nekko-agent/shared';
import { allPanes, extent, isSplit, type WbPane } from './layout.js';
import {
  DEFAULT_AGENT_PANEL,
  readAgentPanel,
  DEFAULT_WALL_STATE,
  DEFAULT_MONITORS_DOCK,
  DEFAULT_WALL_LAYOUT,
  MONITORS,
  WALL_KINDS,
  sanitizeWallLayout,
  sanitizeMonitorsDock,
  LEGACY_GRID_KEY,
  WALL_STATE_KEY,
  addPane,
  autoShape,
  filterTree,
  leafRects,
  loadWallState,
  migrateGridState,
  reconcileWall,
  ribbonItems,
  toWallSetting,
  saveWallState,
  seedWall,
  tileTree,
  wallPane,
} from './commandWall.js';

const chat = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id, title: id, createdAt: 1_000, updatedAt: 1_000, ...extra }) as unknown as SessionSummary;
const term = (id: string, running = true): TerminalInfo =>
  ({ id, title: id, cwd: '/', shell: 'sh', createdAt: 1_000, running }) as TerminalInfo;
const panes = (n: number): WbPane[] => Array.from({ length: n }, (_, i) => wallPane('chat', `c${i}`));
const refs = (root: ReturnType<typeof tileTree>) => allPanes(root).map((p) => p.refId);

describe('autoShape', () => {
  it('fills a wide area with squarish windows and the fewest empty places', () => {
    const wide = (n: number) => autoShape(n, 1.8);
    expect(wide(1)).toEqual({ cols: 1, rows: 1 });
    expect(wide(2)).toEqual({ cols: 2, rows: 1 });
    expect(wide(3)).toEqual({ cols: 2, rows: 2 });
    expect(wide(4)).toEqual({ cols: 2, rows: 2 });
    expect(wide(5)).toEqual({ cols: 3, rows: 2 });
    expect(wide(7)).toEqual({ cols: 3, rows: 3 });
  });
});

describe('tileTree', () => {
  it('is nothing for no windows and the window itself for one', () => {
    expect(tileTree([])).toBeNull();
    const [only] = panes(1);
    expect(tileTree([only])).toBe(only);
  });
  it('tiles five windows as a row of three over a row of two, in reading order', () => {
    const root = tileTree(panes(5), 1.8);
    expect(root && isSplit(root) && root.dir).toBe('col');
    expect(extent(root)).toEqual({ across: 3, down: 2 });
    expect(refs(root)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
  });
  it('shares each row equally', () => {
    const root = tileTree(panes(4), 1.8);
    const rects = leafRects(root);
    for (const r of rects.values()) {
      expect(r.width).toBeCloseTo(0.5);
      expect(r.height).toBeCloseTo(0.5);
    }
  });
});

describe('addPane', () => {
  it('starts a wall with the window itself', () => {
    const [a] = panes(1);
    expect(addPane(null, a)).toBe(a);
  });
  it('appends agents as balanced sequential tiles instead of splitting the last agent', () => {
    const items = panes(7);
    let root = tileTree(items.slice(0, 6), 1.8);
    root = addPane(root, items[6], 1.8);
    expect(refs(root)).toEqual(items.map((p) => p.refId));
    const rects = leafRects(root);
    const last = rects.get(items[5].id)!;
    const added = rects.get(items[6].id)!;
    expect(added.y).toBeGreaterThan(last.y);
    expect(last.height).toBeCloseTo(added.height);
    expect(last.width).toBeGreaterThanOrEqual(1 / 3);
  });
  it('never breaks the 8×8 ceiling', () => {
    let root = tileTree(panes(1), 1.8);
    for (let i = 1; i < 80; i++) root = addPane(root, wallPane('chat', `x${i}`), 1.8);
    const { across, down } = extent(root);
    expect(across).toBeLessThanOrEqual(8);
    expect(down).toBeLessThanOrEqual(8);
  });
});

describe('filterTree', () => {
  it('lifts out the other kind', () => {
    const root = tileTree([wallPane('chat', 'a'), wallPane('terminal', 't')], 1.8);
    expect(refs(filterTree(root, 'all'))).toEqual(['a', 't']);
    expect(refs(filterTree(root, 'chat'))).toEqual(['a']);
    expect(refs(filterTree(root, 'terminal'))).toEqual(['t']);
  });
});

describe('seedWall', () => {
  it('starts with the chats touched in the last day and the shells still running, without panels in the tree', () => {
    const now = 100 * 60 * 60_000;
    const seeded = seedWall(
      DEFAULT_WALL_STATE,
      [chat('fresh', { updatedAt: now - 1000 }), chat('stale', { updatedAt: now - 48 * 60 * 60_000 }), chat('child', { updatedAt: now, parentSessionId: 'fresh' } as Partial<SessionSummary>)],
      [term('live'), term('dead', false)],
      now,
    );
    const kinds = allPanes(seeded.root).map((p) => `${p.kind}:${p.refId}`);
    expect(kinds).toEqual(['chat:fresh', 'terminal:live']);
    expect(seeded.watermark).toBe(now);
  });
});

describe('reconcileWall', () => {
  const now = 10_000;
  const seeded = seedWall(DEFAULT_WALL_STATE, [chat('a', { updatedAt: now })], [], now);

  it('waits for the lists before seeding, then seeds once', () => {
    expect(reconcileWall(DEFAULT_WALL_STATE, [], [], now)).toBe(DEFAULT_WALL_STATE);
    expect(reconcileWall(DEFAULT_WALL_STATE, [chat('a', { updatedAt: now })], [], now).watermark).toBe(now);
  });
  it('drops a chat that is gone or archived and adds one created since', () => {
    const next = reconcileWall(seeded, [chat('a', { archivedAt: 5 } as Partial<SessionSummary>), chat('b', { createdAt: now + 1 })], [], now + 5);
    const kinds = allPanes(next.root).map((p) => `${p.kind}:${p.refId}`);
    expect(kinds).not.toContain('chat:a');
    expect(kinds).toContain('chat:b');
    expect(next.watermark).toBe(now + 1);
  });
  it('does not add new chats while auto-add is off, but still moves the watermark', () => {
    const next = reconcileWall({ ...seeded, autoAdd: false }, [chat('a', { updatedAt: now }), chat('b', { createdAt: now + 1 })], [], now + 5);
    expect(allPanes(next.root).map((p) => p.refId)).not.toContain('b');
    expect(next.watermark).toBe(now + 1);
  });
  it('keeps spawned delegates out of automatic windows', () => {
    const next = reconcileWall(seeded, [chat('a', { updatedAt: now }), chat('child', { createdAt: now + 1, parentSessionId: 'a' })], [], now + 5);
    expect(allPanes(next.root).map((p) => p.refId)).not.toContain('child');
    expect(next.watermark).toBe(now + 1);
  });
  it('returns the same object when nothing changed', () => {
    expect(reconcileWall(seeded, [chat('a', { updatedAt: now })], [], now + 5)).toBe(seeded);
  });
});

describe('persistence', () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };

  it('round-trips a wall and never mints a restored id again', () => {
    const storage = memory();
    const state = seedWall(DEFAULT_WALL_STATE, [chat('a', { updatedAt: 1 }), chat('b', { updatedAt: 1 })], [], 1);
    saveWallState(storage, state);
    const loaded = loadWallState(storage);
    expect(loaded.root).toEqual(state.root);
    const fresh = wallPane('chat', 'z');
    expect(allPanes(loaded.root).some((p) => p.id === fresh.id)).toBe(false);
  });
  it('carries the previous grid over as a tiled wall with monitors', () => {
    const storage = memory();
    storage.setItem(LEGACY_GRID_KEY, JSON.stringify({ cells: [{ kind: 'chat', refId: 'a' }, { kind: 'terminal', refId: 't' }], autoAdd: false, filter: 'chat', insights: { show: true, panels: { models: true } }, watermark: 77 }));
    const loaded = loadWallState(storage);
    expect(allPanes(loaded.root).map((p) => `${p.kind}:${p.refId}`)).toEqual(['chat:a', 'terminal:t']);
    expect(loaded.dock.monitors.automations).toBe(true);
    expect(loaded.dock.monitors.insights).toBe(true);
    expect(loaded.autoAdd).toBe(false);
    expect(loaded.filter).toBe('chat');
    expect(loaded.insights.panels.models).toBe(true);
    expect(loaded.watermark).toBe(77);
  });
  it('leaves the panels out when the grid had hidden its insights box', () => {
    const migrated = migrateGridState({ cells: [{ kind: 'chat', refId: 'a' }], insights: { show: false } });
    expect(allPanes(migrated!.root).map((p) => p.kind)).toEqual(['chat']);
    expect(migrated!.dock.monitors.automations).toBe(false);
    expect(migrated!.dock.monitors.insights).toBe(false);
  });
  it('tolerates a damaged entry and an unknown kind', () => {
    const storage = memory();
    storage.setItem(WALL_STATE_KEY, '{nope');
    expect(loadWallState(storage)).toEqual(DEFAULT_WALL_STATE);
    storage.setItem(WALL_STATE_KEY, JSON.stringify({ root: { id: 'split_1', dir: 'row', children: [{ id: 'pane_2', kind: 'browser', refId: 'x' }, { id: 'pane_3', kind: 'chat', refId: 'a' }], sizes: [0.5, 0.5] } }));
    const loaded = loadWallState(storage);
    expect(allPanes(loaded.root).map((p) => p.refId)).toEqual(['a']);
  });
});

describe('the setting', () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };
  it('wins over the browser copy, which stays the fallback', () => {
    const storage = memory();
    const local = seedWall(DEFAULT_WALL_STATE, [chat('local', { updatedAt: 1 })], [], 1);
    saveWallState(storage, local);
    const shared = seedWall(DEFAULT_WALL_STATE, [chat('shared', { updatedAt: 1 })], [], 2);
    expect(allPanes(loadWallState(storage, toWallSetting(shared)).root).map((p) => p.refId)).toContain('shared');
    expect(allPanes(loadWallState(storage, null).root).map((p) => p.refId)).toContain('local');
  });
  it('round-trips through the setting shape', () => {
    const state = seedWall({ ...DEFAULT_WALL_STATE, autoAdd: false, filter: 'terminal' }, [chat('a', { updatedAt: 1 })], [term('t')], 5);
    const back = loadWallState(undefined, toWallSetting(state));
    expect(back).toEqual(state);
  });
});

describe('ribbonItems', () => {
  const approval = (command?: string): PendingInput =>
    ({ sessionId: 'a', approval: { call: { id: 'c1', name: 'run_command', input: command ? { command } : {} }, reason: 'shell', severity: 'medium', requestedAt: 1 } }) as unknown as PendingInput;
  const question = (): PendingInput => ({ sessionId: 'q', question: { id: 'q1', questions: [] } }) as unknown as PendingInput;

  it('lists each waiting chat once, with the command an approval wants to run', () => {
    const items = ribbonItems([chat('a', { title: 'Ship it' }), chat('q', { title: 'Retry policy' }), chat('idle')], { a: approval('git push -u origin cc'), q: question() });
    expect(items).toEqual([
      { sessionId: 'a', title: 'Ship it', blocked: 'approval', what: 'git push -u origin cc', command: true },
      { sessionId: 'q', title: 'Retry policy', blocked: 'question', what: 'asked you a question', command: false },
    ]);
  });
  it('falls back to the tool name, shortens a long command, and skips archived chats', () => {
    const long = 'x'.repeat(80);
    const items = ribbonItems([chat('a'), chat('b'), chat('z', { archivedAt: 9 } as Partial<SessionSummary>)], { a: approval(), b: approval(long), z: question() });
    expect(items.map((i) => i.what)).toEqual(['run_command', `${'x'.repeat(47)}…`]);
  });
});

describe('wall preferences and panel migration', () => {
  const restore = (saved: unknown) => loadWallState({ getItem: () => JSON.stringify(saved) });
  const a = { id: 'pane_a', kind: 'chat', refId: 'a' };
  const b = { id: 'pane_b', kind: 'terminal', refId: 'b' };
  it('exports the dock descriptors and fresh defaults without tree panels', () => {
    expect(WALL_KINDS).toEqual(['chat', 'terminal']);
    expect(MONITORS.map(p => p.key)).toEqual(Object.keys(DEFAULT_MONITORS_DOCK.monitors));
    expect(DEFAULT_MONITORS_DOCK).toEqual({ side: 'right', show: true,
      monitorOrder: MONITORS.map(p => p.key),
      minimized: { automations: false, utilization: false, budget: false, insights: false, hardware: false },
      monitors: { automations: true, utilization: true, budget: true, insights: false, hardware: true } });
    expect(seedWall(DEFAULT_WALL_STATE, [], [], 9).root).toBeNull();
    expect(DEFAULT_WALL_STATE.hero).toBeNull();
    expect(DEFAULT_WALL_STATE.folded).toEqual({});
  });
  it('clamps finite dimensions and rejects malformed persisted values', () => {
    expect(sanitizeWallLayout({ mode: 'fixed', cols: 99, rows: -2 })).toEqual({ mode: 'fixed', cols: 6, rows: 1 });
    expect(sanitizeWallLayout({ mode: 'focus', cols: 2.6, rows: 1.2 })).toEqual({ mode: 'focus', cols: 3, rows: 1 });
    expect(sanitizeWallLayout({ mode: 'other', cols: Infinity, rows: '4' })).toEqual(DEFAULT_WALL_LAYOUT);
    expect(sanitizeMonitorsDock({ side: 'other', show: 0, minimized: 'yes', panels: { insights: true, budget: false, vitals: true, hardware: 0, alien: true } }))
      .toEqual({ ...DEFAULT_MONITORS_DOCK, monitors: { ...DEFAULT_MONITORS_DOCK.monitors, insights: true, budget: false } });
    for (const side of ['right', 'left', 'top', 'bottom']) expect(sanitizeMonitorsDock({ side }).side).toBe(side);
    for (const watermark of [-1, '10', null]) expect(restore({ watermark }).watermark).toBe(0);
    const state = restore({ autoAdd: 'false', hero: 42, folded: { a: true, b: false, c: 1, '': true } });
    expect(state.autoAdd).toBe(true);
    expect(state.hero).toBeNull();
    expect(state.folded).toEqual({ a: true, b: false });
    expect(restore(null)).toEqual(DEFAULT_WALL_STATE);
    expect(sanitizeMonitorsDock([])).toEqual(DEFAULT_MONITORS_DOCK);
  });
  it('reads docks saved before monitors were renamed from panels', () => {
    const legacy = sanitizeMonitorsDock({ panels: { insights: true, budget: false }, panelOrder: ['budget', 'hardware'] });
    expect(legacy.monitors).toEqual({ ...DEFAULT_MONITORS_DOCK.monitors, insights: true, budget: false });
    expect(legacy.monitorOrder?.slice(0, 2)).toEqual(['budget', 'hardware']);
    expect(legacy).not.toHaveProperty('panels');
    expect(legacy).not.toHaveProperty('panelOrder');
    // The new names win when both are present.
    expect(sanitizeMonitorsDock({ monitors: { budget: true }, panels: { budget: false } }).monitors.budget).toBe(true);
  });
  it('sanitizes minimization independently for known monitors without mutating defaults', () => {
    const minimized = { utilization: true, budget: false, insights: true, hardware: 1, alien: true };
    const dock = sanitizeMonitorsDock({ panels: { utilization: false }, minimized });
    expect(dock.minimized).toEqual({ ...DEFAULT_MONITORS_DOCK.minimized, utilization: true, insights: true });
    expect(dock.monitors.utilization).toBe(false);
    expect(dock.minimized).not.toBe(DEFAULT_MONITORS_DOCK.minimized);
    dock.minimized.automations = true;
    expect(DEFAULT_MONITORS_DOCK.minimized.automations).toBe(false);
    expect(minimized).toEqual({ utilization: true, budget: false, insights: true, hardware: 1, alien: true });
    for (const invalid of [true, false, null, 'yes', [], { utilization: 'yes' }]) {
      expect(sanitizeMonitorsDock({ minimized: invalid }).minimized).toEqual(DEFAULT_MONITORS_DOCK.minimized);
    }
  });
  it('persists companion folding per session without removing or folding chat panes', () => {
    const root = tileTree([wallPane('chat', 'a'), wallPane('chat', 'b')]);
    const state = restore({ root, folded: { a: true, b: false } });
    expect(state.folded).toEqual({ a: true, b: false });
    expect(state.root).toEqual(root);
    expect(refs(state.root)).toEqual(['a', 'b']);
    expect(loadWallState(undefined, toWallSetting(state))).toEqual(state);
  });
  it('removes old panel leaves, enables their dock flags and preserves relative sizes', () => {
    const saved = { root: { id: 'split_c', dir: 'row', children: [a,
      { id: 'pane_d', kind: 'automations', refId: 'automations' }, b,
      { id: 'pane_e', kind: 'insights', refId: 'insights' }], sizes: [0.2, 0.3, 0.4, 0.1] },
      dock: { show: false, monitors: { automations: false, insights: false } } };
    const state = restore(saved);
    expect(state.root).toMatchObject({ id: 'split_c', dir: 'row', children: [a, b] });
    if (!state.root || !isSplit(state.root)) throw new Error('Expected split');
    expect(state.root.sizes[0]).toBeCloseTo(1 / 3);
    expect(state.root.sizes[1]).toBeCloseTo(2 / 3);
    expect(state.dock.monitors.automations).toBe(true);
    expect(state.dock.monitors.insights).toBe(true);
    expect(state.dock.show).toBe(false);
    expect(saved.dock.monitors.insights).toBe(false);
    expect(loadWallState(undefined, toWallSetting(state))).toEqual(state);
    expect(DEFAULT_MONITORS_DOCK.monitors.insights).toBe(false);
  });
  it('collapses panel-only branches without changing intact nested trees', () => {
    const nested = { id: 'split_f', dir: 'col', children: [a, b], sizes: [0.25, 0.75] };
    const state = restore({ root: { id: 'split_g', dir: 'row', children: [nested,
      { id: 'pane_h', kind: 'insights', refId: 'insights' }], sizes: [0.7, 0.3] } });
    expect(state.root).toEqual(nested);
    expect(restore({ root: { id: 'pane_i', kind: 'insights', refId: 'insights' } }).root).toBeNull();
  });
  it('round-trips every new preference through local and shared persistence', () => {
    const state = { ...DEFAULT_WALL_STATE, layout: { mode: 'focus' as const, cols: 6, rows: 1 },
      dock: { ...DEFAULT_MONITORS_DOCK, side: 'bottom' as const, show: false,
        minimized: { ...DEFAULT_MONITORS_DOCK.minimized, utilization: true, budget: true } },
      hero: 'session-a', folded: { 'session-a': true, 'session-b': false } };
    let raw = '';
    saveWallState({ setItem: (_, value) => { raw = value; } }, state);
    expect(loadWallState({ getItem: () => raw })).toEqual(state);
    expect(loadWallState(undefined, toWallSetting(state))).toEqual(state);
  });
});

 describe('agent tab placement', () => {
  it('persists each choice and defaults invalid values to top', () => {
    for (const tabs of ['top', 'left', 'hidden'] as const) {
      const state = { ...DEFAULT_WALL_STATE, tabs };
      expect(loadWallState(undefined, toWallSetting(state)).tabs).toBe(tabs);
      let raw = '';
      saveWallState({ setItem: (_, value) => { raw = value; } }, state);
      expect(loadWallState({ getItem: () => raw }).tabs).toBe(tabs);
    }
    expect(loadWallState({ getItem: () => JSON.stringify({ tabs: 'invalid' }) }).tabs).toBe('top');
  });
});

describe('agent panel preferences', () => {
  it('persists close and orientation, defaulting to a shown column', () => {
    for (const agentPanel of [{ show: false, orientation: 'vertical' }, { show: true, orientation: 'horizontal' }] as const) {
      const state = { ...DEFAULT_WALL_STATE, agentPanel };
      expect(loadWallState(undefined, toWallSetting(state)).agentPanel).toEqual(agentPanel);
      let raw = '';
      saveWallState({ setItem: (_, value) => { raw = value; } }, state);
      expect(loadWallState({ getItem: () => raw }).agentPanel).toEqual(agentPanel);
    }
    expect(loadWallState({ getItem: () => JSON.stringify({ agentPanel: { show: 'no', orientation: 'diagonal' } }) }).agentPanel).toEqual(DEFAULT_AGENT_PANEL);
    expect(readAgentPanel(undefined)).toEqual({ show: true, orientation: 'vertical' });
  });
});
