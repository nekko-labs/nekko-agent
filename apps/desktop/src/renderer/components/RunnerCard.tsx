import React, { useEffect, useRef, useState } from 'react';
import {
  NO_IMAGE_ERROR,
  STATE_LABELS,
  acceptBlocked,
  auditText,
  auditTimeline,
  imageBusy,
  imageFraction,
  imageLine,
  missingToolsLine,
  networkText,
  reasonText,
  runnerSubtitle,
  runnerTitle,
  scopeName,
  slotLines,
  stepText,
  formatMinutes,
  todayText,
  waitingText,
  type AuditLine,
  type ImageView,
  type JobAction,
  type QueuedJob,
  type RunnerState,
  type RunnerView,
  type SlotView,
} from '@nekko-agent/shared';
import { Badge, StatusDot, Toggle } from './primitives/index.js';
import type { StatusTone } from '../tokens.js';
import { connectToWorkflow } from './RunnerReady.js';
import { ChevronIcon, GearIcon } from '../icons.js';
import { useStore } from '../store.js';

const TONE: Record<RunnerState, StatusTone> = {
  off: 'neutral', waiting: 'warning', ready: 'success', running: 'running', draining: 'warning', cleaning: 'info', error: 'danger',
};

const two = (n: number) => String(n).padStart(2, '0');
const hhmm = (ts: number) => {
  const d = new Date(ts * 1000);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
};
const hhmmss = (ts: number) => `${hhmm(ts)}:${two(new Date(ts * 1000).getSeconds())}`;

const openExternally = (url: string) => window.nekko.openPath(url).catch(() => {});
function ExternalLink({ url, children }: { url: string; children: React.ReactNode }) {
  return <a href={url} className="shrink-0 text-accent hover:underline" onClick={(e) => { e.preventDefault(); void openExternally(url); }}>{children}</a>;
}

/** A log fetched when it first shows, scrolled to its end, where a failure is. */
function LogBlock({ title, load, kind }: { title: string; load(): Promise<string>; kind: string }) {
  const [log, setLog] = useState<{ text: string } | { error: string } | null>(null);
  useEffect(() => {
    load().then((text) => setLog({ text }), (e) => setLog({ error: e instanceof Error ? e.message : String(e) }));
  }, []);
  return (
    <div>
      <p className="mb-1 text-ink">{title}</p>
      {log === null ? (
        <p className="text-ink-faint">Loading…</p>
      ) : 'error' in log ? (
        <p className="text-ink-faint">Couldn't read it: {log.error}</p>
      ) : (
        <pre
          className="max-h-72 overflow-auto rounded-lg p-2 font-mono text-2xs whitespace-pre-wrap break-all"
          style={{ background: 'var(--paper)' }}
          ref={(el) => { if (el) el.scrollTop = el.scrollHeight; }}
          data-log={kind}
        >
          {log.text || 'The log is empty.'}
        </pre>
      )}
    </div>
  );
}

/** One recent job: a summary line with its job and PR, expanding to the VM's steps, the job's log and the VM's own log. */
function RecentJob({ line: l, runnerId, rerun }: { line: AuditLine; runnerId: string; rerun: boolean }) {
  const [open, setOpen] = useState(false);
  const act = useJobAction(runnerId);
  const steps = auditTimeline(l);
  const ranVm = l.result !== 'notRemoved';
  return (
    <li data-recent-job={l.ts}>
      <div className="flex items-center gap-2">
        <button className="flex min-w-0 flex-1 items-center gap-2 text-left hover:text-ink" aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronIcon className={`h-3 w-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
          <StatusDot tone={l.result === 'finished' ? 'success' : 'warning'} size={6} />
          <code className="font-mono text-2xs text-ink-faint">{hhmm(l.ts)}</code>
          <span className="min-w-0 truncate">{auditText(l, rerun)}</span>
        </button>
        {l.pr && <ExternalLink url={l.pr.url}>PR #{l.pr.number}</ExternalLink>}
        {l.url && <ExternalLink url={l.url}>Job</ExternalLink>}
        {l.jobId != null && l.repo && (
          <button className="shrink-0 text-accent hover:underline disabled:opacity-50" disabled={act.busy} onClick={() => void act.run('rerun', l.repo!, l.jobId!, 'Re-run asked for. It starts once GitHub has the run finished.')}>
            Re-run
          </button>
        )}
      </div>
      {open && (
        <div className="mt-1 mb-2 ml-5 space-y-2">
          {l.repo && <p className="text-ink-faint">{l.repo}</p>}
          {steps.length > 0 && (
            <ol className="space-y-0.5">
              {steps.map((s, i) => (
                <li key={i} className="flex gap-2">
                  <code className="font-mono text-2xs text-ink-faint">{hhmmss(s.ts)}</code>
                  <span>{s.text}</span>
                </li>
              ))}
            </ol>
          )}
          {l.jobId != null ? (
            <LogBlock title="Job log" kind="job" load={() => window.nekko.runnerJobLog(runnerId, l.jobId!)} />
          ) : (
            l.result !== 'failedToStart' && ranVm && <p className="text-ink-faint">No job log here: this runner could not match the VM to a job. Find the workflow run on GitHub to read its log.</p>
          )}
          {l.vm ? (
            <LogBlock title="VM log" kind="vm" load={() => window.nekko.runnerVmLog(runnerId, l.vm!)} />
          ) : (
            ranVm && <p className="text-ink-faint">No VM log was saved for this job. Older image scripts or a log collection failure can cause this. Use Update scripts in runner settings for future VMs; a log lost when the VM was deleted cannot be recovered.</p>
          )}
        </div>
      )}
    </li>
  );
}

/** Sends one `runner:job` action; a refusal shows as a toast with the daemon's sentence. */
function useJobAction(runnerId: string) {
  const [busy, setBusy] = useState(false);
  const pushToast = useStore((s) => s.pushToast);
  const run = async (action: JobAction, repo: string, jobId: number, done?: string): Promise<boolean> => {
    setBusy(true);
    try {
      await window.nekko.runnerJob(runnerId, action, repo, jobId);
      if (done) pushToast('success', done);
      return true;
    } catch (e) {
      pushToast('error', e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

/** A running VM's console, read again every few seconds; it stays at the end unless scrolled up. */
function LiveLog({ runnerId, vm }: { runnerId: string; vm: string }) {
  const [log, setLog] = useState<{ text: string } | { error: string } | null>(null);
  const pre = useRef<HTMLPreElement | null>(null);
  const atEnd = useRef(true);
  useEffect(() => {
    let alive = true;
    const load = () => window.nekko.runnerLiveLog(runnerId, vm).then(
      (text) => { if (alive) setLog({ text }); },
      (e) => { if (alive) setLog({ error: e instanceof Error ? e.message : String(e) }); },
    );
    void load();
    const timer = setInterval(() => void load(), LIVE_LOG_EVERY_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [runnerId, vm]);
  useEffect(() => {
    if (pre.current && atEnd.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [log]);
  return (
    <div>
      <p className="mb-1 text-ink">Live log <span className="text-ink-faint">· updates every few seconds</span></p>
      {log === null ? (
        <p className="text-ink-faint">Loading…</p>
      ) : 'error' in log ? (
        <p className="text-ink-faint">Couldn't read it: {log.error}</p>
      ) : (
        <pre
          ref={pre}
          onScroll={(e) => { const el = e.currentTarget; atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}
          className="max-h-72 overflow-auto rounded-lg p-2 font-mono text-2xs whitespace-pre-wrap break-all"
          style={{ background: 'var(--paper)' }}
          data-log="live"
        >
          {log.text || 'Nothing yet. Step output shows here once the VM image has the latest scripts (Update scripts in runner settings).'}
        </pre>
      )}
    </div>
  );
}
const LIVE_LOG_EVERY_MS = 3000;

/** The job a slot is running: its link, how far it has got, its live log, and Re-run or Cancel. */
function RunningJob({ slot, runnerId, now }: { slot: SlotView; runnerId: string; now: number }) {
  const [showLog, setShowLog] = useState(false);
  const [confirm, setConfirm] = useState<'cancel' | 'restart' | null>(null);
  const act = useJobAction(runnerId);
  const j = slot.job;
  const progress = stepText(j?.steps);
  const name = j ? `${j.workflow} · ${j.job}` : 'A job';
  const finish = async (action: 'cancel' | 'restart') => {
    if (!j) return;
    const ok = await act.run(action, j.repo, j.jobId, action === 'cancel' ? 'Cancelled the run.' : 'Cancelled. The job runs again once GitHub has the run finished.');
    if (ok) setConfirm(null);
  };
  return (
    <li data-running-job={slot.vm ?? ''} className="space-y-1.5">
      <div className="flex items-center gap-2">
        <StatusDot tone="running" pulse size={6} />
        <span className="min-w-0 truncate text-ink">
          Working on {j?.url ? <ExternalLink url={j.url}>{name}</ExternalLink> : name}
        </span>
        <span className="shrink-0 text-ink-faint">{formatMinutes(Math.max(0, now - slot.since))}</span>
        {slot.boosted && <span className="shrink-0 text-ink-faint">· accepted now</span>}
        <span className="flex-1" />
        {j?.pr && <ExternalLink url={j.pr.url}>PR #{j.pr.number}</ExternalLink>}
      </div>
      {progress && (
        <>
          <p>{progress.text}</p>
          <div
            className="h-1.5 overflow-hidden rounded-full"
            style={{ background: 'var(--surface-2)' }}
            role="progressbar"
            aria-label={`${name} progress`}
            aria-valuenow={Math.round(progress.fraction * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="h-full rounded-full" style={{ width: `${progress.fraction * 100}%`, background: 'var(--accent)' }} />
          </div>
        </>
      )}
      {confirm ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-ink">
            {confirm === 'cancel' ? 'Cancel the whole workflow run on GitHub?' : 'Cancel this run and start the job again?'}
          </span>
          <button className="btn btn-outline py-1! text-xs" style={{ color: 'var(--danger)' }} disabled={act.busy} onClick={() => void finish(confirm)}>
            {confirm === 'cancel' ? 'Cancel run' : 'Cancel and re-run'}
          </button>
          <button className="btn btn-outline py-1! text-xs" disabled={act.busy} onClick={() => setConfirm(null)}>Keep running</button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {slot.vm && (
            <button className="btn btn-outline py-1! text-xs" aria-expanded={showLog} onClick={() => setShowLog(!showLog)}>
              {showLog ? 'Hide live log' : 'Live log'}
            </button>
          )}
          {j && <button className="btn btn-outline py-1! text-xs" onClick={() => setConfirm('restart')}>Re-run</button>}
          {j && <button className="btn btn-outline py-1! text-xs" onClick={() => setConfirm('cancel')}>Cancel</button>}
        </div>
      )}
      {showLog && slot.vm && <LiveLog runnerId={runnerId} vm={slot.vm} />}
    </li>
  );
}

/** A job waiting for a runner with this one's labels: Accept now or Decline, or undo either. */
function QueuedRow({ job: q, view, now }: { job: QueuedJob; view: RunnerView; now: number }) {
  const act = useJobAction(view.config.id);
  // Shown at once; the daemon's view catches up on its next tick.
  const [mine, setMine] = useState<JobAction | null>(null);
  useEffect(() => setMine(null), [q.declined, q.accepted]);
  const declined = mine ? mine === 'decline' : q.declined;
  const accepted = mine ? mine === 'accept' : q.accepted;
  const blocked = acceptBlocked(view);
  const send = async (action: JobAction) => {
    if (await act.run(action, q.repo, q.jobId)) setMine(action);
  };
  return (
    <li data-queued-job={q.jobId} className={`flex flex-wrap items-center gap-2 ${declined ? 'opacity-60' : ''}`}>
      <StatusDot tone={accepted ? 'running' : 'neutral'} size={6} />
      <span className="min-w-0 truncate text-ink">
        {q.url ? <ExternalLink url={q.url}>{`${q.workflow} · ${q.job}`}</ExternalLink> : `${q.workflow} · ${q.job}`}
      </span>
      <span className="shrink-0 text-ink-faint">{q.repo} · {waitingText(q.createdAt, now)}</span>
      {q.pr && <ExternalLink url={q.pr.url}>PR #{q.pr.number}</ExternalLink>}
      <span className="flex-1" />
      {declined || accepted ? (
        <>
          <span className="shrink-0">{declined ? 'Declined: this Mac starts no VM for it' : 'Accepted: a VM starts for it now'}</span>
          <button className="shrink-0 text-accent hover:underline disabled:opacity-50" disabled={act.busy} onClick={() => void send('undo')}>Undo</button>
        </>
      ) : (
        <>
          <button className="btn btn-outline py-1! text-xs" disabled={act.busy || blocked !== null} title={blocked ?? 'Start a VM for it now, as if the runner were in Runner first'} onClick={() => void send('accept')}>
            Accept now
          </button>
          <button className="btn btn-outline py-1! text-xs" disabled={act.busy} title="This Mac starts no VM for it; another runner may take it" onClick={() => void send('decline')}>
            Decline
          </button>
        </>
      )}
    </li>
  );
}

function JobGroup({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="mb-1 text-2xs font-semibold tracking-wide text-ink-faint uppercase">{title}{count ? ` · ${count}` : ''}</h4>
      <ul className="space-y-1.5">{children}</ul>
    </section>
  );
}

/** The runner's jobs by status: waiting, running here, and the last few that ended. Empty groups are left out. */
function Jobs({ view, now }: { view: RunnerView; now: number }) {
  const queue = view.queue ?? [];
  const running = view.slots.filter((s) => s.state === 'running' || s.state === 'draining');
  if (!queue.length && !running.length && !view.recent.length) return null;
  return (
    <div className="mt-3 space-y-3 border-t pt-2 text-xs text-ink-soft" style={{ borderColor: 'var(--line)' }} data-runner-jobs>
      {queue.length > 0 && (
        <JobGroup title="Queued" count={queue.length}>
          {queue.map((q) => <QueuedRow key={`${q.repo}-${q.jobId}`} job={q} view={view} now={now} />)}
        </JobGroup>
      )}
      {running.length > 0 && (
        <JobGroup title="In progress" count={running.length}>
          {running.map((s, i) => <RunningJob key={s.vm ?? i} slot={s} runnerId={view.config.id} now={now} />)}
        </JobGroup>
      )}
      {view.recent.length > 0 && (
        <JobGroup title="Completed">
          {view.recent.map((l, i) => (
            <RecentJob key={`${l.ts}-${i}`} line={l} runnerId={view.config.id} rerun={view.config.settings.rerunLostJobs} />
          ))}
        </JobGroup>
      )}
    </div>
  );
}

/** Where the image stands: the same stage and bar as the setup sheet, so the sheet is optional. */
function ImageRow({ image, onSetup }: { image: ImageView; onSetup?(): void }) {
  const fraction = imageFraction(image);
  const busy = imageBusy(image);
  const action = busy ? 'Details' : image.canResume ? 'Resume setup' : 'Set up this Mac';
  return (
    <div className="mt-3 rounded-xl border px-3 py-2" style={{ borderColor: 'var(--line)', background: 'var(--paper)' }}>
      <div className="flex items-center gap-3">
        <p role={image.state === 'failed' ? 'alert' : undefined} className="min-w-0 flex-1 text-xs text-ink-soft">
          {busy ? imageLine(image) : image.canResume ? 'Setup paused. Finished stages are kept.' : 'One click, then it builds your job VM by itself.'}
        </p>
        <button className={`btn py-1! text-xs ${busy ? 'btn-outline' : 'btn-primary'}`} onClick={onSetup}>{action}</button>
      </div>
      {fraction !== null && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--surface-2)' }} role="progressbar" aria-label="Setting up this Mac" aria-valuenow={Math.round(fraction * 100)}>
          <div className="h-full rounded-full" style={{ width: `${fraction * 100}%`, background: 'var(--accent)' }} />
        </div>
      )}
    </div>
  );
}

/** An image in use without tools jobs run before their own setup, with the way to add them. */
function MissingToolsRow({ tools, onAddTools }: { tools: string[]; onAddTools?(): Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const pushToast = useStore((s) => s.pushToast);
  const add = async () => {
    setBusy(true);
    try {
      await onAddTools?.();
    } catch (e) {
      pushToast('error', `Couldn't start installing them: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="mt-3 flex items-center gap-3 rounded-xl border px-3 py-2"
      style={{ borderColor: 'var(--warning)', background: 'color-mix(in srgb, var(--warning) 10%, transparent)' }}
      data-missing-tools={tools.join(' ')}
    >
      <p role="status" className="min-w-0 flex-1 text-xs">{missingToolsLine(tools)}</p>
      {onAddTools && <button className="btn btn-primary py-1! text-xs" disabled={busy} onClick={() => void add()}>{tools.length === 1 ? 'Install it' : 'Install them'}</button>}
    </div>
  );
}

/** One connected runner (mockup 3): state, slots, the Mac's facts and recent jobs. */
/**
 * `beginReply` is called as a request starts and returns where its answer goes,
 * so the section can drop an answer a newer push has already overtaken.
 */
export function RunnerCard({ view: given, now, image = null, onSettings, onSetup, onAddTools, beginReply }: { view: RunnerView; now: number; image?: ImageView | null; onSettings(): void; onSetup?(): void; onAddTools?(): Promise<void>; beginReply(): (v: RunnerView) => void }) {
  const [busy, setBusy] = useState(false);
  const pushToast = useStore((s) => s.pushToast);
  const settingUp = image !== null && (image.state !== 'ready' || image.canResume);
  const missingTools = !settingUp && image?.state === 'ready' ? (image.info?.missingTools ?? []) : [];
  // Setup is the answer to "No VM image yet", so a runner that is on waits for it, and one that is off stays off.
  const view: RunnerView = settingUp && given.error === NO_IMAGE_ERROR ? { ...given, state: given.state === 'error' ? 'waiting' : given.state, error: null } : given;
  const { config, state, host, today } = view;
  const sampled = host.ramMb > 0;
  const power = host.onBattery === null ? 'Unknown' : !host.onBattery ? 'On AC' : host.batteryPct === null ? 'On battery' : `On battery, ${Math.round(host.batteryPct)}%`;
  const network = networkText(host);

  const setEnabled = async (enabled: boolean) => {
    setBusy(true);
    try {
      const reply = beginReply();
      reply(await window.nekko.setRunnerEnabled(config.id, enabled));
    } catch (e) {
      pushToast('error', `Couldn't turn the runner ${enabled ? 'on' : 'off'}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 rounded-xl border px-4 py-3" style={{ borderColor: 'var(--line)', background: 'var(--surface)' }} data-runner-card={config.id}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <StatusDot tone={TONE[state] ?? 'neutral'} pulse={state === 'running'} />
          <div className="min-w-0">
            <p className="text-sm font-semibold">{runnerTitle(view)}</p>
            <p className="text-xs text-ink-faint">{runnerSubtitle(view)}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={TONE[state] ?? 'neutral'}>{STATE_LABELS[state] ?? state}</Badge>
          <Toggle value={config.settings.enabled} disabled={busy} onChange={(v) => void setEnabled(v)} label={`Runner on for ${scopeName(config.scope)}`} />
          <button className="btn btn-outline px-2! py-1!" aria-label={`Runner settings for ${scopeName(config.scope)}`} title="Runner settings" onClick={onSettings}>
            <GearIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Any state: an Off runner on a Mac without VM support still carries why. */}
      {view.error && (
        <p
          role="alert"
          className="mt-3 rounded-xl border px-3 py-2 text-xs"
          style={{ borderColor: 'var(--danger)', background: 'color-mix(in srgb, var(--danger) 10%, transparent)' }}
        >
          {view.error}
        </p>
      )}
      {image && settingUp && <ImageRow image={image} onSetup={onSetup} />}
      {missingTools.length > 0 && <MissingToolsRow tools={missingTools} onAddTools={onAddTools} />}

      {(state === 'waiting' || state === 'draining') && view.reasons.length > 0 && (
        <ul className="mt-3 space-y-0.5 text-xs text-ink-soft">
          {view.reasons.map((r) => <li key={r}>{reasonText(r).sentence}</li>)}
        </ul>
      )}

      <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
        {slotLines(view, now).map((s) => (
          <div key={s.title} className={`rounded-xl border px-3 py-2 ${s.dim ? 'opacity-50' : ''}`} style={{ borderColor: 'var(--line)', background: 'var(--paper)' }}>
            <p className="text-xs text-ink-soft">{s.title}</p>
            <p className={`mt-0.5 text-sm ${s.active ? '' : 'text-ink-faint'}`}>{s.text}</p>
          </div>
        ))}
      </div>

      <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2 text-xs text-ink-soft">
        <div>
          <b className="block text-sm text-ink">
            {sampled ? `${Math.round(config.settings.memoryPerVmMb / 1024)} GB · ${host.cpusPerVm} cores` : view.error ? 'Unavailable' : 'Not known yet'}
          </b>
          per VM
        </div>
        <div><b className="block text-sm text-ink">Power</b>{power}</div>
        <div><b className="block text-sm text-ink">Network</b>{network}</div>
        <div><b className="block text-sm text-ink">Today</b>{todayText(today)}</div>
      </div>

      <Jobs view={view} now={now} />

      {image !== null && !settingUp && (
        <div className="mt-3 flex justify-end">
          <button className="btn btn-outline py-1! text-xs" onClick={() => void connectToWorkflow(view)}>Connect to a workflow</button>
        </div>
      )}
    </div>
  );
}
