import { needsNewerEngine, type EngineInstall, type LocalModel } from '@nekko-agent/shared';

/**
 * Which one thing the Model server card says about the managed engine.
 *
 * Repair, the CUDA switch and the update all download the pinned release into a
 * clean folder, so two of them side by side would be two buttons for the same
 * download. One is shown, in this order: a broken engine is repaired first (that
 * is the one that makes replies hang); an NVIDIA card is offered CUDA next, whose
 * words already say it also brings an old engine up to date; and only then does
 * an out-of-date engine get its own plain update.
 *
 * The update is said only when it is worth a download of several hundred MB: the
 * engine is far behind the pin (`outdated.notify`), or a model in the library is
 * refused for want of a newer one (`filesNeedingEngine`). The pin moves several
 * times a day, so being a little behind is the normal state and not news. The
 * rows' own "Needs a newer engine" and the offer's Update work either way: they
 * read `outdated.buildId`, which is set for any older managed engine.
 */
export type EngineNotice = 'repair' | 'switch' | 'update';

export function engineNotice(install: Pick<EngineInstall, 'problem' | 'upgrade' | 'outdated'>, filesNeedingEngine = 0): EngineNotice | null {
  if (install.problem) return 'repair';
  if (install.upgrade) return 'switch';
  if (install.outdated && (install.outdated.notify || filesNeedingEngine > 0)) return 'update';
  return null;
}

/** How many models are refused only because the engine is too old: one Update fixes them all. */
export function modelsNeedingNewerEngine(models: readonly Pick<LocalModel, 'loadCheck'>[]): number {
  return models.filter(needsNewerEngine).length;
}

/** What the update line says: the models waiting on it, else how far behind the engine is. */
export function engineUpdateText(outdated: NonNullable<EngineInstall['outdated']>, filesNeedingEngine: number): string {
  if (filesNeedingEngine <= 0) return outdated.message;
  return filesNeedingEngine === 1 ? '1 model in your library needs a newer engine.' : `${filesNeedingEngine} models in your library need a newer engine.`;
}
