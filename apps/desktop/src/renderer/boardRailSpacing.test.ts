import { describe, expect, it, vi } from 'vitest';
import './tests/browserGlobals.js';
import { cssRule, cssValue, hasSelector, stylesheet } from './tests/css.js';
import { liveStore } from './tests/liveStore.js';
import { renderApp } from './tests/renderApp.js';

vi.mock('./store.js', (original) => liveStore(original as never));
import { RAIL_MAX_TAPER, RAIL_MIN_LOWER_SWOOP, RAIL_ROW_CLEARANCE, railGeometry } from './railGeometry.js';

const nums = (d: string) => d.match(/-?[\d.]+/g)!.map(Number);
/** Every x the outline reaches (absolute commands only, x first in each pair). */
const xs = (d: string) => nums(d).filter((_, i) => i % 2 === 0);

describe('swoop rail geometry', () => {
  const g = railGeometry({ railHeight: 1200, groupTop: 300, groupHeight: 500 });

  it('tapers out of the wall above the rows and swells to the rest width beside them', () => {
    expect(g.swellTop).toBe(300 - RAIL_ROW_CLEARANCE);
    expect(g.swellBottom).toBe(800 + RAIL_ROW_CLEARANCE);
    expect(g.y0).toBe(g.swellTop - RAIL_MAX_TAPER);
    expect(g.restPath.startsWith(`M0,${g.y0} C0,`)).toBe(true);
    expect(g.restPath).toContain(`52,${g.swellTop} L52,${g.swellBottom}`);
    expect(Math.max(...xs(g.restPath))).toBe(52);
  });

  it('mirrors the upper taper below the rows and ends at the wall with no tail', () => {
    expect(g.y1).toBe(g.swellBottom + Math.max(RAIL_MAX_TAPER, RAIL_MIN_LOWER_SWOOP));
    expect(g.restPath).toMatch(new RegExp(` 0,${g.y1} Z$`));
    // Only the two tapers and the wall reach x = 0; no hairline runs on.
    expect(g.restPath.match(/L/g)).toHaveLength(1);
  });

  it('keeps short gaps above the rows as a shorter taper', () => {
    const short = railGeometry({ railHeight: 900, groupTop: 60, groupHeight: 400 });
    expect(short.y0).toBe(0);
    expect(short.y1).toBe(short.swellBottom + RAIL_MIN_LOWER_SWOOP);
  });

  it('opens to the full width on the same vertical anchors', () => {
    expect(Math.max(...xs(g.openPath))).toBe(198);
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
  });

  it('paints static wings with the darker fill and only widens their viewport', () => {
    expect(cssRule(styles, '.rail')).toMatchObject({ top: '5%', bottom: '5%', 'pointer-events': 'none' });
    expect(cssRule(styles, '.rail').background).toBeUndefined();
    expect(cssRule(styles, '.rail-feedback')['pointer-events']).toBe('auto');
    expect(cssRule(styles, '.rail-backdrop')).toMatchObject({ width: 'var(--rail-w-rest)', 'pointer-events': 'none' });
    expect(cssRule(styles, '.rail-backdrop path').fill).toBe(cssValue('var(--rail-fill, color-mix(in srgb, color-mix(in srgb, var(--paper) 92%, black) 97%, transparent))'));
    expect(cssRule(styles, `${OPEN} .rail-backdrop`).width).toBe('var(--rail-w-open)');
    for (const selector of ['.rail-backdrop', '.rail-backdrop path', `${OPEN} .rail-backdrop`]) {
      expect(cssRule(styles, selector)['clip-path']).toBeUndefined();
      expect(cssRule(styles, selector).d).toBeUndefined();
      expect(cssRule(styles, selector)['backdrop-filter']).toBeUndefined();
    }
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
    expect(group).toContain('class="rail-backdrop"');
    expect(group).toContain('preserveAspectRatio="none"');
    // On the active (first) row; each row carries its index for the label stagger.
    expect(nav.match(/class="rail-indicator"/g)).toHaveLength(1);
    expect(nav).toMatch(/class="rail-indicator"[^>]*style="--i:0;/);
    expect(nav).toContain('style="--n:0"');
    expect(nav).toContain('style="--n:1"');
    // Send feedback sits in the shape under the last destination, set apart by a divider.
    const afterRows = group.slice(group.lastIndexOf('style="--n:'));
    expect(afterRows.indexOf('class="rail-divider"')).toBeGreaterThan(0);
    expect(afterRows.indexOf('data-testid="rail-feedback"')).toBeGreaterThan(afterRows.indexOf('class="rail-divider"'));
    expect(afterRows.indexOf('data-testid="rail-feedback"')).toBeLessThan(afterRows.indexOf('class="rail-space-after"'));
  });

  it('keeps 1px around the board and one wall gap beside the agent list without shrinking grips', () => {
    const board = stylesheet('components/commandWallLayouts.css');
    expect(cssRule(board, '.command-wall-layout').padding).toBe('12px 1px 0');
    expect(cssRule(board, ".wall-agent-workspace[data-tabs='left']")).toMatchObject({ 'flex-direction': 'row', gap: cssValue('calc(var(--pane-gap) - 1px)') });
    expect(cssRule(styles, '.wall-composer-row')['padding-inline']).toBe(cssValue('15px calc(15px + var(--wall-gutter))'));
    expect(cssRule(styles, '.wall-composer-side')).toMatchObject({ width: '14px', 'z-index': '2', cursor: 'col-resize' });
  });

  it('spaces the agent panel, windows, composer and dock one --pane-gap apart', () => {
    const board = stylesheet('components/commandWallLayouts.css');
    expect(cssRule(styles, '.wall-workspace')).toMatchObject({ 'row-gap': cssValue('var(--pane-gap)'), 'column-gap': cssValue('calc(var(--pane-gap) - 1px)') });
    expect(cssRule(styles, ".wall-workspace[data-dock-side='right']:has(.command-wall-layout[data-zone-rails])")['column-gap']).toBe('0');
    // Windows stop a gap short of a composer below them, rails or not.
    expect(cssRule(board, '.wall-column:has(> .wall-composer-row:last-child) > .command-wall-layout')['padding-bottom']).toBe(cssValue('var(--pane-gap)'));
    expect(cssRule(board, '.command-wall-layout[data-zone-rails]')).toMatchObject({ '--zone-rail': '14px', 'padding-right': cssValue('var(--zone-rail)'), 'padding-bottom': cssValue('var(--zone-rail)'), overflow: 'clip' });
    // The resize handle lives in the gap, never over the windows' footers.
    expect(cssRule(styles, '.wall-composer-split').height).toBe(cssValue('var(--pane-gap)'));
    expect(cssRule(styles, '.wall-composer[data-dock^="bottom"] > .wall-composer-split').top).toBe(cssValue('calc(-1 * var(--pane-gap))'));
    // The agent panel spans the windows, from offsets CommandCenterView measures.
    expect(cssRule(board, ".wall-agent-workspace[data-tabs='left'] > .wall-agents-presence[data-orientation='vertical']", { media: 'min-width: 721px' })).toMatchObject({ 'margin-top': cssValue('var(--wall-panes-top, 0px)'), 'margin-bottom': cssValue('var(--wall-panes-bottom, 0px)') });
  });
});
