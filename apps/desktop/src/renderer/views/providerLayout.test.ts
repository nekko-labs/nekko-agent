import { describe, expect, it } from 'vitest';
import { columnsFor, packGroups } from './providerLayout.js';

const shape = (rows: ReturnType<typeof packGroups<string>>) => rows.map((r) => r.map((s) => s.items.join(',')));

describe('provider group packing', () => {
  it('puts one local and one cloud side by side', () => {
    const rows = packGroups([{ key: 'local', items: ['l1'] }, { key: 'cloud', items: ['c1'] }], 2);
    expect(shape(rows)).toEqual([['l1', 'c1']]);
  });

  it('keeps two cloud cards together when they do not fit beside local', () => {
    const rows = packGroups([{ key: 'local', items: ['l1'] }, { key: 'cloud', items: ['c1', 'c2'] }], 2);
    expect(shape(rows)).toEqual([['l1'], ['c1,c2']]);
  });

  it('moves the third cloud card next to local on the following line', () => {
    const rows = packGroups([{ key: 'local', items: ['l1'] }, { key: 'cloud', items: ['c1', 'c2', 'c3'] }], 2);
    expect(shape(rows)).toEqual([['c1,c2'], ['l1', 'c3']]);
  });

  it('fits everything on one row when wide enough', () => {
    const rows = packGroups([{ key: 'local', items: ['l1'] }, { key: 'cloud', items: ['c1', 'c2'] }], 3);
    expect(shape(rows)).toEqual([['l1', 'c1,c2']]);
  });

  it('stacks in one column and skips empty groups', () => {
    const rows = packGroups([{ key: 'local', items: [] }, { key: 'cloud', items: ['c1', 'c2'] }], 1);
    expect(shape(rows)).toEqual([['c1'], ['c2']]);
  });

  it('computes columns from width', () => {
    expect(columnsFor(832, 360, 16)).toBe(2);
    expect(columnsFor(1088, 340, 16)).toBe(3);
    expect(columnsFor(300, 360, 16)).toBe(1);
    expect(columnsFor(0, 360, 16)).toBe(1);
  });
});
