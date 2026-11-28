import { cannotLoadReason, type LocalModel } from '@nekko-agent/shared';
import { dflash2DraftName, isStockDflash2Target } from './draftModels.js';

// These optional fields are projected by engine:models. sourceRepo describes
// distribution (which may be a merge or a conversion), not checkpoint identity.
type CompanionMetadata = {
  companion?: { kind: 'lora'; baseRepo?: string };
  dependentWeights?: boolean;
  loraBaseRepo?: string;
};
type Kind = 'lora' | 'draft' | 'other';
export type InstalledPair = { kind: 'lora' | 'draft'; model: LocalModel };

export function companionKind(model: LocalModel & CompanionMetadata): Kind | undefined {
  if (model.companion?.kind === 'lora') return 'lora';
  if (model.dependentWeights) return 'other';
  if (model.modality === 'draft' || /dflash/i.test(model.architecture ?? '')) return 'draft';
}

const repoId = /^(?!.*(?:\.\.|--))[a-z\d](?:[a-z\d_.-]*[a-z\d])?\/[a-z\d](?:[a-z\d_.-]*[a-z\d])?$/i;

export function unpairedCompanionReason(model: LocalModel & CompanionMetadata): string | undefined {
  switch (companionKind(model)) {
    case 'lora':
      if (model.format === 'mlx') return 'LoRA pairing currently requires GGUF weights.';
      if (model.readable === false || model.unknownWeightType != null || /-\d{5}-of-\d{5}\.gguf$/i.test(model.path)) return 'This LoRA file is not supported by the local runtime.';
      if (!model.companion?.baseRepo || !repoId.test(model.companion.baseRepo)) return 'The exact base checkpoint is unknown.';
      return `Install the compatible GGUF base: ${model.companion.baseRepo}.`;
    case 'draft':
      if (dflash2DraftName(model)) return `Install the stock Qwen3.8-27B base in ${model.format === 'mlx' ? 'MLX' : 'GGUF'} format.`;
      return 'This draft cannot run alone. No compatible base was verified.';
    case 'other':
      return 'These adapter weights cannot run on their own.';
  }
}

function canPair(base: LocalModel & CompanionMetadata, pair: InstalledPair): boolean {
  const model: LocalModel & CompanionMetadata = pair.model;
  const format = base.format ?? 'gguf';
  if (base.id === model.id || base.path === model.path || format !== (model.format ?? 'gguf')) return false;
  if (base.readable === false || model.readable === false || model.loadCheck?.level === 'blocked' || cannotLoadReason(base)) return false;
  if (pair.kind === 'draft') return isStockDflash2Target(base) && !!dflash2DraftName(model);
  if (format !== 'gguf' || !['chat', 'vision', 'embedding'].includes(base.modality ?? '')) return false;
  const repo = model.companion?.baseRepo;
  return !!repo && repoId.test(repo) && repo === base.loraBaseRepo && !!base.architecture &&
    base.architecture === model.architecture && model.unknownWeightType == null && !/-\d{5}-of-\d{5}\.gguf$/i.test(model.path);
}

/** The same installed file can apply to multiple exact, supported base builds. */
export function installedCompanionPairs(models: readonly LocalModel[]) {
  const byBase = new Map<string, InstalledPair[]>();
  const pairedIds = new Set<string>();
  const bases: LocalModel[] = [];
  const companions: InstalledPair[] = [];
  for (const model of models) {
    const kind = companionKind(model);
    if (!kind) bases.push(model);
    else if (kind !== 'other') companions.push({ kind, model });
  }
  for (const base of bases) {
    const pairs = companions.filter(pair => canPair(base, pair));
    if (!pairs.length) continue;
    byBase.set(base.id, pairs);
    for (const pair of pairs) pairedIds.add(pair.model.id);
  }
  return { byBase, pairedIds };
}
