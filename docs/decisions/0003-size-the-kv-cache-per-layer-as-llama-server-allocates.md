---
status: accepted
date: 2026-10-23
---

# 0003. Size the KV cache per layer, as llama-server allocates it

## Context

The fit planner (`nekko-engine/src/capacity.rs`) priced the KV cache as `2 x layers x kvHeads x headDim x context x bytes x slots`. That holds for a plain transformer on Ollama. It does not hold for the models people run now, or for how the engine runs them:

- **Hybrid models** (Qwen3.5, 3.6, 3.8) are mostly recurrent layers with no KV cache. Qwen3.5 4B at 32k: the formula says 4 GiB, llama.cpp allocates 1 GiB on its 8 attention layers.
- **Sliding-window models** (Gemma 4, gpt-oss) cap most layers at a window. Gemma 4 publishes a per-layer `head_count_kv` array, which the reader skipped, so the formula fell back to all 16 heads at the global width: 48 GiB at 32k for Gemma 4 12B, against llama.cpp's 1952 MiB.
- **Slots.** The engine passes no `--parallel` for a one-slot load, so `llama-server` runs four sequences over one unified cache: the full-attention layers hold the context once, and the sliding layers hold four windows (4608 cells for Gemma 4's 1024-token window). With `--parallel N`, the context is split between the slots (each gets `context / N`) and each slot keeps its own window. Multiplying the whole cache by the slot count is right for Ollama only.

All three were measured with llama-server b11429 on an M5 Max (2026-10-22/23). Decision [0002](0002-bundled-model-feed-with-measured-calibration.md) quoted 992 MiB for Gemma 4 12B, measured with `--parallel 1`. The engine's real one-slot load is 1952 MiB, and the recommendations now use that figure.

## Options considered

1. **Per-architecture rules from metadata alone** (`full_attention_interval`, `sliding_window_pattern`). No tensor table to read, but every new architecture needs a rule, and Gemma 4's global layers (one 512-wide head, keys doubling as values) are not in the metadata.
2. **Layer by layer from the tensor table.** A layer's `attn_k` and `attn_v` widths are its cache per token. No `attn_k` means no cache. `ssm_*` tensors mark a recurrent layer, whose fused `attn_qkv` feeds a state and not a cache. The window comes from the per-layer pattern, or a known period where the file has none. This needs the tensor table, which follows the metadata in the header the engine already reads.
3. **Ask llama-server** (load, read its log, unload). Exact, but it means a load before every plan.

## Decision

Option 2, as a `KvLayout` (cache elements per token on full and sliding layers, and the window) read by `gguf.rs` and stored on the library row. `kv_cache_bytes` uses it when present, sized as llama-server allocates. A file whose tensor table cannot be read, and every model from another server, keeps the uniform estimate. An architecture with a window but no known pattern is counted as all full-attention, which can overstate its cache but never understates it.

## Consequences

- Fit verdicts, spill estimates, auto-fit presets and the one-click fixes for Gemma 4, gpt-oss and the Qwen hybrids now agree with what loads. A 16 GB card runs Gemma 4 12B at 32k fully on the GPU, where the planner used to say it would not load.
- The recommendations (`nekko-machine`) use the same formula, so a recommended model and its fit bar agree.
- Rows already in `library.json` get the layout once, on the next listing, from the file's header.
- Not counted: the fixed recurrent state of hybrid models (50 MiB for Qwen3.5 4B with one sequence, 251 MiB for Qwen3.6 35B A3B with four), left to the overhead allowance. llama.cpp's defaults are assumed: a 512-token micro-batch and four automatic sequences. If a later llama.cpp changes either, `tests/kv_layout.rs` (run with `NEKKO_KV_CHECK_DIR` against real files) is where the difference shows.
