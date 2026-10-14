import type { AgentEvent, ChatMessage, EffortLevel, ToolCall, ToolResult } from '@nekko-agent/shared';
import { COMPACTION_PREAMBLE, isContextOverflowError, latestCompactionIndex } from '@nekko-agent/shared';
import { ELIDE_ALL, applyElision, elidable, elisionFor } from './fit.js';
import type { Provider, ToolSpec } from '../providers/types.js';
import { BUILTIN_TOOLS } from './tools.js';
import { RUNAWAY_NOTE, createRunawayGuard } from './runaway.js';
import { INTERRUPTED_NOTE, RESUME_PROMPT, repairInterruptedHistory } from './resume.js';
import { LOOP_WRAP_UP_PROMPT, createLoopDetector, loopNote, loopNudge } from './progress.js';
import { MAX_STREAM_ATTEMPTS, ProviderHttpError, isTransientProviderError, retryDelayMs } from '../providers/errors.js';

/** Wait, or stop waiting the moment the run is aborted. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

export interface RunAgentOptions {
  sessionId: string;
  provider: Provider;
  model: string;
  system: string;
  /** Conversation so far (excluding system). New messages are appended in place. */
  history: ChatMessage[];
  tools?: ToolSpec[];
  /** Executes a tool call in the host and returns its result. */
  executeTool: (call: ToolCall) => Promise<ToolResult>;
  signal?: AbortSignal;
  /** Sampling temperature (from the effort setting). */
  temperature?: number;
  /**
   * The first retry wait after a transient model-call failure, which doubles
   * from there (default 1 s; see providers/errors.ts). Tests pass 0.
   */
  retryBaseDelayMs?: number;
  /** The effort setting itself, for models that take it instead of a temperature. */
  effort?: EffortLevel;
  /** Reasoning toggle passed to the provider (true/false/undefined = default). */
  think?: boolean;
  /**
   * When set, only the last N user-turn groups of `history` are sent to the
   * model (new messages are still appended to the full `history` array so the
   * caller persists the whole transcript). Cutting on user-message boundaries
   * keeps tool_use/tool_result pairs intact. Used by long-running run-driven
   * loops so they don't replay an ever-growing transcript every turn.
   */
  maxHistoryTurns?: number;
  /**
   * The model's context window in tokens. When set, older tool outputs are
   * elided from what is sent once the prompt nears it (fit.ts), so a long run
   * on a small local model keeps going instead of overflowing.
   */
  contextWindow?: number;
  /** Hard cap on tokens one provider response may generate (see MAX_OUTPUT_TOKENS_DEFAULT). */
  maxOutputTokens?: number;
  /**
   * Continue a run that stopped part-way rather than starting the turn over.
   * `history` is repaired first (see resume.ts) and the model is told to build on
   * what is already there, so the steps it already took are not repeated.
   */
  resume?: boolean;
  /**
   * Messages the user sent while the reply ran. Pulled at each tool boundary
   * (never mid-stream) and appended to `history` before the next model call,
   * so steering lands in the transcript without stopping the turn.
   */
  pullSteering?: () => ChatMessage[];
  /** Pass response headers up to the host (rate-limit capture). */
  onHeaders?: (headers: Headers) => void;
  /** Route-aware metering for hosts using failover; usage events alone do not identify a route. */
  onUsage?: (usage: { providerId: string; modelId: string; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }) => void;
  /** CP6 foundation: host-authorized replacement after transient retries exhaust.
   * Absent by default. The host must enforce Auto opt-in/pool/privacy policy.
   * One replacement per run; no completed tool is re-executed by this hook.
   */
  failover?: (error: unknown) => Promise<{
    provider: Provider;
    model: string;
    onHeaders?: (headers: Headers) => void;
    maxOutputTokens?: number;
  } | null>;
}

let counter = 0;
function id(prefix: string): string {
  counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
  return `${prefix}_${Date.now().toString(36)}_${counter}`;
}

/**
 * A chat that was an image chat carries replies that are only a picture. A
 * chat model neither receives assistant images nor accepts an empty turn from
 * every provider, so each becomes a line saying what was made; the stored
 * transcript is left as it is.
 */
export function asSeenByChatModel(m: ChatMessage): ChatMessage {
  if (m.role !== 'assistant' || !m.generated || m.content.trim()) return m;
  const g = m.generated;
  return { ...m, content: `[Generated a ${g.width}×${g.height} image with ${g.modelId.split('/').pop()}, seed ${g.seed}.]` };
}

/**
 * What of a compacted transcript a model is sent: the latest compaction
 * summary and what follows it. The summary is folded into the user message
 * after it (or becomes a user message of its own when nothing follows yet), so
 * the history still opens on a user turn and roles keep alternating, which
 * strict chat templates require. A transcript never compacted is returned
 * unchanged.
 */
export function fromLatestCompaction(history: ChatMessage[]): ChatMessage[] {
  const at = latestCompactionIndex(history);
  if (at < 0) return history;
  const marker = history[at];
  const summary = `${COMPACTION_PREAMBLE}\n\n${marker.content}`;
  const rest = history.slice(at + 1);
  if (rest[0]?.role === 'user') return [{ ...rest[0], content: `${summary}\n\n---\n\n${rest[0].content}` }, ...rest.slice(1)];
  return [{ id: marker.id, role: 'user', content: summary, createdAt: marker.createdAt }, ...rest];
}

/**
 * Window `history` to the last `turns` user-turn groups for sending to the
 * model. Cuts on a user-message boundary so the window always starts on a user
 * message and never splits a tool_use from its tool_result. Returns `history`
 * unchanged when `turns` is falsy or there are no more than `turns` user
 * messages, so normal chats (no limit) are unaffected.
 */
export function windowHistory(history: ChatMessage[], turns?: number): ChatMessage[] {
  if (!turns || turns < 1) return history;
  const userIdx: number[] = [];
  for (let i = 0; i < history.length; i++) if (history[i].role === 'user') userIdx.push(i);
  if (userIdx.length <= turns) return history;
  return history.slice(userIdx[userIdx.length - turns]);
}

/**
 * The agentic loop: stream a model response, run any tool calls, feed the
 * results back, and repeat until the model stops calling tools. Yields
 * normalized AgentEvents that the host forwards to the renderer.
 *
 * History is mutated to include the assistant + tool messages so callers can
 * persist the full transcript.
 */
/** What one streamed provider response accumulated. */
interface Turn {
  phase?: ChatMessage['phase'];
  text: string;
  reasoning: string;
  reasoningSeconds?: number;
  calls: ToolCall[];
  /** Set when the stream was cut off for degenerate repetition (see runaway.ts). */
  runaway?: boolean;
}

/**
 * How much of a degenerate stream is kept in the transcript. The head is the
 * part worth keeping (the model usually reasons well, then collapses), so we
 * keep that and drop the cycle rather than persisting tens of thousands of
 * characters of the same sentence.
 */
const RUNAWAY_KEEP_CHARS = 4_000;

function trimRunaway(s: string): string {
  return s.length <= RUNAWAY_KEEP_CHARS
    ? s
    : `${s.slice(0, RUNAWAY_KEEP_CHARS)}\n\n[…cut off here: the model started repeating itself.]`;
}

/** A response that produced no text, no reasoning, and no tool calls. Some local
 *  models occasionally stop cold mid-agent-loop (finish_reason "stop" with a
 *  single token); treating that as a completed turn makes the chat look like it
 *  silently died. We detect it so the loop can retry once with a nudge. */
function isEmptyTurn(t: Turn): boolean {
  return !t.text.trim() && !t.reasoning.trim() && t.calls.length === 0;
}

export async function* runAgent(opts: RunAgentOptions): AsyncGenerator<AgentEvent> {
  const tools = opts.tools ?? BUILTIN_TOOLS;
  let route = { provider: opts.provider, model: opts.model, onHeaders: opts.onHeaders, maxOutputTokens: opts.maxOutputTokens };
  let switched = false;
  // How many of the oldest bulky tool outputs this run elides from what it
  // sends (fit.ts). Only grows, so consecutive requests share their prefix.
  let elided = 0;
  // A context-overflow error gets one retry with everything eligible elided.
  let squeezed = false;
  /** Elidable tool outputs in the last request: whether a squeeze could still help. */
  let sentEligible = 0;

  // Stream one provider response, yielding its events and accumulating the
  // result into `turn`. `extraMessages` are appended to the sent history only
  // (never persisted) so a retry can nudge the model without polluting the
  // transcript. `sendTools` overrides the offered tools (the wrap-up pass
  // withholds them entirely).
  async function* stream(turn: Turn, extraMessages: ChatMessage[] = [], sendTools = tools): AsyncGenerator<AgentEvent> {
    let reasoningStartedAt = 0;
    // Text and reasoning are watched separately: a model can collapse into a
    // loop in either channel, and a repeat in one says nothing about the other.
    const textGuard = createRunawayGuard();
    const reasoningGuard = createRunawayGuard();
    // Our own controller so tripping the guard actually closes the connection
    // instead of leaving the server streaming into a dropped iterator.
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (opts.signal) {
      if (opts.signal.aborted) ctl.abort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const full = [...windowHistory(fromLatestCompaction(opts.history), opts.maxHistoryTurns).map(asSeenByChatModel), ...extraMessages];
    elided = elisionFor(opts.system, sendTools, full, opts.contextWindow, elided);
    sentEligible = elidable(full).length;
    const messages = applyElision(full, elided);

    try {
      for await (const chunk of route.provider.chat({
        model: route.model,
        messages,
        system: opts.system,
        tools: sendTools,
        temperature: opts.temperature,
        effort: opts.effort,
        think: opts.think,
        maxOutputTokens: route.maxOutputTokens,
        signal: ctl.signal,
        onHeaders: route.onHeaders,
      })) {
        switch (chunk.type) {
          case 'phase':
            turn.phase = chunk.phase;
            break;
          case 'text':
            if (reasoningStartedAt && turn.reasoningSeconds == null) {
              turn.reasoningSeconds = Math.round((Date.now() - reasoningStartedAt) / 1000);
            }
            turn.text += chunk.delta;
            yield { type: 'text', sessionId: opts.sessionId, delta: chunk.delta };
            if (textGuard.push(chunk.delta)) turn.runaway = true;
            break;
          case 'reasoning':
            if (!reasoningStartedAt) reasoningStartedAt = Date.now();
            turn.reasoning += chunk.delta;
            yield { type: 'reasoning', sessionId: opts.sessionId, delta: chunk.delta };
            if (reasoningGuard.push(chunk.delta)) turn.runaway = true;
            break;
          case 'tool_call':
            if (reasoningStartedAt && turn.reasoningSeconds == null) {
              turn.reasoningSeconds = Math.round((Date.now() - reasoningStartedAt) / 1000);
            }
            turn.calls.push(chunk.call);
            yield { type: 'tool_call', sessionId: opts.sessionId, call: chunk.call };
            break;
          case 'usage':
            opts.onUsage?.({ providerId: route.provider.config.id, modelId: route.model, inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens, cacheReadTokens: chunk.cacheReadTokens, cacheWriteTokens: chunk.cacheWriteTokens });
            yield {
              type: 'usage',
              sessionId: opts.sessionId,
              inputTokens: chunk.inputTokens,
              outputTokens: chunk.outputTokens,
              cacheReadTokens: chunk.cacheReadTokens,
              cacheWriteTokens: chunk.cacheWriteTokens,
              outputMs: chunk.outputMs,
            };
            break;
          case 'done':
            break;
        }
        // Cut a degenerate stream off here rather than waiting out the output
        // cap: it has stopped making progress and will not recover.
        if (turn.runaway) {
          ctl.abort();
          break;
        }
      }
    } catch (e) {
      // Our own abort surfaces as an AbortError; that isn't a failure to report.
      if (!turn.runaway) throw e;
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
    }
    if (reasoningStartedAt && turn.reasoningSeconds == null) {
      turn.reasoningSeconds = Math.round((Date.now() - reasoningStartedAt) / 1000);
    }
  }

  /**
   * One model call, sent again after a transient failure (an overloaded
   * provider, a stream that went quiet, a dropped connection; see
   * providers/errors.ts). Each attempt starts `turn` over from where it stood
   * before the call: a stream that died half-way is regenerated, not stitched,
   * and a `retry` event tells the UI to drop what the failed attempt showed.
   * Anything else, a stop the user asked for included, is thrown as before.
   */
  async function* streamWithRetry(turn: Turn, extraMessages: ChatMessage[] = [], sendTools = tools): AsyncGenerator<AgentEvent> {
    for (let attempt = 1; ; attempt++) {
      const before: Turn = { ...turn, calls: [...turn.calls] };
      try {
        yield* stream(turn, extraMessages, sendTools);
        return;
      } catch (e) {
        // The prompt no longer fits: send it once more with every older tool
        // output elided before giving up on the reply.
        if (!opts.signal?.aborted && !squeezed && isContextOverflowError(e) && elided < sentEligible) {
          squeezed = true;
          elided = ELIDE_ALL;
          Object.assign(turn, before, { calls: [...before.calls] });
          yield { type: 'retry', sessionId: opts.sessionId, attempt, maxAttempts: MAX_STREAM_ATTEMPTS, delayMs: 0, reason: 'The conversation no longer fits the context window: retrying with older tool output left out' };
          attempt = 0;
          continue;
        }
        if (opts.signal?.aborted || !isTransientProviderError(e)) throw e;
        if (attempt >= MAX_STREAM_ATTEMPTS) {
          if (switched || !opts.failover) throw e;
          const replacement = await opts.failover(e);
          if (!replacement || opts.signal?.aborted || replacement.provider.config.id === route.provider.config.id) throw e;
          switched = true;
          const previous = route;
          route = { ...replacement, onHeaders: replacement.onHeaders, maxOutputTokens: replacement.maxOutputTokens };
          Object.assign(turn, before, { calls: [...before.calls] });
          yield { type: 'retry', sessionId: opts.sessionId, attempt, maxAttempts: MAX_STREAM_ATTEMPTS, delayMs: 0, reason: 'Switching model after retry exhaustion' };
          opts.history.push({ id: id('switch'), role: 'user', content: `[Model switched from ${previous.provider.config.id}/${previous.model} to ${route.provider.config.id}/${route.model} after retry exhaustion. Continue from the existing transcript and tool results; do not repeat completed work.]`, createdAt: Date.now() });
          yield { type: 'steered', sessionId: opts.sessionId, messageId: opts.history[opts.history.length - 1].id };
          attempt = 0;
          continue;
        }
        const delayMs = retryDelayMs(attempt, e instanceof ProviderHttpError ? e.retryAfterMs : undefined, Math.random, opts.retryBaseDelayMs);
        Object.assign(turn, before, { calls: [...before.calls] });
        yield {
          type: 'retry',
          sessionId: opts.sessionId,
          attempt,
          maxAttempts: MAX_STREAM_ATTEMPTS,
          delayMs,
          reason: (e as Error).message,
        };
        await sleep(delayMs, opts.signal);
        if (opts.signal?.aborted) throw e;
      }
    }
  }

  /**
   * End a reply whose stream broke. Whatever the model produced up to that point
   * is kept in the transcript (dropping it is what made a timeout on a long reply
   * feel like the whole run was thrown away); any tool call it was part-way
   * through emitting is not, because the arguments may be truncated and it never
   * ran. The host has already checkpointed the steps before this one.
   */
  function* endInterrupted(turn: Turn, error: unknown): Generator<AgentEvent> {
    const partial = (turn.runaway ? trimRunaway(turn.text) : turn.text).trim();
    const reasoning = turn.reasoning.trim();
    if (partial || reasoning) {
      opts.history.push({
        id: id('msg'),
        role: 'assistant',
        content: [partial, INTERRUPTED_NOTE].filter(Boolean).join('\n\n'),
        ...(reasoning ? { reasoning, reasoningSeconds: turn.reasoningSeconds } : {}),
        ...(turn.phase ? { phase: turn.phase } : {}),
        interrupted: true,
        createdAt: Date.now(),
      });
    }
    yield {
      type: 'error',
      sessionId: opts.sessionId,
      // A stop the user asked for is not a failure, and shouldn't read as one.
      message: opts.signal?.aborted ? 'Stopped' : (error as Error).message,
    };
  }

  // Resuming: make the interrupted transcript valid to send again, then give the
  // model one transient turn to push against when the last thing in it is its own
  // cut-off reply (a transcript ending on a tool result already has its opening).
  let resumeExtra: ChatMessage[] = [];
  if (opts.resume) {
    repairInterruptedHistory(opts.history);
    if (opts.history[opts.history.length - 1]?.role === 'assistant') {
      resumeExtra = [{ id: id('nudge'), role: 'user', content: RESUME_PROMPT, createdAt: Date.now() }];
    }
  }

  // A transient nudge used to recover from an empty response (not persisted).
  const nudge: ChatMessage = {
    id: id('nudge'),
    role: 'user',
    content: 'Please continue and give your answer.',
    createdAt: Date.now(),
  };

  // Loop detection (progress.ts): the first trip nudges the model to change
  // course, the second ends the reply early through a wrap-up pass. There is no
  // tool-step limit: the loop runs until the model stops calling tools, a
  // safeguard trips, a stream fails, or the user stops it.
  const loops = createLoopDetector();
  let loopExtra: ChatMessage[] = [];
  let nudged = false;
  let loopReason = '';
  /** Tool round trips actually taken this reply (reported on `done`). */
  let steps = 0;

  for (let iter = 0; ; iter++) {
    if (opts.signal?.aborted) {
      yield { type: 'error', sessionId: opts.sessionId, message: 'Aborted' };
      return;
    }
    // Steering: what the user typed while the tools ran joins the transcript
    // here, at the step boundary, so the next call sees it without the turn
    // having been stopped and started over.
    if (iter > 0) {
      for (const m of opts.pullSteering?.() ?? []) {
        opts.history.push(m);
        yield { type: 'steered', sessionId: opts.sessionId, messageId: m.id };
      }
    }

    const turn: Turn = { text: '', reasoning: '', calls: [] };
    try {
      yield* streamWithRetry(turn, iter === 0 ? resumeExtra : loopExtra);
      loopExtra = [];
      // Empty response: retry once with a nudge before giving up so the turn
      // doesn't silently stall (common with some local models mid-loop).
      if (isEmptyTurn(turn) && !opts.signal?.aborted) {
        yield* streamWithRetry(turn, [nudge]);
      }
    } catch (e) {
      yield* endInterrupted(turn, e);
      return;
    }

    const { text, reasoning, reasoningSeconds, calls } = turn;

    // Still nothing after the retry: surface it instead of ending on a blank
    // bubble, so the user knows the turn ended and can try again.
    const stalled = isEmptyTurn(turn);
    const content = stalled
      ? '_The model returned an empty response and stopped. It may have run out of steam: try again, or rephrase._'
      : text;

    // Record the assistant message. A stream we cut off for looping keeps its
    // useful head, is annotated with why it stopped, and drops any tool call it
    // was mid-way through emitting (the arguments are not trustworthy).
    const assistantMsg: ChatMessage = turn.runaway
      ? {
          id: id('msg'),
          role: 'assistant',
          content: [trimRunaway(text).trim(), RUNAWAY_NOTE].filter(Boolean).join('\n\n'),
          ...(reasoning ? { reasoning: trimRunaway(reasoning), reasoningSeconds } : {}),
          createdAt: Date.now(),
        }
      : {
          id: id('msg'),
          role: 'assistant',
          content,
          ...(reasoning ? { reasoning, reasoningSeconds } : {}),
          toolCalls: calls.length ? calls : undefined,
          createdAt: Date.now(),
        };
    if (turn.phase) assistantMsg.phase = turn.phase;
    opts.history.push(assistantMsg);

    // A looping model does not recover by being asked again, so end the reply
    // here instead of spending more rounds on the same cycle.
    if (turn.runaway) {
      yield { type: 'done', sessionId: opts.sessionId, messageId: assistantMsg.id, stop: 'runaway', steps };
      return;
    }

    // No tool calls → the turn is complete.
    if (calls.length === 0 && turn.phase !== 'commentary') {
      yield { type: 'done', sessionId: opts.sessionId, messageId: assistantMsg.id, stop: 'complete', steps };
      return;
    }

    if (calls.length) steps++;
    // The request for these tools is in the transcript now; the host saves it
    // here, so a tool that never returns still leaves the step on disk.
    yield { type: 'step', sessionId: opts.sessionId, messageId: assistantMsg.id };
    // Execute tool calls sequentially (the host applies guardrails/approval).
    let tripped: string | undefined;
    for (const call of calls) {
      let result: ToolResult;
      try {
        result = await opts.executeTool(call);
      } catch (e) {
        result = { toolCallId: call.id, output: `Error: ${(e as Error).message}`, isError: true };
      }
      opts.history.push({
        id: id('msg'),
        role: 'tool',
        content: '',
        toolResult: result,
        createdAt: Date.now(),
      });
      yield { type: 'tool_result', sessionId: opts.sessionId, result };
      tripped ??= loops.push(call, result);
    }

    if (tripped) {
      if (nudged) {
        loopReason = tripped;
        break;
      }
      nudged = true;
      loops.reset();
      loopExtra = [{ id: id('nudge'), role: 'user', content: loopNudge(tripped), createdAt: Date.now() }];
    }
  }

  // The loop detector tripped twice. Instead of discarding
  // everything the model just did (which is what surfacing an error here used
  // to do), take one last pass with the tools withheld so the work comes back
  // as a real answer the user can act on.
  if (opts.signal?.aborted) {
    yield { type: 'error', sessionId: opts.sessionId, message: 'Aborted' };
    return;
  }
  const wrapUp: Turn = { text: '', reasoning: '', calls: [] };
  try {
    yield* streamWithRetry(
      wrapUp,
      [{ id: id('nudge'), role: 'user', content: LOOP_WRAP_UP_PROMPT, createdAt: Date.now() }],
      [],
    );
  } catch (e) {
    yield* endInterrupted(wrapUp, e);
    return;
  }

  const note = wrapUp.runaway ? RUNAWAY_NOTE : loopNote(loopReason);
  const wrapText = (wrapUp.runaway ? trimRunaway(wrapUp.text) : wrapUp.text).trim();
  const wrapMsg: ChatMessage = {
    id: id('msg'),
    role: 'assistant',
    content: wrapText ? `${wrapText}\n\n${note}` : note,
    ...(wrapUp.reasoning
      ? {
          reasoning: wrapUp.runaway ? trimRunaway(wrapUp.reasoning) : wrapUp.reasoning,
          reasoningSeconds: wrapUp.reasoningSeconds,
        }
      : {}),
    createdAt: Date.now(),
  };
  if (wrapUp.phase) wrapMsg.phase = wrapUp.phase;
  opts.history.push(wrapMsg);
  yield { type: 'done', sessionId: opts.sessionId, messageId: wrapMsg.id, stop: 'loop', steps };
}
