import { describe, expect, it } from 'vitest';
import { pageGroups, pagedCount, showMoreLabel } from './listPaging.js';

describe('pagedCount', () => {
  it('caps at the page and the total', () => {
    expect(pagedCount(400, 50)).toBe(50);
    expect(pagedCount(20, 50)).toBe(20);
  });

  it('stretches to keep the selected row on screen', () => {
    expect(pagedCount(400, 50, 120)).toBe(121);
    expect(pagedCount(400, 50, 10)).toBe(50);
  });
});

describe('pageGroups', () => {
  it('truncates across groups and counts what it hid', () => {
    const { groups, hidden } = pageGroups([['a', [1, 2, 3]], ['b', [4, 5, 6]], ['c', [7]]], 4);
    expect(groups).toEqual([['a', [1, 2, 3]], ['b', [4]]]);
    expect(hidden).toBe(3);
  });

  it('keeps everything under the limit', () => {
    expect(pageGroups([['a', [1, 2]]], 50)).toEqual({ groups: [['a', [1, 2]]], hidden: 0 });
  });
});

describe('showMoreLabel', () => {
  it('names the next page out of the rest', () => {
    expect(showMoreLabel(350)).toBe('Show 50 more of 350');
    expect(showMoreLabel(12)).toBe('Show 12 more');
  });
});
