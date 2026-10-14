import type { ChatMessage } from '@nekko-agent/shared';
import { historyText } from '@nekko-agent/shared';

/**
 * Keeping a long agent run inside the model's context window.
 *
 * A local model with an 8k or 32k window fills it in a handful of tool steps:
 * one `read_file` of a big source file or one noisy build log is most of it.
 * The stored transcript keeps everything; this decides what of it a single
 * request carries. Past `FIT_TRIGGER` of the window, the oldest bulky tool
 * outputs are replaced, in the copy that is sent, by a one-line stub saying
 * what was there, until the prompt is back under `FIT_TARGET`. The model can
 * run the tool again if it still needs the output.
 *
 * The cut point only moves forward within a run and only when the trigger is
 * crossed again, so the requests in between share a stable prefix (provider
 * prompt caches and llama.cpp's slot cache keep working).
 *
 * crates/nekko-loop/src/fit.rs is the engine daemon's port; the agent loop
 * golden set holds the two to the same requests.
 */

/** Share of the window at which older tool outputs start being elided. */
export const FIT_TRIGGER = 0.8;
/** Share of the window the prompt is brought back under once trimming starts. */
export const FIT_TARGET = 0.6;
/** Tool outputs shorter than this are left alone: eliding them saves nothing. */
export const ELIDE_MIN_CHARS = 600;
/** The newest messages are always sent whole: they are what the model is working on. */
export const KEEP_RECENT = 4;
/** "Everything eligible", for the squeeze after a context-overflow error. */
export const ELIDE_ALL = Number.MAX_SAFE_INTEGER;

/** What an elided tool output is replaced with in the request. */
export function elidedToolOutput(chars: number): string {
  return `[Older tool output elided to keep this conversation inside the model's context window (${chars} characters). Run the tool again if you still need it.]`;
}

/** Positions of the tool outputs that may be elided, oldest first. */
export function elidable(messages: ChatMessage[]): number[] {
  const out: number[] = [];
  const end = messages.length - KEEP_RECENT;
  for (let i = 0; i < end; i++) {
    const output = messages[i].toolResult?.output;
    if (messages[i].role === 'tool' && output && output.length > ELIDE_MIN_CHARS) out.push(i);
  }
  return out;
}

/** A prompt's size in UTF-16 units (a quarter token each, as `estimateTokens` counts). */
export function promptUnits(system: string, tools: unknown[], messages: ChatMessage[]): number {
  let units = system.length + (tools.length ? JSON.stringify(tools).length : 0);
  for (const m of messages) units += historyText(m).length;
  return units;
}

/** `messages` with the first `count` elidable tool outputs replaced by a stub. */
export function applyElision(messages: ChatMessage[], count: number): ChatMessage[] {
  if (count <= 0) return messages;
  const at = elidable(messages).slice(0, count);
  if (!at.length) return messages;
  const out = messages.slice();
  for (const i of at) {
    const m = out[i];
    const output = m.toolResult!.output;
    out[i] = { ...m, toolResult: { ...m.toolResult!, output: elidedToolOutput(output.length) } };
  }
  return out;
}

/**
 * How many elidable outputs to elide for this request, given how many the run
 * already elides (`current`). Unchanged while the prompt stays under the
 * trigger; otherwise the smallest count that brings it under the target, or
 * every eligible output when even that is not enough.
 */
export function elisionFor(system: string, tools: unknown[], messages: ChatMessage[], contextWindow: number | undefined, current: number): number {
  if (!contextWindow || contextWindow <= 0) return current;
  const eligible = elidable(messages);
  const applied = Math.min(current, eligible.length);
  let units = promptUnits(system, tools, messages);
  const saving = (i: number) => {
    const output = messages[i].toolResult!.output;
    return output.length - elidedToolOutput(output.length).length;
  };
  for (let k = 0; k < applied; k++) units -= saving(eligible[k]);
  if (units / 4 <= contextWindow * FIT_TRIGGER) return current;
  let count = applied;
  while (count < eligible.length && units / 4 > contextWindow * FIT_TARGET) {
    units -= saving(eligible[count]);
    count++;
  }
  return count;
}
