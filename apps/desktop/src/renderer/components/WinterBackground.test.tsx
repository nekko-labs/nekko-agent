import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SNOWFLAKE_TYPES, WinterBackground } from './WinterBackground.js';

const at = (hour: number) => () => new Date(2026, 11, 10, hour);
/** A repeatable stand-in for Math.random. */
function seeded(seed: number) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

describe('Winter background', () => {
  it('is decorative snow with the drift hidden among it, and no snow cat', () => {
    const markup = renderToStaticMarkup(<WinterBackground now={at(12)} random={seeded(7)} />);
    expect(markup).toContain('class="winter-background"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup.match(/class="winter-flake[^"]*"/g)).toHaveLength(10);
    expect(markup).not.toContain('snow-cat');
    expect(markup).toContain('data-winter-egg="drift"');
  });

  it('has eight snowflake designs, each drawn as six arms', () => {
    expect(SNOWFLAKE_TYPES).toHaveLength(8);
    expect(new Set(SNOWFLAKE_TYPES.map((t) => t.arm)).size).toBe(8);
    const markup = renderToStaticMarkup(<WinterBackground now={at(12)} random={() => 0.3} />);
    const first = markup.match(/<svg class="winter-flake[\s\S]*?<\/svg>/)![0];
    expect(first.match(/rotate\(/g)).toHaveLength(5);
  });

  it('picks a random design, size and slow speed for each flake', () => {
    const markup = renderToStaticMarkup(<WinterBackground now={at(12)} random={seeded(42)} />);
    const types = [...markup.matchAll(/data-flake-type="(\d)"/g)].map((m) => Number(m[1]));
    expect(new Set(types).size).toBeGreaterThan(3);
    const sizes = [...markup.matchAll(/class="winter-flake[^"]*"[^>]*width="(\d+)"/g)].map((m) => Number(m[1]));
    for (const size of sizes) expect(size).toBeGreaterThanOrEqual(22);
    const falls = [...markup.matchAll(/animation-duration:(\d+)s/g)].map((m) => Number(m[1]));
    expect(falls).toHaveLength(10);
    for (const fall of falls) expect(fall).toBeGreaterThanOrEqual(48);
    expect(new Set(falls).size).toBeGreaterThan(3);
  });

  it('shows the aurora only late at night', () => {
    expect(renderToStaticMarkup(<WinterBackground now={at(12)} />)).not.toContain('winter-aurora');
    expect(renderToStaticMarkup(<WinterBackground now={at(23)} />)).toContain('data-winter-egg="aurora"');
    expect(renderToStaticMarkup(<WinterBackground now={at(2)} />)).toContain('data-winter-egg="aurora"');
  });
});
