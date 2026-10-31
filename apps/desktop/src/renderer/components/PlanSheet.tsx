import React, { useMemo, useState } from 'react';
import type { PlanStep, PlanStepKind, PrInfo, Session } from '@nekko-agent/shared';
import { lastReplyInterrupted, parsePrUrl, planProgress } from '@nekko-agent/shared';
import { getLiveRun, runningSessionIds, useLiveRunsVersion } from '../liveRuns.js';
import { planStepLinks, type PlanStepLinks, type ProjectLink } from '../planStepLinks.js';
import { sheetPlan } from '../claudeAgentPlan.js';
import { useStore } from '../store.js';
import { CheckIcon, RobotIcon, RocketIcon, TagIcon } from '../icons.js';
import type { ChatArtifact } from '../chatArtifacts.js';
import { canonicalPrUrl, progressAge, safeProgressLink } from './WorkProgress.js';

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

const VERIFY = {
  pending: { label: 'Check pending', tone: 'var(--ink-faint)' },
  active: { label: 'Checking', tone: 'var(--accent)' },
  passed: { label: 'Verified', tone: 'var(--success)' },
  failed: { label: 'Check failed', tone: 'var(--danger)' },
  blocked: { label: 'Check blocked', tone: 'var(--warning)' },
  unknown: { label: 'Check unknown', tone: 'var(--ink-faint)' },
};
const open = (url?: string) => { if (url) void window.nekko.openPath(url).catch(() => {}); };

/** Only the agent's explicit report counts; a done step or a tool success is not a pass. */
function VerificationChip({ step }: { step: PlanStep }) {
  const v = step.verification!;
  const { label, tone } = VERIFY[v.status] ?? VERIFY.unknown;
  const evidence = safeProgressLink(v.evidenceUrl);
  return <button type="button" className="plan-sheet-chip" data-plan-chip="verify" disabled={!evidence}
    title={`Agent-reported, not inferred from tool results · ${progressAge(step.updatedAt, Date.now(), ['active', 'pending'].includes(v.status))}${evidence ? ' · Open evidence' : ''}`}
    onClick={() => open(evidence)}>
    <span className="plan-sheet-dot" style={{ background: tone }} />{label}{v.device ? ` on ${v.device}` : ''}
  </button>;
}

/** One slim row: each failing or running check by name, the passing ones folded into a count. */
function CiChips({ info }: { info: PrInfo }) {
  const items = info.checkProgress?.items ?? [];
  const order = { failing: 0, pending: 1, unknown: 2, completed: 3 };
  const loud = items.filter(c => c.state !== 'completed').sort((a, b) => order[a.state] - order[b.state]);
  const passed = items.length - loud.length;
  const base = canonicalPrUrl(info.url);
  return <>
    {loud.map((check, i) => <button key={i} type="button" className="plan-sheet-chip" data-plan-chip="ci" title={`#${info.number} · ${check.name} · ${check.state}`} onClick={() => open(safeProgressLink(check.link))}>
      <span className="plan-sheet-dot" style={{ background: check.state === 'failing' ? 'var(--danger)' : check.state === 'pending' ? 'var(--warning)' : 'var(--ink-faint)' }} />{check.name}
    </button>)}
    {passed > 0 && <button type="button" className="plan-sheet-chip" data-plan-chip="ci" title={`#${info.number} · CI checks`} onClick={() => open(base && base + '/checks')}>
      <span className="plan-sheet-dot" style={{ background: 'var(--success)' }} />{passed} passed
    </button>}
  </>;
}

const KIND_LABEL: Record<PlanStepKind, string> = { explore: 'Explore', build: 'Build', verify: 'Verify', ship: 'Ship' };

/** The step's place in the loop, a small caps word before its title. */
function Kind({ kind, current }: { kind?: PlanStepKind; current?: boolean }) {
  if (!kind) return null;
  return <span className="plan-sheet-kind" data-plan-kind={kind} data-current={current || undefined}>{KIND_LABEL[kind]}</span>;
}

/** "Pass 2": Verify sent the work back to this step. */
function Pass({ step }: { step: PlanStep }) {
  if (!step.pass || step.pass < 2) return null;
  return <span className="plan-sheet-pass" title={`Pass ${step.pass}: a later check sent the work back here`}>
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v4.5h-4.5" /></svg>Pass {step.pass}
  </span>;
}

function ProjectChip({ link }: { link: ProjectLink }) {
  return <button type="button" className="plan-sheet-chip" data-plan-chip="project" title={link.url} onClick={() => open(link.url)}><TagIcon className="h-3 w-3" />{link.label}</button>;
}

type Child = { id: string; title: string; running: boolean };

function SubagentChip({ child, onOpen }: { child: Child; onOpen: (id: string) => void }) {
  return <button type="button" className="plan-sheet-chip" data-plan-chip="subagent" title={`Open ${child.title}`} onClick={() => onOpen(child.id)}>
    <RobotIcon className="h-3 w-3" /><span className="truncate">{child.title}</span>
    {child.running ? <span className="plan-sheet-glyph is-running" role="img" aria-label="Running"><RocketIcon className="h-3 w-3" /></span> : <span className="plan-sheet-glyph" role="img" aria-label="Done"><CheckIcon className="h-3 w-3" /></span>}
  </button>;
}

/** Folded, the sub-agents are one chip: how many run and how many are done. */
function SubagentSummary({ children }: { children: Child[] }) {
  const running = children.filter(c => c.running).length;
  const done = children.length - running;
  return <span className="plan-sheet-chip" data-plan-chip="subagents" title={`Sub-agents: ${running} running, ${done} done`}>
    Sub-agents
    {running > 0 && <><b>{running}</b><span className="plan-sheet-glyph is-running" role="img" aria-label="running"><RocketIcon className="h-3 w-3" /></span></>}
    {done > 0 && <><b>{done}</b><span className="plan-sheet-glyph" role="img" aria-label="done"><CheckIcon className="h-3 w-3" /></span></>}
  </span>;
}

/**
 * The agent's plan as a sheet tucked behind the composer's top edge, with
 * curved shoulders into it and a slightly different tint.
 *
 * Folded (the default) it is one or two lines: the step being worked (its loop
 * kind, title, pass and place in the plan) and a row of chips for it: the
 * sub-agents as one count, then the step's PRs, task links, verification and
 * files. Clicking it opens the whole plan, every step with its own chips
 * underneath: task links, sub-agents (each opens its chat), verification, CI
 * checks, PRs and files. Finished steps squeeze to their title and open while
 * the pointer or keyboard focus is anywhere on the sheet.
 */
export function PlanSheet({ sessionId, session, streaming, prs, basePath, onOpenChild, initiallyOpen = false }: {
  sessionId: string;
  session: Session | null;
  streaming: boolean;
  prs: PrInfo[];
  basePath?: string;
  /** Opens a sub-agent's chat (on the wall, as a window there). */
  onOpenChild?: (id: string) => void;
  /** Start with the whole plan showing rather than folded. */
  initiallyOpen?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(!initiallyOpen);
  const messages = session?.messages;
  const sessions = useStore((s) => s.sessions);
  const providers = useStore((s) => s.providers);
  useLiveRunsVersion();
  const working = streaming || !!getLiveRun(sessionId) || !!session?.activeRun;
  const plan = useMemo(() => sheetPlan(session, providers, working), [session, providers, working]);
  const childSessions = useMemo(() => (sessions ?? []).filter((s) => s.parentSessionId === sessionId), [sessions, sessionId]);
  const links = useMemo(() => planStepLinks(messages ?? [], plan, basePath, childSessions), [messages, plan, basePath, childSessions]);
  if (!plan?.length) return null;
  const running = new Set(runningSessionIds());
  const childById = new Map(childSessions.map((c): [string, Child] => [c.id, { id: c.id, title: c.title || 'Sub-agent', running: running.has(c.id) || !!getLiveRun(c.id) || !!c.activeRun }]));
  const openChild = onOpenChild ?? ((id: string) => useStore.getState().openChatPane(id));
  const progress = planProgress(plan);
  // An active step is not tied to token streaming. Only an explicit
  // interruption pauses it; a resumed live run takes precedence over history.
  const paused = !streaming && !getLiveRun(sessionId) && !session?.activeRun && lastReplyInterrupted(messages ?? []);
  const current = plan.find(step => step.status === 'active') ?? plan.find(step => step.status === 'pending') ?? plan[plan.length - 1];
  const prInfo = new Map(prs.map(pr => [pr.url, pr]));
  // CI belongs under verification: the last step the agent publishes a check
  // for, else the step that opened the PR, else whatever is running now.
  const checker = plan.filter(step => step.verification).pop()?.id;
  const ci = new Map<string, PrInfo[]>();
  for (const pr of prs) {
    if (pr.state !== 'open' || !pr.checkProgress?.items.length) continue;
    const id = checker ?? [...links].find(([, own]) => own.prs.includes(pr.url))?.[0] ?? current?.id;
    if (id) ci.set(id, [...(ci.get(id) ?? []), pr]);
  }
  const prChip = (url: string) => { const { text, tone } = prChipLabel(url, prInfo.get(url)); return <button key={url} type="button" className="plan-sheet-chip" data-plan-chip="pr" title={prInfo.get(url)?.title ?? url} onClick={() => open(url)}><span className="plan-sheet-dot" style={{ background: tone }} />{text}</button>; };
  const artifactChip = (artifact: ChatArtifact) => <button key={artifact.path} type="button" className="plan-sheet-chip" data-plan-chip="link" title={artifact.path} onClick={() => openArtifact(artifact, sessionId)}>{artifact.live ? artifact.live.host + artifact.live.route : artifact.filename}</button>;
  const kids = (own?: PlanStepLinks) => (own?.subagents ?? []).map(id => childById.get(id)).filter((c): c is Child => !!c);
  const position = plan.indexOf(current) + 1;

  if (collapsed) {
    const own = links.get(current.id);
    const allKids = [...childById.values()];
    // The current step's PRs, else the newest PR the chat opened, so a finished plan still shows where it landed.
    const shownPrs = own?.prs.length ? own.prs : [...links.values()].flatMap(l => l.prs).slice(-1);
    const chips = [
      allKids.length > 0 && <SubagentSummary key="subagents" children={allKids} />,
      current.verification && <VerificationChip key="verify" step={current} />,
      ...shownPrs.map(prChip),
      // The step's own task links, else the chat's (the first step's), which say what this work is for.
      ...(own?.projects.length ? own.projects : links.get(plan[0].id)?.projects ?? []).map(link => <ProjectChip key={link.url} link={link} />),
      ...(own?.artifacts ?? []).map(artifactChip),
    ].filter(Boolean);
    return <div className="plan-sheet-dock"><div className="plan-sheet" data-plan-sheet data-folded aria-label="Agent plan">
      <button type="button" className="plan-sheet-fold" onClick={() => setCollapsed(false)} aria-expanded={false} title="Show the whole plan">
        <span className="plan-sheet-line">
          <StepMark status={current.status} paused={paused} />
          <Kind kind={current.kind} current={current.status === 'active'} />
          <span className={`min-w-0 flex-1 truncate ${current.status === 'done' ? 'text-ink-soft' : 'text-ink'}`} title={current.title}>{current.title}</span>
          <Pass step={current} />
          <span className="shrink-0 tabular-nums text-[11px] text-ink-faint">{position} of {plan.length}</span>
          <span aria-hidden className="ctl-caret">▴</span>
        </span>
      </button>
      {chips.length > 0 && <div className="plan-sheet-chips plan-sheet-fold-chips">{chips}</div>}
    </div></div>;
  }

  return <div className="plan-sheet-dock"><div className="plan-sheet" data-plan-sheet aria-label="Agent plan">
    <div className="plan-sheet-head">
      <button type="button" className="plan-sheet-toggle" onClick={() => setCollapsed(true)} aria-expanded title="Fold the plan">
        <span className="font-semibold text-ink-soft">Plan</span>
        <span className="tabular-nums">{progress.done + progress.skipped} of {progress.total} done</span>
        <span className="flex-1" />
        <span aria-hidden className="ctl-caret">▾</span>
      </button>
    </div>
    <ol className="plan-sheet-steps">
      {plan.map(step => {
        const own = links.get(step.id);
        const checks = ci.get(step.id) ?? [];
        const stepKids = kids(own);
        const chips = !!(own?.prs.length || own?.artifacts.length || own?.projects.length || stepKids.length || step.verification || checks.length);
        const detail = step.verification?.detail || step.note;
        const squeezed = step.status === 'done' || step.status === 'skipped';
        return <li key={step.id} className="plan-sheet-step" data-plan-step={squeezed ? 'done' : step.status} data-plan-step-id={step.id} tabIndex={squeezed && (detail || chips) ? 0 : undefined}>
          <StepMark status={step.status} paused={paused} />
          <div className="min-w-0">
            <p className="plan-sheet-line">
              <Kind kind={step.kind} current={step.status === 'active'} />
              <span className={`min-w-0 flex-1 truncate ${squeezed ? 'text-ink-soft' : 'text-ink'}${step.status === 'skipped' ? ' line-through' : ''}`} title={step.title}>{step.title}</span>
              <Pass step={step} />
            </p>
            {(detail || chips) && <div className="plan-sheet-more" data-plan-more><div>
              {detail && <p className="truncate text-[11.5px] text-ink-faint" title={detail}>{detail}</p>}
              {chips && <div className="plan-sheet-chips">
                {own?.projects.map(link => <ProjectChip key={link.url} link={link} />)}
                {stepKids.map(child => <SubagentChip key={child.id} child={child} onOpen={openChild} />)}
                {step.verification && <VerificationChip step={step} />}
                {own?.prs.map(prChip)}
                {checks.map(pr => <CiChips key={pr.url} info={pr} />)}
                {own?.artifacts.map(artifactChip)}
              </div>}
            </div></div>}
          </div>
        </li>;
      })}
    </ol>
  </div></div>;
}
