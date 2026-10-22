import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Truncated, bytesPerToken, kvGeometry, parseGgufHeader, quantFiles, sameFiles } from './model-feed.mjs';

/** A GGUF v3 header: `meta` as [key, type, value] and tensors as [name, dims, offset]. */
function gguf(meta, tensors) {
  const parts = [];
  const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); parts.push(b); };
  const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); parts.push(b); };
  const str = s => { u64(Buffer.byteLength(s)); parts.push(Buffer.from(s)); };
  u32(0x46554747); u32(3); u64(tensors.length); u64(meta.length);
  for (const [key, type, value] of meta) {
    str(key); u32(type);
    if (type === 4) u32(value);
    else if (type === 8) str(value);
    else if (type === 9) {
      const [inner, items] = value;
      u32(inner); u64(items.length);
      for (const v of items) inner === 8 ? str(v) : (() => { const b = Buffer.alloc(1); b.writeUInt8(v ? 1 : 0); parts.push(b); })();
    }
  }
  for (const [name, dims, offset] of tensors) { str(name); u32(dims.length); dims.forEach(u64); u32(0); u64(offset); }
  return new Uint8Array(Buffer.concat(parts));
}

const META = [
  ['general.architecture', 8, 'toy'],
  ['toy.block_count', 4, 4],
  ['toy.attention.sliding_window', 4, 128],
  ['toy.attention.sliding_window_pattern', 9, [7, [true, false, true, false]]],
  ['tokenizer.ggml.tokens', 9, [8, ['a', 'b', 'c']]],
];

test('reads metadata, keeps short per-layer arrays and skips the vocabulary', () => {
  const h = parseGgufHeader(gguf(META, [['blk.0.attn_k.weight', [64, 32], 0]]));
  assert.equal(h.meta['toy.block_count'], 4);
  assert.deepEqual(h.meta['toy.attention.sliding_window_pattern'], [true, false, true, false]);
  assert.deepEqual(h.tensors[0], { name: 'blk.0.attn_k.weight', dims: [64, 32], type: 0, offset: 0 });
  assert.equal(h.dataStart % 32, 0);
});

test('a prefix that ends inside the header asks for more', () => {
  const buf = gguf(META, [['blk.0.attn_k.weight', [64, 32], 0]]);
  assert.throws(() => parseGgufHeader(buf.subarray(0, buf.length - 3)), Truncated);
  assert.throws(() => parseGgufHeader(new Uint8Array(16)), /Not a GGUF/);
});

test('counts the KV cache per layer: recurrent layers none, sliding layers apart', () => {
  const tensors = [
    { name: 'blk.0.attn_k.weight', dims: [64, 32] },
    { name: 'blk.0.attn_v.weight', dims: [64, 32] },
    // Layer 1: recurrent, no attention.
    { name: 'blk.2.attn_k.weight', dims: [64, 32] },
    { name: 'blk.2.attn_v.weight', dims: [64, 32] },
    // Layer 3: keys double as values.
    { name: 'blk.3.attn_k.weight', dims: [64, 16] },
  ];
  const meta = { 'general.architecture': 'toy', 'toy.block_count': 4, 'toy.attention.sliding_window': 128, 'toy.attention.sliding_window_pattern': [true, false, true, false] };
  assert.deepEqual(kvGeometry(meta, tensors), { fullBytesPerToken: (16 + 16) * 2, swaBytesPerToken: 2 * (32 + 32) * 2, slidingWindow: 128 });
  // The last shared layers keep no cache of their own.
  assert.deepEqual(kvGeometry({ ...meta, 'toy.attention.shared_kv_layers': 1 }, tensors), { fullBytesPerToken: 0, swaBytesPerToken: 2 * (32 + 32) * 2, slidingWindow: 128 });
  // gpt-oss has a window but no pattern: every other layer slides.
  const oss = { 'general.architecture': 'gpt-oss', 'gpt-oss.block_count': 2, 'gpt-oss.attention.sliding_window': 128 };
  const two = [0, 1].flatMap(i => [{ name: `blk.${i}.attn_k.weight`, dims: [8, 4] }, { name: `blk.${i}.attn_v.weight`, dims: [8, 4] }]);
  assert.deepEqual(kvGeometry(oss, two), { fullBytesPerToken: 16, swaBytesPerToken: 16, slidingWindow: 128 });
});

test('a decoded token reads the weights less lookups and unrouted experts', () => {
  const shard = (tensors, fileBytes) => ({ tensors, dataStart: 0, fileBytes });
  const t = (name, offset) => ({ name, offset, dims: [], type: 0 });
  // Sizes by offset gap: embd 100, output 50, experts 400, attn 40 (to the file end).
  const tensors = [t('token_embd.weight', 0), t('output.weight', 100), t('blk.0.ffn_up_exps.weight', 150), t('blk.0.attn_q.weight', 550)];
  assert.equal(bytesPerToken([shard(tensors, 590)], { experts: 8, expertsUsed: 2 }), 50 + 40 + 100);
  // With no output layer the embedding is read in full for the logits.
  const tied = [t('token_embd.weight', 0), t('blk.0.attn_q.weight', 100)];
  assert.equal(bytesPerToken([shard(tied, 140)], {}), 140);
  // Per-layer embeddings are lookups.
  const ple = [t('per_layer_token_embd.weight', 0), t('output.weight', 300)];
  assert.equal(bytesPerToken([shard(ple, 310)], {}), 10);
});

test('picks the files for a quant label and never a near miss', () => {
  const file = path => ({ type: 'file', path, size: 1 });
  const tree = ['m-Q4_K_M.gguf', 'm-UD-Q4_K_M.gguf', 'mmproj-F16.gguf', 'MTP/mtp-m-Q8_0.gguf', 'm-Q8_0-00002-of-00002.gguf', 'm-Q8_0-00001-of-00002.gguf'].map(file);
  assert.deepEqual(quantFiles(tree, 'Q4_K_M').map(f => f.path), ['m-Q4_K_M.gguf']);
  assert.deepEqual(quantFiles(tree, 'UD-Q4_K_M').map(f => f.path), ['m-UD-Q4_K_M.gguf']);
  assert.deepEqual(quantFiles(tree, 'Q8_0').map(f => f.path), ['m-Q8_0-00001-of-00002.gguf', 'm-Q8_0-00002-of-00002.gguf']);
  assert.deepEqual(quantFiles(tree, 'Q6_K'), []);
});

test('reuses a built model only while its files are the same', () => {
  const built = { repo: 'o/m', quants: [{ label: 'Q8_0' }, { label: 'Q4_K_M' }], projector: { file: 'mmproj-F16.gguf' } };
  const source = { repo: 'o/m', quants: ['Q8_0', 'Q4_K_M'], projector: 'mmproj-F16.gguf' };
  assert.equal(sameFiles(built, source), true);
  assert.equal(sameFiles(built, { ...source, quants: ['Q4_K_M'] }), false);
  assert.equal(sameFiles(built, { ...source, projector: undefined }), false);
  assert.equal(sameFiles(undefined, source), false);
});
