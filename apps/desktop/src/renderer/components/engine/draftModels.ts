import type { LocalModel } from '@nekko-agent/shared';

const GGUF_TARGET = /^Qwen3\.8[- ]27B$/i;
const GGUF_HEAD = /^Qwen3\.8[- ]27B-DFlash2$/i;
const MLX_TARGET = /^(?:mlx-community_)?Qwen3\.8-27B(?:-4bit|-8bit|-bf16|-MLX-8bit)?$/;
const MLX_HEAD = /^(?:(?:incoai|z-lab)_)?Qwen3\.8-27B-DFlash2$/;

/** A full MLX folder, a managed owner_repo folder, or a Hugging Face snapshot. */
function mlxFolderName(path: string, snapshotOwner: RegExp): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const repo = parts.at(-3);
  if (parts.at(-2) === 'snapshots' && repo && snapshotOwner.test(repo)) return repo.replace(snapshotOwner, '');
  return parts.at(-1) ?? '';
}

/** Recognition from library metadata, not a hash or a substitute for runtime validation. */
export function isStockDflash2Target(model: LocalModel): boolean {
  if (model.readable === false) return false;
  if (model.format === 'mlx') {
    return model.mlxRunnable === true && model.architecture === 'qwen3_5' && model.modality === 'vision' &&
      MLX_TARGET.test(mlxFolderName(model.path, /^models--mlx-community--/));
  }
  return model.architecture === 'qwen35' && model.layers === 64 && GGUF_TARGET.test(model.name);
}

/** The GGUF header says `dflash`; MLX can say `qwen3` and is classified from its config. */
export function dflash2DraftName(model: LocalModel): string | undefined {
  if (model.readable === false) return undefined;
  if (model.format === 'mlx') {
    if (model.modality !== 'draft' || model.mlxRunnable !== true) return undefined;
    const folder = mlxFolderName(model.path, /^models--(?:incoai|z-lab)--/);
    return MLX_HEAD.test(folder) ? 'Qwen3.8-27B-DFlash2' : undefined;
  }
  return model.architecture === 'dflash' && GGUF_HEAD.test(model.name) ? model.name : undefined;
}

export function draftModelCandidates(target: LocalModel, models: LocalModel[]): LocalModel[] {
  const stock = isStockDflash2Target(target);
  const format = target.format ?? 'gguf';
  return models.filter((draft) => {
    if (draft.id === target.id || (draft.format ?? 'gguf') !== format) return false;
    // A head is bound to one target. Never admit it through the ordinary-draft heuristic.
    if (/dflash/i.test(draft.architecture ?? '') || (format === 'mlx' && draft.modality === 'draft')) {
      return stock && !!dflash2DraftName(draft);
    }
    // Ordinary drafts keep the same architecture, type and quarter-size rule.
    return !!target.architecture && draft.architecture === target.architecture &&
      (draft.modality === 'draft' || draft.modality === 'chat' || !draft.modality) && draft.sizeBytes <= target.sizeBytes / 4;
  });
}
