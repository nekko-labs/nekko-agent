import { afterEach, describe, expect, it, vi } from 'vitest';
import { archiveWithExit, scatterStardust, STARDUST_MS } from './archiveExit.js';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const makeElement = () => ({
  className: '',
  style: { left: '', top: '', setProperty: vi.fn() },
  setAttribute: vi.fn(),
  append: vi.fn(),
  remove: vi.fn(),
});

function makeRow() {
  const animations: { keyframes: Keyframe[]; cancel: ReturnType<typeof vi.fn> }[] = [];
  const row = {
    dataset: {} as Record<string, string>,
    style: { pointerEvents: '' },
    getBoundingClientRect: () => ({ left: 10, top: 100, width: 200, height: 40 }),
    animate: vi.fn((keyframes: Keyframe[]) => {
      const animation = { keyframes, cancel: vi.fn(), finished: Promise.resolve() };
      animations.push(animation);
      return animation;
    }),
  };
  return { row, animations };
}

function stubPage(reducedMotion: boolean) {
  const append = vi.fn();
  vi.stubGlobal('document', { createElement: vi.fn(makeElement), body: { append } });
  vi.stubGlobal('window', { matchMedia: () => ({ matches: reducedMotion }), setTimeout: vi.fn() as unknown as typeof setTimeout });
  vi.stubGlobal('getComputedStyle', () => ({ marginTop: '2px', marginBottom: '0px' }));
  return { append };
}

describe('archive exit', () => {
  it('archives straight away, without animating, for reduced motion', async () => {
    const { append } = stubPage(true);
    const { row } = makeRow();
    const archive = vi.fn(async () => true);
    await archiveWithExit(row as unknown as HTMLElement, archive);
    expect(archive).toHaveBeenCalledOnce();
    expect(row.animate).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it('starts archiving straight away, then closes the row to the left and collapses its height', async () => {
    const { append } = stubPage(false);
    const { row, animations } = makeRow();
    const archive = vi.fn(async () => {
      // Engine work starts in parallel with the exit so the close feels snappy.
      expect(animations).toHaveLength(0);
      expect(append).not.toHaveBeenCalled();
      return true;
    });
    await archiveWithExit(row as unknown as HTMLElement, archive);
    expect(archive).toHaveBeenCalledOnce();
    expect(animations[0].keyframes.at(-1)?.clipPath).toBe('inset(0 100% 0 0 round 8px)');
    expect(animations[1].keyframes[0].height).toBe('40px');
    expect(animations[1].keyframes.at(-1)?.height).toBe('0px');
    expect(animations[0].cancel).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledOnce();
  });

  it('puts the row back when archiving fails', async () => {
    stubPage(false);
    const { row, animations } = makeRow();
    await archiveWithExit(row as unknown as HTMLElement, async () => false);
    expect(animations.every((a) => a.cancel.mock.calls.length === 1)).toBe(true);
    expect(row.style.pointerEvents).toBe('');
    expect(row.dataset.archiving).toBeUndefined();
  });

  it('ignores a second click while the row is already leaving', async () => {
    stubPage(false);
    const { row } = makeRow();
    row.dataset.archiving = 'true';
    const archive = vi.fn(async () => true);
    await archiveWithExit(row as unknown as HTMLElement, archive);
    expect(archive).not.toHaveBeenCalled();
  });

  it('does not wait on animations that never finish', async () => {
    stubPage(false);
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), setTimeout });
    const { row } = makeRow();
    row.animate.mockImplementation((keyframes: Keyframe[]) => ({ keyframes, cancel: vi.fn(), finished: new Promise<never>(() => {}) }));
    const archive = vi.fn(async () => true);
    await archiveWithExit(row as unknown as HTMLElement, archive);
    expect(archive).toHaveBeenCalledOnce();
  });

  it('still archives when the row is not on screen', async () => {
    stubPage(false);
    const archive = vi.fn(async () => true);
    await archiveWithExit(null, archive);
    expect(archive).toHaveBeenCalledOnce();
  });

  it('anchors the stardust at the left edge of the row and clears it after its run', () => {
    vi.useFakeTimers();
    const dust = makeElement();
    const createElement = vi.fn().mockReturnValueOnce(dust).mockImplementation(makeElement);
    const append = vi.fn();
    vi.stubGlobal('document', { createElement, body: { append } });
    vi.stubGlobal('window', { setTimeout });
    scatterStardust({ left: 10, top: 100, width: 200, height: 40 });
    expect(dust.className).toBe('archive-stardust');
    expect(dust.style.left).toBe('16px');
    expect(dust.style.top).toBe('120px');
    expect(dust.append).toHaveBeenCalledTimes(14);
    expect(append).toHaveBeenCalledWith(dust);
    vi.advanceTimersByTime(STARDUST_MS - 1);
    expect(dust.remove).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(dust.remove).toHaveBeenCalledOnce();
  });
});
