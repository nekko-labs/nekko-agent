import type { LocalModel } from '@nekko-agent/shared';

/**
 * The few local models someone reaches for: the ones they starred and the
 * ones they used last, offered beside what is loaded so loading one again is
 * a click rather than a trip to Model Server.
 */

/** The built-in Model Server's provider id (`PROVIDER_ID` in EngineSection). */
export const ENGINE_PROVIDER_ID = 'nekko-engine';

/** How many starred and recent models the Local models monitor offers. */
export const STARRED_SHOWN = 4;
export const RECENT_SHOWN = 3;

const RECENT_KEY = 'nekko.localModels.recent';
const RECENT_KEPT = 20;

export interface RecentUse { id: string; at: number }

/** The local models this app saw in memory, newest first. */
export function readRecentLocalModels(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): RecentUse[] {
  try {
    const raw = JSON.parse(storage?.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((r): r is RecentUse => typeof r?.id === 'string' && Number.isFinite(r?.at)) : [];
  } catch {
    return [];
  }
}

/**
 * Remember that these models were in memory at these times. Picture models
 * count too: a Photo chat loads one for the length of a job, and the next
 * picture should not start with a search for it.
 */
export function noteLocalModelsUsed(uses: RecentUse[], storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = globalThis.localStorage): void {
  if (!uses.length || !storage) return;
  const latest = new Map<string, number>();
  for (const r of [...readRecentLocalModels(storage), ...uses]) latest.set(r.id, Math.max(latest.get(r.id) ?? 0, r.at));
  const next = [...latest].map(([id, at]) => ({ id, at })).sort((a, b) => b.at - a.at).slice(0, RECENT_KEPT);
  try { storage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* storage full or off: recents are a convenience */ }
}

/**
 * The starred and recent models to offer, from the library on disk.
 *
 * Starred are the `nekko-engine::<id>` keys in `favoriteModels`, in the order
 * they were starred. Recent merges what this app saw loaded with the chats
 * that ran on a local model, newest first. Neither repeats a loaded model
 * (it already has its own row), and recent never repeats a starred one.
 */
export function localModelShortcuts({ models, resident, favorites, seen, chats }: {
  models: LocalModel[];
  resident: string[];
  favorites: readonly string[] | undefined;
  seen: RecentUse[];
  chats: Array<{ providerId?: string; modelId?: string; updatedAt: number }>;
}): { starred: LocalModel[]; recent: LocalModel[] } {
  const byId = new Map(models.map((m) => [m.id, m]));
  const loaded = new Set(resident);
  const prefix = `${ENGINE_PROVIDER_ID}::`;
  const starredIds = (favorites ?? []).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
  const starred = starredIds.map((id) => byId.get(id)).filter((m): m is LocalModel => !!m && !loaded.has(m.id)).slice(0, STARRED_SHOWN);
  const starredSet = new Set(starredIds);
  const latest = new Map<string, number>();
  const uses = [...seen, ...chats.filter((c) => c.providerId === ENGINE_PROVIDER_ID && c.modelId).map((c) => ({ id: c.modelId!, at: c.updatedAt }))];
  for (const r of uses) latest.set(r.id, Math.max(latest.get(r.id) ?? 0, r.at));
  const recent = [...latest]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => byId.get(id))
    .filter((m): m is LocalModel => !!m && !loaded.has(m.id) && !starredSet.has(m.id))
    .slice(0, RECENT_SHOWN);
  return { starred, recent };
}

/**
 * Load a local model the way a library row's Load does: with what it was last
 * saved with, or the planner's own answer when it has never been configured.
 * A picture model loads with its saved files and no planner pass.
 */
export async function loadLocalModel(providerId: string, model: LocalModel): Promise<{ ok: boolean; message?: string }> {
  const params = model.preset ? { ...model.preset, budgetFraction: undefined } : null;
  return (params || model.modality === 'image'
    ? window.nekko.runtimeLoad(providerId, model.id, params ?? {})
    : autoLoad(providerId, model.id)).catch((e: Error) => ({ ok: false, message: e.message }));
}

/**
 * Load with the planner's own answer at a middling budget.
 *
 * A model nobody has configured still has to load sensibly, and asking the same
 * planner the drawer asks means the quick path and the considered path cannot
 * disagree.
 */
async function autoLoad(providerId: string, modelId: string): Promise<{ ok: boolean; message?: string }> {
  const auto = await window.nekko.runtimeAutoFit(providerId, modelId, 0.75).catch(() => null);
  return window.nekko.runtimeLoad(providerId, modelId, {
    contextTokens: auto?.request.contextTokens,
    kvCacheDtype: auto?.request.kvCacheDtype,
    gpuLayers:
      auto?.plan.totalLayers && auto.request.gpuLayerFraction < 1
        ? Math.round(auto.plan.totalLayers * auto.request.gpuLayerFraction)
        : undefined,
  });
}
