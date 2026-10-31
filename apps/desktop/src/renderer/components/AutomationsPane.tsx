import React from 'react';
import type { AutomationTask } from '@nekko-agent/shared';
import { runPolicyNote, taskCadence } from '@nekko-agent/shared';
import { PanelList } from './primitives/index.js';
import { TrashIcon } from '../icons.js';
import { PaneMetadata } from './PaneFrame.js';
import { AutomationsEmptyArt, EmptyArea } from './EmptyIllustrations.js';
import { useStore } from '../store.js';
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

const TASK_KIND_META: Record<AutomationTask['kind'], { icon: string; label: string }> = {
  scheduled: { icon: '⏰', label: 'Scheduled' },
  recurring: { icon: '🔁', label: 'Recurring' },
  background: { icon: '♾️', label: 'Background' },
};

/** Status resolution for an automation row: running now > waiting for idle > next up > paused > done/error. */
function taskState(t: AutomationTask, running: Set<string>, now: number): { label: string; color: string; live: boolean } {
  if (t.lastSessionId && running.has(t.lastSessionId)) return { label: 'running now', color: 'var(--success)', live: true };
  if (t.status === 'active') {
    // Due, but held by its run policy until the computer is free (run_policy.rs).
    if (t.waitingSince) return { label: 'waiting for you to be away', color: 'var(--info)', live: false };
    if (t.nextRunAt) return { label: inTime(t.nextRunAt - now), color: 'var(--warning)', live: false };
    return { label: 'active', color: 'var(--success)', live: false };
  }
  if (t.status === 'paused') return { label: 'paused', color: 'var(--neutral)', live: false };
  if (t.status === 'error') return { label: 'error', color: 'var(--danger)', live: false };
  return { label: 'done', color: 'var(--info)', live: false };
}

/**
 * The automations window on the Agent board wall: what fired, what's
 * planned next, what's parked. The window's strip names it, so the body
 * starts straight at the count and the rows.
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
      <PaneMetadata>
        <span className="chip shrink-0 text-2xs">{tasks.length === 0 ? 'nothing scheduled' : `${active} active of ${tasks.length}`}</span>
      </PaneMetadata>
      {paused && (
        <div
          className="mb-2 flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs"
          style={{ borderColor: 'var(--warning)', background: 'color-mix(in srgb, var(--warning) 10%, transparent)' }}
          role="status"
        >
          <span className="min-w-0 flex-1">All automations are paused: nothing fires on its own. Run now still works.</span>
          <button className="btn btn-ghost px-2 py-0.5 text-xs" onClick={() => void setAutomationsPaused(false).catch(() => {})}>Resume</button>
        </div>
      )}
      {sorted.length === 0 ? (
        <EmptyArea className="my-auto" art={<AutomationsEmptyArt />} title="Nothing scheduled">
          Open a chat and use its <span className="font-medium text-ink-soft">⚡ Automate</span> menu to run a prompt at a time, repeat it on a schedule, or keep an agent working in the background. They line up here.
        </EmptyArea>
      ) : (
        <PanelList>
          {sorted.map((t) => {
            const meta = TASK_KIND_META[t.kind];
            const st = taskState(t, running, now);
            const ran = runPolicyNote(t.lastRunLowPriority, t.lastRunWaitedMs);
            return (
              <div key={t.id} className="group px-4 py-2.5" data-task-row={t.id}>
                <div className="flex items-center gap-2.5">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-sm" style={{ background: 'var(--surface-2)' }} title={meta.label}>{meta.icon}</span>
                  <button
                    className="min-w-0 truncate text-left text-sm font-medium enabled:hover:text-accent"
                    onClick={() => t.lastSessionId && onOpen(t.lastSessionId)}
                    disabled={!t.lastSessionId}
                    title={t.lastSessionId ? 'Open this automation’s chat' : t.title}
                  >
                    {t.title}
                  </button>
                  <span className="shrink-0 text-2xs text-ink-faint">{taskCadence(t)}</span>
                  <span
                    className="ml-auto flex shrink-0 items-center gap-1.5 tabular-nums text-xs font-medium"
                    style={{ color: st.color }}
                    data-task-state
                    title={t.waitingSince ? `Due ${relTime(now - t.waitingSince)}. It runs once nobody is using this computer, or after 2 hours. Run now starts it at once.` : undefined}
                  >
                    {st.live && <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: st.color }} />}
                    {st.label}
                  </span>
                  <span className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                    {t.status !== 'done' && (
                      <button className="btn btn-ghost px-2 py-0.5 text-xs" onClick={() => window.nekko.runTaskNow(t.id)}>Run now</button>
                    )}
                    {t.status === 'active' ? (
                      <button className="btn btn-ghost px-2 py-0.5 text-xs" onClick={() => window.nekko.updateTask(t.id, { status: 'paused' })}>Pause</button>
                    ) : t.status === 'paused' ? (
                      <button className="btn btn-ghost px-2 py-0.5 text-xs" onClick={() => window.nekko.updateTask(t.id, { status: 'active' })}>Resume</button>
                    ) : null}
                    <button className="rounded-sm p-1 text-ink-faint hover:text-red-400" title="Delete automation" onClick={() => window.nekko.deleteTask(t.id)}><TrashIcon className="h-3.5 w-3.5" /></button>
                  </span>
                </div>
                <div className="mt-0.5 flex items-baseline gap-2 pl-[34px] text-xs text-ink-faint">
                  {t.runCount > 0 && <span className="shrink-0 tabular-nums">{t.runCount} run{t.runCount === 1 ? '' : 's'}{t.lastRunAt ? ` · last ${relTime(now - t.lastRunAt)}` : ''}{ran ? ` · ${ran}` : ''}</span>}
                  {t.lastResult && <span className="min-w-0 truncate text-ink-soft" title={t.lastResult}>{t.lastResult}</span>}
                </div>
              </div>
            );
          })}
        </PanelList>
      )}
    </section>
  );
}
