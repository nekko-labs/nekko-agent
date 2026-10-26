import React, { useMemo, useState } from 'react';
import type { PlanStep, PrInfo, Session } from '@nekko-agent/shared';
import { lastReplyInterrupted, parsePrUrl, planProgress } from '@nekko-agent/shared';
import { getLiveRun } from '../liveRuns.js';
import { planStepLinks } from '../planStepLinks.js';
import { useStore } from '../store.js';
import { CheckIcon, PencilIcon } from '../icons.js';
import type { ChatArtifact } from '../chatArtifacts.js';

function StepMark({ status, paused }: { status: PlanStep['status']; paused: boolean }) {
  const label = status === 'active' ? (paused ? 'Paused' : 'Working') : status === 'done' ? 'Done' : status === 'skipped' ? 'Skipped' : 'Pending';
  return <span className="mt-[3px] grid h-3 w-3 shrink-0 place-items-center" role="img" aria-label={label} title={label}>
    {status === 'done' ? <CheckIcon className="h-3 w-3 text-success" /> :
      <svg aria-hidden="true" className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ color: status === 'active' ? 'var(--accent)' : 'var(--ink-faint)' }}>
        {status === 'active' ? (paused ? <path d="M8 5v14M16 5v14" /> : <path d="M12 3v3m6.36-.36-2.12 2.12M21 12h-3m.36 6.36-2.12-2.12M12 21v-3m-6.36.36 2.12-2.12M3 12h3m-.36-6.36 2.12 2.12" />) : <>
          <circle cx="12" cy="12" r="8" />
          {status === 'skipped' && <path d="M6 18 18 6" />}
        </>}
      </svg>}
  </span>;
}

/** One PR as a chip: number, state, and CI from the PR poller's cached rollup. */
export function prChipLabel(url: string, info?: PrInfo): { text: string; tone: string } {
  const number = info?.number ?? parsePrUrl(url)?.number;
  if (!info) return { text: `#${number}`, tone: 'var(--ink-faint)' };
  if (info.state === 'merged') return { text: `#${number} · Merged`, tone: 'var(--accent)' };
  if (info.state === 'closed') return { text: `#${number} · Closed`, tone: 'var(--ink-faint)' };
  const p = info.checkProgress;
  const ci = info.checks === 'failing' ? 'CI failing' : info.checks === 'passing' ? 'CI passing' : info.checks === 'pending' ? (p?.total ? `CI ${p.completed} of ${p.total}` : 'CI running') : 'No CI';
  const tone = info.checks === 'failing' ? 'var(--danger)' : info.checks === 'passing' ? 'var(--success)' : info.checks === 'pending' ? 'var(--warning)' : 'var(--ink-faint)';
  return { text: `#${number} · ${info.isDraft ? 'Draft' : 'Open'} · ${ci}`, tone };
}

function openArtifact(artifact: ChatArtifact, sessionId: string) {
  if (artifact.live) void window.nekko.openPath(artifact.live.url).catch(() => {});
  else useStore.getState().openFilePane(artifact.path, sessionId);
}

/**
 * The agent's plan as a sheet rising from the composer's top edge. Each step is
 * a title, one line of detail, and (only when it has any) a row of chips for
 * the PRs and files that step produced. Finished steps squeeze to their title
 * and open while the pointer or keyboard focus is anywhere on the sheet.
 */
export function PlanSheet({ sessionId, session, streaming, prs, basePath, onChangePlan }: {
  sessionId: string;
  session: Session | null;
  streaming: boolean;
  prs: PrInfo[];
  basePath?: string;
  /** Pops up the plan-change prompt; nothing is sent until the user types and sends. */
  onChangePlan?: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const plan = session?.agentPlan;
  const messages = session?.messages;
  const links = useMemo(() => planStepLinks(messages ?? [], plan, basePath), [messages, plan, basePath]);
  if (!plan?.length) return null;
  const progress = planProgress(plan);
  // An active step is not tied to token streaming. Only an explicit
  // interruption pauses it; a resumed live run takes precedence over history.
  const paused = !streaming && !getLiveRun(sessionId) && !session?.activeRun && lastReplyInterrupted(messages ?? []);
  const current = plan.find(step => step.status === 'active') ?? plan.find(step => step.status === 'pending');
  const prInfo = new Map(prs.map(pr => [pr.url, pr]));

  return <div className="plan-sheet-dock"><div className="plan-sheet" data-plan-sheet aria-label="Agent plan">
    <div className="plan-sheet-head">
      <button type="button" className="plan-sheet-toggle" onClick={() => setCollapsed(c => !c)} aria-expanded={!collapsed} title={collapsed ? 'Show the plan' : 'Hide the plan'}>
        <span className="font-semibold text-ink-soft">Plan</span>
        <span className="tabular-nums">{progress.done + progress.skipped} of {progress.total}</span>
        {collapsed && current && <span className="min-w-0 truncate text-ink-soft">· {current.title}</span>}
        <span aria-hidden className="ctl-caret">{collapsed ? '▴' : '▾'}</span>
      </button>
      <button type="button" className="plan-sheet-action disabled:cursor-not-allowed disabled:opacity-50" disabled={!onChangePlan} onClick={onChangePlan} title="Tell the agent what to change about its plan"><PencilIcon className="h-3 w-3" />Change plan</button>
    </div>
    {!collapsed && <ol className="plan-sheet-steps">
      {plan.map(step => {
        const own = links.get(step.id);
        const chips = !!(own?.prs.length || own?.artifacts.length);
        const squeezed = step.status === 'done' || step.status === 'skipped';
        return <li key={step.id} className="plan-sheet-step" data-plan-step={squeezed ? 'done' : step.status} data-plan-step-id={step.id} tabIndex={squeezed && (step.note || chips) ? 0 : undefined}>
          <StepMark status={step.status} paused={paused} />
          <div className="min-w-0">
            <p className={`truncate ${squeezed ? 'text-ink-soft' : 'text-ink'}${step.status === 'skipped' ? ' line-through' : ''}`} title={step.title}>{step.title}</p>
            {(step.note || chips) && <div className="plan-sheet-more" data-plan-more><div>
              {step.note && <p className="truncate text-[11.5px] text-ink-faint" title={step.note}>{step.note}</p>}
              {chips && <div className="plan-sheet-chips">
                {own!.prs.map(url => { const { text, tone } = prChipLabel(url, prInfo.get(url)); return <button key={url} type="button" className="plan-sheet-chip" data-plan-chip="pr" title={prInfo.get(url)?.title ?? url} onClick={() => void window.nekko.openPath(url).catch(() => {})}><span className="plan-sheet-dot" style={{ background: tone }} />{text}</button>; })}
                {own!.artifacts.map(artifact => <button key={artifact.path} type="button" className="plan-sheet-chip" data-plan-chip="link" title={artifact.path} onClick={() => openArtifact(artifact, sessionId)}>{artifact.live ? artifact.live.host + artifact.live.route : artifact.filename}</button>)}
              </div>}
            </div></div>}
          </div>
        </li>;
      })}
    </ol>}
  </div></div>;
}
