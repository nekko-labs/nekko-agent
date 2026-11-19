import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ImageModeControls, PHOTO_SHAPES } from './ImageModeControls.js';
import type { Session } from '@nekko-agent/shared';

describe('simple photo controls', () => {
  it('leads with model and shape, not technical inputs', () => {
    const html = renderToStaticMarkup(<ImageModeControls session={{ id: 's', imageParams: {} } as Session} onChange={() => {}} busy={false} />);
    expect(html).toContain('aria-label="Image model"');
    expect(html).toContain('aria-label="Image size"');
    expect(html).toContain('Square');
    expect(html).toContain('1:1');
    expect(html).toMatch(/aria-expanded="false"[^>]*data-photo-advanced-trigger/);
    expect(html).not.toContain('type="number"');
  });
  it('retains custom/previous dimensions rather than silently changing them', () => {
    const html = renderToStaticMarkup(<ImageModeControls session={{ id: 's', imageParams: { width: 1344, height: 768 } } as Session} onChange={() => {}} busy={false} />);
    expect(html).toContain('Custom · 1344×768');
    expect(html).toContain('data-size="1344x768"');
  });
  it('uses backend-supported dimensions with exact wide/tall proportions', () => {
    for (const shape of PHOTO_SHAPES) for (const n of shape.size.split('x').map(Number)) {
      expect(n % 64).toBe(0); expect(n).toBeGreaterThanOrEqual(256); expect(n).toBeLessThanOrEqual(2048);
    }
    const [w, h] = PHOTO_SHAPES.find(s => s.label === 'Wide')!.size.split('x').map(Number);
    expect(w / h).toBeCloseTo(16 / 9);
  });
  it('names every shape for where the picture goes', () => {
    for (const shape of PHOTO_SHAPES) expect(shape.uses.length).toBeGreaterThan(0);
    expect(PHOTO_SHAPES.find(s => s.label === 'Wide')!.uses).toContain('YouTube thumbnails');
    expect(PHOTO_SHAPES.find(s => s.label === 'Square')!.uses).toContain('Icons');
  });
  it('disables shape and Advanced while a turn runs', () => {
    const html = renderToStaticMarkup(<ImageModeControls session={{ id: 's', imageParams: {} } as Session} onChange={() => {}} busy />);
    expect(html).toMatch(/aria-label="Advanced"[^>]*disabled/);
    expect(html).toMatch(/aria-label="Image size"[^>]*disabled/);
  });
});
