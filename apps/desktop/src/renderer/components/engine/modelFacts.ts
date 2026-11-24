import { cannotLoadReason, modelModality, needsNewerEngine, type LocalModel, type ModelModality } from '@nekko-agent/shared';
import { formatBytes, formatTokens } from '../runtimes/verdict.js';

/**
 * The few facts that decide whether a model is worth running here, in words:
 * how big it is (parameters), what it needs (memory per quant) and what the
 * rest of the memory buys (context). Pure, so the list rows, the picks and the
 * detail pane all say them the same way.
 */

/** The parameter count a name or a header states: "27B", "35B, 3B active", "4B effective". */
export function paramsText(name: string, parameterSize?: string): string | null {
  const m = /(?:^|[\s_-])(E)?(\d+(?:\.\d+)?)([BbMm])(?:[\s_-]+A(\d+(?:\.\d+)?)B)?(?=$|[\s_.-])/.exec(name);
  if (m) {
    const size = `${m[2]}${m[3].toUpperCase()}`;
    if (m[4]) return `${size}, ${m[4]}B active`;
    return m[1] ? `${size} effective` : size;
  }
  const p = parameterSize?.trim();
  return p ? p.toUpperCase().replace(/^(\d+(?:\.\d+)?)\s*([BM])$/, '$1$2') : null;
}

/** "27B parameters", "35B parameters, 3B active", or nothing when the name does not say. */
export function paramsLabel(name: string, parameterSize?: string): string | null {
  const p = paramsText(name, parameterSize);
  if (!p) return null;
  return p.includes(',') ? p.replace(',', ' parameters,') : p.endsWith('effective') ? p.replace(' effective', ' effective parameters') : `${p} parameters`;
}

const TYPE_LABELS: Record<ModelModality, string> = {
  chat: 'Chat', vision: 'Vision', embedding: 'Embeddings', image: 'Image generation',
  audio: 'Audio', draft: 'Draft model', unknown: 'Unknown type',
};

export function localTypeLabel(model: LocalModel): string {
  return TYPE_LABELS[model.modality ?? modelModality(model)];
}

/** What is wrong with a model on disk, worst first, or null when nothing is. */
export type ModelProblem = { text: string; tone: 'danger' | 'warning'; detail: string };

export function modelProblem(m: Pick<LocalModel, 'lastLoadError' | 'modality' | 'hasProjector' | 'readable' | 'format' | 'mlxRunnable' | 'name' | 'loadCheck'> & { loaded?: boolean }): ModelProblem | null {
  if (m.lastLoadError && !m.loaded) return { text: 'Last load failed', tone: 'danger', detail: m.lastLoadError };
  const unsupported = m.modality === 'image' ? undefined : cannotLoadReason(m as LocalModel);
  // An engine too old for the file is one Update away, so it says that rather than "Can't run here".
  if (unsupported) return { text: unsupported === m.loadCheck?.reason && needsNewerEngine(m) ? 'Needs a newer engine' : "Can't run here", tone: 'warning', detail: unsupported };
  // The engine in use may still try it, and llama.cpp's own error shows if it cannot.
  if (m.loadCheck?.level === 'warning') return { text: 'May not run here', tone: 'warning', detail: m.loadCheck.reason };
  if (m.modality === 'vision' && !m.hasProjector) return { text: 'No projector', tone: 'warning', detail: 'Its projector (mmproj-*.gguf) is missing: it answers text but cannot see images.' };
  return null;
}

/** The worst problem among a family's files, so the list row can wear it instead of a check. */
export function familyProblem(local: Array<Parameters<typeof modelProblem>[0]>): ModelProblem | null {
  // A file that cannot run only speaks for the family when none of its other files can either:
  // a family with one build the engine refuses and one it runs is not "Can't run here". With none
  // that run, one an engine update would fix speaks first.
  const blocked = (m: (typeof local)[number]) => m.modality !== 'image' && !!cannotLoadReason(m as LocalModel);
  const fixable = (m: (typeof local)[number]) => cannotLoadReason(m as LocalModel) === m.loadCheck?.reason && needsNewerEngine(m);
  const runnable = local.filter((m) => !blocked(m));
  const speaking = runnable.length ? runnable : local.some(fixable) ? local.filter(fixable) : local;
  const all = speaking.map(modelProblem).filter((p): p is ModelProblem => !!p);
  return all.find((p) => p.tone === 'danger') ?? all[0] ?? null;
}

/** "Up to 88K fits in this GPU · 256K max", or the max alone when the fit is not known. */
export function contextFitText(fitTokens: number | undefined, maxTokens: number | null | undefined, where: string): string | null {
  const max = maxTokens ? `${formatTokens(maxTokens)} max` : null;
  if (fitTokens === undefined) return max;
  if (fitTokens <= 0) return [`No room for context in ${where}`, max].filter(Boolean).join(' · ');
  const all = maxTokens && fitTokens >= maxTokens;
  return [all ? `All of it fits in ${where}` : `Up to ${formatTokens(fitTokens)} fits in ${where}`, max].filter(Boolean).join(' · ');
}

/** The part of a memory figure that is not the weights: the context and the engine's working buffers. */
export function memorySplit(memoryBytes: number, weightsBytes: number, budgetBytes: number): { weights: number; rest: number } {
  if (!budgetBytes) return { weights: 0, rest: 0 };
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  const weights = clamp(weightsBytes / budgetBytes);
  return { weights, rest: clamp(memoryBytes / budgetBytes) - weights };
}

/** "11.3 to 21.0 GB" across a family's downloadable quants, or one size, or nothing. */
export function sizeRangeText(sizes: number[]): string | null {
  const known = sizes.filter((n) => n > 0);
  if (!known.length) return null;
  const lo = Math.min(...known);
  const hi = Math.max(...known);
  return lo === hi ? formatBytes(lo) : `${formatBytes(lo)} to ${formatBytes(hi)}`;
}
