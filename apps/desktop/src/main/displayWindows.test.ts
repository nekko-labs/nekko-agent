import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { pickWindowForAgent, readDisplayPrefs, swipeBounds, SWIPE_EDGE } from '../displayWindows.js';
import { CLAIM_GRACE_MS, createDisplayWindows, type ScreenDisplay, type ScreenWindow } from './displayWindows.js';

const area = (x: number) => ({ x, y: 0, width: 1920, height: 1040 });
const display = (id: number, x: number): ScreenDisplay => ({ id, bounds: { ...area(x), height: 1080 }, workArea: area(x), scaleFactor: 1 });

/** A fake clock + screen + windows, driven by hand. */
function rig(displays: ScreenDisplay[], saved?: unknown) {
  const dataDir = mkdtempSync(join(tmpdir(), 'displays-'));
  if (saved) writeFileSync(join(dataDir, 'display-windows.json'), JSON.stringify(saved));
  let clock = 0;
  const timers: Array<{ at: number; fn: () => void; dead?: boolean }> = [];
  const handlers: Record<string, () => void> = {};
  let nextId = 10;
  const made: Array<FakeWindow> = [];
  class FakeWindow implements ScreenWindow {
    bounds; destroyed = false; shown = false; listeners: Record<string, Array<() => void>> = {}; trail: number[] = [];
    webContents = { id: nextId++, send: () => {} };
    constructor(public displayId: string, b: { x: number; y: number; width: number; height: number }) { this.bounds = b; }
    setBounds(b: typeof this.bounds) { this.bounds = b; this.trail.push(b.width); }
    getBounds() { return this.bounds; }
    show() { this.shown = true; }
    close() { this.destroy(); }
    destroy() { if (this.destroyed) return; this.destroyed = true; (this.listeners.closed ?? []).forEach((f) => f()); }
    isDestroyed() { return this.destroyed; }
    once(e: string, f: () => void) { (this.listeners[e] ??= []).push(f); }
    emit(e: string) { (this.listeners[e] ?? []).forEach((f) => f()); }
  }
  const main = new FakeWindow('main', area(0));
  const broadcasts: number[] = [];
  const placed: Array<[string, string]> = [];
  const dw = createDisplayWindows({
    dataDir,
    screen: {
      getAllDisplays: () => displays,
      getPrimaryDisplay: () => displays[0],
      getDisplayMatching: (r) => displays.find((d) => r.x >= d.bounds.x && r.x < d.bounds.x + d.bounds.width) ?? displays[0],
      on: (e, f) => { handlers[e] = f; },
    },
    mainWindow: () => main,
    createWindow: (id, b) => { const w = new FakeWindow(id, b); made.push(w); return w; },
    broadcast: () => { broadcasts.push(clock); },
    placed: (key, s) => placed.push([key, s]),
    setTimer: (fn, ms) => { const t = { at: clock + ms, fn }; timers.push(t); return t; },
    clearTimer: (t) => { (t as { dead?: boolean }).dead = true; },
    now: () => clock,
  });
  const advance = (ms: number) => {
    const until = clock + ms;
    for (;;) {
      const due = timers.filter((t) => !t.dead && t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.dead = true; clock = due.at; due.fn();
    }
    clock = until;
  };
  return { dw, main, made, advance, handlers, broadcasts, placed, dataDir, displays };
}

describe('multi-monitor placement policy', () => {
  it('prefers an empty screen, else the emptiest, main winning ties', () => {
    expect(pickWindowForAgent([{ key: 'main', panes: 3 }, { key: '2', panes: 0 }], 'empty-first')).toBe('2');
    expect(pickWindowForAgent([{ key: 'main', panes: 0 }, { key: '2', panes: 0 }], 'empty-first')).toBe('main');
    expect(pickWindowForAgent([{ key: 'main', panes: 2 }, { key: '2', panes: 2 }, { key: '3', panes: 1 }], 'empty-first')).toBe('3');
    expect(pickWindowForAgent([{ key: 'main', panes: 5 }, { key: '2', panes: 0 }], 'main-first')).toBe('main');
    expect(pickWindowForAgent([{ key: 'main', panes: 5 }], 'empty-first')).toBe('main');
  });

  it('reads saved prefs defensively', () => {
    expect(readDisplayPrefs(null)).toEqual({ enabled: [], placement: 'empty-first' });
    expect(readDisplayPrefs({ enabled: ['2', 2, '2', ''], placement: 'main-first' })).toEqual({ enabled: ['2'], placement: 'main-first' });
  });

  it('swipes in from the left edge and out into the right edge', () => {
    const a = area(1920);
    expect(swipeBounds(a, 'in', 0)).toEqual({ ...a, width: SWIPE_EDGE });
    expect(swipeBounds(a, 'in', 1)).toEqual(a);
    expect(swipeBounds(a, 'in', 0.5).x).toBe(a.x);
    expect(swipeBounds(a, 'out', 0)).toEqual(a);
    const end = swipeBounds(a, 'out', 1);
    expect(end.width).toBe(SWIPE_EDGE);
    expect(end.x + end.width).toBe(a.x + a.width);
  });
});

describe('screen windows', () => {
  it('lists every screen with the main one locked on', () => {
    const { dw, main } = rig([display(1, 0), display(2, 1920)]);
    dw.start();
    const s = dw.state(main.webContents.id);
    expect(s.displays.map((d) => [d.label, d.main, d.enabled, d.self])).toEqual([['1', true, true, true], ['2', false, false, false]]);
    dw.toggle('1', false, false);
    expect(dw.state(main.webContents.id).displays[0].enabled).toBe(true);
  });

  it('opens a screen window as a left strip that grows to fill the screen, and remembers it', () => {
    const { dw, made, advance, dataDir } = rig([display(1, 0), display(2, 1920)]);
    dw.start();
    dw.toggle('2', true, false);
    const win = made[0];
    expect(win.bounds).toEqual({ ...area(1920), width: SWIPE_EDGE });
    win.emit('ready-to-show');
    advance(400);
    expect(win.shown).toBe(true);
    expect(win.bounds).toEqual(area(1920));
    expect(win.trail[0]).toBeLessThan(win.trail[win.trail.length - 1]);
    expect(win.trail.every((w, i) => i === 0 || w >= win.trail[i - 1])).toBe(true);
    expect(JSON.parse(readFileSync(join(dataDir, 'display-windows.json'), 'utf8')).enabled).toEqual(['2']);
  });

  it('shrinks into the right edge, then closes', () => {
    const { dw, made, advance } = rig([display(1, 0), display(2, 1920)]);
    dw.start();
    dw.toggle('2', true, true);
    made[0].emit('ready-to-show');
    dw.toggle('2', false, false);
    expect(made[0].isDestroyed()).toBe(false);
    advance(400);
    expect(made[0].isDestroyed()).toBe(true);
    const widths = made[0].trail.slice(1);
    expect(widths.every((w, i) => i === 0 || w <= widths[i - 1])).toBe(true);
    expect(dw.openIds()).toEqual([]);
  });

  it('restores saved screens on start, skipping the main screen and missing ones', () => {
    const { dw, made } = rig([display(1, 0), display(2, 1920)], { enabled: ['1', '2', '99'] });
    dw.start();
    expect(made.map((w) => w.displayId)).toEqual(['2']);
  });

  it('drops a window whose screen was unplugged', () => {
    const r = rig([display(1, 0), display(2, 1920)], { enabled: ['2'] });
    r.dw.start();
    r.displays.pop();
    r.handlers['display-removed']();
    expect(r.made[0].isDestroyed()).toBe(true);
  });

  it('a window keeps the agents it makes; the main window places by preference', async () => {
    const { dw, made, main, placed } = rig([display(1, 0), display(2, 1920)]);
    dw.start();
    dw.toggle('2', true, true);
    const screen2 = made[0];
    dw.report(main.webContents.id, 4);
    dw.report(screen2.webContents.id, 0);
    await expect(dw.claim(screen2.webContents.id, 'a', 'self')).resolves.toBe('2');
    await expect(dw.claim(main.webContents.id, 'b', 'place')).resolves.toBe('2');
    expect(placed).toEqual([['2', 'b']]);
    // Decided once: a second claim does not move it.
    await expect(dw.claim(main.webContents.id, 'b', 'self')).resolves.toBe('2');
    dw.setPlacement('main-first');
    await expect(dw.claim(main.webContents.id, 'c', 'place')).resolves.toBe('main');
  });

  it('waits briefly for an appearing agent, letting its creator claim it first', async () => {
    const { dw, made, main, advance } = rig([display(1, 0), display(2, 1920)]);
    dw.start();
    dw.toggle('2', true, true);
    const auto = dw.claim(main.webContents.id, 'x', 'auto');
    await expect(dw.claim(made[0].webContents.id, 'x', 'self')).resolves.toBe('2');
    await expect(auto).resolves.toBe('2');
    const late = dw.claim(made[0].webContents.id, 'y', 'auto');
    advance(CLAIM_GRACE_MS);
    await expect(late).resolves.toBe('main');
  });
});
