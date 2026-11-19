import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatControls, INCOGNITO_OFF_HINT, SYNC_ON_HINT } from './ChatControls.js';
import type { Session } from '@nekko-agent/shared';

const store = vi.hoisted(() => ({ settings: { defaultChatMode: 'guardrails', gitManagement: { mode: 'worktree' } }, refreshSettings: vi.fn(async () => {}), pushToast: vi.fn() }));
vi.mock('../store.js', () => ({ useStore: Object.assign((select: (s: typeof store) => unknown) => select(store), { getState: () => store }) }));
const sync = vi.hoisted(() => ({ on: false }));
vi.mock('./cloud/useSyncOn.js', () => ({ useSyncOn: () => sync.on }));
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
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); sync.on = false; });
function controls(toolsInWindow = true, chat: Session = session) {
  [true, false, {}].forEach((v) => vi.mocked(useState).mockReturnValueOnce([v, vi.fn()] as never));
  const onChange = vi.fn();
  const tree = ChatControls({ session: chat, isCloudModel: false, onChange, toolsInWindow });
  const nodes: React.ReactElement<Record<string, any>>[] = [];
  const walk = (node: React.ReactNode) => React.Children.forEach(node, (child) => {
    if (React.isValidElement<Record<string, any>>(child)) { nodes.push(child); walk(child.props.children); }
  });
  walk(tree);
  return { onChange, nodes };
}
// Approvals, execution, work mode and saved modes live in the Mode panel: ModePanel.test.tsx.
describe('privacy switches', () => {
  it('keeps incognito session-only', async () => {
    const view = controls();
    const toggle = view.nodes.find((n) => n.type === 'button' && 'data-incognito-toggle' in n.props)!;
    // A warning, not an accent: Incognito is not a good default.
    expect(toggle.props.className).toContain('ctl-toggle-warning');
    expect(toggle.props.title).toBe(INCOGNITO_OFF_HINT);
    await toggle.props.onClick();
    expect(window.nekko.setSessionOptions).toHaveBeenCalledWith('chat', { incognito: true });
    expect(window.nekko.updateSettings).not.toHaveBeenCalled();
  });
});

describe('the Sync switch', () => {
  const syncToggle = (v: ReturnType<typeof controls>) => v.nodes.find((n) => n.type === 'button' && 'data-sync-toggle' in n.props);
  it('only shows while this computer syncs', () => {
    expect(syncToggle(controls())).toBeUndefined();
    sync.on = true;
    expect(syncToggle(controls())).toBeDefined();
  });
  it('is on by default and turning it off keeps the chat on this computer', async () => {
    sync.on = true;
    const toggle = syncToggle(controls())!;
    expect(toggle.props['aria-pressed']).toBe(true);
    expect(toggle.props.title).toBe(SYNC_ON_HINT);
    await toggle.props.onClick();
    expect(window.nekko.setSessionOptions).toHaveBeenCalledWith('chat', { syncOff: true });
  });
  it('turns back on, and never shows on an incognito chat', async () => {
    sync.on = true;
    await syncToggle(controls(true, { ...session, syncOff: true }))!.props.onClick();
    expect(window.nekko.setSessionOptions).toHaveBeenCalledWith('chat', { syncOff: false });
    expect(syncToggle(controls(true, { ...session, incognito: true }))).toBeUndefined();
  });
});

it('keeps offline session-only', async () => {
  const view = controls(false);
  const toggle = view.nodes.find((n) => n.type === 'button' && String(n.props.title).startsWith('No internet:'))!;
  await toggle.props.onClick();
  expect(window.nekko.setSessionOptions).toHaveBeenCalledWith('chat', { offline: true });
  expect(window.nekko.updateSettings).not.toHaveBeenCalled();
});

