import { useRef, useState } from 'react';
import { AUTO_MODEL_ID, MODEL_FOLDER_PROVIDERS, cannotLoadReason, modelModality, type AppSettings, type LocalModel } from '@nekko-agent/shared';
import { CheckIcon, StarIcon, TrashIcon } from '../../icons.js';
import { useStore } from '../../store.js';
import { notifyModelsChanged } from '../../modelCatalog.js';
import { confirmDeletion } from '../DeleteConfirmation.js';
import { companionKind } from './installedCompanions.js';
import { nextFavoriteModels } from '../agent-console/modelPickerInteractions.js';

function deletionPrompt(model: LocalModel) {
  const mlx = model.format === 'mlx';
  if (model.managed !== false && !mlx) return `Delete ${model.name} from this computer? You’ll need to download or import it again to use it.`;
  const provider = model.folderProvider && MODEL_FOLDER_PROVIDERS[model.folderProvider]?.label;
  const source = model.managed !== false ? '' : provider ? `This model came from ${provider}. ` : 'This model may have been downloaded by another app. ';
  const effect = model.folderProvider === 'ollama'
    ? 'This removes the model from Ollama but keeps shared downloads.'
    : mlx ? 'This deletes the model’s weights or cache links, not the folder or shared cache.'
      : 'This deletes the model file (including any numbered shards) or cache link.';
  const warning = model.managed === false && model.folderProvider !== 'ollama' ? ' Other apps may no longer be able to use it.' : '';
  return `Delete ${model.name}? ${source}${effect}${warning} Double-check this is the model you want to delete.\n\n${model.path}`;
}

export function chatDefaultEligible(model: LocalModel): boolean {
  const type = model.modality ?? modelModality(model);
  return !companionKind(model) && (type === 'chat' || type === 'vision') && !cannotLoadReason(model);
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
      const required = m.managed === false || m.format === 'mlx';
      if (!await confirmDeletion(deletionPrompt(m), { required })) return;
      const result = await window.nekko.engineDeleteModel(m.id, required ? m.path : undefined);
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
    {!companionKind(model) && <button type="button" className={`${button} ${starred ? 'text-accent' : 'text-ink-faint'}`} aria-pressed={starred} aria-label={`Favorite ${label}`} title={starred ? 'Remove from favorites' : 'Add to favorites'} disabled={actions.busy || !actions.ready} onClick={() => void actions.favorite(model)}>
      <StarIcon className="h-4 w-4" filled={starred} />
    </button>}
    {chatDefaultEligible(model) && <button type="button" className={`${button} ${isDefault ? 'text-accent' : 'text-ink-faint'}`} aria-pressed={isDefault} aria-label={`Set ${label} as default`} title={isDefault ? 'Default for new chats' : 'Set as default for new chats'} disabled={actions.busy || !actions.ready} onClick={() => { if (!isDefault) void actions.setDefault(model); }}>
      <CheckIcon className="h-4 w-4" />
    </button>}
    {model.path && <button type="button" className={`${button} text-ink-faint hover:text-danger-text`} aria-label={`Delete ${label}`} title="Delete from this computer" disabled={actions.busy} onClick={() => void actions.remove(model)}>
      <TrashIcon className="h-4 w-4" />
    </button>}
  </div>;
}
