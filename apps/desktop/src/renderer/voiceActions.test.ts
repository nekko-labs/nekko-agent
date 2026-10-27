import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingInput, PrInfo, SessionSummary } from '@nekko-agent/shared';

const store = vi.hoisted(() => ({
  state: {} as Record<string, any>,
  listeners: new Set<(s: Record<string, any>) => void>(),
}));
const drafts = vi.hoisted(() => new Map<string, { text: string; images: string[]; videos: string[] }>());
const capture = vi.hoisted(() => ({ onSegment: null as null | ((wav: number[]) => void), tail: [] as number[], stop: vi.fn(), abort: vi.fn() }));
const runs = vi.hoisted(() => ({ running: new Set<string>(), step: '' }));
vi.mock('./store.js', () => ({ useStore: { getState: () => store.state, setState: vi.fn(), subscribe: (fn: (s: Record<string, any>) => void) => { store.listeners.add(fn); return () => { store.listeners.delete(fn); }; } } }));
vi.mock('./composerDrafts.js', () => ({ loadDraft: (id: string) => drafts.get(id) ?? null, saveDraft: (id: string, d: { text: string; images: string[]; videos?: string[] }) => { drafts.set(id, { text: d.text, images: d.images, videos: d.videos ?? [] }); } }));
vi.mock('./liveRuns.js', () => ({ getLiveRun: (id: string) => (runs.running.has(id) ? {} : undefined), describeRun: () => runs.step }));
vi.mock('./components/PrCard.js', () => ({ runPrAction: vi.fn(async () => {}) }));
vi.mock('./displays.js', () => ({ displaysBridge: { go: vi.fn(async () => 'ok') } }));
vi.mock('./voiceCapture.js', () => ({
  startVoiceCapture: vi.fn(async (o: { onSegment: (wav: number[]) => void }) => {
    capture.onSegment = o.onSegment;
    return { stop: capture.stop.mockImplementation(() => capture.tail), abort: capture.abort };
  }),
}));

import { PENDING_TTL_MS, WAKE_CARRY_MS, pickChat, runVoiceIntent, shipAction, statusLine, voiceComposer, voiceListener, type VoiceTarget } from './voiceActions.js';
import { runPrAction } from './components/PrCard.js';
import { startVoiceCapture } from './voiceCapture.js';

const pr = (patch: Partial<PrInfo> = {}): PrInfo => ({ url: 'https://github.com/o/r/pull/7', owner: 'o', repo: 'r', number: 7, title: 'T', state: 'open', isDraft: false, additions: 0, deletions: 0, changedFiles: 0, checks: 'passing', source: 'gh', ...patch });
const question = { sessionId: 's1', question: { callId: 'call1', questions: [{ id: 'q1', header: 'Scope', question: 'Which way?', options: [] }], askedAt: 1 } } as unknown as PendingInput;
const goAheadAnswer = [{ questionId: 'q1', labels: [], note: 'Go ahead and build it.' }];
const chat = (id: string, title: string, patch: Partial<SessionSummary> = {}) => ({ id, title, updatedAt: Number(id.replace(/\D/g, '')) || 0, ...patch }) as SessionSummary;

describe('shipAction', () => {
  it('merges an open PR when no question is waiting, running or not', () => {
    expect(shipAction({ prs: [pr()], running: false })).toBe('merge');
    expect(shipAction({ prs: [pr({ state: 'merged' }), pr()], running: true })).toBe('merge');
  });
  it('asks which when there is an open PR and a question waiting', () => {
    expect(shipAction({ prs: [pr()], running: false, pending: question })).toBe('ask');
  });
  it('tells it to go ahead with no PR when idle or waiting on a question', () => {
    expect(shipAction({ prs: [], running: false })).toBe('go-ahead');
    expect(shipAction({ prs: [], running: true, pending: question })).toBe('go-ahead');
  });
  it('is still working when running with no PR', () => {
    expect(shipAction({ prs: [], running: true })).toBe('still-working');
  });
  it('has nothing to ship when every PR is already merged or closed', () => {
    expect(shipAction({ prs: [pr({ state: 'merged' }), pr({ state: 'closed' })], running: false })).toBe('nothing');
  });
});

describe('pickChat', () => {
  const sessions = [chat('c1', 'Fix login bug'), chat('c2', 'Login page redesign'), chat('c3', 'Billing export'), chat('c4', 'Old login', { archivedAt: 5 } as Partial<SessionSummary>)];
  it('opens the one match', () => {
    expect(pickChat(sessions, 'billing')).toEqual({ open: 'c3' });
  });
  it('offers every match when there are several, never archived chats', () => {
    const result = pickChat(sessions, 'login');
    expect('choose' in result && result.choose.map(s => s.id).sort()).toEqual(['c1', 'c2']);
  });
  it('offers nothing when nothing matches', () => {
    expect(pickChat(sessions, 'kubernetes')).toEqual({ choose: [] });
  });
});

describe('statusLine', () => {
  it('names the lane and the current step', () => {
    expect(statusLine({ title: 'Auth', running: true, step: 'Running tests', watchingPr: false })).toBe('Auth: Working, Running tests');
  });
  it('says Watching PR when idle with watches, and nothing more without', () => {
    expect(statusLine({ title: 'Auth', running: false, step: '', watchingPr: true })).toBe('Auth: Idle, Watching PR');
    expect(statusLine({ title: 'Auth', running: false, step: '', watchingPr: false })).toBe('Auth: Idle');
    expect(statusLine({ title: 'Auth', running: true, pending: question, step: '', watchingPr: false })).toBe('Auth: Needs you');
  });
});

function target(sessionId = 's1', result = { erased: true, sent: true }): VoiceTarget & { text: string[]; calls: string[] } {
  const t = { sessionId, text: [] as string[], calls: [] as string[] } as VoiceTarget & { text: string[]; calls: string[] };
  t.onText = (x: string, sentence?: boolean) => { t.text.push(x); t.calls.push(sentence ? 'sentence' : 'text'); };
  t.onErase = () => { t.calls.push('erase'); return result.erased; };
  t.onClear = () => { t.calls.push('clear'); };
  t.onSend = async () => { t.calls.push('send'); return result.sent; };
  return t;
}

let nekko: Record<string, any>;
beforeEach(() => {
  runs.running.clear(); runs.step = ''; drafts.clear();
  store.state = {
    activeSessionId: 's1',
    sessions: [chat('s1', 'Auth'), chat('s2', 'Billing')],
    prsBySession: {} as Record<string, PrInfo[]>,
    settings: { voice: { enabled: true, commandsEnabled: true } },
    pushToast: vi.fn(), newChat: vi.fn(async () => {}), archiveChat: vi.fn(async () => {}), setView: vi.fn(), openChatPane: vi.fn(),
  };
  let stop: (() => void) | null = null;
  nekko = {
    pendingInput: vi.fn(async () => ({})),
    voiceStatus: vi.fn(async () => ({ installed: true })),
    voiceTranscribe: vi.fn(async () => ''),
    openPath: vi.fn(async () => {}),
    answerQuestion: vi.fn(async () => {}),
    onVoiceLockStop: vi.fn((cb: () => void) => { stop = cb; return () => { stop = null; }; }),
    fireVoiceStop: () => stop?.(),
  };
  vi.stubGlobal('window', { nekko, setTimeout, clearTimeout });
});
afterEach(() => { voiceListener.abort(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); capture.tail = []; });

describe('runVoiceIntent', () => {
  it('erases, clears and sends without a confirm, with a toast each', async () => {
    const t = target();
    for (const kind of ['erase', 'clear', 'send'] as const) expect(await runVoiceIntent({ kind }, t, null)).toBeNull();
    expect(t.calls).toEqual(['erase', 'clear', 'send']);
    expect(store.state.pushToast.mock.calls).toEqual([['success', 'Erased'], ['success', 'Cleared'], ['success', 'Sent']]);
  });
  it('types dictation and unknown commands', async () => {
    const t = target();
    await runVoiceIntent({ kind: 'dictation', text: 'hello' }, t, null);
    await runVoiceIntent({ kind: 'unknown', text: 'Nekko, juggle' }, t, null);
    expect(t.text).toEqual(['hello', 'Nekko, juggle']);
  });
  it('starts a new chat and opens pages and chats', async () => {
    const t = target();
    await runVoiceIntent({ kind: 'new-session' }, t, null);
    await runVoiceIntent({ kind: 'navigate', view: 'settings' }, t, null);
    await runVoiceIntent({ kind: 'open-chat', query: 'billing', text: 'Nekko, open billing' }, t, null);
    expect(store.state.newChat).toHaveBeenCalledOnce();
    expect(store.state.pushToast).toHaveBeenCalledWith('success', 'New chat');
    expect(store.state.setView).toHaveBeenCalledWith('settings');
    expect(store.state.pushToast).toHaveBeenCalledWith('success', 'Opened Settings');
    expect(store.state.openChatPane).toHaveBeenCalledWith('s2');
    expect(store.state.pushToast).toHaveBeenCalledWith('success', 'Opened Billing');
  });
  it('switches desktops with a toast', async () => {
    await runVoiceIntent({ kind: 'go', target: { kind: 'desktop', n: 2 } }, null, null);
    await runVoiceIntent({ kind: 'go', target: { kind: 'desktop', step: 1 } }, null, null);
    expect(store.state.pushToast.mock.calls).toEqual([['success', 'Switched to desktop 2'], ['success', 'Switched to the next desktop']]);
  });
  it('chat commands need a focused chat', async () => {
    for (const kind of ['erase', 'clear', 'send', 'ship', 'status', 'complete-session'] as const) expect(await runVoiceIntent({ kind }, null, null)).toBeNull();
    expect(store.state.pushToast.mock.calls.every(([kind, text]: string[]) => kind === 'error' && text === 'Open a chat first')).toBe(true);
    expect(store.state.pushToast).toHaveBeenCalledTimes(6);
    expect(store.state.archiveChat).not.toHaveBeenCalled();
  });
  it('confirms before completing a chat; yes runs it, no drops it', async () => {
    const t = target();
    const pending = await runVoiceIntent({ kind: 'complete-session' }, t, null);
    expect(pending?.message).toMatch(/Say 'Nekko, yes' or tap Confirm\.$/);
    expect(store.state.archiveChat).not.toHaveBeenCalled();
    expect(await runVoiceIntent({ kind: 'no' }, t, pending)).toBeNull();
    expect(store.state.pushToast).toHaveBeenLastCalledWith('success', 'Cancelled');
    expect(store.state.archiveChat).not.toHaveBeenCalled();
    expect(await runVoiceIntent({ kind: 'yes' }, t, pending)).toBeNull();
    expect(store.state.archiveChat).toHaveBeenCalledWith('s1');
    expect(store.state.pushToast).toHaveBeenLastCalledWith('success', 'Completed Auth');
  });
  it('ship with an open PR confirms naming it, then merges through the PR action', async () => {
    store.state.prsBySession = { s1: [pr()] };
    const t = target();
    const pending = await runVoiceIntent({ kind: 'ship' }, t, null);
    expect(pending?.message).toBe("Merge o/r#7? Say 'Nekko, yes' or tap Confirm.");
    expect(runPrAction).not.toHaveBeenCalled();
    await runVoiceIntent({ kind: 'yes' }, t, pending);
    expect(store.state.pushToast).toHaveBeenCalledWith('success', 'Merging o/r#7');
    expect(runPrAction).toHaveBeenCalledWith('s1', pr().url, 'merge');
  });
  it('ship with an open PR and a question waiting asks which: merge or go ahead', async () => {
    store.state.prsBySession = { s1: [pr()] };
    nekko.pendingInput.mockResolvedValue({ s1: question });
    const t = target();
    const pending = await runVoiceIntent({ kind: 'ship' }, t, null);
    expect(pending?.kind).toBe('choose');
    expect(pending?.kind === 'choose' && pending.options.map(o => o.label)).toEqual(['Merge o/r#7', 'Go ahead']);
    expect(await runVoiceIntent({ kind: 'yes' }, t, pending)).toBe(pending);
    expect(await runVoiceIntent({ kind: 'pick', n: 2 }, t, pending)).toBeNull();
    // A turn blocked on a question is answered, not queued behind itself.
    expect(nekko.answerQuestion).toHaveBeenCalledWith('s1', 'call1', goAheadAnswer);
    expect(t.calls).toEqual([]);
    expect(runPrAction).not.toHaveBeenCalled();
    await runVoiceIntent({ kind: 'pick', n: 1 }, t, pending);
    expect(runPrAction).toHaveBeenCalledWith('s1', pr().url, 'merge');
  });
  it('ship with a stacked PR opens it on GitHub', async () => {
    store.state.prsBySession = { s1: [pr({ stack: { number: 1, size: 2 } })] };
    expect(await runVoiceIntent({ kind: 'ship' }, target(), null)).toBeNull();
    expect(nekko.openPath).toHaveBeenCalledWith(pr().url);
    expect(runPrAction).not.toHaveBeenCalled();
  });
  it('ship with no PR tells an idle agent to go ahead, and says when it is still working', async () => {
    const t = target();
    await runVoiceIntent({ kind: 'ship' }, t, null);
    expect(t.text).toEqual(['Go ahead and build it.']);
    expect(t.calls).toEqual(['sentence', 'send']);
    expect(store.state.pushToast).toHaveBeenLastCalledWith('success', 'Sent');
    runs.running.add('s1');
    await runVoiceIntent({ kind: 'ship' }, t, null);
    expect(store.state.pushToast).toHaveBeenLastCalledWith('success', "It's still working");
    store.state.prsBySession = { s1: [pr({ state: 'merged' })] };
    runs.running.clear();
    await runVoiceIntent({ kind: 'ship' }, t, null);
    expect(store.state.pushToast).toHaveBeenLastCalledWith('success', 'Nothing to ship');
  });
  it('ship with no PR and a question waiting answers it with "Go ahead"', async () => {
    nekko.pendingInput.mockResolvedValue({ s1: question });
    runs.running.add('s1');
    const t = target();
    await runVoiceIntent({ kind: 'ship' }, t, null);
    expect(nekko.answerQuestion).toHaveBeenCalledWith('s1', 'call1', goAheadAnswer);
    expect(t.calls).toEqual([]);
    expect(store.state.pushToast).toHaveBeenLastCalledWith('success', 'Sent');
  });
  it('toasts Erased and Sent only when something was erased or sent', async () => {
    const t = target('s1', { erased: false, sent: false });
    await runVoiceIntent({ kind: 'erase' }, t, null);
    await runVoiceIntent({ kind: 'send' }, t, null);
    await runVoiceIntent({ kind: 'ship' }, t, null);
    expect(t.calls).toEqual(['erase', 'send', 'sentence', 'send']);
    expect(store.state.pushToast).not.toHaveBeenCalled();
  });
  it('types an "open X" that matches no chat instead of dropping it', async () => {
    const t = target();
    expect(await runVoiceIntent({ kind: 'open-chat', query: 'kubernetes', text: 'Nekko, open kubernetes' }, t, null)).toBeNull();
    expect(t.text).toEqual(['Nekko, open kubernetes']);
    expect(store.state.openChatPane).not.toHaveBeenCalled();
  });
  it('status toasts the lane and current step', async () => {
    runs.running.add('s1'); runs.step = 'Editing auth.ts';
    await runVoiceIntent({ kind: 'status' }, target(), null);
    expect(store.state.pushToast).toHaveBeenCalledWith('success', 'Auth: Working, Editing auth.ts');
  });
  it('open-chat with several matches waits for a pick', async () => {
    store.state.sessions = [chat('s1', 'Login fix'), chat('s2', 'Login page')];
    const t = target();
    const pending = await runVoiceIntent({ kind: 'open-chat', query: 'login', text: 'Nekko, open login' }, t, null);
    expect(pending?.kind).toBe('choose');
    const label = pending?.kind === 'choose' ? pending.options[1].label : '';
    expect(await runVoiceIntent({ kind: 'pick', n: 2 }, t, pending)).toBeNull();
    expect(store.state.openChatPane).toHaveBeenCalledWith(store.state.sessions.find((s: SessionSummary) => s.title === label).id);
    expect(store.state.pushToast).toHaveBeenLastCalledWith('success', `Opened ${label}`);
  });
  it('a pending confirm survives dictation and ignores a pick', async () => {
    const t = target();
    const pending = await runVoiceIntent({ kind: 'complete-session' }, t, null);
    expect(await runVoiceIntent({ kind: 'dictation', text: 'hm' }, t, pending)).toBe(pending);
    expect(await runVoiceIntent({ kind: 'pick', n: 1 }, t, pending)).toBe(pending);
  });
});

describe('voiceListener', () => {
  const flush = () => new Promise(r => setTimeout(r, 0));
  it('types dictation and runs a command from one segment, and keeps listening', async () => {
    const a = target('s1');
    const off = voiceListener.register('s1', () => a);
    nekko.voiceTranscribe.mockResolvedValue('Fix the bug. Nekko, send it.');
    expect(await voiceListener.start('s1')).toBe('started');
    capture.onSegment!([1]);
    await voiceListener.drain();
    expect(a.calls).toEqual(['text', 'send']);
    expect(a.text).toEqual(['Fix the bug.']);
    expect(voiceListener.snapshot().listening).toBe(true);
    expect(voiceListener.snapshot().heard).toBe('Fix the bug. Nekko, send it.');
    off();
  });
  it('sends text to the chat focused when the segment applies', async () => {
    const a = target('s1'); const b = target('s2');
    const offA = voiceListener.register('s1', () => a); const offB = voiceListener.register('s2', () => b);
    nekko.voiceTranscribe.mockResolvedValue('hello');
    await voiceListener.start('s1');
    store.state.activeSessionId = 's2';
    capture.onSegment!([1]);
    await voiceListener.drain();
    expect(b.text).toEqual(['hello']);
    store.state.activeSessionId = 'elsewhere';
    capture.onSegment!([2]);
    await voiceListener.drain();
    expect(a.text).toEqual(['hello']);
    // Chat commands never fall back to the capturing chat.
    nekko.voiceTranscribe.mockResolvedValue('Nekko, send it.');
    capture.onSegment!([3]);
    await voiceListener.drain();
    expect(a.calls).toEqual(['text']);
    expect(store.state.pushToast).toHaveBeenLastCalledWith('error', 'Open a chat first');
    offA(); offB();
  });
  it('words after "send it" start the next draft instead of riding along', async () => {
    let draft = '';
    const sent: string[] = [];
    const composer = { sessionId: 's1', ...voiceComposer({ get: () => draft, set: t => { draft = t; }, send: async t => { sent.push(t); return true; }, sent: () => {} }) };
    const off = voiceListener.register('s1', () => composer);
    nekko.voiceTranscribe.mockResolvedValue('Fix the bug. Nekko, send it. Then add tests.');
    await voiceListener.start('s1');
    capture.onSegment!([1]);
    await voiceListener.drain();
    expect(sent).toEqual(['Fix the bug.']);
    expect(draft).toBe('Then add tests.');
    off();
  });
  it('types everything when commands are off', async () => {
    const a = target('s1');
    const off = voiceListener.register('s1', () => a);
    store.state.settings.voice.commandsEnabled = false;
    nekko.voiceTranscribe.mockResolvedValue('Nekko, send it.');
    await voiceListener.start('s1');
    capture.onSegment!([1]);
    await voiceListener.drain();
    expect(a.calls).toEqual(['text']);
    off();
  });
  it('toggling off transcribes the tail; an abort drops it', async () => {
    const a = target('s1');
    const off = voiceListener.register('s1', () => a);
    nekko.voiceTranscribe.mockResolvedValue('last words');
    await voiceListener.start('s1');
    capture.tail = [9];
    await voiceListener.stop();
    expect(a.text).toEqual(['last words']);
    expect(voiceListener.snapshot().listening).toBe(false);
    await voiceListener.start('s1');
    voiceListener.abort();
    await voiceListener.drain();
    expect(a.text).toEqual(['last words']);
    expect(nekko.voiceTranscribe).toHaveBeenCalledTimes(1);
    off();
  });
  it('an empty tail is not transcribed', async () => {
    const off = voiceListener.register('s1', () => target('s1'));
    await voiceListener.start('s1');
    capture.tail = [];
    await voiceListener.stop();
    expect(nekko.voiceTranscribe).not.toHaveBeenCalled();
    off();
  });
  it('stops on lock or suspend', async () => {
    const off = voiceListener.register('s1', () => target('s1'));
    await voiceListener.start('s1');
    nekko.fireVoiceStop();
    expect(capture.abort).toHaveBeenCalled();
    expect(voiceListener.snapshot().listening).toBe(false);
    off();
  });
  it('keeps listening on a page with no chat: words wait in the owning chat\'s draft, chat commands need a chat', async () => {
    drafts.set('s1', { text: 'Started typing', images: ['img'], videos: [] });
    const off = voiceListener.register('s1', () => target('s1'));
    await voiceListener.start('s1');
    off();
    store.state.activeSessionId = null;
    await flush();
    expect(voiceListener.snapshot().listening).toBe(true);
    nekko.voiceTranscribe.mockResolvedValue('Then add tests. Nekko, send it. Nekko, open settings.');
    capture.onSegment!([1]);
    await voiceListener.drain();
    expect(drafts.get('s1')).toEqual({ text: 'Started typing Then add tests.', images: ['img'], videos: [] });
    expect(store.state.pushToast.mock.calls).toEqual([['success', 'Added to Auth draft'], ['error', 'Open a chat first'], ['success', 'Opened Settings']]);
    expect(store.state.setView).toHaveBeenCalledWith('settings');
    expect(voiceListener.snapshot().listening).toBe(true);
  });
  it('stops when voice is turned off, even with no chat on screen', async () => {
    const off = voiceListener.register('s1', () => target('s1'));
    await voiceListener.start('s1');
    off();
    store.state.settings = { voice: { enabled: false } };
    store.listeners.forEach(fn => fn(store.state));
    expect(capture.abort).toHaveBeenCalled();
    expect(voiceListener.snapshot().listening).toBe(false);
  });
  it('catches a lock that happens while the microphone is opening', async () => {
    vi.mocked(startVoiceCapture).mockImplementationOnce(async () => { nekko.fireVoiceStop(); return { stop: capture.stop, abort: capture.abort }; });
    const off = voiceListener.register('s1', () => target('s1'));
    expect(await voiceListener.start('s1')).toBe('failed');
    expect(capture.abort).toHaveBeenCalled();
    expect(voiceListener.snapshot().listening).toBe(false);
    off();
  });
  it('keeps a segment spoken while the last one is still transcribing', async () => {
    let busy = false;
    nekko.voiceTranscribe.mockImplementation(async (w: number[]) => {
      if (busy) throw new Error('Voice transcription is already running.');
      busy = true;
      try { await new Promise(r => setTimeout(r, 10)); return w[0] === 1 ? 'First.' : 'Second.'; } finally { busy = false; }
    });
    const a = target('s1');
    const off = voiceListener.register('s1', () => a);
    await voiceListener.start('s1');
    capture.onSegment!([1]); capture.onSegment!([2]);
    await voiceListener.drain();
    expect(a.text).toEqual(['First.', 'Second.']);
    off();
  });
  it('says once when speech could not be turned into text', async () => {
    nekko.voiceTranscribe.mockRejectedValue(new Error('engine down'));
    const off = voiceListener.register('s1', () => target('s1'));
    await voiceListener.start('s1');
    capture.onSegment!([1]); capture.onSegment!([2]);
    await voiceListener.drain();
    expect(store.state.pushToast.mock.calls).toEqual([['error', 'Could not turn speech into text: engine down']]);
    off();
  });
  it('carries a wake word said alone into the next segment within 5 seconds', async () => {
    vi.useFakeTimers();
    const a = target('s1');
    const off = voiceListener.register('s1', () => a);
    await voiceListener.start('s1');
    for (const said of ['Fix it. Nekko.', 'Send it.']) {
      nekko.voiceTranscribe.mockResolvedValueOnce(said);
      capture.onSegment!([1]);
      await voiceListener.drain();
    }
    expect(a.text).toEqual(['Fix it.']);
    expect(a.calls).toEqual(['text', 'send']);
    nekko.voiceTranscribe.mockResolvedValueOnce('Nekko?');
    capture.onSegment!([1]);
    await voiceListener.drain();
    vi.advanceTimersByTime(WAKE_CARRY_MS + 1);
    nekko.voiceTranscribe.mockResolvedValueOnce('Send it.');
    capture.onSegment!([1]);
    await voiceListener.drain();
    expect(a.text).toEqual(['Fix it.', 'Send it.']);
    expect(a.calls).toEqual(['text', 'send', 'text']);
    off();
  });
  it('asks for setup when voice is off or not installed', async () => {
    store.state.settings.voice.enabled = false;
    expect(await voiceListener.start('s1')).toBe('setup');
    store.state.settings.voice.enabled = true;
    nekko.voiceStatus.mockResolvedValue({ installed: false });
    expect(await voiceListener.start('s1')).toBe('setup');
  });
  it('answers a pending confirm from a button tap', async () => {
    const a = target('s1');
    const off = voiceListener.register('s1', () => a);
    nekko.voiceTranscribe.mockResolvedValue('Nekko, complete this session.');
    await voiceListener.start('s1');
    capture.onSegment!([1]);
    await voiceListener.drain();
    expect(voiceListener.snapshot().pending?.kind).toBe('confirm');
    await voiceListener.answer({ kind: 'yes' });
    expect(store.state.archiveChat).toHaveBeenCalledWith('s1');
    expect(voiceListener.snapshot().pending).toBeNull();
    off();
  });
});

describe('voiceComposer', () => {
  function composer(draft: string, send: (text: string) => Promise<boolean> = async () => true) {
    const box = { draft, sent: [] as string[], cleared: 0 };
    const c = voiceComposer({ get: () => box.draft, set: t => { box.draft = t; }, send: async t => { box.sent.push(t); return send(t); }, sent: () => { box.cleared++; } });
    return { box, c };
  }
  it('erases exactly the last dictated piece, once', () => {
    const { box, c } = composer('typed');
    c.onText('one.'); c.onText('two.');
    expect(c.onErase()).toBe(true);
    expect(box.draft).toBe('typed one.');
    expect(c.onErase()).toBe(false);
    expect(box.draft).toBe('typed one.');
    c.onClear();
    expect(box.draft).toBe('');
  });
  it('starts "Go ahead and build it." as its own sentence', () => {
    const { box, c } = composer('fix the header ');
    c.onText('Go ahead and build it.', true);
    expect(box.draft).toBe('fix the header. Go ahead and build it.');
    const done = composer('Fix the header.');
    done.c.onText('Go ahead and build it.', true);
    expect(done.box.draft).toBe('Fix the header. Go ahead and build it.');
  });
  it('a refused send puts the text back, ahead of words dictated meanwhile, and keeps the attachments', async () => {
    let refuse!: (ok: boolean) => void;
    const { box, c } = composer('Fix the bug.', () => new Promise(r => { refuse = r; }));
    const sending = c.onSend();
    c.onText('Then add tests.');
    refuse(false);
    expect(await sending).toBe(false);
    expect(box.draft).toBe('Fix the bug. Then add tests.');
    expect(box.cleared).toBe(0);
  });
  it('a send that throws is a refused send', async () => {
    const { box, c } = composer('Fix the bug.', async () => { throw new Error('offline'); });
    expect(await c.onSend()).toBe(false);
    expect(box.draft).toBe('Fix the bug.');
  });
  it('a sent draft clears the attachments; an empty draft is not sent', async () => {
    const { box, c } = composer('Fix the bug.');
    expect(await c.onSend()).toBe(true);
    expect(box).toEqual({ draft: '', sent: ['Fix the bug.'], cleared: 1 });
    expect(await c.onSend()).toBe(false);
    expect(box.sent).toEqual(['Fix the bug.']);
  });
});

describe('pending confirms', () => {
  async function confirmPending(text = 'Nekko, complete this session.') {
    const a = target('s1');
    const off = voiceListener.register('s1', () => a);
    nekko.voiceTranscribe.mockResolvedValue(text);
    await voiceListener.start('s1');
    capture.onSegment!([1]);
    await voiceListener.drain();
    expect(voiceListener.snapshot().pending?.kind).toBe('confirm');
    return off;
  }
  it('expire after a minute, so a late "Nekko, yes" does nothing', async () => {
    vi.useFakeTimers();
    const off = await confirmPending();
    vi.advanceTimersByTime(PENDING_TTL_MS - 1);
    expect(voiceListener.snapshot().pending).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(voiceListener.snapshot().pending).toBeNull();
    await voiceListener.answer({ kind: 'yes' });
    expect(store.state.archiveChat).not.toHaveBeenCalled();
    off();
  });
  it('keep their clock while the user keeps talking', async () => {
    vi.useFakeTimers();
    const off = await confirmPending();
    vi.advanceTimersByTime(PENDING_TTL_MS / 2);
    nekko.voiceTranscribe.mockResolvedValue('Some more words. Nekko, how is it going?');
    capture.onSegment!([2]);
    await voiceListener.drain();
    await voiceListener.answer({ kind: 'pick', n: 1 });
    expect(voiceListener.snapshot().pending).not.toBeNull();
    vi.advanceTimersByTime(PENDING_TTL_MS / 2);
    expect(voiceListener.snapshot().pending).toBeNull();
    await voiceListener.answer({ kind: 'yes' });
    expect(store.state.archiveChat).not.toHaveBeenCalled();
    off();
  });
  it('are cleared when listening is toggled off or aborted', async () => {
    let off = await confirmPending();
    await voiceListener.stop();
    expect(voiceListener.snapshot().pending).toBeNull();
    off();
    off = await confirmPending();
    voiceListener.abort();
    expect(voiceListener.snapshot().pending).toBeNull();
    off();
  });
  it('are cleared when the confirmed action fails', async () => {
    store.state.archiveChat.mockRejectedValueOnce(new Error('engine said no'));
    const off = await confirmPending();
    await voiceListener.answer({ kind: 'yes' });
    expect(store.state.pushToast).toHaveBeenLastCalledWith('error', 'engine said no');
    expect(voiceListener.snapshot().pending).toBeNull();
    off();
  });
});
