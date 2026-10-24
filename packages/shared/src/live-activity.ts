/**
 * What a chat is doing *right now*, folded from its event stream.
 *
 * The board reads sessions off disk, and a session on disk is a finished
 * transcript: while a turn is in flight its steps exist only as events, so a
 * card that renders the stored session can say "working 4m" and nothing about
 * what the four minutes went on. That is the one thing you open the Command
 * Center to find out, so the events are folded here instead — the same shape
 * the chat's own step rail shows, kept small enough to sit on a card.
 *
 * Pure and synchronous: the renderer keeps one of these per running session and
 * hands each event to `reduceLiveActivity`. Nothing here touches React, so the
 * folding is testable without a DOM.
 */

import type { AgentEvent } from './chat.js';
import { summarizeThought, summarizeToolCall, truncateWords } from './agent-steps.js';
import { trimTrailingSlashes } from './trim.js';

/** A thought, a tool call, or a line the model said between tools. */
export type LiveStepKind = 'thinking' | 'tool' | 'note';

export interface LiveStep {
  /** Stable within one run, so React keys don't churn as steps stream in. */
  id: string;
  kind: LiveStepKind;
  /** The tool's name, or "Thinking" / "Said". */
  label: string;
  /** One line: what the tool was pointed at, or where the thought landed. */
  detail: string;
  at: number;
  /** Tool steps only: still running, or how it came back. */
  status?: 'running' | 'ok' | 'error';
  /** Tool steps only: the head of what it returned. */
  result?: string;
}

export interface LiveActivity {
  steps: LiveStep[];
  /** The narration streaming right now, tail-trimmed. */
  tail: string;
  /** An image turn's stage ("Loading the image model"), which is all it reports. */
  image?: string;
  /** Reasoning streamed since the last step, not yet folded into one. */
  thinking: string;
  startedAt: number;
  updatedAt: number;
  inputTokens: number;
  outputTokens: number;
}

/** Steps kept per run. Older ones fall off the top; a card is not a transcript. */
export const LIVE_STEP_CAP = 6;
/** Characters of streaming narration kept. Enough to read the current thought. */
export const LIVE_TAIL_CHARS = 360;

export function emptyLiveActivity(now: number): LiveActivity {
  return { steps: [], tail: '', thinking: '', startedAt: now, updatedAt: now, inputTokens: 0, outputTokens: 0 };
}

/**
 * Fold one event into a session's live activity.
 *
 * Returns `undefined` when the run is over, which is the signal to drop the
 * entry: once the turn lands, the stored transcript says it better than a
 * half-remembered event stream, and a stale rail under a finished card is worse
 * than no rail at all.
 */
export function reduceLiveActivity(
  prev: LiveActivity | undefined,
  event: AgentEvent,
  now: number,
): LiveActivity | undefined {
  if (event.type === 'done' || event.type === 'error') return undefined;

  const a: LiveActivity = prev ? { ...prev, steps: [...prev.steps] } : emptyLiveActivity(now);
  a.updatedAt = now;

  switch (event.type) {
    case 'reasoning':
      a.thinking += event.delta;
      break;

    case 'text':
      // A thought that ends in narration is finished being thought.
      flushThinking(a, now);
      a.tail = tailOf(a.tail + event.delta);
      break;

    case 'tool_call': {
      flushThinking(a, now);
      flushNarration(a, now);
      push(a, {
        id: event.call.id,
        kind: 'tool',
        label: event.call.name,
        detail: summarizeToolCall(event.call, 70),
        at: now,
        status: 'running',
      });
      break;
    }

    case 'image_status':
      // An image turn has no narration; its stage is the whole story.
      a.image = event.label;
      break;

    case 'tool_approval_required':
      // The card shows the approval itself; recording it twice would put the
      // same command in the rail and in the buttons under it.
      break;

    case 'tool_result': {
      const step = lastRunningTool(a.steps, event.result.toolCallId);
      if (step) {
        const i = a.steps.indexOf(step);
        a.steps[i] = {
          ...step,
          status: event.result.isError ? 'error' : 'ok',
          result: firstLine(event.result.output),
        };
      }
      break;
    }

    case 'usage':
      a.inputTokens += event.inputTokens;
      a.outputTokens += event.outputTokens;
      break;

    case 'retry': {
      // The failed call's narration and thinking are gone with it; the rail
      // says the loop is trying again, so a card does not sit on "Thinking"
      // through a two-minute backoff.
      a.thinking = '';
      a.tail = '';
      if (event.paused) {
        // A background reply stepped aside for the person at the computer: it
        // carries on, from where it stood, once they are away.
        push(a, { id: `retry_${now}_${a.steps.length}`, kind: 'note', label: 'Paused', detail: 'Someone is using this computer, or it is on battery or hot. It carries on from here once it is free.', at: now });
        break;
      }
      push(a, {
        id: `retry_${now}_${a.steps.length}`,
        kind: 'note',
        label: 'Retrying',
        detail: `${event.attempt} of ${event.maxAttempts}, in ${Math.max(1, Math.round(event.delayMs / 1000))} s: ${truncateWords(event.reason.replace(/\s+/g, ' '), 50)}`,
        at: now,
      });
      break;
    }

    default:
      break;
  }

  return a;
}

/** Turn buffered reasoning into a step. Silent when there is nothing worth one. */
function flushThinking(a: LiveActivity, now: number): void {
  const text = a.thinking.trim();
  a.thinking = '';
  if (text.length < 12) return;
  push(a, {
    id: `think_${now}_${a.steps.length}`,
    kind: 'thinking',
    label: 'Thinking',
    detail: summarizeThought(text, 70) || 'Worked it through',
    at: now,
  });
}

/** Turn narration the model has finished saying into a step. */
function flushNarration(a: LiveActivity, now: number): void {
  const text = a.tail.trim();
  a.tail = '';
  if (text.length < 12) return;
  push(a, {
    id: `note_${now}_${a.steps.length}`,
    kind: 'note',
    label: 'Said',
    detail: truncateWords(text.replace(/\s+/g, ' '), 70),
    at: now,
  });
}

function push(a: LiveActivity, step: LiveStep): void {
  a.steps.push(step);
  if (a.steps.length > LIVE_STEP_CAP) a.steps.splice(0, a.steps.length - LIVE_STEP_CAP);
}

/**
 * The step a result belongs to. Matched by call id when the ids line up, and
 * otherwise by "the tool still running", because some providers hand back a
 * result id that never appeared on the call.
 */
function lastRunningTool(steps: LiveStep[], toolCallId: string): LiveStep | undefined {
  const byId = steps.find((s) => s.kind === 'tool' && s.id === toolCallId);
  if (byId) return byId;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].kind === 'tool' && steps[i].status === 'running') return steps[i];
  }
  return undefined;
}

function tailOf(text: string): string {
  return text.length <= LIVE_TAIL_CHARS ? text : text.slice(text.length - LIVE_TAIL_CHARS);
}

function firstLine(output: string): string {
  const line = (output ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return truncateWords(line, 70);
}

/**
 * The verb each builtin tool is doing, for the few-word status line.
 *
 * A tool's name is what it is called, not what it is doing: "read_file" under a
 * spinner reads as jargon where "Reading ChatPane.tsx" reads as a sentence. An
 * unlisted tool (an MCP one) falls back to its own name, which is still better
 * than a generic word that could mean anything.
 */
const TOOL_VERBS: Record<string, string> = {
  read_file: 'Reading',
  write_file: 'Writing',
  edit_file: 'Editing',
  glob: 'Finding',
  grep: 'Searching',
  list_dir: 'Listing',
  bash: 'Running',
  spawn_agent: 'Delegating',
  ask_user: 'Asking',
  web_search: 'Searching',
  fetch_url: 'Fetching',
  update_plan: 'Planning',
  report_experiment: 'Recording',
  report_artifact: 'Recording',
  remember: 'Remembering',
  start_process: 'Starting',
  read_process: 'Checking',
  kill_process: 'Stopping',
};

/** Words kept in the short status. Five is the brief; the sixth is noise. */
const SHORT_STATUS_WORDS = 5;

/** The tail of a path, so a status says the file rather than its whole route. */
function shortTarget(detail: string): string {
  const first = detail.trim().split(/\s+/)[0] ?? '';
  // A path becomes its last segment; anything else is left as written, because
  // trimming a shell command at a slash would change what it says.
  if (/[\\/]/.test(first) && !first.includes(' ')) {
    const leaf = trimTrailingSlashes(first, true).split(/[\\/]/).pop();
    if (leaf) return leaf;
  }
  return first;
}

/** Cut to at most `words` words, without an ellipsis: this is a label, not prose. */
function firstWords(text: string, words = SHORT_STATUS_WORDS): string {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, words).join(' ');
}

/**
 * What the agent is doing right now, in a few words, present tense.
 *
 * This is the line under a streaming reply, and it replaced a hardcoded
 * "Streaming" that was true of every turn and therefore told you nothing. The
 * order is what the agent is *doing*, not what it last did: a running tool wins,
 * because that is where the time is going; then a thought in progress; then the
 * narration it is writing. Deliberately short enough not to reflow the line as
 * it changes.
 */
export function shortLiveStatus(a: LiveActivity | undefined): string {
  if (!a) return '';

  const last = a.steps[a.steps.length - 1];
  if (last?.kind === 'tool' && last.status === 'running') {
    const verb = TOOL_VERBS[last.label] ?? last.label;
    // A delegation's detail is already a plain sentence; its first word alone says nothing.
    if (last.label === 'spawn_agent') return last.detail ? firstWords(`${verb} ${last.detail.split(' · ')[0]}`, SHORT_STATUS_WORDS) : verb;
    const target = shortTarget(last.detail ?? '');
    // The verb is one word, so the target gets the rest of the budget.
    return target ? firstWords(`${verb} ${target}`, SHORT_STATUS_WORDS) : verb;
  }

  if (a.image) return a.image;
  // A background reply waiting for the person at the computer to leave.
  if (last?.kind === 'note' && last.label === 'Paused') return 'Paused';
  if (a.thinking.trim()) return 'Thinking';
  if (a.tail.trim()) return 'Writing reply';

  // After a tool returns the model is deciding its next action. Completed
  // steps and failures belong in the tool log, not in a present-tense label.
  if (last?.kind === 'tool') return 'Thinking';
  if (last) return 'Working';
  return 'Starting';
}

/**
 * The one line a card shows when there is no room for the rail: what the agent
 * is doing at this instant, in the present tense.
 */
export function describeLiveActivity(a: LiveActivity | undefined): string {
  if (!a) return '';
  if (a.thinking.trim()) return summarizeThought(a.thinking, 80) || 'Thinking';
  const last = a.steps[a.steps.length - 1];
  if (last?.kind === 'tool' && last.status === 'running') {
    return last.detail ? `${last.label} · ${last.detail}` : last.label;
  }
  if (a.tail.trim()) return truncateWords(a.tail.replace(/\s+/g, ' ').trim(), 80);
  if (last) return last.detail ? `${last.label} · ${last.detail}` : last.label;
  return 'Starting';
}
