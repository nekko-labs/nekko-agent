import { ModelDownloadButton } from './ModelDownloadButton.js';
import { useStore } from '../../store.js';
import { useEffect, useState } from 'react';
import type { ImageRecommendedOption, LocalModel, RecommendationPlacement, RecommendedOption, Recommendations, TaskRecommendation } from '@nekko-agent/shared';
import { formatBytes, formatTokens } from '../runtimes/verdict.js';
import { StatusDot } from '../primitives/index.js';
import { fitText, hardwareText, isDownloaded, memoryText, nudgeTitle, speedText } from './recommendationText.js';
import { pictureTimeText } from './pictureModelText.js';
import { contextFitText, memorySplit, paramsLabel } from './modelFacts.js';

/**
 * "What should I run here", answered per task before anything is downloaded.
 *
 * The daemon picks from a list shipped with the app against this machine's
 * profile (`machine:recommendations`): for each task, the best model that fits
 * with room to spare and is fast enough, at its best quant. A row is that one
 * decision, with what it costs and what it leaves: its parameters, the
 * download, the memory it takes at the task's context (weights, then the
 * context and working buffers, drawn on one meter against the machine's
 * budget), the longest context that still fits, and the speed to expect,
 * labelled by how sure it is. Quants opens every quant of that model with the
 * same figures, so a bigger or smaller build is one click away.
 *
 * It leads Find new models, the half of the Models page about getting a model;
 * an upgrade (a new GPU, or a newer list, ranking a better model above the one
 * the user has) is said above it.
 */
export function RecommendedModels({ models, onQueued, nudgesOnly = false }: { models: LocalModel[]; onQueued: () => void; /** On this machine: only an upgrade, the picks stay in Find. */ nudgesOnly?: boolean }) {
  const [recs, setRecs] = useState<Recommendations | null>(null);
  const [failed, setFailed] = useState(false);
  const [checking, setChecking] = useState(false);
  const pushToast = useStore(s => s.pushToast);

  const load = (refresh: boolean) => {
    setChecking(true);
    window.nekko
      .machineRecommendations(refresh ? { refresh } : undefined)
      .then(r => { setRecs(r); setFailed(false); })
      .catch(() => setFailed(true))
      .finally(() => setChecking(false));
  };
  useEffect(() => load(false), []);

  const download = (_task: { task: string }, res?: { ok: boolean; message: string }) => {
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
      {!nudgesOnly && <RecommendationList recs={recs} models={models} checking={checking} onDownload={download} onRecheck={() => load(true)} />}
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
    <div className="mb-(--q-group)" role="status" data-upgrade-nudges>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-info">{nudgeTitle(recs)}</p>
        <button className="btn btn-ghost py-0.5 text-xs text-ink-faint" onClick={onDismiss}>
          Not now
        </button>
      </div>
      <div className="mt-(--q-tight)">
        {rows.map(({ n, t }) => {
          const p = t.pick!;
          const state = queued[t.task];
          return (
            <div key={n.task} className="flex min-h-(--q-row) flex-wrap items-center gap-x-2 gap-y-1" data-upgrade-nudge={n.task}>
              <span className="w-[96px] shrink-0 text-xs text-ink-faint">{t.label}</span>
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

/** Where the budget lives, for "fits in …". */
export function budgetPlace(placement: RecommendationPlacement): string {
  return placement === 'gpu' ? 'this GPU' : placement === 'unified' ? 'the GPU share of memory' : 'memory';
}

/** The block itself, from props only. */
export function RecommendationList({
  recs,
  models,
  checking = false,
  queued = {},
  onDownload,
  onRecheck,
}: {
  recs: Recommendations;
  models: Pick<LocalModel, 'path'>[];
  checking?: boolean;
  /** Per task, what happened to its download request. */
  queued?: Record<string, string>;
  onDownload: (task: { task: string }, result?: { ok: boolean; message: string }) => void;
  onRecheck: () => void;
}) {
  const picked = recs.tasks.filter(t => t.pick);
  const pictures = (recs.imageTasks ?? []).filter(t => t.pick);
  return (
    <section className="min-w-0" data-recommendations aria-labelledby="recommendations-title">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h3 id="recommendations-title" className="quiet-group-label">Best for this machine</h3>
        <span className="text-xs text-ink-faint">{hardwareText(recs)}</span>
        <button className="btn btn-ghost ml-auto py-1 text-xs" onClick={onRecheck} disabled={checking}>
          {checking ? 'Checking…' : 'Check this machine again'}
        </button>
      </div>
      <div className="mt-(--q-heading)">
        {picked.map(t => (
          <TaskPickRow key={t.task} t={t} recs={recs} models={models} state={queued[t.task]} onDownload={res => onDownload(t, res)} />
        ))}
        {pictures.map(t => (
          <ImageRecommendationRow key={t.task} label={t.label} p={t.pick!} recs={recs} have={isDownloaded(t.pick!, models)} state={queued[t.task]}
            onDownload={res => onDownload({ task: t.task }, res)} />
        ))}
      </div>
      <div className="mt-(--q-inline) flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-ink-faint">
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-1.5 w-2.5 rounded-sm bg-meter-model" aria-hidden />weights</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-1.5 w-2.5 rounded-sm bg-meter-context" aria-hidden />context and working memory</span>
        <span>{feedText(recs)} Speeds are for the start of a conversation: ~ marks an estimate, "here" what this machine measured.</span>
      </div>
    </section>
  );
}

/** Weights, then context and working memory, against the budget. */
export function MemoryMeter({ memoryBytes, weightsBytes, budgetBytes, className = '' }: { memoryBytes: number; weightsBytes: number; budgetBytes: number; className?: string }) {
  const { weights, rest } = memorySplit(memoryBytes, weightsBytes, budgetBytes);
  return (
    <span
      className={`relative inline-block h-1.5 overflow-hidden rounded-full bg-meter-track ${className}`}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={budgetBytes}
      aria-valuenow={memoryBytes}
      aria-label={`${formatBytes(memoryBytes)} of ${formatBytes(budgetBytes)}`}
    >
      {/* The whole fill as one bar, weights drawn over its start: no seam between the two to show a gap. */}
      <span className="absolute inset-y-0 left-0 rounded-r-full bg-meter-context transition-[width] duration-(--dur-slow) ease-(--ease-out)" style={{ width: `${(weights + rest) * 100}%` }} />
      <span className={`absolute inset-y-0 left-0 bg-meter-model transition-[width] duration-(--dur-slow) ease-(--ease-out) ${rest > 0 ? '' : 'rounded-r-full'}`} style={{ width: `${weights * 100}%` }} />
    </span>
  );
}

const FIT_WORD = { fits: 'Fits', tight: 'Tight', tooBig: 'Too big' } as const;
const FIT_TEXT_CLASS = { fits: 'text-success', tight: 'text-warning-text', tooBig: 'text-danger-text' } as const;

/** One task's pick: what it is, what it needs, what it leaves, and every other quant behind Quants. */
function TaskPickRow({
  t,
  recs,
  models,
  state,
  onDownload,
}: {
  t: TaskRecommendation;
  recs: Recommendations;
  models: Pick<LocalModel, 'path'>[];
  state?: string;
  onDownload: (result?: { ok: boolean; message: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const p = t.pick!;
  const speed = speedText(p, t, recs.hardware);
  const fit = fitText(p);
  const have = isDownloaded(p, models);
  const params = paramsLabel(p.name);
  const place = budgetPlace(p.placement);
  const context = contextFitText(p.fitContextTokens, p.maxContextTokens, place);
  const quants = p.quants ?? [];
  return (
    <div data-recommendation={t.task}>
      <div className="-mx-2 flex flex-wrap items-start gap-x-4 gap-y-1 rounded-lg px-2 py-(--q-inline)" data-quiet-row>
        <div className="w-[96px] shrink-0 pt-0.5 text-xs text-ink-faint">{t.label}</div>
        <div className="min-w-[220px] flex-1">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-medium">{p.name}</span>
            <span className="text-xs text-ink-faint" title={`${p.repo}: ${p.files.join(', ')}`}>
              {[params, p.quant, `${formatBytes(p.downloadBytes)} download`].filter(Boolean).join(' · ')}
            </span>
          </p>
          <p className="mt-(--q-tight) flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
            <MemoryMeter memoryBytes={p.memoryBytes} weightsBytes={p.downloadBytes} budgetBytes={recs.budget.bytes} className="w-[200px]" />
            <span title="Weights, the conversation's memory at this task's context, and the engine's working buffers">
              <span className="text-ink">{formatBytes(p.memoryBytes)}</span> of {formatBytes(recs.budget.bytes)} at {formatTokens(p.contextTokens)} context
            </span>
            {speed && (
              <span className="text-ink-soft" title={speed.title} data-speed-basis={p.speed?.basis ?? 'unknown'}>
                {speed.text}
              </span>
            )}
          </p>
          {context && <p className="mt-(--q-tight) text-xs text-ink-faint" data-context-fit>Context: {context}</p>}
          {t.belowTargetSpeed && (
            <p className="mt-(--q-tight) text-xs text-warning-text">
              Slower than the {t.minTokensPerSecond} tok/s this task wants; the fastest that fits here.
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`inline-flex items-center gap-1.5 text-xs ${p.fit === 'fits' ? 'text-ink-soft' : 'text-warning-text'}`} title={fit.title}>
            <StatusDot tone={p.fit === 'fits' ? 'success' : 'warning'} size={6} />
            {have ? 'Downloaded' : fit.text}
          </span>
          {quants.length > 1 && (
            <button type="button" className="btn btn-ghost py-1 text-xs" aria-expanded={open} data-quants-toggle onClick={() => setOpen(v => !v)}>
              Quants
            </button>
          )}
          {have ? null : state ? (
            <span className="text-xs text-ink-faint" role="status">{state}</span>
          ) : (
            <ModelDownloadButton modelId={p.repo} quant={p.downloadLabel} onResult={onDownload} variant="quiet" />
          )}
        </div>
      </div>
      <div className={`collapse-wrap ${open ? '' : 'collapsed'}`} aria-hidden={!open}>
        <div className="min-h-0 overflow-hidden">
          {open && <QuantTable p={p} models={models} place={place} onDownload={onDownload} />}
        </div>
      </div>
    </div>
  );
}

/** Every quant of one pick's model: its weights, its memory at the task's context, and the context that fits. */
export function QuantTable({
  p,
  models,
  place,
  onDownload,
}: {
  p: RecommendedOption;
  models: Pick<LocalModel, 'path'>[];
  place: string;
  onDownload: (result?: { ok: boolean; message: string }) => void;
}) {
  return (
    <table className="mb-(--q-inline) ml-[112px] w-[calc(100%-112px)] text-xs" data-quant-table>
      <thead>
        <tr className="text-left text-ink-soft">
          <th className="py-1 pr-4 font-medium">Quant</th>
          <th className="py-1 pr-4 text-right font-medium">Weights</th>
          <th className="py-1 pr-4 text-right font-medium">Memory at {formatTokens(p.contextTokens)}</th>
          <th className="py-1 pr-4 text-right font-medium">Context that fits</th>
          <th className="py-1 pr-4 font-medium">Fit</th>
          <th className="py-1" />
        </tr>
      </thead>
      <tbody className="tabular-nums">
        {(p.quants ?? []).map(q => {
          const pick = q.quant === p.quant;
          const have = isDownloaded(q, models);
          return (
            <tr key={q.quant} className={pick ? 'bg-accent-soft' : undefined} data-quant={q.quant}>
              <td className="rounded-l-md py-1 pl-1 pr-4 font-mono text-2xs">{q.quant}{pick ? <span className="font-sans text-ink-faint"> · pick</span> : null}</td>
              <td className="py-1 pr-4 text-right">{formatBytes(q.downloadBytes)}</td>
              <td className="py-1 pr-4 text-right">{formatBytes(q.memoryBytes)}</td>
              <td className="py-1 pr-4 text-right" title={`The longest context that fits in ${place} beside these weights`}>{q.fitContextTokens > 0 ? formatTokens(q.fitContextTokens) : 'none'}</td>
              <td className={`py-1 pr-4 ${FIT_TEXT_CLASS[q.fit]}`}>{FIT_WORD[q.fit]}</td>
              <td className="rounded-r-md py-1 pr-1 text-right">
                {have ? <span className="text-ink-faint">Downloaded</span> : q.fit === 'tooBig' ? null : <ModelDownloadButton modelId={p.repo} quant={q.downloadLabel} onResult={onDownload} variant="quiet" />}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Where the list came from: the one this version shipped, or a newer one an update check brought. */
export function feedText(recs: Pick<Recommendations, 'feedVersion' | 'feedSource'>): string {
  return recs.feedSource === 'update'
    ? `From an updated model list (${recs.feedVersion}), newer than the one this version shipped.`
    : `From the model list shipped with this version (${recs.feedVersion}).`;
}

/** "4.6 GB of 7 GB (estimated)": a picture model's memory is not measured yet, so it says so. */
export function imageFitText(p: ImageRecommendedOption): { text: string; title: string } {
  if (p.offloadToCpu) {
    return { text: p.fit === 'fits' ? 'Fits with offload' : 'Tight, with offload', title: 'Fits only by keeping part of it in system memory (CPU offload), so pictures take longer. Nekko turns that on when a Photo chat first uses it.' };
  }
  return p.fit === 'fits'
    ? { text: 'Fits', title: `Leaves about ${formatBytes(p.headroomBytes)}, by an estimate: picture models are not measured yet.` }
    : { text: 'Tight fit', title: `Leaves about ${formatBytes(p.headroomBytes)}, by an estimate: it should run, with little to spare.` };
}

/** One picture task's pick: its supporting files counted in the download, and a time only when one was measured. */
function ImageRecommendationRow({
  label,
  p,
  recs,
  have,
  state,
  onDownload,
}: {
  label: string;
  p: ImageRecommendedOption;
  recs: Recommendations;
  have: boolean;
  state?: string;
  onDownload: (result?: { ok: boolean; message: string }) => void;
}) {
  const fit = imageFitText(p);
  const time = pictureTimeText(p);
  const ok = p.fit === 'fits' && !p.offloadToCpu;
  const params = paramsLabel(p.name);
  return (
    <div className="-mx-2 flex flex-wrap items-start gap-x-4 gap-y-1 rounded-lg px-2 py-(--q-inline)" data-recommendation={p.modelId} data-image-recommendation data-quiet-row>
      <div className="w-[96px] shrink-0 pt-0.5 text-xs text-ink-faint">{label}</div>
      <div className="min-w-[220px] flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-medium">{p.name}</span>
          <span className="text-xs text-ink-faint" title={`${p.repo}: ${p.files.join(', ')}`}>
            {[params, p.quant, `${formatBytes(p.downloadBytes)} download, with its supporting files`, p.license].filter(Boolean).join(' · ')}
          </span>
        </p>
        <p className="mt-(--q-tight) flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
          <MemoryMeter memoryBytes={p.memoryBytes} weightsBytes={Math.min(p.memoryBytes, p.downloadBytes)} budgetBytes={recs.budget.bytes} className="w-[200px]" />
          <span title="Every file plus working room, or with offload the largest file plus working room. Not measured yet.">
            ~{memoryText({ memoryBytes: p.memoryBytes } as RecommendedOption, recs.budget)}
          </span>
          {time && <span className="text-ink-soft" title={time.title} data-picture-time={p.time?.basis}>{time.text}</span>}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className={`inline-flex items-center gap-1.5 text-xs ${ok ? 'text-ink-soft' : 'text-warning-text'}`} title={fit.title}>
          <StatusDot tone={ok ? 'success' : 'warning'} size={6} />
          {have ? 'Downloaded' : fit.text}
        </span>
        {have ? null : state ? (
          <span className="text-xs text-ink-faint" role="status">{state}</span>
        ) : (
          <ModelDownloadButton modelId={p.repo} quant={p.downloadLabel} onResult={onDownload} variant="quiet" />
        )}
      </div>
    </div>
  );
}
