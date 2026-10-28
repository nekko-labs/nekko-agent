import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineProcess } from './engine-process.js';
const mocks = vi.hoisted(() => {
  const plain = { toBitmap: () => Buffer.alloc(20 * 20 * 4) };
  return { menus: [] as any[][], on: vi.fn(), destroy: vi.fn(), setImage: vi.fn(), setToolTip: vi.fn(), plain, dotted: { dotted: true } };
});
vi.mock('electron', () => ({
  Tray: class { setToolTip = mocks.setToolTip; setImage = mocks.setImage; setContextMenu() {} on = mocks.on; destroy = mocks.destroy; },
  nativeImage: { createFromPath: () => ({ resize: () => mocks.plain }), createFromBitmap: () => mocks.dotted },
  Menu: { buildFromTemplate: (items: any[]) => { mocks.menus.push(items); return items; } },
}));
import { createDesktopTray } from './tray.js';
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
afterEach(() => { vi.useRealTimers(); mocks.menus.length = 0; mocks.on.mockClear(); mocks.setImage.mockClear(); mocks.setToolTip.mockClear(); });

describe('desktop tray', () => {
  it('puts new chat first and distinguishes service and model power', async () => {
    vi.useFakeTimers();
    const answers: Record<string, unknown> = { 'engine:running': true, 'engine:installedBin': '/llama' };
    const engine = { running: true, start: vi.fn(), endpoint: vi.fn().mockResolvedValue({}), stop: vi.fn(async () => { engine.running = false; }), call: vi.fn(async (channel: string) => channel in answers ? answers[channel] : { running: true, install: { binPath: '/llama' }, ok: true }) };
    const newChat = vi.fn(); const feedback = vi.fn(); const showUi = vi.fn(); const serviceStarted = vi.fn();
    const result = createDesktopTray({ iconPath: '/icon', engine: engine as unknown as EngineProcess, newChat, feedback, showUi, serviceStarted, quit: vi.fn(), onError: vi.fn() });
    await settle();
    let menu = mocks.menus.at(-1)!;
    expect(menu[0].label).toBe('Open a new chat');
    menu[0].click(); await settle(); expect(newChat).toHaveBeenCalledOnce();
    menu.find(i => i.label === 'Send feedback…').click(); expect(feedback).toHaveBeenCalledOnce();
    menu = mocks.menus.at(-1)!;
    menu.find(i => i.label === 'Stop model server').click(); await settle();
    expect(engine.call).toHaveBeenCalledWith('runtime:stop', 'nekko-engine', true);
    menu = mocks.menus.at(-1)!;
    menu.find(i => i.label === 'Stop Nekko service').click(); await settle();
    expect(engine.stop).toHaveBeenCalledOnce();
    menu = mocks.menus.at(-1)!;
    expect(menu.find(i => i.label === 'Start model server').enabled).toBe(false);
    menu.find(i => i.label === 'Start Nekko service').click(); await settle();
    expect(engine.start).toHaveBeenCalledOnce(); expect(serviceStarted).toHaveBeenCalledOnce();
    result.dispose(); expect(mocks.destroy).toHaveBeenCalled();
  });

  const runnerEngine = (runners: () => Promise<unknown>) => ({
    running: true, start: vi.fn(), endpoint: vi.fn(), stop: vi.fn(),
    call: vi.fn((channel: string) => channel === 'runner:list' ? runners() : Promise.resolve({ running: false, install: {} })),
  });
  const open = (engine: object, onError = vi.fn()) => createDesktopTray({ iconPath: '/icon', engine: engine as unknown as EngineProcess, newChat: vi.fn(), feedback: vi.fn(), showUi: vi.fn(), serviceStarted: vi.fn(), quit: vi.fn(), onError });
  const running = { slots: [{ state: 'running', job: null, since: 0, drainEndsAt: null }], awake: true };

  it('shows the CI runner dot and line while a VM runs', async () => {
    vi.useFakeTimers();
    let views: unknown[] = [running];
    const result = open(runnerEngine(async () => views));
    await settle();
    let menu = mocks.menus.at(-1)!;
    expect(menu.find((i) => i.label === 'CI runners: 1 VM running').enabled).toBe(false);
    expect(menu.some((i) => i.label === 'Keeping this Mac awake for CI')).toBe(true);
    expect(mocks.setImage).toHaveBeenLastCalledWith(mocks.dotted);
    expect(mocks.setToolTip).toHaveBeenLastCalledWith('Nekko Agent · CI runner active');
    views = [{ ...running, slots: [...running.slots, ...running.slots] }];
    await vi.advanceTimersByTimeAsync(6000); await settle();
    expect(mocks.menus.at(-1)!.some((i) => i.label === 'CI runners: 2 VMs running')).toBe(true);
    views = [];
    await vi.advanceTimersByTimeAsync(6000); await settle();
    menu = mocks.menus.at(-1)!;
    expect(menu.some((i) => String(i.label).startsWith('CI runners') || i.label === 'Keeping this Mac awake for CI')).toBe(false);
    expect(mocks.setImage).toHaveBeenLastCalledWith(mocks.plain);
    expect(mocks.setToolTip).toHaveBeenLastCalledWith('Nekko Agent');
    result.dispose();
  });

  it('clears an earlier dot when runner:list starts rejecting', async () => {
    vi.useFakeTimers();
    let fail = false;
    const result = open(runnerEngine(async () => { if (fail) throw new Error('unknown channel runner:list'); return [running]; }));
    await settle();
    expect(mocks.setImage).toHaveBeenLastCalledWith(mocks.dotted);
    fail = true;
    await vi.advanceTimersByTimeAsync(6000); await settle();
    expect(mocks.setImage).toHaveBeenLastCalledWith(mocks.plain);
    expect(mocks.menus.at(-1)!.some((i) => String(i.label).startsWith('CI runners'))).toBe(false);
    result.dispose();
  });

  it('polls the model server without engine:status (no GPU probe, no runtime search)', async () => {
    vi.useFakeTimers();
    const bins: Record<string, string | null> = { llama: null, diffusion: '/sd-server', mlx: null };
    const engine = {
      running: true, start: vi.fn(), endpoint: vi.fn(), stop: vi.fn(),
      call: vi.fn(async (channel: string, runtime?: string) => channel === 'engine:running' ? false : channel === 'engine:installedBin' ? bins[runtime!] : []),
    };
    const result = open(engine);
    await settle();
    await vi.advanceTimersByTimeAsync(12_000); await settle();
    expect(engine.call.mock.calls.map(([c]) => c)).not.toContain('engine:status');
    expect(engine.call).toHaveBeenCalledWith('engine:installedBin', 'diffusion');
    // Any installed runtime lets the model server start.
    expect(mocks.menus.at(-1)!.find((i) => i.label === 'Start model server').enabled).toBe(true);
    bins.diffusion = null;
    await vi.advanceTimersByTimeAsync(6000); await settle();
    expect(mocks.menus.at(-1)!.find((i) => i.label === 'Start model server').enabled).toBe(false);
    result.dispose();
  });

  it('treats a failed runner:list as no runners', async () => {
    const onError = vi.fn();
    const result = open(runnerEngine(() => Promise.reject(new Error('unknown channel'))), onError);
    await settle();
    const menu = mocks.menus.at(-1)!;
    expect(menu.some((i) => String(i.label).startsWith('CI runners'))).toBe(false);
    expect(mocks.setImage).not.toHaveBeenCalledWith(mocks.dotted);
    expect(onError).not.toHaveBeenCalled();
    result.dispose();
  });
});
