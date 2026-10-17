import { afterEach, describe, expect, it, vi } from 'vitest';
import { IpcChannels, IpcEvents } from '@nekko-agent/shared';
import { notificationLink, startMainNotifications } from './notifications.js';

class Socket {
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (e: { data: string }) => void;
  close = vi.fn();
  event(payload: unknown) { this.onmessage?.({ data: JSON.stringify({ channel: IpcEvents.agentEvent, payload }) }); }
  workflows(payload: unknown) { this.onmessage?.({ data: JSON.stringify({ channel: IpcEvents.workflowsUpdated, payload }) }); }
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const done = { type: 'done', sessionId: 'a', messageId: 'm' };
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(off => off()); vi.useRealTimers(); });

type Context = () => { windowHidden: boolean; visibleSessionId: string | null; visibleView?: string | null };
function setup(context: Context = () => ({ windowHidden: true, visibleSessionId: null })) {
  vi.useFakeTimers();
  let enabled: boolean | undefined;
  const endpoint = vi.fn().mockResolvedValue({ url: 'http://127.0.0.1:123', token: 'a b', mode: 'backend' });
  const call = vi.fn(async (channel: string) => channel === IpcChannels.settingsGet ? { desktopNotifications: enabled } : { title: 'Parser' });
  const sockets: Socket[] = [];
  const urls: string[] = [];
  const post = vi.fn();
  cleanups.push(startMainNotifications({ endpoint, call: call as any }, post, url => {
    urls.push(url);
    const socket = new Socket(); sockets.push(socket);
    return socket as unknown as WebSocket;
  }, context));
  return { endpoint, call, sockets, urls, post, enable: (value: boolean | undefined) => { enabled = value; } };
}

describe('main desktop notifications', () => {
  it('subscribes directly with token, defaults on and deduplicates without any renderer', async () => {
    const s = setup(); await flush();
    expect(s.urls).toEqual(['ws://127.0.0.1:123/api/ws?sessions=&token=a%20b']);
    s.sockets[0].onopen?.();
    s.sockets[0].event(done); s.sockets[0].event(done); await flush();
    expect(s.post).toHaveBeenCalledTimes(1);
    expect(s.post).toHaveBeenCalledWith(expect.objectContaining({ kind: 'finished', body: 'Parser' }));
    await vi.advanceTimersByTimeAsync(5000);
    s.sockets[0].event(done); await flush();
    expect(s.post).toHaveBeenCalledTimes(2);
  });

  it('reads current opt-out, suppresses stops/relay events and posts errors/questions/approvals', async () => {
    const s = setup(); await flush(); s.sockets[0].onopen?.();
    s.enable(false); s.sockets[0].event(done); await flush(); expect(s.post).not.toHaveBeenCalled();
    s.enable(true);
    for (const message of ['Stopped', 'Aborted', 'This operation was aborted']) s.sockets[0].event({ type: 'error', sessionId: 'a', message });
    s.sockets[0].event({ ...done, relayOnly: true }); await flush();
    expect(s.call).toHaveBeenCalledTimes(1);
    s.sockets[0].event({ type: 'error', sessionId: 'a', message: 'Failed' });
    s.sockets[0].event({ type: 'question', sessionId: 'a', request: { callId: 'c', askedAt: 0, questions: [{ id: 'q', header: '', question: 'Which branch?', options: [] }] } });
    s.sockets[0].event({ type: 'tool_approval_required', sessionId: 'a', call: { id: 'c', name: 'bash', input: {} }, reason: 'Deletes files' });
    await flush();
    expect(s.post.mock.calls.map(([notice]) => notice.kind)).toEqual(['failed', 'question', 'approval']);
  });

  it('re-resolves endpoints on close/error and retries when the service is stopped', async () => {
    const s = setup(); await flush(); s.sockets[0].onopen?.();
    s.endpoint.mockRejectedValueOnce(new Error('stopped'));
    s.sockets[0].onerror?.(); s.sockets[0].onclose?.();
    await vi.advanceTimersByTimeAsync(250);
    s.endpoint.mockResolvedValue({ url: 'http://127.0.0.1:456', token: 'new', mode: 'daemon' });
    await vi.advanceTimersByTimeAsync(500);
    expect(s.urls[1]).toBe('ws://127.0.0.1:456/api/ws?sessions=&token=new');
    expect(s.endpoint).toHaveBeenCalledTimes(3);
    // Late frames on a dead socket cannot create notices.
    s.sockets[0].event(done); await flush(); expect(s.post).not.toHaveBeenCalled();
  });

  it('times out stalled handshakes and cancels retries/late events on quit', async () => {
    const s = setup(); await flush();
    await vi.advanceTimersByTimeAsync(10250);
    expect(s.sockets).toHaveLength(2);
    cleanups.pop()!();
    s.sockets[1].event(done); s.sockets[1].onclose?.();
    await vi.advanceTimersByTimeAsync(30000);
    expect(s.sockets).toHaveLength(2);
    expect(s.post).not.toHaveBeenCalled();
    expect(s.sockets[1].close).toHaveBeenCalled();
  });

  it('fails closed if settings cannot be read, and tolerates a deleted session', async () => {
    const s = setup(); await flush(); s.sockets[0].onopen?.();
    s.call.mockRejectedValueOnce(new Error('offline'));
    s.sockets[0].event(done); await flush(); expect(s.post).not.toHaveBeenCalled();
    s.call.mockImplementation(async channel => { if (channel === IpcChannels.settingsGet) return {} as any; throw new Error('deleted'); });
    s.sockets[0].event(done); await flush();
    expect(s.post).toHaveBeenCalledWith(expect.objectContaining({ body: 'A chat' }));
  });

  it('suppresses only the currently visible focused session and does not dedupe suppressed notices', async () => {
    let context = { windowHidden: false, visibleSessionId: 'a' as string | null };
    const s = setup(() => context); await flush(); s.sockets[0].onopen?.();
    s.sockets[0].event(done); await flush(); expect(s.post).not.toHaveBeenCalled();
    context = { windowHidden: false, visibleSessionId: 'b' };
    s.sockets[0].event(done); await flush(); expect(s.post).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    context = { windowHidden: true, visibleSessionId: 'a' };
    s.sockets[0].event(done); await flush(); expect(s.post).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    context = { windowHidden: false, visibleSessionId: null };
    s.sockets[0].event(done); await flush(); expect(s.post).toHaveBeenCalledTimes(3);
  });

  it('encodes session IDs for click delivery', () => {
    expect(notificationLink('a/b ?')).toBe('nekko-agent://session/open?id=a%2Fb%20%3F');
  });

  it('tells each finished workflow run once, from the workflows snapshot', async () => {
    const s = setup(); await flush(); s.sockets[0].onopen?.();
    const started = Date.now();
    const wf = { id: 'w', name: 'Digest', notify: 'failure', steps: [{ id: 'a', name: 'Lint', kind: 'shell', run: 'x' }] };
    const old = { id: 'r0', workflowId: 'w', status: 'failure', triggerKind: 'schedule', startedAt: 1, endedAt: started - 1, steps: [] };
    const live = { id: 'r1', workflowId: 'w', status: 'running', triggerKind: 'schedule', startedAt: started, steps: [] };
    s.sockets[0].workflows({ workflows: [wf], runs: [live, old] }); await flush();
    expect(s.post).not.toHaveBeenCalled();
    const failed = { ...live, status: 'failure', endedAt: started + 5, steps: [{ stepId: 'a', status: 'failure', attempt: 1, startedAt: started, error: 'exit 1' }] };
    s.sockets[0].workflows({ workflows: [wf], runs: [failed, old] });
    s.sockets[0].workflows({ workflows: [wf], runs: [failed, old] }); await flush();
    expect(s.post).toHaveBeenCalledTimes(1);
    expect(s.post).toHaveBeenCalledWith(expect.objectContaining({ kind: 'run-failed', title: 'Digest failed', link: 'nekko-agent://workflow/run?workflow=w&run=r1' }));
  });

  it('keeps workflow run notices quiet on the Workflows view and when notifications are off', async () => {
    let view: string | null = 'workflows';
    const s = setup(() => ({ windowHidden: false, visibleSessionId: null, visibleView: view })); await flush(); s.sockets[0].onopen?.();
    const wf = { id: 'w', name: 'Digest', steps: [] };
    const run = (id: string) => ({ id, workflowId: 'w', status: 'failure', triggerKind: 'schedule', startedAt: Date.now(), endedAt: Date.now() + 1, steps: [], message: 'boom' });
    s.sockets[0].workflows({ workflows: [wf], runs: [run('r1')] }); await flush();
    view = 'chat'; s.enable(false);
    s.sockets[0].workflows({ workflows: [wf], runs: [run('r2')] }); await flush();
    expect(s.post).not.toHaveBeenCalled();
    s.enable(true);
    s.sockets[0].workflows({ workflows: [wf], runs: [run('r3')] }); await flush();
    expect(s.post).toHaveBeenCalledWith(expect.objectContaining({ title: 'Digest failed', body: 'boom' }));
  });
});
