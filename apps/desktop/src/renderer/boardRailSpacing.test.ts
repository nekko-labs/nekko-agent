import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { railGeometry } from './railGeometry.js';

describe('rounded mirrored rail geometry', () => {
  it('rests as one collapsed-width column and opens to the full width, tails included', () => {
    const g = railGeometry({ railHeight: 1200, groupTop: 300, groupHeight: 500 });
    expect(g.extension).toBe(298);
    expect(g.rest.every(([x]) => x === 52)).toBe(true);
    expect(g.open.every(([x]) => x === 198)).toBe(true);
    for (let i = 0; i < 4; i++) {
      expect(g.rest[7 - i]).toEqual([g.rest[i][0], g.top + g.bottom - g.rest[i][1]]);
    }
  });

  it('ends each tail in a concave curve to x=0 and shares one command list for interpolation', () => {
    const g = railGeometry({ railHeight: 1200, groupTop: 300, groupHeight: 500 });
    expect(g.restPath.startsWith('M0,2 Q0,')).toBe(true);
    expect(g.restPath).toMatch(/Q0,[\d.]+ 0,[\d.]+ Z$/);
    const shape = (d: string) => d.replace(/[-\d.]+/g, 'n');
    expect(shape(g.restPath)).toBe(shape(g.openPath));
  });

  it.each([
    [900, 80, 480], [500, 16, 468], [200, 16, 168], [32, 16, 0],
    [0, 0, 0], [100, -40, 200], [100, 140, 80], [NaN, NaN, Infinity],
  ])('bounds short/invalid layout %s/%s/%s', (railHeight, groupTop, groupHeight) => {
    const g = railGeometry({ railHeight, groupTop, groupHeight });
    for (const d of [g.restPath, g.openPath]) {
      const nums = d.match(/-?[\d.]+/g)!.map(Number);
      expect(nums.every(Number.isFinite)).toBe(true);
    }
    for (const [x, y] of [...g.rest, ...g.open]) {
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(g.height);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(g.width);
    }
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
    expect(css).toContain('&:hover .rail-backdrop path,\n  &:has(:focus-visible) .rail-backdrop path');
    expect(css).toContain('pointer-events: visiblePainted;');
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
