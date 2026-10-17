import { describe, expect, it } from 'vitest';
import { columnsFor, packGroups } from './providerLayout.js';

const shape = (rows: ReturnType<typeof packGroups<string>>) =>
  rows.map((r) => r.map((s) => `${s.items.join(',')}/${s.span}`));

describe('provider group packing', () => {
  it('puts one local and one cloud side by side', () => {
    const rows = packGroups([{ key: 'local', items: ['l1'] }, { key: 'cloud', items: ['c1'] }], 2);
    expect(shape(rows)).toEqual([['l1/1', 'c1/1']]);
  });

  it('gives a group its own line when it does not fit beside the previous one', () => {
    const rows = packGroups([{ key: 'local', items: ['l1'] }, { key: 'cloud', items: ['c1', 'c2'] }], 2);
    expect(shape(rows)).toEqual([['l1/1'], ['c1,c2/2']]);
  });

  it('never splits a group: extra cards wrap inside its own container', () => {
    const rows = packGroups(
      [{ key: 'local', items: ['l1', 'l2', 'l3', 'l4'] }, { key: 'cloud', items: ['c1', 'c2', 'c3', 'c4', 'c5'] }],
      3,
    );
    expect(shape(rows)).toEqual([['l1,l2,l3,l4/3'], ['c1,c2,c3,c4,c5/3']]);
  });

  it('fits everything on one row when wide enough', () => {
    const rows = packGroups([{ key: 'local', items: ['l1', 'l2'] }, { key: 'cloud', items: ['c1'] }], 3);
    expect(shape(rows)).toEqual([['l1,l2/2', 'c1/1']]);
  });

  it('stacks in one column and skips empty groups', () => {
    const rows = packGroups([{ key: 'local', items: [] }, { key: 'cloud', items: ['c1', 'c2'] }], 1);
    expect(shape(rows)).toEqual([['c1,c2/1']]);
  });

  it('computes columns from width', () => {
    expect(columnsFor(832, 360, 16)).toBe(2);
    expect(columnsFor(1088, 340, 16)).toBe(3);
    expect(columnsFor(300, 360, 16)).toBe(1);
    expect(columnsFor(0, 360, 16)).toBe(1);
  });
});
