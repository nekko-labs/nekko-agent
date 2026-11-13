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
  sizeNotice,
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
  type SlotLine,
} from '@nekko-agent/shared';
import { StatusDot, Toggle } from './primitives/index.js';
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

/** A text action inside a row: faint until the row is hovered or focused, always shown on touch. */
const ROW_ACTION = 'quiet-row-action shrink-0 rounded-md px-2 py-0.5 text-xs text-ink-soft hover:bg-[var(--q-wash)] hover:text-ink disabled:opacity-50';
const LOG_STYLE: React.CSSProperties = { background: 'var(--surface-2)' };

const openExternally = (url: string) => window.nekko.openPath(url).catch(() => {});
function ExternalLink({ url, children }: { url: string; children: React.ReactNode }) {
  return <a href={url} className="shrink-0 text-accent hover:underline" onClick={(e) => { e.preventDefault(); void openExternally(url); }}>{children}</a>;
}

/** A slim meter in the working colour: a job's steps or the image build. */
function Meter({ fraction, label, value }: { fraction: number; label: string; value?: number }) {
  return (
    <div className="h-1 overflow-hidden rounded-full" style={{ background: 'var(--surface-2)' }} role="progressbar" aria-label={label} aria-valuenow={value ?? Math.round(fraction * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full" style={{ width: `${fraction * 100}%`, background: 'var(--success)', transition: 'width var(--dur-slow) var(--ease-out)' }} />
    </div>
  );
}

/** A group's label: sentence case, with its count in the faint tier. */
function GroupLabel({ title, count }: { title: string; count?: number }) {
  return <h4 className="mb-1 text-xs font-medium text-ink-soft">{title}{count ? ` · ${count}` : ''}</h4>;
}

/** A log fetched when it first shows, scrolled to its end, where a failure is. */
function LogBlock({ title, load, kind }: { title: string; load(): Promise<string>; kind: string }) {
  const [log, setLog] = useState<{ text: string } | { error: string } | null>(null);
  useEffect(() => {
    load().then((text) => setLog({ text }), (e) => setLog({ error: e instanceof Error ? e.message : String(e) }));
  }, []);
  return (
    <div>
      <p className="mb-1 text-ink-soft">{title}</p>
      {log === null ? (
        <p className="text-ink-faint">Loading…</p>
      ) : 'error' in log ? (
        <p className="text-ink-faint">Couldn't read it: {log.error}</p>
      ) : (
        <pre
          className="max-h-72 overflow-auto rounded-lg p-2 font-mono text-2xs whitespace-pre-wrap break-all"
          style={LOG_STYLE}
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
    <li data-recent-job={l.ts} data-quiet-row>
      <div className="flex min-w-0 items-center gap-2 py-1">
        <button className="flex min-w-0 flex-1 items-center gap-2 text-left hover:text-ink" aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronIcon className={`h-3 w-3 shrink-0 text-ink-faint transition-transform ${open ? 'rotate-90' : ''}`} />
          <StatusDot tone={l.result === 'finished' ? 'success' : 'warning'} size={6} />
          <span className="min-w-0 truncate">{auditText(l, rerun)}</span>
          <span className="shrink-0 font-mono text-2xs text-ink-faint tabular-nums">{hhmm(l.ts)}</span>
        </button>
        {l.pr && <ExternalLink url={l.pr.url}>PR #{l.pr.number}</ExternalLink>}
        {l.url && <ExternalLink url={l.url}>Job</ExternalLink>}
        {l.jobId != null && l.repo && (
          <button className={ROW_ACTION} disabled={act.busy} onClick={() => void act.run('rerun', l.repo!, l.jobId!, 'Re-run asked for. It starts once GitHub has the run finished.')}>
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
  return log === null ? (
    <p className="text-xs text-ink-faint">Loading…</p>
  ) : 'error' in log ? (
    <p className="text-xs text-ink-faint">Couldn't read it: {log.error}</p>
  ) : (
    <pre
      ref={pre}
      onScroll={(e) => { const el = e.currentTarget; atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}
      className="max-h-72 overflow-auto rounded-lg p-2 font-mono text-2xs whitespace-pre-wrap break-all"
      style={LOG_STYLE}
      title="Updates every few seconds"
      data-log="live"
    >
      {log.text || 'Nothing yet. Step output shows here once the VM image has the latest scripts (Update scripts in runner settings).'}
    </pre>
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
  const finishing = slot.state === 'draining'
    ? (slot.drainEndsAt === null ? 'finishing' : `stops in ${Math.max(1, Math.ceil((slot.drainEndsAt - now) / 60))} min`)
    : null;
  const finish = async (action: 'cancel' | 'restart') => {
    if (!j) return;
    const ok = await act.run(action, j.repo, j.jobId, action === 'cancel' ? 'Cancelled the run.' : 'Cancelled. The job runs again once GitHub has the run finished.');
    if (ok) setConfirm(null);
  };
  const actions = !confirm && (
    <span className="ml-auto flex shrink-0 items-center">
      {slot.vm && <button className={ROW_ACTION} aria-expanded={showLog} onClick={() => setShowLog(!showLog)}>{showLog ? 'Hide live log' : 'Live log'}</button>}
      {j && <button className={ROW_ACTION} onClick={() => setConfirm('restart')}>Re-run</button>}
      {j && <button className={`${ROW_ACTION} text-danger-text! hover:text-danger-text!`} onClick={() => setConfirm('cancel')}>Cancel</button>}
    </span>
  );
  return (
    <li data-running-job={slot.vm ?? ''} data-quiet-row className="space-y-1 py-1">
      {/* No wrapping: actions hidden until hover would otherwise hold an empty line on a narrow panel. */}
      <div className="flex min-w-0 items-center gap-2">
        <StatusDot tone="running" pulse size={6} />
        <span className="min-w-0 truncate text-ink">
          Working on {j?.url ? <ExternalLink url={j.url}>{name}</ExternalLink> : name}
        </span>
        <span className="shrink-0 text-ink-faint tabular-nums">
          {formatMinutes(Math.max(0, now - slot.since))}{slot.boosted ? ' · accepted now' : ''}{finishing ? ` · ${finishing}` : ''}
        </span>
        {j?.pr && <ExternalLink url={j.pr.url}>PR #{j.pr.number}</ExternalLink>}
        {!progress && actions}
      </div>
      {progress && (
        <div className="space-y-1 pl-3.5">
          <div className="flex min-w-0 items-center gap-2">
            <p className="min-w-0 truncate text-ink-soft">{progress.text}</p>
            {actions}
          </div>
          <Meter fraction={progress.fraction} label={`${name} progress`} />
        </div>
      )}
      {confirm && (
        <div className="flex flex-wrap items-center gap-2 pl-3.5">
          <span className="text-ink">
            {confirm === 'cancel' ? 'Cancel the whole workflow run on GitHub?' : 'Cancel this run and start the job again?'}
          </span>
          <button className="btn btn-ghost text-danger-text!" disabled={act.busy} onClick={() => void finish(confirm)}>
            {confirm === 'cancel' ? 'Cancel run' : 'Cancel and re-run'}
          </button>
          <button className="btn btn-ghost" disabled={act.busy} onClick={() => setConfirm(null)}>Keep running</button>
        </div>
      )}
      {showLog && slot.vm && <div className="pl-3.5"><LiveLog runnerId={runnerId} vm={slot.vm} /></div>}
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
    <li data-queued-job={q.jobId} data-quiet-row className={`flex min-w-0 items-center gap-2 py-1 transition-opacity ${declined ? 'opacity-60' : ''}`}>
      <StatusDot tone={accepted ? 'running' : 'neutral'} size={6} />
      <span className="min-w-0 truncate text-ink" title={`${q.workflow} · ${q.job} · ${q.repo}`}>
        {q.url ? <ExternalLink url={q.url}>{`${q.workflow} · ${q.job}`}</ExternalLink> : `${q.workflow} · ${q.job}`}
      </span>
      <span className="shrink-0 text-ink-faint">{waitingText(q.createdAt, now)}</span>
      {q.pr && <ExternalLink url={q.pr.url}>PR #{q.pr.number}</ExternalLink>}
      <span className="flex-1" />
      {declined || accepted ? (
        <>
          <span className="min-w-0 truncate text-ink-soft">{declined ? 'Declined: this Mac starts no VM for it' : 'Accepted: a VM starts for it now'}</span>
          <button className="shrink-0 text-accent hover:underline disabled:opacity-50" disabled={act.busy} onClick={() => void send('undo')}>Undo</button>
        </>
      ) : (
        <span className="flex shrink-0 items-center">
          <button className={ROW_ACTION} disabled={act.busy || blocked !== null} title={blocked ?? 'Start a VM for it now, as if the runner were in Runner first'} onClick={() => void send('accept')}>
            Accept now
          </button>
          <button className={ROW_ACTION} disabled={act.busy} title="This Mac starts no VM for it; another runner may take it" onClick={() => void send('decline')}>
            Decline
          </button>
        </span>
      )}
    </li>
  );
}

/**
 * The runner's jobs by status: waiting, running here, and (on the CI runners
 * page) the last few that ended. Empty groups are left out.
 */
function Jobs({ view, now, compact }: { view: RunnerView; now: number; compact: boolean }) {
  const queue = view.queue ?? [];
  const running = view.slots.filter((s) => s.state === 'running' || s.state === 'draining');
  const recent = compact ? [] : view.recent;
  if (!queue.length && !running.length && !recent.length) return null;
  return (
    <div className="flex flex-col gap-4 text-xs text-ink-soft" data-runner-jobs>
      {queue.length > 0 && (
        <section>
          <GroupLabel title="Queued" count={queue.length} />
          <ul>{queue.map((q) => <QueuedRow key={`${q.repo}-${q.jobId}`} job={q} view={view} now={now} />)}</ul>
        </section>
      )}
      {running.length > 0 && (
        <section>
          <GroupLabel title="In progress" count={running.length} />
          <ul>{running.map((s, i) => <RunningJob key={s.vm ?? i} slot={s} runnerId={view.config.id} now={now} />)}</ul>
        </section>
      )}
      {recent.length > 0 && (
        <section>
          <GroupLabel title="Completed" />
          <ul>
            {recent.map((l, i) => (
              <RecentJob key={`${l.ts}-${i}`} line={l} runnerId={view.config.id} rerun={view.config.settings.rerunLostJobs} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** One slot that is not running a job: what it does, and its VM's name and live log once it has one. */
function SlotRow({ slot: s, runnerId }: { slot: SlotLine; runnerId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <li data-runner-vm={s.vm} data-quiet-row className="py-1">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className={`shrink-0 font-medium ${s.dim ? 'text-ink-faint' : 'text-ink'}`}>{s.title}</span>
        <span className={`min-w-0 shrink truncate ${s.active ? 'text-ink-soft' : 'text-ink-faint'}`}>{s.text}</span>
        {s.vm && <code className="min-w-0 truncate font-mono text-2xs text-ink-faint">{s.vm}</code>}
        {s.vm && <><span className="flex-1" /><button className={ROW_ACTION} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide live log' : 'Live log'}</button></>}
      </div>
      {open && s.vm && <div className="mt-1"><LiveLog runnerId={runnerId} vm={s.vm} /></div>}
    </li>
  );
}

/** Where the image stands: the same stage and bar as the setup sheet, so the sheet is optional. */
function ImageRow({ image, onSetup }: { image: ImageView; onSetup?(): void }) {
  const fraction = imageFraction(image);
  const busy = imageBusy(image);
  const action = busy ? 'Details' : image.canResume ? 'Resume setup' : 'Set up this Mac';
  return (
    <div className="space-y-2" data-runner-image>
      <div className="flex min-w-0 items-center gap-2">
        <p role={image.state === 'failed' ? 'alert' : undefined} className="min-w-0 flex-1 text-xs text-ink-soft" style={image.state === 'failed' ? { color: 'var(--danger-text)' } : undefined}>
          {busy ? imageLine(image) : image.canResume ? 'Setup paused. Finished stages are kept.' : 'One click, then it builds your job VM by itself.'}
        </p>
        <button className={`btn shrink-0 ${busy ? 'btn-ghost' : 'btn-primary'}`} onClick={onSetup}>{action}</button>
      </div>
      {fraction !== null && <Meter fraction={fraction} label="Setting up this Mac" />}
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
    <div className="flex min-w-0 items-center gap-2" data-missing-tools={tools.join(' ')}>
      <StatusDot tone="warning" size={6} />
      <p role="status" className="min-w-0 flex-1 text-xs" style={{ color: 'var(--warning-text)' }}>{missingToolsLine(tools)}</p>
      {onAddTools && <button className="btn btn-primary shrink-0" disabled={busy} onClick={() => void add()}>{tools.length === 1 ? 'Install it' : 'Install them'}</button>}
    </div>
  );
}

/** Where **Not now** remembers the suggestion it hid, per runner. */
const NOT_NOW_KEY = (id: string) => `nekko.runner.sizeNotNow.${id}`;

/**
 * The suggested VM size, on the card once the daemon has two jobs at the current size and
 * the suggestion differs from it (#2700). Apply saves it as the settings row does; Not now
 * hides this suggestion until the daemon suggests something else.
 */
function SizeNoticeRow({ view, beginReply }: { view: RunnerView; beginReply(): (v: RunnerView) => void }) {
  const notice = sizeNotice(view);
  const id = view.config.id;
  const [hidden, setHidden] = useState<string | null>(() => {
    try { return window.localStorage.getItem(NOT_NOW_KEY(id)); } catch { return null; }
  });
  const [busy, setBusy] = useState(false);
  const pushToast = useStore((s) => s.pushToast);
  if (!notice || hidden === notice.key) return null;
  const apply = async () => {
    setBusy(true);
    try {
      const reply = beginReply();
      reply(await window.nekko.updateRunner(id, notice.apply));
      pushToast('success', 'New VM size saved. It applies from the next VM.');
    } catch (e) {
      pushToast('error', `Couldn't apply the suggested size: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };
  const notNow = () => {
    try { window.localStorage.setItem(NOT_NOW_KEY(id), notice.key); } catch { /* best effort */ }
    setHidden(notice.key);
  };
  return (
    <div className="flex min-w-0 items-center gap-2" data-size-notice={notice.key}>
      <StatusDot tone="info" size={6} />
      <p role="status" className="min-w-0 flex-1 text-xs text-ink-soft" title={notice.reasons.join(' ') || undefined}>{notice.line}</p>
      <button className="btn btn-ghost shrink-0" disabled={busy} onClick={notNow}>Not now</button>
      <button className="btn btn-primary shrink-0" disabled={busy} onClick={() => void apply()}>Apply</button>
    </div>
  );
}

/**
 * One connected runner, as quiet rows: a header with state, switch and
 * settings; one line for an error, the image build, missing tools or a suggested VM size; why it
 * waits; the slots not running a job; the jobs; and one line of facts.
 * `compact` is the Automations panel: it leaves out idle slots without a VM,
 * the facts line, completed jobs and Connect to a workflow, which stay on the
 * CI runners page.
 *
 * `beginReply` is called as a request starts and returns where its answer goes,
 * so the section can drop an answer a newer push has already overtaken.
 */
export function RunnerCard({ view: given, now, image = null, compact = false, onSettings, onSetup, onAddTools, beginReply }: { view: RunnerView; now: number; image?: ImageView | null; compact?: boolean; onSettings(): void; onSetup?(): void; onAddTools?(): Promise<void>; beginReply(): (v: RunnerView) => void }) {
  const [busy, setBusy] = useState(false);
  const pushToast = useStore((s) => s.pushToast);
  const settingUp = image !== null && (image.state !== 'ready' || image.canResume);
  const missingTools = !settingUp && image?.state === 'ready' ? (image.info?.missingTools ?? []) : [];
  // Setup is the answer to "No VM image yet", so a runner that is on waits for it, and one that is off stays off.
  const view: RunnerView = settingUp && given.error === NO_IMAGE_ERROR ? { ...given, state: given.state === 'error' ? 'waiting' : given.state, error: null } : given;
  const { config, state, host, today } = view;
  const name = scopeName(config.scope);
  const sampled = host.ramMb > 0;
  const facts = [
    sampled ? `${Math.round(config.settings.memoryPerVmMb / 1024)} GB, ${host.cpusPerVm} cores per VM` : view.error ? 'VM size unavailable' : 'VM size not known yet',
    host.onBattery === null ? 'Power unknown' : !host.onBattery ? 'On AC' : host.batteryPct === null ? 'On battery' : `On battery, ${Math.round(host.batteryPct)}%`,
    host.networkId === null ? 'Network unknown' : networkText(host),
    today.jobs ? `Today ${todayText(today)}` : 'No jobs today',
  ];
  // A running slot is told under In progress; the panel also leaves out slots with nothing to show.
  const slots = slotLines(view, now).filter((s) => !s.busy && (!compact || s.vm));
  const reasons = (state === 'waiting' || state === 'draining') ? view.reasons.slice(0, compact ? 1 : undefined) : [];

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
    <section className={`quiet-group mt-2 flex min-w-0 flex-col ${compact ? 'gap-3' : 'gap-5'}`} data-runner-card={config.id} data-compact={compact || undefined}>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <StatusDot tone={TONE[state] ?? 'neutral'} />
          <h3 className="min-w-0 truncate text-sm font-semibold" title={`${runnerTitle(view)}\n${runnerSubtitle(view)}`}>{name}</h3>
          <span className="shrink-0 text-xs transition-colors" style={{ color: state === 'error' ? 'var(--danger-text)' : 'var(--ink-soft)' }} data-runner-state>{STATE_LABELS[state] ?? state}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <Toggle value={config.settings.enabled} disabled={busy} onChange={(v) => void setEnabled(v)} label={`Runner on for ${name}`} />
            <button className="btn btn-ghost px-1.5!" aria-label={`Runner settings for ${name}`} title="Runner settings" onClick={onSettings}>
              <GearIcon className="h-3.5 w-3.5" />
            </button>
          </span>
        </div>

        {/* Any state: an Off runner on a Mac without VM support still carries why. */}
        {view.error && <p role="alert" className="text-xs" style={{ color: 'var(--danger-text)' }}>{view.error}</p>}
        {image && settingUp && <ImageRow image={image} onSetup={onSetup} />}
        {missingTools.length > 0 && <MissingToolsRow tools={missingTools} onAddTools={onAddTools} />}
        <SizeNoticeRow view={view} beginReply={beginReply} />
        {reasons.length > 0 && (
          <ul className="text-xs text-ink-soft" data-runner-reasons>
            {reasons.map((r) => <li key={r}>{reasonText(r).sentence}</li>)}
          </ul>
        )}
      </div>

      {slots.length > 0 && (
        <section className="text-xs" data-runner-slots>
          <GroupLabel title="Slots" />
          <ul>{slots.map((s) => <SlotRow key={s.vm ?? s.title} slot={s} runnerId={config.id} />)}</ul>
        </section>
      )}

      <Jobs view={view} now={now} compact={compact} />

      {!compact && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-faint" data-runner-facts>
          {facts.map((f) => <span key={f}>{f}</span>)}
          {image !== null && !settingUp && (
            <button className="btn btn-ghost ml-auto" onClick={() => void connectToWorkflow(view)}>Connect to a workflow</button>
          )}
        </div>
      )}
    </section>
  );
}
