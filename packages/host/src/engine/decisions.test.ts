import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import { checkDecisionFile, createDecisions, DECISION_CATALOG, DECISION_RELEASE_URL } from './decisions.js';
import type { EngineDaemon } from './daemon.js';

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const scratch = async () => { const d = await mkdtemp(join(tmpdir(), 'nekko-decide-')); dirs.push(d); return d; };

const fakeDownloads = () => {
  const started: Array<{ url: string; dest: string; headers?: Record<string, string> }> = [];
  return { started, downloads: { start: vi.fn(async (req) => { started.push(req); return req; }) } as never };
};

const request = { state: 'I was charged twice.', questions: { dept: { type: 'choice' as const, instructions: 'Which team?', criteria: ['billing', 'technical'] } } };

describe('decision models', () => {
  it('downloads a catalog model from the pinned release, every file checked by size and SHA-256', async () => {
    const models = await scratch();
    const { started, downloads } = fakeDownloads();
    const d = createDecisions({ modelsDir: () => models, downloads, daemon: () => undefined, typesafeKey: () => undefined });
    const res = await d.download('laya-en', 'fp16');
    expect(res).toEqual({ ok: true, message: 'Downloading Laya (English) fp16 (0.85 GB).' });
    expect(started.map((r) => r.url)).toEqual([
      'laya-en.tokenizer.json', 'laya-en.tokenizer_config.json', 'laya-en.rl_agent_config.json', 'laya-en.config.json', 'laya-en.model_fp16.onnx',
    ].map((a) => `${DECISION_RELEASE_URL}/${a}`));
    expect(started.map((r) => r.dest)).toEqual(['tokenizer.json', 'tokenizer_config.json', 'rl_agent_config.json', 'config.json', 'model_fp16.onnx'].map((f) => join(models, 'decision', 'laya-en', f)));
    expect(DECISION_RELEASE_URL).toBe('https://github.com/nekko-labs/nekko-agent/releases/download/decision-models-v1');
    for (const entry of DECISION_CATALOG) {
      expect(entry.unavailable).toBeUndefined();
      for (const f of [...entry.variants, ...entry.shared]) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect((await d.download('nope')).ok).toBe(false);
  });

  it('accepts a file only with the published bytes', async () => {
    const dir = await scratch();
    const body = Buffer.from('{"max_len":512}');
    const sha256 = createHash('sha256').update(body).digest('hex');
    const path = join(dir, 'f.part');
    await writeFile(path, body);
    expect(await checkDecisionFile(path, { file: 'f', bytes: body.length, sha256 })).toBeNull();
    expect(await checkDecisionFile(path, { file: 'f', bytes: body.length + 1, sha256 })).toBe('f is not the published size.');
    await writeFile(path, Buffer.from('{"max_len":999}'));
    expect(await checkDecisionFile(path, { file: 'f', bytes: body.length, sha256 })).toBe('f is not the published file (checksum mismatch).');
  });

  it('adds an export folder, lists it with its precisions, and forgets it without touching its files', async () => {
    const models = await scratch();
    const exportDir = await scratch();
    let saved: string[] = [];
    const d = createDecisions({ modelsDir: () => models, downloads: fakeDownloads().downloads, daemon: () => undefined, typesafeKey: () => undefined, folders: () => saved, saveFolders: (x) => { saved = x; } });
    expect((await d.addFolder(exportDir)).ok).toBe(false); // empty: not an export
    await writeFile(join(exportDir, 'model_fp16.onnx'), 'graph');
    await writeFile(join(exportDir, 'model.onnx'), 'graph');
    await writeFile(join(exportDir, 'model.onnx.data'), 'weights');
    await writeFile(join(exportDir, 'tokenizer.json'), '{}');
    await writeFile(join(exportDir, 'rl_agent_config.json'), '{}');
    expect((await d.addFolder(exportDir)).ok).toBe(true);
    expect((await d.addFolder(exportDir)).ok).toBe(true);
    expect(saved).toHaveLength(1); // added once
    const [m] = await d.models();
    expect(m).toMatchObject({ external: true, precisions: ['fp16', 'fp32'] });
    expect((await d.remove(m.id)).ok).toBe(true);
    expect(saved).toEqual([]);
    expect(await readFile(join(exportDir, 'model.onnx'), 'utf8')).toBe('graph');
  });

  it('lists only complete model dirs and refuses ids that escape the folder', async () => {
    const models = await scratch();
    const d = createDecisions({ modelsDir: () => models, downloads: fakeDownloads().downloads, daemon: () => undefined, typesafeKey: () => undefined });
    const dir = join(models, 'decision', 'laya-en');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'model_fp16.onnx'), 'weights');
    expect(await d.models()).toEqual([]); // no tokenizer or config yet
    await writeFile(join(dir, 'tokenizer.json'), '{}');
    await writeFile(join(dir, 'rl_agent_config.json'), '{}');
    const [m] = await d.models();
    expect(m).toMatchObject({ id: 'laya-en', name: 'Laya (English)', precisions: ['fp16'] });
    await expect(d.remove('../../etc')).rejects.toThrow(/not a decision model id/);
  });

  it('runs locally through the daemon, and says why when there is no daemon', async () => {
    const models = await scratch();
    const daemon = { decideRun: vi.fn(async () => ({ model: 'laya-en', answers: { dept: { type: 'choice', choice: 'billing' } } })) } as unknown as EngineDaemon;
    const d = createDecisions({ modelsDir: () => models, downloads: fakeDownloads().downloads, daemon: () => daemon, typesafeKey: () => undefined });
    const res = await d.run('local', request);
    expect(res).toMatchObject({ provider: 'local', model: 'laya-en', answers: { dept: { choice: 'billing' } } });
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);

    const none = createDecisions({ modelsDir: () => models, downloads: fakeDownloads().downloads, daemon: () => undefined, typesafeKey: () => undefined });
    await expect(none.run('local', request)).rejects.toThrow(/engine daemon/);
    expect((await none.status()).local.available).toBe(false);
    await expect(none.run('local', { state: '', questions: {} })).rejects.toThrow(/state is empty/);
  });

  it('calls TypeSafe with the key and jev-latest, and reports its errors', async () => {
    const models = await scratch();
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/models')) return new Response('{}', { status: 401 });
      expect(url).toBe('https://api.typesafe.ai/v1/systemone');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer ts-key');
      const body = JSON.parse(String(init?.body));
      if (body.state === 'boom') return new Response(JSON.stringify({ error: { message: 'bad question' } }), { status: 400 });
      expect(body.model).toBe('jev-latest');
      return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { dept: { type: 'choice', choice: 'billing' } } }));
    }) as unknown as typeof globalThis.fetch;
    const d = createDecisions({ modelsDir: () => models, downloads: fakeDownloads().downloads, daemon: () => undefined, typesafeKey: () => 'ts-key', fetch });
    expect(await d.run('typesafe', request)).toMatchObject({ provider: 'typesafe', model: 'jev-1.13.0' });
    await expect(d.run('typesafe', { ...request, state: 'boom' })).rejects.toThrow('TypeSafe answered 400: bad question');
    expect(await d.checkTypesafe()).toEqual({ ok: false, message: 'TypeSafe rejected the key.' });
    const keyless = createDecisions({ modelsDir: () => models, downloads: fakeDownloads().downloads, daemon: () => undefined, typesafeKey: () => undefined, fetch });
    await expect(keyless.run('typesafe', request)).rejects.toThrow(/TypeSafe API key/);
  });
it('fetches DirectML only on a Windows whose own copy is too old, and still loads on the CPU when that fails', async () => {
    const models = await scratch();
    const dir = join(models, 'decision', 'laya-en');
    await mkdir(dir, { recursive: true });
    for (const f of ['model_fp16.onnx', 'tokenizer.json', 'rl_agent_config.json']) await writeFile(join(dir, f), '{}');
    let available = true;
    const decideLoad = vi.fn(async (req: Record<string, unknown>) => ({ precision: req.precision, ep: 'cpu' }));
    const daemon = { decideStatus: vi.fn(async () => ({ loaded: false, directml: { available } })), decideLoad } as unknown as EngineDaemon;
    const fetch = vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof globalThis.fetch;
    const make = (platform: NodeJS.Platform) =>
      createDecisions({ modelsDir: () => models, downloads: fakeDownloads().downloads, daemon: () => daemon, typesafeKey: () => undefined, fetch, platform, directmlDir: () => join(models, 'dml') });

    // Windows 11: its own DirectML will do, so nothing is fetched or passed.
    expect((await make('win32').load('laya-en')).ok).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(decideLoad.mock.calls[0][0]).not.toHaveProperty('directml');

    // Windows 10: too old, and the fetch fails; the model loads anyway, and the message says why it is on the CPU.
    available = false;
    const res = await make('win32').load('laya-en');
    expect(res.ok).toBe(true);
    expect(fetch).toHaveBeenCalled();
    expect(res.message).toMatch(/runs on the CPU until DirectML can be fetched/);
    expect(decideLoad.mock.calls[1][0]).not.toHaveProperty('directml');

    // Not Windows: never asked.
    fetch.mockClear();
    await make('linux').load('laya-en');
    expect(fetch).not.toHaveBeenCalled();
  });
});
