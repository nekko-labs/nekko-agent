/**
 * Model training runs + long-running goal runs, one shared engine.
 *
 * A run drives a dedicated agent session through repeated turns. Training runs
 * (the "data-scientist agent") register every attempt via the report_experiment
 * tool, which builds the run's experiment tree (the "idea maze"). Goal runs are
 * plan-first: the agent writes an execution plan via the update_plan tool, then
 * executes it step by step, revising and iterating until the goal is finished.
 * The user can inject hints, new approaches, or new data mid-run; unconsumed
 * hints are folded into the next turn's prompt. Pure helpers here (stats, maze
 * layout, plan progress) are unit-tested and shared by the host service and
 * both views.
 */

export type RunKind = 'training' | 'goal';

export type RunStatus = 'draft' | 'running' | 'paused' | 'completed' | 'stopped' | 'failed';

export type ExperimentStatus = 'planned' | 'running' | 'succeeded' | 'failed' | 'repaired';

export interface ExperimentNode {
  id: string;
  /** Parent experiment this one branched from (absent = a root approach). */
  parentId?: string;
  /** Short pipeline-style title, e.g. "RobustScaler PCA RandomForest". */
  title: string;
  /** The idea family this belongs to, e.g. "gradient boosting", "PCA stack". */
  approach?: string;
  status: ExperimentStatus;
  /** Primary metric value (higher is better unless the run minimizes). */
  score?: number;
  /** Metric name, e.g. "cv r2", "accuracy". */
  metric?: string;
  /** The agent's one-line takeaway. */
  note?: string;
  createdAt: number;
  updatedAt: number;
}

/** What a produced artifact is, so the dashboard can label and icon it. */
export type ArtifactKind = 'model' | 'agents-md' | 'skill' | 'spec' | 'dataset' | 'code' | 'report' | 'other';

/**
 * A concrete thing a run produced: the trained model, a harness file (agent
 * file / skill / spec), a dataset card, etc. Registered by the agent via the
 * report_artifact tool so the dashboard can show exactly what was built, where
 * it lives, and how to use it, rather than leaving it buried in the log.
 */
export interface RunArtifact {
  id: string;
  kind: ArtifactKind;
  /** Human label, e.g. "Trained model (transformer)", "AGENTS.md". */
  title: string;
  /** Where it lives: a path relative to the workspace, or absolute. */
  path: string;
  /** One-line description of what it is / how to use it. */
  note?: string;
  createdAt: number;
  updatedAt: number;
}

/** Status of one step in a goal run's execution plan. */
export type PlanStepStatus = 'pending' | 'active' | 'done' | 'skipped';

export type PlanVerificationStatus = 'pending' | 'active' | 'passed' | 'failed' | 'blocked' | 'unknown';

export interface PlanVerification {
  status: PlanVerificationStatus;
  device?: string;
  detail?: string;
  evidenceUrl?: string;
}

/** One step of the execution plan a goal agent builds before working. */
export interface PlanStep {
  id: string;
  /** Concrete, verifiable step, e.g. "Wire the CSV parser + unit tests". */
  title: string;
  status: PlanStepStatus;
  /** Explicit inspection state, independent of generic completion; freshness uses updatedAt. */
  verification?: PlanVerification;
  /** One-line outcome, blocker, or the reason a step was skipped. */
  note?: string;
  createdAt: number;
  updatedAt: number;
}

export interface RunHint {
  id: string;
  text: string;
  at: number;
  /** Set when a turn has folded this hint into its prompt. */
  consumedAt?: number;
}

export interface RunLogEntry {
  at: number;
  kind: 'info' | 'milestone' | 'hint' | 'error';
  text: string;
}

export interface DatasetRef {
  source: 'huggingface' | 'kaggle' | 'local' | 'url';
  /** e.g. "imdb", "user/dataset", a path, or a URL. */
  id: string;
  split?: string;
}

export interface BaseModelRef {
  source: 'huggingface' | 'local' | 'none';
  /** e.g. "distilbert-base-uncased" or a local path; ignored for "none". */
  id?: string;
}

/** Simple-mode fields + the full expert levers. Everything optional. */
export interface TrainingConfig {
  dataset?: DatasetRef;
  baseModel?: BaseModelRef;
  /** Metric to optimize, e.g. "r2", "accuracy", "f1". */
  metric?: string;
  /** Optimize downward (loss/error metrics) instead of upward. */
  minimizeMetric?: boolean;
  /** Expert levers, forwarded to the agent as constraints. */
  framework?: 'auto' | 'sklearn' | 'pytorch' | 'transformers';
  epochs?: number;
  batchSize?: number;
  learningRate?: number;
  maxExperiments?: number;
  timeBudgetMin?: number;
  /** Safety backstop on total agent turns; resuming past it grants another leg. */
  maxTurns?: number;
  /** Free-form expert notes appended verbatim to the agent brief. */
  extra?: string;
  /** Harness artifacts to produce beside the model for the use case. */
  harness?: { agentsMd?: boolean; skill?: boolean; spec?: boolean };
}

export interface TrainingRun {
  id: string;
  kind: RunKind;
  name: string;
  /** The purpose ("build a model for X") or the long-running goal. */
  goal: string;
  status: RunStatus;
  config: TrainingConfig;
  /** Selected ML solving approach preset id (goal runs). */
  approachId?: string;
  /** The chat session the agent works in. */
  sessionId?: string;
  workspaceId?: string;
  experiments: ExperimentNode[];
  /** Concrete outputs the run produced (model, harness files, reports). */
  artifacts?: RunArtifact[];
  /** Goal runs: the execution plan the agent builds first, then works through. */
  plan?: PlanStep[];
  hints: RunHint[];
  log: RunLogEntry[];
  bestExperimentId?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  endedAt?: number;
  /** Total milliseconds spent in 'running' before the last pause/stop. */
  runtimeMs?: number;
  /** Count of agent turns taken so far. */
  turns?: number;
  /**
   * Engine loop bookkeeping for stall detection (not user-facing): a fingerprint
   * of measurable progress (plan + experiments), a fingerprint of the last
   * turn's output, and the count of consecutive turns that made neither. Reset
   * whenever the run makes progress, consumes a hint, or is (re)started.
   */
  lastProgressKey?: string;
  lastOutputSig?: string;
  stallTurns?: number;
  /** Consecutive turns that ended in an error (guards against error loops). */
  errorTurns?: number;
}

export interface NewTrainingRun {
  kind: RunKind;
  name?: string;
  goal: string;
  config?: TrainingConfig;
  approachId?: string;
  workspaceId?: string;
  providerId?: string;
  modelId?: string;
}

/** Derived, display-ready stats (the dashboard header tiles). */
export interface RunStats {
  best?: number;
  bestMetric?: string;
  experiments: number;
  /** succeeded / (succeeded + failed + repaired), 0..1; undefined until any finish. */
  successRate?: number;
  /** Distinct idea families tried (approach values, falling back to roots). */
  niches: number;
  /** Experiments that recovered from a failure. */
  repairs: number;
  runtimeMs: number;
  turns: number;
}

/** Common ML solving approaches offered as presets on goal runs. */
export interface ApproachPreset {
  id: string;
  label: string;
  blurb: string;
  /** Folded into the agent brief when selected. */
  hint: string;
}

export const APPROACH_PRESETS: ApproachPreset[] = [
  {
    id: 'automl-sweep',
    label: 'AutoML sweep',
    blurb: 'Breadth-first: try many model families fast, then double down on winners.',
    hint: 'Work breadth-first like an AutoML system: quickly try many model families (linear, trees, boosting, kNN, small nets) with sane defaults, compare on one CV metric, then iterate on the top 2-3 families.',
  },
  {
    id: 'feature-first',
    label: 'Feature engineering first',
    blurb: 'Invest in the data representation before touching model choice.',
    hint: 'Prioritize feature engineering: profile the data, handle missingness/outliers, build derived features and encodings, and validate each transformation by its CV delta before exploring model families.',
  },
  {
    id: 'hyperparam-search',
    label: 'Hyperparameter search',
    blurb: 'Fix a strong family, then search its configuration space methodically.',
    hint: 'Pick the strongest baseline family early, then run a methodical hyperparameter search (coarse random search, then fine-grained around the best region). Track every trial as an experiment.',
  },
  {
    id: 'ensemble-stack',
    label: 'Ensemble & stacking',
    blurb: 'Combine diverse decent models instead of hunting one perfect model.',
    hint: 'Build several diverse decent models and combine them (voting, averaging, stacking with a meta-learner). Diversity matters more than individual perfection.',
  },
  {
    id: 'transfer-finetune',
    label: 'Transfer learning / fine-tune',
    blurb: 'Start from a pretrained model and adapt it to the task.',
    hint: 'Start from a suitable pretrained model (Hugging Face) and fine-tune: freeze most layers first, tune the head, then progressively unfreeze if the budget allows. Compare against a classical baseline.',
  },
  {
    id: 'data-centric',
    label: 'Data-centric iteration',
    blurb: 'Fix the labels and coverage; the model is rarely the bottleneck.',
    hint: 'Iterate on the data, not the model: audit label quality, find error clusters, augment or rebalance underrepresented slices, and re-measure. Keep the model fixed while the data improves.',
  },
  {
    id: 'neuro-evolution',
    label: 'Evolutionary / population search',
    blurb: 'Maintain a population of candidates, mutate winners, prune losers.',
    hint: 'Run a population-based search: keep a pool of candidate pipelines, mutate/crossover the best performers each generation, prune the weakest, and record each generation as experiments branching from their parent.',
  },
  {
    id: 'custom',
    label: 'Custom',
    blurb: 'No preset. The brief and your hints steer the agent.',
    hint: '',
  },
];

export function getApproach(id?: string): ApproachPreset | undefined {
  return APPROACH_PRESETS.find((a) => a.id === id);
}

/** Compare scores respecting the run's metric direction. */
export function isBetterScore(candidate: number, incumbent: number | undefined, minimize?: boolean): boolean {
  if (incumbent == null) return true;
  return minimize ? candidate < incumbent : candidate > incumbent;
}

/** The current best experiment (by score, respecting direction). */
export function bestExperiment(run: Pick<TrainingRun, 'experiments' | 'config'>): ExperimentNode | undefined {
  let best: ExperimentNode | undefined;
  for (const e of run.experiments) {
    if (e.score == null) continue;
    if (!best || isBetterScore(e.score, best.score, run.config?.minimizeMetric)) best = e;
  }
  return best;
}

/** Derive the dashboard stats from a run. */
export function runStats(run: TrainingRun, now = Date.now()): RunStats {
  const finished = run.experiments.filter((e) => e.status === 'succeeded' || e.status === 'failed' || e.status === 'repaired');
  const ok = finished.filter((e) => e.status === 'succeeded' || e.status === 'repaired').length;
  const families = new Set(run.experiments.map((e) => (e.approach?.trim().toLowerCase() || (e.parentId ? '' : e.id))).filter(Boolean));
  const best = bestExperiment(run);
  const live = run.status === 'running' && run.startedAt ? now - run.startedAt : 0;
  return {
    best: best?.score,
    bestMetric: best?.metric ?? run.config?.metric,
    experiments: run.experiments.length,
    successRate: finished.length ? ok / finished.length : undefined,
    niches: families.size,
    repairs: run.experiments.filter((e) => e.status === 'repaired').length,
    runtimeMs: (run.runtimeMs ?? 0) + live,
    turns: run.turns ?? 0,
  };
}

/** Plan progress for the Goals dashboard (done + skipped count toward completion). */
export interface PlanProgress {
  total: number;
  done: number;
  skipped: number;
  /** The step being worked now: the first 'active' step, else the first 'pending'. */
  current?: PlanStep;
  /** Completion 0..1 ((done + skipped) / total); 0 while there is no plan. */
  ratio: number;
}

export function planProgress(plan: PlanStep[] | undefined): PlanProgress {
  const steps = plan ?? [];
  const done = steps.filter((s) => s.status === 'done').length;
  const skipped = steps.filter((s) => s.status === 'skipped').length;
  const current = steps.find((s) => s.status === 'active') ?? steps.find((s) => s.status === 'pending');
  return { total: steps.length, done, skipped, current, ratio: steps.length ? (done + skipped) / steps.length : 0 };
}

/** Input shape of an `update_plan` tool call. */
export interface PlanUpdateInput {
  replace?: boolean;
  steps?: Array<Record<string, unknown>>;
}

export interface PlanUpdateResult {
  plan: PlanStep[];
  /** True when `steps` replaced the plan outright (initial write or a re-plan). */
  replaced: boolean;
  /** Steps that transitioned to done this call. */
  finished: PlanStep[];
  /** Steps that transitioned to skipped this call. */
  skippedNow: PlanStep[];
}

/** Invalid objects are ignored; invalid optional fields are dropped. No completion inference. */
function sanitizeVerification(value: unknown): PlanVerification | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const statuses: string[] = ['pending', 'active', 'passed', 'failed', 'blocked', 'unknown'];
  if (typeof v.status !== 'string' || !statuses.includes(v.status)) return undefined;
  const result: PlanVerification = { status: v.status as PlanVerificationStatus };
  for (const [key, cap] of [['device', 160], ['detail', 1000]] as const) {
    if (typeof v[key] === 'string' && v[key].trim()) result[key] = v[key].trim().slice(0, cap);
  }
  if (typeof v.evidenceUrl === 'string') {
    const link = v.evidenceUrl.trim();
    if (link.length <= 2048 && /^https?:\/\//i.test(link)) {
      try {
        const url = new URL(link);
        if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) result.evidenceUrl = link;
      } catch { /* Ignore unsafe or malformed evidence links. */ }
    }
  }
  return result;
}

/**
 * Apply an `update_plan` call to an existing plan: the semantics both writers
 * share: goal-run plans on a TrainingRun and the live `agentPlan` on an
 * ordinary chat session.
 *
 * `replace` rewrites unfinished scope while retaining done/skipped history;
 * otherwise steps upsert by id, falling back to a case-insensitive title match so the model
 * can update a step whose id it forgot. Titles cap at 160 chars, notes at 240,
 * and unknown statuses are ignored rather than rejected.
 */
export function applyPlanUpdate(
  current: PlanStep[] | undefined,
  input: PlanUpdateInput,
): PlanUpdateResult | { error: string } {
  const raw = Array.isArray(input.steps) ? input.steps : [];
  if (!raw.length) return { error: 'Pass at least one step.' };

  const valid: PlanStepStatus[] = ['pending', 'active', 'done', 'skipped'];
  const now = Date.now();
  const hadPlan = (current ?? []).length > 0;
  const replace = input.replace === true || !hadPlan;
  // Re-planning can replace unfinished scope, never the conversation's settled history.
  const next: PlanStep[] = (current ?? [])
    .filter((step) => !replace || step.status === 'done' || step.status === 'skipped')
    .map((step) => ({ ...step }));
  const finished: PlanStep[] = [];
  const skippedNow: PlanStep[] = [];

  const freshId = () => {
    let n = next.length + 1;
    while (next.some((s) => s.id === `step_${n}`)) n++;
    return `step_${n}`;
  };
  for (const r of raw) {
    const title = String(r.title ?? '').trim().slice(0, 160);
    const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim() : '';
    const status = typeof r.status === 'string' && valid.includes(r.status as PlanStepStatus)
      ? (r.status as PlanStepStatus)
      : undefined;
    const note = typeof r.note === 'string' && r.note.trim() ? r.note.trim().slice(0, 240) : undefined;
    const verification = sanitizeVerification(r.verification);
    let step = id ? next.find((s) => s.id === id) : undefined;
    // A fresh plan often starts numbering at step_1 again. Do not rename history.
    if (replace && step && title && step.title.toLowerCase() !== title.toLowerCase()) step = undefined;
    if (!step && title) step = next.find((s) => s.title.toLowerCase() === title.toLowerCase());
    if (step) {
      const was = step.status;
      if (title) step.title = title;
      if (status && !(replace && (was === 'done' || was === 'skipped'))) step.status = status;
      if (note) step.note = note;
      if (verification) step.verification = verification;
      step.updatedAt = now;
      if (step.status === 'done' && was !== 'done') finished.push(step);
      else if (step.status === 'skipped' && was !== 'skipped') skippedNow.push(step);
    } else if (title) {
      next.push({ id: id && !next.some((s) => s.id === id) ? id : freshId(), title, status: status ?? 'pending', note, createdAt: now, updatedAt: now, ...(verification ? { verification } : {}) });
    }
  }
  if (!next.length) return { error: 'The plan cannot be empty; pass the full step list.' };
  return { plan: next, replaced: replace, finished, skippedNow };
}

/** The text an `update_plan` call echoes back so the agent knows each step's id. */
export function planEcho(plan: PlanStep[]): string {
  const p = planProgress(plan);
  const lines = plan.map((s, i) => `${i + 1}. [${s.status}] ${s.id}: ${s.title}`);
  return `Plan saved (${p.done}/${p.total} done${p.skipped ? `, ${p.skipped} skipped` : ''}):\n${lines.join('\n')}`;
}

/** A node placed on the idea-maze canvas (column/row grid coordinates). */
export interface MazeNode {
  exp: ExperimentNode;
  /** Column: stable left-to-right order (DFS over creation-ordered forest). */
  col: number;
  /** Row: depth in the tree (roots at 0). */
  row: number;
  /** True when this node is on the ancestry path of the best experiment. */
  onBestPath: boolean;
}

/**
 * Deterministic idea-maze layout: a DFS over the forest (roots and siblings in
 * creation order) assigns each node the next column; depth gives the row. The
 * result reads left→right chronologically, with branches hanging under their
 * parents, like the AIDE-style experiment maze.
 */
export function layoutMaze(run: Pick<TrainingRun, 'experiments' | 'config' | 'bestExperimentId'>): MazeNode[] {
  const byParent = new Map<string | undefined, ExperimentNode[]>();
  const byId = new Map(run.experiments.map((e) => [e.id, e]));
  for (const e of run.experiments) {
    // Orphaned parent ids (agent typo) fall back to root placement.
    const key = e.parentId && byId.has(e.parentId) ? e.parentId : undefined;
    const list = byParent.get(key) ?? [];
    list.push(e);
    byParent.set(key, list);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

  const bestId = run.bestExperimentId ?? bestExperiment(run as TrainingRun)?.id;
  const bestPath = new Set<string>();
  let cur = bestId ? byId.get(bestId) : undefined;
  let guard = 0;
  while (cur && guard++ < 1000) {
    bestPath.add(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }

  const out: MazeNode[] = [];
  let col = 0;
  const walk = (node: ExperimentNode, row: number) => {
    out.push({ exp: node, col: col++, row, onBestPath: bestPath.has(node.id) });
    for (const child of byParent.get(node.id) ?? []) walk(child, row + 1);
  };
  for (const root of byParent.get(undefined) ?? []) walk(root, 0);
  return out;
}

/** Workspace-safe folder name for a run's artifacts (shared by host + UI). */
export function runFolderSlug(run: Pick<TrainingRun, 'name' | 'id'>): string {
  return run.name.replace(/[^a-z0-9-_ ]/gi, '').slice(0, 30).trim() || run.id.slice(0, 8);
}

/**
 * The workspace-relative folder a run keeps its artifacts in. Training runs use
 * "nekko-training/<slug>"; goal runs use "nekko-goal/<slug>". The host tells
 * the agent to work here, and the dashboard shows/opens it, so both agree.
 */
export function runOutputDir(run: Pick<TrainingRun, 'name' | 'id' | 'kind'>): string {
  return `${run.kind === 'goal' ? 'nekko-goal' : 'nekko-training'}/${runFolderSlug(run)}`;
}

/** Short human runtime, e.g. "15h", "2d 4h", "34m". */
export function formatRuntime(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return h >= 10 ? `${h}h` : `${h}h ${m % 60 ? `${m % 60}m` : ''}`.trim();
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Token the agent uses to declare the whole run finished. */
export const RUN_DONE_TOKEN = '⟦RUN_DONE⟧';

/**
 * Default safety backstop on total agent turns for a run (overridable per run
 * via config.maxTurns). The host stops a run at this cap; resuming grants a
 * fresh leg. Shared so the dashboard can show the budget the loop enforces.
 */
export const RUN_MAX_TURNS_DEFAULT = 400;
