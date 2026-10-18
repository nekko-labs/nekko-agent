import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { readdir, rm, stat } from 'fs/promises';
import { join, resolve, sep } from 'path';
import type {
  DecisionCatalogEntry,
  DecisionPrecision,
  DecisionProvider,
  DecisionRequest,
  DecisionResponse,
  DecisionStatus,
  InstalledDecisionModel,
} from '@nekko-agent/shared';
import type { createDownloads } from './download.js';
import { downloadDirectml } from './directml.js';
import type { EngineDaemon } from './daemon.js';

/**
 * Decision models: classifiers that read a state and answer typed questions
 * (`choice`, `score`, `noul`) with calibrated probabilities in one forward
 * pass, instead of generating text.
 *
 * Two providers speak the same request and response (TypeSafe Jev's):
 * - **Local**: Laya, run natively by the engine daemon (`crates/nekko-decide`,
 *   ONNX Runtime on DirectML, CoreML or CUDA). The TS side only fetches its
 *   files and asks the daemon to load and run it, so there is no Python.
 * - **TypeSafe Jev**: the hosted model, reached with the user's API key.
 */

/**
 * Where the exports are fetched from: a release of this repository that is
 * never the latest one (the app's updater reads `releases/latest`), holding
 * ONNX exports of the three Laya checkpoints made and checked by
 * scripts/decision-models/ (see docs/decision-models.md). Every file is pinned
 * by size and SHA-256 below, so a replaced asset is refused, never loaded.
 * The engine daemon's port (crates/nekkod/src/decisions.rs) fetches from the
 * same place, held to this by `decisions.golden.test.ts`.
 */
export const DECISION_RELEASE_URL = 'https://github.com/nekko-labs/nekko-agent/releases/download/decision-models-v1';

const RELEASE = 'nekko-agent decision-models-v1';

/** A checkpoint's tokenizer and configs, as `stage-release.py` printed them. */
const shared = (id: string, files: Array<[file: string, bytes: number, sha256: string]>) =>
  files.map(([file, bytes, sha256]) => ({ file, asset: `${id}.${file}`, bytes, sha256 }));

export const DECISION_CATALOG: DecisionCatalogEntry[] = [
  {
    id: 'laya-en',
    name: 'Laya (English)',
    publisher: 'Convai Innovations',
    license: 'Apache-2.0',
    source: `${RELEASE}, from convaiinnovations/laya@55cf4c4`,
    description:
      'A 395M ModernBERT decision model. Routes, scores and answers yes/no questions about a text or JSON state, with calibrated probabilities, in one pass. 512-token context.',
    variants: [
      { precision: 'fp16', file: 'model_fp16.onnx', asset: 'laya-en.model_fp16.onnx', bytes: 845_901_452, sha256: 'f5adb828cd42bb265da6397c3693256f3c3fd34038a783becb8fb3831f21f03e', recommended: true },
      { precision: 'int8', file: 'model_int8.onnx', asset: 'laya-en.model_int8.onnx', bytes: 612_313_098, sha256: '57556a82d0384335b43831c48921fa8269d7788e06463779b11eda45d1675a58' },
      { precision: 'fp32', file: 'model.onnx', asset: 'laya-en.model.onnx', bytes: 1_688_502_312, sha256: '7fd5d50d5354397ed7aa162cef85254270544812569faa37c19db249d268f360' },
    ],
    shared: shared('laya-en', [
      ['tokenizer.json', 3_583_228, '6c8aaa9a542084f2457eab775d4eeb51f92a70c0fd9de28d5edb0ddec3c08d30'],
      ['tokenizer_config.json', 308, '50044de60daaa73df97d262e15a40d4faf0160e7d742df64b377877a1320dd12'],
      ['rl_agent_config.json', 745, 'ae287b56bbcf5f8c4f4541ae9dfd00c914c4c48b940b8398c3058af37ba92bbd'],
      ['config.json', 2_083, 'bf3ab80598fdccf414855a2ce80f22859e4492d06ca8a62ddd1cfb63972f8979'],
    ]),
  },
  {
    id: 'laya-multilingual',
    name: 'Laya (multilingual)',
    publisher: 'Convai Innovations',
    license: 'Apache-2.0',
    source: `${RELEASE}, from convaiinnovations/laya-multilingual@e4e9ddf`,
    description:
      'A 322M mmBERT decision model for text in 100+ languages, about twice as fast as the English one. Less accurate on English text. 1,024-token context.',
    // No int8: its 256k-token embedding stays fp32, so the int8 file is larger than fp16 and less accurate.
    variants: [
      { precision: 'fp16', file: 'model_fp16.onnx', asset: 'laya-multilingual.model_fp16.onnx', bytes: 646_462_359, sha256: 'd5b9c4cff507b3370ab19c4dcd6302bd529bca8e9adaede6d48e95a2364e6d42', recommended: true },
      { precision: 'fp32', file: 'model.onnx', asset: 'laya-multilingual.model.onnx', bytes: 1_290_294_801, sha256: '6f5a928fe6ab7f9b34fa57b8a29683fbdd13e604cf75b7a0d483bf98760b665e' },
    ],
    shared: shared('laya-multilingual', [
      ['tokenizer.json', 34_363_188, '609d8f4c067cd3950f88594c5a802616cea245823836ef5848ee4fc40aab5b6f'],
      ['tokenizer_config.json', 502, '424b69444bf7b5809dc2cd2e36d0bd71b8055124dd24274d6db3c655d38205e7'],
      ['rl_agent_config.json', 472, '25061739243b617ad88d1219ba6f8a9c86c5881ca28df024fa2d9b3b2fcc30c6'],
      ['config.json', 1_938, '83f6916d13ef0f556ac461f28308dc2bffa7ebeadee8ec9e2db5812020ea5bb4'],
    ]),
  },
  {
    id: 'laya-typed-decisions',
    name: 'Laya (typed decisions)',
    publisher: 'Convai Innovations',
    license: 'Apache-2.0',
    source: `${RELEASE}, from convaiinnovations/laya-typed-decisions@1a793eb`,
    description:
      'The English model fine-tuned on four workflows: invoice processing, security incidents, customer service and agent traces. Much more accurate there, untested elsewhere. 1,024-token context.',
    variants: [
      { precision: 'fp16', file: 'model_fp16.onnx', asset: 'laya-typed-decisions.model_fp16.onnx', bytes: 845_901_452, sha256: '49dfd4f9b0988a921ab387ce136079a00975e682272433832d118070fc2fc729', recommended: true },
      { precision: 'int8', file: 'model_int8.onnx', asset: 'laya-typed-decisions.model_int8.onnx', bytes: 612_313_098, sha256: 'dda81996ba157117d7174cdc82295480c66066e605b3a5314b7faa3fad64279a' },
      { precision: 'fp32', file: 'model.onnx', asset: 'laya-typed-decisions.model.onnx', bytes: 1_688_502_312, sha256: 'c2254b2fa7f90ca6534296ac96ac3d72eb7261e13f4242997db44d7a8d9cf1d3' },
    ],
    shared: shared('laya-typed-decisions', [
      ['tokenizer.json', 3_583_228, '6c8aaa9a542084f2457eab775d4eeb51f92a70c0fd9de28d5edb0ddec3c08d30'],
      ['tokenizer_config.json', 337, '08d4cf3ac4dca381759441b85b91a6d40e688471dcd33d15d6649eb0a9a854d1'],
      ['rl_agent_config.json', 847, 'ebf0cd524d92342a6be5e48e9fca3d7c2babfb5a56ccd79d2171ef5d8c7f7be8'],
      ['config.json', 2_084, '5268d24ad3b77c8151de5dcb0762ba4391619aad9ab0bda33e36fb083cfeae6d'],
    ]),
  },
];

/** The bytes are the published file's: its size, then its SHA-256, streamed. Null when they are. */
export async function checkDecisionFile(path: string, f: { file: string; bytes: number; sha256?: string }): Promise<string | null> {
  if ((await fileSize(path)) !== f.bytes) return `${f.file} is not the published size.`;
  if (!f.sha256) return null;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex') === f.sha256 ? null : `${f.file} is not the published file (checksum mismatch).`;
}

const TYPESAFE_URL = 'https://api.typesafe.ai/v1';
const MODEL_FILES: Record<DecisionPrecision, string[]> = {
  fp16: ['model_fp16.onnx', 'model.fp16.onnx', 'laya.fp16.onnx'],
  fp32: ['model.onnx', 'laya.onnx'],
  int8: ['model_int8.onnx', 'model.int8.onnx', 'laya.int8.onnx'],
};
const MAX_STATE_CHARS = 50_000;
const MAX_QUESTIONS = 64;

/**
 * The request shape both providers share; checked here so neither sees
 * garbage. Pure: the engine daemon's `decide` tool runs the same check
 * (crates/nekko-turn `decide`, held to this by `decide.golden.test.ts`).
 */
export function checkDecisionRequest(request: DecisionRequest): string | null {
  if (!request || typeof request !== 'object') return 'Send a state and at least one question.';
  const state = typeof request.state === 'string' ? request.state : JSON.stringify(request.state ?? '');
  if (!state.trim()) return 'The state is empty.';
  if (state.length > MAX_STATE_CHARS) return `The state is over ${MAX_STATE_CHARS.toLocaleString('en-US')} characters.`;
  const questions = request.questions && typeof request.questions === 'object' ? Object.keys(request.questions) : [];
  if (!questions.length) return 'Ask at least one question.';
  if (questions.length > MAX_QUESTIONS) return `Ask at most ${MAX_QUESTIONS} questions at once.`;
  return null;
}

export interface DecisionsDeps {
  modelsDir: () => string;
  downloads: ReturnType<typeof createDownloads>;
  daemon: () => EngineDaemon | undefined;
  typesafeKey: () => string | undefined;
  /** Export folders the user added. */
  folders?: () => string[];
  saveFolders?: (dirs: string[]) => void;
  fetch?: typeof fetch;
  /** Where the catalog's files are fetched from (`DECISION_RELEASE_URL`; tests use a local server). */
  releaseUrl?: () => string;
  /** Where a downloaded DirectML.dll goes (Windows); without it none is fetched. */
  directmlDir?: () => string;
  platform?: NodeJS.Platform;
}

const fileSize = (path: string) => stat(path).then((s) => (s.isFile() ? s.size : 0)).catch(() => 0);

export function createDecisions(deps: DecisionsDeps) {
  const doFetch = deps.fetch ?? fetch;
  const root = () => join(deps.modelsDir(), 'decision');
  const dirOf = (id: string) => {
    const dir = resolve(root(), id);
    // Ids come from the renderer: never let one name a path outside the folder.
    if (!dir.startsWith(resolve(root()) + sep)) throw new Error('That is not a decision model id.');
    return dir;
  };

  /** A model dir's precisions and size, or null when it is not a complete export. */
  async function inspect(dir: string): Promise<{ precisions: DecisionPrecision[]; sizeBytes: number } | null> {
    const tokenizer = (await fileSize(join(dir, 'tokenizer.json'))) || (await fileSize(join(dir, 'tokenizer', 'tokenizer.json')));
    if (!(await fileSize(join(dir, 'rl_agent_config.json'))) || !tokenizer) return null;
    const precisions: DecisionPrecision[] = [];
    let sizeBytes = 0;
    for (const p of ['fp16', 'int8', 'fp32'] as const) {
      for (const f of MODEL_FILES[p]) {
        // An external-data export keeps its weights beside the graph.
        const size = (await fileSize(join(dir, f))) + (await fileSize(join(dir, `${f}.data`)));
        if (size && (await fileSize(join(dir, f)))) { precisions.push(p); sizeBytes += size; break; }
      }
    }
    return precisions.length ? { precisions, sizeBytes } : null;
  }

  const folderId = (dir: string) => `folder:${resolve(dir)}`;

  async function models(): Promise<InstalledDecisionModel[]> {
    const out: InstalledDecisionModel[] = [];
    for (const dir of deps.folders?.() ?? []) {
      const found = await inspect(dir);
      if (found) out.push({ id: folderId(dir), name: `Laya · ${dir.split(/[\\/]/).filter(Boolean).pop()}`, dir: resolve(dir), ...found, external: true });
    }
    const names = await readdir(root()).catch(() => [] as string[]);
    for (const id of names) {
      const dir = join(root(), id);
      if (!(await fileSize(join(dir, 'rl_agent_config.json'))) || !(await fileSize(join(dir, 'tokenizer.json')))) continue;
      const precisions: DecisionPrecision[] = [];
      let sizeBytes = 0;
      for (const p of ['fp16', 'int8', 'fp32'] as const) {
        for (const f of MODEL_FILES[p]) {
          const size = await fileSize(join(dir, f));
          if (size) { precisions.push(p); sizeBytes += size; break; }
        }
      }
      if (!precisions.length) continue;
      const entry = DECISION_CATALOG.find((c) => c.id === id);
      out.push({ id, name: entry?.name ?? id, dir, precisions, sizeBytes, catalogId: entry?.id });
    }
    return out;
  }

  /**
   * Fetch one precision of a catalog model, plus its tokenizer and config,
   * through the download queue as one group. Each file is checked against its
   * published size and SHA-256 before it is renamed into place; a file already
   * on disk at the published size is kept.
   */
  async function download(catalogId: string, precision: DecisionPrecision = 'fp16'): Promise<{ ok: boolean; message: string }> {
    const entry = DECISION_CATALOG.find((c) => c.id === catalogId);
    const variant = entry?.variants.find((v) => v.precision === precision);
    if (!entry || !variant) return { ok: false, message: 'That decision model is not in the catalog.' };
    if (entry.unavailable) return { ok: false, message: entry.unavailable };
    const dir = dirOf(entry.id);
    const base = deps.releaseUrl?.() ?? DECISION_RELEASE_URL;
    let queued = 0;
    let bytes = 0;
    for (const f of [...entry.shared, variant]) {
      const dest = join(dir, f.file);
      if ((await fileSize(dest)) === f.bytes) continue;
      void deps.downloads.start({
        // Four segments: `finishedModelJobs` follows up three-segment `model:` ids as
        // chat models (turning the model server's autoStart on), which these are not.
        id: `decision:${entry.id}:${f === variant ? precision : 'shared'}:${f.file}`,
        kind: 'model',
        label: `${entry.name} · ${f.file}`,
        target: entry.id,
        url: `${base}/${f.asset ?? f.file}`,
        dest,
        group: `decision:${entry.id}:${precision}`,
        groupLabel: `${entry.name} · ${precision}`,
        file: f.file,
        verify: (part) => checkDecisionFile(part, f),
      });
      queued += 1;
      bytes += f.bytes;
    }
    return queued
      ? { ok: true, message: `Downloading ${entry.name} ${precision} (${(bytes / 1e9).toFixed(2)} GB).` }
      : { ok: true, message: `${entry.name} ${precision} is already downloaded.` };
  }

  /** Point at an export folder the user made or copied; it is read in place, never moved. */
  async function addFolder(path: string): Promise<{ ok: boolean; message: string }> {
    const dir = resolve(String(path ?? '').trim());
    if (!path?.trim()) return { ok: false, message: 'Enter the folder that holds the export.' };
    const found = await inspect(dir);
    if (!found) return { ok: false, message: `${dir} has no complete export: it needs an ONNX model file, tokenizer.json and rl_agent_config.json.` };
    const dirs = deps.folders?.() ?? [];
    if (!dirs.some((d) => resolve(d) === dir)) deps.saveFolders?.([...dirs, dir]);
    return { ok: true, message: `Added ${dir} (${found.precisions.join(', ')}).` };
  }

  async function remove(id: string): Promise<{ ok: boolean; message: string }> {
    if (id.startsWith('folder:')) {
      const dir = id.slice('folder:'.length);
      const daemon = deps.daemon();
      const loaded = daemon ? await daemon.decideStatus().catch(() => null) : null;
      if (loaded?.loaded && loaded.dir && resolve(String(loaded.dir)) === dir) await daemon?.decideUnload();
      deps.saveFolders?.((deps.folders?.() ?? []).filter((d) => resolve(d) !== dir));
      return { ok: true, message: 'Removed the folder from the list. Its files were not touched.' };
    }
    const dir = dirOf(id);
    const daemon = deps.daemon();
    const loaded = daemon ? await daemon.decideStatus().catch(() => null) : null;
    if (loaded?.loaded && loaded.dir && resolve(String(loaded.dir)) === dir) await daemon?.decideUnload();
    await rm(dir, { recursive: true, force: true });
    return { ok: true, message: 'Deleted the decision model.' };
  }

  async function status(): Promise<DecisionStatus> {
    const daemon = deps.daemon();
    const typesafe = { configured: Boolean(deps.typesafeKey()) };
    if (!daemon) {
      return { local: { available: false, loaded: false, reason: 'Local decision models run in the desktop app\'s engine daemon.' }, typesafe };
    }
    const s = await daemon.decideStatus().catch((e: Error) => ({ loaded: false, error: e.message }) as Record<string, unknown>);
    return {
      local: {
        available: true,
        loaded: Boolean(s.loaded),
        model: s.model as string | undefined,
        dir: s.dir as string | undefined,
        ep: s.ep as string | undefined,
        precision: s.precision as DecisionPrecision | undefined,
        loadMs: s.loadMs as number | undefined,
        reason: s.error as string | undefined,
      },
      typesafe,
    };
  }

  async function load(id: string, precision?: DecisionPrecision): Promise<{ ok: boolean; message: string }> {
    const daemon = deps.daemon();
    if (!daemon) return { ok: false, message: 'Local decision models run in the desktop app\'s engine daemon.' };
    const model = (await models()).find((m) => m.id === id);
    if (!model) return { ok: false, message: 'That decision model is not downloaded.' };
    try {
      const dml = await directmlFor(daemon);
      const s = await daemon.decideLoad({
        dir: model.dir,
        precision: precision ?? model.precisions[0],
        name: model.external ? 'laya' : model.id,
        ...(dml.path ? { directml: dml.path } : {}),
      });
      const loaded = `Loaded ${model.name} (${s.precision ?? precision ?? model.precisions[0]}) on ${s.ep ?? 'the CPU'}${s.loadMs ? ` in ${(Number(s.loadMs) / 1000).toFixed(1)} s` : ''}.`;
      return { ok: true, message: dml.note ? `${loaded} ${dml.note}` : loaded };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  /**
   * The DirectML.dll to hand the daemon. Windows 11's own copy is new enough,
   * and then this is nothing; Windows 10's is not, and then the copy fetched
   * once from Microsoft (about 9 MB, see directml.ts) is used, fetched now if
   * need be. A failed fetch is a note, not a failure: the model still loads,
   * on the CPU.
   */
  async function directmlFor(daemon: EngineDaemon): Promise<{ path?: string; note?: string }> {
    if ((deps.platform ?? process.platform) !== 'win32' || !deps.directmlDir) return {};
    const s = await daemon.decideStatus().catch(() => null);
    const dml = s?.directml as { available?: boolean } | undefined;
    if (!dml || dml.available) return {};
    try {
      return { path: await downloadDirectml(deps.directmlDir(), { fetch: deps.fetch }) };
    } catch (e) {
      return { note: `${(e as Error).message} It runs on the CPU until DirectML can be fetched.` };
    }
  }

  async function unload(): Promise<{ ok: boolean; message: string }> {
    const daemon = deps.daemon();
    if (daemon) await daemon.decideUnload();
    return { ok: true, message: 'Unloaded the decision model.' };
  }

  async function run(provider: DecisionProvider, request: DecisionRequest): Promise<DecisionResponse> {
    const problem = checkDecisionRequest(request);
    if (problem) throw new Error(problem);
    const started = Date.now();
    if (provider === 'local') {
      const daemon = deps.daemon();
      if (!daemon) throw new Error('Local decision models run in the desktop app\'s engine daemon.');
      const res = await daemon.decideRun(request);
      return { ...res, provider: 'local', latencyMs: Date.now() - started };
    }
    const key = deps.typesafeKey();
    if (!key) throw new Error('Add a TypeSafe API key to use Jev.');
    const res = await doFetch(`${TYPESAFE_URL}/systemone`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request, model: request.model || 'jev-latest' }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* reported below */ }
    if (!res.ok) {
      const message = (body as { error?: { message?: string } | string } | null)?.error;
      throw new Error(`TypeSafe answered ${res.status}: ${typeof message === 'string' ? message : message?.message ?? text.slice(0, 200)}`);
    }
    return { ...(body as DecisionResponse), provider: 'typesafe', latencyMs: Date.now() - started };
  }

  /** A key check that costs nothing: TypeSafe's model list. */
  async function checkTypesafe(): Promise<{ ok: boolean; message: string }> {
    const key = deps.typesafeKey();
    if (!key) return { ok: false, message: 'No TypeSafe API key is set.' };
    const res = await doFetch(`${TYPESAFE_URL}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) }).catch((e: Error) => e);
    if (res instanceof Error) return { ok: false, message: `Could not reach TypeSafe: ${res.message}` };
    if (res.status === 401 || res.status === 403) return { ok: false, message: 'TypeSafe rejected the key.' };
    if (!res.ok) return { ok: false, message: `TypeSafe answered ${res.status}.` };
    const body = (await res.json().catch(() => null)) as { data?: Array<{ id: string }> } | null;
    const ids = body?.data?.map((m) => m.id) ?? [];
    return { ok: true, message: ids.length ? `Key works. Models: ${ids.join(', ')}.` : 'Key works.' };
  }

  return { catalog: async () => DECISION_CATALOG, models, download, addFolder, remove, status, load, unload, run, checkTypesafe };
}
