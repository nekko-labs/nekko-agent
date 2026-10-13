/** Chat / agent conversation types. */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  /** Text or JSON-serializable output shown back to the model. */
  output: string;
  /** Approved screenshot PNG data URLs delivered to the selected model. */
  images?: string[];
  isError?: boolean;
}

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  /** Responses API distinction between working commentary and the final answer. */
  phase?: 'commentary' | 'final_answer';
  /**
   * Image data URLs: attached by the user on a user message, or produced by an
   * image model on an assistant message in an image-generation chat.
   */
  images?: string[];
  /** How an assistant message's images were made, so they can be reproduced. */
  generated?: GeneratedImageMeta;
  /** Model chain-of-thought text, when the provider streams it. */
  reasoning?: string;
  /** Whole seconds spent streaming the reasoning text. */
  reasoningSeconds?: number;
  /** Skill invoked for this user turn and the user's own input. */
  skill?: { name: string; input: string };
  /** Tool calls requested by the assistant in this message. */
  toolCalls?: ToolCall[];
  /** Tool results (for role === 'tool'). */
  toolResult?: ToolResult;
  /**
   * This reply was cut off before it finished (the stream timed out, the network
   * dropped, or the user hit stop). What the model had produced is kept rather
   * than discarded, and the chat offers to resume from here.
   */
  interrupted?: boolean;
  /**
   * This message is a compaction summary: it stands in for every message
   * before it. The earlier messages stay in the transcript so the chat can
   * still show them, but from here on a model is sent this summary and what
   * follows it, never what came before (`sinceCompaction`).
   */
  compaction?: { summarized: number };
  /**
   * Measurements for the reply this message ends, recorded by the host when the
   * turn finishes. On the last assistant message of a turn only. Counts and
   * identifiers only, never prompt or reply text.
   */
  turnStats?: TurnStats;
  createdAt: number;
}

/**
 * What one reply cost and what produced it. Kept in the transcript so a chat
 * that switched models shows which stretch ran on which, and in the reply log
 * for later analysis.
 */
export interface TurnStats {
  providerId: string;
  modelId: string;
  /** The effort the request was sent with, after the model's own clamp. */
  effort?: import('./settings.js').EffortLevel;
  /** Summed over every model call in the reply (tool round trips included). */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Decode time summed over calls, when the provider reported it. */
  outputMs?: number;
  /** Wall time from send to done, tools and approvals included. */
  wallMs: number;
  /** Model calls in the reply. */
  calls: number;
  steps?: number;
  stop?: ReplyStop;
}

/** Per-session Context Inspector preferences (which provenance items the user
 *  excluded or pinned), keyed by context item id. Persisted with the session. */
export interface ContextPrefs {
  excluded: string[];
  pinned: string[];
}

/**
 * How a chat handles tool execution:
 *  - `ask`, confirm every file write / command before it runs.
 *  - `guardrails`, run freely except where the guardrail rules say ask/deny.
 *  - `yolo`, run everything without confirming (deny rules still block).
 */
export type ChatMode = 'ask' | 'guardrails' | 'yolo';

/**
 * What a chat is for. `multimodal` (the default, and what an absent value
 * means) talks to a chat model with text and images in and text out.
 * `image` sends each prompt to a local image-generation model instead, and
 * every reply is a picture.
 */
export type ChatType = 'multimodal' | 'image';

/** An image-generation chat's settings, kept per chat. */
export interface ImageChatParams {
  /** An engine library model with `modality: 'image'`. */
  modelId?: string;
  width: number;
  height: number;
  steps: number;
  cfgScale: number;
  /** -1 picks a fresh random seed per image; the one used is recorded on the reply. */
  seed: number;
}

export const DEFAULT_IMAGE_CHAT_PARAMS: ImageChatParams = { width: 1024, height: 1024, steps: 28, cfgScale: 4.5, seed: -1 };

export interface GeneratedImageMeta {
  modelId: string;
  width: number;
  height: number;
  steps: number;
  cfgScale: number;
  /** The seed actually used, never -1. */
  seed: number;
  /** Wall time for the request, model load included when it had to load. */
  ms: number;
}

export interface ImageTurnOptions {
  sessionId: string;
  prompt: string;
  params: ImageChatParams & { modelId: string };
}

export interface Session {
  id: string;
  title: string;
  workspaceId?: string;
  /** Opt-in marker written only on new chats; older sessions keep their checkout. */
  executionMode?: ExecutionMode;
  sandbox?: SandboxIdentity;
  gitIsolation?: boolean;
  /** Explicit dependent work, pinned when Continue as stacked PR is selected. */
  gitStackParent?: { workspaceId: string; url: string; branch: string; sha: string };
  gitWorktrees?: Record<string, { sourceRoot: string; root: string; path: string; branch: string; notice: string }>;
  /** Additional context folders for this chat; workspaceId remains primary. */
  supportingWorkspaceIds?: string[];
  /**
   * When set, this session was spawned as a sub-agent by another session. The
   * workbench nests it as a sub-tab under its parent; the agent loop reports its
   * final answer back to the parent's `spawn_agent` tool call.
   */
  parentSessionId?: string;
  /** When set, this chat is driven by an automation task (shown in the Tasks
   *  board, kept out of the regular chat boards/lanes). */
  taskId?: string;
  /** When set, this chat is driven by a training/goal run (shown in the
   *  Training/Goals tabs, kept out of the regular chat boards/lanes; the
   *  report_experiment tool becomes available to the agent). */
  trainingRunId?: string;
  providerId?: string;
  modelId?: string;
  messages: ChatMessage[];
  contextPrefs?: ContextPrefs;
  /** Files explicitly attached to this chat's context (absolute paths). */
  attachedPaths?: string[];
  /** When set, the chat keeps a spec.md in the workspace updated each turn. */
  specLinked?: boolean;
  /** Spec-driven methodology id for this chat (see SPEC_METHODOLOGIES). */
  specMethodology?: string;
  /** When set, the chat picks the best model per turn (model auto-mode). */
  autoModel?: boolean;
  /**
   * How hard Auto mode leans on capability for this chat: `cheap` always takes
   * the smallest capable model, `quality` always the strongest, `normal` (the
   * default) reads each prompt and picks between them.
   */
  autoQuality?: import('./model-select.js').AutoQuality;
  /**
   * When true, Auto mode may move a turn to an equivalent model on another
   * provider when this chat's provider is spent (its binding usage window is
   * exhausted or past the switch threshold) or when an equivalent model
   * elsewhere is materially cheaper. Off by default: the pick never
   * downgrades capability, and the reason is shown on the turn.
   */
  autoProviderSwitch?: boolean;
  /** Tool-execution policy for this chat. */
  mode?: ChatMode;
  /** Chat or image generation; absent means `multimodal`. */
  chatType?: ChatType;
  /** Settings for an image-generation chat. */
  imageParams?: ImageChatParams;
  /**
   * Per-chat reasoning toggle for models that support it: `true` forces thinking
   * on, `false` suppresses it, `undefined` leaves the model's default. Only
   * offered in the UI when the selected model is reasoning-capable.
   */
  thinking?: boolean;
  /** Tool names the user disabled for this chat (subset of the builtins). */
  disabledTools?: string[];
  /** Offline: no tool calls, no connectors/internet (local models only). */
  offline?: boolean;
  /** Incognito: don't persist the transcript or touch memory. */
  incognito?: boolean;
  /** Pinned to the top of the chat list. */
  pinned?: boolean;
  /** Free-form tags for organizing/filtering chats. */
  tags?: string[];
  /** Queued prompts to run one after another when the current turn finishes. */
  queue?: QueuedPrompt[];
  /**
   * Set while a turn is running, cleared when it ends. A session that still
   * carries this when the host starts was cut off by a crash or a quit, and the
   * host marks its last reply interrupted so the chat offers Continue.
   */
  activeRun?: { startedAt: number };
  /**
   * The plan for the prompt this chat is working on: decoded from the prompt,
   * then whatever the user edited it into. Lives on the session so the rail
   * survives a tab switch, and so a chat resumed tomorrow still shows what it
   * was told to do.
   */
  plan?: import('./prompt-plan.js').PromptPlan;
  /**
   * The plan the agent itself wrote for this chat, via the `update_plan` tool:
   * what it decided to do after reading the request, kept live as it works.
   * Distinct from `plan`, which is the user's editable draft decoded from the
   * prompt.
   */
  agentPlan?: import('./training.js').PlanStep[];
  /**
   * The title was written by the app (the prompt prefix or a summarization),
   * so a better summary may replace it. Any title the user typed flips this off.
   */
  titleAuto?: boolean;
  /** Manual sidebar position within its project (set by drag-to-reorder). */
  order?: number;
  /**
   * When the chat was archived (epoch ms). An archived chat leaves the
   * workspace list but keeps its transcript, readable from the Archived list
   * until it is restored or `ARCHIVE_RETENTION_DAYS` pass, when it is deleted.
   * Absent (or null, once restored) means the chat is live.
   */
  archivedAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

/** Return the primary and supporting context folders in stable, de-duplicated order. */
export function getSessionWorkspaceIds(
  session: Pick<Session, 'workspaceId' | 'supportingWorkspaceIds'>,
): string[] {
  return Array.from(new Set([
    ...(session.workspaceId ? [session.workspaceId] : []),
    ...(session.supportingWorkspaceIds ?? []).filter(Boolean),
  ]));
}

/** Time window for bulk chat deletion. */
export type ChatClearScope = 'today' | 'month' | 'all';

/** How a reply ended (see the `done` event). */
export type ReplyStop = 'complete' | 'loop' | 'runaway';

/** Streaming events emitted by the agent loop. */
/**
 * A compaction's state, as the chat shows it. `done`/`total` count the summary
 * calls: one per transcript chunk, plus a merge pass when there were several.
 * `target` says where the summary lands: this chat, or a new one it opens
 * (`newSessionId`, once that exists).
 */
export interface CompactionProgress {
  state: 'running' | 'done' | 'failed' | 'cancelled';
  done: number;
  total: number;
  target: 'here' | 'new';
  newSessionId?: string;
  error?: string;
}

export type AgentEvent =
  | { type: 'text'; sessionId: string; delta: string }
  | { type: 'reasoning'; sessionId: string; delta: string }
  | { type: 'tool_call'; sessionId: string; call: ToolCall }
  | { type: 'tool_approval_required'; sessionId: string; call: ToolCall; reason: string; severity: 'low' | 'medium' | 'high' }
  | { type: 'tool_result'; sessionId: string; result: ToolResult }
  /** The agent stopped to ask before carrying on. See `ask.ts`. */
  | { type: 'question'; sessionId: string; request: import('./ask.js').AskRequest }
  /** The question was answered or dropped, so anything showing it can stop. */
  | { type: 'question_resolved'; sessionId: string; callId: string }
  | {
      type: 'usage';
      sessionId: string;
      inputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      outputTokens: number;
      /**
       * Milliseconds the model spent generating `outputTokens` (decode only, no
       * prompt processing and no time between responses). The chat's tok/s
       * readout divides by the sum of these rather than by the turn's wall clock,
       * which also covers tool runs and approval waits. Absent when the provider
       * gave us nothing to measure.
       */
      outputMs?: number;
    }
  /** An image-generation turn moved on: loading the model, then generating. */
  | { type: 'image_status'; sessionId: string; stage: 'loading' | 'generating'; label: string }
  | {
      type: 'done';
      sessionId: string;
      messageId: string;
      /**
       * Why the reply ended: it finished, the loop detector stopped it
       * (progress.ts), or a stream collapsed into repetition. Absent from
       * older engines.
       */
      stop?: ReplyStop;
      /** Tool round trips the reply took. */
      steps?: number;
    }
  | { type: 'error'; sessionId: string; message: string }
  /**
   * A model call failed in a way worth trying again (the provider was
   * overloaded, a stream went quiet, the network dropped) and the loop is about
   * to send it again after `delayMs`. Whatever the failed call streamed is
   * discarded and regenerated, so anything showing the live reply should drop
   * the text and reasoning since the last `tool_result` (or the turn's start).
   */
  | { type: 'retry'; sessionId: string; attempt: number; maxAttempts: number; delayMs: number; reason: string }
  /**
   * The assistant message that asks for tool calls has been appended to the
   * transcript and the tools are about to run. The host checkpoints here, so a
   * tool that never returns (or a host that dies while it runs) leaves the
   * request on disk instead of losing the whole step.
   */
  | { type: 'step'; sessionId: string; messageId: string }
  /**
   * A message the user sent while the reply ran was folded into the
   * transcript at a tool boundary (`chat:steer`); the next model call sees it.
   */
  | { type: 'steered'; sessionId: string; messageId: string }
  /** How a compaction of this chat is going (`compaction.ts` in the host). */
  | { type: 'compaction'; sessionId: string; progress: CompactionProgress }
  /**
   * The session record changed outside the event stream (its plan, its title),
   * so anything showing it should re-read it. Emitted mid-turn, which is why it
   * is an event rather than something a listener polls for.
   */
  | { type: 'session_meta'; sessionId: string };

/**
 * What a session is waiting on a person for, right now.
 *
 * Kept in the host rather than in whichever component happened to see the
 * event: a question asked while you were on another screen is still a question,
 * and the board has to be able to ask "who needs me" without having watched
 * every session's event stream since it started.
 */
export interface PendingInput {
  sessionId: string;
  /** A tool call waiting on approve/deny. */
  approval?: {
    call: ToolCall;
    reason: string;
    severity: 'low' | 'medium' | 'high';
    requestedAt: number;
  };
  /** An `ask_user` call waiting on answers. */
  question?: import('./ask.js').AskRequest;
}

/**
 * Output tokens per second, measured over the time the model spent generating
 * them (the summed `outputMs` of a turn's usage events), not over how long the
 * user waited. A turn that generates 500 tokens in 10 seconds and then runs a
 * 40-second test suite ran at 50 tok/s, not 10.
 *
 * Returns 0 when there is nothing to divide, which the UI reads as "no rate to
 * show" rather than printing a zero.
 */
export function decodeRate(outputTokens: number, decodeMs: number): number {
  if (!Number.isFinite(outputTokens) || !Number.isFinite(decodeMs) || outputTokens <= 0 || decodeMs < 100) return 0;
  return outputTokens / (decodeMs / 1000);
}

/** -1 marks an unmeasurable turn; never pair untimed tokens with another step's time. */
export function accumulateDecodeMs(total: number, outputTokens: number, outputMs?: number): number {
  if (outputTokens <= 0) return total;
  if (total < 0 || outputMs === undefined || !Number.isFinite(outputMs) || outputMs < 100) return -1;
  return total + outputMs;
}

/**
 * Render a tokens/second rate. Local models routinely run in the single digits,
 * where rounding to a whole number hides the difference between 8.6 and 9.4, so
 * slow rates keep one decimal and fast ones stay tidy.
 */
export function formatRate(tokensPerSecond: number): string {
  return tokensPerSecond >= 10 ? String(Math.round(tokensPerSecond)) : tokensPerSecond.toFixed(1);
}

/**
 * Whether a run that stopped part-way has anything worth resuming: a completed
 * step, a tool result, or the head of a reply that was cut off. A run that broke
 * before the model said anything has nothing to carry on from, so the chat offers
 * to simply run it again instead of offering to continue from nothing.
 */
/**
 * Whether the transcript ends on a reply that was cut off: the last message of
 * the current turn is an assistant message marked `interrupted`, or a tool call
 * the model asked for that never got its result. A chat opened on such a
 * transcript (after a restart, say) shows the interruption and offers Continue
 * even though no `error` event is around to announce it.
 */
export function lastReplyInterrupted(history: ChatMessage[]): boolean {
  const last = history[history.length - 1];
  if (!last || last.role === 'user') return false;
  // Explicit interruption markers remain authoritative, including a partial
  // assistant reply followed by results from tools that were already running.
  let turnStart = history.length - 1;
  while (turnStart >= 0 && history[turnStart].role !== 'user') turnStart--;
  const turn = history.slice(turnStart + 1);
  const lastAssistant = [...turn].reverse().find((m) => m.role === 'assistant');
  if (lastAssistant?.interrupted) return true;
  const results = new Set(turn.flatMap((m) => m.toolResult ? [m.toolResult.toolCallId] : []));
  return turn.some((m) => m.role === 'assistant' && m.toolCalls?.some((call) => !results.has(call.id)));
}

export function hasResumableProgress(history: ChatMessage[]): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === 'user') return false; // reached this turn's prompt, nothing after it
    if (m.role === 'tool') return true;
    if (m.role === 'assistant' && (m.content.trim() || m.toolCalls?.length || m.reasoning?.trim() || m.images?.length)) return true;
  }
  return false;
}

export interface QueuePayload {
  text: string;
  /** Image data URLs attached to this queued user turn. */
  images?: string[];
  /** Skill invoked for this queued user turn and the user's own input. */
  skill?: { name: string; input: string };
}

/** Queue entries are kept backwards-compatible with older string-only sessions. */
export type QueuedPrompt = string | QueuePayload;

export function queueItemText(item: QueuedPrompt): string {
  return typeof item === 'string' ? item : item.text;
}

export function queueItemPayload(item: QueuedPrompt): QueuePayload {
  return typeof item === 'string' ? { text: item } : item;
}

export function queueItemsEqual(a: QueuedPrompt, b: QueuedPrompt): boolean {
  return JSON.stringify(queueItemPayload(a)) === JSON.stringify(queueItemPayload(b));
}

export interface SendOptions {
  sessionId: string;
  providerId: string;
  modelId: string;
  text: string;
  /** Image data URLs attached to this user turn. */
  images?: string[];
  /** Skill invoked for this user turn and the user's own input. */
  skill?: { name: string; input: string };
  /** File paths the user explicitly attached as context. */
  attachedPaths?: string[];
  /** Re-answer the last user turn: drop trailing assistant/tool messages and
   *  don't append a new user message. */
  regenerate?: boolean;
  /**
   * Carry on from a run that stopped part-way instead of starting it again.
   * Nothing is appended to the transcript and nothing is dropped from it: the
   * agent picks up after the last thing that completed, so the steps already
   * taken (and the tool results they produced) are not repeated. `text` is
   * ignored. See `regenerate` for the destructive alternative.
   */
  resume?: boolean;
  /**
   * Only send the last N user-turn groups to the model (the full transcript is
   * still persisted). Used by long-running run-driven turns (Goals/Training) so
   * a loop that spans hundreds of turns doesn't replay its whole ever-growing
   * history to the model each turn. Omitted for normal chats (full history).
   */
  maxHistoryTurns?: number;
}

/**
 * What the model thinks the user might say next, generated after a reply.
 * `options` are the one-click follow-ups under the transcript; `next` is the
 * fuller message shown as ghost text in the composer.
 */
export interface ReplySuggestions {
  options: string[];
  next: string | null;
}

/** A suggestion chip stays a chip: past this it's a paragraph, not an option. */
const SUGGESTION_OPTION_MAX = 120;
const SUGGESTION_NEXT_MAX = 240;

function cleanSuggestion(text: string, max: number): string {
  return text
    .replace(/^[-*•\d]+[.)]?\s+/, '') // bullet or numbered-list marker
    .replace(/^["'`,]+|["'`,]+$/g, '') // quote wrappers, and a trailing comma off a JSON fragment
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Read the suggestion call's answer. The prompt asks for one JSON object
 * (`{"options": [...], "next": "..."}`) and most models comply; small local
 * models drift, so a bare-lines read stands in for it: each non-empty line is
 * an option and the first is the ghost text. Returns null when nothing usable
 * came back.
 */
export function parseReplySuggestions(raw: string): ReplySuggestions | null {
  const braces = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (braces >= 0 && lastBrace > braces) {
    try {
      const parsed = JSON.parse(raw.slice(braces, lastBrace + 1)) as {
        options?: unknown;
        next?: unknown;
        suggestion?: unknown;
        draft?: unknown;
      };
      const options = (Array.isArray(parsed.options) ? parsed.options : [])
        .map((o) => (typeof o === 'string' ? cleanSuggestion(o, SUGGESTION_OPTION_MAX) : ''))
        .filter(Boolean);
      const nextRaw = [parsed.next, parsed.suggestion, parsed.draft].find((v) => typeof v === 'string');
      const next = typeof nextRaw === 'string' ? cleanSuggestion(nextRaw, SUGGESTION_NEXT_MAX) : null;
      // Valid JSON that came back empty is a real "no suggestions" answer; the
      // line read below would only re-serve the object's own fragments.
      if (options.length || next) return { options: dedupeSuggestions(options).slice(0, 4), next };
      return null;
    } catch {
      /* fall through to the line read */
    }
  }
  const options = dedupeSuggestions(
    raw
      .split(/\r?\n/)
      // JSON-ishness is judged on the raw line, before cleaning strips the
      // quotes that mark a fragment like `"options": [`.
      .map((line) => line.trim())
      .filter(
        (line) =>
          line &&
          !/^[{}[\],]/.test(line) &&
          !/^["'][A-Za-z_]+["']\s*:/.test(line) &&
          !/^(options|next|suggestion|draft)\s*:/i.test(line),
      )
      .map((line) => cleanSuggestion(line, SUGGESTION_OPTION_MAX))
      .filter(Boolean),
  ).slice(0, 4);
  if (!options.length) return null;
  return { options, next: options[0] };
}

function dedupeSuggestions(options: string[]): string[] {
  const seen = new Set<string>();
  return options.filter((o) => {
    const key = o.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Explicit execution mode is authoritative; legacy sessions retain their previous behavior. */
export type ExecutionMode = 'sandbox' | 'worktree' | 'unified';
export interface SandboxIdentity { image: string; identity: string; configuredAt: number; sourceWorkspaceIds: string[] }
export interface SandboxStatus { mode: ExecutionMode; phase: 'unconfigured' | 'configured' | 'ready' | 'error'; identity?: string; image?: string; error?: string; applySupported: false }
export interface SandboxDiff { identity: string; diffId: string; changes: Array<{ path: string; before: string | null; after: { path: string; base64: string; hash: string } | null }> }
export function getExecutionMode(session?: Pick<Session, 'executionMode' | 'gitIsolation'>): ExecutionMode {
  return session?.executionMode ?? (session?.gitIsolation === false ? 'unified' : 'worktree');
}
