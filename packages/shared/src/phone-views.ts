/**
 * What a paired phone sees beyond a chat's transcript: the computer's saved
 * prompts, a chat's queue, its pull requests, the computer's automations
 * (tasks and workflows) and its provider usage and limits. Each is a narrow,
 * read-only projection made on the computer: named fields only, long text cut,
 * model paths cut to their file name, and nothing that holds a key, a token,
 * a folder or an instruction the phone does not need.
 *
 * The daemon has the same projections (crates/nekko-remote/src/phone_views.rs),
 * held to these by the phone golden (tests/golden/phone.json).
 */

import { limitsKeyFor } from './limits.js';

/** The limits of these views. */
export const PHONE_VIEWS = {
  /** A task's last result and a workflow's description, in UTF-16 units. */
  textChars: 600,
  /** Days of daily usage. */
  usageDays: 14,
  /** Models listed in usage, the busiest first. */
  usageModels: 12,
} as const;

/** A saved prompt as a phone receives it with the settings: its name and text. */
export const PHONE_PROMPT_VIEW = ['body', 'id', 'name'] as const;

/** A task (`tasks:list`): its schedule and how it last went, never its instruction or folder. */
export const PHONE_TASK_VIEW = [
  'createdAt',
  'id',
  'intervalMs',
  'keepAlive',
  'kind',
  'lastResult',
  'lastRunAt',
  'lastSessionId',
  'nextRunAt',
  'runAt',
  'runCount',
  'status',
  'title',
] as const;

/** A workflow (`workflows:list`): its name and state, never its steps, triggers' settings or folder. */
export const PHONE_WORKFLOW_VIEW = [
  'category',
  'description',
  'enabled',
  'id',
  'lastRunAt',
  'lastStatus',
  'name',
  'nextRunAt',
  'runCount',
] as const;

/** A run a phone started (`workflow:run`). */
export const PHONE_WORKFLOW_RUN_VIEW = ['id', 'startedAt', 'status', 'workflowId'] as const;

/** A chat's pull request (`pr:sessionList`): its state and checks. */
export const PHONE_PR_VIEW = [
  'additions',
  'changedFiles',
  'checks',
  'deletions',
  'isDraft',
  'number',
  'reviewDecision',
  'state',
  'title',
  'url',
] as const;

/** A provider's limits (`limits:get`): the plan and each window. */
export const PHONE_LIMITS_VIEW = ['creditsState', 'planType', 'updatedAt'] as const;
export const PHONE_LIMIT_WINDOW_VIEW = ['id', 'label', 'modelFamily', 'resetAt', 'scope', 'status', 'usedPercent'] as const;

/** `chat:editQueued`'s edit: the text the editor showed, and the new text (none removes the prompt). */
export const PHONE_QUEUE_EDIT_KEYS = ['expect', 'text'] as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: Obj, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function pickKeys(value: unknown, keys: readonly string[]): Obj {
  const out: Obj = {};
  if (!isObj(value)) return out;
  for (const k of keys) if (own(value, k)) out[k] = value[k];
  return out;
}

/** `s` cut to `n` UTF-16 units, never leaving half of a surrogate pair. */
function cut(s: string, n: number): string {
  if (s.length <= n) return s;
  const end = s.charCodeAt(n - 1) >= 0xd800 && s.charCodeAt(n - 1) <= 0xdbff ? n - 1 : n;
  return s.slice(0, end);
}

function cutField(o: Obj, key: string): void {
  if (typeof o[key] === 'string') o[key] = cut(o[key] as string, PHONE_VIEWS.textChars);
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** A model id that is a file on the computer (a local model) becomes its file name. */
function modelName(id: string): string {
  return id.slice(Math.max(id.lastIndexOf('/'), id.lastIndexOf('\\')) + 1);
}

/** The saved prompts in a settings view: names and text that are strings, nothing else. */
export function phonePromptsView(prompts: unknown): Obj[] {
  if (!Array.isArray(prompts)) return [];
  return prompts
    .filter((p) => isObj(p) && typeof p.name === 'string' && typeof p.body === 'string')
    .map((p) => pickKeys(p, PHONE_PROMPT_VIEW));
}

/**
 * A chat's queue as a phone receives it: each prompt's text and skill, with
 * its photos as `''` (the phone shows how many, the computer keeps them).
 */
export function phoneQueueView(queue: unknown): unknown[] {
  if (!Array.isArray(queue)) return [];
  return queue.map((q) => {
    if (!isObj(q)) return q;
    const out: Obj = { text: typeof q.text === 'string' ? q.text : '' };
    if (isObj(q.skill)) out.skill = pickKeys(q.skill, ['input', 'name']);
    const photos = (Array.isArray(q.images) ? q.images.length : 0) + (Array.isArray(q.videos) ? q.videos.length : 0);
    if (photos) out.images = Array.from({ length: photos }, () => '');
    return out;
  });
}

export function phoneTasksView(tasks: unknown): Obj[] {
  if (!Array.isArray(tasks)) return [];
  return tasks.filter(isObj).map((t) => {
    const out = pickKeys(t, PHONE_TASK_VIEW);
    cutField(out, 'lastResult');
    return out;
  });
}

/** `workflows:list` (definitions and runs) as the phone's list of workflows. */
export function phoneWorkflowsView(snapshot: unknown): Obj[] {
  const list = isObj(snapshot) && Array.isArray(snapshot.workflows) ? snapshot.workflows : [];
  return list.filter(isObj).map((w) => {
    const out = pickKeys(w, PHONE_WORKFLOW_VIEW);
    cutField(out, 'description');
    out.stepCount = Array.isArray(w.steps) ? w.steps.length : 0;
    return out;
  });
}

/**
 * A chat's durable watches as a phone sees them (`session:watches`, 2026-10-24):
 * what each watches, when it wakes and how that went, so the phone's rows
 * can show the same live chip as the desktop. The continuation prompt is not
 * a field of the view (the desktop channel never returns it either; the
 * transcript holds it in the arming call). `lastError` is cut to `textChars`.
 */
export const PHONE_WATCH_VIEW = ['id', 'kind', 'url', 'status', 'deadlineAt', 'nextPollAt', 'pending', 'failures', 'lastError'] as const;

/** `session:watches` for a phone: each watch picked to `PHONE_WATCH_VIEW`, anything that is not an object dropped. */
export function phoneWatchesView(result: unknown): Obj[] {
  if (!Array.isArray(result)) return [];
  return result.filter(isObj).map((w) => {
    const view = pickKeys(w, PHONE_WATCH_VIEW);
    cutField(view, 'lastError');
    return view;
  });
}

export function phonePrsView(prs: unknown): Obj[] {
  return Array.isArray(prs) ? prs.filter(isObj).map((p) => pickKeys(p, PHONE_PR_VIEW)) : [];
}

export function phoneLimitsView(limits: unknown): Obj | null {
  if (!isObj(limits)) return null;
  const windows = Array.isArray(limits.windows) ? limits.windows.filter(isObj).map((w) => pickKeys(w, PHONE_LIMIT_WINDOW_VIEW)) : [];
  return { ...pickKeys(limits, PHONE_LIMITS_VIEW), windows };
}

/** `usage:summary` as totals, the busiest models and the recent days. */
export function phoneUsageView(usage: unknown): Obj | null {
  if (!isObj(usage)) return null;
  const models = isObj(usage.byModel)
    ? Object.entries(usage.byModel)
        .filter(([, v]) => isObj(v))
        .map(([id, v]) => {
          const m = v as Obj;
          const row: Obj = { model: modelName(id), input: num(m.input), output: num(m.output), cost: num(m.cost) };
          if (m.subscription === true) row.subscription = true;
          return row;
        })
    : [];
  const tokens = (r: Obj) => (r.input as number) + (r.output as number);
  const name = (r: Obj) => r.model as string;
  models.sort((a, b) => tokens(b) - tokens(a) || (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0));
  const days = Array.isArray(usage.daily) ? usage.daily.filter((d) => isObj(d) && typeof d.date === 'string') : [];
  return {
    totalInput: num(usage.totalInput),
    totalOutput: num(usage.totalOutput),
    totalCost: num(usage.totalCost),
    byModel: models.slice(0, PHONE_VIEWS.usageModels),
    daily: days.slice(Math.max(0, days.length - PHONE_VIEWS.usageDays)).map((d) => {
      const o = d as Obj;
      return { date: o.date, input: num(o.input), output: num(o.output), cost: num(o.cost) };
    }),
  };
}

/**
 * The computer's limits key for a provider a phone names by id (the phone
 * never sees keys or token references), or null when it has no limits to read.
 */
export function phoneLimitsKey(providers: unknown, providerId: string): string | null {
  const list = Array.isArray(providers) ? providers : [];
  const found = list.find((p) => isObj(p) && p.id === providerId);
  return isObj(found) ? limitsKeyFor(found as never) : null;
}
