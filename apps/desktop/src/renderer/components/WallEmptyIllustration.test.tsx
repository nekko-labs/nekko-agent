import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const preset = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock('../store.js', () => ({ useStore: (select: (s: unknown) => unknown) => select({ settings: { themePreset: preset.value } }) }));
import { WallEmptyIllustration, wallEmptyVariant } from './WallEmptyIllustration.js';

describe('empty wall illustration', () => {
  it('maps Spooky (autumn) and Winter to their variants, everything else to default', () => {
    expect(wallEmptyVariant('autumn')).toBe('spooky');
    expect(wallEmptyVariant('winter')).toBe('winter');
    for (const p of [undefined, 'dark', 'light', 'nebula', 'terminal']) expect(wallEmptyVariant(p)).toBe('default');
  });
  it('dresses the scene for Spooky and keeps it plain otherwise', () => {
    preset.value = 'dark';
    const plain = renderToStaticMarkup(<WallEmptyIllustration />);
    expect(plain).toContain('data-variant="default"');
    expect(plain).not.toContain('data-part="spooky"');
    expect(plain).not.toContain('orange-wizard-hat');
    expect(plain).toContain('aria-hidden="true"');
    preset.value = 'autumn';
    const spooky = renderToStaticMarkup(<WallEmptyIllustration />);
    expect(spooky).toContain('data-variant="spooky"');
    expect(spooky).toContain('data-part="spooky"');
    expect(spooky).not.toContain('orange-wizard-hat');
  });
  it('snows on the wall for Winter, with a kagami mochi in place of the snowman over Oshogatsu', () => {
    preset.value = 'winter';
    const december = renderToStaticMarkup(<WallEmptyIllustration now={new Date(2026, 11, 10)} />);
    expect(december).toContain('data-variant="winter"');
    expect(december).toContain('data-part="snowman"');
    expect(december).not.toContain('kagami-mochi');
    expect(december).not.toContain('data-part="spooky"');
    expect(december).not.toMatch(/winter-beanie|santa-hat/);
    const newYear = renderToStaticMarkup(<WallEmptyIllustration now={new Date(2027, 0, 2)} />);
    expect(newYear).toContain('data-part="kagami-mochi"');
    expect(newYear).not.toContain('data-part="snowman"');
    preset.value = undefined;
  });
});
