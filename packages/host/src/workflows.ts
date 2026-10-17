import { exec } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { isAbsolute, join, resolve } from 'path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  AgentEvent,
  ConnectorConfig,
  NewWorkflow,
  Workflow,
  WorkflowEvent,
  WorkflowRun,
  WorkflowStep,
  WorkflowStepRun,
  WorkflowTriggerKind,
  WorkflowsSnapshot,
} from '@nekko-agent/shared';
import {
  CONNECTOR_CATALOG,
  GIT_PROVIDERS,
  MAX_STEP_LOOPS,
  MAX_WORKFLOW_DEPTH,
  UNCATEGORIZED,
  eventContext,
  findWorkflowAction,
  matchWorkflows,
  nextScheduledRun,
  pausedBlocks,
  readStepOutcome,
  slugify,
  stepOutcomeInstruction,
} from '@nekko-agent/shared';
import {
  renderTemplate,
  runWorkflowAction,
  templateContext,
  type WorkflowActionContext,
  type WorkflowTemplateContext,
} from '@nekko-agent/core';
import { dataDir, getSettings } from './store.js';
import { createSession, deleteSession, getSession, saveSession } from './sessions.js';
import { abortChat, sendChat } from './chat.js';
import { listInstalledSkillDefs } from './skills.js';

/**
 * The workflow engine.
 *
 * A run walks a workflow's steps, but by *routing* rather than by index: each
 * step says where control goes on success and on failure, so a verify step can
 * send the run back to build (bounded by MAX_STEP_LOOPS). Steps are prompts,
 * skills, nested workflows, or shell commands; the prompt and skill kinds share
 * one chat session for the whole run, so a later step sees what an earlier one
 * did, and they report their own outcome with a PASS/FAIL token the way a shell
 * step reports an exit code.
 *
 * Definitions live in workflows.json, run history in workflow-runs.json (capped,
 * see RUNS_KEPT), so both survive a restart. A scheduler ticks the cron and
 * interval triggers; everything else arrives through dispatchWorkflowEvent,
 * which is what the CLI, a Slack integration, and a git provider webhook all
 * call.
 */

const TICK_MS = 15_000;
/** Runs kept per workflow; older ones are dropped so the file stays small. */
const RUNS_KEPT = 20;
/** Command output (and agent answers) retained per step, in characters. */
const OUTPUT_KEPT = 4_000;
const DEFAULT_SHELL_TIMEOUT_SEC = 600;

let workflowSender: ((e: AgentEvent) => void) | null = null;
let notify: ((snapshot: WorkflowsSnapshot) => void) | null = null;
/** Workflow ids with a run in flight (one run per workflow at a time). */
const inFlight = new Set<string>();
/** Run ids the user asked to cancel; checked between steps and attempts. */
const cancelled = new Set<string>();
let timer: ReturnType<typeof setInterval> | null = null;

/** Forward a workflow run's agent events to renderers (same bus as live chats). */
export function setWorkflowSender(fn: (e: AgentEvent) => void): void {
  workflowSender = fn;
}

/** Notify renderers when a workflow or any of its runs changes. */
export function setWorkflowsNotifier(fn: (snapshot: WorkflowsSnapshot) => void): void {
  notify = fn;
}

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

function file(name: string): string {
  const dir = dataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file(name), 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function loadWorkflows(): Workflow[] {
  return readJson<Workflow[]>('workflows.json', []);
}

function loadRuns(): WorkflowRun[] {
  return readJson<WorkflowRun[]>('workflow-runs.json', []);
}

function writeWorkflows(list: Workflow[]): void {
  writeFileSync(file('workflows.json'), JSON.stringify(list, null, 2), 'utf8');
  announce();
}

function writeRuns(runs: WorkflowRun[]): void {
  writeFileSync(file('workflow-runs.json'), JSON.stringify(runs, null, 2), 'utf8');
  announce();
}

/** Push the current state to renderers. */
function announce(): void {
  notify?.({ workflows: listWorkflows(), runs: listWorkflowRuns() });
}

/** Definitions, newest first, with each one's next scheduled fire filled in. */
export function listWorkflows(): Workflow[] {
  const now = Date.now();
  return loadWorkflows()
    .map((wf) => ({ ...wf, nextRunAt: wf.enabled ? nextScheduledRun(wf, now) : undefined }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function listWorkflowRuns(workflowId?: string): WorkflowRun[] {
  const runs = loadRuns();
  return (workflowId ? runs.filter((r) => r.workflowId === workflowId) : runs).sort((a, b) => b.startedAt - a.startedAt);
}

/** Both lists in one shot, so a renderer can load its whole view at once. */
export function workflowsSnapshot(): WorkflowsSnapshot {
  return { workflows: listWorkflows(), runs: listWorkflowRuns() };
}

/* ------------------------------------------------------------------ *
 * CRUD
 * ------------------------------------------------------------------ */

export function createWorkflow(input: NewWorkflow): Workflow {
  const list = loadWorkflows();
  const now = Date.now();
  const settings = getSettings();
  const wf: Workflow = {
    id: randomUUID(),
    name: input.name.trim() || 'Untitled workflow',
    description: input.description?.trim() || undefined,
    category: input.category?.trim() || UNCATEGORIZED,
    enabled: input.enabled ?? true,
    steps: input.steps ?? [],
    triggers: input.triggers ?? [{ id: randomUUID(), kind: 'manual' }],
    workspaceId: input.workspaceId ?? settings.workspaces[0]?.id,
    providerId: input.providerId,
    modelId: input.modelId,
    notify: input.notify,
    templateId: input.templateId,
    createdAt: now,
    updatedAt: now,
    runCount: 0,
  };
  list.push(wf);
  writeWorkflows(list);
  return wf;
}

export function updateWorkflow(id: string, patch: Partial<Workflow>): Workflow | undefined {
  const list = loadWorkflows();
  const wf = list.find((w) => w.id === id);
  if (!wf) return undefined;
  // id and createdAt are the workflow's identity; a patch never moves them.
  Object.assign(wf, patch, { id: wf.id, createdAt: wf.createdAt, updatedAt: Date.now() });
  writeWorkflows(list);
  return wf;
}

export function deleteWorkflow(id: string): void {
  writeWorkflows(loadWorkflows().filter((w) => w.id !== id));
  // Drop the run history too, and any chat session a run created that never
  // produced anything (an empty orphan is noise in the sidebar).
  const keep: WorkflowRun[] = [];
  for (const run of loadRuns()) {
    if (run.workflowId !== id) {
      keep.push(run);
      continue;
    }
    for (const sid of new Set(run.steps.map((s) => s.sessionId).filter(Boolean) as string[])) {
      const session = getSession(sid);
      if (session && session.messages.length === 0) deleteSession(sid);
    }
  }
  writeRuns(keep);
}

/** Copy a workflow, so a variant starts from a working one. */
export function duplicateWorkflow(id: string): Workflow | undefined {
  const source = loadWorkflows().find((w) => w.id === id);
  if (!source) return undefined;
  return createWorkflow({
    name: `${source.name} (copy)`,
    description: source.description,
    category: source.category,
    // A copy starts disabled: two workflows answering the same trigger is
    // rarely what someone wants a click after duplicating.
    enabled: false,
    steps: source.steps.map((s) => ({ ...s })),
    triggers: source.triggers.map((t) => ({ ...t, id: randomUUID() })),
    workspaceId: source.workspaceId,
    providerId: source.providerId,
    modelId: source.modelId,
  });
}

/* ------------------------------------------------------------------ *
 * Runs
 * ------------------------------------------------------------------ */

/** Apply a mutation to a run and persist (re-reads to avoid clobbering). */
function persistRun(runId: string, mutate: (run: WorkflowRun) => void): void {
  const runs = loadRuns();
  const run = runs.find((r) => r.id === runId);
  if (!run) return;
  mutate(run);
  writeRuns(runs);
}

function appendRun(run: WorkflowRun): void {
  const runs = loadRuns();
  runs.push(run);
  // Trim this workflow's history to the most recent RUNS_KEPT.
  const mine = runs.filter((r) => r.workflowId === run.workflowId).sort((a, b) => b.startedAt - a.startedAt);
  const drop = new Set(mine.slice(RUNS_KEPT).map((r) => r.id));
  writeRuns(runs.filter((r) => !drop.has(r.id)));
}

/** Roll a finished run up onto its workflow, for the list rows. */
function rollUp(workflowId: string, run: WorkflowRun): void {
  const list = loadWorkflows();
  const wf = list.find((w) => w.id === workflowId);
  if (!wf) return;
  wf.lastRunAt = run.startedAt;
  wf.lastStatus = run.status;
  wf.runCount = (wf.runCount ?? 0) + 1;
  writeWorkflows(list);
}

export function cancelWorkflowRun(runId: string): void {
  const run = loadRuns().find((r) => r.id === runId);
  if (!run || run.status !== 'running') return;
  cancelled.add(runId);
  // Stop whatever agent step is mid-flight; the loop notices between steps.
  for (const sid of new Set(run.steps.map((s) => s.sessionId).filter(Boolean) as string[])) abortChat(sid);
  persistRun(runId, (r) => {
    r.status = 'cancelled';
    r.endedAt = Date.now();
    r.message = 'Cancelled.';
    for (const s of r.steps) if (s.status === 'running') { s.status = 'skipped'; s.endedAt = Date.now(); }
  });
}

/** Start a workflow by hand. Resolves when the run finishes. */
export async function runWorkflow(id: string, event?: WorkflowEvent): Promise<WorkflowRun | undefined> {
  return execute(id, event?.kind ?? 'manual', event, 0);
}

/**
 * Offer an inbound event to every workflow listening for it, and start each
 * match. This is the single door for the CLI, Slack, and git provider webhooks:
 * the caller normalizes its payload into a WorkflowEvent (see GitEvent) and the
 * matching rules live in shared, so every transport behaves identically.
 * Returns the runs that were started.
 */
export async function dispatchWorkflowEvent(event: WorkflowEvent): Promise<WorkflowRun[]> {
  const matches = matchWorkflows(loadWorkflows(), event);
  const runs = await Promise.all(matches.map((wf) => execute(wf.id, event.kind, event, 0)));
  return runs.filter((r): r is WorkflowRun => !!r);
}

/** Outcome of one step attempt. */
interface StepResult {
  ok: boolean;
  output?: string;
  error?: string;
  sessionId?: string;
}

/**
 * Walk a workflow's steps until a terminal transition, then record the result.
 * `depth` guards nested workflow steps (see MAX_WORKFLOW_DEPTH).
 */
async function execute(
  workflowId: string,
  triggerKind: WorkflowTriggerKind,
  event: WorkflowEvent | undefined,
  depth: number,
): Promise<WorkflowRun | undefined> {
  const wf = loadWorkflows().find((w) => w.id === workflowId);
  if (!wf) return undefined;
  // "Pause all automations" holds back what nobody asked for just now.
  if (depth === 0 && pausedBlocks(triggerKind, getSettings().automationsPaused)) return undefined;
  // One run per workflow at a time: a schedule that fires while the last run is
  // still going should be skipped, not stacked.
  if (inFlight.has(workflowId)) return undefined;
  if (wf.steps.length === 0) return undefined;

  const run: WorkflowRun = {
    id: randomUUID(),
    workflowId,
    status: 'running',
    triggerKind,
    triggerLabel: event ? describeEvent(event) : undefined,
    startedAt: Date.now(),
    steps: [],
  };
  inFlight.add(workflowId);
  appendRun(run);

  // One session for the whole run, so a verify step can see what build did.
  const session = createSession(wf.workspaceId);
  session.title = `${wf.name} · run`;
  if (wf.providerId) session.providerId = wf.providerId;
  if (wf.modelId) session.modelId = wf.modelId;
  saveSession(session);

  const visits = new Map<string, number>();
  /** Latest output per step id, for `{{steps.<stepId>.output}}` templates. */
  const stepOutputs = new Map<string, string>();
  const runInfo: WorkflowActionContext['run'] = {
    id: run.id,
    workflowId,
    workflowName: wf.name,
    status: 'running',
    triggerKind,
    triggerLabel: run.triggerLabel,
  };
  let cursor = 0;
  let status: WorkflowRun['status'] = 'success';
  let message: string | undefined;
  let firstStep = true;

  try {
    while (cursor >= 0 && cursor < wf.steps.length) {
      if (cancelled.has(run.id)) return finish('cancelled', 'Cancelled.');
      const step = wf.steps[cursor];

      const seen = (visits.get(step.id) ?? 0) + 1;
      visits.set(step.id, seen);
      if (seen > MAX_STEP_LOOPS) {
        return finish(
          'failure',
          `"${step.name}" was reached ${MAX_STEP_LOOPS} times without the run converging, so it was stopped.`,
        );
      }

      const attempts = Math.max(0, step.retries ?? 0) + 1;
      let result: StepResult = { ok: false, error: 'Step did not run.' };
      for (let attempt = 1; attempt <= attempts; attempt++) {
        if (cancelled.has(run.id)) return finish('cancelled', 'Cancelled.');
        const entry: WorkflowStepRun = { stepId: step.id, status: 'running', attempt, startedAt: Date.now() };
        persistRun(run.id, (r) => { r.steps.push(entry); });

        result = await runStep(wf, step, session.id, {
          event,
          isFirst: firstStep,
          depth,
          run: runInfo,
          tctx: templateContext({ event, outputs: stepOutputs, run: runInfo }),
        });
        firstStep = false;
        // Even a failed attempt's output is worth exposing: a later action step
        // may want the tail of the log it's reporting on.
        stepOutputs.set(step.id, result.output ?? result.error ?? '');

        persistRun(run.id, (r) => {
          const last = r.steps[r.steps.length - 1];
          if (!last) return;
          last.status = result.ok ? 'success' : 'failure';
          last.endedAt = Date.now();
          last.sessionId = result.sessionId;
          last.output = result.output?.slice(-OUTPUT_KEPT);
          last.error = result.error;
        });
        if (result.ok) break;
      }

      // Where next. A failing step with continueOnError is routed as if it
      // passed (GitHub's semantics), but its attempt stays recorded as failed.
      const routed = result.ok || step.continueOnError
        ? step.onSuccess ?? { goto: 'next' as const }
        : step.onFailure ?? { goto: 'fail' as const };

      if (routed.goto === 'fail') {
        return finish('failure', `"${step.name}" failed: ${result.error ?? 'no details'}`);
      }
      if (routed.goto === 'end') break;
      if (routed.goto === 'step') {
        const target = wf.steps.findIndex((s) => s.id === routed.stepId);
        // A transition pointing at a deleted step ends the run rather than
        // silently falling through to whatever now sits at that position.
        if (target === -1) {
          return finish('failure', `"${step.name}" routes to a step that no longer exists.`);
        }
        cursor = target;
        continue;
      }
      cursor += 1;
    }
    return finish(status, message);
  } catch (e) {
    return finish('failure', `Run failed: ${(e as Error).message}`);
  } finally {
    inFlight.delete(workflowId);
    cancelled.delete(run.id);
    // A run whose steps were all shell commands never wrote to its session.
    const fresh = getSession(session.id);
    if (fresh && fresh.messages.length === 0) deleteSession(session.id);
  }

  function finish(final: WorkflowRun['status'], note?: string): WorkflowRun | undefined {
    status = final;
    message = note;
    persistRun(run.id, (r) => {
      // Cancelling already wrote the terminal state; don't overwrite it.
      if (r.status !== 'running') return;
      r.status = final;
      r.endedAt = Date.now();
      r.message = note;
    });
    const saved = loadRuns().find((r) => r.id === run.id);
    if (saved) rollUp(workflowId, saved);
    return saved;
  }
}

/** Everything a step needs beyond its own definition. */
interface StepContext {
  /** The event that fired the run (undefined for a manual start). */
  event?: WorkflowEvent;
  /** True only for the first step, which gets the event context in its prompt. */
  isFirst: boolean;
  depth: number;
  /** The run, handed to action runners for defaults like the status context. */
  run: WorkflowActionContext['run'];
  /** `{{trigger.*}}` / `{{steps.*}}` / `{{run.*}}` interpolation context. */
  tctx: WorkflowTemplateContext;
}

/** Run one step according to its kind. */
async function runStep(
  wf: Workflow,
  step: WorkflowStep,
  sessionId: string,
  sctx: StepContext,
): Promise<StepResult> {
  // Templates apply to `run`/`with`/`params` across kinds: a prompt can quote
  // an earlier step's output and a shell step can name the triggering branch.
  const render = (s?: string) => (s ? renderTemplate(s, sctx.tctx) : s);
  switch (step.kind) {
    case 'shell':
      return runShell(wf, { ...step, run: render(step.run) ?? step.run });
    case 'workflow':
      return runNested({ ...step, run: render(step.run) ?? step.run }, sctx.depth);
    case 'action':
      return runAction(step, sctx);
    case 'prompt':
    case 'skill':
      return runAgentStep(
        wf,
        { ...step, run: render(step.run) ?? step.run, with: render(step.with) },
        sessionId,
        sctx.isFirst ? sctx.event : undefined,
      );
  }
}

/**
 * Action step: call a registered integration op (see core's WORKFLOW_ACTIONS
 * runners). The connector's credentials come from settings, never from the
 * step, so a workflow stays shareable without leaking tokens.
 */
async function runAction(step: WorkflowStep, sctx: StepContext): Promise<StepResult> {
  const spec = findWorkflowAction(step.run.trim());
  if (!spec) {
    return { ok: false, error: `Unknown action "${step.run}". Pick one from the action list in the editor.` };
  }
  let config: ConnectorConfig | undefined;
  if (spec.connector) {
    config = getSettings().connectors.find((c) => c.kind === spec.connector && c.connected);
    if (!config) {
      const label = CONNECTOR_CATALOG.find((c) => c.kind === spec.connector)?.label ?? spec.connector;
      return { ok: false, error: `The ${label} connector isn't connected. Connect it under Connectors.` };
    }
  }
  const params = Object.fromEntries(
    Object.entries(step.params ?? {}).map(([k, v]) => [k, renderTemplate(v, sctx.tctx)]),
  );
  const res = await runWorkflowAction(spec.op, config, params, { event: sctx.event, run: sctx.run });
  if (res.isError) {
    return { ok: false, output: res.output, error: res.output.split('\n')[0].slice(0, 300) || 'Action failed.' };
  }
  return { ok: true, output: res.output };
}

/**
 * Shell step. The command comes from the workflow the user wrote, never from the
 * event that triggered the run, so this runs unattended like a CI step instead
 * of raising a guardrail prompt nobody is there to answer.
 */
async function runShell(wf: Workflow, step: WorkflowStep): Promise<StepResult> {
  const root = getSettings().workspaces.find((w) => w.id === wf.workspaceId)?.path
    ?? getSettings().workspaces[0]?.path
    ?? process.cwd();
  const cwd = step.cwd ? (isAbsolute(step.cwd) ? step.cwd : resolve(root, step.cwd)) : root;
  const timeout = Math.max(1, step.timeoutSec ?? DEFAULT_SHELL_TIMEOUT_SEC) * 1000;

  return new Promise<StepResult>((done) => {
    exec(step.run, { cwd, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const output = [stdout, stderr].filter(Boolean).join('\n').trim();
      if (!error) {
        done({ ok: true, output });
        return;
      }
      const killed = (error as { killed?: boolean }).killed;
      done({
        ok: false,
        output,
        error: killed ? `Timed out after ${step.timeoutSec ?? DEFAULT_SHELL_TIMEOUT_SEC}s` : error.message,
      });
    });
  });
}

/** Nested workflow step: run the target and inherit its outcome. */
async function runNested(step: WorkflowStep, depth: number): Promise<StepResult> {
  if (depth + 1 > MAX_WORKFLOW_DEPTH) {
    return { ok: false, error: `Nested workflows go no deeper than ${MAX_WORKFLOW_DEPTH} levels.` };
  }
  const target = loadWorkflows().find((w) => w.id === step.run);
  if (!target) return { ok: false, error: 'The workflow this step triggers no longer exists.' };
  const run = await execute(target.id, 'manual', undefined, depth + 1);
  if (!run) {
    return { ok: false, error: `"${target.name}" could not start (already running, or it has no steps).` };
  }
  return {
    ok: run.status === 'success',
    output: `"${target.name}" finished: ${run.status}`,
    error: run.status === 'success' ? undefined : run.message ?? run.status,
  };
}

/**
 * Prompt or skill step: one turn of the normal agent loop in the run's session,
 * so tools, guardrails, and context assembly behave exactly as they do in chat.
 * The step reports its own outcome with a PASS/FAIL token (see
 * stepOutcomeInstruction), which is what makes routing possible for agent work.
 */
async function runAgentStep(
  wf: Workflow,
  step: WorkflowStep,
  sessionId: string,
  event: WorkflowEvent | undefined,
): Promise<StepResult> {
  const settings = getSettings();
  const providerId = step.providerId ?? wf.providerId ?? settings.defaultProviderId;
  const modelId = step.modelId ?? wf.modelId ?? settings.defaultModelId;
  if (!providerId || !modelId) {
    return { ok: false, sessionId, error: 'No model configured. Pick a default provider and model in Models.' };
  }

  let body = step.run.trim();
  if (step.kind === 'skill') {
    const skill = findSkill(step.run);
    if (!skill) return { ok: false, sessionId, error: `No installed skill matches "${step.run}".` };
    body = skill.template.trim();
  }
  if (!body) return { ok: false, sessionId, error: 'This step has nothing to run.' };

  const canRetry = (step.retries ?? 0) > 0 || !!step.onFailure;
  const prompt = [
    `## Workflow step: ${step.name}`,
    body,
    step.with?.trim() ? `### Context\n${step.with.trim()}` : '',
    event ? eventContext(event) : '',
    stepOutcomeInstruction(canRetry),
  ]
    .filter(Boolean)
    .join('\n\n');

  const before = getSession(sessionId)?.messages.length ?? 0;
  let failed: string | undefined;
  try {
    await sendChat({ sessionId, providerId, modelId, text: prompt }, (e) => {
      if (e.type === 'error') failed = e.message;
      workflowSender?.(e);
    });
  } catch (e) {
    return { ok: false, sessionId, error: (e as Error).message };
  }

  const after = getSession(sessionId);
  const answer = [...(after?.messages ?? [])]
    .slice(before)
    .reverse()
    .find((m) => m.role === 'assistant' && m.content.trim())?.content ?? '';
  if (failed) return { ok: false, sessionId, output: answer, error: failed };
  if (!answer) return { ok: false, sessionId, error: 'The model produced no answer for this step.' };
  return readStepOutcome(answer) === 'fail'
    ? { ok: false, sessionId, output: answer, error: 'The step reported failure.' }
    : { ok: true, sessionId, output: answer };
}

/** Resolve a skill step's target by id or by its `/name`. */
function findSkill(ref: string) {
  const want = ref.trim().replace(/^\//, '').toLowerCase();
  return listInstalledSkillDefs().find((s) => s.id.toLowerCase() === want || s.name.toLowerCase() === want);
}

/** Short human label for what set a run off, shown on the run row. */
export function describeEvent(e: WorkflowEvent): string {
  switch (e.kind) {
    case 'git': {
      const provider = GIT_PROVIDERS.find((p) => p.id === e.provider)?.label ?? e.provider ?? 'Git';
      return [provider, e.event, e.repo, e.branch].filter(Boolean).join(' · ');
    }
    case 'slack':
      return `Slack ${e.channel ?? ''}`.trim();
    case 'cli':
      return `CLI ${e.command ?? ''}`.trim();
    case 'schedule':
      return 'Schedule';
    case 'connector': {
      const catalog = [
        { kind: 'slack', label: 'Slack' },
        { kind: 'linear', label: 'Linear' },
        { kind: 'jira', label: 'Jira' },
        { kind: 'github', label: 'GitHub' },
        { kind: 'gitlab', label: 'GitLab' },
      ] as const;
      const label = catalog.find((c) => c.kind === e.connector)?.label ?? e.connector ?? 'Connector';
      const parts = [label, e.channel ?? e.repo, e.event, e.text].filter(Boolean);
      return parts.join(' · ');
    }
    case 'webhook':
      return `Webhook${e.slug ? ` · ${e.slug}` : ''}`;
    default:
      return 'Manual';
  }
}

/** Thrown when a request reaches a webhook trigger with the wrong secret. */
export class WebhookUnauthorizedError extends Error {
  readonly code = 'WEBHOOK_UNAUTHORIZED' as const;
  constructor(message = 'unauthorized') {
    super(message);
  }
}

/** Dispatch a webhook that was already authenticated by its route. */
function secretMatches(expected: string, supplied: string): boolean {
  if (expected.length !== supplied.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
  } catch {
    return false;
  }
}

/** Dispatch a webhook that was already authenticated by its route. */
export async function dispatchWebhook(slug: string, secret: string, payload: Record<string, unknown>): Promise<WorkflowRun[]> {
  let foundWebhook = false;
  for (const wf of loadWorkflows()) {
    if (!wf.enabled) continue;
    if (slugify(wf.name) !== slug) continue;
    for (const t of wf.triggers) {
      if (t.kind !== 'webhook' || !t.webhookSecret) continue;
      foundWebhook = true;
      if (secretMatches(t.webhookSecret, secret)) {
        return dispatchWorkflowEvent({ kind: 'webhook', workflowId: wf.id, secret, slug, payload });
      }
    }
  }
  if (foundWebhook) {
    throw new WebhookUnauthorizedError();
  }
  return [];
}

/* ------------------------------------------------------------------ *
 * Scheduler
 * ------------------------------------------------------------------ */

/**
 * Fire schedule triggers as they come due. Interval triggers are measured from
 * the workflow's last run, cron ones from the expression, both resolved by
 * nextScheduledRun so the host and the editor's preview agree.
 */
export function startWorkflowScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    const now = Date.now();
    for (const wf of loadWorkflows()) {
      if (!wf.enabled || inFlight.has(wf.id)) continue;
      if (!wf.triggers.some((t) => t.kind === 'schedule' && t.enabled !== false)) continue;
      // A schedule that came due while the app was closed fires once on the next
      // tick rather than being replayed for every missed slot.
      const due = nextScheduledRun(wf, wf.lastRunAt ?? wf.createdAt);
      if (due != null && due <= now) void execute(wf.id, 'schedule', { kind: 'schedule' }, 0);
    }
  }, TICK_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
}

/** Mark any run left mid-flight by a crash or quit as interrupted, on boot. */
export function reconcileWorkflowRuns(): void {
  const runs = loadRuns();
  let changed = false;
  for (const run of runs) {
    if (run.status !== 'running') continue;
    run.status = 'failure';
    run.endedAt = run.endedAt ?? Date.now();
    run.message = 'Interrupted: Nekko Agent stopped while this run was in progress.';
    for (const s of run.steps) if (s.status === 'running') { s.status = 'skipped'; s.endedAt = Date.now(); }
    changed = true;
  }
  if (changed) writeRuns(runs);
}
