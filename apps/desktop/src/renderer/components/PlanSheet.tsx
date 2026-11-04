import React, { useMemo, useState } from 'react';
import type { ChatMessage, PlanStep, PlanStepKind, PrInfo, Session } from '@nekko-agent/shared';
import { lastReplyInterrupted, parsePrUrl, planProgress } from '@nekko-agent/shared';
import { getLiveRun, runningSessionIds, useLiveRunsVersion } from '../liveRuns.js';
import { planStepLinks, type PlanStepLinks, type ProjectLink } from '../planStepLinks.js';
import { sheetPlan } from '../claudeAgentPlan.js';
import { VERIFY_GROUP_ID, groupVerification } from '../planVerifyGroup.js';
import { useShown } from '../simpleMode.js';
import { useStore } from '../store.js';
import { CheckIcon, RobotIcon, RocketIcon, TagIcon } from '../icons.js';
import type { ChatArtifact } from '../chatArtifacts.js';
import { canonicalPrUrl, progressAge, safeProgressLink } from './WorkProgress.js';
import { runPrAction } from './PrCard.js';

function StepMark({ status, paused }: { status: PlanStep['status']; paused: boolean }) {
  const label = status === 'active' ? (paused ? 'Paused' : 'Working') : status === 'done' ? 'Done' : status === 'skipped' ? 'Skipped' : 'Pending';
  return <span className="mt-1 grid h-3 w-3 shrink-0 place-items-center" role="img" aria-label={label} title={label}>
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
export function prChipLabel(url: string, info?: PrInfo): { text: string; tone: string; status: PrStatus } {
  const number = info?.number ?? parsePrUrl(url)?.number;
  if (!info) return { text: `#${number}`, tone: 'var(--ink-faint)', status: 'unknown' };
  if (info.state === 'merged') return { text: `#${number} · Merged`, tone: 'var(--accent)', status: 'merged' };
  if (info.state === 'closed') return { text: `#${number} · Closed`, tone: 'var(--ink-faint)', status: 'closed' };
  const p = info.checkProgress;
  const ci = info.checks === 'failing' ? 'CI failing' : info.checks === 'passing' ? 'CI passing' : info.checks === 'pending' ? (p?.total ? `CI ${p.completed} of ${p.total}` : 'CI running') : 'No CI';
  const tone = info.checks === 'failing' ? 'var(--danger)' : info.checks === 'passing' ? 'var(--success)' : info.checks === 'pending' ? 'var(--warning)' : 'var(--ink-faint)';
  const status: PrStatus = info.checks === 'failing' ? 'failing' : info.checks === 'passing' ? 'passing' : info.checks === 'pending' ? 'pending' : info.isDraft ? 'draft' : 'open';
  return { text: `#${number} · ${info.isDraft ? 'Draft' : 'Open'} · ${ci}`, tone, status };
}

type PrStatus = 'draft' | 'open' | 'pending' | 'passing' | 'failing' | 'merged' | 'closed' | 'unknown';

/** The dot the chip wears, matching the PR status badges elsewhere in the app. */
function PrStatusDot({ status, tone }: { status: PrStatus; tone: string }) {
  if (status === 'passing') return <span className="plan-sheet-status" data-pr-status="passing" style={{ color: tone }} aria-hidden><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="6.4" opacity="0.3" /><path d="m5 8.2 2.2 2.2L11 6.6" /></svg></span>;
  if (status === 'failing') return <span className="plan-sheet-status" data-pr-status="failing" style={{ color: tone }} aria-hidden><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="6.4" opacity="0.3" /><path d="M5.5 5.5 10.5 10.5M10.5 5.5 5.5 10.5" /></svg></span>;
  if (status === 'pending') return <span className="plan-sheet-status is-pending" data-pr-status="pending" style={{ color: tone }} aria-hidden><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><circle cx="8" cy="8" r="6.4" opacity="0.3" /><path d="M8 3.6a4.4 4.4 0 0 1 4.4 4.4" /></svg></span>;
  if (status === 'merged') return <span className="plan-sheet-status" data-pr-status="merged" style={{ color: tone }} aria-hidden><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="5" cy="4" r="1.6" /><circle cx="5" cy="12" r="1.6" /><circle cx="11.5" cy="12" r="1.6" /><path d="M5 5.6v4.8M6.6 12h3.3" /><path d="M5 8.4c0 2 2 3.6 4.6 3.6" /></svg></span>;
  return <span className="plan-sheet-dot" style={{ background: tone }} />;
}

/** The approve, decline and merge round pills that fade in when the pointer is on a PR chip. */
function PrHoverActions({ url, info, sessionId }: { url: string; info?: PrInfo; sessionId: string }) {
  const [busy, setBusy] = useState<'approve' | 'close' | 'merge' | null>(null);
  if (!info || info.state !== 'open') return null;
  const act = async (action: 'approve' | 'close' | 'merge', e: React.MouseEvent) => {
    e.stopPropagation(); e.preventDefault();
    if (action === 'merge' && info.stack) { window.nekko.openPath(url).catch(() => {}); return; }
    setBusy(action);
    try { await runPrAction(sessionId, url, action); } finally { setBusy(null); }
  };
  const disabled = (action: 'approve' | 'close' | 'merge') => !!busy || (action === 'merge' && info.checks === 'failing');
  return <span className="plan-sheet-pr-actions" role="group" aria-label={`Actions for #${info.number}`}>
    <button type="button" className="plan-sheet-pr-action" data-pr-act="approve" disabled={disabled('approve')} title="Approve" onClick={(e) => void act('approve', e)}>{busy === 'approve' ? '…' : 'Approve'}</button>
    <button type="button" className="plan-sheet-pr-action" data-pr-act="close" disabled={disabled('close')} title="Decline" onClick={(e) => void act('close', e)}>{busy === 'close' ? '…' : 'Decline'}</button>
    <button type="button" className="plan-sheet-pr-action" data-pr-act="merge" disabled={disabled('merge')} title={info.checks === 'failing' ? 'Merge blocked while CI is failing' : info.stack ? 'Review stack on GitHub' : 'Merge'} onClick={(e) => void act('merge', e)}>{busy === 'merge' ? '…' : info.stack ? 'Merge on GH' : 'Merge'}</button>
  </span>;
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
/**
 * A pill-shaped caret the whole plan toggles on, so the fold affordance reads
 * as a button rather than a stray glyph. "down" points to the detail about to
 * open; "up" asks it to fold back.
 */
function PlanCaret({ direction, label }: { direction: 'up' | 'down'; label: string }) {
  return <span className="plan-sheet-caret" data-dir={direction} aria-hidden title={label}>
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      {direction === 'down' ? <path d="m4 6 4 4 4-4" /> : <path d="m4 10 4-4 4 4" />}
    </svg>
  </span>;
}

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
 * checks, PRs and files. Each step with details opens and closes on its own
 * title: unfinished steps start open, finished ones closed, except the last
 * step that has results for the user (PRs, files, links), which starts open.
 */
export function PlanSheet({ sessionId, session, streaming, prs, basePath, onOpenChild, initiallyOpen = true }: {
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
  // The whole plan is open by default; the user folds it to one line when they
  // want the chrome out of the way.
  const [collapsed, setCollapsed] = useState(initiallyOpen === false);
  // The user's own open/close per step; unset steps follow the defaults below.
  const [stepOpen, setStepOpen] = useState<Record<string, boolean>>({});
  // These chips are pull requests, so the condition holds wherever they would draw.
  const prsShown = useShown('pr-status', { pr: true });
  const sessions = useStore((s) => s.sessions);
  const providers = useStore((s) => s.providers);
  const liveVersion = useLiveRunsVersion();
  const live = getLiveRun(sessionId);
  // Mid-turn, the saved `messages` don't yet show tool calls from the in-flight
  // reply. Fold the live tools in as a synthetic trailing assistant message so a
  // Claude Agent chat's TodoWrite plan updates while the agent is still writing
  // it, not only when the turn ends. The real server-side `agentPlan` already
  // updates per call via `session_meta`.
  const planSession = useMemo(() => {
    if (!session || !live?.tools.length) return session;
    const synth: ChatMessage = {
      id: '__live__',
      role: 'assistant',
      content: live.text,
      toolCalls: live.tools,
      createdAt: live.startedAt,
    };
    // Treat each live tool call as succeeded so `claudeCodeOwnPlan` can read it:
    // results stream to the renderer but are kept inside `liveRun.blocks`, not
    // inside the saved `toolResult` field the plan reader looks at.
    const synthResults: ChatMessage[] = live.tools.map((call, i) => ({
      id: '__live_r_' + i,
      role: 'user',
      content: '',
      toolResult: { toolCallId: call.id, output: '', isError: false },
      createdAt: live.startedAt + i,
    }));
    return { ...session, messages: [...(session.messages ?? []), synth, ...synthResults] };
    // liveVersion is the subscription signal, so changes to `live.tools`
    // reach the memo even when the array reference stays stable between ticks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, liveVersion]);
  const messages = planSession?.messages;
  const fullPlan = useMemo(() => sheetPlan(planSession, providers), [planSession, providers]);
  const childSessions = useMemo(() => (sessions ?? []).filter((s) => s.parentSessionId === sessionId), [sessions, sessionId]);
  // Chips land on the plan's own steps; then every check folds into one Verify step.
  const { steps: plan, checks: verifyChecks, links } = useMemo(
    () => groupVerification(fullPlan ?? [], planStepLinks(messages ?? [], fullPlan, basePath, childSessions)),
    [messages, fullPlan, basePath, childSessions]);
  if (!plan.length) return null;
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
  for (const pr of prsShown ? prs : []) {
    if (pr.state !== 'open' || !pr.checkProgress?.items.length) continue;
    const id = checker ?? [...links].find(([, own]) => own.prs.includes(pr.url))?.[0] ?? current?.id;
    if (id) ci.set(id, [...(ci.get(id) ?? []), pr]);
  }
  const prChip = (url: string) => {
    const info = prInfo.get(url);
    const { text, tone, status } = prChipLabel(url, info);
    return <span key={url} className="plan-sheet-pr" data-plan-pr={info?.number ?? 'unknown'}>
      <button type="button" className="plan-sheet-chip" data-plan-chip="pr" title={info?.title ?? url} onClick={() => open(url)}>
        <PrStatusDot status={status} tone={tone} />{text}
      </button>
      <PrHoverActions url={url} info={info} sessionId={sessionId} />
    </span>;
  };
  const artifactChip = (artifact: ChatArtifact) => <button key={artifact.path} type="button" className="plan-sheet-chip" data-plan-chip="link" title={artifact.path} onClick={() => openArtifact(artifact, sessionId)}>{artifact.live ? artifact.live.host + artifact.live.route : artifact.filename}</button>;
  const kids = (own?: PlanStepLinks) => (own?.subagents ?? []).map(id => childById.get(id)).filter((c): c is Child => !!c);
  const position = plan.indexOf(current) + 1;
  const resultStep = plan.filter(step => links.get(step.id)?.prs.length || links.get(step.id)?.artifacts.length).pop()?.id;

  if (collapsed) {
    const own = links.get(current.id);
    const allKids = [...childById.values()];
    // The current step's PRs, else the newest PR the chat opened, so a finished plan still shows where it landed.
    const shownPrs = !prsShown ? [] : own?.prs.length ? own.prs : [...links.values()].flatMap(l => l.prs).slice(-1);
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
          <span className="shrink-0 tabular-nums text-2xs text-ink-faint">{position} of {plan.length}</span>
          <PlanCaret direction="down" label="Show the whole plan" />
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
        <PlanCaret direction="up" label="Fold the plan" />
      </button>
    </div>
    <ol className="plan-sheet-steps">
      {plan.map(step => {
        const own = links.get(step.id);
        const checks = ci.get(step.id) ?? [];
        const stepKids = kids(own);
        // The grouped Verify step shows each check as a sub-bullet, each with its own report.
        const subs = step.id === VERIFY_GROUP_ID ? verifyChecks : [];
        const report = subs.length ? undefined : step.verification;
        const chips = !!((prsShown && own?.prs.length) || own?.artifacts.length || own?.projects.length || stepKids.length || report || checks.length);
        const detail = subs.length ? step.note : report?.detail || step.note;
        const squeezed = step.status === 'done' || step.status === 'skipped';
        const more = !!(detail || chips || subs.length);
        const isOpen = more && (stepOpen[step.id] ?? (!squeezed || step.id === resultStep));
        const line = <>
          <Kind kind={step.kind} current={step.status === 'active'} />
          <span className={`min-w-0 flex-1 truncate ${squeezed ? 'text-ink-soft' : 'text-ink'}${step.status === 'skipped' ? ' line-through' : ''}`} title={step.title}>{step.title}</span>
          <Pass step={step} />
        </>;
        return <li key={step.id} className="plan-sheet-step" data-plan-step={squeezed ? 'done' : step.status} data-plan-step-id={step.id} data-open={isOpen || undefined}>
          <StepMark status={step.status} paused={paused} />
          <div className="min-w-0">
            {more
              ? <button type="button" className="plan-sheet-line plan-sheet-step-toggle" aria-expanded={isOpen} onClick={() => setStepOpen(o => ({ ...o, [step.id]: !isOpen }))}>
                {line}
                <svg className="plan-sheet-step-caret" aria-hidden="true" viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 4 4 4-4 4" /></svg>
              </button>
              : <p className="plan-sheet-line">{line}</p>}
            {more && <div className="plan-sheet-more" data-plan-more hidden={!isOpen}>
              {detail && <p className="truncate text-xs text-ink-faint" title={detail}>{detail}</p>}
              {subs.length > 0 && <ul className="plan-sheet-substeps" data-plan-substeps>
                {subs.map(sub => {
                  const subDetail = sub.verification?.detail || sub.note;
                  return <li key={sub.id} className="plan-sheet-substep" data-plan-substep={sub.id}>
                    <StepMark status={sub.status} paused={paused} />
                    <div className="min-w-0 flex-1">
                      <p className="plan-sheet-line">
                        <span className={`min-w-0 flex-1 truncate ${sub.status === 'done' || sub.status === 'skipped' ? 'text-ink-soft' : 'text-ink'}${sub.status === 'skipped' ? ' line-through' : ''}`} title={sub.title}>{sub.title}</span>
                        {sub.verification && <VerificationChip step={sub} />}
                      </p>
                      {subDetail && <p className="truncate text-xs text-ink-faint" title={subDetail}>{subDetail}</p>}
                    </div>
                  </li>;
                })}
              </ul>}
              {chips && <div className="plan-sheet-chips">
                {own?.projects.map(link => <ProjectChip key={link.url} link={link} />)}
                {stepKids.map(child => <SubagentChip key={child.id} child={child} onOpen={openChild} />)}
                {report && <VerificationChip step={step} />}
                {prsShown && own?.prs.map(prChip)}
                {checks.map(pr => <CiChips key={pr.url} info={pr} />)}
                {own?.artifacts.map(artifactChip)}
              </div>}
            </div>}
          </div>
        </li>;
      })}
    </ol>
  </div></div>;
}
