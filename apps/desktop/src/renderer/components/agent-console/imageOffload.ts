import type { LocalModel, Recommendations } from '@nekko-agent/shared';

const base = (p: string) => p.split(/[\\/]/).pop()?.toLowerCase() ?? '';

/**
 * Whether this machine's picture recommendations say `model` fits only with
 * sd.cpp's CPU offload, and the model does not have it on yet.
 */
export function needsOffload(model: Pick<LocalModel, 'path' | 'preset'>, recs: Recommendations | null): boolean {
  if (model.preset?.diffusion?.offloadToCpu) return false;
  const option = recs?.imageTasks?.flatMap((t) => t.options).find((o) => base(o.files[0] ?? '') === base(model.path));
  return Boolean(option?.offloadToCpu);
}

/**
 * Turn on the model's **Offload weights to CPU** preset when the
 * recommendations say it only fits that way, keeping the rest of its preset.
 * The engine offloads only when the preset says so, so a model downloaded from
 * anywhere (Models, a recommendation, the Photo setup) is set right the first
 * time a Photo chat uses it.
 */
export async function ensureRecommendedOffload(model: LocalModel, recs?: Recommendations | null): Promise<boolean> {
  const r = recs === undefined ? await window.nekko.machineRecommendations().catch(() => null) : recs;
  if (!needsOffload(model, r)) return false;
  await window.nekko.engineSaveModelPreset(model.id, { ...model.preset, diffusion: { ...model.preset?.diffusion, offloadToCpu: true } });
  return true;
}
