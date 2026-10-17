import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, sep } from 'path';
import { expect, it } from 'vitest';
import { createDecisions, DECISION_CATALOG, DECISION_RELEASE_URL } from './decisions.js';
import type { EngineDaemon } from './daemon.js';
import type { DownloadRequest } from './download.js';

/** Where the scripts download from (a release URL the daemon test also serves). */
const RELEASE = 'http://release.test/download/decision-models-v1';

/**
 * The decision-model service (`decisions:*`) as the TS host runs it, which the
 * engine daemon's port (crates/nekkod/src/decisions.rs) must reproduce: the
 * same answers, messages and daemon calls for the same script over the same
 * files. Writes crates/nekkod/tests/golden/decisions.json (the catalog, the
 * file tree, the scripts and what each step returned); fails if it is stale
 * (rewrite with UPDATE_GOLDEN=1).
 *
 * The local model is a scripted stand-in for the daemon's decide service, and
 * TypeSafe a scripted fetch, so both sides replay the same conversation.
 */
const golden = join(__dirname, '..', '..', '..', '..', 'crates', 'nekkod', 'tests', 'golden', 'decisions.json');

/** Files to create, relative to the scratch root (`models/` is the models dir). */
const TREE: Record<string, string> = {
  'models/decision/laya-en/model_fp16.onnx': 'fp16 graph',
  'models/decision/laya-en/model_int8.onnx': 'int8',
  'models/decision/laya-en/tokenizer.json': '{}',
  'models/decision/laya-en/rl_agent_config.json': '{"a":1}',
  'models/decision/custom/laya.onnx': 'fp32 weights here',
  'models/decision/custom/tokenizer.json': '{}',
  'models/decision/custom/rl_agent_config.json': '{}',
  'models/decision/noweights/tokenizer.json': '{}',
  'models/decision/noweights/rl_agent_config.json': '{}',
  'models/decision/partial/model_fp16.onnx': 'x',
  'models/decision/partial/rl_agent_config.json': '{}',
  'models/decision/stray.txt': 'not a dir',
  // A typed-decisions download cut short: one file at its published size (kept), one not (fetched again).
  'models/decision/laya-typed-decisions/rl_agent_config.json': 'x'.repeat(847),
  'models/decision/laya-typed-decisions/config.json': '{}',
  'ext1/model.fp16.onnx': 'graph16',
  'ext1/model_int8.onnx': 'g8',
  'ext1/tokenizer/tokenizer.json': '{"nested":true}',
  'ext1/rl_agent_config.json': '{}',
  'ext2/model.onnx': 'graph',
  'ext2/tokenizer.json': '{}',
  'ext3/model.onnx': 'graph',
  'ext3/model.onnx.data': 'external weights',
  'ext3/tokenizer.json': '{}',
  'ext3/rl_agent_config.json': '{}',
  'bad/model.onnx': 'graph',
  'bad/tokenizer.json': '{}',
  'bad/rl_agent_config.json': '{}',
};

const REQUEST = { state: 'I was charged twice.', questions: { dept: { type: 'choice', instructions: 'Which team?', criteria: ['billing', 'technical'] } } };

type Step = [op: string, ...args: unknown[]];

/** `<root>` in a string argument is the scratch root, and its slashes the platform's separator. */
const SCRIPTS: { name: string; typesafeKey: string | null; typesafe: { status: number; body: string }[]; steps: Step[] }[] = [
  {
    name: 'local',
    typesafeKey: null,
    typesafe: [],
    steps: [
      ['catalog'],
      ['models'],
      ['download', 'laya-en', 'fp16'],
      ['download', 'laya-en', 'int8'],
      ['download', 'laya-en', 'fp8'],
      ['download', 'nope'],
      ['download', 'laya-multilingual'],
      ['download', 'laya-multilingual', 'int8'],
      ['download', 'laya-typed-decisions', 'fp32'],
      ['addFolder', ''],
      ['addFolder', '   '],
      ['addFolder', '<root>/ext2'],
      ['addFolder', '<root>/ext1'],
      ['addFolder', '<root>/ext1/'],
      ['addFolder', '<root>/ext2/../ext3'],
      ['addFolder', '<root>/bad'],
      ['models'],
      ['status'],
      ['load', 'nope'],
      ['load', 'laya-en'],
      ['status'],
      ['load', 'folder:<root>/ext1', 'int8'],
      ['load', 'folder:<root>/bad'],
      ['status'],
      ['run', 'local', REQUEST],
      ['run', 'local', { state: '  ', questions: { q: {} } }],
      ['run', 'local', { state: 'x', questions: {} }],
      ['remove', 'folder:<root>/bad'],
      ['remove', 'folder:<root>/ext1'],
      ['status'],
      ['load', 'laya-en', 'int8'],
      ['remove', 'laya-en'],
      ['remove', '../../etc'],
      ['remove', 'decision'],
      ['unload'],
      ['models'],
      ['checkTypesafe'],
      ['run', 'typesafe', REQUEST],
    ],
  },
  {
    name: 'typesafe',
    typesafeKey: 'ts-key-123',
    typesafe: [
      { status: 200, body: '{"data":[{"id":"jev-latest"},{"id":"jev-mini"}]}' },
      { status: 200, body: '{"object":"list","data":[]}' },
      { status: 401, body: '' },
      { status: 500, body: 'oops' },
      { status: 200, body: '{"model":"jev-latest","answers":{"dept":{"type":"choice","choice":"billing"}}}' },
      { status: 400, body: '{"error":{"message":"bad questions"}}' },
      { status: 429, body: '{"error":"slow down"}' },
      { status: 502, body: '<html>bad gateway</html>' },
    ],
    steps: [
      ['status'],
      ['checkTypesafe'],
      ['checkTypesafe'],
      ['checkTypesafe'],
      ['checkTypesafe'],
      ['run', 'typesafe', REQUEST],
      ['run', 'typesafe', { ...REQUEST, model: 'jev-mini' }],
      ['run', 'typesafe', REQUEST],
      ['run', 'typesafe', REQUEST],
    ],
  },
];

/** The daemon's decide service, scripted: a dir named `bad` fails to load. */
function fakeDaemon(calls: unknown[]): EngineDaemon {
  let status: Record<string, unknown> = { loaded: false };
  return {
    decideStatus: async () => { calls.push(['decide:status']); return status; },
    decideLoad: async (req: { dir: string; precision?: string; name?: string }) => {
      calls.push(['decide:load', req]);
      if (req.dir.endsWith('bad')) throw new Error('ONNX Runtime could not load the model');
      status = { loaded: true, model: req.name, dir: req.dir, ep: req.precision === 'int8' ? 'cpu' : 'directml', precision: req.precision, loadMs: req.precision === 'int8' ? 0 : 1234 };
      return status;
    },
    decideUnload: async () => { calls.push(['decide:unload']); status = { loaded: false }; },
    decideRun: async (request: unknown) => { calls.push(['decide:run', request]); return { model: String(status.model), answers: { dept: { type: 'choice', choice: 'billing', probabilities: { billing: 0.9, technical: 0.1 } } } }; },
  } as unknown as EngineDaemon;
}

it('the decision service matches the daemon golden set', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nekko-decisions-golden-'));
  const norm = (v: unknown): unknown => JSON.parse(JSON.stringify(v ?? null).split(JSON.stringify(root).slice(1, -1)).join('<root>').replace(/\\\\/g, '/'));
  const results: unknown[] = [];
  try {
    for (const script of SCRIPTS) {
      rmSync(join(root, 'models'), { recursive: true, force: true });
      for (const [rel, text] of Object.entries(TREE)) {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), text);
      }
      const calls: unknown[] = [];
      const checks: Promise<void>[] = [];
      const requests: unknown[] = [];
      let folders: string[] = [];
      const replies = [...script.typesafe];
      const daemon = fakeDaemon(calls);
      const decisions = createDecisions({
        modelsDir: () => join(root, 'models'),
        releaseUrl: () => RELEASE,
        // The queue is the engine's (its own golden set holds the transfer); here what is
        // asked of it, and what each file's check says about a wrong and a right file.
        downloads: {
          start: (req: DownloadRequest) => {
            const { verify, ...rest } = req;
            const verified: Record<string, unknown> = {};
            calls.push(['downloads.start', { ...rest, verified }]);
            checks.push((async () => {
              const probe = join(root, `probe-${checks.length}.part`);
              writeFileSync(probe, 'x');
              verified.wrongSize = await verify?.(probe);
              // A small file of the right size but other bytes: the checksum must catch it.
              const file = DECISION_CATALOG.flatMap((c) => [...c.variants, ...c.shared]).find((f) => req.url.endsWith(`/${f.asset}`));
              if (file && file.bytes < 4096) {
                writeFileSync(probe, Buffer.alloc(file.bytes));
                verified.wrongBytes = await verify?.(probe);
              }
              rmSync(probe, { force: true });
            })());
            return Promise.resolve(rest);
          },
        } as never,
        daemon: () => daemon,
        typesafeKey: () => script.typesafeKey ?? undefined,
        folders: () => folders,
        saveFolders: (dirs) => { folders = dirs; calls.push(['saveFolders', dirs]); },
        fetch: (async (url: string, init?: RequestInit) => {
          requests.push({ url, method: init?.method ?? 'GET', auth: (init?.headers as Record<string, string>)?.Authorization, body: init?.body ?? null });
          const r = replies.shift() ?? { status: 500, body: 'no reply scripted' };
          return new Response(r.body || null, { status: r.status });
        }) as typeof fetch,
      });
      const steps: unknown[] = [];
      for (const [op, ...rawArgs] of script.steps) {
        const args = rawArgs.map((a) => (typeof a === 'string' && a.includes('<root>') ? a.replace('<root>', root).replace(/\//g, sep) : a));
        let out: unknown;
        try {
          const fn = (decisions as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[op];
          out = { ok: await fn(...args) };
        } catch (e) {
          out = { error: (e as Error).message };
        }
        await Promise.all(checks.splice(0));
        // Latency is the clock's; the shape is what matters.
        const value = (out as { ok?: { latencyMs?: number } }).ok;
        if (value && typeof value === 'object' && 'latencyMs' in value) value.latencyMs = 0;
        steps.push({ op, args: rawArgs, out: norm(out), calls: norm(calls.splice(0)), requests: norm(requests.splice(0)) });
      }
      results.push({ name: script.name, typesafeKey: script.typesafeKey, typesafe: script.typesafe, steps });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const out = { catalog: DECISION_CATALOG, releaseUrl: DECISION_RELEASE_URL, testReleaseUrl: RELEASE, tree: TREE, scripts: results };
  if (process.env.UPDATE_GOLDEN) {
    mkdirSync(dirname(golden), { recursive: true });
    writeFileSync(golden, `${JSON.stringify(out, null, 1)}\n`);
  }
  expect(JSON.parse(readFileSync(golden, 'utf8'))).toEqual(out);
});
