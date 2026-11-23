import type { EngineInstall } from '@nekko-agent/shared';

/**
 * Which one thing the Model server card says about the managed engine.
 *
 * Repair, the CUDA switch and the update all download the pinned release into a
 * clean folder, so two of them side by side would be two buttons for the same
 * download. One is shown, in this order: a broken engine is repaired first (that
 * is the one that makes replies hang); an NVIDIA card is offered CUDA next, whose
 * words already say it also brings an old engine up to date; and only then does
 * an out-of-date engine get its own plain update.
 */
export type EngineNotice = 'repair' | 'switch' | 'update';

export function engineNotice(install: Pick<EngineInstall, 'problem' | 'upgrade' | 'outdated'>): EngineNotice | null {
  if (install.problem) return 'repair';
  if (install.upgrade) return 'switch';
  if (install.outdated) return 'update';
  return null;
}
