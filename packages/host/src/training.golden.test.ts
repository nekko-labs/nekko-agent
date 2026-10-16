import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, expect, it, vi } from 'vitest';
import type { TrainingRun } from '@nekko-agent/shared';
import { RUN_DONE_TOKEN } from '@nekko-agent/shared';

/**
 * What the training and goal-run engine does, which the engine daemon's port
 * (crates/nekko-automation `training`) must reproduce exactly: `training.json`,
 * the replies, the change notices, the chats made and the turns sent across a
 * run of operations (create, update, delete, start, pause, stop, hints, the
 * run's tools, the re-armed turns, the safety guards, a restart), plus the
 * per-turn prompts and the progress and output fingerprints.
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
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

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

/** A run as a test fixture: the fields every run has, plus `extra`. */
function fixture(extra: Partial<TrainingRun>): TrainingRun {
  return {
    id: 'r_fix', kind: 'training', name: 'Fixture', goal: 'Predict churn', status: 'running', config: {},
    experiments: [], hints: [], log: [], createdAt: 1, updatedAt: 1, turns: 0, ...extra,
  } as TrainingRun;
}

const exp = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ id, title: `T ${id}`, status, createdAt: 1, updatedAt: 1, ...extra });

it('runs training and goal runs and keeps training.json as the TS engine does', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nekko-training-golden-'));
  try {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(NOW);
    let ids = 0;
    vi.doMock('crypto', async (orig) => ({
      ...(await orig<typeof import('crypto')>()),
      randomUUID: () => uuid(++ids),
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
    const training = await import('./training.js');
    const notices: unknown[] = [];
    training.setTrainingNotifier((runs) => notices.push(JSON.parse(JSON.stringify(runs))));
    const file = join(dir, 'training.json');
    const read = () => {
      try {
        return readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    };

    // A chat the file scenarios below drive, with a model chosen.
    const chat = (id: string) => {
      sessions.set(id, { id, providerId: 'p1', modelId: 'm1', messages: [] });
    };
    const fileRun = (extra: Record<string, unknown>) => ({
      id: 'f1', kind: 'goal', name: 'From file', goal: 'Keep going', status: 'running', config: {}, sessionId: 's_file',
      experiments: [], hints: [], log: [], createdAt: 5, updatedAt: 6, startedAt: NOW - 1000, turns: 3, ...extra,
    });
    const longLog = Array.from({ length: 400 }, (_, i) => ({ at: i, kind: 'info', text: `entry ${i}` }));

    type Op = { op: string; args?: unknown[]; at?: number; replies?: Array<{ reply?: string; error?: string }>; settings?: typeof settings; file?: string; chats?: string[] };
    const R1 = uuid(1);
    const R2 = uuid(2);
    const R3 = uuid(3);
    const ops: Op[] = [
      { op: 'list' },
      {
        op: 'create', args: [{
          kind: 'training', name: '  Ticket urgency  ', goal: 'Classify support tickets by urgency', workspaceId: 'w1', providerId: 'p1', modelId: 'm1',
          config: {
            dataset: { source: 'huggingface', id: 'org/tickets', split: 'train' }, baseModel: { source: 'huggingface', id: 'distilbert-base-uncased' },
            metric: 'f1', framework: 'transformers', epochs: 3, batchSize: 16, learningRate: 0.00002, maxExperiments: 12, timeBudgetMin: 90,
            extra: 'Prefer small models.', harness: { agentsMd: true, skill: false, spec: true },
          },
        }],
      },
      { op: 'create', args: [{ kind: 'goal', goal: 'Ship the CSV importer with tests and docs, end to end, for every format 🐱', approachId: 'automl-sweep', config: { extra: 'No new dependencies.' } }], at: NOW + 1000 },
      { op: 'create', args: [{ kind: 'goal', goal: '' }], at: NOW + 2000, settings: {} },
      { op: 'create', args: [{ kind: 'training', name: '   ', goal: '' }], at: NOW + 3000, settings: { defaultProviderId: 'p-default', defaultModelId: 'm-default' } },
      { op: 'list' },
      // The first turn of a training run: the full brief.
      { op: 'start', args: [R1], at: NOW + 10_000, replies: [{ reply: 'Profiled the data.' }] },
      { op: 'experiment', args: ['s_1', { id: 'exp_a', title: 'Baseline LR', status: 'running', approach: '  linear  ', metric: 'f1' }], at: NOW + 11_000 },
      { op: 'experiment', args: ['s_1', { id: 'exp_a', status: 'succeeded', score: 0.71 }], at: NOW + 12_000 },
      { op: 'experiment', args: ['s_1', { title: 'Random forest', status: 'succeeded', score: 0.65, parent_id: 'exp_a', approach: 'trees' }], at: NOW + 13_000 },
      { op: 'experiment', args: ['s_1', { id: '  exp_b  ', title: 'Boosting', status: 'failed', note: '  Out of memory on the GPU  ', parent_id: ' exp_a ' }], at: NOW + 14_000 },
      { op: 'experiment', args: ['s_1', { id: 'exp_b', status: 'repaired', score: 0.8, metric: 'f1 macro' }], at: NOW + 15_000 },
      { op: 'experiment', args: ['s_1', { id: 'exp_c', status: 'bogus' }] },
      { op: 'experiment', args: ['s_1', { id: 'exp_c', status: 'planned', title: 'x'.repeat(130), parent_id: 'exp_c', note: 'n'.repeat(310) }], at: NOW + 16_000 },
      { op: 'experiment', args: ['s_1', { id: 'exp_d', title: 'Strings', score: '0.9' }], at: NOW + 17_000 },
      { op: 'experiment', args: ['s_1', { id: 'exp_e', title: 'Worse', status: 'succeeded', score: 0.1 + 0.2 }], at: NOW + 18_000 },
      { op: 'experiment', args: ['s_1', { id: 'exp_f', status: 'failed' }], at: NOW + 18_500 },
      { op: 'experiment', args: ['s_none', { id: 'x' }] },
      { op: 'artifact', args: ['s_1', { path: '  nekko-training/ticket-urgency/model.pkl  ', kind: 'model', note: '  Pickled sklearn model  ' }], at: NOW + 19_000 },
      { op: 'artifact', args: ['s_1', { path: 'nekko-training\\ticket-urgency\\AGENTS.md', kind: 'agents-md' }], at: NOW + 20_000 },
      { op: 'artifact', args: ['s_1', { path: 'nekko-training/ticket-urgency/model.pkl', title: '  Trained model  ', kind: 'weird' }], at: NOW + 21_000 },
      { op: 'artifact', args: ['s_1', { path: 'reports/', kind: 'report', note: '   ' }], at: NOW + 22_000 },
      { op: 'artifact', args: ['s_1', { path: '   ' }] },
      { op: 'artifact', args: ['s_none', { path: 'a' }] },
      { op: 'hint', args: [R1, '  Try gradient boosting with early stopping  '], at: NOW + 23_000 },
      { op: 'hint', args: [R1, '   '], at: NOW + 23_500 },
      { op: 'hint', args: [R1, 'h'.repeat(130)], at: NOW + 24_000 },
      // The re-armed turn: the continuation brief with the tree and the hints.
      { op: 'advance', at: NOW + 30_000, replies: [{ reply: 'Tried boosting.' }] },
      { op: 'pause', args: [R1], at: NOW + 31_000 },
      { op: 'pause', args: [R1], at: NOW + 32_000 },
      // Its pending turn finds the run paused and does nothing.
      { op: 'advance', at: NOW + 40_000 },
      { op: 'start', args: [R1], at: NOW + 50_000, replies: [{ reply: `Model trained and registered.   ${RUN_DONE_TOKEN} trailing` }] },
      // Goal runs: the plan.
      { op: 'plan', args: ['s_2', { steps: [] }], at: NOW + 60_000 },
      { op: 'plan', args: ['s_2', { replace: true, steps: [{ title: 'Read the importer' }, { title: 'Write the parser', status: 'active' }, { title: 'Add tests', note: 'Unit and golden' }] }], at: NOW + 61_000 },
      { op: 'plan', args: ['s_2', { steps: [{ id: 'step_1', status: 'done', note: 'Read it all' }, { title: 'write the parser', status: 'skipped', note: 'Not needed' }, { title: 'Write docs' }] }], at: NOW + 62_000 },
      { op: 'plan', args: ['s_2', { steps: [null] }], at: NOW + 63_000 },
      { op: 'plan', args: ['s_none', { steps: [{ title: 'x' }] }] },
      { op: 'planFor', args: ['s_2'] },
      { op: 'planFor', args: ['s_none'] },
      { op: 'start', args: [R2], at: NOW + 70_000, replies: [{ reply: 'Started on step 3.' }] },
      { op: 'plan', args: ['s_2', { replace: true, steps: [{ title: 'Ship it', status: 'active' }] }], at: NOW + 71_000 },
      { op: 'experiment', args: ['s_2', { title: 'Parser speed', status: 'succeeded', score: 12, metric: 'ms' }], at: NOW + 72_000 },
      { op: 'advance', at: NOW + 80_000, replies: [{ error: 'provider offline' }] },
      { op: 'advance', at: NOW + 90_000, replies: [{ reply: 'Same answer' }] },
      { op: 'advance', at: NOW + 100_000, replies: [{ reply: '  Same\n\nanswer ' }] },
      { op: 'stop', args: [R2], at: NOW + 101_000 },
      { op: 'stop', args: [R2], at: NOW + 102_000 },
      { op: 'advance', at: NOW + 110_000 },
      // The run whose chat has no model: it fails at once.
      { op: 'start', args: [R3], at: NOW + 120_000, settings: {} },
      { op: 'update', args: [R1, { name: 'Renamed', status: 'running', turns: 99, config: { metric: 'acc' }, approachId: null, goal: 'New goal' }], at: NOW + 130_000, settings: { defaultProviderId: 'p-default', defaultModelId: 'm-default' } },
      { op: 'update', args: ['missing', { name: 'x' }] },
      { op: 'start', args: ['missing'] },
      { op: 'delete', args: [R3], at: NOW + 140_000 },
      { op: 'delete', args: [R1], at: NOW + 141_000 },
      { op: 'delete', args: ['missing'], at: NOW + 142_000 },
      { op: 'list' },
      // Runs read back from disk, and a restart with runs mid-flight.
      { op: 'file', file: JSON.stringify([fileRun({ stallTurns: 7, lastProgressKey: '0/0||0|', lastOutputSig: '11:Same answer' })]), chats: ['s_file'] },
      { op: 'resume', at: NOW + 200_000, replies: [{ reply: 'Same answer' }] },
      { op: 'file', file: JSON.stringify([fileRun({ errorTurns: 4 }), fileRun({ id: 'f2', sessionId: 's_file2', createdAt: 7, kind: 'training', turns: 0 })]), chats: ['s_file', 's_file2'] },
      { op: 'resume', at: NOW + 210_000, replies: [{ error: 'still offline' }, { reply: 'First turn.' }] },
      { op: 'advance', at: NOW + 214_000, replies: [{ reply: `All done ${RUN_DONE_TOKEN}` }] },
      { op: 'file', file: JSON.stringify([fileRun({ config: { timeBudgetMin: 1 }, runtimeMs: 59_500, startedAt: NOW + 219_000 })]) },
      { op: 'resume', at: NOW + 220_000 },
      { op: 'file', file: JSON.stringify([fileRun({ turns: 400, startedAt: undefined, status: 'running' })]) },
      { op: 'resume', at: NOW + 230_000 },
      { op: 'start', args: ['f1'], at: NOW + 231_000, replies: [{ reply: 'Back at it.' }] },
      { op: 'pause', args: ['f1'], at: NOW + 232_000 },
      { op: 'file', file: JSON.stringify([fileRun({ config: { maxTurns: 2 }, turns: 2, status: 'stopped', endedAt: 9, runtimeMs: 100 })]) },
      { op: 'start', args: ['f1'], at: NOW + 240_000, replies: [{ reply: 'Fresh leg.' }] },
      { op: 'stop', args: ['f1'], at: NOW + 241_000 },
      { op: 'file', file: JSON.stringify([fileRun({ sessionId: 's_gone' })]) },
      { op: 'resume', at: NOW + 250_000 },
      { op: 'file', file: JSON.stringify([fileRun({ status: 'paused', log: longLog })]) },
      { op: 'hint', args: ['f1', 'Look at the logs'], at: NOW + 260_000 },
      { op: 'file', file: 'not json' },
      { op: 'list' },
      { op: 'create', args: [{ kind: 'training', name: 'After corruption', goal: 'g' }], at: NOW + 270_000 },
    ];

    const out = [];
    for (const step of ops) {
      if (step.at) vi.setSystemTime(step.at - (step.op === 'advance' ? 4_000 : 0));
      if (step.settings) {
        delete settings.defaultProviderId;
        delete settings.defaultModelId;
        Object.assign(settings, step.settings);
      }
      for (const id of step.chats ?? []) chat(id);
      replies.length = 0;
      replies.push(...(step.replies ?? []));
      const [n, s, t] = [notices.length, sessionLog.length, turns.length];
      const args = step.args ?? [];
      let result: unknown = null;
      const tool = (f: () => unknown) => {
        try {
          return f();
        } catch (e) {
          return { error: (e as Error).message };
        }
      };
      switch (step.op) {
        case 'list': result = training.listTrainingRuns(); break;
        case 'create': result = training.createTrainingRun(args[0] as never); break;
        case 'update': result = training.updateTrainingRun(args[0] as string, args[1] as Partial<TrainingRun>); break;
        case 'delete': result = training.deleteTrainingRun(args[0] as string); break;
        case 'start': result = training.startTrainingRun(args[0] as string); break;
        case 'pause': result = training.pauseTrainingRun(args[0] as string); break;
        case 'stop': result = training.stopTrainingRun(args[0] as string); break;
        case 'hint': result = training.addTrainingHint(args[0] as string, args[1] as string); break;
        case 'experiment': result = tool(() => training.reportExperiment(args[0] as string, args[1] as Record<string, unknown>)); break;
        case 'artifact': result = tool(() => training.reportArtifact(args[0] as string, args[1] as Record<string, unknown>)); break;
        case 'plan': result = tool(() => training.updateRunPlan(args[0] as string, args[1] as Record<string, unknown>)); break;
        case 'planFor': result = training.runPlanForSession(args[0] as string) ?? null; break;
        case 'advance': vi.advanceTimersByTime(4_000); break;
        case 'resume': training.startTrainingScheduler(); break;
        case 'file': writeFileSync(file, step.file!); break;
      }
      await settle();
      await settle();
      out.push({
        op: step.op,
        args,
        now: Date.now(),
        settings: { ...settings },
        replies: step.replies ?? [],
        chats: step.chats ?? [],
        result,
        file: read(),
        notices: notices.slice(n),
        sessions: sessionLog.slice(s),
        turns: turns.slice(t),
        timers: vi.getTimerCount(),
      });
    }

    // The per-turn brief over every branch.
    const many = Array.from({ length: 45 }, (_, i) => exp(`e${i}`, i % 3 === 0 ? 'failed' : 'succeeded', { score: i / 10 }));
    const prompts = [
      [fixture({}), []],
      [fixture({ config: { dataset: { source: 'kaggle', id: 'c/titanic' }, baseModel: { source: 'none' }, framework: 'auto', minimizeMetric: true, metric: 'rmse', harness: { skill: true } } }), ['Use the GPU']],
      [fixture({ config: { dataset: { source: 'local', id: './data.csv', split: '' }, baseModel: { source: 'local' }, epochs: 0, maxExperiments: 5 } }), []],
      [fixture({ config: { dataset: { source: 'url', id: 'https://x.test/d.csv' }, timeBudgetMin: 15, extra: 'Notes 🐱' } }), ['a', 'b\nc']],
      [fixture({ kind: 'goal', name: 'Big goal!', config: { timeBudgetMin: 20, extra: 'Keep it small' } }), []],
      [fixture({ kind: 'goal', name: '***' }), ['steer']],
      [fixture({ kind: 'goal', turns: 2, config: { extra: 'c' } }), []],
      [fixture({ kind: 'goal', turns: 5, plan: [{ id: 'step_1', title: 'A', status: 'done', note: 'ok', createdAt: 1, updatedAt: 1 }, { id: 'step_2', title: 'B', status: 'skipped', createdAt: 1, updatedAt: 1 }, { id: 'step_3', title: 'C', status: 'active', createdAt: 1, updatedAt: 1 }], experiments: [exp('e1', 'succeeded', { score: 3 }), exp('e2', 'running', { parentId: 'e1', note: 'note here' })], bestExperimentId: 'e1' } as never), ['h']],
      [fixture({ turns: 1, experiments: many as never, bestExperimentId: 'e44' }), []],
      [fixture({ turns: 3, config: { extra: 'x', minimizeMetric: true }, experiments: [exp('e1', 'succeeded', { score: 2 }), exp('e2', 'repaired', { score: 1 }), exp('e3', 'failed')] as never }), []],
      [fixture({ turns: 3 }), []],
      [fixture({ kind: 'other' as never, turns: 0 }), []],
      [fixture({ kind: 'other' as never, turns: 4 }), []],
      [fixture({ turns: undefined }), []],
    ].map(([run, hints]) => ({ run, hints, prompt: training.turnPrompt(run as TrainingRun, hints as string[]) }));
    const progress = [
      fixture({}),
      fixture({ plan: [{ id: 'a', title: 'A', status: 'done', createdAt: 1, updatedAt: 1 }, { id: 'b', title: 'B', status: 'skipped', createdAt: 1, updatedAt: 1 }, { id: 'c', title: 'C', status: 'pending', createdAt: 1, updatedAt: 1 }] }),
      fixture({ experiments: [exp('e1', 'running'), exp('e2', 'succeeded', { score: 0.5 }), exp('e3', 'failed', { score: null })] as never }),
    ].map((run) => ({ run, signature: training.progressSignature(run) }));
    const outputs = ['', 'Same answer', `  a\n\tb  ${RUN_DONE_TOKEN} ${RUN_DONE_TOKEN}`, 'é🐱 '.repeat(100)].map((text) => ({ text, signature: training.outputSignature(text) }));
    check(join(crate, 'tests', 'golden', 'training.json'), { start: NOW, ops: out, prompts, progress, outputs });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
