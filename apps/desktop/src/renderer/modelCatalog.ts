import { useSyncExternalStore } from 'react';
import type { DownloadJob } from '@nekko-agent/shared';
import { useStore } from './store.js';

/**
 * A number that goes up whenever the models a picker could list may have
 * changed, so every open chat re-reads its list instead of keeping the one it
 * opened with (#3121): a download finished (a new model, or a picture model's
 * supporting files), the background catalog check found a provider's list
 * changed (`models:updated`), a provider was added, removed or edited, or a
 * model was deleted or imported here ({@link notifyModelsChanged}).
 */
let version = 0;
const listeners = new Set<() => void>();
let stopSources: (() => void) | null = null;

export function notifyModelsChanged(): void {
  version += 1;
  for (const l of listeners) l();
}

/** The ids of downloads already seen finished, so a job counts once. */
export function newlyFinished(seen: Set<string>, jobs: DownloadJob[]): boolean {
  let fresh = false;
  for (const j of jobs) {
    if (j.state !== 'done' || seen.has(j.id)) continue;
    seen.add(j.id);
    fresh = true;
  }
  return fresh;
}

function startSources(): () => void {
  const done = new Set<string>();
  const offDownloads = window.nekko.onDownloadsUpdated?.((jobs) => { if (newlyFinished(done, jobs)) notifyModelsChanged(); });
  const offModels = window.nekko.onModelsUpdated?.(() => notifyModelsChanged());
  // A provider added, removed, switched on or off, or pointed somewhere else.
  // Each refresh returns a new array, so compare what is in it.
  let providers = JSON.stringify(useStore.getState().providers);
  const offProviders = useStore.subscribe((s, prev) => {
    if (s.providers === prev.providers) return;
    const next = JSON.stringify(s.providers);
    if (next === providers) return;
    providers = next;
    notifyModelsChanged();
  });
  return () => { offDownloads?.(); offModels?.(); offProviders(); };
}

/** Listen for catalog changes; the sources are wired while anyone listens. */
export function subscribeModelCatalog(listener: () => void): () => void {
  listeners.add(listener);
  stopSources ??= startSources();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { stopSources?.(); stopSources = null; }
  };
}

export function modelCatalogVersion(): number {
  return version;
}

export function useModelCatalogVersion(): number {
  return useSyncExternalStore(subscribeModelCatalog, modelCatalogVersion, modelCatalogVersion);
}
