import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { expect, it } from 'vitest';
import { createCatalog, CURATED, hfFileUrl, stripFrontMatter } from './catalog.js';

/**
 * The model catalog (`engine:catalog`, `engine:catalogModel`,
 * `engine:catalogDetail`) as the TS host computes it from Hugging Face's
 * answers, which the engine daemon's port (crates/nekko-engine `catalog`) must
 * reproduce as text, key order included, with the same requests. Hugging Face
 * is a scripted fetch here: each URL answers from `HF` (anything else is a
 * 404; `throw` is a network failure). Writes
 * crates/nekko-engine/tests/golden/catalog.json and the starter list the
 * daemon embeds (crates/nekko-engine/src/curated.json); fails if either is
 * stale (rewrite with UPDATE_GOLDEN=1).
 */
const crate = join(__dirname, '..', '..', '..', '..', 'crates', 'nekko-engine');
const golden = join(crate, 'tests', 'golden', 'catalog.json');
const curatedFile = join(crate, 'src', 'curated.json');

const API = 'https://huggingface.co/api';
const tree = (files: Array<[string, number] | [string, number, 'directory']>) =>
  JSON.stringify(files.map(([path, size, type]) => ({ type: type ?? 'file', oid: 'x', size, path })));

const QWEN_TREE = tree([
  ['.gitattributes', 1500],
  ['README.md', 9000],
  ['Qwen3-4B-Q4_K_M.gguf', 2_497_280_000],
  ['Qwen3-4B-Q8_0.gguf', 4_280_000_000],
  ['Qwen3-4B-Q3_K_M.gguf', 2_080_000_000],
  ['Qwen3-4B-BF16.gguf', 8_050_000_000],
  ['Qwen3-4B-IQ4_XS.gguf', 2_270_000_000],
  ['Qwen3-4B-UD-Q4_K_XL.gguf', 2_550_000_000],
  ['mmproj-F16.gguf', 840_000_000],
  ['params', 12],
  ['tokenizer_config.json', 9_700],
  ['config.json', 727],
  ['nested', 0, 'directory'],
  ['nested/tokenizer.json', 11_000_000],
  ['nested/huge/config.json', 70_000_000],
  ['Template.JINJA', 10],
  ['chat_template.jinja', 4_000],
]);

const SPLIT_TREE = tree([
  ['gpt-oss-20b-MXFP4.gguf', 12_100_000_000],
  ['Q8_0/big-Q8_0-00002-of-00003.gguf', 9_000_000_000],
  ['Q8_0/big-Q8_0-00001-of-00003.gguf', 9_000_000_000],
  ['Q8_0/big-Q8_0-00003-of-00003.gguf', 3_000_000_000],
  ['weird-name.gguf', 100],
  ['UPPER.GGUF', 200],
  ['f32/model-f32.gguf', 50],
]);

const MLX_TREE = tree([
  ['config.json', 1_000],
  ['model-00001-of-00002.safetensors', 3_000_000_000],
  ['model-00002-of-00002.safetensors', 1_000_000_000],
  ['model.safetensors.index.json', 60_000],
  ['tokenizer.json', 11_000_000],
  ['tokenizer_config.json', 5_000],
  ['special_tokens_map.json', 600],
  ['README.md', 4_000],
  ['figure.png', 80_000],
  ['sub/config.json', 10],
]);

const BOTH_TREE = tree([
  ['config.json', 900],
  ['model.safetensors', 2_000_000_000],
  ['Model-Q4_K_M.gguf', 1_000_000],
]);

const HF: Record<string, { status: number; body: string } | 'throw'> = {
  [`${API}/models/unsloth/Qwen3-4B-GGUF/tree/main?recursive=true`]: { status: 200, body: QWEN_TREE },
  [`${API}/models/bartowski/Qwen2.5-7B-Instruct-GGUF/tree/main?recursive=true`]: { status: 200, body: tree([['Qwen2.5-7B-Instruct-Q4_K_M.gguf', 4_680_000_000], ['Qwen2.5-7B-Instruct-Q6_K.gguf', 6_250_000_000]]) },
  [`${API}/models/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF/tree/main?recursive=true`]: 'throw',
  [`${API}/models/ggml-org/gpt-oss-20b-GGUF/tree/main?recursive=true`]: { status: 200, body: SPLIT_TREE },
  [`${API}/models/bartowski/google_gemma-3-12b-it-GGUF/tree/main?recursive=true`]: { status: 200, body: '[]' },
  [`${API}/models/CompendiumLabs/bge-small-en-v1.5-gguf/tree/main?recursive=true`]: { status: 200, body: tree([['bge-small-en-v1.5-f16.gguf', 67_000_000], ['bge-small-en-v1.5-q8_0.gguf', 36_000_000]]) },
  [`${API}/models?filter=gguf&search=qwen%20coder%2F%26&sort=downloads&direction=-1&limit=20&full=true`]: {
    status: 200,
    body: JSON.stringify([
      { id: 'unsloth/Qwen3-4B-GGUF', downloads: 120000, likes: 300, lastModified: '2025-05-01T10:00:00.000Z', createdAt: '2025-04-29T00:00:00Z', pipeline_tag: 'text-generation', gated: false, tags: ['gguf', 'base_model:Qwen/Qwen3-4B', 'license:apache-2.0', 'vision'] },
      { modelId: 'ggml-org/gpt-oss-20b-GGUF', downloads: 5, tags: ['gguf'], gated: 'auto', lastModified: 'not a date' },
      { id: 'someone/empty-GGUF', downloads: 1 },
      { downloads: 3 },
      { id: 'noslash', tags: ['embedding'] },
    ]),
  },
  [`${API}/models/noslash/tree/main?recursive=true`]: { status: 200, body: tree([['x-Q4_0.gguf', 10]]) },
  [`${API}/models/someone/empty-GGUF/tree/main?recursive=true`]: { status: 200, body: tree([['README.md', 1]]) },
  [`${API}/models?filter=mlx&pipeline_tag=text-generation&search=llama&sort=downloads&direction=-1&limit=20&full=true`]: {
    status: 200,
    body: JSON.stringify([
      { id: 'mlx-community/Llama-3.2-3B-Instruct-4bit', downloads: 900, tags: ['mlx', 'safetensors'] },
      { id: 'someone/both-GGUF', tags: ['mlx'] },
      { id: 'other/plain', tags: [] },
    ]),
  },
  [`${API}/models/mlx-community/Llama-3.2-3B-Instruct-4bit/tree/main?recursive=true`]: { status: 200, body: MLX_TREE },
  [`${API}/models/someone/both-GGUF/tree/main?recursive=true`]: { status: 200, body: BOTH_TREE },
  [`${API}/models/other/plain/tree/main?recursive=true`]: { status: 200, body: MLX_TREE },
  [`${API}/models?filter=gguf&search=broken&sort=downloads&direction=-1&limit=20&full=true`]: { status: 500, body: 'down' },
  [`${API}/models/unsloth/Qwen3-4B-GGUF`]: {
    status: 200,
    body: JSON.stringify({ id: 'unsloth/Qwen3-4B-GGUF', downloads: 120000, likes: 300, lastModified: '2025-05-01T10:00:00.000Z', pipeline_tag: 'text-generation', tags: ['gguf', 'base_model:quantized:Qwen/Qwen3-4B', 'license:apache-2.0', 'reasoning'], cardData: { summary: 'Small model.', license: 'apache-2.0' }, gated: false }),
  },
  [`${API}/models/someone/both-GGUF`]: { status: 200, body: JSON.stringify({ tags: ['mlx'], cardData: { base_model: 'org/base' } }) },
  [`${API}/models/ggml-org/gpt-oss-20b-GGUF`]: 'throw',
  'https://huggingface.co/unsloth/Qwen3-4B-GGUF/raw/main/README.md': { status: 200, body: '---\nlicense: apache-2.0\ntags:\n- gguf\n---\n\n# Qwen3 4B\n\nA model card.\n' },
  'https://huggingface.co/ggml-org/gpt-oss-20b-GGUF/raw/main/README.md': { status: 503, body: '' },
  'https://huggingface.co/someone/both-GGUF/raw/main/README.md': 'throw',
};

type Step = { op: 'curated' | 'search' | 'model' | 'detail' | 'companions'; args: unknown[]; mlx: boolean; token: string | null };
const STEPS: Step[] = [
  { op: 'curated', args: [], mlx: false, token: null },
  { op: 'search', args: ['qwen coder/&'], mlx: false, token: 'hf_token' },
  { op: 'search', args: ['  '], mlx: false, token: null },
  { op: 'search', args: ['llama', 20, 'mlx'], mlx: true, token: null },
  { op: 'search', args: ['llama', 20, 'mlx'], mlx: false, token: null },
  { op: 'search', args: ['broken'], mlx: false, token: null },
  { op: 'model', args: ['unsloth/Qwen3-4B-GGUF'], mlx: false, token: null },
  { op: 'model', args: ['someone/both-GGUF'], mlx: true, token: null },
  { op: 'model', args: ['someone/both-GGUF'], mlx: false, token: null },
  { op: 'model', args: ['ggml-org/gpt-oss-20b-GGUF'], mlx: false, token: null },
  { op: 'model', args: ['someone/empty-GGUF'], mlx: false, token: null },
  { op: 'detail', args: ['unsloth/Qwen3-4B-GGUF'], mlx: false, token: 'hf_token' },
  { op: 'detail', args: ['ggml-org/gpt-oss-20b-GGUF'], mlx: false, token: null },
  { op: 'detail', args: ['someone/both-GGUF'], mlx: true, token: null },
  { op: 'detail', args: ['someone/empty-GGUF'], mlx: false, token: null },
  { op: 'companions', args: ['unsloth/Qwen3-4B-GGUF'], mlx: false, token: null },
  { op: 'companions', args: ['nobody/missing'], mlx: false, token: null },
];

const FRONT_MATTER = ['---\na: 1\n---\nbody\n', '---\nunclosed', '  plain text  ', '---\na: 1\n---', '---x\n---\n\ntext', ''];
const FILE_URLS: [string, string][] = [['a/b', 'dir/my file#1?.gguf'], ['org/repo', 'plain.gguf'], ['o/r', 'ünï/çødé.gguf']];

it('the model catalog matches the daemon golden set', async () => {
  const steps = [];
  for (const step of STEPS) {
    const requests: unknown[] = [];
    // A fresh catalog per step: the model cache is per process, not part of the answer.
    const catalog = createCatalog({
      token: () => step.token ?? undefined,
      mlx: () => step.mlx,
      fetch: (async (url: string, init?: RequestInit) => {
        requests.push({ url, headers: init?.headers ?? null });
        const r = HF[url];
        if (r === 'throw') throw new TypeError('fetch failed');
        return new Response(r?.body ?? 'Not found', { status: r?.status ?? 404 });
      }) as typeof fetch,
    });
    const fn = (catalog as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[step.op];
    const out = await fn(...step.args);
    // Requests run concurrently: their order is the scheduler's, their set is the contract.
    requests.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    steps.push({ ...step, out: JSON.stringify(out ?? null), requests });
  }
  const out = {
    hf: HF,
    steps,
    frontMatter: FRONT_MATTER.map((input) => ({ input, out: stripFrontMatter(input) })),
    fileUrls: FILE_URLS.map(([repo, file]) => ({ repo, file, url: hfFileUrl(repo, file) })),
  };
  if (process.env.UPDATE_GOLDEN) {
    mkdirSync(dirname(golden), { recursive: true });
    writeFileSync(golden, `${JSON.stringify(out, null, 1)}\n`);
    writeFileSync(curatedFile, `${JSON.stringify(CURATED, null, 1)}\n`);
  }
  expect(JSON.parse(readFileSync(golden, 'utf8'))).toEqual(out);
  expect(JSON.parse(readFileSync(curatedFile, 'utf8'))).toEqual(CURATED);
});
