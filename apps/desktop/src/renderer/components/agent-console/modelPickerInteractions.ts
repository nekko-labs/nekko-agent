import type { ModelInfo, ProviderConfig } from '@nekko-agent/shared';

export const modelPickerKey = (providerId: string, modelId: string) => `${providerId}::${modelId}`;

export function matchesModelQuery(model: Pick<ModelInfo, 'id' | 'name' | 'details'>, query: string): boolean {
  const q = query.trim().toLowerCase();
  const path = typeof model.details?.path === 'string' ? model.details.path.toLowerCase() : '';
  return !q || model.name.toLowerCase().includes(q) || model.id.toLowerCase().includes(q) || path.includes(q);
}

export function filteredModelGroups(
  providers: ProviderConfig[],
  modelsOf: (providerId: string) => ModelInfo[],
  query: string,
): Array<{ provider: ProviderConfig; models: ModelInfo[] }> {
  return providers
    .map((provider) => ({ provider, models: modelsOf(provider.id).filter((model) => matchesModelQuery(model, query)) }))
    .filter((group) => group.models.length > 0);
}

/**
 * What a picker row shows for a model: a short name, and beneath it where the
 * model lives. A local model's id is often a path in itself
 * (`lmstudio/lmstudio-community/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M`), which reads
 * badly as a label, so when the server sent no friendlier name the last
 * segment is the name and the rest becomes the sub-line. The file path the
 * engine sends always wins as the sub-line.
 */
export function modelRowLabel(model: Pick<ModelInfo, 'id' | 'name' | 'details'>, local: boolean): { name: string; sub?: string } {
  const path = typeof model.details?.path === 'string' ? model.details.path : undefined;
  // Only a local server's ids are file layouts; a cloud id like `meta/llama`
  // keeps its name and its price line.
  const pathLike = local && model.name === model.id && /[\\/]/.test(model.id);
  if (!pathLike) return { name: model.name, sub: path };
  const parts = model.id.split(/[\\/]/).filter(Boolean);
  const name = (parts.pop() ?? model.id).replace(/\.gguf$/i, '');
  return { name, sub: path ?? (parts.join('/') || undefined) };
}

export function nextFavoriteModels(current: readonly string[] | undefined, key: string): string[] {
  const next = new Set(current ?? []);
  next.has(key) ? next.delete(key) : next.add(key);
  return [...next];
}

type PickerTarget = EventTarget & {
  closest?: (selector: string) => unknown;
};

type PickerRoot = {
  contains?: (target: never) => boolean;
};

export function shouldDismissModelPickerPointer(
  target: EventTarget | null,
  triggerRoot: PickerRoot | null,
  popupRoot: PickerRoot | null,
): boolean {
  const element = target as PickerTarget | null;
  if (element?.closest?.('[role=menu]')) return false;
  if (target && triggerRoot?.contains?.(target as never)) return false;
  if (target && popupRoot?.contains?.(target as never)) return false;
  return true;
}

export function isModelPickerEscape(event: Pick<KeyboardEvent, 'key'>): boolean {
  return event.key === 'Escape';
}

