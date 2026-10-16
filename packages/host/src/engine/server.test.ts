import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import type { EngineSettings, LocalModel } from '@nekko-agent/shared';
import { DEFAULT_ENGINE_SETTINGS } from '@nekko-agent/shared';
import { buildArgs, createEngineServer, explainLoadError, inputModalities, probeFlags, resolveCompanions, type EngineServer } from './server.js';

/**
 * The router, driven against a stand-in for `llama-server`.
 *
 * The stand-in is a real child process speaking real HTTP on a real port, which
 * is the part worth testing: health polling, proxying, and eviction are all
 * about process and socket behaviour, and a mocked child would prove none of it.
 * What it does not test is llama.cpp itself, which is deliberate: this file owns
 * the routing, not the inference.
 */

/**
 * A fake llama-server: answers /health, echoes what it was asked for.
 *
 * Written to a file rather than passed to `node -e`, because in eval mode node
 * keeps parsing `--flags` as its own options and chokes on `--model`. A script
 * path ends node's option parsing, so the stub sees exactly the argv the router
 * built.
 */
const STUB = `
  const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
  const alias = process.argv[process.argv.indexOf('--alias') + 1];
  require('http').createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok' }));
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-stub-alias': alias });
      res.end(JSON.stringify({ served_by: alias, path: req.url, echo: body ? JSON.parse(body) : null }));
    });
  }).listen(port, '127.0.0.1');
`;

let stubPath = '';
let stubDir = '';

beforeAll(async () => {
  stubDir = await mkdtemp(join(tmpdir(), 'nekko-engine-'));
  stubPath = join(stubDir, 'stub-server.cjs');
  await writeFile(stubPath, STUB);
});
afterAll(async () => {
  await rm(stubDir, { recursive: true, force: true });
});

const model = (id: string): LocalModel => ({
  id,
  name: id,
  path: `/models/${id}.gguf`,
  sizeBytes: 4_000_000_000,
  layers: 32,
  kvHeads: 8,
  headDim: 128,
  maxContext: 32768,
  addedAt: Date.now(),
});

const MODELS = [model('qwen3-8b'), model('gemma3-12b')];

function make(
  settings: Partial<EngineSettings> = {},
  models: LocalModel[] = MODELS,
  spawnFn?: typeof spawn,
  extraDeps: Partial<Parameters<typeof createEngineServer>[0]> = {},
) {
  const current: EngineSettings = { ...DEFAULT_ENGINE_SETTINGS, ...settings };
  const server = createEngineServer({
    settings: () => current,
    binPath: async () => process.execPath,
    findModel: async (id) => models.find((m) => m.id === id),
    listModels: async () => models,
    getGpuStats: async () => null,
    // The real call is `llama-server <flags>`; here it is `node stub.cjs <flags>`,
    // so the stub reads the same `--port` and `--alias` the router passes.
    spawnFn:
      spawnFn ??
      (((_bin: string, args: readonly string[]) =>
        spawn(process.execPath, [stubPath, ...args], {
          stdio: ['ignore', 'pipe', 'pipe'],
        })) as unknown as typeof spawn),
    ...extraDeps,
  });
  return { server, settings: current };
}

let open: EngineServer | null = null;
afterEach(async () => {
  await open?.stop();
  open = null;
});

async function start(overrides: Partial<EngineSettings> = {}): Promise<{ server: EngineServer; port: number }> {
  const port = await freePort();
  const { server } = make({ port, ...overrides });
  const res = await server.start();
  expect(res.ok, res.message).toBe(true);
  open = server;
  return { server, port };
}

const call = (port: number, path: string, init?: RequestInit) =>
  fetch(`http://127.0.0.1:${port}${path}`, init);

describe('engine router', () => {
  it('serves the library at /v1/models with load state', async () => {
    const { port } = await start();
    const res = await call(port, '/v1/models');
    const body = (await res.json()) as { data: Array<{ id: string; state: string }> };
    expect(body.data.map((m) => m.id)).toEqual(['qwen3-8b', 'gemma3-12b']);
    expect(body.data[0].state).toBe('not-loaded');
  });

  it('loads a model and proxies inference to its process', async () => {
    const { server, port } = await start();
    expect((await server.load('qwen3-8b', { contextTokens: 4096 })).ok).toBe(true);

    const res = await call(port, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3-8b', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const body = (await res.json()) as { served_by: string; path: string };
    expect(body.served_by).toBe('qwen3-8b');
    expect(body.path).toBe('/v1/chat/completions');
  });

  it('routes each model to its own process', async () => {
    const { server, port } = await start({ maxLoaded: 2 });
    await server.load('qwen3-8b', {});
    await server.load('gemma3-12b', {});

    for (const id of ['qwen3-8b', 'gemma3-12b']) {
      const res = await call(port, '/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: id }),
      });
      expect(((await res.json()) as { served_by: string }).served_by).toBe(id);
    }
  });

  it('loads on demand when a request names a model that is not resident', async () => {
    const { server, port } = await start({ jitLoad: true });
    expect(server.loadedIds()).toEqual([]);

    const res = await call(port, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gemma3-12b' }),
    });
    expect(((await res.json()) as { served_by: string }).served_by).toBe('gemma3-12b');
    expect(server.loadedIds()).toEqual(['gemma3-12b']);
  });

  it('refuses instead of loading when load-on-demand is off', async () => {
    const { port } = await start({ jitLoad: false });
    const res = await call(port, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3-8b' }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/not loaded/i);
  });

  it('says which models exist when asked for one that does not', async () => {
    const { port } = await start();
    const res = await call(port, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'not-a-model' }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain('/v1/models');
  });

  it('evicts the least recently used model past the resident limit', async () => {
    const { server } = await start({ maxLoaded: 1 });
    await server.load('qwen3-8b', {});
    await server.load('gemma3-12b', {});
    expect(server.loadedIds()).toEqual(['gemma3-12b']);
  });

  it('rejects an unauthorized request when a key is set, and allows a good one', async () => {
    const { server, port } = await start({ apiKey: 'sekrit' });
    await server.load('qwen3-8b', {});

    expect((await call(port, '/v1/models')).status).toBe(401);
    const bad = await call(port, '/v1/models', { headers: { authorization: 'Bearer wrong' } });
    expect(bad.status).toBe(401);
    const good = await call(port, '/v1/models', { headers: { authorization: 'Bearer sekrit' } });
    expect(good.status).toBe(200);
  });

  it('leaves health unauthenticated so the port can be identified', async () => {
    const { port } = await start({ apiKey: 'sekrit' });
    const res = await call(port, '/health');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { service: string }).service).toBe('nekko-agent-engine');
  });

  it('sends no CORS headers unless origins are configured', async () => {
    const { port } = await start();
    const res = await call(port, '/v1/models', { headers: { origin: 'https://example.com' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('allows a configured origin and refuses an unlisted one', async () => {
    const { port } = await start({ corsOrigins: 'https://good.example' });
    const ok = await call(port, '/v1/models', { headers: { origin: 'https://good.example' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://good.example');
    const no = await call(port, '/v1/models', { headers: { origin: 'https://bad.example' } });
    expect(no.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('reports a port that is already taken rather than failing silently', async () => {
    const { port } = await start();
    const { server: second } = make({ port });
    const res = await second.start();
    expect(res.ok).toBe(false);
    expect(res.message).toContain('already in use');
  });

  it('unloading stops the model answering', async () => {
    const { server } = await start();
    await server.load('qwen3-8b', {});
    expect(server.resident()).toHaveLength(1);
    expect((await server.unload('qwen3-8b')).ok).toBe(true);
    expect(server.resident()).toHaveLength(0);
  });

  it('refuses a model llama.cpp cannot serve before any process is spawned', async () => {
    let spawned = 0;
    const { server } = make(
      {},
      [{ ...model('flux-1-dev'), modality: 'image', architecture: 'flux' }],
      ((_bin: string, _args: readonly string[]) => {
        spawned += 1;
        throw new Error('should never be spawned');
      }) as unknown as typeof spawn,
    );
    const res = await server.load('flux-1-dev', {});
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/image-generation/);
    expect(spawned).toBe(0);
    // The refusal is the same state the row shows, readable by the models call.
    expect(server.loadErrorFor('flux-1-dev')).toMatch(/image-generation/);
  });

  it('loads the autoload list when the engine starts', async () => {
    const { server } = await start({ autoload: ['qwen3-8b'] });
    // Autoload is fired rather than awaited, so poll for the process landing.
    const deadline = Date.now() + 15_000;
    while (!server.loadedIds().includes('qwen3-8b') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(server.loadedIds()).toContain('qwen3-8b');
  });

  it('changes a resident model\'s idle TTL without a reload', async () => {
    const { server } = await start({ idleTtlSeconds: 900 });
    await server.load('qwen3-8b', {});
    expect(server.resident()[0].expiresAt).toBeDefined();

    // 0 is "keep it until I say": the eviction deadline disappears.
    expect(server.setResidentTtl('qwen3-8b', 0).ok).toBe(true);
    expect(server.resident()[0].expiresAt).toBeUndefined();

    // And a refused change says so rather than doing nothing quietly.
    expect(server.setResidentTtl('not-loaded', 0).ok).toBe(false);
  });

  it('always names a context: the trained size capped at 64k, or what was asked for', async () => {
    const seen: string[][] = [];
    const spawnFn = ((_bin: string, args: readonly string[]) => {
      seen.push([...args]);
      return spawn(process.execPath, [stubPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    }) as unknown as typeof spawn;
    const big = { ...model('gemma4-12b'), maxContext: 262_144 };
    const port = await freePort();
    const { server } = make({ port, maxLoaded: 3 }, [...MODELS, big], spawnFn);
    open = server;
    await server.start();
    const ctx = (i: number) => seen[i][seen[i].indexOf('--ctx-size') + 1];
    expect((await server.load('gemma4-12b', {})).ok).toBe(true);
    expect(ctx(0)).toBe('65536');
    expect((await server.load('qwen3-8b', {})).ok).toBe(true);
    expect(ctx(1)).toBe('32768');
    expect((await server.load('gemma3-12b', { contextTokens: 131072 })).ok).toBe(true);
    expect(ctx(2)).toBe('131072');
    // The unasked-for default is not a changed setting: the same load is not a reload.
    expect((await server.load('gemma4-12b', {})).message).toMatch(/already loaded/);
    expect(seen).toHaveLength(3);
  });

  it('keeps the last failure reason until a load succeeds', async () => {
    let die = true;
    const spawnFn = ((_bin: string, args: readonly string[]) =>
      die
        ? // A child that exits before /health, the way a load really fails.
          spawn(process.execPath, ['-e', 'process.exit(1)'], { stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn(process.execPath, [stubPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })) as unknown as typeof spawn;
    const port = await freePort();
    const { server } = make({ port }, MODELS, spawnFn);
    open = server;
    await server.start();

    const failed = await server.load('qwen3-8b', {});
    expect(failed.ok).toBe(false);
    expect(server.loadErrorFor('qwen3-8b')).toBeTruthy();

    die = false;
    expect((await server.load('qwen3-8b', {})).ok).toBe(true);
    expect(server.loadErrorFor('qwen3-8b')).toBeUndefined();
  });

  it('reports a load while it is in flight, then clears it', async () => {
    // A child that starts listening late, so the load has an observable middle.
    const slow = join(stubDir, 'stub-slow.cjs');
    await writeFile(
      slow,
      `
      const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
      setTimeout(() => {
        require('http').createServer((req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
        }).listen(port, '127.0.0.1');
      }, 2000);
    `,
    );
    let freeMB = 6000;
    const port = await freePort();
    const { server } = make(
      { port },
      MODELS,
      ((_bin: string, args: readonly string[]) =>
        spawn(process.execPath, [slow, ...args], {
          stdio: ['ignore', 'pipe', 'pipe'],
        })) as unknown as typeof spawn,
      {
        getGpuStats: async () => ({
          source: 'nvidia-smi',
          devices: [{ name: 'fake', memoryTotalMB: 8192, memoryUsedMB: 8192 - freeMB, memoryFreeMB: freeMB }],
          totalMB: 8192,
          usedMB: 8192 - freeMB,
          freeMB,
        }),
      },
    );
    open = server;
    await server.start();

    const p = server.load('qwen3-8b', {});
    // The entry exists the moment the load is asked for, queued behind the chain.
    expect(server.status().loading?.[0]?.phase).toBe('queued');
    await new Promise((r) => setTimeout(r, 300));
    expect(server.status().loading?.[0]?.phase).toBe('loading');
    // Free VRAM sinking against the file's size is the progress number.
    freeMB -= 500;
    await new Promise((r) => setTimeout(r, 900));
    expect(server.status().loading?.[0]?.progress).toBeGreaterThan(0);
    expect((await p).ok).toBe(true);
    expect(server.status().loading ?? []).toEqual([]);
  });
});

describe('buildArgs', () => {
  const m = model('qwen3-8b');

  const all = () => true;

  it('adds the agent-speed defaults where the build supports them', () => {
    const args = buildArgs(m, 9000, {}, undefined, all);
    expect(args[args.indexOf('--cache-reuse') + 1]).toBe('256');
    expect(args).toContain('--no-cache-idle-slots');
    expect(args).toContain('--spec-default');
    expect(args).not.toContain('--spec-draft-model');
  });

  it('leaves out every flag an older build does not know', () => {
    const args = buildArgs(m, 9000, {}, undefined, (f) => f === '--cache-reuse');
    expect(args).toContain('--cache-reuse');
    expect(args).not.toContain('--spec-default');
    expect(args).not.toContain('--no-cache-idle-slots');
  });

  it('turns speculative decoding off on request, and keeps it for vision models', () => {
    expect(buildArgs(m, 9000, { speculative: false }, undefined, all)).not.toContain('--spec-default');
    expect(buildArgs(m, 9000, {}, { mmproj: '/m/mmproj.gguf' }, all)).toContain('--spec-default');
  });

  it('adds a draft model beside the n-gram lookup when one is attached', () => {
    const args = buildArgs(m, 9000, {}, { draftModel: '/m/small.gguf' }, all);
    expect(args[args.indexOf('--spec-draft-model') + 1]).toBe('/m/small.gguf');
    expect(args[args.indexOf('--spec-type') + 1]).toBe('draft-simple');
    expect(args).toContain('--spec-default');
  });

  it('keeps embedding models on the plain path', () => {
    const e = { ...model('nomic-embed'), architecture: 'nomic-bert' };
    const args = buildArgs(e, 9000, {}, undefined, all);
    expect(args).toContain('--embedding');
    expect(args).not.toContain('--spec-default');
    expect(args).not.toContain('--cache-reuse');
  });

  it('reads supported flags from the build and remembers them per binary', async () => {
    let asked = 0;
    const help = async () => {
      asked++;
      return '  --cache-reuse N   min chunk size\n  -kvu, --kv-unified\n  --spec-default\n';
    };
    const supports = await probeFlags('/fake/llama-server-a', help);
    expect(supports('--cache-reuse')).toBe(true);
    expect(supports('--spec-default')).toBe(true);
    expect(supports('--no-cache-idle-slots')).toBe(false);
    await probeFlags('/fake/llama-server-a', help);
    expect(asked).toBe(1);
  });

  it('treats a build it cannot ask as knowing none of the newer flags', async () => {
    const supports = await probeFlags('/fake/llama-server-b', async () => {
      throw new Error('no such file');
    });
    expect(supports('--cache-reuse')).toBe(false);
  });

  it('passes only what was asked for, so unset means the engine default', () => {
    expect(buildArgs(m, 9000, {})).toEqual([
      '--model', m.path,
      '--alias', 'qwen3-8b',
      '--host', '127.0.0.1',
      '--port', '9000',
    ]);
  });

  it('maps the cross-runtime parameters onto llama.cpp flags', () => {
    const args = buildArgs(m, 9000, { contextTokens: 16384, gpuLayers: 20, parallelSlots: 4 });
    expect(args).toContain('--ctx-size');
    expect(args[args.indexOf('--ctx-size') + 1]).toBe('16384');
    expect(args[args.indexOf('--n-gpu-layers') + 1]).toBe('20');
    expect(args[args.indexOf('--parallel') + 1]).toBe('4');
  });

  it('sets both KV cache halves, and only when they differ from the default', () => {
    expect(buildArgs(m, 9000, { kvCacheDtype: 'f16' })).not.toContain('--cache-type-k');
    const args = buildArgs(m, 9000, { kvCacheDtype: 'q8_0' });
    expect(args[args.indexOf('--cache-type-k') + 1]).toBe('q8_0');
    expect(args[args.indexOf('--cache-type-v') + 1]).toBe('q8_0');
  });

  it('writes flash attention as an explicit on/off, and omits it when unset', () => {
    expect(buildArgs(m, 9000, {})).not.toContain('--flash-attn');
    expect(buildArgs(m, 9000, { flashAttention: true })).toContain('on');
    expect(buildArgs(m, 9000, { flashAttention: false })).toContain('off');
  });

  it('writes mmap and mlock as --load-mode on builds that know it', () => {
    const supports = (f: string) => f === '--load-mode';
    const off = buildArgs(m, 9000, { mmap: false }, undefined, supports);
    expect(off[off.indexOf('--load-mode') + 1]).toBe('none');
    expect(off).not.toContain('--no-mmap');
    const locked = buildArgs(m, 9000, { mlock: true }, undefined, supports);
    expect(locked[locked.indexOf('--load-mode') + 1]).toBe('mmap+mlock');
    // Unset means the engine default: no flag at all.
    expect(buildArgs(m, 9000, {}, undefined, supports)).not.toContain('--load-mode');
    expect(buildArgs(m, 9000, { mmap: true }, undefined, supports)).not.toContain('--load-mode');
    // Pinning without a map is not a load-mode, so mmap-off wins.
    const both = buildArgs(m, 9000, { mmap: false, mlock: true }, undefined, supports);
    expect(both[both.indexOf('--load-mode') + 1]).toBe('none');
  });

  it('keeps --no-mmap and --mlock for builds without --load-mode', () => {
    expect(buildArgs(m, 9000, { mmap: true })).not.toContain('--no-mmap');
    expect(buildArgs(m, 9000, {})).not.toContain('--no-mmap');
    expect(buildArgs(m, 9000, { mmap: false })).toContain('--no-mmap');
    expect(buildArgs(m, 9000, { mlock: true })).toContain('--mlock');
    expect(buildArgs(m, 9000, { mmap: false })).not.toContain('--load-mode');
  });

  it('puts an embedding model into embedding mode', () => {
    const bge = { ...model('bge-small'), architecture: 'bert' };
    expect(buildArgs(bge, 9000, {})).toContain('--embedding');
    expect(buildArgs(m, 9000, {})).not.toContain('--embedding');
  });

  it('carries a seed of zero, which is a real seed and not an absent one', () => {
    expect(buildArgs(m, 9000, { seed: 0 })).toContain('--seed');
  });

  it('passes a projector to llama-server as --mmproj', () => {
    const args = buildArgs(m, 9000, {}, { mmproj: '/models/mmproj-Q4_K_M.gguf' });
    expect(args[args.indexOf('--mmproj') + 1]).toBe('/models/mmproj-Q4_K_M.gguf');
  });

  it('lists images as an input only for a model whose projector is there', () => {
    expect(inputModalities({ modality: 'chat', hasProjector: false })).toEqual(['text']);
    expect(inputModalities({ modality: 'vision', hasProjector: false })).toEqual(['text']);
    expect(inputModalities({ modality: 'vision', hasProjector: true })).toEqual(['text', 'image']);
    expect(inputModalities({})).toEqual(['text']);
    expect(inputModalities({ modality: 'image' })).toBeUndefined();
    expect(inputModalities({ modality: 'embedding' })).toBeUndefined();
  });

  it('enables jinja when a chat template file is supplied', () => {
    const args = buildArgs(m, 9000, {}, { chatTemplateFile: '/models/chat_template.jinja' });
    expect(args[args.indexOf('--chat-template-file') + 1]).toBe('/models/chat_template.jinja');
    expect(args).toContain('--jinja');
    expect(buildArgs(m, 9000, {})).not.toContain('--jinja');
  });
});

describe('resolveCompanions', () => {
  it('finds the projector and a jinja template beside the model', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nekko-model-'));
    try {
      const modelPath = join(dir, 'vision-7b-Q4_K_M.gguf');
      await writeFile(modelPath, 'x');
      await writeFile(join(dir, 'mmproj-vision-7b-f16.gguf'), 'x');
      await writeFile(join(dir, 'chat_template.jinja'), '{{ messages }}');
      const found = await resolveCompanions({ ...model('vision-7b'), path: modelPath });
      expect(found).not.toHaveProperty('error');
      if (!('error' in found)) {
        expect(found.mmproj).toBe(join(dir, 'mmproj-vision-7b-f16.gguf'));
        expect(found.chatTemplateFile).toBe(join(dir, 'chat_template.jinja'));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('extracts a chat template from tokenizer_config.json into the work dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nekko-model-'));
    const work = await mkdtemp(join(tmpdir(), 'nekko-work-'));
    try {
      const modelPath = join(dir, 'model-Q4_K_M.gguf');
      await writeFile(modelPath, 'x');
      await writeFile(join(dir, 'tokenizer_config.json'), JSON.stringify({ chat_template: '{% for m in messages %}' }));
      const found = await resolveCompanions({ ...model('model'), path: modelPath }, work);
      if ('error' in found) throw new Error(found.error);
      expect(found.chatTemplateFile).toBe(join(work, 'model-Q4_K_M.chat_template.jinja'));
      expect((await readFile(found.chatTemplateFile!, 'utf8'))).toContain('{%');
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });

  it('fails a split model naming the missing shard before any process runs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nekko-model-'));
    try {
      const modelPath = join(dir, 'big-00001-of-00003.gguf');
      await writeFile(modelPath, 'x');
      await writeFile(join(dir, 'big-00002-of-00003.gguf'), 'x');
      const found = await resolveCompanions({ ...model('big'), path: modelPath });
      expect('error' in found && found.error).toMatch(/big-00003-of-00003\.gguf is missing/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns no companions for a lone model in an empty directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nekko-model-'));
    try {
      const modelPath = join(dir, 'plain.gguf');
      await writeFile(modelPath, 'x');
      expect(await resolveCompanions({ ...model('plain'), path: modelPath })).toEqual({});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('uses a projector fetched into the companions dir when none sits beside the weights', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nekko-model-'));
    const sidecars = await mkdtemp(join(tmpdir(), 'nekko-comp-'));
    try {
      const modelPath = join(dir, 'vision-7b-Q4_K_M.gguf');
      await writeFile(modelPath, 'x');
      await writeFile(join(sidecars, 'mmproj-fetched-BF16.gguf'), 'x');
      const found = await resolveCompanions({ ...model('vision-7b'), path: modelPath }, undefined, sidecars);
      if ('error' in found) throw new Error(found.error);
      expect(found.mmproj).toBe(join(sidecars, 'mmproj-fetched-BF16.gguf'));
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(sidecars, { recursive: true, force: true });
    }
  });

  it('prefers the projector beside the weights over a fetched one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nekko-model-'));
    const sidecars = await mkdtemp(join(tmpdir(), 'nekko-comp-'));
    try {
      const modelPath = join(dir, 'vision-7b-Q4_K_M.gguf');
      await writeFile(modelPath, 'x');
      await writeFile(join(dir, 'mmproj-local.gguf'), 'x');
      await writeFile(join(sidecars, 'mmproj-fetched.gguf'), 'x');
      const found = await resolveCompanions({ ...model('vision-7b'), path: modelPath }, undefined, sidecars);
      if ('error' in found) throw new Error(found.error);
      expect(found.mmproj).toBe(join(dir, 'mmproj-local.gguf'));
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(sidecars, { recursive: true, force: true });
    }
  });

  it('extracts a chat template out of a fetched tokenizer_config.json too', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nekko-model-'));
    const sidecars = await mkdtemp(join(tmpdir(), 'nekko-comp-'));
    const work = await mkdtemp(join(tmpdir(), 'nekko-work-'));
    try {
      const modelPath = join(dir, 'model.gguf');
      await writeFile(modelPath, 'x');
      await writeFile(join(sidecars, 'tokenizer_config.json'), JSON.stringify({ chat_template: '{% loop %}' }));
      const found = await resolveCompanions({ ...model('model'), path: modelPath }, work, sidecars);
      if ('error' in found) throw new Error(found.error);
      expect(found.chatTemplateFile).toBe(join(work, 'model.chat_template.jinja'));
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(sidecars, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    }
  });
});

describe('explainLoadError', () => {
  it('translates an unknown architecture into an engine-update hint', () => {
    expect(explainLoadError(["llama_model_load: error loading model: unknown model architecture: 'mamba2'"])).toMatch(
      /Update the engine/i,
    );
  });

  it('names a missing projector when a vision model dies', () => {
    expect(explainLoadError(['srv load_model: failed to load mmproj'])).toMatch(/projector file/i);
  });

  it('names the missing file when one is quoted in the log', () => {
    const msg = explainLoadError(["llama_model_load: error loading model: unable to open file 'qwen-00002-of-00003.gguf'"]);
    expect(msg).toContain('qwen-00002-of-00003.gguf');
    expect(msg).toMatch(/Re-download/);
  });

  it('reads memory pressure out of an allocation failure', () => {
    expect(explainLoadError(['ggml_backend_cuda_buffer_type_alloc_buffer: failed to allocate 3.5 GiB'])).toMatch(
      /Not enough memory/i,
    );
  });

  it('calls a file that is not a GGUF what it is', () => {
    expect(explainLoadError(['llama_model_load: error loading model: bad magic'])).toMatch(/isn't a GGUF/i);
  });

  it('reads a tensor mismatch as a bad download', () => {
    expect(explainLoadError(['llama_model_load: error loading model: missing required tensor blk.0.ffn'])).toMatch(
      /tensor/i,
    );
  });

  it('ignores the shutdown noise after the cause when nothing else matched', () => {
    const log = [
      'srv load_model: something invented went wrong',
      'srv operator(): cleaning up before exit...',
      'exiting due to model loading error',
    ];
    expect(explainLoadError(log)).toBe('srv load_model: something invented went wrong');
  });

  it('falls back to the log tail for a failure nobody wrote a translation for', () => {
    expect(explainLoadError(['some line', 'the actual failure'])).toBe('some line the actual failure');
  });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error('no port'))));
    });
  });
}
