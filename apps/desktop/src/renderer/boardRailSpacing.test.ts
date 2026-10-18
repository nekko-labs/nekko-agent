import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RAIL_MIN_LOWER_SWOOP, RAIL_OPEN_RADIUS, RAIL_ROW_CLEARANCE, RAIL_TIP, RAIL_TIP_INSET, railGeometry } from './railGeometry.js';

const nums = (d: string) => d.match(/-?[\d.]+/g)!.map(Number);
/** Every x the outline reaches (absolute commands only, x first in each pair). */
const xs = (d: string) => nums(d).filter((_, i) => i % 2 === 0);

describe('swoop rail geometry', () => {
  const g = railGeometry({ railHeight: 1200, groupTop: 300, groupHeight: 500 });

  it('starts and ends as a hairline near the rail ends and swells to the rest width beside the rows', () => {
    expect(g.y0).toBe(RAIL_TIP_INSET);
    expect(g.y1).toBe(1200 - RAIL_TIP_INSET);
    expect(g.swellTop).toBe(300 - RAIL_ROW_CLEARANCE);
    expect(g.swellBottom).toBe(800 + RAIL_ROW_CLEARANCE);
    expect(g.restPath.startsWith(`M0,${RAIL_TIP_INSET} L0,${RAIL_TIP_INSET} Q${RAIL_TIP},${RAIL_TIP_INSET}`)).toBe(true);
    expect(g.restPath).toContain(`52,${g.swellTop} L52,${g.swellBottom}`);
    expect(Math.max(...xs(g.restPath))).toBe(52);
    expect(g.restPath).toMatch(new RegExp(`L0,${g.y1} Z$`));
  });

  it('mirrors the upper swoop below the rows, then runs on as a hairline', () => {
    const upper = g.swellTop - (g.y0 + RAIL_TIP);
    const tail = g.swellBottom + Math.max(upper, RAIL_MIN_LOWER_SWOOP);
    expect(g.restPath).toContain(`${RAIL_TIP},${tail} L${RAIL_TIP},${g.y1 - RAIL_TIP}`);
  });

  it('opens to one even column with rounded ends', () => {
    expect(new Set(xs(g.openPath).filter(x => x > 0 && x < 198 - RAIL_OPEN_RADIUS))).toEqual(new Set());
    expect(g.openPath.startsWith(`M0,${RAIL_TIP_INSET} L${198 - RAIL_OPEN_RADIUS},${RAIL_TIP_INSET} Q198,${RAIL_TIP_INSET} 198,${RAIL_TIP_INSET + RAIL_OPEN_RADIUS}`)).toBe(true);
  });

  it('shares one command list so `d` interpolates', () => {
    const shape = (d: string) => d.replace(/[-\d.]+/g, 'n');
    expect(shape(g.restPath)).toBe(shape(g.openPath));
  });

  it.each([
    [900, 80, 480], [500, 16, 468], [200, 16, 168], [32, 16, 0],
    [0, 0, 0], [100, -40, 200], [100, 140, 80], [NaN, NaN, Infinity],
  ])('bounds short/invalid layout %s/%s/%s', (railHeight, groupTop, groupHeight) => {
    const r = railGeometry({ railHeight, groupTop, groupHeight });
    for (const d of [r.restPath, r.openPath]) {
      const values = nums(d);
      expect(values.every(Number.isFinite)).toBe(true);
      for (const [i, v] of values.entries()) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(i % 2 === 0 ? r.width : Math.max(r.height, r.bottom));
      }
    }
  });
});

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('compact board and navigation spacing', () => {
  it('keeps button widths, click-through spacing and identical hover/focus/pinned geometry', () => {
    const css = read('./styles.css');
    expect(css).toContain('--rail-w-rest: 52px;');
    expect(css).toContain('--rail-w-open: 198px;');
    expect(css).toContain('width: var(--rail-w-open);\n  padding-right: 16px;');
    expect(198 - 6 - 16).toBe(188 - 12);
    expect(css).toContain('pointer-events: none;');
    expect(css).toMatch(/\.rail-destinations \{[^}]*pointer-events: auto;/);
    expect(css).toContain('.rail:is(:hover, :has(:focus-visible), [data-open]) {');
    expect(css).toContain('d: var(--rail-open);');
    expect(css).toContain('pointer-events: visiblePainted;');
    expect(css).toContain('var(--accent) 8%, var(--paper)');
    expect(css).toContain('var(--accent) 6%, var(--surface)');
    expect(css).not.toContain('@utility rail {');
    expect(css).not.toContain('rail-item-in');
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{\n  \.rail, \.rail-backdrop/);
    const app = read('./App.tsx');
    expect(app).toContain('<RailBackdrop />');
    expect(app).toContain('<div className="rail-destinations">');
    expect(app).toContain('className="rail-indicator"');
    expect(app).toContain("'--i': Math.max(0, activeNavIndex)");
    expect(app).toContain("'--n': navIndex");
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
