import type { Session } from '@nekko-agent/shared';

/**
 * Transcripts of the chats opened most recently, kept in memory so opening one
 * of them again paints from here at once and revalidates in the background
 * (stale-while-revalidate), instead of waiting on a fetch and a parse.
 *
 * Bounded in both directions: at most MAX_CHATS chats, and about MAX_BYTES of
 * message text between them, so the warm set has a fixed ceiling however long
 * the app runs. The chat asked for last always stays, even on its own over
 * the byte budget: evicting the one you are looking at would be pointless.
 */
export const MAX_CHATS = 8;
export const MAX_BYTES = 24 * 1024 * 1024;

const cache = new Map<string, { session: Session; bytes: number }>();
let totalBytes = 0;
let holds = 0;
const holdWaiters: Array<() => void> = [];

/** Rough in-memory size of a transcript's text (UTF-16, two bytes a character). */
export function transcriptBytes(session: Session): number {
  let chars = 0;
  for (const m of session.messages) {
    chars += m.content.length + (m.reasoning?.length ?? 0) + (m.toolResult?.output.length ?? 0);
    if (m.images) for (const img of m.images) chars += img.length;
    // Screenshots a tool returned: usually most of a long agent chat's bytes,
    // and left out before, so eight cached chats could hold far past the budget.
    if (m.toolResult?.images) for (const img of m.toolResult.images) chars += img.length;
  }
  return chars * 2;
}

function evict(keep: string): void {
  for (const [id, entry] of cache) {
    if (cache.size <= MAX_CHATS && totalBytes <= MAX_BYTES) return;
    if (id === keep) continue;
    cache.delete(id);
    totalBytes -= entry.bytes;
  }
}

/** A cached transcript, marked as most recently used. */
export function getCachedSession(id: string): Session | undefined {
  const hit = cache.get(id);
  if (!hit) return undefined;
  cache.delete(id);
  cache.set(id, hit);
  return hit.session;
}

/** Remember a transcript (the newest copy wins). */
export function putCachedSession(session: Session): void {
  const prev = cache.get(session.id);
  if (prev?.session === session) {
    getCachedSession(session.id);
    return;
  }
  if (prev) {
    cache.delete(session.id);
    totalBytes -= prev.bytes;
  }
  const bytes = transcriptBytes(session);
  cache.set(session.id, { session, bytes });
  totalBytes += bytes;
  evict(session.id);
}

export function dropCachedSession(id: string): void {
  const prev = cache.get(id);
  if (!prev) return;
  cache.delete(id);
  totalBytes -= prev.bytes;
}

/** Fetch a transcript from the host and cache it. */
export async function loadSession(id: string): Promise<Session | null> {
  const s = await window.nekko.getSession(id);
  if (s) putCachedSession(s);
  else dropCachedSession(id);
  return s;
}

/**
 * A chat on screen holds this from mounting until its first load settles. The
 * load itself starts after the first paint, so counting fetches would miss it.
 * Returns the release.
 */
export function holdTranscript(): () => void {
  holds += 1;
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    holds -= 1;
    if (holds === 0) for (const done of holdWaiters.splice(0)) done();
  };
}

/** Settles once every chat on screen has its first transcript, or failed to get it. */
export function transcriptsLoaded(): Promise<void> {
  return holds === 0 ? Promise.resolve() : new Promise((resolve) => { holdWaiters.push(resolve); });
}

/** What is cached right now, oldest first. Tests and diagnostics. */
export function cachedSessionIds(): string[] {
  return [...cache.keys()];
}

export function cachedBytes(): number {
  return totalBytes;
}

/** Tests only. */
export function __resetSessionCache(): void {
  cache.clear();
  totalBytes = 0;
}
