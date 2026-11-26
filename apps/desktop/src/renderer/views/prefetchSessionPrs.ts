import type { PrInfo } from '@nekko-agent/shared';
import { LIVE_STATE_FRESH_MS, isLiveState } from '../liveStateTicker.js';

/**
 * The cards whose PRs need no read: every PR merged or closed (final), or an
 * open/draft one read less than half a tick ago. A card with a live PR that was
 * never read here, or was read longer ago, drops out, so the next prefetch run
 * re-reads it.
 */
export function freshSessionPrs(
  prsBySession: Record<string, PrInfo[]>,
  readAt: ReadonlyMap<string, number>,
  now = Date.now(),
): Record<string, PrInfo[]> {
  const fresh: Record<string, PrInfo[]> = {};
  for (const [id, prs] of Object.entries(prsBySession)) {
    if (!prs.some(isLiveState) || now - (readAt.get(id) ?? 0) < LIVE_STATE_FRESH_MS / 2) fresh[id] = prs;
  }
  return fresh;
}

/** Cards read together in one request when the host can answer for many. */
const BATCH = 24;

/**
 * Hydrate every visible card, with bounded concurrency rather than a one-shot
 * slice. With `refreshMany` the cards still to read go together, `BATCH` to a
 * request (`pr:sessionListMany`), instead of one request each.
 */
export async function prefetchSessionPrs(
  ids: string[],
  loaded: () => Record<string, unknown>,
  refresh: (id: string) => Promise<void>,
  inFlight: Map<string, Promise<void>>,
  cancelled: () => boolean,
  refreshMany?: (ids: string[]) => Promise<void>,
): Promise<void> {
  if (refreshMany) {
    const wanted = [...new Set(ids)].filter((id) => id && !(id in loaded()) && !inFlight.has(id));
    for (let i = 0; i < wanted.length && !cancelled(); i += BATCH) {
      const chunk = wanted.slice(i, i + BATCH).filter((id) => !inFlight.has(id));
      if (chunk.length === 0) continue;
      const read = Promise.resolve().then(() => refreshMany(chunk))
        .catch(() => { /* Retry on summary/visibility changes, not a tight loop. */ })
        .finally(() => { for (const id of chunk) inFlight.delete(id); });
      for (const id of chunk) inFlight.set(id, read);
      await read;
    }
    return;
  }
  let next = 0;
  const worker = async () => {
    while (!cancelled() && next < ids.length) {
      // Re-rendered effects share these reads, so rapid filtering cannot multiply
      // the concurrency limit while the cancelled workers finish their requests.
      while (inFlight.size >= 8) await Promise.race(inFlight.values());
      if (cancelled()) return;
      const id = ids[next++];
      if (!id || id in loaded() || inFlight.has(id)) continue;
      const read = Promise.resolve().then(() => refresh(id))
        .catch(() => { /* Retry on summary/visibility changes, not a tight loop. */ })
        .finally(() => { inFlight.delete(id); });
      inFlight.set(id, read);
      await read;
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, ids.length) }, worker));
}
