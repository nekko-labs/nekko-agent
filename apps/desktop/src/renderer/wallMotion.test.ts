import { afterEach, describe, expect, it, vi } from 'vitest';
import { EDGE_DUST_MS, WALL_PUSH_EASE, WALL_PUSH_MS, edgeClip, foldWindow, growWindow, mostOverlapping, outerSide, scatterEdgeDust } from './wallMotion.js';
import { cssRule, cssValue, stylesheet } from './tests/css.js';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

describe('wall push geometry', () => {
  it('finds the window that gave up, or takes over, the room', () => {
    const left = box(0, 0, 500, 600);
    const right = box(508, 0, 492, 600);
    expect(mostOverlapping(box(254, 0, 246, 600), [['a', left], ['b', right]])).toBe('a');
    expect(mostOverlapping(box(600, 0, 400, 600), [['a', left], ['b', right]])).toBe('b');
    expect(mostOverlapping(box(2000, 0, 10, 10), [['a', left]])).toBeNull();
  });

  it('opens from the edge facing away from the neighbour it pushed', () => {
    const pushed = box(0, 0, 496, 600);
    expect(outerSide(box(504, 0, 496, 600), pushed)).toBe('right');
    expect(outerSide(box(0, 0, 496, 600), box(504, 0, 496, 600))).toBe('left');
    expect(outerSide(box(0, 304, 1000, 296), box(0, 0, 1000, 296))).toBe('down');
    expect(outerSide(box(0, 0, 1000, 296), box(0, 304, 1000, 296))).toBe('up');
    // The full-width row under a row of three opens from the bottom.
    expect(outerSide(box(0, 304, 1130, 295), box(0, 0, 373, 296))).toBe('down');
    expect(outerSide(box(0, 0, 10, 10), undefined)).toBe('left');
  });

  it('clips to nothing but the chosen edge', () => {
    expect(edgeClip('right', '14px')).toBe('inset(0 0 0 100% round 14px)');
    expect(edgeClip('left', '14px')).toBe('inset(0 100% 0 0 round 14px)');
    expect(edgeClip('down', '14px')).toBe('inset(100% 0 0 0 round 14px)');
    expect(edgeClip('up', '14px')).toBe('inset(0 0 100% 0 round 14px)');
  });

  it('stays well inside half a second, in step with the CSS slide', () => {
    expect(WALL_PUSH_MS).toBeLessThan(500);
    const wall = cssRule(stylesheet('components/commandWallLayouts.css'), '.command-wall-layout');
    expect(wall['--wall-push-ms']).toBe(`${WALL_PUSH_MS}ms`);
    expect(wall['--wall-push-ease']).toBe(cssValue(WALL_PUSH_EASE));
  });
});

function stubPage(reduced: boolean) {
  const append = vi.fn();
  vi.stubGlobal('window', { matchMedia: () => ({ matches: reduced }), setTimeout: vi.fn(), clearTimeout: vi.fn() });
  vi.stubGlobal('getComputedStyle', () => ({ borderRadius: '14px' }));
  vi.stubGlobal('document', { createElement: vi.fn(() => ({ className: '', style: { setProperty: vi.fn() }, setAttribute: vi.fn(), append: vi.fn(), remove: vi.fn() })), body: { append } });
  return { append };
}

const windowEl = (connected: boolean) => {
  const animate = vi.fn(() => ({ finished: new Promise(() => {}) }));
  return { animate, isConnected: connected, inert: false, removeAttribute: vi.fn(), setAttribute: vi.fn(), querySelectorAll: () => [], getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }) };
};

describe('wall push animations', () => {
  it('reveals a new window from its outer edge over the push', () => {
    stubPage(false);
    const el = windowEl(true);
    growWindow(el as unknown as HTMLElement, 'right');
    expect(el.animate).toHaveBeenCalledWith(
      [{ clipPath: 'inset(0 0 0 100% round 14px)', opacity: 0.7 }, { clipPath: 'inset(0 0 0 0 round 14px)', opacity: 1 }],
      { duration: WALL_PUSH_MS, easing: WALL_PUSH_EASE },
    );
  });

  it('folds a removed window into its edge from an inert layer', () => {
    stubPage(false);
    const el = windowEl(false);
    const layer = { append: vi.fn() };
    foldWindow(el as unknown as HTMLElement, layer as unknown as HTMLElement, 'left');
    expect(layer.append).toHaveBeenCalledWith(el);
    expect(el.inert).toBe(true);
    expect(el.removeAttribute).toHaveBeenCalledWith('data-wall-pane');
    expect(el.setAttribute).toHaveBeenCalledWith('data-wall-leaving', '');
    expect(el.animate).toHaveBeenCalledWith(
      [{ clipPath: 'inset(0 0 0 0 round 14px)', opacity: 1 }, { clipPath: 'inset(0 100% 0 0 round 14px)', opacity: 0.6 }],
      { duration: WALL_PUSH_MS, easing: WALL_PUSH_EASE, fill: 'forwards' },
    );
  });

  it('does nothing under reduced motion, or for a window still on the wall', () => {
    stubPage(true);
    const el = windowEl(false);
    const layer = { append: vi.fn() };
    expect(growWindow(el as unknown as HTMLElement, 'right')).toBeNull();
    foldWindow(el as unknown as HTMLElement, layer as unknown as HTMLElement, 'left');
    stubPage(false);
    foldWindow(windowEl(true) as unknown as HTMLElement, layer as unknown as HTMLElement, 'left');
    expect(el.animate).not.toHaveBeenCalled();
    expect(layer.append).not.toHaveBeenCalled();
  });

  it('lays stardust along the folded edge and clears it after its run', () => {
    vi.useFakeTimers();
    const dust = { className: '', style: { left: '', top: '', setProperty: vi.fn() }, setAttribute: vi.fn(), append: vi.fn(), remove: vi.fn() };
    const grain = () => ({ className: '', style: { setProperty: vi.fn() } });
    const append = vi.fn();
    vi.stubGlobal('document', { createElement: vi.fn().mockReturnValueOnce(dust).mockImplementation(grain), body: { append } });
    vi.stubGlobal('window', { setTimeout });
    scatterEdgeDust({ left: 100, top: 50, width: 400, height: 600 }, 'right');
    expect(dust.className).toBe('completion-stardust');
    expect(dust.style.left).toBe('500px');
    expect(dust.style.top).toBe('350px');
    expect(dust.append.mock.calls.length).toBeGreaterThanOrEqual(10);
    expect(append).toHaveBeenCalledWith(dust);
    vi.advanceTimersByTime(EDGE_DUST_MS);
    expect(dust.remove).toHaveBeenCalledOnce();
  });
});
