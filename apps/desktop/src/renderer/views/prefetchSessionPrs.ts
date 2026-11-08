/** Hydrate every visible card, with bounded concurrency rather than a one-shot slice. */
export async function prefetchSessionPrs(
  ids: string[],
  loaded: () => Record<string, unknown>,
  refresh: (id: string) => Promise<void>,
  inFlight: Map<string, Promise<void>>,
  cancelled: () => boolean,
): Promise<void> {
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
