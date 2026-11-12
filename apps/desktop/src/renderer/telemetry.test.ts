import { describe, expect, it, vi } from 'vitest';

vi.mock('./store.js', () => ({ useStore: { getState: () => ({}), subscribe: () => () => {} } }));

import { readFileSync } from 'node:fs';
import { errorReport, clickControl } from './telemetry.js';
// @ts-expect-error: a plain .mjs build script, no type declarations.
import { collectClickLabels, listPath } from '../../scripts/click-labels.mjs';

describe('click reports', () => {
  it('the committed label list matches the source (run node apps/desktop/scripts/click-labels.mjs)', () => {
    expect(JSON.parse(readFileSync(listPath, 'utf8'))).toEqual(collectClickLabels());
  });

  it('report fixed labels only, never one built from a name', () => {
    // The nearest labelled control, as Element.closest would find it.
    const inside = (attrs: Record<string, string> | null) =>
      ({ closest: () => (attrs ? { getAttribute: (k: string) => attrs[k] ?? null } : null) }) as unknown as EventTarget;
    expect(clickControl(inside({ 'aria-label': 'Add provider' }))).toBe('Add provider');
    expect(clickControl(inside({ 'aria-label': 'Open file taxes-2026.pdf' }))).toBeNull();
    expect(clickControl(inside(null))).toBeNull();
    expect(clickControl(null)).toBeNull();
  });
});

describe('UI error reports', () => {
  it('lead with the error class; nekkod keeps only the first line and frame names', () => {
    const e = new TypeError('x is undefined');
    const r = errorReport(e);
    expect(r).toEqual({ source: 'renderer', message: 'TypeError: x is undefined', stack: e.stack });
  });

  it('name a thrown non-error plainly', () => {
    expect(errorReport('Script error.')).toEqual({ source: 'renderer', message: 'Error: Script error.', stack: '' });
    expect(errorReport(undefined, 'main').message).toBe('Error: ');
  });
});
