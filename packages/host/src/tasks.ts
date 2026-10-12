import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { AgentEvent, AutomationTask, NewTask } from '@nekko-agent/shared';
import { TASK_DONE_TOKEN } from '@nekko-agent/shared';
import { dataDir } from './store.js';
import { getSettings } from './store.js';
import { getSession, saveSession, createSession, deleteSession } from './sessions.js';
import { sendChat } from './chat.js';

/**
 * Automation tasks: scheduled (one-shot at a time), recurring (every N), and
 * long-running background agents (keep alive forever, or until a condition the
 * agent judges met). A single in-process scheduler ticks periodically and fires
 * any due task by driving a chat session through the normal agent loop. State is
 * persisted to tasks.json so tasks survive restarts.
 */

const TICK_MS = 15_000;
const DEFAULT_BG_INTERVAL = 5 * 60_000;

let taskSender: ((e: AgentEvent) => void) | null = null;
let notify: ((tasks: AutomationTask[]) => void) | null = null;
const inFlight = new Set<string>();
let timer: ReturnType<typeof setInterval> | null = null;

/** Forward the fired task's agent events to renderers (same bus as live chats). */
export function setTaskSender(fn: (e: AgentEvent) => void): void {
  taskSender = fn;
}
/** Notify renderers when the task list changes. */
export function setTasksNotifier(fn: (tasks: AutomationTask[]) => void): void {
  notify = fn;
}

function file(): string {
  const dir = dataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'tasks.json');
}

function load(): AutomationTask[] {
  try {
    return JSON.parse(readFileSync(file(), 'utf8')) as AutomationTask[];
  } catch {
    return [];
  }
}

function save(tasks: AutomationTask[]): void {
  writeFileSync(file(), JSON.stringify(tasks, null, 2), 'utf8');
  notify?.(tasks);
}

export function listTasks(): AutomationTask[] {
  return load().sort((a, b) => b.createdAt - a.createdAt);
}

export function createTask(input: NewTask): AutomationTask[] {
  const tasks = load();
  const now = Date.now();
  const title = input.title.trim() || 'Untitled task';
  const id = randomUUID();
  // Give every task its own chat session up front so the dashboard can always
  // open it, even before the task has fired. Firing reuses this session.
  const settings = getSettings();
  const providerId = input.providerId ?? settings.defaultProviderId;
  const modelId = input.modelId ?? settings.defaultModelId;
  const session = createSession(input.workspaceId);
  session.title = title;
  session.taskId = id;
  if (providerId) session.providerId = providerId;
  if (modelId) session.modelId = modelId;
  saveSession(session);
  const task: AutomationTask = {
    id,
    title,
    kind: input.kind,
    prompt: input.prompt,
    workspaceId: input.workspaceId,
    providerId: input.providerId,
    modelId: input.modelId,
    runAt: input.runAt,
    intervalMs: input.intervalMs,
    keepAlive: input.keepAlive,
    condition: input.condition,
    status: 'active',
    createdAt: now,
    runCount: 0,
    lastSessionId: session.id,
    // When the first fire happens: scheduled → at runAt; otherwise asap.
    nextRunAt: input.kind === 'scheduled' ? input.runAt ?? now : now,
  };
  tasks.push(task);
  save(tasks);
  return listTasks();
}

export function updateTask(id: string, patch: Partial<AutomationTask>): AutomationTask[] {
  const tasks = load();
  const t = tasks.find((x) => x.id === id);
  if (t) {
    Object.assign(t, patch);
    // Re-arm when resumed.
    if (patch.status === 'active' && !t.nextRunAt) t.nextRunAt = Date.now();
    save(tasks);
  }
  return listTasks();
}

export function deleteTask(id: string): AutomationTask[] {
  const tasks = load();
  const t = tasks.find((x) => x.id === id);
  // Drop the task's chat only if it never produced anything (empty orphan).
  if (t?.lastSessionId) {
    const s = getSession(t.lastSessionId);
    if (s && s.messages.length === 0) deleteSession(s.id);
  }
  save(tasks.filter((x) => x.id !== id));
  return listTasks();
}

export function runTaskNow(id: string): void {
  const t = load().find((x) => x.id === id);
  if (t) void fireTask(t.id);
}

/**
 * The prompt a firing task sends: its own, plus the stop instruction for a
 * background task that runs until a condition holds.
 */
export function taskPrompt(task: AutomationTask): string {
  let prompt = task.prompt;
  if (task.kind === 'background' && task.keepAlive === 'until' && task.condition) {
    prompt += `\n\n(This is a background task. Keep working until: ${task.condition}. When that condition is fully satisfied, end your reply with the token ${TASK_DONE_TOKEN}.)`;
  }
  return prompt;
}

/** What a finished fire writes back: the answer's start, and done or the next run. */
export function taskRunPatch(task: AutomationTask, result: string, now: number): Partial<AutomationTask> {
  const patch: Partial<AutomationTask> = { lastResult: result.slice(0, 400) };
  if (task.kind === 'scheduled') {
    patch.status = 'done';
  } else if (task.kind === 'recurring') {
    patch.nextRunAt = now + Math.max(60_000, task.intervalMs ?? DEFAULT_BG_INTERVAL);
  } else {
    // background
    if (task.keepAlive === 'until' && (result.includes(TASK_DONE_TOKEN) || /\bcondition met\b/i.test(result))) {
      patch.status = 'done';
    } else {
      patch.nextRunAt = now + Math.max(60_000, task.intervalMs ?? DEFAULT_BG_INTERVAL);
    }
  }
  return patch;
}

/**
 * A task that was firing when the process stopped had its next run cleared at
 * the start of the fire and never got one back, so it would never fire again.
 * At startup every active task without a next run is due now.
 */
export function reconcileTasks(now = Date.now()): void {
  const tasks = load();
  let changed = false;
  for (const t of tasks) {
    if (t.status === 'active' && t.nextRunAt == null) {
      t.nextRunAt = now;
      changed = true;
    }
  }
  if (changed) save(tasks);
}

/** Drive one task through a chat turn, then re-arm (or finish) it. */
async function fireTask(id: string): Promise<void> {
  if (inFlight.has(id)) return;
  const tasks = load();
  const task = tasks.find((x) => x.id === id);
  if (!task || task.status !== 'active') return;

  const settings = getSettings();
  const providerId = task.providerId ?? settings.defaultProviderId;
  const modelId = task.modelId ?? settings.defaultModelId;
  if (!providerId || !modelId) {
    persistTask(id, { status: 'error', lastResult: 'No model configured, set a default provider/model in Models.' });
    return;
  }

  inFlight.add(id);
  // Reuse the task's session across fires so background agents keep context.
  let sid = task.lastSessionId;
  if (!sid || !getSession(sid)) {
    const s = createSession(task.workspaceId);
    s.title = task.title;
    s.taskId = task.id;
    s.providerId = providerId;
    s.modelId = modelId;
    saveSession(s);
    sid = s.id;
  }

  const prompt = taskPrompt(task);

  persistTask(id, { status: 'active', lastRunAt: Date.now(), runCount: task.runCount + 1, lastSessionId: sid, nextRunAt: undefined });

  try {
    await sendChat({ sessionId: sid, providerId, modelId, text: prompt }, (e) => taskSender?.(e));
    const done = getSession(sid);
    const last = [...(done?.messages ?? [])].reverse().find((m) => m.role === 'assistant' && m.content.trim());
    persistTask(id, taskRunPatch(task, last?.content ?? '', Date.now()));
  } catch (e) {
    persistTask(id, { status: 'error', lastResult: `Run failed: ${(e as Error).message}` });
  } finally {
    inFlight.delete(id);
  }
}

/** Apply a patch to a task by id and persist (re-reads to avoid clobbering). */
function persistTask(id: string, patch: Partial<AutomationTask>): void {
  const tasks = load();
  const t = tasks.find((x) => x.id === id);
  if (!t) return;
  Object.assign(t, patch);
  save(tasks);
}

/** Start the periodic scheduler (idempotent). */
export function startTaskScheduler(): void {
  if (timer) return;
  reconcileTasks();
  timer = setInterval(() => {
    const now = Date.now();
    for (const t of load()) {
      if (t.status !== 'active' || inFlight.has(t.id)) continue;
      const due = t.nextRunAt != null ? t.nextRunAt <= now : false;
      if (due) void fireTask(t.id);
    }
  }, TICK_MS);
  // Don't keep the process alive just for the scheduler (Node).
  (timer as unknown as { unref?: () => void }).unref?.();
}
