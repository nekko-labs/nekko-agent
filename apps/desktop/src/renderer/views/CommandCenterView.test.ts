import { describe, expect, it, vi } from 'vitest';
vi.mock('../store.js', () => ({ useStore: Object.assign(() => ({}), { getState: () => ({}) }) }));
vi.mock('../components/AgentWindowPicker.js', () => ({ AgentWindowPicker: () => null, AgentWindowDropdown: () => null, defaultFolderIds: () => [] }));
vi.mock('../components/InsightsBox.js', () => ({}));
vi.mock('../components/CommandWall.js', () => ({ CommandWall: () => null, TerminalExcerpt: () => null }));
vi.mock('../components/WallComposer.js', () => ({ WallComposer: () => null }));
vi.mock('../components/MonitorsDock.js', () => ({ MonitorsDock: () => null }));
vi.mock('../chrome.js', () => ({ hasAppChrome: false }));
import React, { useState } from 'react';
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>();
  return { ...actual, useState: vi.fn(), useRef: () => ({ current: null }), useEffect: vi.fn() };
});
import { wallLayoutShortcut, WallToolbar } from './CommandCenterView.js';
import { DEFAULT_WALL_STATE } from '../commandWall.js';
import { AgentWindowDropdown } from '../components/AgentWindowPicker.js';
import { readFileSync } from 'node:fs';

it.each(['focus', 'grid', 'fixed'] as const)('direct creation replaces More without changing the %s layout', (mode) => {
  vi.mocked(useState).mockReturnValueOnce([null, vi.fn()]);
  const setWall = vi.fn(); const setAddOpen = vi.fn();
  const tree = WallToolbar({ wall: { ...DEFAULT_WALL_STATE, layout: { ...DEFAULT_WALL_STATE.layout, mode: mode === 'fixed' ? 'grid' as const : mode, fixedGrid: mode === 'fixed' } }, setWall, setAddOpen, addOpen: false, onAdd: vi.fn() });
  const elements: React.ReactElement<Record<string, any>>[] = [];
  const walk = (node: React.ReactNode) => React.Children.forEach(node, (child) => {
    if (!React.isValidElement<Record<string, any>>(child)) return;
    elements.push(child); walk(child.props.children);
  });
  walk(tree);
  expect(elements.some((e) => e.props['aria-label'] === 'Add window')).toBe(false);
  for (const label of ['New agent', 'New image session', 'New terminal']) {
    const button = elements.find((e) => e.props['aria-label'] === label)!;
    expect(button).toBeDefined();
    button.props.onClick();
  }
  expect(setAddOpen).not.toHaveBeenCalled();
  expect(setWall).not.toHaveBeenCalled();
});

it('hosts the detailed picker in the toolbar rather than a wall tile', () => {
  vi.mocked(useState).mockReturnValueOnce([null, vi.fn()]);
  const tree = WallToolbar({ wall: DEFAULT_WALL_STATE, setWall: vi.fn(), setAddOpen: vi.fn(), addOpen: true, onAdd: vi.fn(), onPick: vi.fn() });
  const elements: React.ReactElement<Record<string, any>>[] = [];
  const walk = (node: React.ReactNode) => React.Children.forEach(node, (child) => {
    if (!React.isValidElement<Record<string, any>>(child)) return;
    elements.push(child); walk(child.props.children);
  });
  walk(tree);
  // Open, the picker hangs off the toolbar's New terminal button.
  const picker = elements.find((e) => e.type === AgentWindowDropdown);
  expect(picker).toBeDefined();
  const terminal = elements.find((e) => e.props['aria-label'] === 'New terminal')!;
  expect(picker!.props.anchorRef).toBe(terminal.props.ref ?? (terminal as unknown as { ref: unknown }).ref);
  // That the page never hands the wall an add tile is rendered in newAgentSetup.test.ts.
});

// Source pin, pending the wall e2e journey: the title-bar slot is found by a
// MutationObserver in an effect, which needs a DOM to run.
it('watches only the title-bar slot\'s ancestors, never the whole body subtree (source pin)', () => {
  const view = readFileSync(new URL('./CommandCenterView.tsx', import.meta.url), 'utf8');
  expect(view).not.toMatch(/observer\.observe\(document\.body, \{ childList: true, subtree: true \}\)/);
  expect(view).toMatch(/observer\.observe\(ancestor, \{ childList: true \}\)/);
});

const key = { code: 'Digit1', key: '!', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, repeat: false, isComposing: false, defaultPrevented: false };
describe('agent board layout shortcuts', () => {
  it.each([['Digit1', '!', 'focus'], ['Digit2', '@', 'grid']])('maps shifted %s to %s', (code, value, mode) => {
    expect(wallLayoutShortcut({ ...key, code, key: value })).toBe(mode);
    expect(wallLayoutShortcut({ ...key, code, key: value, ctrlKey: false, metaKey: true })).toBe(mode);
  });
  it.each([{ shiftKey: false }, { altKey: true }, { repeat: true }, { isComposing: true }, { defaultPrevented: true }, { metaKey: true }, { ctrlKey: false }, { code: 'Digit3', key: '#' }, { code: 'Digit4', key: '$' }])('ignores unsupported modifiers and events %j', (patch) => {
    expect(wallLayoutShortcut({ ...key, ...patch })).toBeNull();
  });
  it('supports synthetic digit keys but never steals unshifted agent selection', () => {
    expect(wallLayoutShortcut({ ...key, code: '', key: '2' })).toBe('grid');
    expect(wallLayoutShortcut({ ...key, key: '1', shiftKey: false })).toBeNull();
  });
});
