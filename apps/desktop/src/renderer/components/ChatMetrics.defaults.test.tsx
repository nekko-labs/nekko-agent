import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { EffortSlider } from './ChatMetrics.js';
const store = vi.hoisted(() => ({ settings: { effort: 'normal' }, refreshSettings: vi.fn(async () => {}) }));
// The popover's hooks need a renderer; closed, it is just a ref and a flag.
vi.mock('./ModeViews.js', () => ({ EffortDial: () => null, usePopover: () => ({ open: false, setOpen: vi.fn(), anchor: { current: null }, pop: { current: null }, style: {} }) }));
vi.mock('../store.js', () => ({ useStore: Object.assign((select: (s: typeof store) => unknown) => select(store), { getState: () => store, setState: vi.fn() }) }));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });
it('saves effort globally and refreshes it for other and future windows', async () => {
  const updateSettings = vi.fn(async () => ({}));
  vi.stubGlobal('window', { nekko: { updateSettings } });
  const tree = EffortSlider({ modelId: 'llama3' });
  const nodes: React.ReactElement<Record<string, any>>[] = [];
  const walk = (node: React.ReactNode) => React.Children.forEach(node, (child) => {
    if (React.isValidElement<Record<string, any>>(child)) { nodes.push(child); walk(child.props.children); }
  });
  walk(tree);
  // One step up from Normal, with the arrow key on the dial.
  nodes.find((n) => n.type === 'button')!.props.onKeyDown({ key: 'ArrowRight', preventDefault: () => {} });
  await vi.waitFor(() => expect(store.refreshSettings).toHaveBeenCalledOnce());
  expect(updateSettings).toHaveBeenCalledExactlyOnceWith({ effort: 'high' });
});
