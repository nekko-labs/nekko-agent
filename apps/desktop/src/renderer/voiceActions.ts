import type { PendingInput, PrInfo, SessionSummary } from '@nekko-agent/shared';
import { LANE_META, sessionLane } from '@nekko-agent/shared';
import { searchChats } from './views/chatFinder.js';
import { useStore } from './store.js';
import { describeRun, getLiveRun } from './liveRuns.js';
import { displaysBridge } from './displays.js';
import { runPrAction } from './components/PrCard.js';
import { splitVoiceSegments, type VoiceIntent } from './voiceCommands.js';
import { startVoiceCapture } from './voiceCapture.js';
import { createSegmentQueue } from './voiceSegments.js';

/** What "Nekko, ship it" does for a chat. */
export function shipAction(input: { prs: PrInfo[]; running: boolean; pending?: PendingInput }): 'merge' | 'go-ahead' | 'ask' | 'still-working' | 'nothing' {
  const open = input.prs.some(p => p.state === 'open');
  const question = !!input.pending?.question;
  if (open) return question ? 'ask' : 'merge';
  if (question) return 'go-ahead';
  if (input.running) return 'still-working';
  // A chat whose PRs are all merged or closed already shipped.
  return input.prs.length ? 'nothing' : 'go-ahead';
}

/** "Open the one about X": one match opens, otherwise up to three to choose from. */
export function pickChat(sessions: SessionSummary[], query: string): { open: string } | { choose: SessionSummary[] } {
  const { hits } = searchChats(sessions.filter(s => !s.archivedAt), query, { scope: 'chats', limit: 3 });
  return hits.length === 1 ? { open: hits[0].session.id } : { choose: hits.map(h => h.session) };
}

/** "Nekko, how's it going": the lane, then the current step or "Watching PR". */
export function statusLine(input: { title: string; running: boolean; pending?: PendingInput; stalled?: boolean; step: string; watchingPr: boolean }): string {
  const { lane } = sessionLane({ running: input.running, pending: input.pending, stalled: input.stalled ?? false });
  const detail = input.step || (input.watchingPr ? 'Watching PR' : '');
  return `${input.title}: ${LANE_META[lane].title}${detail ? ', ' + detail : ''}`;
}

/** The composer a voice segment lands in. */
export interface VoiceTarget { sessionId: string; onText(text: string): void; onErase(): void; onClear(): void; onSend(): void }

/** A command waiting on "Nekko, yes" / "no" or a tap, or a chat list waiting on a pick. */
export type VoicePending = { kind: 'confirm'; message: string; run: () => Promise<void> } | { kind: 'choose'; message: string; options: SessionSummary[] };

const SAY_YES = "Say 'Nekko, yes' or tap Confirm.";
const prLabel = (pr: PrInfo) => `${pr.owner}/${pr.repo}#${pr.number}`;

/** Runs one intent against the target composer and returns what is pending afterwards. */
export async function runVoiceIntent(intent: VoiceIntent, target: VoiceTarget, pending: VoicePending | null): Promise<VoicePending | null> {
  const store = useStore.getState();
  const toast = (message: string) => store.pushToast('success', message);
  const id = target.sessionId;
  const session = store.sessions.find((s: SessionSummary) => s.id === id);
  const title = session?.title || 'This chat';
  switch (intent.kind) {
    case 'dictation': case 'unknown': target.onText(intent.text); return pending;
    case 'erase': target.onErase(); toast('Erased'); return pending;
    case 'clear': target.onClear(); toast('Cleared'); return pending;
    case 'send': target.onSend(); toast('Sent'); return pending;
    case 'new-session': await store.newChat(); toast('New chat'); return pending;
    case 'navigate': store.setView(intent.view); return pending;
    case 'go': {
      const result = displaysBridge ? await displaysBridge.go(intent.target) : 'not-found';
      if (result === 'needs-access') throw new Error('Switching desktops needs the Accessibility permission: turn on Switch me there in the Agents Screens menu.');
      if (result === 'not-found') throw new Error(`There is no ${intent.target.kind} ${'n' in intent.target ? intent.target.n : 'that way'}.`);
      return pending;
    }
    case 'status': {
      const waiting = (await window.nekko.pendingInput().catch(() => ({} as Record<string, PendingInput>)))[id];
      toast(statusLine({ title, running: !!getLiveRun(id), pending: waiting, stalled: session?.stalled, step: describeRun(id), watchingPr: (session?.activeWatchCount ?? 0) > 0 }));
      return pending;
    }
    case 'open-chat': {
      const result = pickChat(store.sessions, intent.query);
      if ('open' in result) { store.openChatPane(result.open); return pending; }
      if (!result.choose.length) { store.pushToast('error', `No chat matches "${intent.query}"`); return pending; }
      return { kind: 'choose', message: "Which chat? Say 'Nekko, the first one' or tap it.", options: result.choose };
    }
    case 'complete-session':
      return { kind: 'confirm', message: `Complete "${title}"? ${SAY_YES}`, run: () => store.archiveChat(id) };
    case 'ship': {
      const prs: PrInfo[] = store.prsBySession[id] ?? [];
      const waiting = (await window.nekko.pendingInput().catch(() => ({} as Record<string, PendingInput>)))[id];
      const action = shipAction({ prs, running: !!getLiveRun(id), pending: waiting });
      if (action === 'go-ahead') { target.onText('Go ahead and build it.'); target.onSend(); toast('Sent'); return pending; }
      if (action === 'still-working') { toast("It's still working"); return pending; }
      if (action === 'nothing') { toast('Nothing to ship'); return pending; }
      const pr = prs.find(p => p.state === 'open')!;
      // A GitHub stack is reviewed and merged on GitHub, as the PR card's Merge button does.
      if (pr.stack) { void window.nekko.openPath(pr.url).catch(() => {}); toast(`Opening ${prLabel(pr)} on GitHub`); return pending; }
      const ask = action === 'ask' ? `${title} has a question waiting for you. Merge ${prLabel(pr)} anyway?` : `Merge ${prLabel(pr)}?`;
      return { kind: 'confirm', message: `${ask} ${SAY_YES}`, run: async () => { toast(`Merging ${prLabel(pr)}`); await runPrAction(id, pr.url, 'merge'); } };
    }
    case 'yes':
      if (pending?.kind !== 'confirm') return pending;
      await pending.run();
      return null;
    case 'no': return null;
    case 'pick': {
      const chosen = pending?.kind === 'choose' ? pending.options[intent.n - 1] : undefined;
      if (!chosen) return pending;
      store.openChatPane(chosen.id);
      return null;
    }
  }
}

/** What every dictation button draws: one microphone for the whole app. */
export interface VoiceSnapshot {
  listening: boolean;
  busy: 'starting' | 'transcribing' | null;
  level: number;
  heard: string;
  pending: VoicePending | null;
  error: string;
  /** The chat whose button turned listening on. */
  owner: string | null;
  /** Bumped when buttons mount or unmount, so the one showing the strip can move. */
  version: number;
}

let snap: VoiceSnapshot = { listening: false, busy: null, level: 0, heard: '', pending: null, error: '', owner: null, version: 0 };
const listeners = new Set<() => void>();
const set = (patch: Partial<VoiceSnapshot>) => { snap = { ...snap, ...patch }; listeners.forEach(fn => fn()); };
const targets = new Map<string, Array<() => VoiceTarget>>();
let capture: { stop(): number[]; abort(): void } | null = null;
let offStop: (() => void) | null = null;

const targetFor = (id: string | null | undefined) => (id ? targets.get(id)?.at(-1) : undefined);
// The focused chat wins; else the chat that turned listening on; else any mounted composer.
function resolveTarget(): (() => VoiceTarget) | undefined {
  return targetFor(useStore.getState().activeSessionId) ?? targetFor(snap.owner) ?? [...targets.values()].at(-1)?.at(-1);
}

async function act(intent: VoiceIntent): Promise<void> {
  const target = resolveTarget();
  if (!target) return;
  try { set({ pending: await runVoiceIntent(intent, target(), snap.pending) }); }
  catch (e) { useStore.getState().pushToast('error', (e as Error).message); }
}

async function applyText(text: string): Promise<void> {
  const voice = useStore.getState().settings?.voice;
  if (!voice?.enabled) return;
  set({ heard: text });
  for (const intent of voice.commandsEnabled === false ? [{ kind: 'dictation' as const, text }] : splitVoiceSegments(text)) await act(intent);
}

const queue = createSegmentQueue(wav => window.nekko.voiceTranscribe(wav), applyText);

function end(): void {
  capture = null;
  offStop?.(); offStop = null;
  set({ listening: false, level: 0 });
}

export const voiceListener = {
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  snapshot: () => snap,
  /** A mounted composer. Listening stops once none is left (a chat switch remounts one at once). */
  register(sessionId: string, target: () => VoiceTarget): () => void {
    targets.set(sessionId, [...(targets.get(sessionId) ?? []), target]);
    set({ version: snap.version + 1 });
    return () => {
      const rest = (targets.get(sessionId) ?? []).filter(t => t !== target);
      if (rest.length) targets.set(sessionId, rest); else targets.delete(sessionId);
      set({ version: snap.version + 1 });
      window.setTimeout(() => { if (!targets.size) voiceListener.abort(); }, 0);
    };
  },
  /** The chat whose button shows the strip and any confirm. */
  displaySessionId(): string | undefined { return resolveTarget()?.().sessionId; },
  async start(owner: string): Promise<'started' | 'setup' | 'failed'> {
    if (capture || snap.busy === 'starting') return 'started';
    set({ busy: 'starting', error: '' });
    try {
      const voice = useStore.getState().settings?.voice;
      const status = await window.nekko.voiceStatus();
      if (!voice?.enabled || !status.installed) { set({ busy: null }); return 'setup'; }
      const local = await startVoiceCapture({ ...voice, onLevel: level => set({ level }), onSilence: () => {}, onSegment: wav => queue.push(wav) });
      if (!useStore.getState().settings?.voice?.enabled || !targets.size) { local.abort(); set({ busy: null }); return 'failed'; }
      capture = local;
      offStop = window.nekko.onVoiceStop?.(() => voiceListener.abort()) ?? null;
      set({ listening: true, busy: null, owner, heard: '', level: 0 });
      return 'started';
    } catch (e) { set({ busy: null, error: (e as Error).message }); return 'failed'; }
  },
  /** Toggle off: the words spoken just before still count. */
  async stop(): Promise<void> {
    const current = capture;
    if (!current) return;
    end();
    const tail = current.stop();
    if (!tail.length) return;
    set({ busy: 'transcribing' });
    queue.push(tail);
    await queue.drain();
    if (snap.busy === 'transcribing') set({ busy: null });
  },
  /** Voice switched off, the screen locked or the last composer went: drop the unfinished tail. */
  abort(): void {
    const current = capture;
    if (!current) return;
    end();
    current.abort();
  },
  /** A tap on Confirm, Cancel or a listed chat. */
  answer: (intent: VoiceIntent) => act(intent),
  dismissError: () => set({ error: '' }),
  drain: () => queue.drain(),
};
