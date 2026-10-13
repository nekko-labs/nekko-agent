import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createLibrary, daemonLibrary } from './library.js';
import { buildGguf, str, u32 } from './gguf-fixture.js';

/**
 * The library treats the files as the truth and the index as a cache, so these
 * tests are mostly about reconciliation: a file dropped in by hand appears, a
 * file deleted outside the app disappears, and the pieces of a split model do
 * not masquerade as models of their own.
 */

let dir: string;
let library: ReturnType<typeof createLibrary>;

const gguf = (name: string, over: Array<[string, ReturnType<typeof u32>]> = []) =>
  writeFile(
    join(dir, name),
    buildGguf([
      ['general.architecture', str('llama')],
      ['general.name', str(name.replace(/\.gguf$/, ''))],
      ['general.file_type', u32(15)],
      ['llama.block_count', u32(32)],
      ['llama.attention.head_count', u32(32)],
      ['llama.attention.head_count_kv', u32(8)],
      ['llama.embedding_length', u32(4096)],
      ['llama.context_length', u32(32768)],
      ...over,
    ]),
  );

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nekko-lib-'));
  library = createLibrary({ modelsDir: () => dir });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('model library', () => {
  it('reads geometry from the file itself, so the planner gets real numbers', async () => {
    await gguf('qwen3-8b.gguf');
    const [model] = await library.list();

    expect(model.layers).toBe(32);
    expect(model.kvHeads).toBe(8);
    expect(model.headDim).toBe(128);
    expect(model.maxContext).toBe(32768);
    expect(model.quantization).toBe('Q4_K_M');
  });

  it('picks up a file dropped into the folder by hand', async () => {
    expect(await library.list()).toHaveLength(0);
    await gguf('dropped-in.gguf');
    expect(await library.list()).toHaveLength(1);
  });

  it('drops a row whose file was deleted outside the app', async () => {
    await gguf('gone.gguf');
    expect(await library.list()).toHaveLength(1);

    await rm(join(dir, 'gone.gguf'));
    expect(await library.list()).toHaveLength(0);
  });

  it('finds models in subfolders, which is how downloads are filed', async () => {
    await mkdir(join(dir, 'bartowski_Qwen2.5-7B-Instruct-GGUF'), { recursive: true });
    await writeFile(
      join(dir, 'bartowski_Qwen2.5-7B-Instruct-GGUF', 'qwen.gguf'),
      buildGguf([
        ['general.architecture', str('qwen2')],
        ['qwen2.block_count', u32(28)],
      ]),
    );

    const [model] = await library.list();
    // The id is the path below the models dir, so it is stable and URL-safe.
    expect(model.id).toBe('bartowski_Qwen2.5-7B-Instruct-GGUF/qwen');
  });

  it('treats a split model as one entry, not as one per shard', async () => {
    await gguf('big-00001-of-00003.gguf');
    await gguf('big-00002-of-00003.gguf');
    await gguf('big-00003-of-00003.gguf');

    const models = await library.list();
    expect(models).toHaveLength(1);
    expect(models[0].id).toContain('00001-of-00003');
  });

  it('does not list a vision projector as a model', async () => {
    await gguf('gemma3-12b.gguf');
    await gguf('mmproj-gemma3-12b.gguf');
    expect((await library.list()).map((m) => m.name)).toEqual(['gemma3-12b']);
  });

  it('refuses to import something that is not a GGUF', async () => {
    const path = join(dir, 'notes.txt');
    await writeFile(path, 'hello');
    const res = await library.importFile(path);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/GGUF/);
  });

  it('refuses to import a .gguf whose contents are not one', async () => {
    const path = join(dir, 'lying.gguf');
    await writeFile(path, 'definitely not a gguf');
    const res = await library.importFile(path);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/readable GGUF/);
  });

  it('deletes a model with its shards and projector', async () => {
    await gguf('big-00001-of-00002.gguf');
    await gguf('big-00002-of-00002.gguf');
    await gguf('mmproj-big.gguf');

    const [model] = await library.list();
    expect((await library.remove(model.id)).ok).toBe(true);
    expect(await library.list()).toHaveLength(0);
  });

  it('keeps per-model load settings across reads', async () => {
    await gguf('preset.gguf');
    const [model] = await library.list();

    await library.savePreset(model.id, { contextTokens: 16384, kvCacheDtype: 'q8_0', budgetFraction: 0.6 });
    const [reloaded] = await library.list();
    expect(reloaded.preset).toEqual({ contextTokens: 16384, kvCacheDtype: 'q8_0', budgetFraction: 0.6 });
  });

  it('reports total disk use across the library', async () => {
    await gguf('a.gguf');
    await gguf('b.gguf');
    const models = await library.list();
    expect(await library.diskUsage()).toBe(models.reduce((n, m) => n + m.sizeBytes, 0));
  });

  it('survives a models folder that does not exist yet', async () => {
    const empty = createLibrary({ modelsDir: () => join(dir, 'not-created') });
    expect(await empty.list()).toEqual([]);
  });

  it('labels each model with what kind of file it is', async () => {
    await gguf('qwen3-8b.gguf');
    await writeFile(
      join(dir, 'sd.gguf'),
      buildGguf([
        ['general.architecture', str('sd3')],
        ['general.name', str('Stable Diffusion')],
      ]),
    );

    const byArch = new Map((await library.list()).map((m) => [m.architecture, m.modality]));
    expect(byArch.get('llama')).toBe('chat');
    expect(byArch.get('sd3')).toBe('image');
  });

  it('marks a file whose header will not read as unreadable, not chat', async () => {
    await writeFile(join(dir, 'old-ggml.gguf'), 'GGML legacy bytes that are not a real GGUF');
    const [model] = await library.list();
    expect(model.readable).toBe(false);
    expect(model.modality).toBe('unknown');
  });

  it('knows a vision model has its projector, from beside it or from the companions dir', async () => {
    await gguf('gemma3-12b.gguf');
    let [model] = await library.list();
    expect(model.hasProjector).toBe(false);
    // Nothing says "sees images" yet: plain llama architecture, no projector.
    expect(model.modality).toBe('chat');

    // A projector we fetched into the nekko-side dir counts the same as one
    // dropped beside the weights.
    const fetched = join(dir, '.companions');
    await mkdir(fetched, { recursive: true });
    // The dir is keyed by a hash of the model id; create it the same way the
    // host does rather than hardcoding the hash.
    const { companionsDir } = await import('./companions.js');
    const sidecarDir = companionsDir(dir, model.id);
    await mkdir(sidecarDir, { recursive: true });
    await writeFile(join(sidecarDir, 'mmproj-gemma3-12b-BF16.gguf'), 'x');

    [model] = await library.list();
    expect(model.hasProjector).toBe(true);
    // A projector is evidence: the same weights now classify as vision.
    expect(model.modality).toBe('vision');
  });

  it('never lists the companions dir as models of its own', async () => {
    await gguf('plain.gguf');
    const { companionsDir } = await import('./companions.js');
    const sidecarDir = companionsDir(dir, 'plain');
    await mkdir(sidecarDir, { recursive: true });
    await writeFile(join(sidecarDir, 'mmproj-plain.gguf'), 'x');
    await writeFile(join(sidecarDir, 'stray.gguf'), 'x');

    expect((await library.list()).map((m) => m.id)).toEqual(['plain']);
  });
});

describe('the library under the engine daemon', () => {
  it('reads and writes through the daemon, which alone writes library.json', async () => {
    const calls: unknown[][] = [];
    const rows = [
      { id: 'a', name: 'A', path: '/m/a.gguf', sizeBytes: 3, addedAt: 0 },
      { id: 'b', name: 'B', path: '/m/b.gguf', sizeBytes: 4, addedAt: 0 },
    ];
    const call = async <T,>(channel: string, ...args: unknown[]): Promise<T> => {
      calls.push([channel, ...args]);
      return (channel === 'engine:library' ? rows : { ok: true, message: channel }) as T;
    };
    const remote = daemonLibrary(call);

    expect((await remote.find('b'))?.name).toBe('B');
    expect(await remote.find('nope')).toBeUndefined();
    expect(await remote.diskUsage()).toBe(7);
    await remote.savePreset('a', { contextTokens: 4096 });
    expect(await remote.importFile('/x.gguf')).toEqual({ ok: true, message: 'engine:importModel' });
    expect(await remote.remove('a')).toEqual({ ok: true, message: 'engine:deleteModel' });
    expect(calls.filter((c) => c[0] !== 'engine:library')).toEqual([
      ['engine:saveModelPreset', 'a', { contextTokens: 4096 }],
      ['engine:importModel', '/x.gguf'],
      ['engine:deleteModel', 'a'],
    ]);
  });
});
