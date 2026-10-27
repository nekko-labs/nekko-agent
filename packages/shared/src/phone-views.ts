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

/**
 * The computer's hardware for the phone's Expert monitor (`system:stats`,
 * `gpu:stats`, 2026-10-24): load, memory and temperatures, never a CPU or
 * GPU model name (as `monitor:summary`), a process, a path or a serial number.
 */
export const PHONE_SYSTEM_VIEW = ['cpuCores', 'cpuPct', 'memTotalMB', 'memUsedMB', 'temps'] as const;
export const PHONE_GPU_VIEW = ['freeMB', 'source', 'totalMB', 'unified', 'usedMB'] as const;
export const PHONE_GPU_DEVICE_VIEW = ['memoryFreeMB', 'memoryTotalMB', 'memoryUsedMB', 'temperatureC', 'utilizationPct'] as const;
/** A temperature row (`SystemStats.temps`): numbers only. */
export const PHONE_TEMPS_VIEW = ['cpuC', 'gpuC', 'memoryC'] as const;

/**
 * The Model Server (`engine:status`) as the phone's monitor shows it: whether
 * it is installed and running, what it holds in memory and what is loading.
 * Never its binary path, port, log or settings.
 */
export const PHONE_ENGINE_VIEW = ['running'] as const;
export const PHONE_RESIDENT_VIEW = ['contextLength', 'expiresAt', 'gpuLayers', 'id', 'lastUsedAt', 'loadedOn', 'sizeBytes', 'startedAt', 'totalLayers', 'vramBytes'] as const;
export const PHONE_LOADING_VIEW = ['id', 'phase', 'progress', 'startedAt'] as const;
export const PHONE_ENGINE_MEMORY_VIEW = ['budgetBytes', 'kind'] as const;

/**
 * A chat's context window (`context:preview`) as totals: tokens in use, the
 * window, and tokens per kind of source. Never an item's label, origin or
 * preview, which hold file paths, memory and guideline text.
 */
export const PHONE_CONTEXT_SOURCES = ['attached-file', 'connector', 'conversation', 'guideline', 'index-snippet', 'memory', 'skill', 'system'] as const;

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

/**
 * `machine:summary` for a phone (2026-10-24): the computer's version and
 * platform, its hardware profile, live CPU and memory, GPU memory and the
 * model server's state with its resident models by id and name. The daemon
 * builds it without paths or addresses; the view pins the top-level keys and
 * the resident fields so a later field never reaches a phone unseen.
 */
export const PHONE_MACHINE_VIEW = ['version', 'platform', 'edition', 'uptimeMs', 'hardware', 'live', 'gpu', 'engine'] as const;
export const PHONE_MACHINE_RESIDENT_VIEW = ['id', 'name', 'contextTokens'] as const;

export function phoneMachineView(result: unknown): Obj | null {
  if (!isObj(result)) return null;
  const view = pickKeys(result, PHONE_MACHINE_VIEW);
  if (isObj(view.engine)) {
    const engine = { ...view.engine } as Obj;
    engine.resident = Array.isArray(engine.resident) ? engine.resident.filter(isObj).map((m) => pickKeys(m, PHONE_MACHINE_RESIDENT_VIEW)) : [];
    view.engine = engine;
  }
  return view;
}

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

/** `system:stats`: the named numbers, temperatures as numbers only. */
export function phoneSystemView(stats: unknown): Obj | null {
  if (!isObj(stats)) return null;
  const out = pickKeys(stats, PHONE_SYSTEM_VIEW);
  if (own(out, 'temps')) out.temps = pickKeys(out.temps, PHONE_TEMPS_VIEW);
  return out;
}

/** `gpu:stats`: the pool and each device's load, memory and temperature. */
export function phoneGpuView(stats: unknown): Obj | null {
  if (!isObj(stats)) return null;
  const devices = Array.isArray(stats.devices) ? stats.devices.filter(isObj).map((d) => pickKeys(d, PHONE_GPU_DEVICE_VIEW)) : [];
  return { ...pickKeys(stats, PHONE_GPU_VIEW), devices };
}

/** `engine:status`: installed, running, what is resident and what is loading. */
export function phoneEngineView(status: unknown): Obj | null {
  if (!isObj(status)) return null;
  const list = (v: unknown, keys: readonly string[]) => (Array.isArray(v) ? v.filter(isObj).map((m) => pickKeys(m, keys)) : []);
  const install = isObj(status.install) ? status.install : {};
  const out: Obj = {
    ...pickKeys(status, PHONE_ENGINE_VIEW),
    installed: typeof install.binPath === 'string' && install.binPath !== '',
    resident: list(status.resident, PHONE_RESIDENT_VIEW),
    loading: list(status.loading, PHONE_LOADING_VIEW),
  };
  if (isObj(status.memory)) out.memory = pickKeys(status.memory, PHONE_ENGINE_MEMORY_VIEW);
  return out;
}

/** `context:preview`: the included items' tokens, in total and by kind of source. */
export function phoneContextView(bundle: unknown): Obj | null {
  if (!isObj(bundle)) return null;
  const sources: Record<string, number> = {};
  let usedTokens = 0;
  for (const item of Array.isArray(bundle.items) ? bundle.items : []) {
    if (!isObj(item) || item.included !== true) continue;
    const tokens = num(item.tokens);
    usedTokens += tokens;
    if ((PHONE_CONTEXT_SOURCES as readonly unknown[]).includes(item.source)) {
      const source = item.source as string;
      sources[source] = (sources[source] ?? 0) + tokens;
    }
  }
  const out: Obj = { usedTokens, sources };
  if (typeof bundle.contextWindow === 'number' && Number.isFinite(bundle.contextWindow)) out.contextWindow = bundle.contextWindow;
  return out;
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

/**
 * The Monitors pane (`monitor:summary`, FD-1): the limits of what one read
 * carries. Running chats and pending input are listed oldest-waiting first up
 * to their cap; automations soonest first.
 */
export const PHONE_MONITOR_VIEW = {
  /** Working chats listed. */
  running: 20,
  /** Approvals and questions listed, across chats. */
  needsYou: 20,
  /** Next scheduled automation runs listed. */
  automations: 10,
  /** A chat title, a tool name or a question, in UTF-16 units. */
  labelChars: 120,
} as const;

/**
 * What the computer reads to answer `monitor:summary`, in this order: the
 * system probe, the GPU probe, the working chats, the chat summaries, the
 * pending input, the tasks and the workflows. Each is a channel the desktop
 * and the daemon already serve.
 */
export const PHONE_MONITOR_SOURCES = [
  'system:stats',
  'gpu:stats',
  'chat:running',
  'sessions:summaries',
  'chat:pending',
  'tasks:list',
  'workflows:list',
] as const;

export type PhoneMonitorSources = Partial<Record<(typeof PHONE_MONITOR_SOURCES)[number], unknown>>;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const label = (v: unknown): string => (typeof v === 'string' ? cut(v, PHONE_MONITOR_VIEW.labelChars) : '');
const cmp = <T extends string | number>(a: T, b: T) => (a < b ? -1 : a > b ? 1 : 0);

/** The largest finite number among `values`, or undefined. */
function highest(values: unknown[]): number | undefined {
  let best: number | undefined;
  for (const v of values) if (finite(v) && (best === undefined || v > best)) best = v;
  return best;
}

/**
 * The hardware rows: CPU and memory from the system probe, GPU from the GPU
 * probe (the busiest device's load, the hottest temperature). No CPU or GPU
 * model names, no process names: load, memory and temperatures only.
 */
function monitorHardware(system: unknown, gpu: unknown): Obj {
  const sys = isObj(system) ? system : {};
  const temps = isObj(sys.temps) ? sys.temps : {};
  const cpu: Obj = { loadPct: num(sys.cpuPct), cores: num(sys.cpuCores) };
  if (finite(temps.cpuC)) cpu.tempC = temps.cpuC;
  const memory: Obj = { usedMB: num(sys.memUsedMB), totalMB: num(sys.memTotalMB) };
  if (finite(temps.memoryC)) memory.tempC = temps.memoryC;
  let gpuRow: Obj | null = null;
  if (isObj(gpu)) {
    const devices = Array.isArray(gpu.devices) ? gpu.devices.filter(isObj) : [];
    gpuRow = { memoryUsedMB: num(gpu.usedMB), memoryTotalMB: num(gpu.totalMB) };
    const load = highest(devices.map((d) => d.utilizationPct));
    if (load !== undefined) gpuRow.loadPct = load;
    const temp = highest(devices.map((d) => d.temperatureC)) ?? (finite(temps.gpuC) ? temps.gpuC : undefined);
    if (temp !== undefined) gpuRow.tempC = temp;
    if (gpu.unified === true) gpuRow.unified = true;
  } else if (finite(temps.gpuC)) {
    gpuRow = { tempC: temps.gpuC };
  }
  return { cpu, memory, gpu: gpuRow };
}

/**
 * `monitor:summary` as a phone receives it: hardware load and temperatures,
 * the working chats (id, title, what they wait on, how long they have run),
 * the approvals and questions waiting across chats (ids, risk and a short
 * label, never a tool's input) and the next automation runs (name and time,
 * never an instruction or folder). `now` is the computer's clock, in ms.
 */
export function phoneMonitorView(sources: PhoneMonitorSources, now: number): Obj {
  const summaries = Array.isArray(sources['sessions:summaries']) ? sources['sessions:summaries'].filter(isObj) : [];
  const byId = new Map<string, Obj>();
  for (const s of summaries) if (typeof s.id === 'string' && !byId.has(s.id)) byId.set(s.id, s);
  const pending = isObj(sources['chat:pending']) ? sources['chat:pending'] : {};
  const title = (id: string) => label(byId.get(id)?.title);

  const running: Obj[] = [];
  const seen = new Set<string>();
  const ids = Array.isArray(sources['chat:running']) ? sources['chat:running'] : [];
  for (const id of ids) {
    if (typeof id !== 'string' || seen.has(id)) continue;
    seen.add(id);
    const p = isObj(pending[id]) ? (pending[id] as Obj) : {};
    const step = isObj(p.approval) ? 'approval' : isObj(p.question) ? 'question' : 'working';
    const row: Obj = { id, title: title(id), step };
    const run = byId.get(id)?.activeRun;
    if (isObj(run) && finite(run.startedAt)) row.elapsedMs = Math.max(0, now - run.startedAt);
    running.push(row);
  }

  const needsYou: Obj[] = [];
  for (const [id, p] of Object.entries(pending)) {
    if (!isObj(p)) continue;
    const a = p.approval;
    if (isObj(a) && isObj(a.call) && typeof a.call.id === 'string') {
      const sev = a.severity === 'low' || a.severity === 'medium' || a.severity === 'high' ? a.severity : 'medium';
      const row: Obj = { sessionId: id, title: title(id), kind: 'approval', callId: a.call.id, risk: sev, label: label(a.call.name) };
      if (finite(a.requestedAt)) row.since = a.requestedAt;
      needsYou.push(row);
    }
    const q = p.question;
    if (isObj(q) && typeof q.callId === 'string') {
      const first = Array.isArray(q.questions) && isObj(q.questions[0]) ? q.questions[0] : {};
      const row: Obj = {
        sessionId: id,
        title: title(id),
        kind: 'question',
        callId: q.callId,
        label: label(first.question),
        count: Array.isArray(q.questions) ? q.questions.length : 0,
      };
      if (finite(q.askedAt)) row.since = q.askedAt;
      needsYou.push(row);
    }
  }
  const since = (r: Obj) => (finite(r.since) ? r.since : Infinity);
  needsYou.sort((a, b) => cmp(since(a), since(b)) || cmp(a.sessionId as string, b.sessionId as string) || cmp(a.kind as string, b.kind as string));

  const automations: Obj[] = [];
  const tasks = Array.isArray(sources['tasks:list']) ? sources['tasks:list'] : [];
  for (const t of tasks) {
    if (isObj(t) && t.status === 'active' && typeof t.id === 'string' && finite(t.nextRunAt)) {
      automations.push({ kind: 'task', id: t.id, name: label(t.title), nextRunAt: t.nextRunAt });
    }
  }
  const wf = sources['workflows:list'];
  const workflows = isObj(wf) && Array.isArray(wf.workflows) ? wf.workflows : [];
  for (const w of workflows) {
    if (isObj(w) && w.enabled !== false && typeof w.id === 'string' && finite(w.nextRunAt)) {
      automations.push({ kind: 'workflow', id: w.id, name: label(w.name), nextRunAt: w.nextRunAt });
    }
  }
  automations.sort(
    (a, b) => cmp(a.nextRunAt as number, b.nextRunAt as number) || cmp(a.kind as string, b.kind as string) || cmp(a.id as string, b.id as string),
  );

  return {
    hardware: monitorHardware(sources['system:stats'], sources['gpu:stats']),
    running: running.slice(0, PHONE_MONITOR_VIEW.running),
    needsYou: needsYou.slice(0, PHONE_MONITOR_VIEW.needsYou),
    automations: automations.slice(0, PHONE_MONITOR_VIEW.automations),
  };
}
