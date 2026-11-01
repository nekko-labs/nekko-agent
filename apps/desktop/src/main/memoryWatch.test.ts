import { afterEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ windows: [] as any[] }));
vi.mock('electron', () => ({
  screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }) },
  BrowserWindow: class {
    handlers: Record<string, (...a: any[]) => void> = {};
    webContents = { setWindowOpenHandler: vi.fn(), on: (e: string, f: (...a: any[]) => void) => { this.handlers[e] = f; }, executeJavaScript: vi.fn().mockResolvedValue(271) };
    showInactive = vi.fn(); destroy = vi.fn(); setBounds = vi.fn(); isDestroyed = () => false;
    loadURL = vi.fn().mockResolvedValue(undefined);
    constructor(public options: unknown) { mock.windows.push(this); }
  },
}));
import { MEMORY_QUIET_MS, createMemoryWatch, decideMemory, leftLine, memoryPromptHtml, parseChoice, rememberChoice, type LocalModels, type MemoryState } from './memoryWatch.js';

const GB = 2 ** 30;
const low: MemoryState = { level: 'low', totalBytes: 64 * GB, availableBytes: 20 * GB, commitLimitBytes: 63 * GB, commitAvailableBytes: 4 * GB, topApp: { name: 'PioneerGame', bytes: 14.3 * GB, processes: 1 }, nekkoBytes: 6 * GB };
const loaded: LocalModels = { models: 2, busy: 1, bytes: 7 * GB };

describe('deciding what to do about low memory', () => {
  it('asks by default, and stays quiet while memory is fine', () => {
    expect(decideMemory(low, {}, null, 0)).toEqual({ kind: 'ask' });
    expect(decideMemory({ ...low, level: 'ok' }, {}, null, 0)).toEqual({ kind: 'none' });
  });
  it('uses a remembered choice, and an app always closed comes first', () => {
    expect(decideMemory(low, { lowMemoryAction: 'release' }, null, 0)).toEqual({ kind: 'release' });
    expect(decideMemory(low, { lowMemoryAction: 'ignore' }, null, 0)).toEqual({ kind: 'none' });
    expect(decideMemory(low, { lowMemoryAction: 'ignore', lowMemoryCloseApps: ['pioneergame'] }, null, 0)).toEqual({ kind: 'close', app: 'PioneerGame' });
    expect(decideMemory({ ...low, topApp: { name: 'chrome', bytes: 6 * GB, processes: 9 } }, { lowMemoryCloseApps: ['PioneerGame'] }, null, 0)).toEqual({ kind: 'ask' });
  });
  it('does not ask twice in the quiet time, unless low turns critical', () => {
    const memo = { at: 0, level: 'low' as const };
    expect(decideMemory(low, {}, memo, MEMORY_QUIET_MS - 1)).toEqual({ kind: 'none' });
    expect(decideMemory({ ...low, level: 'critical' }, {}, memo, 1)).toEqual({ kind: 'ask' });
    expect(decideMemory(low, {}, memo, MEMORY_QUIET_MS)).toEqual({ kind: 'ask' });
  });
  it('remembers a close as that app, and the others as the action', () => {
    expect(rememberChoice('close', 'PioneerGame', { lowMemoryCloseApps: ['chrome'] })).toEqual({ lowMemoryCloseApps: ['chrome', 'PioneerGame'] });
    expect(rememberChoice('close', 'Chrome', { lowMemoryCloseApps: ['chrome'] })).toEqual({});
    expect(rememberChoice('release', undefined, {})).toEqual({ lowMemoryAction: 'release' });
    expect(rememberChoice('ignore', 'x', {})).toEqual({ lowMemoryAction: 'ignore' });
  });
});

describe('the prompt', () => {
  it('says what is left by the tighter measure and names the app, escaped', () => {
    expect(leftLine(low)).toBe('4.0 GB of 63.0 GB left to allocate');
    expect(leftLine({ ...low, commitLimitBytes: null, availableBytes: 3 * GB })).toBe('3.0 GB of 64.0 GB free');
    const html = memoryPromptHtml({ ...low, topApp: { name: '<b>x', bytes: 2 * GB, processes: 1 } });
    expect(html).toContain('&#60;b&#62;x'); expect(html).not.toContain('<b><b>x');
    expect(html).toContain('name="remember"'); expect(html).toContain("form-action https://nekko.invalid");
    expect(html).not.toContain('<script');
  });
  it('offers no close without an app', () => {
    const html = memoryPromptHtml({ ...low, topApp: null });
    expect(html).not.toContain('value="close"'); expect(html).toContain('value="release"');
  });
  it('puts the alarmed mascot beside the title and the details under both', () => {
    const html = memoryPromptHtml(low, loaded);
    expect(html).toMatch(/<header><svg viewBox="0 -7 34 39".*<\/svg><h1>Memory is running low<\/h1><\/header>\n<p>/);
    expect(html).not.toContain('Free Nekko');
  });
  it('says what each option frees, measured, and what shutting down stops', () => {
    const html = memoryPromptHtml(low, loaded);
    expect(html).toContain('Close PioneerGame<small>Frees about 14.3 GB. It can still ask you to save first.</small>');
    expect(html).toContain("Shut down Nekko's 2 local models<small>Frees about 7.0 GB. An agent replying on one of them stops.</small>");
    expect(memoryPromptHtml(low, { models: 1, busy: 0, bytes: 3 * GB })).toContain("Shut down Nekko's local model<small>Frees about 3.0 GB. No agent is using it right now.</small>");
    expect(memoryPromptHtml(low, { models: 3, busy: 2, bytes: 3 * GB })).toContain('2 agents replying on them stop.');
    // Nothing loaded: nothing of Nekko's to shut down. An older daemon: the plain warning.
    expect(memoryPromptHtml(low, { models: 0, busy: 0, bytes: 0 })).not.toContain('value="release"');
    expect(memoryPromptHtml(low)).toContain("Shut down Nekko's local models<small>Agents using them stop.</small>");
  });
  it('reads only its own form', () => {
    expect(parseChoice('https://nekko.invalid/choose?app=PioneerGame&choice=close&remember=1')).toEqual({ choice: 'close', app: 'PioneerGame', remember: true });
    expect(parseChoice('https://nekko.invalid/choose?choice=ignore')).toEqual({ choice: 'ignore', app: undefined, remember: false });
    expect(parseChoice('https://nekko.invalid/choose?choice=format')).toBeNull();
    expect(parseChoice('https://evil.example/choose?choice=close&app=x')).toBeNull();
  });
});

describe('the watch', () => {
  afterEach(() => { mock.windows.length = 0; vi.useRealTimers(); });
  const rig = (state: MemoryState, settings: object, quiet = false, models: LocalModels = loaded) => {
    const calls: unknown[][] = [];
    const engine = { running: true, call: vi.fn(async (...a: unknown[]) => {
      calls.push(a);
      if (a[0] === 'memory:state') return state;
      if (a[0] === 'settings:get') return settings;
      if (a[0] === 'engine:unloadAll') return { unloaded: ['qwen'], freedBytes: 5 * GB, stopped: 1 };
      if (a[0] === 'memory:closeApp') return { ok: true, processes: 1 };
      if (a[0] === 'engine:memory') return models;
      return {};
    }) };
    const tray = { getBounds: () => ({ x: 1800, y: 1040, width: 24, height: 24 }) };
    return { calls, watch: createMemoryWatch({ tray: tray as any, engine: engine as any, quiet: async () => quiet, onError: vi.fn() }) };
  };
  it('asks without taking focus, then acts on and remembers the choice', async () => {
    const { calls, watch } = rig(low, { lowMemoryCloseApps: [] });
    await watch.check();
    const prompt = mock.windows[0];
    expect(prompt.showInactive).toHaveBeenCalled();
    // Sized to its content: 271 px of it, plus the card's padding and border.
    expect(prompt.setBounds).toHaveBeenCalledWith(expect.objectContaining({ width: 360, height: 287 }));
    expect(decodeURIComponent(prompt.loadURL.mock.calls[0][0])).toContain('Frees about 7.0 GB.');
    prompt.handlers['will-navigate']({ preventDefault: vi.fn() }, 'https://nekko.invalid/choose?choice=close&app=PioneerGame&remember=1');
    await vi.waitFor(() => expect(calls.some(c => c[0] === 'memory:closeApp')).toBe(true));
    expect(calls).toContainEqual(['settings:update', { lowMemoryCloseApps: ['PioneerGame'] }]);
    expect(calls).toContainEqual(['memory:closeApp', 'PioneerGame']);
    watch.dispose();
  });
  it('frees Nekko memory without asking when that was remembered, and says so', async () => {
    const { calls, watch } = rig(low, { lowMemoryAction: 'release' });
    await watch.check();
    expect(calls).toContainEqual(['engine:unloadAll']);
    const html = decodeURIComponent(mock.windows[0].loadURL.mock.calls[0][0]);
    // The freed amount is what the model processes held, not their file sizes.
    expect(html).toContain('Shut down a local model, freeing about 7.0 GB. An agent reply was stopped.');
    watch.dispose();
  });
  it('does nothing for a remembered shut-down when no model is loaded', async () => {
    const { calls, watch } = rig(low, { lowMemoryAction: 'release' }, false, { models: 0, busy: 0, bytes: 0 });
    await watch.check();
    expect(calls).not.toContainEqual(['engine:unloadAll']);
    expect(mock.windows).toHaveLength(0);
    watch.dispose();
  });
  it('shows nothing over a full-screen game: the question waits, a remembered release runs quietly', async () => {
    const asked = rig(low, {}, true);
    await asked.watch.check();
    expect(mock.windows).toHaveLength(0);
    asked.watch.dispose();
    const { calls, watch } = rig(low, { lowMemoryAction: 'release' }, true);
    await watch.check();
    expect(calls).toContainEqual(['engine:unloadAll']);
    expect(mock.windows).toHaveLength(0);
    watch.dispose();
  });
});
