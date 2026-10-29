import type { PendingInput, PrInfo, SessionSummary } from '@nekko-agent/shared';
import { LANE_META, sessionLane } from '@nekko-agent/shared';
import { searchChats } from './views/chatFinder.js';
import { useStore } from './store.js';
import { describeRun, getLiveRun } from './liveRuns.js';
import { displaysBridge } from './displays.js';
import { runPrAction } from './components/PrCard.js';
import { splitVoiceSegments, splitWakeTail, type VoiceIntent } from './voiceCommands.js';
import { startVoiceCapture } from './voiceCapture.js';
import { createSegmentQueue } from './voiceSegments.js';
import { loadDraft, saveDraft } from './composerDrafts.js';
import { translate } from './i18n.js';

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

/**
 * The composer a voice segment lands in. `sentence` starts the text as its own
 * sentence; `onErase` says whether anything was removed and `onSend` whether it sent.
 */
export interface VoiceTarget { sessionId: string; onText(text: string, sentence?: boolean): void; onErase(): boolean; onClear(): void; onSend(): Promise<boolean> }

/**
 * The composer side of voice: tracks the last dictated piece so "erase that"
 * removes exactly it, and sends a snapshot so words dictated after "send it"
 * start the next draft instead of riding along. A refused send (no model, an
 * unconfigured sandbox) puts the text back; `sent` runs only after a real send,
 * so attachments are cleared only then. `send` calls `admitted` once the turn
 * has begun: the host's send settles only when the turn ends, and voice must not
 * wait that long. A failure after admission is the chat's own error, not a refusal.
 */
export function voiceComposer(draft: { get(): string; set(text: string): void; send(text: string, admitted: () => void): Promise<unknown>; sent(): void }): Omit<VoiceTarget, 'sessionId'> {
  let last = '';
  return {
    onText(text, sentence) {
      const current = sentence ? draft.get().trimEnd() : draft.get();
      last = (sentence && current && !/[.!?]$/.test(current) ? '.' : '') + (current && !/\s$/.test(current) ? ' ' : '') + text;
      draft.set(current + last);
    },
    onErase() {
      const current = draft.get();
      const removed = !!last && current.endsWith(last);
      if (removed) draft.set(current.slice(0, -last.length));
      last = '';
      return removed;
    },
    onClear() { last = ''; draft.set(''); },
    async onSend() {
      const text = draft.get();
      if (!text.trim()) return false;
      last = ''; draft.set('');
      const ok = await new Promise<boolean>(resolve => {
        draft.send(text, () => resolve(true)).then(r => resolve(r !== false), () => resolve(false));
      });
      if (ok) { draft.sent(); return true; }
      const now = draft.get();
      draft.set(now ? `${text} ${now}` : text);
      return false;
    },
  };
}

/** A command waiting on "Nekko, yes" / "no" or a tap, or a list waiting on "Nekko, the first one" or a tap. */
export type VoicePending = { kind: 'confirm'; message: string; run: () => Promise<void> } | { kind: 'choose'; message: string; options: Array<{ label: string; run: () => Promise<void> | void }> };

const SAY_YES = "Say 'Nekko, yes' or tap Confirm.";
const GO_AHEAD = 'Go ahead and build it.';
const prLabel = (pr: PrInfo) => `${pr.owner}/${pr.repo}#${pr.number}`;
/** Commands about one chat: they act only on the focused chat, never on a fallback. */
const CHAT_COMMANDS = new Set<VoiceIntent['kind']>(['erase', 'clear', 'send', 'ship', 'status', 'complete-session']);
const goLabel = (t: Extract<VoiceIntent, { kind: 'go' }>['target']) => 'n' in t ? `${t.kind} ${t.n}` : `the ${t.step > 0 ? 'next' : 'previous'} ${t.kind}`;

/**
 * Runs one intent and returns what is pending afterwards. `target` is null when
 * no chat is focused; `type` is where words go that are not a command.
 */
export async function runVoiceIntent(intent: VoiceIntent, target: VoiceTarget | null, pending: VoicePending | null, type: (text: string) => void = text => target?.onText(text)): Promise<VoicePending | null> {
  const store = useStore.getState();
  const toast = (message: string) => store.pushToast('success', message);
  const titleOf = (sessionId: string) => store.sessions.find((s: SessionSummary) => s.id === sessionId)?.title || 'Untitled chat';
  const openChat = (sessionId: string) => { store.openChatPane(sessionId); toast(`Opened ${titleOf(sessionId)}`); };
  if (CHAT_COMMANDS.has(intent.kind) && !target) { store.pushToast('error', 'Open a chat first'); return pending; }
  switch (intent.kind) {
    case 'dictation': case 'unknown': type(intent.text); return pending;
    case 'new-session': await store.newChat(); toast('New chat'); return pending;
    case 'navigate': store.setView(intent.view); toast(`Opened ${translate('en', 'nav.' + intent.view)}`); return pending;
    case 'go': {
      const result = displaysBridge ? await displaysBridge.go(intent.target) : 'not-found';
      if (result === 'needs-access') throw new Error('Switching desktops needs the Accessibility permission: turn on Switch me there in the Agents Screens menu.');
      if (result === 'not-found') throw new Error(`There is no ${intent.target.kind} ${'n' in intent.target ? intent.target.n : 'that way'}.`);
      toast(`Switched to ${goLabel(intent.target)}`);
      return pending;
    }
    case 'open-chat': {
      const result = pickChat(store.sessions, intent.query);
      if ('open' in result) { openChat(result.open); return pending; }
      // A "Nekko, open ..." that names no chat is words, never dropped.
      if (!result.choose.length) { type(intent.text); return pending; }
      return { kind: 'choose', message: "Which chat? Say 'Nekko, the first one' or tap it.", options: result.choose.map(s => ({ label: s.title || 'Untitled chat', run: () => openChat(s.id) })) };
    }
    case 'yes':
      if (pending?.kind !== 'confirm') return pending;
      await pending.run();
      return null;
    case 'no':
      if (pending) toast('Cancelled');
      return null;
    case 'pick': {
      const chosen = pending?.kind === 'choose' ? pending.options[intent.n - 1] : undefined;
      if (!chosen) return pending;
      await chosen.run();
      return null;
    }
  }
  // Chat commands: a focused composer is guaranteed above.
  const t = target!;
  const id = t.sessionId;
  const session = store.sessions.find((s: SessionSummary) => s.id === id);
  const title = titleOf(id);
  switch (intent.kind) {
    case 'erase': if (t.onErase()) toast('Erased'); return pending;
    case 'clear': t.onClear(); toast('Cleared'); return pending;
    case 'send': if (await t.onSend()) toast('Sent'); return pending;
    case 'status': {
      const waiting = (await window.nekko.pendingInput().catch(() => ({} as Record<string, PendingInput>)))[id];
      toast(statusLine({ title, running: !!getLiveRun(id), pending: waiting, stalled: session?.stalled, step: describeRun(id), watchingPr: (session?.activeWatchCount ?? 0) > 0 }));
      return pending;
    }
    case 'complete-session':
      return { kind: 'confirm', message: `Complete "${title}"? ${SAY_YES}`, run: async () => { await store.archiveChat(id); toast(`Completed ${title}`); } };
    case 'ship': {
      const prs: PrInfo[] = store.prsBySession[id] ?? [];
      const waiting = (await window.nekko.pendingInput().catch(() => ({} as Record<string, PendingInput>)))[id];
      const action = shipAction({ prs, running: !!getLiveRun(id), pending: waiting });
      // A turn waiting on a question is answered with free text: a send would queue behind that same turn.
      const goAhead = async () => {
        const asked = waiting?.question;
        if (asked) {
          await window.nekko.answerQuestion(id, asked.callId, asked.questions.map(q => ({ questionId: q.id, labels: [], note: GO_AHEAD })));
          toast('Sent');
          return;
        }
        t.onText(GO_AHEAD, true);
        if (await t.onSend()) toast('Sent');
      };
      if (action === 'go-ahead') { await goAhead(); return pending; }
      if (action === 'still-working') { toast("It's still working"); return pending; }
      if (action === 'nothing') { toast('Nothing to ship'); return pending; }
      const pr = prs.find(p => p.state === 'open')!;
      // A GitHub stack is reviewed and merged on GitHub, as the PR card's Merge button does.
      const merge = pr.stack
        ? async () => { void window.nekko.openPath(pr.url).catch(() => {}); toast(`Opening ${prLabel(pr)} on GitHub`); }
        : async () => { toast(`Merging ${prLabel(pr)}`); await runPrAction(id, pr.url, 'merge'); };
      if (action === 'ask') {
        return { kind: 'choose', message: `${title} has a question waiting for you. Say 'Nekko, the first one' or 'the second one', or tap one.`, options: [{ label: `Merge ${prLabel(pr)}`, run: merge }, { label: 'Go ahead', run: goAhead }] };
      }
      if (pr.stack) { await merge(); return pending; }
      return { kind: 'confirm', message: `Merge ${prLabel(pr)}? ${SAY_YES}`, run: merge };
    }
  }
  return pending;
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
let expiry: ReturnType<typeof setTimeout> | undefined;
/** How long a confirm or choice waits for an answer: a stray "Nekko, yes" much later must not merge. */
export const PENDING_TTL_MS = 60_000;
/** A pause right after "Nekko" cuts it into its own segment; it still addresses a segment this soon after. */
export const WAKE_CARRY_MS = 5_000;
let carried: { wake: string; at: number } | null = null;
let transcribeFailing = false;

function setPending(pending: VoicePending | null): void {
  // An unchanged pending keeps its clock: talking on must not keep a confirm alive.
  if (pending === snap.pending) return;
  clearTimeout(expiry);
  if (pending) expiry = setTimeout(() => { if (snap.pending === pending) set({ pending: null }); }, PENDING_TTL_MS);
  set({ pending });
}

const targetFor = (id: string | null | undefined) => (id ? targets.get(id)?.at(-1) : undefined);
const focusedTarget = () => targetFor(useStore.getState().activeSessionId);
// Dictated words are never lost: the focused chat, else the chat that turned listening on, else any mounted composer.
function textTarget(): (() => VoiceTarget) | undefined {
  return focusedTarget() ?? targetFor(snap.owner) ?? [...targets.values()].at(-1)?.at(-1);
}

function typeText(text: string): void {
  const target = textTarget();
  if (target) { target().onText(text); return; }
  // No composer on screen (Settings, Models, ...): the words wait in the owning chat's saved draft,
  // which its composer restores when the chat opens.
  const id = snap.owner;
  if (!id) return;
  const parked = loadDraft(id);
  const current = parked?.text ?? '';
  saveDraft(id, { text: current + (current && !/\s$/.test(current) ? ' ' : '') + text, images: parked?.images ?? [], videos: parked?.videos ?? [] });
  const store = useStore.getState();
  store.pushToast('success', `Added to ${store.sessions.find((s: SessionSummary) => s.id === id)?.title || 'Untitled chat'} draft`);
}

async function act(intent: VoiceIntent): Promise<void> {
  try {
    const before = snap.pending;
    setPending(await runVoiceIntent(intent, focusedTarget()?.() ?? null, before, typeText));
    // With no composer on screen there is no strip to show a list on.
    if (snap.pending && snap.pending !== before && !targets.size) useStore.getState().pushToast('info', snap.pending.message);
  }
  catch (e) {
    useStore.getState().pushToast('error', (e as Error).message);
    // A confirm whose action failed is answered; leaving it up invites a second try by accident.
    if (intent.kind === 'yes' || intent.kind === 'pick') setPending(null);
  }
}

async function applyText(text: string): Promise<void> {
  const voice = useStore.getState().settings?.voice;
  if (!voice?.enabled) return;
  set({ heard: text });
  if (voice.commandsEnabled === false) { await act({ kind: 'dictation', text }); return; }
  const carry = carried && Date.now() - carried.at <= WAKE_CARRY_MS ? `${carried.wake} ` : '';
  // A wake word left alone at the end waits for the next segment; carried too late, it is dropped (it holds no words).
  const { rest, wake } = splitWakeTail(carry + text);
  carried = wake ? { wake, at: Date.now() } : null;
  for (const intent of splitVoiceSegments(rest)) await act(intent);
}

const queue = createSegmentQueue(wav => window.nekko.voiceTranscribe(wav), text => { transcribeFailing = false; return applyText(text); }, e => {
  // Said once per failing run, not on every pause, while the engine keeps refusing.
  if (!transcribeFailing) useStore.getState().pushToast('error', `Could not turn speech into text: ${(e as Error)?.message ?? e}`);
  transcribeFailing = true;
});

function end(): void {
  capture = null;
  offStop?.(); offStop = null;
  setPending(null);
  set({ listening: false, level: 0 });
}

export const voiceListener = {
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  snapshot: () => snap,
  /** A mounted composer. Listening carries on with none (a page with no chat): words then go to the owner's saved draft. */
  register(sessionId: string, target: () => VoiceTarget): () => void {
    targets.set(sessionId, [...(targets.get(sessionId) ?? []), target]);
    set({ version: snap.version + 1 });
    return () => {
      const rest = (targets.get(sessionId) ?? []).filter(t => t !== target);
      if (rest.length) targets.set(sessionId, rest); else targets.delete(sessionId);
      set({ version: snap.version + 1 });
    };
  },
  /** The chat whose button shows the strip and any confirm. */
  displaySessionId(): string | undefined { return textTarget()?.().sessionId; },
  async start(owner: string): Promise<'started' | 'setup' | 'failed'> {
    if (capture || snap.busy === 'starting') return 'started';
    set({ busy: 'starting', error: '' });
    // The toggle-off tail still applies after listening ends, so a carried wake word is reset here, not there.
    transcribeFailing = false; carried = null;
    // Subscribed before the microphone opens, so a lock or voice-off while it opens is not missed.
    // Voice-off is watched here, not in a composer, because listening outlives every composer.
    let stopped = false;
    const stop = () => { stopped = true; voiceListener.abort(); };
    const offs = [window.nekko.onVoiceLockStop?.(stop), useStore.subscribe(s => { if (!s.settings?.voice?.enabled) stop(); })];
    const off = () => offs.forEach(fn => fn?.());
    try {
      const voice = useStore.getState().settings?.voice;
      const status = await window.nekko.voiceStatus();
      if (!voice?.enabled || !status.installed) { off(); set({ busy: null }); return 'setup'; }
      const local = await startVoiceCapture({ ...voice, onLevel: level => set({ level }), onSilence: () => {}, onSegment: wav => queue.push(wav) });
      if (stopped || !useStore.getState().settings?.voice?.enabled) { off(); local.abort(); set({ busy: null }); return 'failed'; }
      capture = local;
      offStop = off;
      set({ listening: true, busy: null, owner, heard: '', level: 0 });
      return 'started';
    } catch (e) { off(); set({ busy: null, error: (e as Error).message }); return 'failed'; }
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
  /** Voice switched off or the screen locked: drop the unfinished tail. */
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
