import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GreetingNekko } from './GreetingNekko.js';

describe('Greeting Nekko', () => {
  it('reuses the pixel peek with paws, a ledge, and eyes looking right', () => {
    const markup = renderToStaticMarkup(<GreetingNekko />);
    expect(markup).toContain('viewBox="0 0 32 30"');
    expect(markup).toContain('shape-rendering="crispEdges"');
    expect(markup).toContain('data-part="peek-paws"');
    expect(markup).toContain('data-nekko-look="true" transform="translate(2 0)"');
    expect(markup).toContain('d="M0 25H32"');
  });

  it('is decorative, non-focusable, and inherits theme colors without network resources', () => {
    const markup = renderToStaticMarkup(<GreetingNekko />);
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('focusable="false"');
    for (const token of ['--surface', '--ink', '--accent', '--line']) expect(markup).toContain(`var(${token})`);
    expect(markup).not.toMatch(/href=|tabindex=|<image|<animate/);
  });
});
