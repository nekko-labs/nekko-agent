import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('wall edge stability and composer handles', () => {
  it('excludes dormant Add cards from scroll geometry and reserves the scrollbar gutter', () => {
    const css = readFileSync(new URL('./commandWallLayouts.css', import.meta.url), 'utf8');
    expect(css).toContain('scrollbar-gutter: stable');
    expect(css).toContain('overflow-x: hidden');
    expect(css).toContain('.command-wall-add:not([data-preview]) { display: none;');
    // Add window moved beside the composer: no edge rails remain on the wall.
    expect(css).not.toContain('command-wall-add-rail');
  });
  it('grows the composer panel by its attachment rows instead of shrinking the editor', () => {
    const source = readFileSync(new URL('./WallComposer.tsx', import.meta.url), 'utf8');
    expect(source).toContain('observeWallComposer(panel, height ?? null)');
    expect(source).not.toContain('height: height == null');
    const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
    // The shell stays natural-height with exactly one vertical scroll owner.
    expect(css).toContain('.wall-composer > .wall-composer-body { display: flex; flex: 0 0 auto; min-height: 0; overflow: visible; }');
    expect(css).toContain('.wall-composer .composer-editor-wrap > [contenteditable] { flex: 0 0 auto; min-height: 64px;');
    expect(css).toContain('overflow-y: auto; overflow-x: hidden; overflow-wrap: anywhere;');
    expect(css).not.toContain('height: 0 !important');
    expect(css).not.toMatch(/\.wall-composer > \.wall-composer-body[^}]*overflow-y: auto/);
    const chat = readFileSync(new URL('./ChatPane.tsx', import.meta.url), 'utf8');
    expect(chat).toContain('data-composer-attachments');
    expect(chat).toContain('data-composer-skill');
  });
  it('keeps the focused wall composer to a single softened 1px border inside its clipped panel', () => {
    const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
    expect(css).toContain('.wall-composer .composer, .wall-composer .composer:focus-within { box-shadow: none; }');
    expect(css).not.toContain('.wall-composer .composer:focus-within { box-shadow: inset 0 0 0 1px var(--accent); }');
    expect(css).toContain('border-color: color-mix(in srgb, var(--accent) 70%, var(--line));');
    expect(css).toContain('.wall-composer .composer-beam-ring { inset: 0; }');
  });
  it('keeps all resize handles on the composer and supports cancellation and reset', () => {
    const source = readFileSync(new URL('./WallComposer.tsx', import.meta.url), 'utf8');
    expect(source).toContain('{resizeHandle}');
    expect(source).toContain("(['left', 'right'] as const).map");
    expect(source).toContain('setPointerCapture(e.pointerId)');
    expect(source).toContain('onLostPointerCapture');
    expect(source).toContain("dock.align === 'center' ? 2 : 1");
    expect(source).toContain('onDoubleClick={() => setWidth(null)}');
    expect(source).toContain("e.key === 'Home'");
    expect(source).toContain('Math.min(available, next)');
  });
});
