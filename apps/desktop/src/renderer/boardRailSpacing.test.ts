import { describe, expect, it, vi } from 'vitest';
import './tests/browserGlobals.js';
import { cssRule, cssValue, hasSelector, stylesheet } from './tests/css.js';
import { liveStore } from './tests/liveStore.js';
import { renderApp } from './tests/renderApp.js';

vi.mock('./store.js', (original) => liveStore(original as never));
import { RAIL_MIN_LOWER_SWOOP, RAIL_ROW_CLEARANCE, RAIL_TIP, RAIL_TIP_INSET, railGeometry } from './railGeometry.js';

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
    expect(new Set(xs(g.openPath).filter(x => x > 0 && x < 198 - RAIL_TIP))).toEqual(new Set());
    expect(g.openPath.startsWith(`M0,${RAIL_TIP_INSET} L${198 - RAIL_TIP},${RAIL_TIP_INSET} Q198,${RAIL_TIP_INSET} 198,${RAIL_TIP_INSET + RAIL_TIP}`)).toBe(true);
  });

  it('keeps every vertical anchor synchronized including the lower tail', () => {
    expect(nums(g.openPath).filter((_, i) => i % 2 === 1)).toEqual(nums(g.restPath).filter((_, i) => i % 2 === 1));
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

const styles = stylesheet('styles.css');
const OPEN = '.rail:is(:hover, :has(:focus-visible), [data-open])';
const reduced = (selector: string) => cssRule(styles, selector, { media: 'prefers-reduced-motion: reduce' });

describe('compact board and navigation spacing', () => {
  it('rests at 52px and opens to 198px the same way on hover, keyboard focus and pin', () => {
    const rail = cssRule(styles, '.rail');
    expect(rail['--rail-w-rest']).toBe('52px');
    expect(rail['--rail-w-open']).toBe('198px');
    expect(rail.width).toBe('var(--rail-w-rest)');
    // One rule covers hover, focus inside and [data-open], so the three open identically.
    const open = cssRule(styles, OPEN);
    expect(open.width).toBe('var(--rail-w-open)');
    expect(open['padding-right']).toBe('16px');
    // Open buttons: 198 - 6 inset - 16 right padding = the 176px row.
    expect(198 - 6 - 16).toBe(188 - 12);
    expect(cssRule(styles, `${OPEN} .rail-backdrop path`).d).toBe('var(--rail-open)');
    expect(cssRule(styles, '.rail-backdrop path').fill).toBe(cssValue('color-mix(in srgb, color-mix(in srgb, var(--accent) 8%, var(--paper)) 88%, transparent)'));
    expect(cssRule(styles, `${OPEN} .rail-backdrop path`).fill).toBe(cssValue('color-mix(in srgb, color-mix(in srgb, var(--accent) 6%, var(--surface)) 88%, transparent)'));
  });

  it('clips the tinted outline without a per-frame backdrop blur', () => {
    const backdrop = cssRule(styles, '.rail-backdrop');
    expect(backdrop['backdrop-filter']).toBe('none');
    expect(backdrop['clip-path']).toBe('var(--rail-rest)');
    expect(cssRule(styles, `${OPEN} .rail-backdrop`)['clip-path']).toBe('var(--rail-open)');
    expect(backdrop.filter).toBeUndefined();
    expect(cssRule(styles, `${OPEN} .rail-backdrop`).filter).toBeUndefined();
  });

  it('lets clicks through everywhere but the buttons and the painted outline', () => {
    expect(cssRule(styles, '.rail')['pointer-events']).toBe('none');
    expect(cssRule(styles, '.rail-destinations')['pointer-events']).toBe('auto');
    expect(cssRule(styles, '.rail-backdrop path')['pointer-events']).toBe('visiblePainted');
  });

  it('has no per-row entrance animation and snaps open and shut under reduced motion', () => {
    expect(hasSelector(styles, /rail-item-in/)).toBe(false);
    for (const selector of ['.rail', '.rail-backdrop', '.rail-backdrop path', '.rail-indicator', '.rail-label', OPEN]) {
      expect(reduced(selector)['transition-duration'], selector).toBe('0s');
    }
  });

  it('draws the backdrop behind the destinations and slides one indicator, in a 52px column', async () => {
    const html = await renderApp({});
    const nav = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'));
    expect(nav).toMatch(/^<nav class="[^"]*\bw-\[52px\][^"]*\bmd:block/);
    const group = nav.slice(nav.indexOf('class="rail-group"'));
    expect(group.indexOf('class="rail-backdrop"')).toBeGreaterThan(-1);
    expect(group.indexOf('class="rail-backdrop"')).toBeLessThan(group.indexOf('class="rail-destinations"'));
    // On the active (first) row; each row carries its index for the label stagger.
    expect(nav.match(/class="rail-indicator"/g)).toHaveLength(1);
    expect(nav).toMatch(/class="rail-indicator"[^>]*style="--i:0;/);
    expect(nav).toContain('style="--n:0"');
    expect(nav).toContain('style="--n:1"');
  });

  it('keeps 1px around the board and 8px beside the agent list without shrinking grips', () => {
    const board = stylesheet('components/commandWallLayouts.css');
    expect(cssRule(board, '.command-wall-layout').padding).toBe('14px 1px');
    expect(cssRule(board, ".wall-agent-workspace[data-tabs='left']")).toMatchObject({ 'flex-direction': 'row', gap: '8px' });
    expect(cssRule(styles, '.wall-composer-row')['padding-inline']).toBe(cssValue('15px calc(15px + var(--wall-gutter))'));
    expect(cssRule(styles, '.wall-composer-side')).toMatchObject({ width: '14px', 'z-index': '2', cursor: 'col-resize' });
  });
});
