import React, { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { PendingInput, SessionSummary } from '@nekko-agent/shared';
import { WorkingSubagents } from './WorkingSubagents.js';
vi.mock('../liveRuns.js', () => ({ useLiveRunsVersion: () => 0 }));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: vi.fn(),
  useRef: () => ({ current: null }),
  useEffect: vi.fn(),
}));
afterEach(() => vi.clearAllMocks());
function elements(node: React.ReactNode): React.ReactElement<Record<string, any>>[] {
  const result: React.ReactElement<Record<string, any>>[] = [];
  React.Children.forEach(node, child => {
    if (React.isValidElement<Record<string, any>>(child)) { result.push(child); result.push(...elements(child.props.children)); }
  });
  return result;
}
it('expands and opens only active children, including orange pending-user status', () => {
  const setExpanded = vi.fn(), onOpen = vi.fn();
  const children = [{id:'active',title:'Run tests'}, {id:'idle',title:'Old child'}] as SessionSummary[];
  const pending = {active:{approval:{}}} as unknown as Record<string, PendingInput>;
  const props = {children,running:new Set(['active']),pending,onOpen};
  vi.mocked(useState).mockReturnValue([false,setExpanded] as never);
  let tree = elements(WorkingSubagents(props));
  tree.find(e=>e.type==='button')!.props.onClick();
  expect(setExpanded).toHaveBeenCalledWith(true);
  vi.mocked(useState).mockReturnValue([true,setExpanded] as never);
  tree = elements(WorkingSubagents(props));
  const buttons=tree.filter(e=>e.type==='button');
  expect(buttons).toHaveLength(2);
  buttons[0].props.onClick();
  expect(onOpen).toHaveBeenCalledWith('active');
  expect(tree.some(e=>e.props.style?.background==='var(--warning)')).toBe(true);
  expect(tree.some(e=>e.props.children==='Old child')).toBe(false);
});
