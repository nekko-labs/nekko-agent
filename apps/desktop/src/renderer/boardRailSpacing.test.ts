import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { railGeometry } from './railGeometry.js';

describe('linear mirrored rail geometry', () => {
  it('extends to the left edge with a 95px shoulder and a linear 40/30/20 tail', () => {
    const g = railGeometry({ railHeight: 1200, groupTop: 300, groupHeight: 500 });
    expect(g.extension).toBe(298);
    expect(g.points.slice(0, 6)).toEqual([
      [0, 2], [20, 12], [30, 108.5], [40, 205], [198, 300], [198, 300],
    ]);
    expect(g.points[1][1] - g.points[0][1]).toBe(10);
    expect((30 - 20) / (108.5 - 12)).toBe((40 - 30) / (205 - 108.5));
    for (let i = 0; i < 6; i++) {
      expect(g.points[11 - i]).toEqual([g.points[i][0], g.top + g.bottom - g.points[i][1]]);
      if (i) expect(g.points[i][0]).toBeGreaterThanOrEqual(g.points[i - 1][0]);
    }
  });

  it.each([
    [900, 80, 480], [500, 16, 468], [200, 16, 168], [32, 16, 0],
    [0, 0, 0], [100, -40, 200], [100, 140, 80], [NaN, NaN, Infinity],
  ])('bounds and mirrors short/invalid layout %s/%s/%s', (railHeight, groupTop, groupHeight) => {
    const g = railGeometry({ railHeight, groupTop, groupHeight });
    for (const [x, y] of g.points) {
      expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(g.height);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(g.width);
    }
    expect(g.top - g.points[0][1]).toBeCloseTo(g.points[11][1] - g.bottom);
    expect(g.points.slice(0, 6).map(p => p[1])).toEqual(g.points.slice(0, 6).map(p => p[1]).sort((a, b) => a - b));
  });
});

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('compact board and navigation spacing', () => {
  it('keeps button widths, click-through tails and identical hover/focus geometry', () => {
    const css = read('./styles.css');
    expect(css).toContain('width: 52px;');
    expect(css).toContain('width: 198px;\n    padding-right: 16px;');
    expect(198 - 6 - 16).toBe(188 - 12);
    expect(css).toContain('pointer-events: none;');
    expect(css).toContain('@utility rail-destinations {\n  pointer-events: auto;');
    expect(css).toContain('&:hover .rail-backdrop,\n  &:has(:focus-visible) .rail-backdrop');
    expect(css).not.toContain('.rail-group::before');
    expect(css).toContain('var(--accent) 4%, var(--paper)');
    expect(css).toContain('var(--accent) 7%, var(--paper)');
    const app = read('./App.tsx');
    expect(app).toContain('<RailBackdrop />');
    expect(app).toContain('rail-destinations flex min-h-0 flex-col gap-[7px]');
    expect(app).not.toContain('flex-col overflow-hidden px-1.5 py-4');
    expect(app).toContain('hidden w-[52px] shrink-0 md:block');
    const component = read('./components/RailBackdrop.tsx');
    expect(component).toContain('observer.observe(parent)');
    expect(component).toContain('groupObserver.observe(group)');
    expect(component).toContain('observer.disconnect(); groupObserver.disconnect();');
    expect(component).not.toContain('requestAnimationFrame');
  });

  it('keeps 1px around the board and 8px beside the agent list without shrinking grips', () => {
    const css = read('./components/commandWallLayouts.css');
    expect(css).toContain('padding: 14px 1px;');
    expect(css).toContain("[data-tabs='left'] { flex-direction: row; gap: 8px; }");
    const styles = read('./styles.css');
    expect(styles).toContain('padding-inline: 15px calc(15px + var(--wall-gutter));');
    expect(styles).toContain('width: 14px; z-index: 2; cursor: col-resize;');
  });
});
