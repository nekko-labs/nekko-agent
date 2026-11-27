import type { EngineMemory } from '@nekko-agent/shared';
import { formatBytes } from '../runtimes/verdict.js';
import { ASPECT_COLOR, MemoryBar } from './MemoryBar.js';
import type { LibraryModel } from './modelFamilies.js';

export function modelMemoryPreview(model: LibraryModel, memory?: EngineMemory) {
  const weights = Number.isFinite(model.sizeBytes) && model.sizeBytes > 0 ? model.sizeBytes : null;
  if (weights === null) return { text: 'Load size unknown', bytes: null, scale: null, estimated: false };
  const pool = memory && Number.isFinite(memory.budgetBytes) && memory.budgetBytes > 0 ? memory : undefined;
  const singlePool = pool && (pool.kind !== 'vram' || (model.gpuFit === 'full' && model.preset?.mlock !== true));
  // Same rough allowance as download fit: not measured, and not reliable for
  // MLX, diffusion, or a model whose weights span separate pools.
  const estimated = !!singlePool && (model.gpuFit === 'full' || model.gpuFit === 'cpu') && model.format !== 'mlx' && model.modality !== 'image';
  const bytes = estimated ? Math.round(weights * 1.2) : weights;
  const scale = pool?.budgetBytes ?? null;
  const capacity = scale && pool ? `${formatBytes(scale)} ${pool.kind === 'vram' ? 'VRAM' : pool.kind === 'ram' ? 'RAM' : 'shared memory'}${estimated ? '' : ' capacity'}` : null;
  const text = estimated ? `~${formatBytes(bytes)} estimated load` : `${formatBytes(weights)} weights on disk`;
  return { text: capacity ? `${text} · ${capacity}` : text, bytes, scale, estimated };
}

export function ModelMemoryPreview({ model, memory, id }: { model: LibraryModel; memory?: EngineMemory; id: string }) {
  const { text, bytes, scale, estimated } = modelMemoryPreview(model, memory);
  return (
    <span className="model-memory-preview mb-1 mt-1.5 block max-w-72" data-model-memory-preview>
      {bytes !== null && scale !== null && (
        <span className="block" aria-hidden="true">
          <MemoryBar height="h-1.5" label={text} scaleBytes={scale} over={estimated && bytes > scale}
            as="span" segments={[{ key: 'footprint', bytes, color: ASPECT_COLOR.weights, title: text, hatched: !estimated }]} />
        </span>
      )}
      <span id={id} className="mt-0.5 block text-2xs text-ink-faint">{text}</span>
    </span>
  );
}
