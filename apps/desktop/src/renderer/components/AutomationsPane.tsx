import React from 'react';
import type { AutomationTask } from '@nekko-agent/shared';
import { runPolicyNote, taskCadence } from '@nekko-agent/shared';
import { StatusDot } from './primitives/index.js';
import { TrashIcon } from '../icons.js';
import { PaneMetadata } from './PaneFrame.js';
import { StatusIcon } from './WorkspaceCard.js';
import { useStore } from '../store.js';
import { CiRunnersView } from '../views/CiRunnersView.js';
import { setAutomationsPaused } from '../automationsPause.js';

function relTime(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? '' : 's'} ago`;
  const y = Math.round(mo / 12);
  return `${y} yr${y === 1 ? '' : 's'} ago`;
}

/** "in 45s" / "in 12 mins" / "in 3 hrs" / "in 2 days", for automation countdowns. */
function inTime(ms: number): string {
  if (ms <= 0) return 'due now';
  const s = Math.round(ms / 1000);
  if (s < 60) return `in ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m} min${m === 1 ? '' : 's'}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h} hr${h === 1 ? '' : 's'}${m % 60 ? ` ${m % 60} min` : ''}`;
  const d = Math.round(h / 24);
  if (d < 30) return `in ${d} day${d === 1 ? '' : 's'}`;
  const mo = Math.round(d / 30);
  return `in ${mo} month${mo === 1 ? '' : 's'}`;
}

/* ---------- Automations ---------- */

const KIND_LABEL: Record<AutomationTask['kind'], string> = { scheduled: 'Once', recurring: 'Recurring', background: 'Background' };

type TaskState = { word: string; mark: React.ReactNode; tone: 'soft' | 'faint' | 'danger' };

/**
 * An automation row's state: running now > waiting for idle > next up >
 * paused > done/error. A running one is an agent at work, so it gets our
 * rocket; everything else is a dot and a word (docs/design-system.md).
 */
function taskState(t: AutomationTask, running: Set<string>, now: number): TaskState {
  if (t.lastSessionId && running.has(t.lastSessionId)) return { word: 'running now', mark: <StatusIcon status="working" />, tone: 'soft' };
  if (t.status === 'active') {
    // Due, but held by its run policy until the computer is free (run_policy.rs).
    if (t.waitingSince) return { word: 'waiting for you to be away', mark: <StatusDot tone="info" />, tone: 'soft' };
    return { word: t.nextRunAt ? inTime(t.nextRunAt - now) : 'active', mark: <StatusDot tone="success" />, tone: 'faint' };
  }
  if (t.status === 'paused') return { word: 'paused', mark: <StatusDot tone="neutral" />, tone: 'faint' };
  if (t.status === 'error') return { word: 'error', mark: <StatusDot tone="danger" />, tone: 'danger' };
  return { word: 'done', mark: <StatusIcon status="done" />, tone: 'faint' };
}

const TONE_CLASS: Record<TaskState['tone'], string> = { soft: 'text-ink-soft', faint: 'text-ink-faint', danger: 'text-danger-text' };

/**
 * "All automations are paused" as one quiet line: a warning dot, the words,
 * and Resume. What it means waits in the tooltip. Shared by the Automations
 * panel and the Automations page.
 */
export function AutomationsPausedLine({ onResume, className = '' }: { onResume: () => void; className?: string }) {
  return (
    <div className={`flex min-w-0 items-center gap-2 text-xs ${className}`} role="status" data-automations-paused
      title="Schedules, events and polls start nothing until you resume. Run now still works.">
      <StatusDot tone="warning" />
      <span className="min-w-0 flex-1 truncate text-warning-text">All automations are paused</span>
      <button type="button" className="btn btn-ghost" onClick={onResume}>Resume</button>
    </div>
  );
}

/**
 * The automations window on the Agent board wall: what fired, what's
 * planned next, what's parked. The window's strip names it and carries the
 * count, so the body starts straight at the rows.
 */
export function AutomationsPane({ tasks, running, now, onOpen }: { tasks: AutomationTask[]; running: Set<string>; now: number; onOpen: (id: string) => void }) {
  const rank = (t: AutomationTask) => {
    if (t.lastSessionId && running.has(t.lastSessionId)) return 0;
    if (t.status === 'active') return 1;
    if (t.status === 'paused') return 2;
    if (t.status === 'error') return 3;
    return 4;
  };
  const sorted = [...tasks].sort((a, b) => rank(a) - rank(b) || (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity) || b.createdAt - a.createdAt);
  const active = tasks.filter((t) => t.status === 'active').length;
  const paused = useStore((s) => s.settings?.automationsPaused === true);

  return (
    <section className="flex h-full min-h-0 flex-col overflow-y-auto p-3">
      {tasks.length > 0 && (
        <PaneMetadata>
          <span className="shrink-0 text-2xs tabular-nums text-ink-faint">{active} active of {tasks.length}</span>
        </PaneMetadata>
      )}
      {paused && <AutomationsPausedLine className="mb-2 px-3" onResume={() => void setAutomationsPaused(false).catch(() => {})} />}
      <CiRunnersView panel />
      <h2 className="py-1 text-sm font-semibold">Scheduled tasks</h2>
      {sorted.length === 0 ? (
        <p className="py-2 text-xs text-ink-faint" data-automations-empty>
          Nothing scheduled. Pick <span className="text-ink-soft">Automate</span> in a chat&rsquo;s + menu to add one.
        </p>
      ) : (
        <div className="flex flex-col" role="list">
          {sorted.map((t) => {
            const st = taskState(t, running, now);
            const cadence = taskCadence(t);
            const ran = runPolicyNote(t.lastRunLowPriority, t.lastRunWaitedMs);
            const history = t.runCount > 0
              ? `${t.runCount} run${t.runCount === 1 ? '' : 's'}${t.lastRunAt ? ` · last ${relTime(now - t.lastRunAt)}` : ''}${ran ? ` · ${ran}` : ''}`
              : null;
            const detail = [cadence, history, t.lastResult].filter(Boolean).join(' · ');
            return (
              <div key={t.id} role="listitem" className="quiet-row flex-col items-stretch gap-1!" data-quiet-row data-task-row={t.id}>
                {/* Wraps on a narrow pane: the state drops to a second line instead of squeezing the title to nothing. */}
                <div className="flex min-h-7 min-w-0 flex-wrap items-center gap-x-2">
                  <span className="grid w-3 shrink-0 place-items-center">{st.mark}</span>
                  <button
                    type="button"
                    className="min-w-0 max-w-full truncate text-left text-sm font-medium enabled:hover:text-accent"
                    dir="auto"
                    onClick={() => t.lastSessionId && onOpen(t.lastSessionId)}
                    disabled={!t.lastSessionId}
                    title={t.lastSessionId ? `${t.title}. Open this automation’s chat` : t.title}
                  >
                    {t.title}
                  </button>
                  <span
                    className={`ml-auto shrink-0 text-xs tabular-nums ${TONE_CLASS[st.tone]}`}
                    data-task-state
                    title={t.waitingSince ? `Due ${relTime(now - t.waitingSince)}. It runs once nobody is using this computer, or after 2 hours. Run now starts it at once.` : undefined}
                  >
                    {st.word}
                  </span>
                  {/* With a pointer these take the state word's place on hover or focus (styles.css), so the word sits flush right at rest. */}
                  <span className="ml-auto flex shrink-0 items-center gap-1" data-task-actions>
                    {t.status !== 'done' && (
                      <button type="button" className="btn btn-ghost" onClick={() => window.nekko.runTaskNow(t.id)}>Run now</button>
                    )}
                    {t.status === 'active' ? (
                      <button type="button" className="btn btn-ghost" onClick={() => window.nekko.updateTask(t.id, { status: 'paused' })}>Pause</button>
                    ) : t.status === 'paused' ? (
                      <button type="button" className="btn btn-ghost" onClick={() => window.nekko.updateTask(t.id, { status: 'active' })}>Resume</button>
                    ) : null}
                    <button type="button" className="rounded-sm p-1 text-ink-faint hover:text-danger-text" title="Delete automation" aria-label={`Delete ${t.title}`} onClick={() => window.nekko.deleteTask(t.id)}>
                      <TrashIcon className="h-3.5 w-3.5" />
                    </button>
                  </span>
                </div>
                <p className="truncate pl-5 text-xs text-ink-faint" title={`${KIND_LABEL[t.kind]} · ${detail}`}>{detail}</p>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
