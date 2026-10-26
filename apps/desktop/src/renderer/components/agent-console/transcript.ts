import { ASK_CANCELLED, ASK_UNATTENDED, groupByPurpose, parseAskRequest } from '@nekko-agent/shared';
import type { PurposeCall, ToolPurpose } from '@nekko-agent/shared';
import type { ChatMessage, ToolCall, ToolResult, PrInfo, PrState } from '@nekko-agent/shared';

/** Display-only projection of the persisted tool reply, never model history.
 * Keep the Q/A body literal: labels and notes cannot be reconstructed from the
 * formatter's comma-separated text without losing what the person selected. */
function askReply(call: ToolCall, message: ChatMessage): ChatMessage | undefined {
  const result = message.toolResult;
  if (call.name !== 'ask_user' || !result || result.isError) return;
  const parsed = parseAskRequest(call.id, call.input, message.createdAt);
  if ('error' in parsed) return;
  const prefix = 'The user answered:\n\n';
  const suffix = '\n\nWork to these answers. Do not ask again about anything settled here.';
  let content: string;
  if (result.output.startsWith(prefix) && result.output.endsWith(suffix)) {
    content = result.output.slice(prefix.length, -suffix.length);
    if (!content.startsWith('Q: ') || !content.includes('\nA: ')) return;
  } else if (result.output === ASK_CANCELLED || result.output === ASK_UNATTENDED) {
    const state = result.output === ASK_CANCELLED ? '(skipped / not answered)' : '(not answered: unattended time limit)';
    content = parsed.request.questions.map((q) => `Q: ${q.question}\nA: ${state}`).join('\n\n');
  } else return;
  return { id: `${message.id}_ask_reply`, role: 'user', content, createdAt: message.createdAt };
}

/**
 * Pure transcript model for the agent console: how a raw message list folds
 * into the blocks the console renders (tool calls, reasoning, narration, the
 * final answer), plus the small formatters those blocks share.
 */

/** One step of an assistant turn: a tool call, a reasoning block, or a bit of
 *  narration text between tools. Grouped into a single collapsible section. */
export type Activity =
  /** `startedAt`/`endedAt`: when the call was made and when its result came back, for the row's elapsed time. `failed`: its result was an error. */
  | { kind: 'tool'; call: ToolCall; result?: ToolResult; startedAt?: number; endedAt?: number; failed?: boolean }
  | { kind: 'reasoning'; text: string; duration: number | null }
  | { kind: 'note'; text: string };

/** A render block of the transcript: a message bubble (user or the final
 *  assistant answer) or a grouped run of the model's working steps. */
export type StreamBlock =
  | { type: 'msg'; message: ChatMessage }
  | { type: 'activity'; key: string; items: Activity[] };

/**
 * Fold a transcript into render blocks, collapsing each run of the model's
 * working steps (reasoning, tool calls, and inter-tool narration) into one
 * activity group so a many-step turn reads as a single expandable line instead
 * of a wall of "Used <tool>" rows. Only the final answer stays a bubble.
 */
export function toStreamBlocks(messages: ChatMessage[], context: ChatMessage[] = messages): StreamBlock[] {
  const calls = new Map<string, ToolCall>();
  const replies = new Map<ChatMessage, ChatMessage>();
  const answered = new Set<string>();
  for (const m of context) {
    if (m.role === 'assistant') for (const call of m.toolCalls ?? []) calls.set(call.id, call);
    if (m.role !== 'tool' || !m.toolResult) continue;
    const call = calls.get(m.toolResult.toolCallId);
    const reply = call && !answered.has(call.id) && askReply(call, m);
    if (reply) { replies.set(m, reply); answered.add(m.toolResult.toolCallId); }
  }
  const results = new Map(messages.flatMap((m) => m.toolResult ? [[m.toolResult.toolCallId, m.toolResult] as const] : []));
  const resultAt = new Map(messages.flatMap((m) => m.toolResult ? [[m.toolResult.toolCallId, m.createdAt] as const] : []));
  const blocks: StreamBlock[] = [];
  let run: Activity[] = [];
  let runKey = '';
  const flush = () => {
    if (run.length) { blocks.push({ type: 'activity', key: `act_${runKey}`, items: run }); run = []; }
  };
  /**
   * Narration the model wrote mid-run is speech, not a step.
   *
   * It used to fold into the collapsed activity group as a "Said" row, which
   * meant the model could explain what it was about to do and have that
   * explanation hidden behind a disclosure triangle: the one part of a run
   * written *to the reader* was the part the reader could not see. So it
   * leaves the group as its own bubble, and because a bubble cannot sit inside
   * the group, it also closes the run: the steps before it and the steps after
   * it become separate groups, which is the grouping the sequence already had.
   */
  const say = (m: ChatMessage, i: number) => {
    flush();
    blocks.push({ type: 'msg', message: { ...m, id: `${m.id}_said_${i}`, toolCalls: undefined } });
    runKey = `${m.id}_${i}_after`;
  };
  // The turn's answer is the last assistant message's own text, even when that
  // message also made tool calls, a run cut short by the loop detector, an abort,
  // or a model that concludes in the same message as its final tool call.
  // Without this its wrap-up would fold into the collapsed activity group and
  // vanish; mid-run narration still folds in as before.
  let lastAssistant = -1;
  messages.forEach((m, i) => { if (m.role === 'assistant') lastAssistant = i; });

  messages.forEach((m, i) => {
    if (m.role === 'tool') {
      const reply = replies.get(m);
      if (reply) { flush(); blocks.push({ type: 'msg', message: reply }); }
      return;
    }
    if (m.role === 'user') { flush(); blocks.push({ type: 'msg', message: m }); return; }
    // Assistant messages that still call tools are working steps; the one that
    // stops calling tools is the answer.
    if (m.toolCalls?.length) {
      const isFinalAnswer = i === lastAssistant && m.content.trim().length > 0;
      if (!run.length) runKey = `${m.id}_${i}`;
      if (m.reasoning) run.push({ kind: 'reasoning', text: m.reasoning, duration: m.reasoningSeconds ?? null });
      // Narration is written out in full as part of the conversation, and it
      // splits the run in two: what led up to it, and what it went on to do.
      if (m.content.trim() && !isFinalAnswer) say(m, i);
      // Delegations, watches and memory saves show their outcome on the step itself.
      m.toolCalls.forEach((c) => run.push({ kind: 'tool', call: c, startedAt: m.createdAt, endedAt: resultAt.get(c.id), ...(results.get(c.id)?.isError ? { failed: true } : {}), ...((c.name === 'spawn_agent' || c.name === 'agent_watch' || c.name === 'remember') && results.has(c.id) ? { result: results.get(c.id) } : {}) }));
      // Reasoning already has its inline activity projection above.
      if (isFinalAnswer) { flush(); blocks.push({ type: 'msg', message: { ...m, reasoning: undefined } }); }
    } else {
      flush();
      blocks.push({ type: 'msg', message: m });
    }
  });
  flush();
  return blocks;
}

/**
 * The transcript to draw while its newest turn is still being written by the
 * live run: everything up to and including the prompt that started it.
 *
 * The daemon checkpoints the chat after every tool result and the pane
 * re-reads it, so mid-turn the persisted copy already holds the turn's
 * narration and tool calls. The live run (liveRuns.ts) holds the same blocks
 * and draws them under the transcript, so drawing both showed the reply twice:
 * once as a settled bubble with a Done row, once streaming below it. The
 * persisted tail comes back as soon as the live run is released.
 */
export function transcriptBeforeLiveTurn(messages: ChatMessage[], transcriptThroughId?: string): ChatMessage[] {
  if (transcriptThroughId) {
    const tail = messages.findIndex((m) => m.id === transcriptThroughId);
    // A missing anchor (for example after compaction) must not hide saved history.
    return tail < 0 || tail === messages.length - 1 ? messages : messages.slice(0, tail + 1);
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return i === messages.length - 1 ? messages : messages.slice(0, i + 1);
  }
  return messages;
}

/** A PR card's own vertical margin, which used to set the gap after it. */
const PR_CARD_GAP = 8;

/**
 * One row of the windowed transcript: a message, working steps, or an anchored
 * PR lifecycle milestone. PR cards never live at a moving transcript tail.
 */
export type TranscriptRow =
  | { key: string; kind: 'msg'; message: ChatMessage; prUrls: string[]; displayOnly?: boolean; gapAfter?: number }
  | { key: string; kind: 'activity'; items: Activity[]; gapAfter?: number }
  | { key: string; kind: 'prs'; urls: string[]; event: 'created' | PrState; gapAfter?: number }
  /** A compaction summary: a divider under the turns it replaced, then the summary. */
  | { key: string; kind: 'compaction'; message: ChatMessage; latest: boolean; gapAfter?: number }
  /** A reply's stats when its last message was folded into working steps. */
  | { key: string; kind: 'stats'; stats: import('@nekko-agent/shared').TurnStats; gapAfter?: number };

/**
 * Fold a transcript into rows with PR discovery and resolution milestones.
 * Tool-only discoveries are anchored just like assistant/user mentions.
 * Keys are unique within the chat and stable as messages are appended.
 */
export function toTranscriptRows(
  messages: ChatMessage[],
  extractUrls: (text: string) => string[],
  collectUrls: (messages: ChatMessage[]) => string[],
  prs: PrInfo[] = [],
): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  // Identity membership is shared by every row, not a full history scan per row.
  const persisted = new Set(messages);
  const known = new Set(collectUrls(messages));
  const shown = new Set<string>();
  const anchors = new Map<number, Array<{ url: string; event: 'created' | PrState }>>();
  const add = (index: number, url: string, event: 'created' | PrState) => {
    const events = anchors.get(index) ?? [];
    events.push({ url, event });
    anchors.set(index, events);
  };
  // Anchor tool-only discoveries to their original turn, never to the moving tail.
  const contextTools = new Set(['read_file', 'grep', 'glob', 'list_dir']);
  const calls = new Map(messages.flatMap((m) => (m.toolCalls ?? []).map((c) => [c.id, c.name] as const)));
  messages.forEach((m, i) => {
    const tool = m.toolResult?.toolCallId ? calls.get(m.toolResult.toolCallId) : undefined;
    if (m.role !== 'tool' || (tool && contextTools.has(tool))) return;
    for (const url of extractUrls([m.content, m.toolResult?.output].filter(Boolean).join('\n'))) {
      if (!known.has(url) || shown.has(url)) continue;
      shown.add(url);
      add(i, url, 'created');
      const pr = prs.find((p) => p.url === url);
      if (pr && pr.state !== 'open') {
        const time = Date.parse((pr.state === 'merged' ? pr.mergedAt : pr.closedAt) ?? '');
        // Missing timestamps stay next to discovery, not after future messages.
        let terminal = i;
        if (Number.isFinite(time)) {
          for (let n = i; n < messages.length; n++) {
            if (messages[n].createdAt <= time) terminal = n;
            else break;
          }
        }
        add(terminal, url, pr.state);
      }
    }
  });
  const keys = new Set<string>();
  const unique = (k: string) => {
    let key = k;
    for (let n = 1; keys.has(key); n++) key = k + '~' + n;
    keys.add(key);
    return key;
  };
  let latestSummary: string | undefined;
  for (const m of messages) if (m.compaction) latestSummary = m.id;
  const append = (chunk: ChatMessage[]) => {
    for (const b of toStreamBlocks(chunk, messages)) {
      if (b.type !== 'msg') {
        rows.push({ key: unique(b.key), kind: 'activity', items: b.items });
        continue;
      }
      const m = b.message;
      if (m.compaction) {
        rows.push({ key: unique('c_' + m.id), kind: 'compaction', message: m, latest: m.id === latestSummary });
        continue;
      }
      if (m.role === 'assistant' && !m.content && !m.reasoning && !m.toolCalls?.length && !m.images?.length) continue;
      rows.push({ key: unique('m_' + m.id), kind: 'msg', message: m, prUrls: [], ...(persisted.has(m) ? {} : m.role === 'user' ? { displayOnly: true } : {}) });
    }
  };
  let start = 0;
  messages.forEach((m, i) => {
    const events = anchors.get(i);
    if (!events) return;
    append(messages.slice(start, i + 1));
    for (const e of events) rows.push({ key: unique('pr_' + e.url + '_' + e.event), kind: 'prs', urls: [e.url], event: e.event, gapAfter: PR_CARD_GAP });
    start = i + 1;
  });
  append(messages.slice(start));
  // Stats on a message that became working steps (a reply that ended on tool
  // calls) or that renders as no row: keep them in the transcript as their own
  // row, after the row that holds the message's work.
  const shownStats = new Set(rows.flatMap((r) => (r.kind === 'msg' && r.message.turnStats ? [r.message.id] : [])));
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.turnStats || shownStats.has(m.id)) continue;
    // After the last row that came from this message or anything before it.
    const at = messages.indexOf(m);
    let insert = rows.length;
    for (let n = at + 1; n < messages.length; n++) {
      const next = rows.findIndex((r) => r.kind === 'msg' && r.message.id === messages[n].id);
      if (next >= 0) { insert = next; break; }
    }
    rows.splice(insert, 0, { key: unique('s_' + m.id), kind: 'stats', stats: m.turnStats });
  }
  return rows;
}

/**
 * A first guess at a row's height (gap included) for a column `width` pixels
 * wide, used until the row has rendered and been measured. It only has to be
 * in the right neighbourhood: the scroll position is corrected as real sizes
 * come in.
 */
export function estimateRowHeight(row: TranscriptRow, width: number): number {
  const gap = row.gapAfter ?? 20;
  if (row.kind === 'activity') return 22 + gap;
  if (row.kind === 'prs') return row.urls.length * 90 + gap;
  if (row.kind === 'stats') return 18 + gap;
  // An older summary folds to its divider; the latest shows its text.
  if (row.kind === 'compaction') {
    return (row.latest ? 96 + Math.ceil(row.message.content.length / Math.max(30, width / 7.6)) * 21 : 40) + gap;
  }
  const m = row.message;
  const user = m.role === 'user';
  const perLine = Math.max(20, Math.floor(((user ? 0.85 : 1) * Math.max(240, width)) / 7.6));
  let lines = 0;
  for (const line of m.content.split('\n')) lines += Math.max(1, Math.ceil(line.length / perLine));
  const fences = (m.content.match(/```/g)?.length ?? 0) / 2;
  let h = lines * (user ? 22 : 23) + fences * 34 + (user ? 20 : 0);
  if (!user && m.reasoning) h += 26;
  if (!user && m.toolCalls?.length) h += m.toolCalls.length * 26;
  if (!user && m.turnStats) h += 18;
  // A generated picture renders up to 512 px wide at its own aspect; an attachment is a 104 px thumb.
  if (m.generated) h += Math.round((Math.min(512, width) * m.generated.height) / m.generated.width) + 28;
  else if (m.images?.length) h += 112;
  return h + row.prUrls.length * 90 + gap;
}

/** A stable-ish key per step (tool calls have ids; thoughts and notes don't). */
export function stepKey(it: Activity, i: number): string {
  return it.kind === 'tool' ? `${it.call.id}_${i}` : `${it.kind}_${i}`;
}

/** Calls shown their own way (delegations, watches, memory saves): never folded into a purpose group. */
const OWN_ROW_TOOLS = new Set(['spawn_agent', 'agent_watch', 'remember']);

/** A step of an activity run with its 1-based place in the run, which its row shows. */
export type IndexedActivity = { item: Activity; index: number };

/** A row of an open activity run: one step, or adjacent same-purpose calls folded into one goal row. */
export type ActivityRow =
  | { kind: 'step'; step: IndexedActivity }
  | { kind: 'group'; purpose: ToolPurpose; steps: IndexedActivity[]; calls: PurposeCall[] };

/**
 * An activity run's steps as purpose groups (spec/chat/tool-calls-grouped-by-purpose.md).
 * Adjacent calls with one purpose fold into a group; a thought between them
 * folds in with them. The call waiting for approval (`pendingCallId`), every
 * question and the calls with their own rows stay single, as does a lone call.
 */
export function activityRows(items: Activity[], pendingCallId?: string): ActivityRow[] {
  const steps = items.map((item, i) => ({ item, index: i + 1 }));
  return groupByPurpose(steps, ({ item }) => item.kind !== 'tool' ? undefined : {
    name: item.call.name,
    input: item.call.input,
    failed: item.failed,
    standalone: OWN_ROW_TOOLS.has(item.call.name) || item.call.id === pendingCallId,
  }).map((r) => r.kind === 'single' ? { kind: 'step', step: r.item } : { kind: 'group', purpose: r.purpose, steps: r.items, calls: r.calls });
}

export const fmtTok =(n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`);

// Formatters are built once: toLocaleTimeString() and toLocaleString() build a
// new one on every call, which is most of the cost of drawing a user bubble.
let timeFormat: Intl.DateTimeFormat | null | undefined;
let dateTimeFormat: Intl.DateTimeFormat | null | undefined;

function formatter(kind: 'time' | 'datetime'): Intl.DateTimeFormat | null {
  try {
    if (kind === 'time') return (timeFormat ??= new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' }));
    // The same fields Date#toLocaleString() fills in when given no options.
    return (dateTimeFormat ??= new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    }));
  } catch {
    return null;
  }
}

/** Short local time for a message timestamp (e.g. "3:42 PM"). */
export function fmtTime(ts: number): string {
  if (!ts) return '';
  try { return formatter('time')?.format(ts) ?? ''; }
  catch { return ''; }
}

/** Full local date and time, as Date#toLocaleString() writes it. */
export function fmtDateTime(ts: number): string {
  try { return formatter('datetime')?.format(ts) ?? new Date(ts).toLocaleString(); }
  catch { return ''; }
}

/** When a transcript row happened, for the swipe-left times: a message's send time, or a step run's first call. */
export function transcriptRowStamp(row: TranscriptRow): string | undefined {
  const at = row.kind === 'msg' || row.kind === 'compaction' ? row.message.createdAt
    : row.kind === 'activity' ? row.items.find((it) => it.kind === 'tool')?.startedAt
      : undefined;
  return at ? fmtTime(at) || undefined : undefined;
}
