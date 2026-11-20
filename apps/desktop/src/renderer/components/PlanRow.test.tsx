import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { fittingPlanChips, PlanRow } from './PlanRow.js';

describe('whole-chip fit', () => {
  it('fits everything without reserving a disclosure unnecessarily', () => {
    expect(fittingPlanChips([60, 80], 148, 30)).toBe(2);
    expect(fittingPlanChips([], 0, 30)).toBe(0);
  });
  it('reserves the count chip and gaps before admitting a prefix', () => {
    expect(fittingPlanChips([60, 80, 20], 146, 30)).toBe(1);
    expect(fittingPlanChips([60, 80, 20], 97, 30)).toBe(0);
    expect(fittingPlanChips([60, 80, 20], 98, 30)).toBe(1);
    expect(fittingPlanChips([200, 20], 100, 30)).toBe(0);
  });
  it('handles zero, fractional and multi-digit count widths', () => {
    expect(fittingPlanChips([60], 0, 30)).toBe(0);
    expect(fittingPlanChips([60.5, 80.5], 149, 30)).toBe(2);
    expect(fittingPlanChips(Array(12).fill(20), 100, 40)).toBe(2);
  });
});

it('connects a keyboard disclosure to its row and keeps measurement chips out of the accessibility tree', () => {
  const html = renderToStaticMarkup(<PlanRow title="Inspect code" chips={[<button key="pr">PR #9</button>]} />);
  expect(html).toContain('aria-label="Show 1 more chips"');
  expect(html).toContain('aria-expanded="false"');
  const id = html.match(/aria-controls="([^"]+)"/)![1];
  expect(html).toContain('id="' + id + '"');
  expect(html).toContain('data-overflowed="true" aria-hidden="true" inert=""');
});
