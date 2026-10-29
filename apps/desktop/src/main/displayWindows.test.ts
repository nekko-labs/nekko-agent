import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { pickWindowForAgent, readDisplayPrefs, swipeBounds, SWIPE_EDGE } from '../displayWindows.js';
import { CLAIM_GRACE_MS, createDisplayWindows, type ScreenDisplay, type ScreenWindow, type SpacesApi } from './displayWindows.js';

const area = (x: number) => ({ x, y: 0, width: 1920, height: 1040 });
const display = (id: number, x: number): ScreenDisplay => ({ id, bounds: { ...area(x), height: 1080 }, workArea: area(x), scaleFactor: 1 });

/** A fake clock + screen + windows, driven by hand. */
function rig(displays: ScreenDisplay[], saved?: unknown, spaces?: SpacesApi) {
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
    spaces,
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
    expect(readDisplayPrefs(null)).toEqual({ enabled: [], placement: 'empty-first', spacesMode: 'ask' });
    expect(readDisplayPrefs({ enabled: ['2', 2, '2', ''], placement: 'main-first' })).toEqual({ enabled: ['2'], placement: 'main-first', spacesMode: 'ask' });
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

/** A fake Mission Control: desktops 1-3, Accessibility on or off, switches recorded. */
function fakeSpaces(trusted = false) {
  const fake = { current: '1', desktops: ['1', '2', '3'], trusted, prompted: 0, switches: [] as Array<[number, number]>, listener: (() => {}) as () => void };
  const api: SpacesApi = {
    read: async () => ({ current: fake.current, desktops: fake.desktops }),
    trusted: (prompt) => { if (prompt) fake.prompted++; return fake.trusted; },
    switchTo: async (from, to) => { fake.switches.push([from, to]); },
    onChange: (l) => { fake.listener = l; },
  };
  const go = async (sid: string) => { fake.current = sid; fake.listener(); await flush(); };
  return { fake, api, go };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('macOS desktops (Spaces)', () => {
  it('lists desktops once there are two, the main window\'s marked and always on', async () => {
    const { api } = fakeSpaces();
    const r = rig([display(1, 0)], undefined, api);
    r.dw.start(); await flush();
    const spaces = r.dw.state(r.main.webContents.id).spaces!;
    expect(spaces.mode).toBe('ask');
    expect(spaces.desktops.map((d) => [d.id, d.label, d.main, d.current, d.enabled, d.self])).toEqual([
      ['space-1', '1', true, true, true, true], ['space-2', '2', false, false, false, false], ['space-3', '3', false, false, false, false],
    ]);
    await r.dw.toggleDesktop('space-1', false);
    expect(r.made).toHaveLength(0);
  });
  it('without Accessibility, holds the new window hidden until you arrive on its desktop', async () => {
    const { fake, api, go } = fakeSpaces(false);
    const r = rig([display(1, 0)], undefined, api);
    r.dw.start(); await flush();
    r.dw.setSpacesMode('switch');
    expect(fake.prompted).toBe(1); // asked macOS once
    await r.dw.toggleDesktop('space-2', true);
    const win = r.made[0];
    expect(win.displayId).toBe('space-2');
    expect(fake.switches).toEqual([]);
    win.emit('ready-to-show');
    expect(win.shown).toBe(false);
    expect(r.dw.state(r.main.webContents.id).spaces!.desktops[1]).toMatchObject({ enabled: true, waiting: true });
    await go('3');
    expect(win.shown).toBe(false);
    await go('2');
    expect(win.shown).toBe(true);
    expect(r.dw.state(win.webContents.id).spaces!.desktops[1]).toMatchObject({ waiting: false, self: true, current: true });
  });
  it('with Accessibility in switch mode, jumps there and shows the window on arrival', async () => {
    const { fake, api, go } = fakeSpaces(true);
    const r = rig([display(1, 0)], undefined, api);
    r.dw.start(); await flush();
    r.dw.setSpacesMode('switch');
    expect(fake.prompted).toBe(0);
    await r.dw.toggleDesktop('space-3', true);
    expect(fake.switches).toEqual([[1, 3]]);
    r.made[0].emit('ready-to-show');
    await go('3');
    expect(r.made[0].shown).toBe(true);
    // Off closes it; screen syncs leave desktop windows alone.
    await r.dw.toggleDesktop('space-3', false);
    expect(r.made[0].destroyed).toBe(true);
  });
  it('keeps desktop windows through screen changes and follows the main window to its desktop', async () => {
    const { api, go } = fakeSpaces(true);
    const r = rig([display(1, 0)], undefined, api);
    r.dw.start(); await flush();
    await r.dw.toggleDesktop('space-2', true);
    r.handlers['display-added']();
    expect(r.made[0].destroyed).toBe(false);
    await go('3');
    r.dw.mainFocused(); await flush(); await flush();
    expect(r.dw.state(r.main.webContents.id).spaces!.desktops.find((d) => d.main)?.id).toBe('space-3');
  });
  it('voice: steps and numbers need Accessibility; screens turn on', async () => {
    const off = fakeSpaces(false);
    const r = rig([display(1, 0), display(2, 1920)], undefined, off.api);
    r.dw.start(); await flush();
    expect(await r.dw.go({ kind: 'desktop', n: 2 })).toBe('needs-access');
    expect(await r.dw.go({ kind: 'desktop', n: 7 })).toBe('not-found');
    off.fake.trusted = true;
    expect(await r.dw.go({ kind: 'desktop', step: 1 })).toBe('ok');
    expect(off.fake.switches).toEqual([[1, 2]]);
    expect(await r.dw.go({ kind: 'screen', n: 2 })).toBe('ok');
    expect(r.dw.openIds()).toContain('2');
    expect(await r.dw.go({ kind: 'screen', n: 3 })).toBe('not-found');
  });
  it('saves the desktop mode with the screens', () => {
    expect(readDisplayPrefs({ spacesMode: 'arrive' }).spacesMode).toBe('arrive');
    expect(readDisplayPrefs({ spacesMode: 'teleport' }).spacesMode).toBe('ask');
  });
});
