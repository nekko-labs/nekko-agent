import { ModelDownloadButton } from './ModelDownloadButton.js';
import { useStore } from '../../store.js';
import { useEffect, useState } from 'react';
import type { LocalModel, Recommendations, TaskRecommendation } from '@nekko-agent/shared';
import { CheckIcon, ChevronIcon } from '../../icons.js';
import { formatBytes } from '../runtimes/verdict.js';
import { fitText, hardwareText, isDownloaded, memoryText, nudgeTitle, speedText } from './recommendationText.js';

/**
 * "What should I run here", answered per task before anything is downloaded.
 *
 * The daemon picks from a list shipped with the app against this machine's
 * profile (`machine:recommendations`): for each task, the best model that fits
 * with room to spare and is fast enough, at its best quant. A row is that one
 * decision, with what it costs: the download, the memory it takes out of what
 * the machine has, and the speed to expect, labelled by how sure it is.
 *
 * Open on a machine with nothing downloaded, where it is the question; folded
 * to its summary once there are models, where it is a second opinion. An
 * upgrade (a new GPU, or a newer list, ranking a better model above the one
 * the user has) is said above it, folded or not.
 */
export function RecommendedModels({ models, onQueued }: { models: LocalModel[]; onQueued: () => void }) {
  const [recs, setRecs] = useState<Recommendations | null>(null);
  const [failed, setFailed] = useState(false);
  const [checking, setChecking] = useState(false);
  const pushToast = useStore(s => s.pushToast);
  // Decided once: a list that arrives later must not fold the block under the reader.
  const [open] = useState(models.length === 0);

  const load = (refresh: boolean) => {
    setChecking(true);
    window.nekko
      .machineRecommendations(refresh ? { refresh } : undefined)
      .then(r => { setRecs(r); setFailed(false); })
      .catch(() => setFailed(true))
      .finally(() => setChecking(false));
  };
  useEffect(() => load(false), []);

  const download = (_task: TaskRecommendation, res?: { ok: boolean; message: string }) => {
    if (!res) return;
    pushToast(res.ok ? 'info' : 'error', res.message);
    if (res.ok) onQueued();
  };

  const dismiss = () => {
    // Every task's current pick is kept as seen, so the card goes and stays gone.
    void window.nekko.machineDismissNudge().catch(() => undefined);
    setRecs(r => (r ? { ...r, nudges: [] } : r));
  };

  // Nothing to say rather than a broken box: the rest of the page still works.
  if (failed || !recs) return null;
  return (
    <>
      <UpgradeNudges recs={recs} onDownload={download} onDismiss={dismiss} />
      <RecommendationList
        recs={recs}
        models={models}
        open={open}
        checking={checking}
        onDownload={download}
        onRecheck={() => load(true)}
      />
    </>
  );
}

/** "A better coding model now fits your 16 GB GPU", with the model it would replace. */
export function UpgradeNudges({
  recs,
  queued = {},
  onDownload,
  onDismiss,
}: {
  recs: Recommendations;
  queued?: Record<string, string>;
  onDownload: (task: TaskRecommendation, result?: { ok: boolean; message: string }) => void;
  onDismiss: () => void;
}) {
  const rows = (recs.nudges ?? [])
    .map(n => ({ n, t: recs.tasks.find(t => t.task === n.task) }))
    .filter((x): x is { n: (typeof recs.nudges)[number]; t: TaskRecommendation } => !!x.t?.pick);
  if (!rows.length) return null;
  return (
    <div
      className="mb-3 rounded-xl border p-4"
      style={{ borderColor: 'color-mix(in srgb, var(--accent) 35%, var(--line))', background: 'color-mix(in srgb, var(--accent) 7%, transparent)' }}
      role="status"
      data-upgrade-nudges
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold">{nudgeTitle(recs)}</p>
        <button className="btn btn-ghost py-0.5 text-xs text-ink-faint" onClick={onDismiss}>
          Not now
        </button>
      </div>
      <div className="mt-1 space-y-1">
        {rows.map(({ n, t }) => {
          const p = t.pick!;
          const state = queued[t.task];
          return (
            <div key={n.task} className="flex flex-wrap items-center gap-x-2 gap-y-1" data-upgrade-nudge={n.task}>
              <span className="w-[118px] shrink-0 text-xs text-ink-faint">{t.label}</span>
              <span className="min-w-0 flex-1 text-xs">
                <span className="font-medium">{p.name}</span> <span className="text-ink-faint">{p.quant} · {formatBytes(p.downloadBytes)} download, instead of {n.haveName}</span>
              </span>
              {state ? (
                <span className="text-xs text-ink-faint">{state}</span>
              ) : (
                <ModelDownloadButton modelId={p.repo} quant={p.downloadLabel} onResult={res => onDownload(t, res)} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The block itself, from props only. */
export function RecommendationList({
  recs,
  models,
  open,
  checking = false,
  queued = {},
  onDownload,
  onRecheck,
}: {
  recs: Recommendations;
  models: Pick<LocalModel, 'path'>[];
  open: boolean;
  checking?: boolean;
  /** Per task, what happened to its download request. */
  queued?: Record<string, string>;
  onDownload: (task: TaskRecommendation, result?: { ok: boolean; message: string }) => void;
  onRecheck: () => void;
}) {
  const picked = recs.tasks.filter(t => t.pick);
  return (
    <details className="group card mb-5 p-4" open={open} data-recommendations>
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1">
        <ChevronIcon className="h-3.5 w-3.5 shrink-0 text-ink-faint transition-transform group-open:rotate-90" />
        <span className="text-sm font-semibold">Best for this machine</span>
        <span className="text-xs text-ink-faint">{hardwareText(recs)}</span>
        <span className="ml-auto text-xs text-ink-faint group-open:hidden">
          {picked.length} pick{picked.length === 1 ? '' : 's'}
        </span>
      </summary>
      <div className="mt-3 divide-y divide-line">
        {picked.map(t => {
          const p = t.pick!;
          const speed = speedText(p, t, recs.hardware);
          const fit = fitText(p);
          const have = isDownloaded(p, models);
          const state = queued[t.task];
          return (
            <div key={t.task} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2" data-recommendation={t.task}>
              <div className="w-[118px] shrink-0 text-xs text-ink-faint">{t.label}</div>
              <div className="min-w-[180px] flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium">{p.name}</span>
                  <span className="chip" title={`${p.repo}: ${p.files.join(', ')}`}>{p.quant}</span>
                  <span
                    className="rounded-full px-2 py-0.5 text-2xs"
                    style={{
                      background: `color-mix(in srgb, ${p.fit === 'fits' ? 'var(--success)' : 'var(--warning, #d1a054)'} 16%, transparent)`,
                      color: p.fit === 'fits' ? 'var(--success)' : 'var(--warning, #d1a054)',
                    }}
                    title={fit.title}
                  >
                    {fit.text}
                  </span>
                </div>
                <p className="mt-0.5 text-2xs text-ink-faint">
                  <span title="Weights, the conversation's memory at this task's context, and the engine's working buffers">
                    {memoryText(p, recs.budget)}
                  </span>
                  {' · '}
                  {formatBytes(p.downloadBytes)} download
                  {speed && (
                    <>
                      {' · '}
                      <span className="text-ink-soft" title={speed.title} data-speed-basis={p.speed?.basis ?? 'unknown'}>
                        {speed.text}
                      </span>
                    </>
                  )}
                </p>
                {t.belowTargetSpeed && (
                  <p className="mt-0.5 text-2xs" style={{ color: 'var(--warning, #d1a054)' }}>
                    Slower than the {t.minTokensPerSecond} tok/s this task wants; the fastest that fits here.
                  </p>
                )}
              </div>
              <div className="shrink-0">
                {have ? (
                  <span className="inline-flex items-center gap-1 text-xs text-success">
                    <CheckIcon className="h-3.5 w-3.5" /> Downloaded
                  </span>
                ) : state ? (
                  <span className="text-xs text-ink-faint" role="status">{state}</span>
                ) : (
                  <ModelDownloadButton modelId={p.repo} quant={p.downloadLabel} onResult={res => onDownload(t, res)} />
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-2xs text-ink-faint">
        <span>
          From the model list shipped with this version ({recs.feedVersion}). Speeds are for the start of a conversation: ~ marks an estimate, "here" what this machine measured.
        </span>
        <button className="btn btn-ghost py-1 text-xs" onClick={onRecheck} disabled={checking}>
          {checking ? 'Checking…' : 'Check this machine again'}
        </button>
      </div>
    </details>
  );
}
