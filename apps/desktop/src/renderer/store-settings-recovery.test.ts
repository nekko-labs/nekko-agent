import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => { (globalThis as any).window = { innerWidth: 1280, addEventListener() {}, matchMedia: () => ({ matches: false }) }; });
const { useStore } = await import('./store.js');
const attrs = new Map<string, string>();
beforeEach(() => {
  attrs.clear();
  (globalThis as any).document = { documentElement: { setAttribute: (key: string, value: string) => attrs.set(key, value), removeAttribute: (key: string) => attrs.delete(key), style: { setProperty() {}, removeProperty() {} } } };
  useStore.setState({ settings: null, settingsLoaded: false, settingsError: null });
});
describe('startup settings and theme recovery', () => {
  it.each([true, false])('resolves system preference before settings load (dark=%s)', (dark) => {
    window.matchMedia = vi.fn(() => ({ matches: dark }) as MediaQueryList);
    useStore.getState().applyTheme();
    expect(attrs.get('data-theme')).toBe(dark ? 'dark' : 'light');
  });
  it('keeps an explicit theme when the system preference changes', () => {
    window.matchMedia = vi.fn(() => ({ matches: true }) as MediaQueryList);
    useStore.setState({ settings: { theme: 'light' } as any });
    useStore.getState().applyTheme();
    expect(attrs.get('data-theme')).toBe('light');
  });
  it('reports a failed read and replaces the error on a successful retry', async () => {
    window.nekko = { getSettings: vi.fn().mockRejectedValueOnce(new Error('engine restarted')).mockResolvedValue({ theme: 'system', providers: [], workspaces: [] }) } as any;
    await useStore.getState().refreshSettings();
    expect(useStore.getState()).toMatchObject({ settings: null, settingsLoaded: true, settingsError: 'engine restarted' });
    await useStore.getState().refreshSettings();
    expect(useStore.getState().settingsError).toBeNull();
    expect(useStore.getState().settings?.theme).toBe('system');
  });
  it('treats an empty daemon reply as a recoverable failure', async () => {
    window.nekko = { getSettings: vi.fn().mockResolvedValue(null) } as any;
    await useStore.getState().refreshSettings();
    expect(useStore.getState().settingsError).toContain('no settings');
  });
});
