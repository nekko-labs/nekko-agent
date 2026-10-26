import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../tests/browserGlobals.js';
import { cssRule, cssUtility, cssValue, hasSelector, stylesheet } from '../tests/css.js';
import { liveStore } from '../tests/liveStore.js';
import { withProvider } from '../tests/renderChatPane.js';
import { renderWallComposer } from '../tests/renderWallComposer.js';

vi.mock('../store.js', (original) => liveStore(original as never));
vi.mock('../liveRuns.js', async (original) => ({ ...(await original<object>()), useLiveRun: () => undefined }));

const styles = stylesheet('styles.css');
const board = stylesheet('components/commandWallLayouts.css');
beforeEach(() => withProvider());

describe('wall edge stability and composer handles', () => {
  it('excludes dormant Add cards from scroll geometry and reserves the scrollbar gutter', () => {
    expect(cssRule(board, '.command-wall-layout')).toMatchObject({ 'scrollbar-gutter': 'stable', 'overflow-x': 'hidden' });
    expect(cssRule(board, '.command-wall-add:not([data-preview])').display).toBe('none');
    // Add window moved beside the composer: no edge rails remain on the wall.
    expect(hasSelector(board, /command-wall-add-rail/)).toBe(false);
  });

  it('grows the composer panel by its attachment rows instead of shrinking the editor', () => {
    // The shell stays natural-height with exactly one vertical scroll owner: the editor.
    expect(cssRule(styles, '.wall-composer > .wall-composer-body')).toMatchObject({ display: 'flex', flex: '0 0 auto', 'min-height': '0', overflow: 'visible' });
    expect(cssRule(styles, '.wall-composer .composer-editor-wrap > [contenteditable]')).toMatchObject({ flex: '0 0 auto', 'min-height': '64px', 'overflow-y': 'auto', 'overflow-x': 'hidden', 'overflow-wrap': 'anywhere' });
    // No fixed height on the panel from the dragged size: the observer sizes the editor instead.
    const panel = renderWallComposer().match(/^<div[^>]*class="panel wall-composer [^>]*>/)?.[0];
    expect(panel).toBeDefined();
    expect(panel).not.toMatch(/style="[^"]*height/);
    // Source pin: the observer is wired in a layout effect, which a server render never runs.
    expect(readFileSync(new URL('./WallComposer.tsx', import.meta.url), 'utf8')).toMatch(/observeWallComposer\(panel, height \?\? null\)/);
  });

  it('keeps the focused wall composer to a single softened 1px border inside its clipped panel', () => {
    for (const selector of ['.wall-composer .composer', '.wall-composer .composer:focus-within']) {
      expect(cssRule(styles, selector)['box-shadow'], selector).toBe('none');
    }
    expect(cssUtility(styles, 'composer', ':focus-within')['border-color']).toBe(cssValue('color-mix(in srgb, var(--accent) 70%, var(--line))'));
  });

  it('keeps all resize handles on the composer', () => {
    const html = renderWallComposer({ resizeHandle: <div data-split-handle /> });
    const panel = html.slice(0, html.indexOf('wall-composer-body'));
    // The height grip given by the page, then a width grip on each side, all on the panel itself.
    expect(panel).toContain('data-split-handle');
    expect(panel.match(/class="wall-composer-side" data-edge="(left|right)" role="separator" tabindex="0"/g)).toHaveLength(2);
    expect(panel).toContain('aria-label="Resize composer from left side"');
    expect(panel).toContain('aria-label="Resize composer from right side"');
  });

  // Source pin, pending the composer e2e journey: dragging, pointer capture,
  // double-click and keyboard reset are handlers that need a DOM to fire.
  it('supports pointer capture, cancellation and reset (source pin)', () => {
    const source = readFileSync(new URL('./WallComposer.tsx', import.meta.url), 'utf8');
    expect(source).toMatch(/setPointerCapture\(e\.pointerId\)/);
    expect(source).toMatch(/onLostPointerCapture/);
    expect(source).toMatch(/dock\.align === 'center' \? 2 : 1/);
    expect(source).toMatch(/onDoubleClick=\{\(\) => setWidth\(null\)\}/);
    expect(source).toMatch(/e\.key === 'Home'/);
    expect(source).toMatch(/Math\.min\(available, next\)/);
  });
});
