import { cannotLoadReason, modelModality, needsNewerEngine, type CatalogModel, type EngineMemory, type GpuFit, type ImageRecommendedOption, type LocalModel, type Recommendations } from '@nekko-agent/shared';

export type LibraryModel = LocalModel & { loaded: boolean; gpuFit?: GpuFit; gpuFitIdle?: GpuFit };
export interface ModelFamily {
  key: string;
  name: string;
  local: LibraryModel[];
  catalog: CatalogModel[];
}

export function modelFamilyName(value: string): string {
  return value.split('/').pop()!
    .replace(/\.gguf$/i, '')
    .replace(/[-_. ](?:GGUF|GGML|MLX|[248]bit|(?:I?Q\d[\w]*|BF16|FP16|F16|FP32|F32))(?:[-_. ]|$)/gi, '-')
    .replace(/[-_. ](?:GGUF|GGML|MLX|[248]bit|I?Q\d[\w]*|BF16|FP16|F16|FP32|F32)$/gi, '')
    .replace(/[-_. ]+$/, '')
    .replace(/[ _]+/g, '-');
}

export function groupModelFamilies(local: LibraryModel[], catalog: CatalogModel[]): ModelFamily[] {
  const groups = new Map<string, ModelFamily>();
  const get = (name: string) => {
    const label = modelFamilyName(name);
    const key = label.toLowerCase().replace(/[-_. ]/g, '');
    let group = groups.get(key);
    if (!group) { group = { key, name: label, local: [], catalog: [] }; groups.set(key, group); }
    return group;
  };
  for (const m of catalog) get(m.baseModel || m.name || m.id).catalog.push(m);
  for (const m of local) {
    const repo = catalog.find(c => c.id === m.sourceRepo);
    get(repo?.baseModel || m.sourceRepo || m.name).local.push(m);
  }
  return [...groups.values()].sort((a, b) => Number(b.local.length > 0) - Number(a.local.length > 0) || a.name.localeCompare(b.name));
}

/**
 * The smallest file a family's line speaks for: among the ones this engine can load,
 * since a build it refuses has no fit to report. Every file, when none can.
 */
export function smallestVariant(local: LibraryModel[]): LibraryModel | undefined {
  const runnable = local.filter((m) => m.modality === 'image' || !cannotLoadReason(m));
  // With none that run, one an engine update would fix, so the line names that fix.
  const fixable = local.filter((m) => cannotLoadReason(m) === m.loadCheck?.reason && needsNewerEngine(m));
  const speaking = runnable.length ? runnable : fixable.length ? fixable : local;
  return speaking.slice().sort((a, b) => a.sizeBytes - b.sizeBytes)[0];
}

export function gpuGuidance(sizeBytes: number | undefined, memory?: EngineMemory, model?: LibraryModel): string {
  // The engine will not load it, so no GPU or CPU split applies.
  if (model?.loadCheck?.level === 'blocked') return needsNewerEngine(model) ? 'Needs a newer engine' : "Can't run here";
  if (model?.gpuFit === 'cpu' || memory?.kind === 'ram') return 'CPU only';
  if (model?.gpuFit === 'wont') return 'Too big';
  if (model?.gpuFit === 'partial') {
    // The planner measures against what is free now, so "partial" also means
    // a GPU that other models or apps are holding: that is not "too big".
    // `gpuFitIdle` re-plans the same context on the card less the desktop reserve.
    const layers = model.layers ?? 0;
    const capped = model.preset?.gpuLayers != null && layers > 0 && model.preset.gpuLayers < layers;
    if (capped) return 'Part on CPU by its settings';
    if (model.gpuFitIdle === 'full') return 'Fits when the GPU is free';
    if (model.gpuFitIdle === 'partial' || model.gpuFitIdle === 'wont') return 'Part on CPU at this context size';
    return 'Not enough free GPU memory';
  }
  if (model?.gpuFit === 'full') {
    return model.maxContext && model.preset?.contextTokens && model.preset.contextTokens < model.maxContext
      ? 'Fits on GPU, but limited context size' : 'Fits on GPU';
  }
  if (!sizeBytes || !memory?.budgetBytes) return 'GPU fit unknown';
  if (sizeBytes * 1.2 <= memory.budgetBytes * 0.55) return 'Fits on GPU';
  if (sizeBytes * 1.2 <= memory.budgetBytes * 0.85) return 'Fits on GPU, but limited context size';
  return 'Too big';
}

/** What a family makes: text (chat, code, vision, embeddings), pictures, or video. */
export type FamilyKind = 'chat' | 'image' | 'video';

/** Video diffusion families (sd.cpp runs Wan, LTX and HunyuanVideo). */
const VIDEO_NAME = /(?:^|[ /_.-])(?:wan[-_ ]?\d|ltx[-_ ]?(?:v|video|\d)|hunyuan[-_ ]?video|cogvideo|mochi[-_ ]?\d|text-to-video|image-to-video)/i;

/** The task a repo declares on Hugging Face, when its name does not say what it makes. */
const VIDEO_TASK = /^(?:text|image|video)-to-video$/;
const IMAGE_TASK = /^(?:text|image|image-text)-to-image$/;

/**
 * Video is checked first: a Wan file on disk is classified `image` (the engine
 * runs it on its picture runtime), but what it makes is video.
 */
function kindOf(names: string[], tags: string[], tasks: string[], imageOnDisk: boolean): FamilyKind {
  if (tags.includes('video') || tasks.some(t => VIDEO_TASK.test(t)) || names.some(n => VIDEO_NAME.test(n))) return 'video';
  if (tags.includes('image') || tasks.some(t => IMAGE_TASK.test(t)) || imageOnDisk || names.some(n => modelModality({ name: n }) === 'image')) return 'image';
  return 'chat';
}

/** Which filter a family belongs under. */
export function familyKind(f: ModelFamily): FamilyKind {
  return kindOf(
    [f.name, ...f.local.flatMap(m => [m.name, m.id, m.architecture ?? '']), ...f.catalog.flatMap(m => [m.id, m.name, m.baseModel ?? ''])],
    f.catalog.flatMap(m => m.tags),
    f.catalog.map(m => m.pipelineTag ?? ''),
    f.local.some(m => m.modality === 'image'),
  );
}

/** What one repository makes, before it is grouped into a family. */
export function catalogKind(m: CatalogModel): FamilyKind {
  return kindOf([m.id, m.name, m.baseModel ?? ''], m.tags, [m.pipelineTag ?? ''], false);
}

/**
 * The picture and video models Nekko has set up: the recommendation list's
 * candidates, each a pinned repository whose supporting files are known and
 * tested. One per repository, whichever task named it first.
 */
export function setUpPictureModels(recs: Pick<Recommendations, 'imageTasks'> | null | undefined): ImageRecommendedOption[] {
  const byRepo = new Map<string, ImageRecommendedOption>();
  for (const t of recs?.imageTasks ?? []) for (const o of [...(t.pick ? [t.pick] : []), ...t.options]) if (!byRepo.has(o.repo)) byRepo.set(o.repo, o);
  return [...byRepo.values()];
}

/**
 * A picture or video repository Nekko has not set up is only offered when a
 * publisher known for working conversions made it and enough people fetch it.
 * Hugging Face search returns every GGUF that matches a word, most of them
 * remixes that need files Nekko does not know how to fetch.
 */
export const MORE_MIN_DOWNLOADS = 10_000;
export const MORE_PUBLISHERS = new Set(['leejet', 'city96', 'quantstack', 'unsloth', 'second-state', 'gpustack', 'calcuis', 'bullerwins']);

/**
 * Sorts a search into what the list shows and what waits behind "Show more".
 *
 * Chat repositories are untouched. A picture or video repository is `listed`
 * when Nekko has set it up or one of its files is already on this machine,
 * `more` when it passes the publisher and download bar, and dropped otherwise.
 * With `withPicks`, the set-up models are listed whether or not the search
 * returned them, so Pictures and Video have something to show before a search.
 */
export function shelveCatalog(
  catalog: CatalogModel[],
  picks: ImageRecommendedOption[],
  local: Pick<LocalModel, 'sourceRepo'>[],
  withPicks: boolean,
): { listed: CatalogModel[]; more: CatalogModel[] } {
  const setUp = new Set(picks.map(p => p.repo));
  const onDisk = new Set(local.map(m => m.sourceRepo));
  const found = new Set(catalog.map(m => m.id));
  // Set-up repositories lead, so a family offers the tested one first.
  const listed: CatalogModel[] = catalog.filter(m => setUp.has(m.id));
  if (withPicks) {
    for (const p of picks) {
      if (found.has(p.repo)) continue;
      listed.push({ id: p.repo, name: p.name, owner: p.owner, tags: [p.capabilities.includes('video') ? 'video' : 'image'], quants: [{ label: p.quant, file: p.files[0] ?? '', sizeBytes: p.weightsBytes }], license: p.license });
    }
  }
  const more: CatalogModel[] = [];
  for (const m of catalog) {
    if (setUp.has(m.id)) continue;
    if (catalogKind(m) === 'chat' || onDisk.has(m.id)) listed.push(m);
    else if (MORE_PUBLISHERS.has(m.id.split('/')[0].toLowerCase()) && (m.downloads ?? 0) >= MORE_MIN_DOWNLOADS) more.push(m);
  }
  return { listed, more };
}
