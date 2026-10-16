import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { EffortSlider } from './ChatMetrics.js';
const store = vi.hoisted(() => ({ settings: { effort: 'normal' }, refreshSettings: vi.fn(async () => {}) }));
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
  nodes.find((n) => n.type === 'input')!.props.onChange({ target: { value: '2' } });
  await vi.waitFor(() => expect(store.refreshSettings).toHaveBeenCalledOnce());
  expect(updateSettings).toHaveBeenCalledExactlyOnceWith({ effort: 'high' });
});
