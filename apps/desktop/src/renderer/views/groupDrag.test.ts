import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { claimDragOver, dragOverClaimed, leftGroup, moveGroupBefore } from './groupDrag.js';

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

  it('lets an inner drop target claim a drag-over for the targets around it, per event', () => {
    const first = { nativeEvent: {} };
    const next = { nativeEvent: {} };
    expect(dragOverClaimed(first)).toBe(false);
    claimDragOver(first);
    // React hands every handler on the way up the same native event.
    expect(dragOverClaimed({ nativeEvent: first.nativeEvent })).toBe(true);
    expect(dragOverClaimed(next)).toBe(false);
  });

  it('never stops a chat group drag-over, so the dragged chip keeps following the pointer', () => {
    // The chip moves from a document-level dragover listener (CommandWall).
    // Stopping the event in a group's drop target froze it over the group.
    const source = readFileSync(new URL('./WorkspacesView.tsx', import.meta.url), 'utf8');
    const start = source.indexOf('const chatGroupDrop = ');
    const over = source.slice(source.indexOf('onDragOver:', start), source.indexOf('onDragLeave:', start));
    expect(start).toBeGreaterThan(-1);
    expect(over).toContain('claimDragOver(e)');
    // Comments may name it; the code must not call it.
    expect(over.replace(/\/\/.*$/gm, '')).not.toContain('stopPropagation');
  });

  it('lets a dragged chat cross the whole Agents list without the no-drop cursor', () => {
    // Gaps between groups and cards are not drop targets of their own; the list
    // accepts the drag there and a drop that no group took just ends it.
    const source = readFileSync(new URL('./WorkspacesView.tsx', import.meta.url), 'utf8');
    const at = source.indexOf('ref={listRef}');
    expect(at).toBeGreaterThan(-1);
    const list = source.slice(at, source.indexOf('\n      >', at));
    expect(list).toContain("onDragOver={(e) => { if (isAgentDrag(e) && !e.defaultPrevented) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } }}");
    expect(list).toContain('onDrop={(e) => { if (!isAgentDrag(e)) return; e.preventDefault(); endDrag(); endAgentDrag(); }}');
  });
});

