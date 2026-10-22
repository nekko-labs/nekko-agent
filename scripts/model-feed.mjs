// Builds the model recommendations feed the daemon ships
// (`crates/nekko-machine/src/model-feed.json`) from its editorial source
// (`crates/nekko-machine/feed/source.json`).
//
// The source says which models, in what order, for which task. Everything
// about a file comes from the file: its size from Hugging Face's tree, and its
// geometry and per-token read from the GGUF header, fetched with HTTP range
// requests (the first few MB, never the weights). The app never runs this:
// it reads the result, offline.
//
//   node scripts/model-feed.mjs            rewrite the feed
//   node scripts/model-feed.mjs --keep     reuse unchanged models' file data
//   node scripts/model-feed.mjs --dry-run  print it instead

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SOURCE = 'crates/nekko-machine/feed/source.json';
const OUT = 'crates/nekko-machine/src/model-feed.json';
const HF = 'https://huggingface.co';

/* ------------------------------------------------------------ GGUF header */

/** Bytes too short for the whole header: fetch more and parse again. */
export class Truncated extends Error {}

/**
 * The GGUF header: its key/value metadata and tensor table. Throws `Truncated`
 * when `buf` ends inside the header, so the caller can fetch a longer prefix.
 */
export function parseGgufHeader(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let at = 0;
  const need = n => {
    if (at + n > buf.byteLength) throw new Truncated();
  };
  const u32 = () => (need(4), (at += 4), view.getUint32(at - 4, true));
  const u64 = () => (need(8), (at += 8), Number(view.getBigUint64(at - 8, true)));
  const str = () => {
    const n = u64();
    need(n);
    at += n;
    return new TextDecoder().decode(buf.subarray(at - n, at));
  };
  const SIZES = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
  const scalar = type => {
    need(SIZES[type]);
    const o = at;
    at += SIZES[type];
    switch (type) {
      case 0: return view.getUint8(o);
      case 1: return view.getInt8(o);
      case 2: return view.getUint16(o, true);
      case 3: return view.getInt16(o, true);
      case 4: return view.getUint32(o, true);
      case 5: return view.getInt32(o, true);
      case 6: return view.getFloat32(o, true);
      case 7: return view.getUint8(o) !== 0;
      case 10: return Number(view.getBigUint64(o, true));
      case 11: return Number(view.getBigInt64(o, true));
      case 12: return view.getFloat64(o, true);
    }
  };
  const value = type => {
    if (type === 8) return str();
    if (type === 9) {
      const inner = u32();
      const n = u64();
      // Short scalar arrays are per-layer settings and are kept; the long
      // ones are the tokenizer's vocabulary, skipped with only their length.
      if (SIZES[inner] && n <= 4096) return Array.from({ length: n }, () => scalar(inner));
      if (inner === 8) for (let i = 0; i < n; i++) str();
      else if (SIZES[inner]) (need(SIZES[inner] * n), (at += SIZES[inner] * n));
      else throw new Error(`GGUF array of type ${inner}`);
      return { length: n };
    }
    if (!(type in SIZES)) throw new Error(`GGUF value of type ${type}`);
    return scalar(type);
  };

  if (u32() !== 0x46554747) throw new Error('Not a GGUF file');
  const version = u32();
  if (version < 2 || version > 3) throw new Error(`GGUF version ${version}`);
  const tensorCount = u64();
  const kvCount = u64();
  const meta = {};
  for (let i = 0; i < kvCount; i++) {
    const key = str();
    meta[key] = value(u32());
  }
  const tensors = [];
  for (let i = 0; i < tensorCount; i++) {
    const name = str();
    const dims = [];
    for (let d = u32(); d > 0; d--) dims.push(u64());
    const type = u32();
    tensors.push({ name, dims, type, offset: u64() });
  }
  const alignment = meta['general.alignment'] ?? 32;
  const dataStart = Math.ceil(at / alignment) * alignment;
  return { meta, tensors, dataStart };
}

/** `<arch>.<key>`, the way the engine's planner reads it. */
function archKey(meta, key) {
  const arch = meta['general.architecture'];
  return meta[`${arch}.${key}`];
}

/**
 * The scalars the planner reads from a header, as `nekko-engine`'s `gguf.rs`
 * reads them (the compute-buffer allowance is sized from `layers` and
 * `headDim`), and the expert counts.
 */
export function geometry(meta) {
  const heads = archKey(meta, 'attention.head_count');
  const embedding = archKey(meta, 'embedding_length');
  const keyLength = archKey(meta, 'attention.key_length');
  const headDim = keyLength ?? (embedding && heads ? embedding / heads : undefined);
  return {
    layers: archKey(meta, 'block_count'),
    headDim,
    maxContext: archKey(meta, 'context_length'),
    experts: archKey(meta, 'expert_count'),
    expertsUsed: archKey(meta, 'expert_used_count'),
  };
}

/** How often a layer is sliding-window where the file has a window but no per-layer pattern (llama.cpp's `set_swa_pattern`). */
const SWA_PERIOD = { 'gpt-oss': 2, gemma2: 2, gemma3: 6 };

/**
 * The KV cache per token of context, in f16 bytes, read layer by layer from
 * the tensors rather than from one `head_count_kv x key_length` for all of
 * them, which overstates hybrid and sliding-window models several times over:
 *
 * - a layer with no `attn_k` (a recurrent layer in a hybrid model) keeps no cache;
 * - the last `shared_kv_layers` reuse earlier layers' cache;
 * - a sliding-window layer holds `slidingWindow` tokens (plus a micro-batch) however long the context.
 *
 * A layer with no `attn_v` (keys doubling as values) is counted as storing both.
 */
export function kvGeometry(meta, tensors) {
  const layers = archKey(meta, 'block_count') ?? 0;
  const window = archKey(meta, 'attention.sliding_window');
  const pattern = archKey(meta, 'attention.sliding_window_pattern');
  const shared = archKey(meta, 'attention.shared_kv_layers') ?? 0;
  const period = SWA_PERIOD[meta['general.architecture']];
  const isSwa = i => {
    if (!window) return false;
    if (Array.isArray(pattern)) return !!pattern[i];
    return period ? i % period < period - 1 : false;
  };
  const width = name => tensors.find(t => t.name === name)?.dims[1];
  let full = 0;
  let swa = 0;
  for (let i = 0; i < layers - shared; i++) {
    const k = width(`blk.${i}.attn_k.weight`);
    if (!k) continue;
    const bytes = (k + (width(`blk.${i}.attn_v.weight`) ?? k)) * 2;
    if (isSwa(i)) swa += bytes;
    else full += bytes;
  }
  return { fullBytesPerToken: full, ...(swa ? { swaBytesPerToken: swa, slidingWindow: window } : {}) };
}

/**
 * Bytes one decoded token reads from memory, which is what decode speed is
 * bound by. Each tensor's size is the gap to the next one's offset (the last
 * runs to the end of its file). Embedding tables are row lookups, not full
 * reads, unless the output layer reuses the token embedding. Expert tensors
 * (`*_exps`) are read only for the experts a token is routed to.
 */
export function bytesPerToken(shards, g) {
  let dense = 0;
  let experts = 0;
  const hasOutput = shards.some(s => s.tensors.some(t => t.name === 'output.weight'));
  for (const { tensors, dataStart, fileBytes } of shards) {
    const sorted = [...tensors].sort((a, b) => a.offset - b.offset);
    sorted.forEach((t, i) => {
      const end = i + 1 < sorted.length ? sorted[i + 1].offset : fileBytes - dataStart;
      const size = end - t.offset;
      if (t.name === 'per_layer_token_embd.weight' || (t.name === 'token_embd.weight' && hasOutput)) return;
      if (/_exps\b|_exps\./.test(t.name)) experts += size;
      else dense += size;
    });
  }
  const share = g.experts && g.expertsUsed ? g.expertsUsed / g.experts : 1;
  return Math.round(dense + experts * share);
}

/* ------------------------------------------------------- choosing files */

/**
 * The files one quant needs, from a repo's tree: one GGUF named for the
 * label, or every shard of a split one. `UD-Q4_K_M` never answers for
 * `Q4_K_M`, nor `Q4_K_M` for `UD-Q4_K_M`.
 */
export function quantFiles(tree, label) {
  const ggufs = tree.filter(f => f.type === 'file' && /\.gguf$/i.test(f.path) && !/mmproj|^MTP\/|eagle3/i.test(f.path));
  const re = new RegExp(`(^|[-_./])${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-\\d{5}-of-\\d{5})?\\.gguf$`, 'i');
  const hits = ggufs.filter(f => re.test(f.path) && (label.startsWith('UD-') || !/UD-/i.test(f.path)));
  return hits.sort((a, b) => a.path.localeCompare(b.path));
}

/* ---------------------------------------------------------------- network */

/** `fetch`, waiting out Hugging Face's rate limit a few times. */
async function get(url, headers = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { 'user-agent': 'nekko-agent model-feed', ...headers } });
    if (res.status !== 429 || attempt === 4) return res;
    await new Promise(r => setTimeout(r, 2000 * 2 ** attempt));
  }
}

async function json(url) {
  const res = await get(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function header(repo, file) {
  for (let bytes = 4 << 20; bytes <= 64 << 20; bytes *= 2) {
    const res = await get(`${HF}/${repo}/resolve/main/${file}`, { range: `bytes=0-${bytes - 1}` });
    if (res.status !== 206) throw new Error(`${repo}/${file}: expected a partial response, got HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    try {
      return parseGgufHeader(buf);
    } catch (e) {
      if (!(e instanceof Truncated)) throw e;
    }
  }
  throw new Error(`${repo}/${file}: header longer than 64 MB`);
}

/** A built model entry still describes its source entry: same repo, quants and projector. */
export function sameFiles(built, m) {
  return (
    !!built &&
    built.repo === m.repo &&
    built.quants.map(q => q.label).join() === m.quants.join() &&
    (built.projector?.file ?? null) === (m.projector ?? null)
  );
}

async function build(source, previous) {
  const models = [];
  for (const m of source.models) {
    const kept = previous?.models.find(b => b.id === m.id);
    if (sameFiles(kept, m)) {
      models.push({ ...kept, name: m.name, owner: m.owner });
      continue;
    }
    const tree = await json(`${HF}/api/models/${m.repo}/tree/main?recursive=true`);
    const quants = [];
    let geo;
    for (const label of m.quants) {
      const files = quantFiles(tree, label);
      if (!files.length) throw new Error(`${m.repo}: no file for ${label}`);
      const shards = [];
      for (const f of files) shards.push({ ...(await header(m.repo, f.path)), fileBytes: f.size });
      const g = geometry(shards[0].meta);
      geo ??= { ...g, kv: kvGeometry(shards[0].meta, shards.flatMap(s => s.tensors)) };
      quants.push({
        label,
        files: files.map(f => f.path),
        sizeBytes: files.reduce((s, f) => s + f.size, 0),
        bytesPerToken: bytesPerToken(shards, g),
      });
      console.error(`${m.repo} ${label}: ${files.length} file(s)`);
    }
    let projector;
    if (m.projector) {
      const f = tree.find(t => t.path === m.projector);
      if (!f) throw new Error(`${m.repo}: no ${m.projector}`);
      projector = { file: f.path, sizeBytes: f.size };
    }
    const { experts, expertsUsed, kv, layers, headDim, maxContext } = geo;
    models.push({
      id: m.id,
      repo: m.repo,
      name: m.name,
      owner: m.owner,
      maxContext,
      // `layers` and `headDim` size the compute buffers the way the engine's planner does.
      geometry: { layers, headDim },
      kv,
      ...(experts ? { experts: { total: experts, used: expertsUsed } } : {}),
      quants,
      ...(projector ? { projector } : {}),
    });
  }
  const { $comment, ...hardware } = source.hardware;
  const calibration = Object.fromEntries(Object.entries(source.calibration).filter(([k]) => k !== '$comment'));
  return {
    format: 1,
    version: source.version,
    tasks: source.tasks,
    models,
    hardware,
    calibration,
    measured: source.measured,
  };
}

async function run() {
  const source = JSON.parse(readFileSync(SOURCE, 'utf8'));
  const known = new Set(source.models.map(m => m.id));
  for (const t of source.tasks) for (const c of t.candidates) if (!known.has(c)) throw new Error(`Task ${t.id} names unknown model ${c}`);
  // `--keep`: reuse what the current feed already read for unchanged models,
  // for an edit to ranks, tasks or tables; a release build reads everything again.
  const previous = process.argv.includes('--keep') ? JSON.parse(readFileSync(OUT, 'utf8')) : undefined;
  const feed = await build(source, previous);
  const text = `${JSON.stringify(feed, null, 1)}\n`;
  if (process.argv.includes('--dry-run')) process.stdout.write(text);
  else writeFileSync(OUT, text);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await run();
