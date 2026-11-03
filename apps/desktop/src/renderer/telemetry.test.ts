import { describe, expect, it, vi } from 'vitest';

vi.mock('./store.js', () => ({ useStore: { getState: () => ({}), subscribe: () => () => {} } }));

import { errorReport } from './telemetry.js';

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
