import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterAll, expect, it, vi } from 'vitest';
import { defaultContextTokens, modelModality, type HardwareFacts, type LocalModel, type ModelFolder } from '@nekko-agent/shared';
import { companionsDir } from './companions.js';
import { folderId, knownFolderCandidates } from './folders.js';
import { readGgufMetadata } from './gguf.js';
import { folderReport, gpuFitFor, seedFolderList } from './index.js';
import { createLibrary } from './library.js';

/**
 * The model library (`engine:models`, `engine:importModel`,
 * `engine:deleteModel`, `engine:saveModelPreset`, `engine:folders`) as the TS
 * host computes it, which the engine daemon's port (crates/nekko-engine
 * `library`) must reproduce as text, key order included: the GGUF header
 * reader, the modality guess, the other apps' folder layouts, the library's
 * reconciliation of `library.json` against a fixture tree (our folder, LM
 * Studio's, a Hugging Face cache, Ollama's manifests and blobs, an MLX
 * folder), imports, deletes, presets, the folder report, the first-start seed
 * and the GPU-fit verdict. Paths are recorded below `<root>` with `/`
 * separators. Writes crates/nekko-engine/tests/golden/library.json; fails if
 * it is stale (rewrite with UPDATE_GOLDEN=1).
 */
const golden = join(__dirname, '..', '..', '..', '..', 'crates', 'nekko-engine', 'tests', 'golden', 'library.json');

const NOW = 1_700_000_000_000;

/* ---------------------------------------------------------------- GGUF */

type Typed =
  | { type: 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32' | 'f32' | 'bool' | 'u64' | 'i64' | 'f64'; value: number }
  | { type: 'string'; value: string }
  | { type: 'strings'; value: string[] }
  | { type: 'u32s'; value: number[] }
  | { type: 'vocab'; count: number; prefix: string };

type GgufSpec = { pairs: Array<[string, Typed]>; version?: number; magic?: number; truncate?: number } | { hex: string };

const TAG: Record<string, number> = { u8: 0, i8: 1, u16: 2, i16: 3, u32: 4, i32: 5, f32: 6, bool: 7, string: 8, u64: 10, i64: 11, f64: 12 };

function ggufString(s: string): Buffer {
  const bytes = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(bytes.length), 0);
  return Buffer.concat([len, bytes]);
}

function scalar(type: string, value: number): Buffer {
  const b = Buffer.alloc(8);
  switch (type) {
    case 'u8': case 'bool': b.writeUInt8(value, 0); return b.subarray(0, 1);
    case 'i8': b.writeInt8(value, 0); return b.subarray(0, 1);
    case 'u16': b.writeUInt16LE(value, 0); return b.subarray(0, 2);
    case 'i16': b.writeInt16LE(value, 0); return b.subarray(0, 2);
    case 'u32': b.writeUInt32LE(value, 0); return b.subarray(0, 4);
    case 'i32': b.writeInt32LE(value, 0); return b.subarray(0, 4);
    case 'f32': b.writeFloatLE(value, 0); return b.subarray(0, 4);
    case 'u64': b.writeBigUInt64LE(BigInt(value), 0); return b;
    case 'i64': b.writeBigInt64LE(BigInt(value), 0); return b;
    case 'f64': b.writeDoubleLE(value, 0); return b;
  }
  throw new Error(type);
}

function u32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}

function u64le(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n), 0);
  return b;
}

function encode(v: Typed): Buffer {
  switch (v.type) {
    case 'string': return Buffer.concat([u32le(8), ggufString(v.value)]);
    case 'strings': return Buffer.concat([u32le(9), u32le(8), u64le(v.value.length), ...v.value.map(ggufString)]);
    case 'vocab': {
      const items: Buffer[] = [];
      for (let i = 0; i < v.count; i++) items.push(ggufString(`${v.prefix}${i}`));
      return Buffer.concat([u32le(9), u32le(8), u64le(v.count), ...items]);
    }
    case 'u32s': return Buffer.concat([u32le(9), u32le(4), u64le(v.value.length), ...v.value.map((n) => scalar('u32', n))]);
    default: return Buffer.concat([u32le(TAG[v.type]), scalar(v.type, v.value)]);
  }
}

function build(spec: GgufSpec): Buffer {
  if ('hex' in spec) return Buffer.from(spec.hex, 'hex');
  const head = Buffer.alloc(24);
  head.writeUInt32LE(spec.magic ?? 0x46554747, 0);
  head.writeUInt32LE(spec.version ?? 3, 4);
  head.writeBigUInt64LE(0n, 8);
  head.writeBigUInt64LE(BigInt(spec.pairs.length), 16);
  const out = Buffer.concat([head, ...spec.pairs.flatMap(([k, v]) => [ggufString(k), encode(v)]), Buffer.alloc(64)]);
  return spec.truncate !== undefined ? out.subarray(0, spec.truncate) : out;
}

const s = (value: string): Typed => ({ type: 'string', value });
const u = (value: number): Typed => ({ type: 'u32', value });

const LLAMA: Array<[string, Typed]> = [
  ['general.architecture', s('llama')],
  ['general.name', s('Llama Test 8B')],
  ['general.file_type', u(15)],
  ['general.size_label', s('8B')],
  ['llama.block_count', u(32)],
  ['llama.attention.head_count', u(32)],
  ['llama.attention.head_count_kv', u(8)],
  ['llama.embedding_length', u(4096)],
  ['llama.context_length', u(131072)],
  ['tokenizer.chat_template', s('{{ messages }}')],
];

const GGUF: Record<string, GgufSpec> = {
  llama: { pairs: LLAMA },
  v2: { pairs: LLAMA, version: 2 },
  v1: { pairs: LLAMA, version: 1 },
  v4: { pairs: LLAMA, version: 4 },
  badMagic: { pairs: LLAMA, magic: 0x46554748 },
  keyLength: { pairs: [['general.architecture', s('gemma3')], ['gemma3.attention.head_count', u(16)], ['gemma3.embedding_length', u(2560)], ['gemma3.attention.key_length', u(256)], ['general.file_type', u(7)]] },
  noKvHeads: { pairs: [['general.architecture', s('phi')], ['phi.attention.head_count', u(32)], ['phi.embedding_length', u(3000)], ['general.file_type', u(99)]] },
  oddRatio: { pairs: [['general.architecture', s('x')], ['x.attention.head_count', u(3)], ['x.embedding_length', u(100)]] },
  fileType0: { pairs: [['general.file_type', u(0)], ['general.name', s('   ')]] },
  floats: { pairs: [['general.architecture', s('f')], ['f.block_count', { type: 'f32', value: 12.5 }], ['f.context_length', { type: 'f64', value: 4096.25 }], ['general.file_type', { type: 'f32', value: 1.5 }]] },
  ints: { pairs: [['a.block_count', { type: 'u8', value: 7 }], ['a.attention.head_count', { type: 'i8', value: -3 }], ['a.attention.head_count_kv', { type: 'u16', value: 4 }], ['a.embedding_length', { type: 'i16', value: 512 }], ['a.context_length', { type: 'i32', value: 2048 }], ['general.file_type', { type: 'bool', value: 1 }], ['general.architecture', s('a')]] },
  wide: { pairs: [['b.block_count', { type: 'u64', value: 9007199254740993 }], ['b.context_length', { type: 'i64', value: -5 }], ['b.attention.head_count', { type: 'i64', value: 40 }]] },
  arrays: { pairs: [['general.architecture', s('qwen3')], ['tokenizer.ggml.tokens', { type: 'strings', value: ['<s>', '</s>', 'héllo'] }], ['tokenizer.ggml.types', { type: 'u32s', value: [1, 2, 3] }], ['qwen3.block_count', u(36)]] },
  duplicates: { pairs: [['general.architecture', s('one')], ['x.block_count', u(10)], ['general.architecture', s('two')], ['y.block_count', u(20)], ['x.block_count', u(30)]] },
  suffixFirst: { pairs: [['p.context_length', s('not a number')], ['q.context_length', u(8192)]] },
  exactWins: { pairs: [['z.block_count', u(5)], ['block_count', u(6)]] },
  emptyStrings: { pairs: [['general.architecture', s('')], ['general.name', s('')], ['general.size_label', s('')]] },
  truncatedPair: { pairs: LLAMA, truncate: 120 },
  truncatedHeader: { pairs: LLAMA, truncate: 20 },
  bigVocab: { pairs: [['general.architecture', s('qwen2')], ['tokenizer.ggml.tokens', { type: 'vocab', count: 260_000, prefix: 'token-number-' }], ['qwen2.block_count', u(28)], ['qwen2.context_length', u(32768)]] },
  hugeVocab: { pairs: [['general.architecture', s('qwen2')], ['tokenizer.ggml.tokens', { type: 'vocab', count: 760_000, prefix: 'token-number-' }], ['qwen2.block_count', u(28)]] },
  // One pair whose type tag is unknown: the reader cannot tell where the next starts.
  unknownType: { hex: '47475546' + '03000000' + '0000000000000000' + '0100000000000000' + '0100000000000000' + '78' + '63000000' + '00000000' },
  // A key whose length is past 64 MB.
  hugeString: { hex: '47475546' + '03000000' + '0000000000000000' + '0100000000000000' + '0000000500000000' + '00' },
  // A pair count past the cap.
  tooManyPairs: { hex: '47475546' + '03000000' + '0000000000000000' + 'a186010000000000' },
  // An array of arrays.
  nestedArray: { hex: '47475546' + '03000000' + '0000000000000000' + '0100000000000000' + '0100000000000000' + '61' + '09000000' + '09000000' + '0100000000000000' },
  // An array count past 2^53.
  hugeArray: { hex: '47475546' + '03000000' + '0000000000000000' + '0100000000000000' + '0100000000000000' + '61' + '09000000' + '04000000' + 'ffffffffffffff7f' },
  // An array count of fixed-width elements longer than any read.
  longArray: { hex: '47475546' + '03000000' + '0000000000000000' + '0100000000000000' + '0100000000000000' + '61' + '09000000' + '04000000' + '0000000001000000' },
  // Invalid UTF-8 in a value.
  badUtf8: { hex: '47475546' + '03000000' + '0000000000000000' + '0100000000000000' + '0c00000000000000' + Buffer.from('general.name').toString('hex') + '08000000' + '0500000000000000' + '61ff62c3' + '63' + '00'.repeat(32) },
  tiny: { hex: '4747554603000000' },
};

/* ------------------------------------------------------- the fixture tree */

type FileSpec = { gguf: GgufSpec } | { text: string } | { size: number };

const meta = (arch: string, name: string | undefined, extra: Array<[string, Typed]> = []): FileSpec => ({
  gguf: {
    pairs: [
      ['general.architecture', s(arch)],
      ...(name ? ([['general.name', s(name)]] as Array<[string, Typed]>) : []),
      ['general.file_type', u(15)],
      [`${arch}.block_count`, u(28)],
      [`${arch}.attention.head_count`, u(16)],
      [`${arch}.attention.head_count_kv`, u(8)],
      [`${arch}.embedding_length`, u(2048)],
      [`${arch}.context_length`, u(40960)],
      ...extra,
    ],
  },
});

const TREE: Record<string, FileSpec> = {
  'models/chat/unsloth_qwen3-4b-gguf/qwen3-4b-q4_k_m.gguf': meta('qwen3', 'Qwen3 4B', [['general.size_label', s('4B')], ['tokenizer.chat_template', s('{{x}}')]]),
  'models/vision/ggml-org_gemma-3-4b-it-gguf/gemma-3-4b-it-q4_k_m.gguf': meta('gemma3', 'Gemma 3 4B'),
  'models/vision/ggml-org_gemma-3-4b-it-gguf/mmproj-gemma-3-4b-it-f16.gguf': meta('clip', 'projector'),
  'models/chat/big/big-q8-00001-of-00002.gguf': meta('llama', 'Big'),
  'models/chat/big/big-q8-00002-of-00002.gguf': { size: 100 },
  'models/chat/big/big-q8.chat_template.jinja': { text: '{{x}}' },
  'models/loose.gguf': meta('llama', undefined),
  'models/broken.gguf': { text: 'not a gguf at all' },
  'models/empty.gguf': { size: 0 },
  'models/whisper-small.gguf': { text: 'lmgg old ggml whisper' },
  'models/notes.txt': { text: 'hello' },
  'models/embed/bge-small-en-v1.5-f16.gguf': meta('bert', 'bge small'),
  'models/image/sd/sd3.5-medium-q4.gguf': meta('sd3', 'SD 3.5 Medium'),
  'models/draft/eagle-head.gguf': meta('eagle', 'Eagle head'),
  'models/a/b/c/deep.gguf': meta('llama', 'Deep'),
  'models/a/b/c/d/deeper.gguf': meta('llama', 'Deeper'),
  'models/mlx/mlx-community_qwen3-0.6b-4bit/config.json': { text: JSON.stringify({ model_type: 'qwen3', quantization: { group_size: 64, bits: 4 }, max_position_embeddings: 40960 }) },
  'models/mlx/mlx-community_qwen3-0.6b-4bit/model.safetensors': { size: 1000 },
  'models/mlx/mlx-community_qwen3-0.6b-4bit/model-2.safetensors': { size: 24 },
  'models/mlx/plain-checkpoint/config.json': { text: JSON.stringify({ model_type: 'llama' }) },
  'models/mlx/plain-checkpoint/model.safetensors': { size: 10 },
  'lmstudio/lmstudio-community/qwen3-8b-gguf/qwen3-8b-q4_k_m.gguf': meta('qwen3', 'Qwen3 8B'),
  'lmstudio/lmstudio-community/qwen3-8b-gguf/mmproj-model-f16.gguf': meta('clip', 'mm'),
  'lmstudio/lmstudio-community/vlm-mlx/config.json': { text: JSON.stringify({ model_type: 'qwen2_5_vl', vision_config: { depth: 1 }, text_config: { max_position_embeddings: 128000 } }) },
  'lmstudio/lmstudio-community/vlm-mlx/weights.safetensors': { size: 500 },
  'lmstudio/blobs/hidden.gguf': meta('llama', 'Hidden'),
  'hf/models--org--repo/snapshots/abc123/model-q4.gguf': meta('mistral', 'Mistral'),
  'ollama/manifests/registry.ollama.ai/library/llama3.2/latest': { text: JSON.stringify({ layers: [{ mediaType: 'application/vnd.ollama.image.template', digest: 'sha256:ttt' }, { mediaType: 'application/vnd.ollama.image.model', digest: 'sha256:aaa', size: 1 }] }) },
  'ollama/manifests/hf.co/user/repo/q4_k_m': { text: JSON.stringify({ layers: [{ mediaType: 'application/vnd.ollama.image.model', digest: 'sha256:bbb' }] }) },
  'ollama/manifests/registry.ollama.ai/library/missing/latest': { text: JSON.stringify({ layers: [{ mediaType: 'application/vnd.ollama.image.model', digest: 'sha256:zzz' }] }) },
  'ollama/manifests/registry.ollama.ai/library/bad/latest': { text: '{not json' },
  'ollama/blobs/sha256-aaa': meta('llama', 'Llama 3.2 3B'),
  'ollama/blobs/sha256-bbb': meta('qwen2', 'Repo'),
  'disabled/off.gguf': meta('llama', 'Off'),
  'outside/ext.gguf': meta('llama', 'External'),
  'outside/bad.gguf': { text: 'nope' },
  'home/.lmstudio/models/pub/repo/thing.gguf': meta('llama', 'Thing'),
  'home/.ollama/models/manifests/registry.ollama.ai/library/tiny/latest': { text: JSON.stringify({ layers: [{ mediaType: 'application/vnd.ollama.image.model', digest: 'sha256:ccc' }] }) },
  'home/.ollama/models/blobs/sha256-ccc': meta('llama', 'Tiny'),
  'home/jan/models/empty/readme.txt': { text: 'nothing here' },
  'hfhome/hub/models--a--b/snapshots/1/b.gguf': meta('llama', 'B'),
};

async function writeTree(root: string): Promise<void> {
  for (const [rel, spec] of Object.entries(TREE)) {
    const path = join(root, ...rel.split('/'));
    await mkdir(dirname(path), { recursive: true });
    if ('gguf' in spec) await writeFile(path, build(spec.gguf));
    else if ('text' in spec) await writeFile(path, spec.text);
    else await writeFile(path, Buffer.alloc(spec.size));
  }
  // A projector fetched for `loose`, which lives in our own companions store.
  const fetched = companionsDir(join(root, 'models'), 'loose');
  await mkdir(fetched, { recursive: true });
  await writeFile(join(fetched, 'mmproj-loose-f16.gguf'), build({ pairs: LLAMA }));
}

/** Every string below the root as `<root>/...` with `/` separators. */
function norm(root: string, v: unknown): unknown {
  if (typeof v === 'string') return v.split(root).join('<root>').replace(/\\/g, '/');
  if (Array.isArray(v)) return v.map((x) => norm(root, x));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(root, x)]));
  return v;
}

async function files(root: string, rel: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(join(dir, e.name), `${prefix}${e.name}/`);
      else out.push(`${prefix}${e.name}`);
    }
  };
  await walk(join(root, rel), '');
  return out.sort();
}

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

it('matches the library golden set the engine daemon replays', { timeout: 120_000 }, async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  const root = await mkdtemp(join(tmpdir(), 'nekko-lib-golden-'));
  roots.push(root);

  // GGUF headers.
  const gguf: Array<{ name: string; spec: GgufSpec; out: string }> = [];
  for (const [name, spec] of Object.entries(GGUF)) {
    const path = join(root, 'gguf', `${name}.gguf`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, build(spec));
    gguf.push({ name, spec, out: JSON.stringify(await readGgufMetadata(path)) });
  }

  // The modality guess and the default context.
  const modalityInputs: Array<Parameters<typeof modelModality>[0]> = [
    { architecture: 'llama' }, { architecture: 'sd3' }, { architecture: 'SDXL' }, { architecture: 'flux' }, { architecture: 'whisper' },
    { architecture: 'eagle' }, { architecture: 'bert' }, { architecture: 'nomic-bert' }, { architecture: 'gemma3' }, { architecture: 'qwen2vl' },
    { architecture: 'llava' }, { architecture: 'gemma2' }, { architecture: 'qwen3', hasProjector: true },
    { name: 'stable-diffusion-v1-5' }, { name: 'models/flux.1-dev' }, { name: 'bge-small' }, { name: 'my embedding model' }, { name: 'whisper-large' },
    { name: 'qwen2vl-7b' }, { name: 'some vision thing' }, { name: 'plain' }, { name: 'x'.repeat(300) + ' sdxl' }, { name: 'sd3_medium' },
    { name: 'whisper-small', readable: false }, { name: 'random', readable: false }, { name: 'random', readable: false, hasProjector: true },
    { architecture: '', name: 'flux_schnell' }, {},
  ];
  const modality = modalityInputs.map((input) => ({ input, out: modelModality(input) }));
  const contexts = [undefined, 0, -1, 4096, 65_536, 131_072].map((maxContext) => ({ maxContext, out: defaultContextTokens({ maxContext }) }));

  // The other apps' folders, per platform, with and without their env overrides.
  const envKeys = ['USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA', 'OLLAMA_MODELS', 'HF_HOME', 'HUGGINGFACE_HUB_CACHE'] as const;
  const saved = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  const setEnv = (env: Record<string, string>) => {
    for (const k of envKeys) delete process.env[k];
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
  };
  const envCases: Array<Record<string, string>> = [
    { USERPROFILE: '/fakehome', HOME: '/fakehome' },
    { USERPROFILE: '/fakehome', HOME: '/fakehome', LOCALAPPDATA: '/local', APPDATA: '/roaming', OLLAMA_MODELS: '/ollama-here', HF_HOME: '/hf' },
    { USERPROFILE: '/fakehome', HOME: '/fakehome', LOCALAPPDATA: '', OLLAMA_MODELS: '', HUGGINGFACE_HUB_CACHE: '/hub-cache' },
  ];
  const candidates: Array<{ os: string; env: Record<string, string>; out: unknown }> = [];
  try {
    for (const env of envCases) {
      for (const os of ['win32', 'darwin', 'linux'] as const) {
        setEnv(env);
        candidates.push({ os, env, out: norm('\u0000', knownFolderCandidates(os)) });
      }
    }
  } finally {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
  const folderIds = [
    [undefined, 'C:\\Users\\me\\My Models'], [undefined, '/home/me/models/'], [undefined, '///'], ['lmstudio', '/x'],
    [undefined, 'D:\\Ünïcödé\\models-ä'], [undefined, '/a/very/long/path/that/keeps/going/and/going/well/past/forty-eight/characters/models'],
  ].map(([provider, path]) => ({ provider, path, out: folderId(provider as never, path as string) }));
  const companionKeys = ['loose', 'lmstudio/pub/repo/file', 'ünï/çødé', ''].map((id) => ({ id, out: companionsDir('', id).replace(/\\/g, '/') }));

  // The GPU-fit verdict.
  const gpu = (totalGb: number, freeGb: number, unified = false): HardwareFacts => ({
    devices: [{ name: 'GPU', totalBytes: totalGb * 2 ** 30, freeBytes: freeGb * 2 ** 30 }],
    unified,
    systemRamTotalBytes: 64 * 2 ** 30,
    systemRamFreeBytes: 32 * 2 ** 30,
  });
  const cpu: HardwareFacts = { devices: [], unified: false, systemRamTotalBytes: 16 * 2 ** 30, systemRamFreeBytes: 8 * 2 ** 30 };
  const row = (over: Partial<LocalModel>): LocalModel => ({
    id: 'm', name: 'm', path: '/m.gguf', sizeBytes: 4 * 2 ** 30, layers: 32, kvHeads: 8, headDim: 128, maxContext: 32768, addedAt: 0, ...over,
  });
  const fitCases: Array<{ model: LocalModel; hw: HardwareFacts; floor?: number }> = [
    { model: row({}), hw: gpu(24, 20) },
    { model: row({}), hw: gpu(6, 5) },
    { model: row({}), hw: gpu(4, 1) },
    { model: row({ sizeBytes: 80 * 2 ** 30 }), hw: gpu(8, 8) },
    { model: row({}), hw: cpu },
    { model: row({ preset: { gpuLayers: 16 } }), hw: gpu(24, 20) },
    { model: row({ preset: { gpuLayers: 64, contextTokens: 131072, parallelSlots: 4, kvCacheDtype: 'q8_0' } }), hw: gpu(24, 20), floor: 1 << 30 },
    { model: row({ layers: undefined, kvHeads: undefined, headDim: undefined }), hw: gpu(24, 20) },
    { model: row({ format: 'mlx' }), hw: gpu(24, 20) },
    { model: row({ modality: 'image' }), hw: gpu(24, 20) },
    { model: row({ architecture: 'bert' }), hw: gpu(24, 20) },
    { model: row({ architecture: 'whisper' }), hw: gpu(24, 20) },
    { model: row({ maxContext: undefined }), hw: gpu(8, 7, true), floor: 512 * 2 ** 20 },
  ];
  const gpuFit = fitCases.map((c) => ({ ...c, out: gpuFitFor(c.model, c.hw, c.floor) }));

  // The library over the fixture tree.
  await writeTree(root);
  const models = join(root, 'models');
  const folders: ModelFolder[] = [
    { id: 'lmstudio', path: join(root, 'lmstudio'), provider: 'lmstudio', enabled: true },
    { id: 'dir-hf', path: join(root, 'hf'), enabled: true, custom: true },
    { id: 'ollama', path: join(root, 'ollama'), provider: 'ollama', enabled: true },
    { id: 'off', path: join(root, 'disabled'), enabled: false },
    { id: 'gone', path: join(root, 'missingfolder'), enabled: true },
    { id: 'blank', path: '', enabled: true },
    { id: 'dup', path: join(root, 'lmstudio') + '/', provider: 'lmstudio', enabled: true },
  ];
  const library = createLibrary({ modelsDir: () => models, folders: () => folders, mlxRunnable: () => false });
  const steps: Array<{ op: string; args: unknown[]; out: string; index?: string; files?: string[] }> = [];
  const index = async () => {
    const path = join(models, 'library.json');
    // As written, with the paths inside it normalized.
    return existsSync(path) ? JSON.stringify(norm(root, JSON.parse(await readFile(path, 'utf8'))), null, 2) : undefined;
  };
  const step = async (op: string, args: unknown[], run: () => Promise<unknown>, extra: { files?: boolean } = {}) => {
    const out = JSON.stringify(norm(root, (await run()) ?? null));
    steps.push({ op, args: norm(root, args) as unknown[], out, index: await index(), ...(extra.files ? { files: await files(root, 'models') } : {}) });
  };
  const lm = 'lmstudio/lmstudio-community/qwen3-8b-gguf/qwen3-8b-q4_k_m';
  await step('list', [], () => library.list());
  await step('list', [], () => library.list());
  await step('find', ['loose'], () => library.find('loose'));
  await step('find', ['nope'], () => library.find('nope'));
  await step('savePreset', ['loose', { contextTokens: 8192, gpuLayers: 20 }], () => library.savePreset('loose', { contextTokens: 8192, gpuLayers: 20 }));
  await step('savePreset', ['nope', { contextTokens: 1 }], () => library.savePreset('nope', { contextTokens: 1 }));
  await step('list', [], () => library.list());
  await step('importFile', [join(root, 'outside', 'ext.gguf')], () => library.importFile(join(root, 'outside', 'ext.gguf')));
  await step('importFile', [join(root, 'models', 'notes.txt')], () => library.importFile(join(root, 'models', 'notes.txt')));
  await step('importFile', [join(root, 'outside', 'absent.gguf')], () => library.importFile(join(root, 'outside', 'absent.gguf')));
  await step('importFile', [join(root, 'outside', 'bad.gguf')], () => library.importFile(join(root, 'outside', 'bad.gguf')));
  await step('importFile', [join(models, 'chat', 'unsloth_qwen3-4b-gguf', 'qwen3-4b-q4_k_m.gguf')], () => library.importFile(join(models, 'chat', 'unsloth_qwen3-4b-gguf', 'qwen3-4b-q4_k_m.gguf')));
  await step('list', [], () => library.list());
  await step('folderReport', [], () => library.folderReport());
  for (const f of [join(root, 'lmstudio'), join(root, 'ollama'), join(root, 'hf'), join(root, 'missingfolder'), models]) {
    await step('probe', [f, f.endsWith('ollama') ? 'ollama' : undefined], () => library.probe(f, f.endsWith('ollama') ? 'ollama' : undefined));
  }
  await step('remove', [lm], () => library.remove(lm));
  await step('remove', ['nope'], () => library.remove('nope'));
  await step('remove', ['chat/big/big-q8-00001-of-00002'], () => library.remove('chat/big/big-q8-00001-of-00002'), { files: true });
  await step('remove', ['loose'], () => library.remove('loose'), { files: true });
  await rm(join(models, 'vision', 'ggml-org_gemma-3-4b-it-gguf', 'gemma-3-4b-it-q4_k_m.gguf'));
  await step('list', [], () => library.list());

  // The folder report with suggestions, and the first-start seed, from a
  // home and an Ollama override inside the fixture.
  const home = join(root, 'home');
  const env = { USERPROFILE: home, HOME: home, LOCALAPPDATA: join(home, 'local'), APPDATA: join(home, 'roaming'), HF_HOME: join(root, 'hfhome') };
  setEnv(env);
  let suggested: unknown;
  let seeded: unknown;
  try {
    const list = knownFolderCandidates();
    suggested = await folderReport(library as never, list);
    seeded = await seedFolderList(library as never, models, list);
  } finally {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
  steps.push({ op: 'folders', args: [norm(root, env)], out: JSON.stringify(norm(root, suggested)) });
  steps.push({ op: 'seed', args: [norm(root, env)], out: JSON.stringify(norm(root, seeded)) });

  const expected = {
    note: 'Generated by packages/host/src/engine/library.golden.test.ts. Do not edit by hand.',
    platform: process.platform,
    now: NOW,
    gguf,
    modality,
    contexts,
    candidates,
    folderIds,
    companionKeys,
    gpuFit,
    library: { tree: TREE, folders: norm(root, folders), steps },
  };
  const text = `${JSON.stringify(expected, null, 2)}\n`;
  if (process.env.UPDATE_GOLDEN === '1' || !existsSync(golden)) {
    mkdirSync(dirname(golden), { recursive: true });
    writeFileSync(golden, text);
  }
  const stored = JSON.parse(readFileSync(golden, 'utf8'));
  // The generating platform is recorded, not compared: the set holds on every one.
  expect({ ...JSON.parse(text), platform: stored.platform }).toEqual(stored);
});
