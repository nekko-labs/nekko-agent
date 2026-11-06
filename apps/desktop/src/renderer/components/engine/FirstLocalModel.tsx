import { useCallback, useEffect, useState } from 'react';
import type { DownloadJob, EngineStatus, LocalModel, Recommendations, TaskRecommendation } from '@nekko-agent/shared';
import { useStore } from '../../store.js';
import { ChatIcon, CheckIcon, CodeIcon, WarningIcon } from '../../icons.js';
import { formatBytes } from '../runtimes/verdict.js';
import { eta, groupDownloads, isActive, type DownloadGroup } from './downloadGroups.js';

/**
 * The Model Server page for someone with no local model yet.
 *
 * The full page answers every question an experienced user has (which build,
 * which quant, how many tokens a second, which folder), and to a newcomer that
 * is a wall. This asks one: what will you use it for? The engine, the build and
 * the quantization are decided from the machine's own recommendations, and the
 * engine comes along with the model in one press, so nobody has to learn that
 * a "runtime" exists before their first reply. Everything else is one link away.
 */

const PROVIDER_ID = 'nekko-engine';
const POLL_MS = 6000;

/** The two jobs a newcomer can name. Routing, embeddings and vision are for later. */
export const FIRST_USES = [
  { task: 'chat', title: 'Everyday help', blurb: 'Writing, questions, summaries and planning.', Icon: ChatIcon },
  { task: 'code', title: 'Writing code', blurb: 'Reading, explaining and changing code.', Icon: CodeIcon },
] as const;

const base = (p: string) => p.split(/[\\/]/).pop()?.toLowerCase() ?? '';

export type FirstModelPhase =
  | { kind: 'choose' }
  | { kind: 'working'; engine?: DownloadGroup; model?: DownloadGroup }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; model: LocalModel };

/** Where the newcomer is, read from what the engine reports rather than kept in the page. */
export function firstModelPhase(jobs: DownloadJob[], models: LocalModel[], picks: TaskRecommendation[]): FirstModelPhase {
  const groups = groupDownloads(jobs);
  const engine = groups.find((g) => g.jobs.some((j) => j.kind === 'engine') && isActive(g.state));
  const model = groups.find((g) => g.jobs.some((j) => j.kind === 'model') && isActive(g.state));
  if (engine || model) return { kind: 'working', engine, model };
  const failed = groups.find((g) => g.state === 'failed');
  const landed = models.find((m) => picks.some((t) => t.pick && base(m.path) === base(t.pick.files[0] ?? ''))) ?? models[0];
  if (landed) return { kind: 'ready', model: landed };
  if (failed) return { kind: 'failed', message: failed.message ?? 'The download stopped.' };
  return { kind: 'choose' };
}

/** "Runs well on your RTX 4060": the fit, in words, with no numbers to decode. */
export function fitSentence(t: TaskRecommendation, recs: Recommendations): string {
  const where = recs.hardware.device ? `your ${recs.hardware.device}` : 'this computer';
  const fit = t.pick?.fit === 'fits' ? `Runs well on ${where}.` : `Fits ${where}, with little room to spare.`;
  return t.belowTargetSpeed ? `${fit} Replies may be slow on this computer.` : fit;
}

export function FirstLocalModel({ onShowAll }: { onShowAll: () => void }) {
  const pushToast = useStore((s) => s.pushToast);
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [models, setModels] = useState<LocalModel[]>([]);
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [recs, setRecs] = useState<Recommendations | null>(null);
  const [task, setTask] = useState<string>('chat');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [s, m, d] = await Promise.all([
      window.nekko.engineStatus().catch(() => null),
      window.nekko.engineModels().catch(() => []),
      window.nekko.engineDownloads().catch(() => []),
    ]);
    if (s) setStatus(s);
    setModels(m);
    setJobs(d);
  }, []);

  useEffect(() => {
    void refresh();
    window.nekko.machineRecommendations().then(setRecs).catch(() => onShowAll());
    const t = setInterval(refresh, POLL_MS);
    const off = window.nekko.onDownloadsUpdated((next) => {
      setJobs(next);
      if (next.some((j) => j.state === 'done')) void refresh();
    });
    return () => { clearInterval(t); off(); };
  }, [refresh, onShowAll]);

  const picks = recs?.tasks.filter((t) => t.pick && FIRST_USES.some((u) => u.task === t.task)) ?? [];
  const engineReady = Boolean(status?.install.binPath);
  // Nothing to offer here (no picks, or no engine this platform can download):
  // the full page explains those cases, so send the reader there.
  const dead = (recs && !picks.length) || (status && !engineReady && !status.install.recommended);
  useEffect(() => { if (dead) onShowAll(); }, [dead, onShowAll]);
  if (!status || !recs || dead) return null;

  const chosen = picks.find((t) => t.task === task) ?? picks[0];
  const phase = firstModelPhase(jobs, models, picks);

  const setUp = async () => {
    const p = chosen.pick!;
    setBusy(true);
    try {
      if (!engineReady) {
        const res = await window.nekko.engineInstall(status.install.recommended?.id);
        if (!res.ok) throw new Error(res.message);
      }
      const res = await window.nekko.engineDownloadModel(p.repo, p.downloadLabel);
      if (!res.ok) throw new Error(res.message);
    } catch (e) {
      pushToast('error', (e as Error).message);
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  const cancel = async () => {
    if (phase.kind !== 'working') return;
    const ids = [phase.engine, phase.model].flatMap((g) => g?.jobs.filter((j) => isActive(j.state)).map((j) => j.id) ?? []);
    await Promise.all(ids.map((id) => window.nekko.engineCancelDownload(id).catch(() => undefined)));
    void refresh();
  };

  const startChatting = async (model: LocalModel) => {
    setBusy(true);
    try {
      if (!status.running) {
        const res = await window.nekko.runtimeStart(PROVIDER_ID);
        if ('error' in res) throw new Error(res.error);
      }
      const store = useStore.getState();
      await store.refreshProviders();
      await store.selectProvider(PROVIDER_ID);
      // Without a model, newChat would send a newcomer to cloud setup; it is the only model here anyway.
      const served = useStore.getState().models;
      const listed = served.find((m) => m.id === model.id || base(m.id) === base(model.path)) ?? served[0];
      if (listed) store.selectModel(listed.id);
      await store.newChat();
    } catch (e) {
      pushToast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <FirstModelSteps
      recs={recs}
      picks={picks}
      chosen={chosen}
      engineReady={engineReady}
      phase={phase}
      busy={busy}
      onChoose={setTask}
      onSetUp={() => void setUp()}
      onCancel={() => void cancel()}
      onStart={(m) => void startChatting(m)}
      onShowAll={onShowAll}
    />
  );
}

/** The screen itself, from props only. */
export function FirstModelSteps({
  recs,
  picks,
  chosen,
  engineReady,
  phase,
  busy = false,
  onChoose,
  onSetUp,
  onCancel,
  onStart,
  onShowAll,
}: {
  recs: Recommendations;
  picks: TaskRecommendation[];
  chosen: TaskRecommendation;
  engineReady: boolean;
  phase: FirstModelPhase;
  busy?: boolean;
  onChoose: (task: string) => void;
  onSetUp: () => void;
  onCancel: () => void;
  onStart: (model: LocalModel) => void;
  onShowAll: () => void;
}) {
  const step = phase.kind === 'ready' ? 3 : phase.kind === 'working' ? 2 : 1;
  const downloading = phase.kind === 'working' ? phase.model : undefined;
  const name = downloading ? (downloading.label.split(' · ')[0] ?? downloading.label) : chosen.pick!.name;
  const title =
    phase.kind === 'ready' ? `${phase.model.name} is ready` : phase.kind === 'working' ? `Setting up ${name}` : 'Run AI on this computer';
  const lead =
    phase.kind === 'ready'
      ? 'It runs on this computer, so what you type to it stays here.'
      : phase.kind === 'working'
        ? 'This can take a few minutes. You can keep using Nekko while it downloads.'
        : 'Free and private: your chats never leave this machine, and it works offline. Choose what you will mostly use it for, and Nekko sets up the rest.';

  return (
    <section className="mx-auto max-w-3xl py-4" data-first-local-model={phase.kind}>
      <div className="flex flex-col items-center text-center">
        <p className="text-xs font-medium text-ink-soft">Your first local model · Step {step} of 3</p>
        <h1 className="mt-3 text-2xl font-semibold">{title}</h1>
        <p className="mt-2 max-w-lg text-sm text-ink-soft">{lead}</p>
        <ol className="my-6 flex gap-5 text-xs text-ink-soft" aria-label="Setup progress">
          {['Choose', 'Download', 'Start chatting'].map((label, i) => (
            <li key={label} aria-current={step === i + 1 ? 'step' : undefined} style={{ color: step === i + 1 ? 'var(--accent)' : undefined }}>
              {i + 1}. {label}
            </li>
          ))}
        </ol>
      </div>

      <div key={phase.kind} className="provider-step">
        {phase.kind === 'ready' ? (
          <div className="card p-6 text-center">
            <span className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full" style={{ background: 'color-mix(in srgb, var(--success) 16%, transparent)', color: 'var(--success)' }}>
              <CheckIcon className="h-5 w-5" />
            </span>
            <p className="mb-4 text-sm text-ink-soft">Nekko starts it for you whenever the app opens.</p>
            <button className="btn btn-primary" disabled={busy} onClick={() => onStart(phase.model)}>
              {busy ? 'Opening…' : 'Start chatting'}
            </button>
          </div>
        ) : phase.kind === 'working' ? (
          <div className="card p-6">
            <ul className="space-y-4" aria-label="Setup steps">
              {!engineReady && <Step state={phase.engine ? 'active' : 'done'} label="Get the free engine that runs models" />}
              <Step state={downloading ? 'active' : 'pending'} label={`Download ${name}`}>
                {downloading && <Progress group={downloading} />}
              </Step>
              <Step state="pending" label="Ready to chat" />
            </ul>
            <button className="btn btn-ghost mt-5 text-xs" onClick={onCancel}>Cancel</button>
          </div>
        ) : (
          <>
            {phase.kind === 'failed' && (
              <p role="alert" className="mb-4 flex items-start gap-2 rounded-lg border p-3 text-xs" style={{ borderColor: 'var(--danger)' }}>
                <span className="mt-0.5 shrink-0" style={{ color: 'var(--danger)' }}><WarningIcon className="h-4 w-4" /></span>
                <span>The download stopped: {phase.message} Press the button to try again; it picks up where it left off.</span>
              </p>
            )}
            <div role="radiogroup" aria-label="What will you use it for?" className="grid gap-3 sm:grid-cols-2">
              {picks.map((t) => {
                const use = FIRST_USES.find((u) => u.task === t.task)!;
                const on = t === chosen;
                return (
                  <button
                    key={t.task}
                    role="radio"
                    aria-checked={on}
                    className="card flex flex-col items-start gap-2 p-5 text-left transition-colors"
                    style={on ? { borderColor: 'var(--accent)', boxShadow: '0 0 0 1px var(--accent)' } : undefined}
                    onClick={() => onChoose(t.task)}
                  >
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                      <use.Icon className="h-[18px] w-[18px]" />
                    </span>
                    <span className="text-base font-semibold">{use.title}</span>
                    <span className="text-sm text-ink-soft">{use.blurb}</span>
                    <span className="mt-1 text-xs text-ink-faint">
                      {t.pick!.name} · {formatBytes(t.pick!.downloadBytes)} download
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="mt-4 text-center text-xs text-ink-soft">{fitSentence(chosen, recs)}</p>
            <div className="mt-5 flex flex-col items-center gap-2">
              <button className="btn btn-primary px-6" disabled={busy} onClick={onSetUp}>
                {busy ? 'Starting…' : 'Download and set up'}
              </button>
              <p className="max-w-md text-center text-xs text-ink-faint">
                One download of {formatBytes(chosen.pick!.downloadBytes)}
                {engineReady ? '' : ', plus the small free engine that runs it'}. Nothing downloads until you press the button.
              </p>
            </div>
          </>
        )}
      </div>

      <p className="mt-8 text-center text-xs text-ink-faint">
        Already use Ollama or LM Studio, or want a different model?{' '}
        <button className="text-accent underline-offset-2 hover:underline" onClick={onShowAll}>
          Show all models and settings
        </button>
      </p>
    </section>
  );
}

function Step({ state, label, children }: { state: 'done' | 'active' | 'pending'; label: string; children?: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3" data-step={state}>
      <span
        aria-hidden
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${state === 'active' ? 'animate-spin border-t-transparent' : ''}`}
        style={{
          borderColor: state === 'pending' ? 'var(--line)' : state === 'done' ? 'var(--success)' : 'var(--accent)',
          borderTopColor: state === 'active' ? 'transparent' : undefined,
          background: state === 'done' ? 'var(--success)' : undefined,
          color: 'white',
        }}
      >
        {state === 'done' && <CheckIcon className="h-3 w-3" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className={`text-sm ${state === 'pending' ? 'text-ink-faint' : 'font-medium'}`}>{label}</p>
        {children}
      </div>
    </li>
  );
}

function Progress({ group }: { group: DownloadGroup }) {
  const pct = group.totalBytes ? Math.min(100, (group.receivedBytes / group.totalBytes) * 100) : 0;
  const left = eta(group);
  return (
    <div className="mt-2">
      <div
        className="h-2 overflow-hidden rounded-full"
        style={{ background: 'var(--surface-2)' }}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-label="Download progress"
      >
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: 'var(--accent)' }} />
      </div>
      <p className="mt-1 text-xs text-ink-faint">
        {formatBytes(group.receivedBytes)}
        {group.totalBytes ? ` of ${formatBytes(group.totalBytes)}` : ''}
        {left ? ` · about ${left}` : ''}
      </p>
    </div>
  );
}
