import type { ChatMessage } from '@nekko-agent/shared';

/**
 * Picking a run back up after it stopped part-way.
 *
 * A long agent run is a sequence of completed steps, and losing all of them
 * because the last one timed out is the difference between "carry on" and "start
 * the whole thing again". The host checkpoints each step to disk as it lands and
 * the loop keeps the text of a reply that was cut off, so what survives an
 * interruption is a real transcript. It just isn't always a *valid* one: a run
 * killed between the model asking for a tool and the tool answering leaves a
 * request with no result, which every provider rejects.
 *
 * Repairing that gap is what lets the same transcript be sent again.
 */

/** Appended to a reply whose stream broke, so the transcript says what happened. */
export const INTERRUPTED_NOTE =
  '_This reply was cut off before it finished. Everything above is kept, resume to carry on from here._';

/** Stands in for a tool call that was requested but never got to run. */
export const INTERRUPTED_TOOL_OUTPUT =
  'This tool call did not run: the reply was interrupted first. Call it again if you still need the result.';

/**
 * Injected as one transient user turn when resuming. It is never persisted, so
 * the transcript keeps reading as the conversation the user actually had.
 */
export const RESUME_PROMPT =
  'Your previous reply was cut off before it finished. Continue from exactly where it stopped. ' +
  'The work above, including every tool result, is already done: build on it and do not repeat it. ' +
  'If the task was already finished, just give the final answer.';

let patchCounter = 0;

/**
 * Fill in results for tool calls that never ran, so an interrupted transcript can
 * be sent to a provider again.
 *
 * Providers require every tool request in the history to be answered (Anthropic
 * rejects a `tool_use` with no `tool_result`; OpenAI does the same for
 * `tool_calls`), and a run that died between requesting a tool and running it
 * leaves exactly that hole. Rather than dropping the model's request, which
 * would rewrite what it did, each unanswered call gets a result saying it never
 * ran, so the model can decide whether it still needs it.
 *
 * Mutates `history` in place (it is the caller's persisted message list) and
 * returns how many gaps were filled.
 */
export function repairInterruptedHistory(history: ChatMessage[]): number {
  let filled = 0;
  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (msg.role !== 'assistant' || !msg.toolCalls?.length) continue;
    const requested = new Set(msg.toolCalls.map((c) => c.id));
    let end = i + 1;
    while (history[end]?.role === 'tool') end++;
    const immediate = new Set(history.slice(i + 1, end).map((m) => m.toolResult?.toolCallId));
    if (msg.toolCalls.every((c) => immediate.has(c.id))) continue;
    // A follow-up can have landed while a tool was finishing. Keep its real
    // output, but move it before intervening user/assistant messages so the
    // provider sees a single immediately following result batch.
    for (let j = end; j < history.length; j++) {
      const result = history[j];
      if (result.role !== 'tool' || !result.toolResult || !requested.has(result.toolResult.toolCallId)) continue;
      history.splice(j, 1);
      history.splice(end++, 0, result);
    }
    const answered = new Set(history.slice(i + 1, end).map((m) => m.toolResult?.toolCallId));
    const missing = msg.toolCalls.filter((c) => !answered.has(c.id));
    if (missing.length === 0) continue;

    // Directly after the request, which is where the pairing the providers check
    // for has to sit.
    const patches: ChatMessage[] = missing.map((call) => ({
      id: `msg_repair_${(patchCounter = (patchCounter + 1) % Number.MAX_SAFE_INTEGER)}`,
      role: 'tool',
      content: '',
      toolResult: { toolCallId: call.id, output: INTERRUPTED_TOOL_OUTPUT, isError: true },
      createdAt: msg.createdAt,
    }));
    history.splice(i + 1, 0, ...patches);
    for (const call of missing) answered.add(call.id);
    i += patches.length;
    filled += patches.length;
  }
  return filled;
}

