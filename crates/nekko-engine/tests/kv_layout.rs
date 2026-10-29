//! The KV cache read layer by layer from a GGUF's tensors, held to what
//! `llama-server` (b11429, f16 cache, 2026-10-22/23) allocated for the same
//! geometry:
//!
//! - Gemma 4 12B at `--ctx-size 32768`, as the engine starts a one-slot load
//!   (no `--parallel`: four sequences, one unified cache): 512 MiB on 8 global
//!   layers and 1440 MiB on 40 sliding-window layers (4608 cells). With
//!   `--parallel 2`: 512 MiB (16384 cells per slot) and 960 MiB (1536 per slot).
//! - Qwen3.5 4B at 32768: 1024 MiB on its 8 attention layers, none on the 24
//!   recurrent ones. Qwen3.6 35B A3B: 640 MiB on 10 of 40.

use nekko_engine::capacity::{FitRequest, KvLayout, ModelFacts, kv_cache_bytes};
use nekko_engine::gguf::read_metadata;

const MIB: f64 = 1024.0 * 1024.0;

enum V {
    U32(u32),
    Str(&'static str),
    Bools(Vec<bool>),
    U32s(Vec<u32>),
}

fn s(out: &mut Vec<u8>, text: &str) {
    out.extend((text.len() as u64).to_le_bytes());
    out.extend(text.as_bytes());
}

/// A GGUF v3 header: metadata pairs, then a tensor table of `(name, [ne0, ne1])`.
fn gguf(meta: &[(&str, V)], tensors: &[(String, [u64; 2])]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend(0x4655_4747u32.to_le_bytes());
    out.extend(3u32.to_le_bytes());
    out.extend((tensors.len() as u64).to_le_bytes());
    out.extend((meta.len() as u64).to_le_bytes());
    for (key, value) in meta {
        s(&mut out, key);
        match value {
            V::U32(n) => {
                out.extend(4u32.to_le_bytes());
                out.extend(n.to_le_bytes());
            }
            V::Str(text) => {
                out.extend(8u32.to_le_bytes());
                s(&mut out, text);
            }
            V::Bools(b) => {
                out.extend(9u32.to_le_bytes());
                out.extend(7u32.to_le_bytes());
                out.extend((b.len() as u64).to_le_bytes());
                out.extend(b.iter().map(|x| *x as u8));
            }
            V::U32s(a) => {
                out.extend(9u32.to_le_bytes());
                out.extend(4u32.to_le_bytes());
                out.extend((a.len() as u64).to_le_bytes());
                for n in a {
                    out.extend(n.to_le_bytes());
                }
            }
        }
    }
    for (offset, (name, dims)) in tensors.iter().enumerate() {
        s(&mut out, name);
        out.extend(2u32.to_le_bytes());
        out.extend(dims[0].to_le_bytes());
        out.extend(dims[1].to_le_bytes());
        out.extend(0u32.to_le_bytes());
        out.extend((offset as u64 * 64).to_le_bytes());
    }
    out.extend([0u8; 64]);
    out
}

fn read(name: &str, bytes: Vec<u8>) -> nekko_engine::gguf::GgufMetadata {
    let p = std::env::temp_dir().join(format!("nekko-kv-{name}-{}.gguf", std::process::id()));
    std::fs::write(&p, bytes).unwrap();
    let meta = read_metadata(p.to_str().unwrap()).expect("a readable GGUF");
    std::fs::remove_file(p).ok();
    meta
}

fn kv(layout: KvLayout, ctx: f64, slots: f64) -> f64 {
    let facts = ModelFacts { kv_layout: Some(layout), ..ModelFacts::default() };
    let req = FitRequest { context_tokens: ctx, parallel_slots: slots, ..FitRequest::default() };
    kv_cache_bytes(&facts, &req).unwrap()
}

fn attn(i: usize, k: u64, v: Option<u64>) -> Vec<(String, [u64; 2])> {
    let mut t = vec![(format!("blk.{i}.attn_k.weight"), [3840, k])];
    if let Some(v) = v {
        t.push((format!("blk.{i}.attn_v.weight"), [3840, v]));
    }
    t
}

/// Gemma 4 12B: every sixth layer global (one 512-wide head, keys doubling as
/// values), the rest sliding over 1024 tokens with eight 256-wide heads.
fn gemma_4_12b() -> Vec<u8> {
    let pattern: Vec<bool> = (0..48).map(|i| i % 6 != 5).collect();
    let tensors: Vec<_> =
        (0..48).flat_map(|i| if i % 6 == 5 { attn(i, 512, None) } else { attn(i, 2048, Some(2048)) }).collect();
    gguf(
        &[
            ("general.architecture", V::Str("gemma4")),
            ("gemma4.block_count", V::U32(48)),
            ("gemma4.attention.head_count", V::U32(16)),
            ("gemma4.attention.head_count_kv", V::U32s(vec![8; 48])),
            ("gemma4.attention.key_length", V::U32(512)),
            ("gemma4.attention.sliding_window", V::U32(1024)),
            ("gemma4.attention.sliding_window_pattern", V::Bools(pattern)),
            ("gemma4.context_length", V::U32(262144)),
        ],
        &tensors,
    )
}

#[test]
fn gemma_4_counts_its_sliding_layers_at_their_window() {
    let meta = read("gemma", gemma_4_12b());
    let l = meta.kv_layout.expect("a layout");
    assert_eq!(l, KvLayout { full_per_token: 8.0 * 1024.0, sliding_per_token: 40.0 * 4096.0, sliding_window: 1024.0 });
    // The uniform geometry is still reported, for anything that reads it.
    assert_eq!((meta.layers, meta.head_dim), (Some(48.0), Some(512.0)));
    assert_eq!(kv(l, 32768.0, 1.0), (512.0 + 1440.0) * MIB, "four unified sequences, a window each");
    assert_eq!(kv(l, 32768.0, 2.0), (512.0 + 960.0) * MIB, "slots share the context, each keeps its window");
    // Below the windows the sliding layers hold the whole context.
    assert_eq!(kv(l, 4096.0, 1.0), (8.0 * 1024.0 + 40.0 * 4096.0) * 4096.0 * 2.0);
}

#[test]
fn a_hybrid_model_keeps_no_cache_on_its_recurrent_layers() {
    // Qwen3.5 4B: attention on every fourth layer; the others are recurrent,
    // with a fused `attn_qkv` that feeds their state, not a cache.
    let tensors: Vec<_> = (0..32)
        .flat_map(|i| {
            if i % 4 == 3 {
                attn(i, 1024, Some(1024))
            } else {
                vec![
                    (format!("blk.{i}.attn_qkv.weight"), [2560, 8192]),
                    (format!("blk.{i}.ssm_out.weight"), [4096, 2560]),
                ]
            }
        })
        .collect();
    let meta = read(
        "qwen35",
        gguf(
            &[
                ("general.architecture", V::Str("qwen35")),
                ("qwen35.block_count", V::U32(32)),
                ("qwen35.attention.head_count", V::U32(16)),
                ("qwen35.attention.head_count_kv", V::U32(4)),
                ("qwen35.attention.key_length", V::U32(256)),
                ("qwen35.full_attention_interval", V::U32(4)),
            ],
            &tensors,
        ),
    );
    let l = meta.kv_layout.unwrap();
    assert_eq!(l, KvLayout { full_per_token: 8.0 * 2048.0, sliding_per_token: 0.0, sliding_window: 0.0 });
    assert_eq!(kv(l, 32768.0, 1.0), 1024.0 * MIB);
    // The uniform formula counted all 32 layers: four times llama.cpp's figure.
    let uniform =
        ModelFacts { layers: meta.layers, kv_heads: meta.kv_heads, head_dim: meta.head_dim, ..ModelFacts::default() };
    let req = FitRequest { context_tokens: 32768.0, ..FitRequest::default() };
    assert_eq!(kv_cache_bytes(&uniform, &req), Some(4096.0 * MIB));
}

#[test]
fn a_window_with_no_pattern_slides_every_other_layer_on_gpt_oss() {
    let tensors: Vec<_> = (0..4).flat_map(|i| attn(i, 512, Some(512))).collect();
    let meta = read(
        "oss",
        gguf(
            &[
                ("general.architecture", V::Str("gpt-oss")),
                ("gpt-oss.block_count", V::U32(4)),
                ("gpt-oss.attention.head_count", V::U32(64)),
                ("gpt-oss.attention.sliding_window", V::U32(128)),
            ],
            &tensors,
        ),
    );
    assert_eq!(
        meta.kv_layout,
        Some(KvLayout { full_per_token: 2048.0, sliding_per_token: 2048.0, sliding_window: 128.0 })
    );
    // An architecture with a window but no known pattern is counted as all full: never less than it holds.
    let meta = read(
        "unknown",
        gguf(
            &[
                ("general.architecture", V::Str("mystery")),
                ("mystery.block_count", V::U32(4)),
                ("mystery.attention.sliding_window", V::U32(128)),
            ],
            &tensors,
        ),
    );
    assert_eq!(meta.kv_layout, Some(KvLayout { full_per_token: 4096.0, sliding_per_token: 0.0, sliding_window: 0.0 }));
}

#[test]
fn shared_layers_and_fused_projections() {
    // The last two of four layers reuse earlier layers' cache.
    let tensors: Vec<_> = (0..4).flat_map(|i| attn(i, 256, Some(256))).collect();
    let meta = read(
        "shared",
        gguf(
            &[
                ("general.architecture", V::Str("gemma3n")),
                ("gemma3n.block_count", V::U32(4)),
                ("gemma3n.attention.shared_kv_layers", V::U32(2)),
            ],
            &tensors,
        ),
    );
    assert_eq!(meta.kv_layout.unwrap().full_per_token, 1024.0);
    // A fused QKV projection stores the KV heads' keys and values.
    let tensors: Vec<_> = (0..2).map(|i| (format!("blk.{i}.attn_qkv.weight"), [2560u64, 7680u64])).collect();
    let meta = read(
        "fused",
        gguf(
            &[
                ("general.architecture", V::Str("phi3")),
                ("phi3.block_count", V::U32(2)),
                ("phi3.attention.head_count", V::U32(32)),
                ("phi3.attention.head_count_kv", V::U32(8)),
                ("phi3.embedding_length", V::U32(2560)),
            ],
            &tensors,
        ),
    );
    assert_eq!(meta.kv_layout.unwrap().full_per_token, 2.0 * 8.0 * (80.0 + 80.0));
}

#[test]
fn a_file_without_a_tensor_table_keeps_the_uniform_estimate() {
    let meta = read(
        "bare",
        gguf(
            &[
                ("general.architecture", V::Str("llama")),
                ("llama.block_count", V::U32(32)),
                ("llama.attention.head_count", V::U32(32)),
                ("llama.attention.head_count_kv", V::U32(8)),
                ("llama.embedding_length", V::U32(4096)),
            ],
            &[],
        ),
    );
    assert_eq!(meta.kv_layout, None);
    assert!(meta.to_value().get("kvLayout").is_none(), "nothing new printed for it");
    // A tensor table cut off by the end of the file leaves the layout out, not the metadata.
    let mut cut = gemma_4_12b();
    cut.truncate(cut.len() - 64 - 200);
    let meta = read("cut", cut);
    assert_eq!((meta.layers, meta.kv_layout), (Some(48.0), None));
}

/// The same check on real files: `NEKKO_KV_CHECK_DIR` holding unsloth's
/// `gemma-4-12b-it-Q4_K_M.gguf`, `Qwen3.5-4B-Q4_K_M.gguf` and
/// `Qwen3.6-35B-A3B-UD-Q4_K_M.gguf`.
#[test]
#[ignore = "needs the model files"]
fn real_files_match_llama_cpp() {
    let dir = std::env::var("NEKKO_KV_CHECK_DIR").expect("NEKKO_KV_CHECK_DIR");
    let layout = |f: &str| read_metadata(&format!("{dir}/{f}")).and_then(|m| m.kv_layout).expect(f);
    let gemma = layout("gemma-4-12b-it-Q4_K_M.gguf");
    assert_eq!(kv(gemma, 32768.0, 1.0), 1952.0 * MIB);
    assert_eq!(kv(gemma, 32768.0, 2.0), 1472.0 * MIB);
    assert_eq!(kv(layout("Qwen3.5-4B-Q4_K_M.gguf"), 32768.0, 1.0), 1024.0 * MIB);
    assert_eq!(kv(layout("Qwen3.6-35B-A3B-UD-Q4_K_M.gguf"), 32768.0, 1.0), 640.0 * MIB);
}

#[test]
fn the_fit_verdict_follows_the_layout() {
    use nekko_engine::capacity::{Device, Hardware, PlanOptions, compute_fit};
    // Gemma 4 12B Q4_K_M (7.1 GB) at 32k on a 16 GB card.
    let gpu = Hardware {
        devices: vec![Device { name: "RTX 4080".into(), total: 16.0 * 1024.0 * MIB, free: 15.0 * 1024.0 * MIB }],
        unified: false,
        ram_total: 32.0 * 1024.0 * MIB,
        ram_free: 24.0 * 1024.0 * MIB,
    };
    let req = FitRequest { context_tokens: 32768.0, ..FitRequest::default() };
    let meta = read("fit", gemma_4_12b());
    let uniform = ModelFacts {
        weights: Some(7_121_861_440.0),
        layers: meta.layers,
        kv_heads: meta.kv_heads,
        head_dim: meta.head_dim,
        max_context: meta.max_context,
        ..ModelFacts::default()
    };
    let opts = PlanOptions::default();
    // The uniform geometry (16 KV heads x 512 on all 48 layers) asks for 48 GiB of cache.
    let before = compute_fit(&uniform, &req, &gpu, &opts);
    assert_eq!(before.kv, 48.0 * 1024.0 * MIB);
    assert_eq!(before.verdict, "wont-load");
    let after = compute_fit(&ModelFacts { kv_layout: meta.kv_layout, ..uniform }, &req, &gpu, &opts);
    assert_eq!(after.kv, 1952.0 * MIB);
    assert_eq!(after.verdict, "fits");
    assert_eq!(after.gpu_layers, Some(48.0));
}

/// Experts, dense feed-forward and lookup tables are told apart by name and
/// sized by type, as shares of every tensor byte (all F32 here: 4 bytes each).
#[test]
fn weights_are_sized_by_kind() {
    let t = |name: &str, a: u64, b: u64| (name.to_string(), [a, b]);
    let meta = read(
        "moe",
        gguf(
            &[
                ("general.architecture", V::Str("qwen3moe")),
                ("qwen3moe.block_count", V::U32(1)),
                ("qwen3moe.expert_count", V::U32(128)),
                ("qwen3moe.expert_used_count", V::U32(8)),
            ],
            &[
                t("token_embd.weight", 10, 10),
                t("blk.0.attn_k.weight", 10, 10),
                t("blk.0.ffn_gate_inp.weight", 10, 10),
                t("blk.0.ffn_up_exps.weight", 20, 10),
                t("blk.0.ffn_down_exps.weight", 20, 10),
                t("blk.0.ffn_up_shexp.weight", 10, 10),
                t("blk.0.ffn_up.weight", 10, 10),
                t("ngram_embd.weight", 30, 10),
            ],
        ),
    );
    let w = meta.weight_layout.expect("a weight layout");
    // 1200 elements: experts 400, dense FFN 100, n-gram table 300.
    assert_eq!((w.expert_share, w.ffn_share, w.table_share), (400.0 / 1200.0, 100.0 / 1200.0, 300.0 / 1200.0));
    assert_eq!((w.experts, w.experts_used), (Some(128.0), Some(8.0)));
    assert!(meta.to_value()["weightLayout"]["expertShare"].is_number());
}
