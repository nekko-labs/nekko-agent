import { randomInt } from 'crypto';
import type { AgentEvent, ImageGenerationRequest, ImageGenerationResult, ImageTurnOptions } from '@nekko-agent/shared';
import { getSession, saveSession, saveTurnSession } from './sessions.js';
import { imageFailure, imageReply, imageSize, imageStageLabel, startImageTurn } from './turn-variants.js';

/**
 * One turn of an image-generation chat.
 *
 * There is no agent loop here: the prompt goes to a local image model and the
 * reply is the picture. It still lands in the transcript as an ordinary user
 * message and an assistant message (carrying the image and how it was made),
 * and it still emits the turn events every surface already listens for, so the
 * chat, the sidebar and the Command Center treat it like any other turn.
 *
 * The pure half (the transcript edits, the request, the labels) is
 * turn-variants.ts; the engine daemon runs the same turn itself
 * (`chat:generateImage`, crates/nekkod/src/image_turns.rs) when it owns the
 * model server, and the host dispatcher sends the channel there.
 */

type Generate = (request: ImageGenerationRequest, onStage?: (stage: 'loading' | 'generating') => void) => Promise<ImageGenerationResult>;

const running = new Map<string, AbortController>();

/** Stop waiting on an image turn. The model server may finish the image anyway; it is discarded. */
export function abortImageTurn(sessionId: string): boolean {
  const c = running.get(sessionId);
  if (!c) return false;
  c.abort();
  return true;
}

export async function generateImageTurn(opts: ImageTurnOptions, generate: Generate, emit: (e: AgentEvent) => void): Promise<void> {
  const { sessionId, params } = opts;
  const session = getSession(sessionId);
  if (!session) {
    emit({ type: 'error', sessionId, message: 'That chat no longer exists.' });
    return;
  }
  if (running.has(sessionId)) {
    emit({ type: 'error', sessionId, message: 'This chat is already generating an image.' });
    return;
  }
  const started_ = startImageTurn(session, opts, Date.now(), randomInt(0, 2 ** 31 - 1));
  if ('error' in started_) {
    emit({ type: 'error', sessionId, message: started_.error });
    return;
  }
  const { request, seed } = started_;
  const controller = new AbortController();
  running.set(sessionId, controller);
  // As sendChat does: nothing touches disk for an incognito chat, and prompts
  // queued mid-turn (written straight to disk) survive this save.
  const persist = () => {
    if (session.incognito) return;
    saveTurnSession(session);
  };
  // Read from disk just above, so nothing is stale yet; and the settings this
  // turn was sent with are the chat's now, which a merging save would undo.
  if (!session.incognito) saveSession(session);

  const size = imageSize(params);
  emit({ type: 'image_status', sessionId, stage: 'generating', label: imageStageLabel('generating', size) });
  const started = Date.now();
  try {
    const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Stopped.'))));
    const result = await Promise.race([
      generate(request, (stage) => emit({ type: 'image_status', sessionId, stage, label: imageStageLabel(stage, size) })),
      aborted,
    ]);
    const reply = imageReply(result, params, seed, Date.now() - started, Date.now());
    session.messages.push(reply);
    persist();
    emit({ type: 'done', sessionId, messageId: reply.id });
  } catch (e) {
    const stopped = controller.signal.aborted;
    const reply = imageFailure(stopped, (e as Error).message, Date.now());
    session.messages.push(reply);
    persist();
    if (stopped) emit({ type: 'done', sessionId, messageId: reply.id });
    else emit({ type: 'error', sessionId, message: (e as Error).message });
  } finally {
    running.delete(sessionId);
  }
}

/** The newest `limit` generated pictures in a chat, newest last. */
export function sessionImages(sessionId: string, limit: number): Array<{ messageId: string; src: string }> {
  const s = getSession(sessionId);
  if (!s) return [];
  const out: Array<{ messageId: string; src: string }> = [];
  const cap = Math.max(1, Math.min(12, Math.floor(limit) || 1));
  for (let i = s.messages.length - 1; i >= 0 && out.length < cap; i--) {
    const m = s.messages[i];
    if (m.role === 'assistant' && m.generated && m.images?.length) out.push({ messageId: m.id, src: m.images[0] });
  }
  return out.reverse();
}
