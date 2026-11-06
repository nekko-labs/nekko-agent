import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { allowModeChange, confirmYolo, YOLO_WARNING } from './YoloWarning.js';

const state = vi.hoisted(() => ({ settings: { skipYoloWarning: false }, pushToast: vi.fn() }));
const render = vi.hoisted(() => vi.fn());
vi.mock('../store.js', () => ({ useStore: { getState: () => state, setState: vi.fn() } }));
vi.mock('react-dom/client', () => ({ createRoot: () => ({ render, unmount: vi.fn() }) }));
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), useState: vi.fn() }));

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); state.settings.skipYoloWarning = false; });

/** Open the warning and return its rendered tree and buttons (Keep asking, Turn on YOLO). */
function dialog(skip = false, open: () => Promise<boolean> = confirmYolo) {
  vi.stubGlobal('HTMLElement', class {});
  const remove = vi.fn();
  vi.stubGlobal('document', { createElement: () => ({ remove }), body: { appendChild: vi.fn() }, activeElement: null });
  const updateSettings = vi.fn().mockResolvedValue({ ...state.settings, skipYoloWarning: true });
  vi.stubGlobal('window', { nekko: { updateSettings } });
  vi.mocked(useState).mockReturnValueOnce([skip, vi.fn()]).mockReturnValueOnce([false, vi.fn()]);
  const result = open();
  const rendered = render.mock.calls.at(-1)![0];
  const tree = rendered.type(rendered.props) as React.ReactElement<Record<string, any>>;
  const buttons: React.ReactElement<Record<string, any>>[] = [];
  const texts: string[] = [];
  const walk = (node: React.ReactNode) => React.Children.forEach(node, (child) => {
    if (typeof child === 'string') texts.push(child);
    if (!React.isValidElement<Record<string, any>>(child)) return;
    if (child.type === 'button') buttons.push(child);
    walk(child.props.children);
  });
  walk(tree);
  return { result, tree, buttons, texts, updateSettings, remove };
}

describe('YOLO warning', () => {
  it('says what YOLO lets through: data can leave without anyone asked', () => {
    expect(YOLO_WARNING).toContain('without asking you first');
    expect(YOLO_WARNING).toContain('sending your files or data out of this computer');
  });
  it('does not warn when the next mode is not YOLO, or the chat is already in YOLO', async () => {
    expect(await allowModeChange('guardrails', 'ask')).toBe(true);
    expect(await allowModeChange('yolo', 'yolo')).toBe(true);
    expect(render).not.toHaveBeenCalled();
  });
  it('warns when switching to YOLO, and Keep asking cancels without saving anything', async () => {
    const d = dialog(true, () => allowModeChange('guardrails', 'yolo'));
    expect(d.texts).toContain('Turn on YOLO?');
    d.buttons[0].props.onClick();
    expect(await d.result).toBe(false);
    expect(d.updateSettings).not.toHaveBeenCalled();
    expect(d.remove).toHaveBeenCalledOnce();
  });
  it('turns YOLO on, and saves skipping only when "Don\'t warn me again" is checked', async () => {
    const skipped = dialog(true);
    await skipped.buttons[1].props.onClick();
    expect(await skipped.result).toBe(true);
    expect(skipped.updateSettings).toHaveBeenCalledExactlyOnceWith({ skipYoloWarning: true });
    const once = dialog(false);
    await once.buttons[1].props.onClick();
    expect(await once.result).toBe(true);
    expect(once.updateSettings).not.toHaveBeenCalled();
  });
  it('closing the dialog is a no', async () => {
    const d = dialog();
    d.tree.props.onClose();
    expect(await d.result).toBe(false);
  });
  it('honors a saved choice not to be warned', async () => {
    state.settings.skipYoloWarning = true;
    expect(await allowModeChange('ask', 'yolo')).toBe(true);
    expect(render).not.toHaveBeenCalled();
  });
});
