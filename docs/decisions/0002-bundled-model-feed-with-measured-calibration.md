---
status: accepted
date: 2026-10-22
---

# 0002. Recommend models from a bundled feed, with speeds calibrated on measurements

## Context

The Models page should say which local models suit this machine per task, with the speed to expect, on a fresh install and offline ([spec](../../spec/models/hardware-aware-model-recommendations.md)). That needs, per model and quant, the memory it takes and the speed it runs at on hardware we mostly do not own. Three facts shaped the choice:

- **The memory formula the engine planner uses overstates current models several times over.** `nekko-engine`'s `kv_cache_bytes` multiplies one `head_count_kv x key_length` by every layer. Gemma 4 12B at 32k context comes out at about 51 GB of KV cache; llama.cpp allocates 992 MiB (8 global layers, 40 sliding-window layers holding 1,536 cells). Qwen3.5 counts its recurrent layers as attention. A recommender using that formula would turn away models that fit.
- **We can measure on only two kinds of hardware**: an RTX 5090 (Windows, CUDA; `docs/benchmarks.md`) and an M5 Max with a 40-core GPU (Metal). We have no AMD card, and AGENTS.md forbids presenting an estimate as a measurement.
- **Model releases move monthly** (Qwen3.5 to 3.8 and Gemma 4 between February and October 2026), so a list compiled into a release goes stale.

## Options considered

1. **Hosted feed only.** Always fresh. Useless offline and on first run without network, and needs a service before anything ships.
2. **Bundled snapshot, online refresh later.** Works offline from the first launch; goes stale between releases until the refresh exists.
3. **Compute at runtime from Hugging Face** (search, read headers on the user's machine). Always current, but slow, network-dependent, and turns the client into a scraper.

For speed:

1. **Only measured numbers.** Honest, but most hardware would show nothing.
2. **Bandwidth estimate with an assumed efficiency.** Covers everything, but the efficiency would be a guess.
3. **Bandwidth estimate, efficiency measured per backend, labelled by basis.** `measured` where the same file was measured on that class, `estimated` where the backend's efficiency is measured, `estimatedBorrowed` where it is borrowed from another backend, nothing for unknown hardware.

## Decision

A **bundled snapshot** built offline by `scripts/model-feed.mjs` (option 2), and **speed option 3**. The build script reads each file's size and GGUF header from Hugging Face on a developer's machine and computes the KV cache layer by layer from the tensors (no `attn_k`, no cache; sliding-window layers capped at their window; shared-KV layers skipped) and the bytes a decoded token reads (embedding lookups excluded, unrouted experts excluded). The KV figures match llama.cpp's own allocation exactly on the two models checked. Each backend's efficiency is the lowest its measurements give, so estimates err low: CUDA 0.52 (RTX 5090, Gemma 4 12B, 127 tok/s without speculative decoding), Metal 0.6 (M5 Max: Gemma 4 12B 61.8 tok/s gives 0.72, Qwen3.5 4B 134.5 tok/s gives 0.60). Vulkan, HIP and CPU borrow CUDA's and say so.

The online refresh, when built, reuses the signed-document pattern the Claude policy override already has (Ed25519 over the payload, a serial that only increases, a copy kept in the data directory, published beside the update feed), so it needs no new service.

## Consequences

- Recommendations work offline from the first launch, and every number on screen can say where it came from.
- The engine planner's fit bar still uses the uniform formula and will disagree with the recommendation for sliding-window and hybrid models (it says a recommended model does not fit). It should adopt the per-layer KV figures; that is a separate change with its own golden fixtures.
- AMD and CPU-only speeds are uncalibrated until someone measures them; the spec says so and the answer is labelled `estimatedBorrowed`. `scripts/itest-recommendations.mjs` prints what any machine would be told, for that check.
- The editorial ranking (which model first for each task) is a product judgement, reviewed when the feed is rebuilt; nothing measures quality.
- Between releases the bundled feed ages. If new models routinely go unrecommended for weeks, the refresh moves up.
