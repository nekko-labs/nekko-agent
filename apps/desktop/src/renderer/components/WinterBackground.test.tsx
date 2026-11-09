import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WinterBackground } from './WinterBackground.js';

const at = (hour: number) => () => new Date(2026, 11, 10, hour);

describe('Winter background', () => {
  it('is decorative snow with the snow cat and the drift hidden among it', () => {
    const markup = renderToStaticMarkup(<WinterBackground now={at(12)} />);
    expect(markup).toContain('class="winter-background"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup.match(/class="winter-flake"/g)).toHaveLength(8);
    expect(markup).toContain('data-winter-egg="snow-cat"');
    expect(markup).toContain('data-winter-egg="drift"');
  });
  it('shows the aurora only late at night', () => {
    expect(renderToStaticMarkup(<WinterBackground now={at(12)} />)).not.toContain('winter-aurora');
    expect(renderToStaticMarkup(<WinterBackground now={at(23)} />)).toContain('data-winter-egg="aurora"');
    expect(renderToStaticMarkup(<WinterBackground now={at(2)} />)).toContain('data-winter-egg="aurora"');
  });
});
