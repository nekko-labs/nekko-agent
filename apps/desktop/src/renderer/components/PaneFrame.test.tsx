import React, { useState } from 'react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { PaneFrame, targetAt } from './PaneFrame.js';
import { ContextAction, ContextMenu } from './ContextMenu.js';
import { confirmDeletion } from './DeleteConfirmation.js';
import { CloseIcon, TrashIcon } from '../icons.js';

const state = vi.hoisted(() => ({
  settings: null as { chatPaneAction?: 'complete' | 'delete' } | null,
  archiveChat: vi.fn(),
  deleteChatForever: vi.fn(),
}));
vi.mock('../store.js', () => ({ useStore: Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => ({ refreshTerminals: vi.fn(), pushToast: vi.fn() }) }) }));
vi.mock('./DeleteConfirmation.js', () => ({ confirmDeletion: vi.fn().mockResolvedValue(false) }));
vi.mock('../window-shortcuts.js', async (original) => ({ ...await original<typeof import('../window-shortcuts.js')>(), registerWindow: vi.fn(), focusWindow: vi.fn() }));
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>();
  return { ...actual, useState: vi.fn(actual.useState), useRef: () => ({ current: null }), useEffect: vi.fn() };
});

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); state.settings = null; });

/** Inspect frame elements and invoke their actual event handlers without a DOM. */
function frame(kind: 'chat' | 'terminal' = 'chat', menu = false, refId = 'session-1', onMinimize?: () => void) {
  vi.mocked(useState).mockImplementation((initial?: unknown) => [initial, vi.fn()] as never);
  vi.mocked(useState).mockReturnValueOnce([null, vi.fn()]);
  vi.mocked(useState).mockReturnValueOnce([menu ? { x: 10, y: 20 } : null, vi.fn()]);
  const onClose = vi.fn();
  const tree = PaneFrame({
    pane: { id: 'pane-1', kind, refId }, title: 'My chat', icon: null,
    isActive: true, dragging: null, canSplit: () => true, onSplit: vi.fn(),
    onClose, onMinimize, onFocus: vi.fn(), onDragStart: vi.fn(), onDragEnd: vi.fn(), onDrop: vi.fn(), children: null,
  });
  const elements: React.ReactElement<Record<string, any>>[] = [];
  const walk = (node: React.ReactNode) => {
    React.Children.forEach(node, (child) => {
      if (!React.isValidElement<Record<string, any>>(child)) return;
      elements.push(child);
      walk(child.props.children);
    });
  };
  walk(tree);
  return { elements, onClose, button: elements.find((e) => e.type === 'button')! };
}

describe('pane lifecycle controls', () => {
  it.each([false, true])('only closes a terminal process after confirmation (%s)', async (approved) => {
    vi.mocked(confirmDeletion).mockResolvedValueOnce(approved);
    const closeTerminal = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('window', { nekko: { closeTerminal } });
    const { button, onClose } = frame('terminal', false, 'terminal-1');
    await button.props.onClick();
    expect(confirmDeletion).toHaveBeenCalledWith(expect.stringContaining('no terminal archive'));
    expect(closeTerminal).toHaveBeenCalledTimes(approved ? 1 : 0);
    expect(onClose).toHaveBeenCalledTimes(approved ? 1 : 0);
    if (approved) expect(closeTerminal).toHaveBeenCalledWith('terminal-1');
  });

  it('places wall minimize immediately before Complete without archiving or deleting', () => {
    const minimize = vi.fn();
    const { elements } = frame('chat', false, 'session-1', minimize);
    const buttons = elements.filter((e) => e.type === 'button');
    expect(buttons.map((e) => e.props['aria-label'])).toEqual(['Minimize My chat', 'Complete My chat']);
    buttons[0].props.onClick();
    expect(minimize).toHaveBeenCalledOnce();
    expect(state.archiveChat).not.toHaveBeenCalled();
    expect(state.deleteChatForever).not.toHaveBeenCalled();
  });

  it('exposes board-only minimize on terminal windows', () => {
    const minimize = vi.fn();
    const closeTerminal = vi.fn();
    vi.stubGlobal('window', { nekko: { closeTerminal } });
    const { elements } = frame('terminal', false, 'terminal-1', minimize);
    elements.find((e) => e.props['aria-label'] === 'Minimize My chat')!.props.onClick();
    expect(minimize).toHaveBeenCalledOnce();
    expect(closeTerminal).not.toHaveBeenCalled();
  });
  it('defaults chats to Complete using existing archive semantics, not Close', () => {
    const { button, onClose } = frame();
    expect(button.props['aria-label']).toBe('Complete My chat');
    expect(button.props.title).toBe('Complete this chat (Ctrl+Shift+E)');
    // The completion control wears an X now (#533); it still archives, never deletes.
    expect(React.Children.toArray(button.props.children).some((c) => React.isValidElement(c) && c.type === CloseIcon)).toBe(true);
    button.props.onClick();
    expect(state.archiveChat).toHaveBeenCalledWith('session-1');
    expect(onClose).not.toHaveBeenCalled();
    expect(state.deleteChatForever).not.toHaveBeenCalled();
  });

  it('routes Delete through the shared store confirmation', () => {
    state.settings = { chatPaneAction: 'delete' };
    const { button } = frame();
    expect(React.Children.toArray(button.props.children).some((c) => React.isValidElement(c) && c.type === TrashIcon)).toBe(true);
    button.props.onClick();
    expect(state.deleteChatForever).toHaveBeenCalledWith('session-1');
    expect(state.archiveChat).not.toHaveBeenCalled();
  });

  it('opens the title-bar menu without bubbling to parent menus', () => {
    const { elements } = frame();
    const strip = elements.find((e) => e.props.draggable)!;
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn(), clientX: 30, clientY: 40 };
    strip.props.onContextMenu(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(vi.mocked(useState).mock.results[1].value[1]).toHaveBeenCalledWith({ x: 30, y: 40 });
  });

  it.each([['chat', '']] as const)('keeps Close for %s panes with ref %s', (kind, refId) => {
    state.settings = { chatPaneAction: 'delete' };
    const { button, elements, onClose } = frame(kind, true, refId);
    expect(button.props['aria-label']).toBe('Close My chat');
    button.props.onClick();
    expect(onClose).toHaveBeenCalledOnce();
    expect(elements.filter((e) => e.type === ContextAction).map((e) => e.props.children)).toEqual(['Close']);
    expect(state.archiveChat).not.toHaveBeenCalled();
    expect(state.deleteChatForever).not.toHaveBeenCalled();
  });
});

/** A 200×100 window at the origin, the shape most drops land on. */
const rect = { left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0 } as DOMRect;

describe('targetAt', () => {
  it('reads the nearest edge, so each corner belongs to its shorter side', () => {
    expect(targetAt(rect, 5, 50)).toBe('left');
    expect(targetAt(rect, 195, 50)).toBe('right');
    expect(targetAt(rect, 100, 5)).toBe('up');
    expect(targetAt(rect, 100, 95)).toBe('down');
  });

  it('splits the edges into four triangles rather than four bands', () => {
    // Nearer the top than the left in *fractions* of the window, even though
    // the top is further away in pixels: a wide window's bands are wide too.
    expect(targetAt(rect, 30, 10)).toBe('up');
    expect(targetAt(rect, 10, 30)).toBe('left');
  });

  it('offers a swap in the middle, which no edge could express', () => {
    // Dropping a window on the left edge of the neighbour already to its right
    // reproduces the order it was in, so "put these two the other way round"
    // needs a target of its own rather than an edge.
    expect(targetAt(rect, 100, 50)).toBe('swap');
  });

  it('keeps the edges reachable from anywhere near them', () => {
    // The swap zone is generous, but every edge stays a short move away: a
    // pointer a tenth of the way in still means the edge it is nearest.
    expect(targetAt(rect, 20, 50)).toBe('left');
    expect(targetAt(rect, 180, 50)).toBe('right');
    expect(targetAt(rect, 100, 10)).toBe('up');
    expect(targetAt(rect, 100, 90)).toBe('down');
  });

  it('survives a window that has been measured at zero size', () => {
    const empty = { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0 } as DOMRect;
    expect(['up', 'down', 'left', 'right', 'swap']).toContain(targetAt(empty, 0, 0));
  });
});
