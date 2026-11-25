import { useEffect, useState } from 'react';
import type { CatalogModelDetail, LocalModel } from '@nekko-agent/shared';
import { useStore } from '../../store.js';
import { loadCatalogDetail } from './catalogDetails.js';
import { ModelDownloadButton } from './ModelDownloadButton.js';
import { useDownloadAction } from './useDownloadAction.js';
import { offerText, runnableAlternative, updateBuildId, wantsAlternative, type RunnableAlternative } from './runnableAlternative.js';

/**
 * Under a row the engine refuses for its weight format: a build of the same model
 * from the same repo that it can run, with a Download that is the catalog's own
 * (so the projector comes along and the file lands where the library finds it,
 * in the same family as this one). Nothing shows unless the repo checks out.
 *
 * It reads the repo through the page the model's own details already load
 * (`loadCatalogDetail`), so this adds no request of its own, and only for a row
 * that is blocked and on screen: never for the polled listing.
 */
export function RunnableAlternativeOffer({ model, have, onChanged }: { model: LocalModel; have: readonly string[]; onChanged: () => void }) {
  // A row with nothing to offer mounts nothing, so no hook below runs for it.
  return wantsAlternative(model) ? <Offer model={model} have={have} onChanged={onChanged} /> : null;
}

function Offer({ model, have, onChanged }: { model: LocalModel; have: readonly string[]; onChanged: () => void }) {
  const [repo, setRepo] = useState<CatalogModelDetail | null>(null);
  useEffect(() => {
    let live = true;
    setRepo(null);
    loadCatalogDetail(model.sourceRepo!).then((r) => live && setRepo(r)).catch(() => undefined);
    return () => { live = false; };
  }, [model.sourceRepo]);
  const offer = runnableAlternative(model, repo, have);
  return offer ? <Shown offer={offer} onChanged={onChanged} /> : null;
}

function Shown({ offer, onChanged }: { offer: RunnableAlternative; onChanged: () => void }) {
  const pushToast = useStore((s) => s.pushToast);
  const [buildId, setBuildId] = useState<string>();
  const update = useDownloadAction({ runtime: 'llama' });
  // The Update button is the Model server card's own: the same install of the same build.
  useEffect(() => {
    if (!offer.engineTooOld) return;
    let live = true;
    window.nekko.engineStatus().then((s) => live && setBuildId(updateBuildId(s))).catch(() => undefined);
    return () => { live = false; };
  }, [offer.engineTooOld]);
  const updateEngine = async () => {
    if (!buildId) return;
    const res = await update.run(() => window.nekko.engineInstall(buildId));
    if (!res) return;
    pushToast(res.ok ? 'info' : 'error', res.ok ? 'Updating the engine. The server stops while it swaps in, so switch it back on once it finishes.' : res.message);
    onChanged();
  };
  return (
    <OfferView
      offer={offer}
      canUpdate={Boolean(buildId)}
      updating={update.active}
      onUpdate={() => void updateEngine()}
      onDownloaded={(res) => {
        pushToast(res.ok ? 'info' : 'error', res.message);
        if (res.ok) onChanged();
      }}
    />
  );
}

/** The line and its buttons. The Download is the catalog's own: this repo, this quant. */
export function OfferView({ offer, canUpdate, updating, onUpdate, onDownloaded }: {
  offer: RunnableAlternative;
  canUpdate: boolean;
  updating: boolean;
  onUpdate: () => void;
  onDownloaded: (res: { ok: boolean; message: string }) => void;
}) {
  return (
    <div className="mt-(--q-tight) flex flex-wrap items-center gap-x-3 gap-y-1 px-2 text-2xs text-ink-soft" data-runnable-alternative>
      <p className="min-w-0 flex-[1_1_16rem]">{offerText(offer)}</p>
      <div className="flex items-center gap-1">
        {offer.engineTooOld && canUpdate && (
          <button className="btn btn-ghost py-1 text-xs disabled:opacity-60" data-update-engine disabled={updating} onClick={onUpdate}>
            {updating ? 'Updating…' : 'Update engine'}
          </button>
        )}
        <ModelDownloadButton modelId={offer.repo} quant={offer.quant.label} variant="quiet" onResult={onDownloaded} />
      </div>
    </div>
  );
}
