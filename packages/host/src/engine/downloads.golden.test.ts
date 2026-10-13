import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterAll, expect, it, vi } from 'vitest';
import type { CatalogModel, DownloadJob, HardwareFacts, LocalModel } from '@nekko-agent/shared';
import { companionsDir } from './companions.js';
import { createDownloads, type DownloadRequest } from './download.js';
import { buildGguf, str, u32 } from './gguf-fixture.js';
import { readGgufMetadata } from './gguf.js';
import { companionsBeside, imageCompanionSetFor, imageCompanionStatus, imageCompanionsDir } from './image-companions.js';
import {
  companionsPlan,
  downloadedModel,
  finishedModelJobs,
  gpuFirstPreset,
  imageCompanionsPlan,
  modelDownloadPlan,
  sourceRepoFor,
} from './index.js';

/**
 * Model downloads (`engine:downloadModel`, `engine:downloadCompanions`,
 * `engine:imageCompanions`, `engine:downloadImageCompanions`,
 * `engine:downloads`, `engine:cancelDownload`, `engine:dismissDownload`) as
 * the TS host runs them, which the engine daemon's port (crates/nekko-engine
 * `download` and `acquire`) must reproduce as text, key order included: the
 * queue over a scripted server (fresh, resumed, refused, failed, verified,
 * cancelled, dismissed and restarted jobs, with the requests it sent and the
 * files it left), and the plans: what one quantization of a catalog model
 * fetches, which repo a model on disk came from, its missing companion files,
 * an image model's text encoders and VAE, which finished jobs are followed
 * up, and the GPU-first preset a fresh download gets. Paths are recorded
 * below `<root>` with `/` separators. Writes
 * crates/nekko-engine/tests/golden/downloads.json; fails if it is stale
 * (rewrite with UPDATE_GOLDEN=1).
 */
const golden = join(__dirname, '..', '..', '..', '..', 'crates', 'nekko-engine', 'tests', 'golden', 'downloads.json');
const NOW = 1_700_000_000_000;

function norm(root: string, v: unknown): unknown {
  if (typeof v === 'string') return v.split(root).join('<root>').replace(/\\/g, '/');
  if (Array.isArray(v)) return v.map((x) => norm(root, x));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, norm(root, x)]));
  return v;
}

function denorm(root: string, v: unknown): unknown {
  if (typeof v === 'string') return v.split('<root>').join(root);
  if (Array.isArray(v)) return v.map((x) => denorm(root, x));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, denorm(root, x)]));
  return v;
}

const GGUF_HEX = buildGguf([['general.architecture', str('llama')], ['llama.block_count', u32(4)]]).toString('hex');

/* --------------------------------------------------------------- the queue */

type Reply = { status: number; length?: string; chunks?: string[]; hex?: string; error?: string; hang?: boolean } | 'throw';

type Op =
  | { op: 'start'; req: DownloadRequest & { verifyGguf?: boolean } }
  | { op: 'settle'; id: string }
  | { op: 'receiving'; id: string; bytes: number }
  | { op: 'cancel'; id: string }
  | { op: 'dismiss'; id: string }
  | { op: 'list' };

interface QueueCase {
  name: string;
  /** Files on disk before the first op, below `<root>`. */
  pre?: Record<string, string>;
  replies: Record<string, Reply>;
  ops: Op[];
}

const req = (id: string, url: string, dest: string, over: Partial<DownloadRequest> = {}): DownloadRequest => ({
  id, kind: 'model', label: `Label ${id}`, target: 'owner/repo', url, dest: `<root>/${dest}`, ...over,
});

const QUEUE: QueueCase[] = [
  {
    name: 'fresh',
    replies: { 'https://hf.test/a': { status: 200, length: '10', chunks: ['hello', 'world'] } },
    ops: [{ op: 'start', req: req('a', 'https://hf.test/a', 'models/a.bin', { group: 'g', groupLabel: 'G', file: 'a.bin' }) }, { op: 'settle', id: 'a' }, { op: 'list' }],
  },
  {
    name: 'no length and a role',
    replies: { 'https://hf.test/b': { status: 200, chunks: ['abc'] } },
    ops: [{ op: 'start', req: req('b', 'https://hf.test/b', 'models/b.bin', { role: 'vae', group: 'g' }) }, { op: 'settle', id: 'b' }],
  },
  {
    name: 'resumed',
    pre: { 'models/c.bin.part': 'hello' },
    replies: { 'https://hf.test/c': { status: 206, length: '5', chunks: ['world'] } },
    ops: [{ op: 'start', req: req('c', 'https://hf.test/c', 'models/c.bin', { headers: { Authorization: 'Bearer t' } }) }, { op: 'settle', id: 'c' }],
  },
  {
    name: 'range ignored',
    pre: { 'models/d.bin.part': 'junk' },
    replies: { 'https://hf.test/d': { status: 200, length: '7', chunks: ['fresh!!'] } },
    ops: [{ op: 'start', req: req('d', 'https://hf.test/d', 'models/d.bin') }, { op: 'settle', id: 'd' }],
  },
  {
    name: 'forbidden',
    replies: { 'https://hf.test/e': { status: 403, chunks: ['no'] } },
    ops: [{ op: 'start', req: req('e', 'https://hf.test/e', 'models/e.bin') }, { op: 'settle', id: 'e' }],
  },
  {
    name: 'not found',
    replies: { 'https://hf.test/f': { status: 404, chunks: ['no'] } },
    ops: [{ op: 'start', req: req('f', 'https://hf.test/f', 'models/f.bin') }, { op: 'settle', id: 'f' }],
  },
  {
    name: 'network failure',
    replies: { 'https://hf.test/g': 'throw' },
    ops: [{ op: 'start', req: req('g', 'https://hf.test/g', 'models/g.bin') }, { op: 'settle', id: 'g' }],
  },
  {
    name: 'stream error',
    replies: { 'https://hf.test/h': { status: 200, length: '20', chunks: ['part'], error: 'boom' } },
    ops: [{ op: 'start', req: req('h', 'https://hf.test/h', 'models/h.bin') }, { op: 'settle', id: 'h' }],
  },
  {
    name: 'not a gguf',
    replies: { 'https://hf.test/i': { status: 200, length: '8', chunks: ['not gguf'] } },
    ops: [{ op: 'start', req: { ...req('i', 'https://hf.test/i', 'models/i.gguf'), verifyGguf: true } }, { op: 'settle', id: 'i' }],
  },
  {
    name: 'a gguf',
    replies: { 'https://hf.test/j': { status: 200, hex: GGUF_HEX } },
    ops: [{ op: 'start', req: { ...req('j', 'https://hf.test/j', 'models/j.gguf'), verifyGguf: true } }, { op: 'settle', id: 'j' }],
  },
  {
    name: 'cancelled midway',
    replies: { 'https://hf.test/k': { status: 200, length: '100', chunks: ['first'], hang: true } },
    ops: [
      { op: 'start', req: req('k', 'https://hf.test/k', 'models/k.bin') },
      { op: 'receiving', id: 'k', bytes: 5 },
      { op: 'start', req: req('k', 'https://hf.test/k-again', 'models/k.bin') },
      { op: 'cancel', id: 'k' },
      { op: 'settle', id: 'k' },
      { op: 'list' },
    ],
  },
  {
    name: 'dismissed and restarted',
    replies: {
      'https://hf.test/l': { status: 200, chunks: ['one'] },
      'https://hf.test/m': { status: 200, chunks: ['two'] },
      'https://hf.test/l2': { status: 200, chunks: ['three'] },
    },
    ops: [
      { op: 'start', req: req('l', 'https://hf.test/l', 'models/l.bin') },
      { op: 'settle', id: 'l' },
      { op: 'start', req: req('m', 'https://hf.test/m', 'models/m.bin') },
      { op: 'settle', id: 'm' },
      { op: 'start', req: req('l', 'https://hf.test/l2', 'models/l.bin', { label: 'Again' }) },
      { op: 'settle', id: 'l' },
      { op: 'list' },
      { op: 'dismiss', id: 'm' },
      { op: 'dismiss', id: 'nope' },
      { op: 'cancel', id: 'nope' },
      { op: 'list' },
    ],
  },
];

function scriptedFetch(replies: Record<string, Reply>, requests: unknown[]): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    requests.push({ url, headers: init?.headers ?? {} });
    const reply = replies[url];
    if (!reply) return new Response('missing', { status: 404 });
    if (reply === 'throw') throw new TypeError('fetch failed');
    const chunks = reply.hex ? [Buffer.from(reply.hex, 'hex')] : (reply.chunks ?? []).map((c) => Buffer.from(c));
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(new Uint8Array(c));
        if (reply.error) controller.error(new Error(reply.error));
        else if (!reply.hang) controller.close();
        signal?.addEventListener('abort', () => {
          try {
            controller.error(new Error('aborted'));
          } catch {
            /* already closed */
          }
        });
      },
    });
    return new Response(body, { status: reply.status, headers: reply.length ? { 'content-length': reply.length } : {} });
  }) as unknown as typeof fetch;
}

async function waitFor<T>(check: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const v = check();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function runQueue(root: string, c: QueueCase) {
  for (const [rel, text] of Object.entries(c.pre ?? {})) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), text);
  }
  const requests: unknown[] = [];
  const downloads = createDownloads({ fetch: scriptedFetch(c.replies, requests) });
  const outs: string[] = [];
  const find = (id: string) => downloads.list().find((j) => j.id === id);
  for (const op of c.ops) {
    switch (op.op) {
      case 'start': {
        const { verifyGguf, ...rest } = op.req;
        const r = denorm(root, rest) as DownloadRequest;
        const started = await downloads.start({
          ...r,
          verify: verifyGguf ? async (p) => ((await readGgufMetadata(p)) ? null : 'The downloaded file is not a readable GGUF.') : undefined,
        });
        outs.push(JSON.stringify(norm(root, started)));
        break;
      }
      case 'settle':
        outs.push(JSON.stringify(norm(root, await waitFor(() => {
          const j = find(op.id);
          return j && ['done', 'failed', 'cancelled'].includes(j.state) ? j : undefined;
        }))));
        break;
      case 'receiving':
        outs.push(JSON.stringify(norm(root, await waitFor(() => {
          const j = find(op.id);
          return j && j.receivedBytes >= op.bytes ? j : undefined;
        }))));
        break;
      case 'cancel':
        downloads.cancel(op.id);
        outs.push('null');
        break;
      case 'dismiss':
        downloads.dismiss(op.id);
        outs.push('null');
        break;
      case 'list':
        outs.push(JSON.stringify(norm(root, downloads.list())));
        break;
    }
  }
  const files: Record<string, string | null> = {};
  for (const op of c.ops) {
    if (op.op !== 'start') continue;
    const dest = denorm(root, op.req.dest) as string;
    for (const p of [dest, `${dest}.part`]) {
      files[norm(root, p) as string] = existsSync(p) ? (await readFile(p)).toString('hex') : null;
    }
  }
  return { outs, files, requests: norm(root, requests) };
}

/* --------------------------------------------------------------- the plans */

const catalogModel = (over: Partial<CatalogModel>): CatalogModel => ({
  id: 'unsloth/Qwen3-4B-GGUF', name: 'Qwen3 4B', owner: 'unsloth', tags: ['chat', 'tools'], quants: [], ...over,
});

const QUANTS = [
  { label: 'Q4_K_M', file: 'Qwen3-4B-Q4_K_M.gguf', sizeBytes: 2_497_280_000, extraFiles: ['mmproj-F16.gguf', 'nested/tokenizer.json', 'chat_template.jinja'] },
  { label: 'Q8_0', file: 'Q8_0/Qwen3-4B-Q8_0-00001-of-00002.gguf', sizeBytes: 4_280_000_000, extraFiles: ['Q8_0/Qwen3-4B-Q8_0-00002-of-00002.gguf'] },
];

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

it('matches the downloads golden set the engine daemon replays', { timeout: 60_000 }, async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  const root = await mkdtemp(join(tmpdir(), 'nekko-dl-golden-'));
  roots.push(root);
  const models = join(root, 'models');

  const queue = [];
  for (const c of QUEUE) {
    const dir = join(root, 'queue', c.name.replace(/\W+/g, '-'));
    await mkdir(dir, { recursive: true });
    queue.push({ ...c, ...(await runQueue(dir, c)) });
  }

  const LANDED = new Set(['<root>/models/chat/unsloth_Qwen3-4B-GGUF/tokenizer.json']);
  const isLanded = async (p: string) => LANDED.has(norm(root, p) as string);
  const downloadPlans = [];
  for (const [model, id, quant] of [
    [catalogModel({ quants: QUANTS }), 'unsloth/Qwen3-4B-GGUF', 'Q4_K_M'],
    [catalogModel({ quants: QUANTS }), 'unsloth/Qwen3-4B-GGUF', 'Q8_0'],
    [catalogModel({ quants: QUANTS }), 'unsloth/Qwen3-4B-GGUF', 'Q2_K'],
    [catalogModel({ quants: [] }), 'unsloth/Qwen3-4B-GGUF', 'Q4_K_M'],
    [null, 'gone/Model-GGUF', 'Q4_K_M'],
    [catalogModel({ id: 'mlx-community/Qwen3-0.6B-4bit', name: 'Qwen3 0.6B', quants: [{ label: 'MLX 4-bit', file: 'model.safetensors', sizeBytes: 1, format: 'mlx', extraFiles: ['config.json'] }] as never }), 'mlx-community/Qwen3-0.6B-4bit', 'MLX 4-bit'],
    [catalogModel({ name: 'BGE small', tags: ['embedding'], pipelineTag: 'feature-extraction', quants: [{ label: 'F16', file: 'bge-f16.gguf', sizeBytes: 1 }] as never }), 'CompendiumLabs/bge-small-en-v1.5-gguf', 'F16'],
    [catalogModel({ name: 'SD3.5 Medium', tags: [], quants: [{ label: 'Q4_0', file: 'sd3.5_medium-Q4_0.gguf', sizeBytes: 1 }] as never }), 'city96/stable-diffusion-3.5-medium-gguf', 'Q4_0'],
  ] as Array<[CatalogModel | null, string, string]>) {
    downloadPlans.push({ model, id, quant, out: JSON.stringify(norm(root, await modelDownloadPlan(model, id, quant, models, isLanded))) });
  }

  const row = (over: Partial<LocalModel>): LocalModel => ({ id: 'x', name: 'X', path: `${models}/x.gguf`, sizeBytes: 1, addedAt: 0, ...over });
  const repoModels: LocalModel[] = [
    row({ sourceRepo: 'unsloth/Qwen3-4B-GGUF' }),
    row({ id: 'chat/bartowski_Qwen2.5-7B-GGUF/qwen', folderId: 'primary' }),
    row({ id: 'qwen_', folderId: 'primary' }),
    row({ id: '_qwen/x' }),
    row({ id: 'loose' }),
    row({ id: 'lmstudio/lmstudio-community/Qwen3-8B-GGUF/file', folderId: 'lmstudio' }),
    row({ id: 'ollama/llama3.2:latest', folderId: 'ollama' }),
    row({ id: 'a_b/c' }),
  ];
  const sourceRepos = repoModels.map((m) => ({ model: norm(root, m), out: sourceRepoFor(m) ?? null }));

  const ownModel = row({ id: 'chat/unsloth_Qwen3-4B-GGUF/Qwen3-4B-Q4_K_M', name: 'Qwen3 4B', path: join(models, 'chat', 'unsloth_Qwen3-4B-GGUF', 'Qwen3-4B-Q4_K_M.gguf'), managed: true });
  const borrowed = row({ id: 'lmstudio/pub/repo/model', name: 'Borrowed', path: join(root, 'lmstudio', 'pub', 'repo', 'model.gguf'), managed: false, folderId: 'lmstudio' });
  const LANDED2 = new Set([
    '<root>/models/chat/unsloth_Qwen3-4B-GGUF/tokenizer.json',
    '<root>/lmstudio/pub/repo/mmproj-F16.gguf',
    norm(root, join(companionsDir(models, 'lmstudio/pub/repo/model'), 'config.json')) as string,
  ]);
  const isLanded2 = async (p: string) => LANDED2.has(norm(root, p) as string);
  const companionCases: Array<[LocalModel, string, { projector?: string; sidecars: string[] } | null]> = [
    [ownModel, 'unsloth/Qwen3-4B-GGUF', null],
    [ownModel, 'unsloth/Qwen3-4B-GGUF', { sidecars: [] }],
    [ownModel, 'unsloth/Qwen3-4B-GGUF', { projector: 'mmproj-F16.gguf', sidecars: ['tokenizer.json', 'nested/chat_template.jinja'] }],
    [ownModel, 'unsloth/Qwen3-4B-GGUF', { sidecars: ['tokenizer.json'] }],
    [borrowed, 'pub/repo', { projector: 'mmproj-F16.gguf', sidecars: ['config.json', 'tokenizer_config.json'] }],
    [borrowed, 'pub/repo', { projector: 'mmproj-F16.gguf', sidecars: ['config.json'] }],
  ];
  const companions = [];
  for (const [model, repo, found] of companionCases) {
    companions.push({ model: norm(root, model), repo, found, out: JSON.stringify(norm(root, await companionsPlan(model, repo, found, models, isLanded2))) });
  }

  // Image models: which set, what is on disk, what to fetch.
  const imageDir = imageCompanionsDir(models);
  await mkdir(imageDir, { recursive: true });
  await writeFile(join(imageDir, 'clip_l.safetensors'), 'x');
  await writeFile(join(imageDir, 'taesd-sd3.safetensors'), 'x');
  await writeFile(join(imageDir, 'vae-flux2.safetensors'), '');
  const sdDir = join(models, 'image', 'city96_sd3.5-medium-gguf');
  await mkdir(sdDir, { recursive: true });
  await writeFile(join(sdDir, 'sd3.5_medium-Q4_0.gguf'), 'x');
  await writeFile(join(sdDir, 'T5XXL_fp16.safetensors'), 'x');
  await writeFile(join(sdDir, 'vae.txt'), 'x');
  await writeFile(join(sdDir, 'clip-g.sft'), 'x');
  const ownVae = join(root, 'elsewhere', 'my-vae.safetensors');
  await mkdir(dirname(ownVae), { recursive: true });
  await writeFile(ownVae, 'x');
  const image = (over: Partial<LocalModel>) => row({ modality: 'image', ...over });
  const imageModels: LocalModel[] = [
    image({ id: 'image/city96_sd3.5-medium-gguf/sd3.5_medium-Q4_0', name: 'SD3.5 Medium', architecture: 'sd3', path: join(sdDir, 'sd3.5_medium-Q4_0.gguf') }),
    image({ id: 'sd-own-vae', name: 'Stable Diffusion 3 own', path: join(models, 'sd3-own.gguf'), preset: { diffusion: { vae: ownVae, clip_l: join(root, 'missing.safetensors') } } as never }),
    image({ id: 'flux1-schnell', name: 'FLUX.1 schnell', architecture: 'flux', path: join(models, 'flux1-schnell-q4.gguf') }),
    image({ id: 'flux1-dev', name: 'flux1 dev', path: join(models, 'flux1-dev.gguf') }),
    image({ id: 'klein4', name: 'FLUX.2 klein 4B', path: join(models, 'flux-2-klein-4b-Q4_K_M.gguf') }),
    image({ id: 'klein9', name: 'FLUX.2 klein', path: join(models, 'flux2_klein_9b.gguf') }),
    image({ id: 'flux2dev', name: 'FLUX.2 dev', path: join(models, 'flux2-dev.gguf') }),
    image({ id: 'other', name: 'Chroma', architecture: 'chroma', path: join(models, 'chroma.gguf') }),
  ];
  const imageCases = [];
  for (const model of imageModels) {
    const beside = await companionsBeside(model, [companionsDir(models, model.id)]);
    const statuses = [];
    for (const token of [undefined, 'hf_token']) {
      const status = await imageCompanionStatus(model, imageDir, beside, Boolean(token));
      statuses.push({
        token: token ?? null,
        status: JSON.stringify(norm(root, status)),
        plan: JSON.stringify(norm(root, imageCompanionsPlan(model, status, token, models))),
      });
    }
    imageCases.push({ model: norm(root, model), set: JSON.stringify(imageCompanionSetFor(model) ?? null), beside: JSON.stringify(norm(root, beside)), statuses });
  }

  // Which finished jobs are followed up, call by call.
  const job = (id: string, state: DownloadJob['state'], over: Partial<DownloadJob> = {}): DownloadJob => ({
    id, kind: 'model', label: id, target: 'r', dest: '<root>/models/chat/x/m.gguf', state, receivedBytes: 0, startedAt: 0, ...over,
  });
  const seen = new Map<string, DownloadJob['state']>();
  const finishedCalls = [
    [job('model:o/r:Q4', 'downloading'), job('model:o/r:Q4:mmproj.gguf', 'done')],
    [job('model:o/r:Q4', 'done'), job('model:o/r:Q4:mmproj.gguf', 'done'), job('engine:llama:b1', 'done', { kind: 'engine' })],
    [job('model:o/r:Q4', 'done'), job('companions:chat/x:file.json', 'done'), job('image-companions:vae.sft', 'done')],
    [job('model:o/r:Q8', 'done', { dest: undefined }), job('model:o/r:Q2', 'failed')],
    [job('model:o/r:Q4', 'done')],
  ];
  const finished = finishedCalls.map((jobs) => ({ jobs, out: finishedModelJobs(jobs, seen).map((j) => j.id) }));

  const list = [
    row({ id: 'gguf', path: join(models, 'chat', 'o_r', 'm.gguf') }),
    row({ id: 'mlx', path: join(models, 'mlx', 'o_r'), format: 'mlx' }),
  ];
  const downloaded = [
    join(models, 'chat', 'o_r', 'm.gguf'),
    join(models, 'mlx', 'o_r', 'model.safetensors'),
    join(models, 'chat', 'o_r', 'other.gguf'),
    join(models, 'chat', 'o_r', '.', 'm.gguf'),
  ].map((dest) => ({ dest: norm(root, dest), out: downloadedModel(list, job('model:o/r:Q4', 'done', { dest }))?.id ?? null }));

  const gpu = (totalGb: number, freeGb: number): HardwareFacts => ({
    devices: [{ name: 'GPU', totalBytes: totalGb * 2 ** 30, freeBytes: freeGb * 2 ** 30 }],
    unified: false,
    systemRamTotalBytes: 64 * 2 ** 30,
    systemRamFreeBytes: 32 * 2 ** 30,
  });
  const geo = (over: Partial<LocalModel>) => row({ sizeBytes: 4 * 2 ** 30, layers: 32, kvHeads: 8, headDim: 128, maxContext: 131072, ...over });
  const presetCases: Array<[LocalModel, HardwareFacts | undefined, number]> = [
    [geo({}), gpu(24, 22), 256 * 2 ** 20],
    [geo({}), gpu(8, 6), 256 * 2 ** 20],
    [geo({}), gpu(4, 3), 512 * 2 ** 20],
    [geo({ sizeBytes: 60 * 2 ** 30 }), gpu(8, 8), 256 * 2 ** 20],
    [geo({ layers: undefined, kvHeads: undefined, headDim: undefined }), gpu(24, 22), 256 * 2 ** 20],
    [geo({ maxContext: 4096 }), gpu(24, 22), 256 * 2 ** 20],
    [geo({}), undefined, 256 * 2 ** 20],
    [geo({}), { ...gpu(8, 8), devices: [] }, 256 * 2 ** 20],
    [geo({ maxContext: undefined }), gpu(12, 11), 1 << 30],
  ];
  const presets = presetCases.map(([model, hw, floor]) => ({ model: norm(root, model), hw: hw ?? null, floor, out: JSON.stringify(gpuFirstPreset(model, hw, floor) ?? null) }));

  const expected = {
    note: 'Generated by packages/host/src/engine/downloads.golden.test.ts. Do not edit by hand.',
    now: NOW,
    // Each case ran below its own folder, which is its `<root>`.
    queue,
    downloadPlans,
    sourceRepos,
    companions,
    imageFiles: ['models/.companions/image/clip_l.safetensors', 'models/.companions/image/taesd-sd3.safetensors', 'models/image/city96_sd3.5-medium-gguf/sd3.5_medium-Q4_0.gguf', 'models/image/city96_sd3.5-medium-gguf/T5XXL_fp16.safetensors', 'models/image/city96_sd3.5-medium-gguf/vae.txt', 'models/image/city96_sd3.5-medium-gguf/clip-g.sft', 'elsewhere/my-vae.safetensors'],
    imageEmpty: ['models/.companions/image/vae-flux2.safetensors'],
    images: imageCases,
    finished,
    downloaded,
    presets,
  };
  const text = `${JSON.stringify(expected, null, 2)}\n`;
  if (process.env.UPDATE_GOLDEN === '1' || !existsSync(golden)) {
    mkdirSync(dirname(golden), { recursive: true });
    writeFileSync(golden, text);
  }
  expect(JSON.parse(text)).toEqual(JSON.parse(readFileSync(golden, 'utf8')));
});
