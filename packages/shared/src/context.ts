/** Context assembly + provenance (powers the Context Inspector panel). */

export type ContextSource =
  | 'attached-file'
  | 'guideline'
  | 'memory'
  | 'connector'
  | 'index-snippet'
  | 'system'
  | 'conversation'
  | 'skill';

export interface ContextItem {
  id: string;
  source: ContextSource;
  /** Display label, e.g. a file path or "AGENTS.md" or memory title. */
  label: string;
  /** Where it came from (absolute path, connector id, etc.). */
  origin: string;
  /** Estimated tokens this item contributes. */
  tokens: number;
  /** Whether the user has pinned this item to always include it. */
  pinned: boolean;
  /** Whether currently included in the prompt. */
  included: boolean;
  /** Short preview of the content. */
  preview: string;
}

export interface ContextBundle {
  items: ContextItem[];
  totalTokens: number;
  /** Model context window for the headroom bar. */
  contextWindow?: number;
  /**
   * The full text behind each item, keyed by item id.
   *
   * Separate from `preview`, which is a 160-character display string: rendering
   * the prompt from previews truncated every attached file and guideline to 160
   * characters while reporting the token count of the whole thing. Optional
   * because this crosses the IPC boundary to the renderer, which only needs the
   * previews and should not be shipped every attached file to draw a list.
   */
  contents?: Map<string, string>;
}

/** Rough token estimate: ~4 chars per token. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * One stored message, as far as the window is concerned. Structurally a subset
 * of `ChatMessage`, so stored messages pass straight in.
 */
export interface HistoryMessage {
  role: string;
  content: string;
  reasoning?: string;
  toolCalls?: Array<{ name?: string; input?: unknown }>;
  /** A tool's output, under the field name `ToolResult` actually uses. */
  toolResult?: { output?: string };
  /** Set on a compaction summary; nothing before it is sent any more. */
  compaction?: unknown;
}

/**
 * Everything one stored message contributes to the next prompt.
 *
 * The transcript is replayed to the model without the stored reasoning, so a
 * turn costs its text, tool arguments, and tool output. On a long agentic run
 * tool traffic dwarfs the prose, while counting private reasoning that is not
 * sent back to the provider makes the window look full when it is not.
 */
export function historyText(m: HistoryMessage): string {
  const parts: string[] = [m.content ?? ''];
  for (const call of m.toolCalls ?? []) {
    parts.push(call.name ?? '');
    // Arguments are serialized on the wire, so their JSON is what occupies the
    // window rather than the object.
    if (call.input !== undefined) parts.push(safeJson(call.input));
  }
  const result = m.toolResult?.output;
  if (result) parts.push(result);
  return parts.filter(Boolean).join('\n');
}

/** Index of the latest compaction summary in a transcript, or -1. */
export function latestCompactionIndex(messages: Array<{ compaction?: unknown }>): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].compaction) return i;
  return -1;
}

/**
 * The part of a transcript a model is still sent: the latest compaction
 * summary and everything after it, or the whole transcript when it was never
 * compacted.
 */
export function sinceCompaction<T extends { compaction?: unknown }>(messages: T[]): T[] {
  const i = latestCompactionIndex(messages);
  return i < 0 ? messages : messages.slice(i);
}

/** How a compaction summary opens when it is sent to a model. */
export const COMPACTION_PREAMBLE = 'Summary of the earlier conversation, compacted to save context:';

/**
 * Wordings providers use when a request does not fit the model's context
 * window: OpenAI's "maximum context length", Anthropic's "prompt is too long",
 * llama.cpp's "exceeds the available context size", LM Studio's "context
 * length", the ChatGPT backend's "exceeds the context window". Plain substrings
 * (lower-cased) so the engine daemon's port (crates/nekko-loop) matches the
 * same set without a regex engine.
 */
export const CONTEXT_OVERFLOW_NEEDLES: readonly string[] = [
  'context length',
  'context_length',
  'context window',
  'context size',
  'maximum context',
  'max context',
  'prompt is too long',
  'prompt too long',
  'too many tokens',
  'exceeds the context',
  'exceed the context',
  'exceeds the maximum',
  'exceed_context_size',
  'input is too long',
  'input too long',
  'reduce the length of the messages',
  'n_ctx',
];

/**
 * Whether a model-call failure says the prompt no longer fits the context
 * window. A rate-limit message that happens to mention tokens is not one.
 */
export function isContextOverflowError(error: unknown): boolean {
  const lower = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase();
  if (lower.includes('rate limit') || lower.includes('rate_limit') || lower.includes('per min')) return false;
  return CONTEXT_OVERFLOW_NEEDLES.some((needle) => lower.includes(needle));
}

/** Estimated tokens a transcript occupies when replayed to the model. */
export function estimateTranscriptTokens(messages: HistoryMessage[]): number {
  const sent = sinceCompaction(messages);
  if (sent.length === 0) return 0;
  return estimateTokens(sent.map(historyText).join('\n'));
}

/** JSON for token counting. A value that cannot be serialized (a cycle) still
 *  has a size, so it falls back to its loose string form. */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}
