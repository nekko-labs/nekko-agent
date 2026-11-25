import type { CatalogModelDetail, CatalogQuant, EngineInstall, LocalModel } from '@nekko-agent/shared';
import { cannotLoadReason } from '@nekko-agent/shared';
import { formatBytes } from '../runtimes/verdict.js';

/**
 * A build of the same model, from the same repo, that the managed engine can run,
 * to offer on a row the engine refuses for its weight format (a fork's quant such
 * as PrismML's PTQ1_0).
 *
 * The engine decides what can run: the row's `loadCheck` says the weight format
 * is blocked, each repo quant's `stock` says stock llama.cpp knows it, and the
 * row's `engineMeetsMinBuild` says whether the engine is also too old for files
 * of this kind. This only picks among what it was told.
 */
export interface RunnableAlternative {
  repo: string;
  quant: CatalogQuant;
  /** The engine is older than the file's maker asks for, so it must be updated as well. */
  engineTooOld: boolean;
  /** The llama.cpp build the file asks for, when the engine is too old. */
  minBuild?: number;
}

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;
/** Unquantized builds: big, and the last pick when anything smaller will run. */
const FULL_PRECISION = /^(F16|BF16|F32)$/i;

type Row = Pick<LocalModel, 'path' | 'sourceRepo' | 'loadCheck' | 'engineMeetsMinBuild' | 'minEngineBuild'>;

/**
 * The build the offer's Update engine installs: the engine card's own, set for any older managed
 * engine whether or not the card shows its notice (`outdated.notify`).
 */
export function updateBuildId(status: { install: Pick<EngineInstall, 'outdated'> }): string | undefined {
  return status.install.outdated?.buildId;
}

/** The file names of the rows the engine in use can load: a build that is here but refused is no alternative. */
export function loadableFiles(models: readonly LocalModel[]): string[] {
  return models.filter((m) => !(m.modality === 'image' ? undefined : cannotLoadReason(m))).map((m) => fileName(m.path));
}

/** Whether a row is one this applies to: refused for its weight format, with a repo to look in. */
export function wantsAlternative(model: Pick<LocalModel, 'sourceRepo' | 'loadCheck'>): boolean {
  return Boolean(model.sourceRepo) && model.loadCheck?.level === 'blocked' && model.loadCheck.cause === 'weightFormat';
}

/**
 * The offer for a row, or null. `repo` is the repo's catalog page and `have` the
 * file names already on this machine.
 *
 * The repo is trusted only if it lists a file with exactly this row's file name:
 * a folder name alone is a hint (an LM Studio folder can be named for one model
 * and hold another). Of the repo's stock quants it takes the smallest that is
 * not full precision, else the smallest of those.
 */
export function runnableAlternative(model: Row, repo: CatalogModelDetail | null | undefined, have: readonly string[] = []): RunnableAlternative | null {
  if (!wantsAlternative(model) || !repo || repo.id.toLowerCase() !== model.sourceRepo!.toLowerCase()) return null;
  const files = repo.quants.filter((q) => q.format !== 'mlx');
  const mine = fileName(model.path);
  if (!files.some((q) => fileName(q.file) === mine)) return null;
  const onDisk = new Set(have);
  // A build that runs is already here: nothing to offer.
  if (files.some((q) => q.stock && onDisk.has(fileName(q.file)))) return null;
  const options = files.filter((q) => q.stock && q.sizeBytes).sort((a, b) => a.sizeBytes! - b.sizeBytes!);
  // `quant` is the format alone where a repo's releases make `label` read `v2.1 F16`.
  const quant = options.find((q) => !FULL_PRECISION.test(q.quant ?? q.label)) ?? options[0];
  if (!quant) return null;
  const engineTooOld = model.engineMeetsMinBuild === false;
  return { repo: repo.id, quant, engineTooOld, minBuild: engineTooOld ? model.minEngineBuild : undefined };
}

/** What the row says: the build, and when the engine is too old, that it needs updating too. */
export function offerText(alt: RunnableAlternative): string {
  const build = `A build that runs here is in the same repo: ${alt.quant.label}, ${formatBytes(alt.quant.sizeBytes ?? 0)}.`;
  if (!alt.engineTooOld) return build;
  return `${build} It needs llama.cpp${alt.minBuild ? ` b${alt.minBuild}` : ''} or newer, so update the engine first.`;
}
