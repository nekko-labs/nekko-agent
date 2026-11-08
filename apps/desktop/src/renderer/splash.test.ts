import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fadeInReloadCover, playSplash, rememberSplashColours } from './splash.js';

const cache = new Map<string, string>();
let nodes: Array<{ tag: string; attrs: Record<string, string>; style: { cssText: string } }>;
const stored = () => JSON.parse(cache.get('nekko.splash')!);
const paint = () => { playSplash(new Promise(() => {})); return nodes.find((n) => n.tag === 'rect')!.attrs.fill; };
beforeEach(() => {
  cache.clear();
  nodes = [];
  vi.stubGlobal('localStorage', { getItem: (key: string) => cache.get(key) ?? null, setItem: (key: string, value: string) => cache.set(key, value) });
  vi.stubGlobal('window', { innerWidth: 1280, innerHeight: 696, matchMedia: () => ({ matches: true }) });
  const make = (tag: string) => {
    const n = { tag, attrs: {} as Record<string, string>, style: { cssText: '' }, setAttribute(key: string, value: string) { this.attrs[key] = value; }, appendChild() {}, getContext: () => null, animate: vi.fn(() => ({ finished: new Promise(() => {}) })) };
    nodes.push(n);
    return n;
  };
  vi.stubGlobal('document', { documentElement: {}, body: { appendChild() {} }, createElement: make, createElementNS: (_: string, tag: string) => make(tag) });
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (key: string) => key === '--paper' ? '#0c0c11' : '#c084b5' }));
});
afterEach(() => vi.unstubAllGlobals());

describe('startup splash palette', () => {
  it('starts in deep plum without settings or cached colours', () => expect(paint()).toBe('#190019'));
  it.each([undefined, 'system', 'light', 'dark', 'x-plum-white', 'x-plum-dark'])('uses the main plum fill, not a text accent, for %s', (id) => {
    rememberSplashColours(['#c084b5', '#c99bb3'], id);
    expect(stored()).toEqual({ version: 1, bg: '#190019', fg: '#ffffff', paper: '#0c0c11' });
    expect(paint()).toBe('#190019');
  });
  it.each(['x-indigo-white', 'x-indigo-dark'])('uses the main indigo fill for %s', (id) => {
    rememberSplashColours(['#a68fd0'], id);
    expect(paint()).toBe('#2b124c');
    expect(stored().fg).toBe('#ffffff');
  });
  it.each(['#9d8ce6', '#5b4ea7', '#6d5efc', '#8b7dff', '#c4b9ff', '#c084b5', '#101714'])('rejects unversioned cached %s before settings load', (bg) => {
    cache.set('nekko.splash', JSON.stringify({ bg, fg: '#17151f', paper: '#121212' }));
    expect(paint()).toBe('#190019');
    fadeInReloadCover(120);
    expect(nodes.find((n) => n.style.cssText.includes('background:'))!.style.cssText).toContain('background:#121212');
  });
  it.each(['nebula', 'lilac', 'lavender', 'x-orchid-dark'])('preserves deliberately selected %s colours in a current cache', (id) => {
    rememberSplashColours(['#9d8ce6'], id);
    expect(paint()).toBe('#9d8ce6');
    expect(stored().fg).toBe('#17151f');
  });
  it('keeps a custom alternate-palette accent', () => {
    rememberSplashColours(['#336699'], 'nebula');
    expect(paint()).toBe('#336699');
  });
  it('skips pale colours in alternate palettes', () => {
    rememberSplashColours(['#ffffff', '#123456'], 'terminal');
    expect(paint()).toBe('#123456');
  });
  it.each(['not-json', 'null', '[]', '{"version":1,"bg":"red","fg":"#ffffff"}', '{"version":99,"bg":"#9d8ce6","fg":"#ffffff"}'])('handles an invalid or unknown cache: %s', (json) => {
    cache.set('nekko.splash', json);
    expect(paint()).toBe('#190019');
  });
  it('uses safe paper when a cached reload colour is invalid', () => {
    cache.set('nekko.splash', JSON.stringify({ paper: 'invalid' }));
    fadeInReloadCover(120);
    expect(nodes[0].style.cssText).toContain('background:#0c0c11');
  });
  it('handles unavailable storage', () => {
    vi.stubGlobal('localStorage', { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } });
    expect(() => rememberSplashColours(['#c084b5'], 'x-plum-dark')).not.toThrow();
    expect(paint()).toBe('#190019');
  });
});
