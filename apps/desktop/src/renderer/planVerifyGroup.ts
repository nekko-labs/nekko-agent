import type { PlanStep, PlanStepStatus, PlanVerification } from '@nekko-agent/shared';
import type { PlanStepLinks } from './planStepLinks.js';

/** The id of the one Verify step the sheet folds every check into. */
export const VERIFY_GROUP_ID = 'verify:all';

export interface GroupedPlan {
  /** The steps the sheet draws, in plan order, with at most one Verify step. */
  steps: PlanStep[];
  /** The Verify step's checks, drawn as sub-bullets under it. */
  checks: PlanStep[];
  /** Chips by drawn step: the folded Verify steps' chips land on the one that holds them. */
  links: Map<string, PlanStepLinks>;
}

const fromReport = (v: PlanVerification): PlanStepStatus => v.status === 'passed' ? 'done' : v.status === 'active' ? 'active' : 'pending';

function rollUp(items: PlanStep[]): PlanStepStatus {
  if (items.some(s => s.status === 'active')) return 'active';
  if (items.every(s => s.status === 'skipped')) return 'skipped';
  if (items.every(s => s.status === 'done' || s.status === 'skipped')) return 'done';
  return 'pending';
}

/** The report the folded line shows for the whole Verify step: a failing or running one first, else the newest. */
function headline(items: PlanStep[]): PlanVerification | undefined {
  const reports = items.flatMap(s => s.verification ? [{ v: s.verification, at: s.updatedAt }] : []);
  const loud = reports.find(r => ['failed', 'blocked', 'active'].includes(r.v.status));
  return (loud ?? reports.sort((a, b) => a.at - b.at).pop())?.v;
}

/**
 * Every check in the plan under one Verify step. A plan can carry several
 * Verify steps (one per thing built) and a verification report on any step;
 * the sheet shows them as one Verify step whose sub-bullets are each Verify
 * step and each other step's report. The Verify step sits where the last one
 * was (else before Ship, else last), and its status rolls up from its checks.
 * A plan with at most one Verify step and no reports elsewhere is unchanged.
 */
export function groupVerification(plan: PlanStep[], links: Map<string, PlanStepLinks>): GroupedPlan {
  const verifies = plan.filter(s => s.kind === 'verify');
  const reported = plan.filter(s => s.kind !== 'verify' && s.verification);
  if (verifies.length <= 1 && !reported.length) return { steps: plan, checks: [], links };

  const checks: PlanStep[] = plan.flatMap(s => s.kind === 'verify' ? [s]
    : s.verification ? [{ id: `${s.id}:check`, title: s.title, status: fromReport(s.verification), verification: s.verification, createdAt: s.createdAt, updatedAt: s.updatedAt }]
    : []);
  const pass = Math.max(0, ...verifies.map(s => s.pass ?? 0));
  const report = headline(checks);
  const group: PlanStep = {
    id: VERIFY_GROUP_ID,
    // The checks themselves are the sub-bullets, so the step names only the phase.
    title: 'Check the work',
    kind: 'verify',
    // The Verify steps' own progress; a plan without any rolls up from the reports alone.
    status: rollUp(verifies.length ? verifies : checks),
    ...(pass > 1 ? { pass } : {}),
    ...(report ? { verification: report } : {}),
    createdAt: Math.min(...checks.map(s => s.createdAt)),
    updatedAt: Math.max(...checks.map(s => s.updatedAt)),
  };

  const rest = plan.filter(s => s.kind !== 'verify').map(s => s.verification ? (({ verification: _, ...bare }) => bare)(s) : s);
  const lastVerify = verifies.length ? plan.lastIndexOf(verifies[verifies.length - 1]) : -1;
  // Where the group goes among the remaining steps: after those that came before the last Verify step.
  let at = lastVerify >= 0 ? plan.slice(0, lastVerify).filter(s => s.kind !== 'verify').length : rest.findIndex(s => s.kind === 'ship');
  if (at < 0) at = rest.length;
  const steps = [...rest.slice(0, at), group, ...rest.slice(at)];

  const merged = new Map([...links].filter(([id]) => !verifies.some(s => s.id === id)));
  const parts = verifies.map(s => links.get(s.id)).filter((l): l is PlanStepLinks => !!l);
  if (parts.length) merged.set(VERIFY_GROUP_ID, {
    prs: [...new Set(parts.flatMap(l => l.prs))],
    artifacts: parts.flatMap(l => l.artifacts).filter((a, i, all) => all.findIndex(b => b.path === a.path) === i),
    projects: parts.flatMap(l => l.projects).filter((p, i, all) => all.findIndex(q => q.url === p.url) === i),
    subagents: [...new Set(parts.flatMap(l => l.subagents))],
  });
  return { steps, checks, links: merged };
}
