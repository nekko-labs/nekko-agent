import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmDeletion } from './DeleteConfirmation.js';

const state = vi.hoisted(() => ({ settings: { skipDeleteConfirmation: false, showTips: false }, pushToast: vi.fn() }));
const render = vi.hoisted(() => vi.fn());
vi.mock('../store.js', () => ({ useStore: { getState: () => state, setState: vi.fn() } }));
vi.mock('react-dom/client', () => ({ createRoot: () => ({ render, unmount: vi.fn() }) }));
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), useState: vi.fn() }));

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); state.settings.skipDeleteConfirmation = false; });
function dialog(skip = false) {
  vi.stubGlobal('HTMLElement', class {});
  const remove = vi.fn();
  vi.stubGlobal('document', { createElement: () => ({ remove }), body: { appendChild: vi.fn() }, activeElement: null });
  const updateSettings = vi.fn().mockResolvedValue({ ...state.settings, skipDeleteConfirmation: true });
  vi.stubGlobal('window', { nekko: { updateSettings } });
  vi.mocked(useState).mockReturnValueOnce([skip, vi.fn()]).mockReturnValueOnce([false, vi.fn()]);
  const result = confirmDeletion('Delete this chat?');
  const rendered = render.mock.calls.at(-1)![0];
  const tree = rendered.type(rendered.props) as React.ReactElement<Record<string, any>>;
  const buttons: React.ReactElement<Record<string, any>>[] = [];
  const walk = (node: React.ReactNode) => React.Children.forEach(node, (child) => {
    if (!React.isValidElement<Record<string, any>>(child)) return;
    if (child.type === 'button') buttons.push(child);
    walk(child.props.children);
  });
  walk(tree);
  return { result, tree, buttons, updateSettings, remove };
}
describe('shared deletion confirmation', () => {
  it('still asks with Show tips off, and cancellation does not persist opt-out', async () => {
    const d = dialog(true);
    d.buttons[0].props.onClick();
    expect(await d.result).toBe(false);
    expect(d.updateSettings).not.toHaveBeenCalled();
    expect(d.remove).toHaveBeenCalledOnce();
  });
  it('only persists skipping when explicitly checked and deletion approved', async () => {
    const d = dialog(true);
    await d.buttons[1].props.onClick();
    expect(await d.result).toBe(true);
    expect(d.updateSettings).toHaveBeenCalledExactlyOnceWith({ skipDeleteConfirmation: true });
  });
  it('approval alone does not disable future confirmations', async () => {
    const d = dialog();
    await d.buttons[1].props.onClick();
    expect(await d.result).toBe(true);
    expect(d.updateSettings).not.toHaveBeenCalled();
  });
  it('rejects another deletion while a confirmation is pending', async () => {
    const d = dialog();
    expect(await confirmDeletion('Another deletion')).toBe(false);
    d.tree.props.onClose();
    expect(await d.result).toBe(false);
  });
  it('honors persisted skipping independently of Show tips', async () => {
    state.settings.skipDeleteConfirmation = true;
    expect(await confirmDeletion('Delete')).toBe(true);
    expect(render).not.toHaveBeenCalled();
  });
});
