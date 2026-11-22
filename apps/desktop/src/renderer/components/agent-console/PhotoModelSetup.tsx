import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_IMAGE_CHAT_PARAMS,
  type DownloadJob,
  type EngineStatus,
  type ImageCompanionStatus,
  type ImageRecommendedOption,
  type ImageTaskRecommendation,
  type LocalModel,
  type Recommendations,
  type Session,
} from '@nekko-agent/shared';
import { useStore } from '../../store.js';
import { CheckIcon, WarningIcon } from '../../icons.js';
import { formatBytes } from '../runtimes/verdict.js';
import { groupDownloads, isActive, type DownloadGroup } from '../engine/downloadGroups.js';
import { Progress, Step } from '../engine/FirstLocalModel.js';
import { ensureRecommendedOffload } from './imageOffload.js';
import { pictureModelBlurb, pictureTimeText } from '../engine/pictureModelText.js';
import './photoStart.css';

/**
 * A Photo chat with no picture model: two or three models picked for this
 * machine, one press to download the one chosen, and the chat ready to draw
 * when it lands (spec/models/photo-and-video-models.md, steps 1-3).
 *
 * The download is the Models page's own job (`engineDownloadModel`, then the
 * text encoders and VAE), so it shows in Models > Downloads too and cancelling
 * either cancels it. Nothing here is kept in the component that the engine
 * does not already report: leaving the chat mid-download and coming back
 * picks up where it is.
 */

const POLL_MS = 5000;
const MAX_CARDS = 3;

const base = (p: string) => p.split(/[\\/]/).pop()?.toLowerCase() ?? '';

export type PhotoSetupPhase =
  /** A picture model is ready, or the user has their own: nothing to show. */
  | { kind: 'hidden' }
  | { kind: 'choose' }
  | { kind: 'working'; step: 'engine' | 'model' | 'files'; group?: DownloadGroup }
  /** The weights landed; the text encoders and VAE are still to fetch. */
  | { kind: 'needsFiles'; model: LocalModel; option: ImageRecommendedOption }
  /** Everything is on disk: apply it to this chat. */
  | { kind: 'finish'; model: LocalModel; option: ImageRecommendedOption }
  | { kind: 'failed'; message: string };

/**
 * Where the setup is, from what the engine reports: its download jobs, the
 * models on disk, and (for a recommended model that landed) its companion files.
 * `companions` is `undefined` while still being read.
 */
export function photoSetupPhase(input: {
  jobs: DownloadJob[];
  models: LocalModel[];
  options: ImageRecommendedOption[];
  companions: ImageCompanionStatus | null | undefined;
  chatModelId?: string;
  runtimeReady: boolean;
  /** Show the choice even to someone with picture models of their own (none of which can do the job). */
  force?: boolean;
}): PhotoSetupPhase {
  const { jobs, models, options, companions, chatModelId, force } = input;
  const files = new Set(options.map((o) => base(o.files[0] ?? '')));
  const groups = groupDownloads(jobs);
  const ours = (g: DownloadGroup) =>
    g.id.startsWith('image-companions:') || g.jobs.some((j) => j.kind === 'model' && files.has(base(j.dest ?? j.file ?? '')));
  const active = (pick: (g: DownloadGroup) => boolean) => groups.find((g) => isActive(g.state) && pick(g));

  const engine = active((g) => g.jobs.some((j) => j.kind === 'engine' && j.id.startsWith('engine:diffusion:')));
  if (engine) return { kind: 'working', step: 'engine', group: engine };
  const weights = active((g) => ours(g) && !g.id.startsWith('image-companions:'));
  if (weights) return { kind: 'working', step: 'model', group: weights };
  const support = active((g) => g.id.startsWith('image-companions:'));
  if (support) return { kind: 'working', step: 'files', group: support };

  const pictures = models.filter((m) => m.modality === 'image');
  const landed = pictures.find((m) => files.has(base(m.path)));
  if (landed) {
    const option = options.find((o) => base(o.files[0] ?? '') === base(landed.path))!;
    if (!input.runtimeReady) return { kind: 'failed', message: 'The image engine is not installed yet. Retry setup to finish it.' };
    if (companions === undefined) return { kind: 'working', step: 'files' };
    if (companions === null) return { kind: 'failed', message: 'Could not verify the supporting files for this model. Check its setup in Models.' };
    if (companions && !companions.ready) {
      const failed = groups.find((g) => g.id === `image-companions:${landed.id}` && g.state === 'failed');
      return failed ? { kind: 'failed', message: failed.message ?? 'A supporting file stopped downloading.' } : { kind: 'needsFiles', model: landed, option };
    }
    return chatModelId === landed.id ? { kind: 'hidden' } : { kind: 'finish', model: landed, option };
  }
  // Someone with picture models of their own picks them in the chat's controls.
  if (pictures.length && !force) return { kind: 'hidden' };
  const failed = groups.find((g) => g.state === 'failed' && ours(g));
  if (failed) return { kind: 'failed', message: failed.message ?? 'The download stopped.' };
  return { kind: 'choose' };
}

/** The fit in words, then how long a picture takes when that was measured. Memory is an estimate, so nothing says "runs well". */
export function photoFitLine(o: ImageRecommendedOption, recs: Recommendations): string {
  const time = o.fit === 'tooBig' ? null : pictureTimeText(o);
  const fit = photoFitWords(o, recs);
  return time ? `${fit} About ${time.text.replace(/^~/, '')}${o.time?.basis === 'measured' ? ' on a computer like this' : ''}.` : fit;
}

function photoFitWords(o: ImageRecommendedOption, recs: Recommendations): string {
  const where = recs.hardware.device ? `your ${recs.hardware.device}` : 'this computer';
  if (o.fit === 'tooBig') return 'Too large for this computer.';
  if (o.offloadToCpu) return `Fits ${where} by keeping part of it in system memory, so pictures take longer.`;
  if (o.placement === 'cpu') return 'Runs on the processor here, so pictures take much longer than on a graphics card.';
  return o.fit === 'fits' ? `Fits ${where}.` : `Fits ${where}, with little room to spare.`;
}

/** The cards to offer: the pick first, then the other candidates, at most three. */
export function photoCards(task: ImageTaskRecommendation): ImageRecommendedOption[] {
  const rest = task.options.filter((o) => o.modelId !== task.pick?.modelId);
  return [...(task.pick ? [task.pick] : []), ...rest].slice(0, MAX_CARDS);
}

/**
 * `onShown` says whether the setup is on screen, so the chat can hide its own
 * "no image models yet" line while this offers the choice.
 */
export function PhotoModelSetup({
  session,
  onReady,
  onShown,
  capability = 'create',
  force = false,
}: {
  session: Session;
  onReady: (s: Session) => void;
  onShown?: (shown: boolean) => void;
  /** `edit` offers models that change a photo (Edit photos); `create` those that make one. */
  capability?: 'create' | 'edit';
  force?: boolean;
}) {
  const pushToast = useStore((s) => s.pushToast);
  const setView = useStore((s) => s.setView);
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [models, setModels] = useState<LocalModel[] | null>(null);
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [recs, setRecs] = useState<Recommendations | null>(null);
  const [companions, setCompanions] = useState<ImageCompanionStatus | null | undefined>(undefined);
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fetched = useRef(new Set<string>());
  const applied = useRef(new Set<string>());

  const refresh = useCallback(async () => {
    const [s, m, d] = await Promise.all([
      window.nekko.engineStatus().catch(() => null),
      window.nekko.engineModels().catch(() => [] as LocalModel[]),
      window.nekko.engineDownloads().catch(() => [] as DownloadJob[]),
    ]);
    if (s) setStatus(s);
    setModels(m);
    setJobs(d);
  }, []);

  useEffect(() => {
    void refresh();
    window.nekko.machineRecommendations().then(setRecs).catch(() => setRecs(null));
    const t = setInterval(refresh, POLL_MS);
    const off = window.nekko.onDownloadsUpdated((next) => {
      setJobs(next);
      if (next.some((j) => j.state === 'done')) void refresh();
    });
    return () => { clearInterval(t); off(); };
  }, [refresh]);

  const task = recs?.imageTasks?.find((t) => t.capability === capability);
  const options = task?.options ?? [];
  const pictures = models?.filter((m) => m.modality === 'image') ?? [];
  const landed = pictures.find((m) => options.some((o) => base(o.files[0] ?? '') === base(m.path)));

  // The landed model's text encoders and VAE: read again whenever downloads move.
  useEffect(() => {
    if (!landed) return;
    window.nekko.engineImageCompanions(landed.id).then(setCompanions).catch(() => setCompanions(null));
  }, [landed?.id, jobs]);

  const phase: PhotoSetupPhase =
    models && task
      ? photoSetupPhase({ jobs, models, options, companions: landed ? companions : null, chatModelId: session.imageParams?.modelId, force, runtimeReady: !!status?.diffusionInstall?.binPath })
      : { kind: 'hidden' };

  // The weights landed: fetch the rest without asking again.
  useEffect(() => {
    if (phase.kind !== 'needsFiles' || fetched.current.has(phase.model.id)) return;
    fetched.current.add(phase.model.id);
    void window.nekko.engineDownloadImageCompanions(phase.model.id).then((r) => {
      if (!r.ok) pushToast('error', r.message);
      void refresh();
    });
  }, [phase.kind === 'needsFiles' ? phase.model.id : null]);

  // Everything on disk: turn on offloading when the pick needs it, and make it this chat's model.
  useEffect(() => {
    if (phase.kind !== 'finish' || applied.current.has(phase.model.id)) return;
    applied.current.add(phase.model.id);
    const { model } = phase;
    void (async () => {
      try {
        await ensureRecommendedOffload(model, recs);
        const defaults = companions?.defaults;
        const params = { ...DEFAULT_IMAGE_CHAT_PARAMS, ...session.imageParams, modelId: model.id, ...(defaults ? { steps: defaults.steps, cfgScale: defaults.cfgScale } : {}) };
        const next = await window.nekko.setSessionOptions(session.id, { imageParams: params });
        if (next) onReady(next);
      } catch (e) {
        pushToast('error', (e as Error).message);
      }
    })();
  }, [phase.kind === 'finish' ? phase.model.id : null]);

  const shown = Boolean(status && recs && task) && phase.kind !== 'hidden' && phase.kind !== 'finish';
  useEffect(() => { onShown?.(shown); }, [shown]);
  useEffect(() => () => onShown?.(false), []);
  if (!shown || !status || !recs || !task) return null;
  const cards = photoCards(task);
  const choice = cards.find((c) => c.modelId === chosen) ?? cards.find((c) => c.fit !== 'tooBig');
  const engineReady = Boolean(status.diffusionInstall?.binPath);
  const canInstallEngine = engineReady || Boolean(status.diffusionInstall?.recommended);

  const setUp = async () => {
    if (!choice) return;
    setBusy(true);
    try {
      if (!engineReady) {
        const res = await window.nekko.engineInstall(status.diffusionInstall?.recommended?.id, 'diffusion');
        if (!res.ok) throw new Error(res.message);
      }
      const res = await window.nekko.engineDownloadModel(choice.repo, choice.downloadLabel);
      if (!res.ok) throw new Error(res.message);
    } catch (e) {
      pushToast('error', (e as Error).message);
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  const cancel = async () => {
    if (phase.kind !== 'working' || !phase.group) return;
    const ids = phase.group.jobs.filter((j) => isActive(j.state)).map((j) => j.id);
    await Promise.all(ids.map((id) => window.nekko.engineCancelDownload(id).catch(() => undefined)));
    void refresh();
  };

  return (
    <PhotoSetupSteps
      recs={recs}
      cards={cards}
      choice={choice}
      recommended={task.pick?.modelId}
      phase={phase}
      engineReady={engineReady}
      canInstallEngine={canInstallEngine}
      capability={capability}
      busy={busy}
      onChoose={setChosen}
      onSetUp={() => void setUp()}
      onCancel={() => void cancel()}
      onShowAll={() => setView('modelserver')}
    />
  );
}

const STEP_LABELS = ['Choose a model', 'Download', 'Describe your picture'] as const;

/** Where the first-model setup is: 1 choose, 2 download, 3 the message box. */
export function PhotoSetupProgress({ at }: { at: 0 | 1 | 2 }) {
  return (
    <ol className="photo-setup-steps" aria-label="Photo setup">
      {STEP_LABELS.map((label, i) => {
        const state = i < at ? 'done' : i === at ? 'current' : 'pending';
        return (
          <li key={label} data-state={state} aria-current={state === 'current' ? 'step' : undefined}>
            <span className="photo-setup-step-mark" aria-hidden="true">{state === 'done' ? <CheckIcon className="h-3 w-3" /> : i + 1}</span>
            <span>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** The setup itself, from props only. */
export function PhotoSetupSteps({
  recs,
  cards,
  choice,
  recommended,
  phase,
  engineReady,
  canInstallEngine,
  capability = 'create',
  busy = false,
  onChoose,
  onSetUp,
  onCancel,
  onShowAll,
}: {
  recs: Recommendations;
  cards: ImageRecommendedOption[];
  choice?: ImageRecommendedOption;
  /** The model picked for this machine, marked Recommended. */
  recommended?: string;
  phase: PhotoSetupPhase;
  engineReady: boolean;
  canInstallEngine: boolean;
  capability?: 'create' | 'edit';
  busy?: boolean;
  onChoose: (modelId: string) => void;
  onSetUp: () => void;
  onCancel: () => void;
  onShowAll: () => void;
}) {
  const seeAll = (
    <button type="button" className="photo-setup-link" onClick={onShowAll}>
      See all picture models
    </button>
  );

  if (phase.kind === 'working' || phase.kind === 'needsFiles') {
    const step = phase.kind === 'needsFiles' ? 'files' : phase.step;
    const order = ['engine', 'model', 'files'] as const;
    const state = (s: (typeof order)[number]) => (order.indexOf(s) < order.indexOf(step) ? 'done' : s === step ? 'active' : 'pending');
    const group = phase.kind === 'working' ? phase.group : undefined;
    return (
      <div className="photo-setup" data-photo-setup="working">
        {capability === 'create' && <PhotoSetupProgress at={1} />}
        <div className="photo-setup-head">
          <h3>Setting up a picture model</h3>
          <p>This can take a while. You can keep using Nekko; it also shows in Models &gt; Downloads.</p>
        </div>
        <ul className="photo-setup-tasks" aria-label="Setup steps">
          {!engineReady && <Step state={state('engine')} label="Get the free engine that makes pictures">{step === 'engine' && group && <Progress group={group} />}</Step>}
          <Step state={state('model')} label="Download the model">{step === 'model' && group && <Progress group={group} />}</Step>
          <Step state={state('files')} label="Download its supporting files">{step === 'files' && group && <Progress group={group} />}</Step>
        </ul>
        {group && <div className="photo-setup-actions"><button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button></div>}
      </div>
    );
  }

  const none = !cards.some((c) => c.fit !== 'tooBig');
  return (
    <div className="photo-setup" data-photo-setup={phase.kind}>
      {capability === 'create' && <PhotoSetupProgress at={0} />}
      <div className="photo-setup-head">
        <h3>{capability === 'edit' ? 'Choose a model that edits photos' : 'Choose a picture model'}</h3>
        <p>
          {capability === 'edit'
            ? 'It runs on this computer, so your photos stay here.'
            : 'It runs on this computer, so your prompts and pictures stay here.'}
        </p>
      </div>
      {phase.kind === 'failed' && (
        <p role="alert" className="photo-setup-alert">
          <span className="mt-0.5 shrink-0" style={{ color: 'var(--danger)' }}><WarningIcon className="h-4 w-4" /></span>
          <span>The download stopped: {phase.message} Press the button to try again; it picks up where it left off.</span>
        </p>
      )}
      {none ? (
        <p className="photo-setup-note">None of the recommended picture models fits this computer. {seeAll}</p>
      ) : (
        <div role="radiogroup" aria-label="Picture model" className="photo-setup-options">
          {cards.map((c) => {
            const on = c.modelId === choice?.modelId;
            const off = c.fit === 'tooBig';
            return (
              <button
                key={c.modelId}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={off}
                className="photo-setup-option quiet-row"
                onClick={() => onChoose(c.modelId)}
                data-photo-model={c.modelId}
              >
                <span className="photo-setup-radio" aria-hidden="true" />
                <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
                  <span className="photo-setup-option-title">
                    {c.name}
                    {c.modelId === recommended && !off && <span className="photo-setup-pick">Recommended</span>}
                  </span>
                  <span className="photo-setup-option-detail">{off ? 'Too large for this computer.' : pictureModelBlurb(c)}</span>
                </span>
                <span className="photo-setup-option-size">{formatBytes(c.downloadBytes)}</span>
              </button>
            );
          })}
        </div>
      )}
      {!none && choice && (
        <>
          <p className="photo-setup-fit">{photoFitLine(choice, recs)}</p>
          <div className="photo-setup-actions">
            <button type="button" className="btn btn-primary" disabled={busy || !canInstallEngine} onClick={onSetUp}>
              {busy ? 'Starting…' : `Download and set up · ${formatBytes(choice.downloadBytes)}`}
            </button>
            {seeAll}
          </div>
          <p className="photo-setup-note">
            {canInstallEngine
              ? `Includes its supporting files${engineReady ? '' : ', plus the free engine that makes pictures'}. Nothing downloads until you press the button. ${choice.license} license.`
              : 'The picture engine has no build for this computer yet.'}
          </p>
        </>
      )}
    </div>
  );
}
