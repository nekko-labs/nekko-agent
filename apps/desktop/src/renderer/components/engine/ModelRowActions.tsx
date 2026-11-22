import { useRef, useState } from 'react';
import { AUTO_MODEL_ID, modelModality, unsupportedLoadReason, type AppSettings, type LocalModel } from '@nekko-agent/shared';
import { CheckIcon, StarIcon, TrashIcon } from '../../icons.js';
import { useStore } from '../../store.js';
import { notifyModelsChanged } from '../../modelCatalog.js';
import { confirmDeletion } from '../DeleteConfirmation.js';
import { nextFavoriteModels } from '../agent-console/modelPickerInteractions.js';

// The engine's file-deletion route does not remove whole MLX directories.
export function canDeleteModel(model: LocalModel): boolean {
  return model.managed !== false && model.format !== 'mlx';
}

export function chatDefaultEligible(model: LocalModel): boolean {
  const type = model.modality ?? modelModality(model);
  return (type === 'chat' || type === 'vision') && !unsupportedLoadReason(model);
}

/** One owner for the family list and the variant pane, including in-flight actions. */
export function useModelRowActions(providerId: string, onChanged: () => void | Promise<void>) {
  const settings = useStore(s => s.settings);
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try { await action(); }
    catch (error) { useStore.getState().pushToast('error', error instanceof Error ? error.message : String(error)); }
    finally { lock.current = false; setBusy(false); }
  };
  const save = async (patch: Partial<AppSettings>) => {
    const next = await window.nekko.updateSettings(patch);
    useStore.setState({ settings: next });
  };
  const key = (m: LocalModel) => `${providerId}::${m.id}`;
  return {
    busy,
    ready: !!settings,
    isFavorite: (m: LocalModel) => settings?.favoriteModels?.includes(key(m)) ?? false,
    isDefault: (m: LocalModel) => settings?.defaultProviderId === providerId && settings.defaultModelId === m.id,
    favorite: (m: LocalModel) => run(() => save({ favoriteModels: nextFavoriteModels(useStore.getState().settings?.favoriteModels, key(m)) })),
    setDefault: (m: LocalModel) => run(() => save({ defaultProviderId: providerId, defaultModelId: m.id })),
    remove: (m: LocalModel) => run(async () => {
      if (!canDeleteModel(m) || !await confirmDeletion(`Delete ${m.name} from this computer? You’ll need to download or import it again to use it.`)) return;
      const result = await window.nekko.engineDeleteModel(m.id);
      useStore.getState().pushToast(result.ok ? 'success' : 'error', result.message);
      if (!result.ok) return;
      notifyModelsChanged();
      await onChanged();
      const current = useStore.getState().settings;
      const patch: Partial<AppSettings> = {};
      if (current?.favoriteModels?.includes(key(m))) patch.favoriteModels = current.favoriteModels.filter(favorite => favorite !== key(m));
      if (current?.defaultProviderId === providerId && current.defaultModelId === m.id) patch.defaultModelId = AUTO_MODEL_ID;
      if (Object.keys(patch).length) await save(patch);
    }),
  };
}
export type ModelRowControl = ReturnType<typeof useModelRowActions>;

const button = 'btn btn-ghost h-8 min-h-8! w-8 shrink-0 p-0! touch:h-11 touch:min-h-11! touch:w-11';

export function ModelRowActions({ model, label = model.name, actions }: { model: LocalModel; label?: string; actions: ModelRowControl }) {
  const starred = actions.isFavorite(model);
  const isDefault = actions.isDefault(model);
  return <div className="flex shrink-0 flex-wrap items-center gap-0.5" aria-label={`Actions for ${label}`} role="group">
    <button type="button" className={`${button} ${starred ? 'text-accent' : 'text-ink-faint'}`} aria-pressed={starred} aria-label={`Favorite ${label}`} title={starred ? 'Remove from favorites' : 'Add to favorites'} disabled={actions.busy || !actions.ready} onClick={() => void actions.favorite(model)}>
      <StarIcon className="h-4 w-4" filled={starred} />
    </button>
    {chatDefaultEligible(model) && <button type="button" className={`${button} ${isDefault ? 'text-accent' : 'text-ink-faint'}`} aria-pressed={isDefault} aria-label={`Set ${label} as default`} title={isDefault ? 'Default for new chats' : 'Set as default for new chats'} disabled={actions.busy || !actions.ready} onClick={() => { if (!isDefault) void actions.setDefault(model); }}>
      <CheckIcon className="h-4 w-4" />
    </button>}
    {canDeleteModel(model) && <button type="button" className={`${button} text-ink-faint hover:text-danger-text`} aria-label={`Delete ${label}`} title="Delete from this computer" disabled={actions.busy} onClick={() => void actions.remove(model)}>
      <TrashIcon className="h-4 w-4" />
    </button>}
  </div>;
}
