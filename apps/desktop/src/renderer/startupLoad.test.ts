import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  (globalThis as { window?: unknown }).window = { innerWidth: 1280, addEventListener() {} };
});
const { useStore } = await import('./store.js');
const { loadStartup } = await import('./startupLoad.js');

const provider = { id: 'p', kind: 'chatgpt', enabled: true };
const settings = { workspaces: [], defaultProviderId: 'p' };
const down = () => Promise.reject(new Error('Nekko service did not become ready.'));

function bridge(overrides: Record<string, unknown> = {}) {
  const b = {
    getSettings: vi.fn(async () => settings),
    listProviders: vi.fn(async () => [provider]),
    listModels: vi.fn(async () => []),
    listSessionSummaries: vi.fn(async () => []),
    listTerminals: vi.fn(async () => []),
    listInstalledSkills: vi.fn(async () => []),
    listExternalSkills: vi.fn(async () => []),
    ...overrides,
  };
  window.nekko = b as unknown as typeof window.nekko;
  return b;
}

const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  useStore.setState({ settings: null, settingsLoaded: false, settingsError: null, providers: [], providersLoaded: false, models: [], activeProviderId: null, activeModelId: null, toasts: [], onboardingOpen: false });
  useStore.setState({ applyTheme: () => {}, loadCustomFonts: async () => {} } as never);
});
afterEach(() => vi.useRealTimers());

describe('loadStartup', () => {
  it('reads once when the engine answers the first time', async () => {
    const b = bridge();
    loadStartup();
    await settle();
    expect(b.getSettings).toHaveBeenCalledTimes(1);
    expect(b.listProviders).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(b.listProviders).toHaveBeenCalledTimes(1);
    // Nothing failed, so the lists App already asked for are not asked for again.
    expect(b.listSessionSummaries).not.toHaveBeenCalled();
  });

  it('reads again once a slow engine comes up, without being sent to a page', async () => {
    let up = false;
    const b = bridge({
      getSettings: vi.fn(() => (up ? Promise.resolve(settings) : down())),
      listProviders: vi.fn(() => (up ? Promise.resolve([provider]) : down())),
    });
    loadStartup();
    await settle();
    expect(useStore.getState().providers).toEqual([]);
    expect(useStore.getState().settingsError).toContain('did not become ready');
    expect(useStore.getState().providersLoaded).toBe(true);

    up = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(useStore.getState().providers).toEqual([provider]);
    expect(useStore.getState().settings).toEqual(settings);
    expect(useStore.getState().settingsError).toBeNull();
    expect(useStore.getState().activeProviderId).toBe('p');
    expect(b.listSessionSummaries).toHaveBeenCalledTimes(1);
    expect(b.listTerminals).toHaveBeenCalledTimes(1);

    const calls = b.listProviders.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(b.listProviders).toHaveBeenCalledTimes(calls);
  });

  it('shows the failure once however often it retries, and clears it on recovery', async () => {
    let up = false;
    bridge({
      getSettings: vi.fn(() => (up ? Promise.resolve(settings) : down())),
      listProviders: vi.fn(() => (up ? Promise.resolve([provider]) : down())),
    });
    loadStartup();
    await settle();
    await vi.advanceTimersByTimeAsync(20_000);
    const shown = () => useStore.getState().toasts.filter((t) => t.message.startsWith('Could not load settings') && !t.leaving);
    expect(shown()).toHaveLength(1);
    up = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(shown()).toHaveLength(0);
  });

  it('does not keep asking when only a provider\'s model list failed', async () => {
    const b = bridge({ listModels: vi.fn(down) });
    loadStartup();
    await settle();
    expect(useStore.getState().providers).toEqual([provider]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(b.listProviders).toHaveBeenCalledTimes(1);
  });

  it('stops when the effect that started it is cleaned up', async () => {
    const b = bridge({ getSettings: vi.fn(down), listProviders: vi.fn(down) });
    const stop = loadStartup();
    await settle();
    stop();
    const calls = b.getSettings.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(b.getSettings).toHaveBeenCalledTimes(calls);
  });
});
