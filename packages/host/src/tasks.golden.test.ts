import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AutomationTask } from '@nekko-agent/shared';
import { TASK_DONE_TOKEN } from '@nekko-agent/shared';

/**
 * What the automation-task service does, which the engine daemon's port
 * (crates/nekko-automation `tasks`) must reproduce exactly: the prompt a task
 * fires with, the patch a finished fire writes, and `tasks.json`, the replies,
 * the change notices, the chats made and the turns sent across a run of
 * operations (create, update, delete, run now, a scheduler tick, startup).
 * Fails if the file is stale; rewrite it with UPDATE_GOLDEN=1.
 */
const crate = join(__dirname, '..', '..', '..', 'crates', 'nekko-automation');

function check(path: string, actual: unknown): void {
  if (process.env.UPDATE_GOLDEN) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `${JSON.stringify(actual, null, 1)}\n`);
  }
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(JSON.parse(JSON.stringify(actual)));
}

const NOW = 1_760_000_000_000;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('./sessions.js');
  vi.doUnmock('./store.js');
  vi.doUnmock('./chat.js');
  vi.doUnmock('crypto');
});

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
};

it('fires, finishes and keeps tasks.json as the TS service does', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nekko-tasks-golden-'));
  try {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
    let uuid = 0;
    vi.doMock('crypto', async (orig) => ({
      ...(await orig<typeof import('crypto')>()),
      randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`,
    }));
    const settings: { defaultProviderId?: string; defaultModelId?: string } = { defaultProviderId: 'p-default', defaultModelId: 'm-default' };
    const sessions = new Map<string, { id: string; messages: Array<{ role: string; content: string }>; [k: string]: unknown }>();
    const sessionLog: unknown[] = [];
    let sessionN = 0;
    vi.doMock('./sessions.js', () => ({
      createSession: (workspaceId?: string) => {
        const s = { id: `s_${++sessionN}`, title: 'New chat', workspaceId, messages: [] as Array<{ role: string; content: string }> };
        sessionLog.push({ create: workspaceId ?? null, id: s.id });
        return s;
      },
      saveSession: (s: { id: string; messages: [] }) => {
        const { messages: _m, workspaceId: _w, id, title, ...rest } = s as unknown as Record<string, unknown>;
        sessionLog.push({ save: id, title, fields: rest });
        sessions.set(s.id, s as never);
      },
      getSession: (id: string) => sessions.get(id) ?? null,
      deleteSession: (id: string) => {
        sessionLog.push({ delete: id });
        sessions.delete(id);
      },
    }));
    vi.doMock('./store.js', async (orig) => ({ ...(await orig<typeof import('./store.js')>()), getSettings: () => settings }));
    // A turn: what the scripted model answers, or why it failed.
    const replies: Array<{ reply?: string; error?: string }> = [];
    const turns: unknown[] = [];
    vi.doMock('./chat.js', () => ({
      sendChat: async (opts: { sessionId: string; text: string }) => {
        turns.push(opts);
        const next = replies.shift() ?? { reply: '' };
        if (next.error) throw new Error(next.error);
        sessions.get(opts.sessionId)?.messages.push({ role: 'user', content: opts.text }, { role: 'assistant', content: next.reply ?? '' });
      },
    }));
    const { setDataDir } = await import('./paths.js');
    setDataDir(dir);
    const tasks = await import('./tasks.js');
    const notices: unknown[] = [];
    tasks.setTasksNotifier((list) => notices.push(JSON.parse(JSON.stringify(list))));
    const file = join(dir, 'tasks.json');
    const read = () => {
      try {
        return readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    };

    type Op = { op: string; args?: unknown[]; at?: number; replies?: Array<{ reply?: string; error?: string }>; settings?: typeof settings; file?: string; deleteSession?: string };
    const ops: Op[] = [
      { op: 'list' },
      { op: 'start' },
      { op: 'create', args: [{ title: '  Nightly report  ', kind: 'recurring', prompt: 'Summarize the day', workspaceId: 'w1', intervalMs: 3_600_000 }] },
      { op: 'create', args: [{ title: '   ', kind: 'scheduled', prompt: 'Ping', runAt: NOW + 120_000, providerId: 'p1', modelId: 'm1' }], at: NOW + 1000 },
      { op: 'create', args: [{ title: 'Watch CI', kind: 'background', prompt: 'Check CI', keepAlive: 'until', condition: 'all green', intervalMs: 30_000 }], at: NOW + 2000 },
      { op: 'create', args: [{ title: 'Forever', kind: 'background', prompt: 'Tend', keepAlive: 'forever' }], at: NOW + 3000 },
      { op: 'list' },
      { op: 'run', args: ['00000000-0000-4000-8000-000000000001'], replies: [{ reply: 'Report: all fine 🐱' }], at: NOW + 10_000 },
      { op: 'run', args: ['00000000-0000-4000-8000-000000000003'], replies: [{ reply: 'Still red.' }], at: NOW + 20_000 },
      { op: 'run', args: ['00000000-0000-4000-8000-000000000003'], replies: [{ reply: `Fixed it. ${TASK_DONE_TOKEN}` }], at: NOW + 30_000 },
      { op: 'run', args: ['00000000-0000-4000-8000-000000000003'], replies: [{ reply: 'never sent' }], at: NOW + 31_000 },
      { op: 'run', args: ['00000000-0000-4000-8000-000000000004'], replies: [{ error: 'provider offline' }], at: NOW + 40_000 },
      { op: 'update', args: ['00000000-0000-4000-8000-000000000004', { status: 'active' }], at: NOW + 41_000 },
      { op: 'update', args: ['00000000-0000-4000-8000-000000000004', { status: 'paused', title: 'Renamed', extra: { x: 1 } }], at: NOW + 42_000 },
      { op: 'update', args: ['00000000-0000-4000-8000-000000000004', { status: 'active' }], at: NOW + 43_000 },
      { op: 'update', args: ['missing', { status: 'active' }] },
      // The scheduled task's own chat was deleted: a fire makes a new one.
      { op: 'run', args: ['00000000-0000-4000-8000-000000000002'], replies: [{ reply: 'x'.repeat(450) }], at: NOW + 130_000, deleteSession: 's_2' },
      { op: 'run', args: ['00000000-0000-4000-8000-000000000002'], replies: [{ reply: 'not again' }], at: NOW + 131_000 },
      // No model anywhere: the task errors without a turn.
      { op: 'create', args: [{ title: 'No model', kind: 'recurring', prompt: 'p', intervalMs: 10 }], at: NOW + 140_000, settings: {} },
      { op: 'run', args: ['00000000-0000-4000-8000-000000000005'], at: NOW + 141_000, settings: {} },
      { op: 'update', args: ['00000000-0000-4000-8000-000000000005', { status: 'active', nextRunAt: NOW + 1 }], at: NOW + 142_000, settings: { defaultProviderId: 'p-default', defaultModelId: 'm-default' } },
      // A scheduler tick fires what is due (the recurring one is not yet).
      { op: 'tick', replies: [{ reply: 'Condition met, stopping.' }, { reply: 'ok' }], at: NOW + 3_700_000 },
      { op: 'delete', args: ['00000000-0000-4000-8000-000000000005'] },
      { op: 'create', args: [{ title: 'Orphan', kind: 'scheduled', prompt: 'p', runAt: NOW }], at: NOW + 3_800_000 },
      { op: 'delete', args: ['00000000-0000-4000-8000-000000000006'] },
      { op: 'delete', args: ['missing'] },
      { op: 'list' },
      // A fire cut short by a restart left an active task with no next run.
      { op: 'file', file: '[{"id":"t1","title":"Cut short","kind":"recurring","prompt":"p","status":"active","createdAt":5,"runCount":2,"lastRunAt":9,"lastSessionId":"gone"},{"id":"t2","title":"Paused","kind":"recurring","prompt":"p","status":"paused","createdAt":6,"runCount":0}]' },
      { op: 'reconcile', at: NOW + 4_000_000 },
      { op: 'file', file: 'not json' },
      { op: 'list' },
      { op: 'create', args: [{ title: 'After corruption', kind: 'recurring', prompt: 'p', intervalMs: 60_000 }], at: NOW + 5_000_000 },
    ];

    const out = [];
    for (const step of ops) {
      if (step.at) vi.setSystemTime(step.at);
      if (step.settings) {
        delete settings.defaultProviderId;
        delete settings.defaultModelId;
        Object.assign(settings, step.settings);
      }
      if (step.deleteSession) sessions.delete(step.deleteSession);
      replies.length = 0;
      replies.push(...(step.replies ?? []));
      const [n, s, t] = [notices.length, sessionLog.length, turns.length];
      const args = step.args ?? [];
      let result: unknown = null;
      switch (step.op) {
        case 'list': result = tasks.listTasks(); break;
        case 'create': result = tasks.createTask(args[0] as never); break;
        case 'update': result = tasks.updateTask(args[0] as string, args[1] as Partial<AutomationTask>); break;
        case 'delete': result = tasks.deleteTask(args[0] as string); break;
        case 'run': tasks.runTaskNow(args[0] as string); await settle(); break;
        case 'tick':
          // The interval fires at step.at.
          vi.setSystemTime(step.at! - 15_000);
          vi.advanceTimersByTime(15_000);
          await settle();
          await settle();
          break;
        case 'start':
          tasks.startTaskScheduler();
          break;
        case 'reconcile':
          tasks.reconcileTasks();
          break;
        case 'file': writeFileSync(file, step.file!); break;
      }
      out.push({
        op: step.op,
        args,
        now: Date.now(),
        settings: { ...settings },
        replies: step.replies ?? [],
        deleteSession: step.deleteSession ?? null,
        result,
        file: read(),
        notices: notices.slice(n),
        sessions: sessionLog.slice(s),
        turns: turns.slice(t),
      });
    }

    const prompts = [
      { kind: 'recurring', prompt: 'a' },
      { kind: 'background', prompt: 'b', keepAlive: 'forever', condition: 'x' },
      { kind: 'background', prompt: 'c', keepAlive: 'until', condition: '' },
      { kind: 'background', prompt: 'd 🐱', keepAlive: 'until', condition: 'tests pass\nand "lint"' },
    ].map((task) => ({ task, prompt: tasks.taskPrompt(task as AutomationTask) }));
    const patches = [];
    const results = ['', 'done', `x ${TASK_DONE_TOKEN}`, 'The CONDITION MET now', 'conditions met', 'precondition met', 'é'.repeat(500)];
    const shapes = [
      { kind: 'scheduled' },
      { kind: 'recurring' },
      { kind: 'recurring', intervalMs: 1000 },
      { kind: 'recurring', intervalMs: 120_000 },
      { kind: 'recurring', intervalMs: null },
      { kind: 'background', keepAlive: 'forever' },
      { kind: 'background', keepAlive: 'until', intervalMs: 90_000 },
    ];
    for (const shape of shapes) {
      for (const result of results) {
        patches.push({ task: shape, result, now: NOW, patch: tasks.taskRunPatch(shape as AutomationTask, result, NOW) });
      }
    }
    check(join(crate, 'tests', 'golden', 'tasks.json'), { start: NOW, ops: out, prompts, patches });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
