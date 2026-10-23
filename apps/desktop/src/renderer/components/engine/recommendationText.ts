import type { LocalModel, RecommendedOption, Recommendations, TaskRecommendation } from '@nekko-agent/shared';
import { formatBytes } from '../runtimes/verdict.js';

/**
 * The words for a recommendation. Every number says where it came from, and
 * the roughest figures say they are rough: a recommendation that over-promises
 * speed costs the user a long download for a model they will not use.
 */

/** "~117 tok/s" and why the reader should believe it, or nothing to show. */
export function speedText(
  option: RecommendedOption,
  task: TaskRecommendation,
  hardware: Recommendations['hardware'],
): { text: string; title: string } | null {
  if (task.minTokensPerSecond == null) return null;
  const s = option.speed;
  if (!s) {
    return hardware.classId
      ? null
      : { text: 'speed unknown', title: `${hardware.device ?? 'This GPU'} is not in the speed table yet, so no figure is guessed.` };
  }
  const n = Math.round(s.tokensPerSecond);
  switch (s.basis) {
    case 'measuredHere':
      return { text: `${n} tok/s here`, title: `The median of your last ${s.samples ?? 'few'} replies with this file on this machine.` };
    case 'measured':
      return { text: `${n} tok/s`, title: 'Measured with this exact file on this kind of hardware.' };
    case 'estimated':
      return { text: `~${n} tok/s`, title: "Estimated from this hardware's memory bandwidth, calibrated on measurements with the same engine backend." };
    case 'estimatedBorrowed':
      return { text: `~${n} tok/s, rough`, title: "Estimated from this hardware's memory bandwidth, calibrated on a different kind of GPU. Not yet measured on hardware like this." };
  }
}

/** "4.2 GB of 31 GB" with the placement the budget is measured in. */
export function memoryText(option: RecommendedOption, budget: Recommendations['budget']): string {
  return `${formatBytes(option.memoryBytes)} of ${formatBytes(budget.bytes)}`;
}

export function fitText(option: RecommendedOption): { text: string; title: string } {
  return option.fit === 'fits'
    ? { text: 'fits', title: `Leaves ${formatBytes(option.headroomBytes)} for longer conversations and other programs.` }
    : { text: 'tight fit', title: `Leaves ${formatBytes(option.headroomBytes)}: it runs, with little to spare.` };
}

/** One line on what the picks were made for. */
export function hardwareText(recs: Recommendations): string {
  const where =
    recs.budget.placement === 'unified'
      ? 'of unified memory'
      : recs.budget.placement === 'gpu'
        ? 'of GPU memory'
        : 'of RAM';
  const backend = { cuda: 'CUDA', vulkan: 'Vulkan', metal: 'Metal', hip: 'ROCm', cpu: 'CPU only' }[recs.hardware.backend] ?? recs.hardware.backend;
  return [recs.hardware.device ?? 'No GPU found', backend, `${formatBytes(recs.budget.bytes)} ${where} for models`].join(' · ');
}

const base = (p: string) => p.split(/[\\/]/).pop()?.toLowerCase() ?? '';

/** Already on this machine: its weights file is in the library. */
export function isDownloaded(option: RecommendedOption, models: Pick<LocalModel, 'path'>[]): boolean {
  const weights = base(option.files[0] ?? '');
  return !!weights && models.some(m => base(m.path) === weights);
}
