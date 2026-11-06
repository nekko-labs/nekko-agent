import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { EffortSlider } from './ChatMetrics.js';
const store = vi.hoisted(() => ({ settings: { effort: 'normal' }, refreshSettings: vi.fn(async () => {}) }));
const popover = vi.hoisted(() => ({ open: false }));
vi.mock('./ModeViews.js', () => ({ EffortDial: () => null, usePopover: () => ({ open: popover.open, setOpen: vi.fn(), anchor: { current: null }, pop: { current: null }, style: {} }) }));
vi.mock('react-dom', () => ({ createPortal: (node: unknown) => node }));
vi.mock('../store.js', () => ({ useStore: Object.assign((select: (s: typeof store) => unknown) => select(store), { getState: () => store, setState: vi.fn() }) }));
afterEach(() => { popover.open = false; vi.clearAllMocks(); vi.unstubAllGlobals(); });
const nodesOf = (tree: React.ReactNode) => {
  const nodes: React.ReactElement<Record<string, any>>[] = [];
  const walk = (node: React.ReactNode) => React.Children.forEach(node, (child) => {
    if (React.isValidElement<Record<string, any>>(child)) { nodes.push(child); walk(child.props.children); }
  });
  walk(tree);
  return nodes;
};
const metadata = { levels: [{ effort: 'low' }, { effort: 'high', description: 'More thinking' }], default: 'low' };
it('saves effort globally and refreshes it for other and future windows', async () => {
  const updateSettings = vi.fn(async () => ({}));
  vi.stubGlobal('window', { nekko: { updateSettings } });
  const nodes = nodesOf(EffortSlider({ modelId: 'llama3', metadata }));
  nodes.find((n) => n.type === 'button')!.props.onKeyDown({ key: 'ArrowRight', preventDefault: () => {} });
  await vi.waitFor(() => expect(store.refreshSettings).toHaveBeenCalledOnce());
  expect(updateSettings).toHaveBeenCalledExactlyOnceWith({ effort: 'high' });
});
it('uses a range with provider stops and persists a future level on the chat and globally', async () => {
  popover.open = true;
  vi.stubGlobal('document', { body: {} });
  const session = { id: 'chat', effort: 'low' };
  const setSessionOptions = vi.fn(async () => ({ ...session, effort: 'future-level' }));
  const updateSettings = vi.fn(async () => ({}));
  const onSessionChange = vi.fn();
  vi.stubGlobal('window', { nekko: { setSessionOptions, updateSettings } });
  const nodes = nodesOf(EffortSlider({ modelId: 'new-model', session, onSessionChange, metadata: { levels: [{ effort: 'low' }, { effort: 'future-level' }], default: 'low' } }));
  const range = nodes.find((n) => n.type === 'input' && n.props.type === 'range')!;
  expect(range.props).toMatchObject({ min: 0, max: 1, step: 1, value: 0 });
  expect(nodes.some((n) => n.props.role === 'radio')).toBe(false);
  range.props.onChange({ currentTarget: { value: '1' } });
  await vi.waitFor(() => expect(store.refreshSettings).toHaveBeenCalledOnce());
  expect(setSessionOptions).toHaveBeenCalledExactlyOnceWith('chat', { effort: 'future-level' });
  expect(updateSettings).toHaveBeenCalledExactlyOnceWith({ effort: 'future-level' });
  expect(onSessionChange).toHaveBeenCalledExactlyOnceWith({ ...session, effort: 'future-level' });
});
it('leaves legacy saved effort untouched when choices are unavailable', () => {
  const updateSettings = vi.fn();
  vi.stubGlobal('window', { nekko: { updateSettings } });
  const nodes = nodesOf(EffortSlider({ modelId: 'gpt-5' }));
  const button = nodes.find((n) => n.type === 'button')!;
  expect(button.props.disabled).toBe(true);
  button.props.onKeyDown({ key: 'ArrowRight', preventDefault: () => {} });
  expect(updateSettings).not.toHaveBeenCalled();
});
