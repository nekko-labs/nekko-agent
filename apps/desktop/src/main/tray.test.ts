import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineProcess } from './engine-process.js';
const mocks = vi.hoisted(() => ({ menus: [] as any[][], on: vi.fn(), destroy: vi.fn() }));
vi.mock('electron', () => ({
  Tray: class { setToolTip() {} setContextMenu() {} on = mocks.on; destroy = mocks.destroy; },
  nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
  Menu: { buildFromTemplate: (items: any[]) => { mocks.menus.push(items); return items; } },
}));
import { createDesktopTray } from './tray.js';
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
afterEach(() => { vi.useRealTimers(); mocks.menus.length = 0; mocks.on.mockClear(); });

describe('desktop tray', () => {
  it('puts new chat first and distinguishes service and model power', async () => {
    vi.useFakeTimers();
    const engine = { running: true, start: vi.fn(), endpoint: vi.fn().mockResolvedValue({}), stop: vi.fn(async () => { engine.running = false; }), call: vi.fn().mockResolvedValue({ running: true, install: { binPath: '/llama' }, ok: true }) };
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
});
