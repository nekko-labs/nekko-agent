import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localImageData } from '../localImages.js';

const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

describe('image and hardware regression boundaries', () => {
  // Source pin, pending a composer e2e journey: sendImage is a send handler
  // with host round trips, which a server render never reaches.
  it('keeps the prompt until image prerequisites have been checked (source pin)', () => {
    const text = source('./ChatPane.tsx');
    const turn = text.match(/const sendImage = async[^]*?\n {2}\};/)?.[0] ?? '';
    expect(turn.indexOf('engineImageCompanions')).toBeGreaterThan(-1);
    expect(turn.indexOf('engineImageCompanions')).toBeLessThan(turn.search(/setDraft\(''\)/));
    expect(turn).toMatch(/!runtime\.diffusionInstall\?\.binPath/);
    expect(turn).toMatch(/setup && !setup\.ready/);
  });

  it('polls hardware every 2 seconds while a monitor watches it, and stops when none does', async () => {
    vi.useFakeTimers();
    const getGpuStats = vi.fn(async () => null);
    const getSystemStats = vi.fn(async () => null);
    vi.stubGlobal('window', { nekko: { getGpuStats, getSystemStats } });
    // A mount, as React would do it on a client: subscribe to the sampler, then run the effect.
    const effects: Array<() => void | (() => void)> = [];
    const subscriptions: Array<() => void> = [];
    vi.doMock('react', async (original) => {
      const actual = await original<typeof import('react')>();
      const useEffect: typeof actual.useEffect = (fn) => { effects.push(fn); };
      const useSyncExternalStore = (subscribe: (cb: () => void) => () => void, get: () => unknown) => { subscriptions.push(subscribe(() => {})); return get(); };
      const useMemo = (fn: () => unknown) => fn();
      return { ...actual, default: { ...actual, useEffect, useSyncExternalStore, useMemo }, useEffect, useSyncExternalStore, useMemo };
    });
    vi.doMock('../store.js', () => ({ useStore: (select: (s: unknown) => unknown) => select({ settings: { monitors: { cpu: false, memory: false, gpu: true, vram: false } } }) }));
    const { useResourceSample } = await import('./ResourceMonitor.js');
    useResourceSample();
    const cleanups = [...effects.map((fn) => fn()), ...subscriptions];
    getGpuStats.mockClear();
    vi.advanceTimersByTime(2000);
    expect(getGpuStats).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(6000);
    expect(getGpuStats).toHaveBeenCalledTimes(4);
    expect(getSystemStats).not.toHaveBeenCalled();
    for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup();
    vi.advanceTimersByTime(10_000);
    expect(getGpuStats).toHaveBeenCalledTimes(4);
  });

  // Source pin: the GPU cache is the engine's (nekko-machine), outside this package's tests.
  it('caches GPU readings for a second and shares an in-flight probe (source pin, engine)', () => {
    const gpu = source('../../../../../crates/nekko-machine/src/probe.rs');
    expect(gpu).toMatch(/const GPU_TTL: Duration = Duration::from_secs\(1\);/);
    // The cache's lock is held across the probe, so a second caller waits for the first one's reading.
    expect(gpu).toMatch(/let mut cache = self\.gpu\.lock\(\)\.await;[\s\S]*?let stats = self\.probe_gpu\(\)\.await;/);
  });

  it('allows only complete text SVG as inert image data, never as a raster response', () => {
    const content = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const file = { content, binary: false, truncated: false };
    expect(localImageData('/a.svg', file)).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}`);
    for (const rejected of [{ ...file, binary: true }, { ...file, truncated: true }, { ...file, content: '' }, { ...file, content: 'x'.repeat(1_000_001) }]) {
      expect(localImageData('/a.svg', rejected)).toBeNull();
    }
    expect(localImageData('/a.png', { ...file, imageDataUrl: 'data:image/svg+xml;base64,AAAA' })).toBeNull();
    // Source pin: the file pane's Download shows only once its host read resolves.
    expect(source('./FilePane.tsx')).toMatch(/title="Download a copy of this file"/);
  });
});
