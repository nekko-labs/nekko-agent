import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => { (globalThis as any).window = { innerWidth: 1280, addEventListener() {}, matchMedia: () => ({ matches: false }) }; });
const chrome = vi.hoisted(() => ({ canZoom: true, setPageZoom: (() => {}) as (factor: number) => void }));
vi.mock('./chrome.js', () => ({
  hasAppChrome: false, isMacChrome: false, syncTitleBarOverlay: () => {},
  setPageZoom: (factor: number) => { chrome.setPageZoom(factor); return chrome.canZoom; },
}));
const { useStore } = await import('./store.js');

const root = { setAttribute() {}, removeAttribute() {}, style: { zoom: '', setProperty() {}, removeProperty() {} } };
const apply = (textScale: number) => {
  useStore.setState({ settings: { textScale } as any });
  useStore.getState().applyTheme();
};

beforeEach(() => {
  (globalThis as any).document = { documentElement: root };
  root.style.zoom = '';
  chrome.canZoom = true;
  chrome.setPageZoom = vi.fn();
});

describe('text size', () => {
  it('uses page zoom on the desktop and leaves CSS zoom off', () => {
    apply(150);
    expect(chrome.setPageZoom).toHaveBeenCalledWith(1.5);
    expect(root.style.zoom).toBe('');
  });

  it('falls back to CSS zoom in a browser tab', () => {
    chrome.canZoom = false;
    apply(125);
    expect(root.style.zoom).toBe('125%');
    apply(100);
    expect(root.style.zoom).toBe('');
  });
});
