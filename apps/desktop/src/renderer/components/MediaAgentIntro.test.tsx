import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MEDIA_INTROS, MediaArtwork } from './MediaAgentIntro.js';
import { IMAGE_SIZES, imageSizeLabel } from './agent-console/ImageModeControls.js';

describe('Photo and Video introductions', () => {
  it('has distinct copy, exactly three benefits, and honest capability limits', () => {
    expect(MEDIA_INTROS.image.name).toBe('Photo');
    expect(MEDIA_INTROS.video.name).toBe('Video');
    for (const copy of Object.values(MEDIA_INTROS)) expect(copy.benefits).toHaveLength(3);
    expect(MEDIA_INTROS.image.limit).toContain('editing an existing photo is not supported');
    expect(MEDIA_INTROS.video.limit).toContain('Direct AI video generation is not connected');
  });
  it('uses original inline artwork with no external images or scripts', () => {
    for (const kind of ['image', 'video'] as const) {
      const html = renderToStaticMarkup(<MediaArtwork kind={kind} />);
      expect(html).toContain('<svg');
      expect(html).not.toMatch(/https?:|<script|<image/);
      expect(html).toContain('aria-hidden="true"');
    }
  });
  it('offers exact reference aspect ratios, never rounding 7:4 to 16:9', () => {
    const labels = IMAGE_SIZES.map(imageSizeLabel);
    for (const ratio of ['1:1', '9:16', '3:4', '4:3', '16:9']) expect(labels.some(label => label.startsWith(`${ratio} ·`))).toBe(true);
    expect(imageSizeLabel('1344x768')).toBe('7:4 · 1344×768');
    for (const size of IMAGE_SIZES) for (const dimension of size.split('x').map(Number)) {
      expect(dimension % 64).toBe(0);
      expect(dimension).toBeLessThanOrEqual(2048);
    }
    expect(imageSizeLabel('0x0')).toBe('0x0');
  });
});
