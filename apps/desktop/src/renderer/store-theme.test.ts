import * as splash from './splash.js';
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
  it('uses Dark Nekko when the computer is in dark mode', () => {
    darkMode(true);
    useStore.setState({ settings: system as any });
    useStore.getState().applyTheme();
    expect(attrs.get('data-theme')).toBe('dark');
    expect(attrs.get('data-preset')).toBe('x-plum-dark');
    expect(props.get('--accent')).toBe('#c084b5');
    expect(props.get('--accent-2')).toBe('#c99bb3');
    expect(useStore.getState().resolvedPreset).toBe('x-plum-dark');
  });
  it('uses Light Nekko when the computer is in light mode', () => {
    darkMode(false);
    useStore.setState({ settings: system as any });
    useStore.getState().applyTheme();
    expect(attrs.get('data-theme')).toBe('light');
    expect(attrs.get('data-preset')).toBe('x-plum-white');
    expect(props.get('--accent')).toBe('#5a2352');
    expect(props.get('--accent-2')).toBe('#8a4a7f');
    expect(useStore.getState().resolvedPreset).toBe('x-plum-white');
  });
  it('switches live when the computer changes mode', () => {
    useStore.setState({ settings: system as any });
    darkMode(true);
    useStore.getState().applyTheme();
    darkMode(false);
    useStore.getState().applyTheme();
    expect(attrs.get('data-preset')).toBe('x-plum-white');
    expect(props.get('--accent')).toBe('#5a2352');
  });
  it('keeps an accent the user chose on System', () => {
    darkMode(true);
    useStore.setState({ settings: { ...system, accent: '#ff0000' } as any });
    useStore.getState().applyTheme();
    expect(props.get('--accent')).toBe('#ff0000');
  });
  it.each([[true, 'dark', 'x-plum-dark', '#c084b5'], [false, 'light', 'x-plum-white', '#5a2352']])('treats a fresh profile with no saved theme as System (dark mode: %s)', (dark, mode, preset, accent) => {
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

describe('independent palette and mode application', () => {
  it.each(['nebula', 'terminal', 'nord', 'ember', 'autumn', 'winter'])('applies %s to the core light mode without a dark surface override', async (id) => {
    const { themePalettePatch } = await import('./themeMode.js');
    darkMode(true);
    const settings = themePalettePatch({ theme: 'light' }, id, true);
    useStore.setState({ settings: settings as any });
    useStore.getState().applyTheme();
    expect(attrs.get('data-theme')).toBe('light');
    expect(attrs.get('data-preset')).toBe(id);
    expect(props.get('--accent')).toBe(settings.accent);
    expect(props.get('--accent-2')).toBe(settings.accent2);
  });
});

describe('remembered splash palette', () => {
  it.each(['x-plum-dark', 'x-indigo-dark', 'nebula'])('passes the resolved %s palette after settings load', (id) => {
    const remember = vi.spyOn(splash, 'rememberSplashColours').mockImplementation(() => {});
    try {
      useStore.setState({ settings: { theme: 'dark', themePreset: id } as any, settingsLoaded: true });
      useStore.getState().applyTheme();
      expect(remember).toHaveBeenCalledWith(expect.any(Array), id);
    } finally { remember.mockRestore(); }
  });
  it.each(['dark', 'x-plum-dark', 'x-indigo-dark'])('preserves a custom accent on %s', (id) => {
    const remember = vi.spyOn(splash, 'rememberSplashColours').mockImplementation(() => {});
    try {
      useStore.setState({ settings: { theme: 'dark', themePreset: id, accent: '#336699' } as any, settingsLoaded: true });
      useStore.getState().applyTheme();
      expect(remember).toHaveBeenCalledWith(expect.arrayContaining(['#336699']), 'custom');
    } finally { remember.mockRestore(); }
  });
  it('does not overwrite cached colours before settings load', () => {
    const remember = vi.spyOn(splash, 'rememberSplashColours').mockImplementation(() => {});
    try {
      useStore.getState().applyTheme();
      expect(remember).not.toHaveBeenCalled();
    } finally { remember.mockRestore(); }
  });
});
