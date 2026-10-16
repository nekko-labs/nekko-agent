import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatControls } from './ChatControls.js';
import type { Session } from '@nekko-agent/shared';

const store = vi.hoisted(() => ({ settings: { defaultChatMode: 'guardrails', gitManagement: { mode: 'worktree' } }, refreshSettings: vi.fn(async () => {}), pushToast: vi.fn() }));
vi.mock('../store.js', () => ({ useStore: Object.assign((select: (s: typeof store) => unknown) => select(store), { getState: () => store }) }));
vi.mock('./SandboxSetup.js', () => ({ SandboxSetup: () => null, SandboxReview: () => null }));
vi.mock('react-dom', () => ({ createPortal: (node: unknown) => node }));
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>();
  return { ...actual, useState: vi.fn(), useRef: () => ({ current: null }), useEffect: vi.fn(), useLayoutEffect: vi.fn() };
});
const session = { id: 'chat', messages: [], executionMode: 'unified' } as unknown as Session;
beforeEach(() => {
  vi.stubGlobal('document', { body: {} });
  vi.stubGlobal('window', { nekko: { setSessionOptions: vi.fn(async () => session), updateSettings: vi.fn(async () => ({})) } });
});
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });
function controls(toolsInWindow = true) {
  [true, false, '', {}].forEach((v) => vi.mocked(useState).mockReturnValueOnce([v, vi.fn()] as never));
  const onChange = vi.fn();
  const tree = ChatControls({ session, isCloudModel: false, onChange, toolsInWindow });
  const nodes: React.ReactElement<Record<string, any>>[] = [];
  const walk = (node: React.ReactNode) => React.Children.forEach(node, (child) => {
    if (React.isValidElement<Record<string, any>>(child)) { nodes.push(child); walk(child.props.children); }
  });
  walk(tree);
  return { onChange, nodes, mode: (m: string) => nodes.find((n) => n.props['data-chat-mode'] === m)! };
}
describe('new-window control defaults', () => {
  it('saves permission mode only after the session update succeeds', async () => {
    let finish!: (s: Session) => void;
    vi.mocked(window.nekko.setSessionOptions).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = controls();
    view.mode('ask').props.onClick();
    expect(window.nekko.updateSettings).not.toHaveBeenCalled();
    finish({ ...session, mode: 'ask' });
    await vi.waitFor(() => expect(store.refreshSettings).toHaveBeenCalledOnce());
    expect(window.nekko.updateSettings).toHaveBeenCalledExactlyOnceWith({ defaultChatMode: 'ask' });
    expect(view.onChange).toHaveBeenCalledWith(expect.objectContaining({ mode: 'ask' }));
  });
  it.each(['reject', 'missing'])('does not persist a permission change when the session update is %s', async (result) => {
    if (result === 'reject') vi.mocked(window.nekko.setSessionOptions).mockRejectedValue(new Error('unavailable'));
    else vi.mocked(window.nekko.setSessionOptions).mockResolvedValue(null);
    const view = controls();
    view.mode('yolo').props.onClick();
    await vi.waitFor(() => expect(result === 'reject' ? store.pushToast : view.onChange).toHaveBeenCalled());
    expect(window.nekko.updateSettings).not.toHaveBeenCalled();
  });
  it('keeps incognito session-only', async () => {
    const view = controls();
    const toggle = view.nodes.find((n) => n.type === 'button' && n.props.title === "Don't save this chat or update memory")!;
    await toggle.props.onClick();
    expect(window.nekko.setSessionOptions).toHaveBeenCalledWith('chat', { incognito: true });
    expect(window.nekko.updateSettings).not.toHaveBeenCalled();
  });
  it('retains execution default persistence', async () => {
    const view = controls();
    const unified = view.nodes.find((n) => n.props.role === 'menuitemradio' && n.key === 'unified')!;
    await unified.props.onClick();
    await vi.waitFor(() => expect(store.refreshSettings).toHaveBeenCalledOnce());
    expect(window.nekko.updateSettings).toHaveBeenCalledWith({ defaultExecutionMode: 'unified', gitManagement: { mode: 'shared' } });
  });
});

it('keeps offline session-only', async () => {
  const view = controls(false);
  const toggle = view.nodes.find((n) => n.type === 'button' && String(n.props.title).startsWith('No internet:'))!;
  await toggle.props.onClick();
  expect(window.nekko.setSessionOptions).toHaveBeenCalledWith('chat', { offline: true });
  expect(window.nekko.updateSettings).not.toHaveBeenCalled();
});
