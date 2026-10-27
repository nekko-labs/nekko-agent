import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => { (globalThis as any).window = { innerWidth: 1280, addEventListener() {}, matchMedia: () => ({ matches: false }) }; });
const { useStore } = await import('./store.js');
const attrs = new Map<string, string>();
const props = new Map<string, string>();
const darkMode = (dark: boolean) => { window.matchMedia = vi.fn(() => ({ matches: dark }) as MediaQueryList); };
// What picking System in the theme picker saves.
const system = { theme: 'system', themePreset: 'system', accent: '#6d5efc', accent2: '#06b6d4' };
beforeEach(() => {
  attrs.clear();
  props.clear();
  (globalThis as any).document = { documentElement: {
    setAttribute: (key: string, value: string) => attrs.set(key, value), removeAttribute: (key: string) => attrs.delete(key),
    style: { setProperty: (key: string, value: string) => props.set(key, value), removeProperty: (key: string) => props.delete(key) },
  } };
  useStore.setState({ settings: null, settingsLoaded: false, resolvedPreset: undefined });
});

describe('System theme', () => {
  it('uses Nekko Dark when the computer is in dark mode', () => {
    darkMode(true);
    useStore.setState({ settings: system as any });
    useStore.getState().applyTheme();
    expect(attrs.get('data-theme')).toBe('dark');
    expect(attrs.get('data-preset')).toBe('nekko-dark');
    expect(props.get('--accent')).toBe('#c4b9ff');
    expect(props.get('--accent-2')).toBe('#8ae4f2');
    expect(useStore.getState().resolvedPreset).toBe('nekko-dark');
  });
  it('uses Lilac when the computer is in light mode', () => {
    darkMode(false);
    useStore.setState({ settings: system as any });
    useStore.getState().applyTheme();
    expect(attrs.get('data-theme')).toBe('light');
    expect(attrs.get('data-preset')).toBe('lilac');
    expect(props.get('--accent')).toBe('#5b4ea7');
    expect(props.get('--accent-2')).toBe('#9d8ce6');
    expect(useStore.getState().resolvedPreset).toBe('lilac');
  });
  it('switches live when the computer changes mode', () => {
    useStore.setState({ settings: system as any });
    darkMode(true);
    useStore.getState().applyTheme();
    darkMode(false);
    useStore.getState().applyTheme();
    expect(attrs.get('data-preset')).toBe('lilac');
    expect(props.get('--accent')).toBe('#5b4ea7');
  });
  it('keeps an accent the user chose on System', () => {
    darkMode(true);
    useStore.setState({ settings: { ...system, accent: '#ff0000' } as any });
    useStore.getState().applyTheme();
    expect(props.get('--accent')).toBe('#ff0000');
  });
  it.each([[true, 'dark', 'nekko-dark', '#c4b9ff'], [false, 'light', 'lilac', '#5b4ea7']])('treats a fresh profile with no saved theme as System (dark mode: %s)', (dark, mode, preset, accent) => {
    darkMode(dark);
    useStore.setState({ settings: {} as any });
    useStore.getState().applyTheme();
    expect(attrs.get('data-theme')).toBe(mode);
    expect(attrs.get('data-preset')).toBe(preset);
    expect(props.get('--accent')).toBe(accent);
    expect(useStore.getState().resolvedPreset).toBe(preset);
  });
  it.each([['light', true], ['dark', false], ['nebula', true]])('leaves the explicit %s preset as it was', (id, dark) => {
    darkMode(dark);
    useStore.setState({ settings: { theme: id === 'light' ? 'light' : 'dark', themePreset: id } as any });
    useStore.getState().applyTheme();
    expect(attrs.get('data-preset')).toBe(id);
    expect(attrs.get('data-theme')).toBe(id === 'light' ? 'light' : 'dark');
  });
});
