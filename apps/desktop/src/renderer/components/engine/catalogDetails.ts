import type { CatalogModelDetail } from '@nekko-agent/shared';

/**
 * One repo's catalog page, read once and shared.
 *
 * The model's own page and a blocked file's row (which looks in the repo for a
 * build the engine can run) ask for the same thing when someone opens a model.
 * Sharing the answer, for as long as the daemon keeps its own (ten minutes),
 * means opening a model is still one trip to Hugging Face, not two. A repo that
 * was not found or a failed read is not kept, so the next look tries again.
 */
const TTL_MS = 10 * 60_000;
const pages = new Map<string, { at: number; page: Promise<CatalogModelDetail | null> }>();

export function loadCatalogDetail(id: string): Promise<CatalogModelDetail | null> {
  const kept = pages.get(id);
  if (kept && Date.now() - kept.at < TTL_MS) return kept.page;
  const page = window.nekko.engineCatalogDetail(id).then(
    (m) => {
      if (!m) pages.delete(id);
      return m;
    },
    (e) => {
      pages.delete(id);
      throw e;
    },
  );
  pages.set(id, { at: Date.now(), page });
  return page;
}

/** For tests: forget everything read so far. */
export function clearCatalogDetails(): void {
  pages.clear();
}
