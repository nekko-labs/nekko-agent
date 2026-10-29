import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@nekko-agent/shared';

const state = vi.hoisted(() => ({ view: 'command', activeSessionId: 'a', setActiveSession: vi.fn(), setView: vi.fn(), openChatPane: vi.fn() }));
const storeSubscription = vi.hoisted(() => ({ subscribe: vi.fn((_listener: (next: any, previous: any) => void) => vi.fn()) }));
vi.mock('./store.js', () => ({ useStore: { getState: () => state, subscribe: storeSubscription.subscribe } }));

const { decideNotification } = await import('./notifications.js');

const ctx = (over: Partial<Parameters<typeof decideNotification>[1]> = {}) => ({
  enabled: true,
  windowHidden: true,
  visibleSessionId: null,
  titleOf: (id: string) => (id === 'a' ? 'Fix the parser' : undefined),
  ...over,
});

const done: AgentEvent = { type: 'done', sessionId: 'a', messageId: 'm' };

describe('decideNotification', () => {
  it('tells about a finished, failed, asking or approval-seeking chat the user is not looking at', () => {
    expect(decideNotification(done, ctx())).toMatchObject({ kind: 'finished', title: 'Reply finished', body: 'Fix the parser' });
    expect(decideNotification({ type: 'error', sessionId: 'a', message: 'anthropic 529: overloaded' }, ctx())).toMatchObject({ kind: 'failed', body: 'Fix the parser: anthropic 529: overloaded' });
    expect(decideNotification({ type: 'question', sessionId: 'a', request: { callId: 'c', askedAt: 0, questions: [{ id: 'q', header: 'Branch', question: 'Which branch?', options: [] }] } }, ctx())).toMatchObject({ kind: 'question', body: 'Fix the parser: Which branch?' });
    expect(decideNotification({ type: 'tool_approval_required', sessionId: 'b', call: { id: 'c', name: 'bash', input: {} }, reason: 'Deletes files', severity: 'high' }, ctx())).toMatchObject({ kind: 'approval', body: 'A chat: Deletes files' });
  });

  it('stays quiet for the chat on screen in a focused window, for Stop, for bookkeeping events, and when switched off', () => {
    expect(decideNotification(done, ctx({ windowHidden: false, visibleSessionId: 'a' }))).toBeNull();
    // Another chat on screen: this one still gets a notice.
    expect(decideNotification(done, ctx({ windowHidden: false, visibleSessionId: 'b' }))).not.toBeNull();
    // The chat is on screen but the window is behind another app: notice.
    expect(decideNotification(done, ctx({ windowHidden: true, visibleSessionId: 'a' }))).not.toBeNull();
    expect(decideNotification({ type: 'error', sessionId: 'a', message: 'Stopped' }, ctx())).toBeNull();
    expect(decideNotification({ type: 'text', sessionId: 'a', delta: 'x' }, ctx())).toBeNull();
    expect(decideNotification({ type: 'tool_result', sessionId: 'a', result: { toolCallId: 'c', output: '' } }, ctx())).toBeNull();
    expect(decideNotification(done, ctx({ enabled: false }))).toBeNull();
    expect(decideNotification({ ...done, relayOnly: true } as unknown as AgentEvent, ctx())).toBeNull();
  });
});


describe('notification transport', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('uses the safe desktop marker without browser notices', async () => {
    const { startDesktopNotifications, notificationSessionId } = await import('./notifications.js');
    const off = vi.fn();
    const subscribe = vi.fn((_cb: (url: string) => void) => off);
    const browser = vi.fn();
    vi.stubGlobal('Notification', browser);
    const reportNotificationVisibility = vi.fn();
    vi.stubGlobal('window', { nekkoChrome: { platform: 'win32', reportNotificationVisibility }, nekko: { onDeepLink: subscribe, onAgentEvent: vi.fn() } });
    const dispose = startDesktopNotifications();
    expect(reportNotificationVisibility).toHaveBeenCalledExactlyOnceWith({ view: 'command', activeSessionId: 'a' });
    const storeListener = storeSubscription.subscribe.mock.calls.at(-1)?.[0] as unknown as (next: unknown, previous: unknown) => void;
    storeListener({ view: 'wall', activeSessionId: 'a' }, { view: 'command', activeSessionId: 'a' });
    expect(reportNotificationVisibility).toHaveBeenCalledTimes(2);
    storeListener({ view: 'wall', activeSessionId: 'a' }, { view: 'wall', activeSessionId: 'a' });
    expect(reportNotificationVisibility).toHaveBeenCalledTimes(2);
    dispose();
    expect(off).toHaveBeenCalledOnce();
    expect(storeSubscription.subscribe.mock.results.at(-1)?.value).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();
    expect(browser).not.toHaveBeenCalled();
    const listener = subscribe.mock.calls[0][0] as unknown as (url: string) => void;
    listener('nekko-agent://session/open?id=session-a');
    expect(state.setActiveSession).toHaveBeenCalledWith('session-a');
    expect(state.setView).toHaveBeenCalledWith('command');
    expect(state.openChatPane).toHaveBeenCalledWith('session-a');
    expect(notificationSessionId('nekko-agent://session/open?id=a%2Fb%20%3F')).toBe('a/b ?');
    for (const url of ['invalid', 'https://session/open?id=a', 'nekko-agent://chat/new', 'nekko-agent://session/open']) expect(notificationSessionId(url)).toBeNull();
  });
  it('keeps the web event subscription when the desktop marker is absent', async () => {
    const { startDesktopNotifications } = await import('./notifications.js');
    const off = vi.fn();
    const onAgentEvent = vi.fn(() => off);
    const offRuns = vi.fn();
    const onWorkflowsUpdated = vi.fn(() => offRuns);
    vi.stubGlobal('Notification', vi.fn());
    vi.stubGlobal('window', { nekko: { onAgentEvent, onWorkflowsUpdated } });
    const dispose = startDesktopNotifications();
    expect(onAgentEvent).toHaveBeenCalledOnce();
    expect(onWorkflowsUpdated).toHaveBeenCalledOnce();
    dispose(); expect(off).toHaveBeenCalledOnce(); expect(offRuns).toHaveBeenCalledOnce();
  });
});
