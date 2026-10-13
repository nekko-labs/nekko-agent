import { describe, expect, it } from 'vitest';
import { leftGroup, moveGroupBefore } from './groupDrag.js';

describe('group dragging', () => {
  it('moves either direction and to the end without losing groups', () => {
    expect(moveGroupBefore(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
    expect(moveGroupBefore(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'a', 'c']);
    expect(moveGroupBefore(['a', 'b', 'c'], 'a', null)).toEqual(['b', 'c', 'a']);
  });
  it('ignores self and stale drops', () => {
    const ids = ['a', 'b', 'c'];
    expect(moveGroupBefore(ids, 'b', 'b')).toBe(ids);
    expect(moveGroupBefore(ids, 'missing', 'b')).toBe(ids);
    expect(moveGroupBefore(ids, 'a', 'missing')).toBe(ids);
  });
  it('keeps hover when crossing descendants and clears it outside', () => {
    const child = {} as Node;
    const outside = {} as Node;
    const group = { contains: (node: Node) => node === child } as HTMLElement;
    expect(leftGroup(group, child)).toBe(false);
    expect(leftGroup(group, outside)).toBe(true);
    expect(leftGroup(group, null)).toBe(true);
  });
});
