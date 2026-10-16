import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { AgentEvent, ArtifactKind, ExperimentNode, NewTrainingRun, PlanStep, RunArtifact, TrainingRun } from '@nekko-agent/shared';
import { RUN_DONE_TOKEN, RUN_MAX_TURNS_DEFAULT, applyPlanUpdate, bestExperiment, isBetterScore, planEcho, planProgress, runStats, runOutputDir } from '@nekko-agent/shared';
import { dataDir, getSettings } from './store.js';
import { getSession, saveSession, createSession, deleteSession } from './sessions.js';
import { sendChat } from './chat.js';
import { daemonCall, daemonOwns } from './engine/daemon.js';

/**
 * What the engine daemon puts in `NEKKOD_OWNS` when it runs training itself
 * (crates/nekko-automation `training`): it is then the only writer of
 * training.json and runs the scheduler, so this host neither starts runs nor
 * writes the file, and its own calls (the local API server, the CLI, a turn
 * this host runs) go to the daemon.
 */
export const DAEMON_TRAINING = 'training';

/** The daemon's door, when it owns training. */
function trainingDaemon(): ReturnType<typeof daemonCall> {
  return daemonOwns(DAEMON_TRAINING) ? daemonCall() : undefined;
}

/**
 * A run session's `report_experiment`, `report_artifact` or `update_plan`
 * call from a turn this host runs: the daemon's when it owns training
 * (`training:tool`), else handled here. Returns the tool's output and the
 * run's plan after the call (for `update_plan`, mirrored onto the session).
 */
export async function trainingTool(sessionId: string, name: string, input: Record<string, unknown>): Promise<{ output: string; plan?: PlanStep[] }> {
  const call = trainingDaemon();
  if (call) {
    const out = await call<{ output?: string; plan?: PlanStep[]; error?: string }>('training:tool', sessionId, name, input);
    if (out?.error !== undefined) throw new Error(out.error);
    return { output: String(out?.output ?? ''), plan: out?.plan ?? undefined };
  }
  if (name === 'report_experiment') return { output: reportExperiment(sessionId, input) };
  if (name === 'report_artifact') return { output: reportArtifact(sessionId, input) };
  const output = updateRunPlan(sessionId, input);
  return { output, plan: runPlanForSession(sessionId) };
}

/**
 * Training/goal runs: one engine drives both the Training tab (train a model
 * for a purpose, full expert levers) and the Goals tab (plan-first long-running
 * goal solving: the agent writes an execution plan, then executes and iterates
 * on it until the goal is finished). A run owns a dedicated chat session; each
 * "turn" the agent works with the normal tool loop, registering experiments via
 * report_experiment and maintaining the goal plan via update_plan (both handled
 * here). Hints the user adds mid-run are folded into the next turn. State
 * persists to training.json so runs survive restarts (running runs resume on
 * boot).
 */

const TURN_DELAY_MS = 4_000;
const MAX_LOG = 400;
/** Only the last N turn-groups are replayed to the model each turn; the run's
 *  brief re-injects the plan/tree, so old turns aren't needed and the loop
 *  never sends an ever-growing transcript (the "goal is just a huge chat" bug). */
const RUN_HISTORY_TURNS = 4;
/** Pause a run after this many consecutive turns with no measurable progress
 *  AND a repeating output (the "thousands of iterations, going nowhere" case). */
const STALL_LIMIT = 8;
/** Fail a run after this many consecutive turns that error out. */
const ERROR_LIMIT = 5;
/** Default safety backstop on total turns; resuming past it grants another leg. */
const DEFAULT_MAX_TURNS = RUN_MAX_TURNS_DEFAULT;

let trainingSender: ((e: AgentEvent) => void) | null = null;
let notify: ((runs: TrainingRun[]) => void) | null = null;
const inFlight = new Set<string>();

export function setTrainingSender(fn: (e: AgentEvent) => void): void {
  trainingSender = fn;
}
export function setTrainingNotifier(fn: (runs: TrainingRun[]) => void): void {
  notify = fn;
}

function file(): string {
  const dir = dataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'training.json');
}

function load(): TrainingRun[] {
  try {
    return JSON.parse(readFileSync(file(), 'utf8')) as TrainingRun[];
  } catch {
    return [];
  }
}

function save(runs: TrainingRun[]): void {
  writeFileSync(file(), JSON.stringify(runs, null, 2), 'utf8');
  notify?.(runs);
}

/** Apply a patch by id, re-reading first so concurrent writers don't clobber. */
function persistRun(id: string, mutate: (run: TrainingRun) => void): TrainingRun | undefined {
  const runs = load();
  const run = runs.find((r) => r.id === id);
  if (!run) return undefined;
  mutate(run);
  run.updatedAt = Date.now();
  save(runs);
  return run;
}

function log(run: TrainingRun, kind: 'info' | 'milestone' | 'hint' | 'error', text: string): void {
  run.log.push({ at: Date.now(), kind, text });
  if (run.log.length > MAX_LOG) run.log.splice(0, run.log.length - MAX_LOG);
}

export function listTrainingRuns(): TrainingRun[] {
  return load().sort((a, b) => b.createdAt - a.createdAt);
}

export function createTrainingRun(input: NewTrainingRun): TrainingRun {
  const runs = load();
  const now = Date.now();
  const id = randomUUID();
  const settings = getSettings();
  // Provision the driving chat session up front (like automation tasks) so
  // "Open chat" always works and the run keeps context across turns.
  const session = createSession(input.workspaceId);
  const name = input.name?.trim() || input.goal.slice(0, 48) || (input.kind === 'goal' ? 'New goal' : 'New training run');
  session.title = name;
  session.trainingRunId = id;
  session.providerId = input.providerId ?? settings.defaultProviderId;
  session.modelId = input.modelId ?? settings.defaultModelId;
  saveSession(session);

  const run: TrainingRun = {
    id,
    kind: input.kind,
    name,
    goal: input.goal,
    status: 'draft',
    config: input.config ?? {},
    approachId: input.approachId,
    sessionId: session.id,
    workspaceId: input.workspaceId,
    experiments: [],
    artifacts: [],
    hints: [],
    log: [{ at: now, kind: 'info', text: 'Run created.' }],
    createdAt: now,
    updatedAt: now,
    turns: 0,
  };
  runs.push(run);
  save(runs);
  return run;
}

export function updateTrainingRun(id: string, patch: Partial<TrainingRun>): TrainingRun[] {
  // Only user-editable fields; engine-owned state moves through the loop.
  const allowed: (keyof TrainingRun)[] = ['name', 'goal', 'config', 'approachId', 'workspaceId'];
  persistRun(id, (run) => {
    for (const key of allowed) {
      if (key in patch) (run as unknown as Record<string, unknown>)[key] = (patch as Record<string, unknown>)[key];
    }
  });
  return listTrainingRuns();
}

export function deleteTrainingRun(id: string): TrainingRun[] {
  const runs = load();
  const run = runs.find((r) => r.id === id);
  if (run?.sessionId) {
    const s = getSession(run.sessionId);
    if (s && s.messages.length === 0) deleteSession(s.id);
  }
  save(runs.filter((r) => r.id !== id));
  return listTrainingRuns();
}

export function startTrainingRun(id: string): TrainingRun[] {
  const run = persistRun(id, (r) => {
    if (r.status === 'running') return;
    r.status = 'running';
    r.startedAt = Date.now();
    if (!r.endedAt && r.turns === 0) log(r, 'info', 'Run started.');
    else log(r, 'info', 'Run resumed.');
    r.endedAt = undefined;
    // A fresh leg: clear the stall/error counters so a resume actually retries,
    // and grant another turn budget if we're already at/over the backstop.
    r.stallTurns = 0;
    r.errorTurns = 0;
    const cap = r.config?.maxTurns ?? DEFAULT_MAX_TURNS;
    if ((r.turns ?? 0) >= cap) {
      r.config = { ...(r.config ?? {}), maxTurns: (r.turns ?? 0) + DEFAULT_MAX_TURNS };
    }
  });
  if (run) void tickRun(id);
  return listTrainingRuns();
}

export function pauseTrainingRun(id: string): TrainingRun[] {
  persistRun(id, (r) => {
    if (r.status !== 'running') return;
    stopClock(r);
    r.status = 'paused';
    log(r, 'info', 'Run paused. The current iteration finishes, then the agent stops.');
  });
  return listTrainingRuns();
}

export function stopTrainingRun(id: string): TrainingRun[] {
  persistRun(id, (r) => {
    if (r.status === 'completed' || r.status === 'stopped') return;
    stopClock(r);
    r.status = 'stopped';
    r.endedAt = Date.now();
    log(r, 'info', 'Run stopped by the user.');
  });
  return listTrainingRuns();
}

export function addTrainingHint(id: string, text: string): TrainingRun[] {
  const trimmed = text.trim();
  if (trimmed) {
    persistRun(id, (r) => {
      r.hints.push({ id: randomUUID(), text: trimmed, at: Date.now() });
      log(r, 'hint', `Hint queued: ${trimmed.slice(0, 120)}`);
      // A new steer is fresh input; let a stalled run try again on it.
      r.stallTurns = 0;
    });
  }
  return listTrainingRuns();
}

/** Fold the elapsed running time into runtimeMs (on pause/stop/finish). */
function stopClock(run: TrainingRun): void {
  if (run.startedAt) {
    run.runtimeMs = (run.runtimeMs ?? 0) + (Date.now() - run.startedAt);
    run.startedAt = undefined;
  }
}

/**
 * Handle a report_experiment tool call from the run's agent session (routed
 * here by chat.ts). Upserts the node, tracks the leader, logs milestones, and
 * tells the agent where it stands.
 */
export function reportExperiment(sessionId: string, input: Record<string, unknown>): string {
  const runs = load();
  const run = runs.find((r) => r.sessionId === sessionId);
  if (!run) return 'No active run is linked to this session; the experiment was not recorded.';

  const now = Date.now();
  const status = String(input.status ?? 'running') as ExperimentNode['status'];
  const valid: ExperimentNode['status'][] = ['planned', 'running', 'succeeded', 'failed', 'repaired'];
  if (!valid.includes(status)) return `Unknown status "${status}". Use one of: ${valid.join(', ')}.`;

  const id = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : `exp_${run.experiments.length + 1}`;
  let node = run.experiments.find((e) => e.id === id);
  if (!node) {
    node = { id, title: '', status, createdAt: now, updatedAt: now };
    run.experiments.push(node);
  }
  node.title = String(input.title ?? node.title ?? id).slice(0, 120);
  node.status = status;
  node.updatedAt = now;
  if (typeof input.parent_id === 'string' && input.parent_id.trim() && input.parent_id !== id) node.parentId = input.parent_id.trim();
  if (typeof input.approach === 'string' && input.approach.trim()) node.approach = input.approach.trim().slice(0, 60);
  if (typeof input.metric === 'string' && input.metric.trim()) node.metric = input.metric.trim().slice(0, 40);
  if (typeof input.note === 'string' && input.note.trim()) node.note = input.note.trim().slice(0, 300);

  let reply: string;
  const minimize = run.config?.minimizeMetric;
  const leaderBefore = run.bestExperimentId ? run.experiments.find((e) => e.id === run.bestExperimentId) : bestExperiment(run);
  if (typeof input.score === 'number' && Number.isFinite(input.score)) {
    node.score = input.score;
    if (!leaderBefore || leaderBefore.id === node.id || isBetterScore(input.score, leaderBefore.score, minimize)) {
      run.bestExperimentId = node.id;
      log(run, 'milestone', `New leader: ${node.title} scored ${input.score}${node.metric ? ` (${node.metric})` : ''}.`);
      reply = `Recorded ${id}. It is the new leader at ${input.score}.`;
    } else {
      log(run, 'info', `Experiment ${id} (${node.title}) scored ${input.score}, not better than the leader (${leaderBefore.score}).`);
      reply = `Recorded ${id} at ${input.score}. Leader remains ${leaderBefore.id} (${leaderBefore.title}) at ${leaderBefore.score}.`;
    }
  } else {
    if (status === 'failed') log(run, 'error', `Experiment ${id} (${node.title}) failed${node.note ? `: ${node.note}` : '.'}`);
    else if (status === 'repaired') log(run, 'milestone', `Experiment ${id} (${node.title}) was self-repaired.`);
    const leader = run.bestExperimentId ? run.experiments.find((e) => e.id === run.bestExperimentId) : undefined;
    reply = `Recorded ${id} (${status}).${leader?.score != null ? ` Leader is ${leader.id} (${leader.title}) at ${leader.score}.` : ''}`;
  }

  run.updatedAt = now;
  save(runs);
  return reply;
}

/**
 * Handle a report_artifact tool call from a run's agent session (routed here by
 * chat.ts). Upserts the artifact by path so the dashboard can show what the run
 * built, where it lives, and how to use it. Logs a milestone the first time an
 * artifact is registered.
 */
export function reportArtifact(sessionId: string, input: Record<string, unknown>): string {
  const runs = load();
  const run = runs.find((r) => r.sessionId === sessionId);
  if (!run) return 'No active run is linked to this session; the artifact was not recorded.';

  const path = typeof input.path === 'string' ? input.path.trim() : '';
  if (!path) return 'Pass the artifact path (relative to the workspace).';
  const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim().slice(0, 120) : path.split(/[\\/]/).pop() ?? path;
  const validKinds: ArtifactKind[] = ['model', 'agents-md', 'skill', 'spec', 'dataset', 'code', 'report', 'other'];
  const kind = validKinds.includes(input.kind as ArtifactKind) ? (input.kind as ArtifactKind) : 'other';
  const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 300) : undefined;

  const now = Date.now();
  if (!run.artifacts) run.artifacts = [];
  let art = run.artifacts.find((a) => a.path === path);
  const isNew = !art;
  if (!art) {
    art = { id: `art_${run.artifacts.length + 1}`, kind, title, path, createdAt: now, updatedAt: now };
    run.artifacts.push(art);
  }
  art.kind = kind;
  art.title = title;
  if (note !== undefined) art.note = note;
  art.updatedAt = now;

  if (isNew) log(run, 'milestone', `Artifact ready: ${title} (${path})`);
  run.updatedAt = now;
  save(runs);
  return `Recorded artifact "${title}" at ${path}. It now shows on the run's Artifacts card.`;
}

/**
 * Handle an update_plan tool call from a run's agent session (routed here by
 * chat.ts). Replaces or upserts plan steps, logs milestones as steps complete,
 * and echoes the plan back so the agent knows each step's id.
 */
export function updateRunPlan(sessionId: string, input: Record<string, unknown>): string {
  const runs = load();
  const run = runs.find((r) => r.sessionId === sessionId);
  if (!run) return 'No active run is linked to this session; the plan was not recorded.';

  const hadPlan = (run.plan ?? []).length > 0;
  const result = applyPlanUpdate(run.plan, input);
  if ('error' in result) return result.error;

  for (const step of result.finished) {
    log(run, 'milestone', `Plan step done: ${step.title}${step.note ? ` (${step.note})` : ''}`);
  }
  for (const step of result.skippedNow) {
    log(run, 'info', `Plan step skipped: ${step.title}${step.note ? ` (${step.note})` : ''}`);
  }

  run.plan = result.plan;
  if (result.replaced) {
    log(run, hadPlan ? 'info' : 'milestone', hadPlan ? `Plan revised: ${result.plan.length} steps.` : `Plan created: ${result.plan.length} steps.`);
  }
  run.updatedAt = Date.now();
  save(runs);

  return planEcho(result.plan);
}

/** The plan a session's run currently holds, when one is linked. */
export function runPlanForSession(sessionId: string): PlanStep[] | undefined {
  return load().find((r) => r.sessionId === sessionId)?.plan;
}

/**
 * A fingerprint of the run's measurable progress: plan completion + a signature
 * of each step's status, and the experiment count + a signature of each node's
 * status/score. When this is identical two turns running, the turn advanced
 * nothing real (no step completed/revised, no experiment added or changed).
 */
export function progressSignature(run: TrainingRun): string {
  const p = planProgress(run.plan);
  const planSig = (run.plan ?? []).map((s) => `${s.id}:${s.status}`).join(',');
  const expSig = run.experiments.map((e) => `${e.id}:${e.status}:${e.score ?? ''}`).join(',');
  return `${p.done + p.skipped}/${p.total}|${planSig}|${run.experiments.length}|${expSig}`;
}

/** Cheap fingerprint of a turn's final answer, to catch verbatim repetition. */
export function outputSignature(text: string): string {
  const norm = text.replace(RUN_DONE_TOKEN, '').replace(/\s+/g, ' ').trim();
  return `${norm.length}:${norm.slice(0, 240)}`;
}

/** Compact plan summary the goal agent sees each turn. */
function planBrief(run: TrainingRun): string {
  if (!run.plan?.length) return 'No plan yet. Build one with update_plan (replace=true) before doing any execution work.';
  const p = planProgress(run.plan);
  const lines = run.plan.map((s, i) => `${i + 1}. [${s.status}] ${s.title}${s.note ? ` (${s.note})` : ''}`);
  return `Plan, ${p.done}/${p.total} done${p.skipped ? ` (${p.skipped} skipped)` : ''}:\n${lines.join('\n')}`;
}

/** Compact tree summary the agent sees each turn (title, lineage, score). */
function treeBrief(run: TrainingRun): string {
  if (run.experiments.length === 0) return 'No experiments recorded yet.';
  const lines = run.experiments
    .slice(-40)
    .map((e) => {
      const score = e.score != null ? ` score=${e.score}` : '';
      const parent = e.parentId ? ` parent=${e.parentId}` : '';
      const star = e.id === run.bestExperimentId ? ' ★leader' : '';
      return `- ${e.id}${parent} [${e.status}]${score}${star} ${e.title}${e.note ? `: ${e.note}` : ''}`;
    });
  const s = runStats(run);
  return `${run.experiments.length} experiments so far (best=${s.best ?? 'n/a'}, success rate=${s.successRate != null ? Math.round(s.successRate * 100) + '%' : 'n/a'}):\n${lines.join('\n')}`;
}

/** The per-turn brief for a run's agent. */
export function turnPrompt(run: TrainingRun, hints: string[]): string {
  const cfg = run.config ?? {};
  const parts: string[] = [];

  if ((run.turns ?? 0) === 0) {
    if (run.kind === 'training') {
      parts.push(
        `You are Nekko Agent's data-scientist agent. Your job is to actually train a model for this purpose, working hands-on in the workspace (write code, run it with the bash tool, prefer Python; set up a venv or use available tooling; install packages as needed).`,
        `PURPOSE: ${run.goal}`,
      );
      const d = cfg.dataset;
      if (d) parts.push(`DATASET: ${d.source}:${d.id}${d.split ? ` (split: ${d.split})` : ''}${d.source === 'huggingface' ? '. Load via the datasets library.' : d.source === 'kaggle' ? '. Download via the kaggle CLI (needs KAGGLE_* creds; if missing, say so in a report note and continue with an alternative if possible).' : ''}`);
      const b = cfg.baseModel;
      if (b && b.source !== 'none') parts.push(`BASE MODEL: ${b.source}:${b.id ?? ''}. Start from it (fine-tune / adapt) where sensible, but compare against a simpler baseline.`);
      const levers: string[] = [];
      if (cfg.framework && cfg.framework !== 'auto') levers.push(`framework=${cfg.framework}`);
      if (cfg.epochs) levers.push(`epochs≈${cfg.epochs}`);
      if (cfg.batchSize) levers.push(`batch=${cfg.batchSize}`);
      if (cfg.learningRate) levers.push(`lr≈${cfg.learningRate}`);
      if (levers.length) parts.push(`EXPERT LEVERS: ${levers.join(', ')} (treat as strong defaults, note deviations).`);
      if (cfg.metric) parts.push(`METRIC: optimize ${cfg.metric}${cfg.minimizeMetric ? ' (lower is better)' : ' (higher is better)'}; measure with cross-validation or a held-out split.`);
      const h = cfg.harness ?? {};
      const artifacts = [h.agentsMd && 'an AGENTS.md agent file describing how an agent should use the model', h.skill && 'a SKILL.md skill wrapping common usage', h.spec && 'a SPEC.md describing the model, its data, metrics, and intended use'].filter(Boolean);
      if (artifacts.length) parts.push(`HARNESS: when the run completes, also produce ${artifacts.join('; ')} in the output folder, tailored to the purpose.`);
      parts.push(
        `RULES: (1) Work in small, measurable experiments. Call report_experiment when an attempt STARTS (status "running") and when it ENDS (succeeded/failed/repaired, with score when measurable), using parent_id to show what you branched from and "approach" to name the idea family. (2) If something breaks, fix it and mark the experiment "repaired" rather than silently retrying. (3) Keep every artifact in the "${runOutputDir(run)}" folder in the workspace, and the moment one exists on disk call report_artifact for it (kind "model" for the trained model itself, plus each harness file you produce) so the user can see what was built. (4) Between turns you lose nothing: this chat keeps your context. (5) When the purpose is fulfilled (model trained, artifacts written AND registered via report_artifact)${cfg.maxExperiments ? `, or you have exhausted ~${cfg.maxExperiments} experiments` : ''}${cfg.timeBudgetMin ? `, or the ~${cfg.timeBudgetMin} minute budget` : ''}, summarize the outcome and end your reply with ${RUN_DONE_TOKEN}.`,
      );
      if (cfg.extra) parts.push(`EXPERT NOTES: ${cfg.extra}`);
      parts.push(`Start now: profile the task, form a short plan, and run your first experiments.`);
    } else {
      parts.push(
        `You are Nekko Agent's goal agent. You own a long-running goal and drive it to FINISHED, working hands-on in the workspace with your tools. You work in three phases: PLAN first, then EXECUTE, then ITERATE until it is genuinely done.`,
        `GOAL: ${run.goal}`,
        `PHASE 1, PLAN FIRST: investigate the goal and the workspace, then call update_plan (replace=true) with an ordered list of 4-12 concrete, independently verifiable steps that take the goal to finished. Do this before any execution work.`,
        `PHASE 2, EXECUTE: work the plan step by step. Mark the step you start "active"; mark it "done" the moment it is verifiably complete, with a one-line note of the outcome. Never claim a step is done without having verified it.`,
        `PHASE 3, ITERATE: when reality disagrees with the plan (a step fails, new work surfaces, the approach is wrong), revise the plan via update_plan (upsert steps, or replace=true to rewrite it) and keep executing. Repeat until every step is done or skipped AND the goal itself is verifiably met.`,
        `RULES: (1) The plan is the contract; keep step statuses current via update_plan every turn. (2) When an attempt is worth measuring, you may also record it with report_experiment. (3) If something breaks, fix it; note blockers on the affected step. (4) Keep new artifacts in a "${runOutputDir(run)}" folder in the workspace unless the goal is about existing files, and call report_artifact for each concrete deliverable you produce so it shows on the dashboard. (5) Between turns you lose nothing: this chat keeps your context. (6) End your reply with ${RUN_DONE_TOKEN} only when the goal is genuinely finished and verified, never merely planned${cfg.timeBudgetMin ? `, or when the ~${cfg.timeBudgetMin} minute budget is exhausted` : ''}.`,
      );
      if (cfg.extra) parts.push(`CONTEXT & CONSTRAINTS FROM THE USER: ${cfg.extra}`);
      parts.push(`Start now: study the goal, then write the plan with update_plan before executing anything.`);
    }
  } else if (run.kind === 'goal') {
    // Self-contained each turn: only the last few turns are replayed to the
    // model, so restate the goal + constraints rather than relying on turn 0.
    parts.push(`Continue working toward this goal until it is verifiably finished.`, `GOAL: ${run.goal}`);
    if (cfg.extra) parts.push(`CONSTRAINTS: ${cfg.extra}`);
    parts.push(planBrief(run));
    if (run.experiments.length) parts.push(`Experiment tree:\n${treeBrief(run)}`);
    parts.push(`Do the next concrete work now (don't just re-plan): mark the step you start "active" via update_plan, and "done" with a one-line note once you have VERIFIED it. Revise the plan only when reality demands it. End your reply with ${RUN_DONE_TOKEN} only when every step is done or skipped and the goal is verifiably met, never merely planned.`);
  } else {
    parts.push(`Continue the run toward its purpose until met.`, `PURPOSE: ${run.goal}`);
    if (cfg.extra) parts.push(`CONSTRAINTS: ${cfg.extra}`);
    parts.push(`Current experiment tree:\n${treeBrief(run)}`);
    parts.push(`Push the leader further: iterate on what works, branch new idea families when progress stalls, repair failures. Keep calling report_experiment. End with ${RUN_DONE_TOKEN} only when the purpose is genuinely met or budgets are exhausted.`);
  }

  if (hints.length) {
    parts.push(`USER GUIDANCE (fold these into your next experiments; acknowledge each):\n${hints.map((h) => `- ${h}`).join('\n')}`);
  }
  return parts.join('\n\n');
}

/** Drive one agent turn for a run, then re-arm while it stays running. */
async function tickRun(id: string): Promise<void> {
  if (inFlight.has(id)) return;
  const run = load().find((r) => r.id === id);
  if (!run || run.status !== 'running') return;

  const settings = getSettings();
  const session = run.sessionId ? getSession(run.sessionId) : null;
  const providerId = session?.providerId ?? settings.defaultProviderId;
  const modelId = session?.modelId ?? settings.defaultModelId;
  if (!session || !providerId || !modelId) {
    persistRun(id, (r) => {
      r.status = 'failed';
      stopClock(r);
      log(r, 'error', 'No model configured. Set a default provider/model in Models, then start the run again.');
    });
    return;
  }

  // Pre-turn safety guards, so a run can never spin forever. These stop the
  // loop (status flips away from 'running', so it won't re-arm below).
  const budgetMin = run.config?.timeBudgetMin;
  if (budgetMin && runStats(run).runtimeMs >= budgetMin * 60_000) {
    persistRun(id, (r) => {
      stopClock(r);
      r.status = 'stopped';
      r.endedAt = Date.now();
      log(r, 'info', `Stopped: reached the ~${budgetMin} minute time budget after ${r.turns ?? 0} turns. Resume to keep going, or raise the budget.`);
    });
    return;
  }
  const turnCap = run.config?.maxTurns ?? DEFAULT_MAX_TURNS;
  if ((run.turns ?? 0) >= turnCap) {
    persistRun(id, (r) => {
      stopClock(r);
      r.status = 'stopped';
      r.endedAt = Date.now();
      log(r, 'error', `Stopped at the ${turnCap}-turn safety cap. It hasn't finished on its own, so it may be stuck. Add a hint to redirect it, then Resume (which grants a fresh turn budget).`);
    });
    return;
  }

  // Consume pending hints into this turn.
  const hints: string[] = [];
  persistRun(id, (r) => {
    for (const h of r.hints) {
      if (!h.consumedAt) {
        h.consumedAt = Date.now();
        hints.push(h.text);
      }
    }
  });

  const fresh = load().find((r) => r.id === id);
  if (!fresh) return;
  const prompt = turnPrompt(fresh, hints);

  inFlight.add(id);
  persistRun(id, (r) => {
    r.turns = (r.turns ?? 0) + 1;
  });
  try {
    // Only the last few turns are replayed to the model (the brief re-injects
    // the plan/tree), so the loop never grows into an unbounded transcript.
    await sendChat(
      { sessionId: session.id, providerId, modelId, text: prompt, maxHistoryTurns: RUN_HISTORY_TURNS },
      (e) => trainingSender?.(e),
    );
    const done = getSession(session.id);
    const last = [...(done?.messages ?? [])].reverse().find((m) => m.role === 'assistant' && m.content.trim());
    const finished = !!last?.content.includes(RUN_DONE_TOKEN);
    persistRun(id, (r) => {
      r.errorTurns = 0;
      if (finished) {
        if (r.status === 'running') {
          stopClock(r);
          r.status = 'completed';
          r.endedAt = Date.now();
          log(r, 'milestone', `Run completed: ${last!.content.replace(RUN_DONE_TOKEN, '').trim().slice(0, 200)}`);
        }
        return;
      }
      // Stall detection: a turn that advanced nothing measurable AND repeated
      // the previous answer (and wasn't given a fresh hint) counts toward a
      // stall; enough in a row and we pause and ask the user to steer.
      const progressKey = progressSignature(r);
      const outputSig = outputSignature(last?.content ?? '');
      const stalled = hints.length === 0 && r.lastProgressKey === progressKey && r.lastOutputSig === outputSig;
      r.lastProgressKey = progressKey;
      r.lastOutputSig = outputSig;
      r.stallTurns = stalled ? (r.stallTurns ?? 0) + 1 : 0;
      if ((r.stallTurns ?? 0) >= STALL_LIMIT && r.status === 'running') {
        stopClock(r);
        r.status = 'paused';
        r.stallTurns = 0;
        log(r, 'error', `Paused after ${STALL_LIMIT} turns with no measurable progress (no plan step completed or revised, and the agent kept repeating itself). Add a hint to redirect it, then Resume.`);
      }
    });
  } catch (e) {
    persistRun(id, (r) => {
      r.errorTurns = (r.errorTurns ?? 0) + 1;
      log(r, 'error', `Iteration failed: ${(e as Error).message}`);
      if ((r.errorTurns ?? 0) >= ERROR_LIMIT && r.status === 'running') {
        stopClock(r);
        r.status = 'failed';
        r.endedAt = Date.now();
        log(r, 'error', `Stopped after ${ERROR_LIMIT} failed turns in a row. Check the model/provider, then Resume.`);
      }
    });
  } finally {
    inFlight.delete(id);
  }

  // Re-arm while still running (pause/stop/complete/fail flips status mid-turn).
  const after = load().find((r) => r.id === id);
  if (after?.status === 'running') {
    const t = setTimeout(() => void tickRun(id), TURN_DELAY_MS);
    (t as unknown as { unref?: () => void }).unref?.();
  }
}

/** Resume runs that were mid-flight when the host went down (idempotent). */
export function startTrainingScheduler(): void {
  for (const run of load()) {
    if (run.status === 'running') {
      persistRun(run.id, (r) => {
        r.startedAt = Date.now();
        log(r, 'info', 'Host restarted; run resumed automatically.');
      });
      void tickRun(run.id);
    }
  }
}
