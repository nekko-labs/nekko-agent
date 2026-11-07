import { useEffect, useState } from 'react';
import { DEFAULT_IMAGE_CHAT_PARAMS, type ImageCompanionStatus, type LocalModel, type Session } from '@nekko-agent/shared';
import { useStore } from '../../store.js';
import { PhotoModelSetup } from './PhotoModelSetup.js';
import { ensureRecommendedOffload } from './imageOffload.js';

/**
 * A photo is attached but the chat's model cannot edit (decision 0067): offer
 * one that can rather than ignore the photo. A picture model already on this
 * computer that edits is one press away; otherwise the Edit photos picks for
 * this machine, downloaded the same way as the first picture model. The draft
 * and the attached photo stay in the composer, so sending again is all that
 * is left once the chat has an edit model.
 */

export interface EditableModel {
  model: LocalModel;
  status: ImageCompanionStatus;
}

/** The picture models on disk that can edit, with what they still lack. */
export function editableModels(models: LocalModel[], statuses: Record<string, ImageCompanionStatus | null>): EditableModel[] {
  return models
    .filter((m) => m.modality === 'image')
    .flatMap((m) => {
      const status = statuses[m.id];
      return status?.capabilities?.includes('edit') ? [{ model: m, status }] : [];
    });
}

export function EditModelOffer({ session, onReady, onDismiss }: { session: Session; onReady: (s: Session) => void; onDismiss: () => void }) {
  const pushToast = useStore((s) => s.pushToast);
  const [editable, setEditable] = useState<EditableModel[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const models = (await window.nekko.engineModels().catch(() => [] as LocalModel[])).filter((m) => m.modality === 'image');
      const statuses = Object.fromEntries(
        await Promise.all(models.map(async (m) => [m.id, await window.nekko.engineImageCompanions(m.id).catch(() => null)] as const)),
      );
      setEditable(editableModels(models, statuses));
    })();
  }, []);

  const use = async ({ model, status }: EditableModel) => {
    setBusy(true);
    try {
      await ensureRecommendedOffload(model);
      if (!status.ready) {
        const r = await window.nekko.engineDownloadImageCompanions(model.id);
        pushToast(r.ok ? 'info' : 'error', r.message);
      }
      const params = { ...DEFAULT_IMAGE_CHAT_PARAMS, ...session.imageParams, modelId: model.id, steps: status.defaults.steps, cfgScale: status.defaults.cfgScale };
      const next = await window.nekko.setSessionOptions(session.id, { imageParams: params });
      if (next) onReady(next);
    } catch (e) {
      pushToast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!editable) return null;
  return (
    <div className="card mx-3 mb-2 p-4" role="region" aria-label="Edit photos" data-edit-offer>
      <div className="mb-3 flex items-start justify-between gap-3">
        <p className="text-sm">
          <span className="font-semibold">This model makes new pictures but can't change a photo.</span>{' '}
          <span className="text-ink-soft">Your prompt and photo are kept.</span>
        </p>
        <button type="button" className="btn btn-ghost shrink-0 py-0.5 text-xs text-ink-faint" onClick={onDismiss}>Not now</button>
      </div>
      {editable.length ? (
        <EditableList editable={editable} busy={busy} onUse={(e) => void use(e)} />
      ) : (
        <div className="flex justify-center"><PhotoModelSetup session={session} onReady={onReady} capability="edit" force /></div>
      )}
    </div>
  );
}

/** The picture models already here that edit, from props only. */
export function EditableList({ editable, busy = false, onUse }: { editable: EditableModel[]; busy?: boolean; onUse: (e: EditableModel) => void }) {
  return (
    <ul className="space-y-2" aria-label="Models on this computer that edit photos">
      {editable.map((e) => (
        <li key={e.model.id} className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2" data-editable-model={e.model.id}>
          <span className="min-w-0 text-xs">
            <span className="font-medium">{e.status.label}</span>
            <span className="text-ink-faint">
              {e.status.capabilities.includes('create') ? ' · also makes new pictures' : ' · edits only'}
              {e.status.ready ? '' : ' · its supporting files download first'}
            </span>
          </span>
          <button type="button" className="btn btn-primary shrink-0 py-1 text-xs" disabled={busy} onClick={() => onUse(e)}>
            Use {e.status.label}
          </button>
        </li>
      ))}
    </ul>
  );
}
