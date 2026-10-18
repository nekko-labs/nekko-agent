import { afterEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ windows: [] as any[] }));
vi.mock('electron', () => ({
  screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }) },
  BrowserWindow: class {
    webContents = { setWindowOpenHandler: vi.fn(), on: vi.fn() };
    showInactive = vi.fn(); destroy = vi.fn(); isDestroyed = () => false;
    loadURL = vi.fn().mockResolvedValue(undefined);
    constructor(public options: unknown) { mock.windows.push(this); }
  },
}));
import { GUIDANCE_MS, companionBounds, companionHtml, createTrayCompanion } from './trayCompanion.js';
import type { AppSettings } from '@nekko-agent/shared';
import type { Tray } from 'electron';
const setup = (settings: Partial<AppSettings> = {}) => {
  const options = { tray: { setToolTip: vi.fn(), getBounds: () => ({ x: 1700, y: 1040, width: 20, height: 20 }), displayBalloon: vi.fn() } as unknown as Tray, settings: vi.fn().mockResolvedValue(settings), update: vi.fn().mockResolvedValue({}), quit: vi.fn(), serviceRunning: () => true, onError: vi.fn() };
  return { options, companion: createTrayCompanion(options), hide: vi.fn() };
};
afterEach(() => { mock.windows.length = 0; vi.useRealTimers(); });
describe('tray companion', () => {
  it('persists the first-close hint, offers a shutdown shortcut and an X, and dismisses itself after 15 s', async () => {
    vi.useFakeTimers(); const { options, companion, hide } = setup();
    await companion.closeWindow(hide);
    expect(options.update).toHaveBeenCalledWith({ trayCloseHintSeen: true });
    expect(hide).toHaveBeenCalledOnce();
    const win = mock.windows[0];
    const html = decodeURIComponent(win.loadURL.mock.calls[0][0]);
    expect(html).toContain('Shut down on close instead');
    expect(html).toContain('aria-label="Dismiss"');
    expect(html).not.toContain('Settings');
    vi.advanceTimersByTime(GUIDANCE_MS - 1); expect(win.destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(win.destroy).toHaveBeenCalledOnce();
    companion.dispose();
  });
  it('offers the shutdown shortcut from the guidance', async () => {
    const { options, companion, hide } = setup();
    await companion.closeWindow(hide);
    const win = mock.windows[0];
    const navigate = win.webContents.on.mock.calls.find((c: any[]) => c[0] === 'will-navigate')[1];
    navigate({ preventDefault: vi.fn() }, 'https://nekko.invalid/shutdown');
    await Promise.resolve();
    expect(options.update).toHaveBeenLastCalledWith({ desktopCloseBehavior: 'shutdown' });
    expect(options.quit).toHaveBeenCalledOnce(); companion.dispose();
  });
  it('times a repeat farewell from display and cancels it on reopening', async () => {
    vi.useFakeTimers(); const { companion, hide } = setup({ trayCloseHintSeen: true });
    await companion.closeWindow(hide); const win = mock.windows[0];
    vi.advanceTimersByTime(1999); expect(win.destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(win.destroy).toHaveBeenCalledOnce(); companion.dispose();
  });
  it('honors shutdown and disabled farewell independently of mascot visibility', async () => {
    const a = setup({ desktopCloseBehavior: 'shutdown' }); await a.companion.closeWindow(a.hide);
    expect(a.options.quit).toHaveBeenCalledOnce(); expect(a.hide).not.toHaveBeenCalled();
    const b = setup({ trayCloseHintSeen: true, trayFarewellEnabled: false }); await b.companion.closeWindow(b.hide);
    expect(b.hide).toHaveBeenCalledOnce(); expect(mock.windows).toHaveLength(0);
  });
  it('does not hide on settings failure or repeat concurrent closes', async () => {
    const a = setup(); a.options.settings.mockRejectedValue(Error('offline'));
    await a.companion.closeWindow(a.hide); expect(a.hide).not.toHaveBeenCalled(); expect(a.options.onError).toHaveBeenCalled();
    const b = setup(); await Promise.all([b.companion.closeWindow(b.hide), b.companion.closeWindow(b.hide)]);
    expect(b.hide).toHaveBeenCalledOnce(); b.companion.dispose();
  });
  it('clamps to taskbar monitor work area and falls back for an overflow icon', () => {
    const work = { x: -1920, y: 0, width: 1920, height: 1040 };
    expect(companionBounds({ x: -8, y: 1040, width: 20, height: 20 }, work).x).toBe(-340);
    expect(companionBounds({ x: 0, y: 0, width: 0, height: 0 }, work)).toEqual({ x: -352, y: 802, width: 340, height: 230 });
  });
  it('respects reduced motion and does not promise running agents with a stopped service', () => {
    expect(companionHtml(true, false, false)).not.toContain('<svg');
    expect(companionHtml(true, true, false)).toContain('service is currently stopped');
    expect(companionHtml(false, true, true)).toContain('prefers-reduced-motion');
    // Clipped rather than scrolled: the window is sized to fit its content.
    expect(companionHtml(true, true, true)).toContain('html,body{height:100%;overflow:hidden}');
  });
});
