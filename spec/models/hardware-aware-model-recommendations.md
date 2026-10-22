---
title: "Hardware-aware model recommendations"
area: models
---

# Hardware-aware model recommendations

**What it is for.** A fresh install should be able to say "on this machine, run these", per task, with the speed to expect and the memory left over, before the user downloads anything. Today the Models page opens on a short curated list with a rough fit chip per model; it does not know which of them suits *this* machine best, or how fast any of them will be. This is part A of local-model scheduling: recommendations from the hardware. Part B (activity-aware background automations: idle detection, preemption, residency) is separate work.

**Tasks.** Chat, coding, a small fast model for routing and classification, embeddings, and vision. Image generation is not in the first feed: it is measured in seconds per image on a different runtime (stable-diffusion.cpp), not tokens per second, and will get its own rows.

## Hardware profile `[implemented, unit- and daemon-tested; live-checked on Apple M5 Max]`

The daemon keeps a profile of the machine in `<data>/machine-profile.json` (`machine:profile`): OS and architecture, CPU model and cores, total RAM, whether memory is unified, each GPU's name, total memory and (Apple Silicon) core count, the compute backends it can run, the installed engine build, and free disk where models are kept. It records what the machine *has* (totals), never the free figures the fit planner reads per load. A saved profile answers immediately (1 ms against a 60 ms probe on the M5 Max, longer where `nvidia-smi` and `vulkaninfo` run) and is reused for a week; it is probed again sooner when the engine build changes, and on request (`{ refresh: true }`). Free disk is read fresh on every answer. Nothing in the profile leaves the machine.

## The recommendations feed `[implemented: bundled snapshot; online refresh planned]`

A feed built offline and shipped with the app (`crates/nekko-machine/src/model-feed.json`), from an editorial source (`crates/nekko-machine/feed/source.json`) by `node scripts/model-feed.mjs`:

- **Editorial:** which models, in which order of preference, for which task; each task's context length and minimum useful speed (chat 20 tok/s, coding 25, routing 60, vision 15; embeddings have none, since decode speed is not what they wait on).
- **From the files themselves:** each quant's exact download size (Hugging Face's tree), and from the GGUF header (fetched with range requests, a few MB, never the weights) the bytes one decoded token reads and the KV cache per token of context, layer by layer.
- **Hardware table:** memory bandwidth per GPU (NVIDIA RTX 20-50 and GTX 16, AMD RX 6000-9000, Intel Arc, Apple M1-M5), from vendor specifications. Variants that share a name are separated by GPU cores (Apple Max chips) or memory (RTX 3060 8 GB and 12 GB). Laptop parts never match desktop rows.
- **Calibration and measurements,** each with its source (below).

The client never searches, scrapes or benchmarks anything to make a recommendation. Community benchmarks may inform the editorial source; they are not read at runtime.

**Online refresh** (planned, not built): a newer feed signed and published beside the release's update feed, verified and kept in the data directory the way the Claude policy override is (`crates/nekkod/src/claude_policy.rs`), falling back to the bundled snapshot. See [decision 0002](../../docs/decisions/0002-bundled-model-feed-with-measured-calibration.md).

## Picking `[implemented, unit-tested over six reference machines]`

`machine:recommendations` answers, per task, the pick, whether it is below the task's speed target, and every candidate at the quant it would be offered at.

- **Budget.** A discrete GPU: the roomiest single card's total memory less 1 GiB for the display and other programs (cards are never pooled). Apple Silicon: the share of unified memory macOS lets the GPU use by default, two thirds up to 36 GB and three quarters above. No usable GPU, or an engine built for the CPU: RAM less 4 GiB for the OS and apps. When nothing fits a small GPU, the task falls back to the CPU budget.
- **Memory need.** Weights (plus the image projector for vision) + KV cache at the task's context + the planner's compute-buffer allowance. The KV cache is counted per layer: recurrent layers of hybrid models (Qwen3.5 and later) keep none, sliding-window layers (Gemma 4, gpt-oss) stop at their window plus one micro-batch, layers that share another layer's cache add nothing. Checked against llama.cpp's own allocation at 32k context: Gemma 4 12B 512 + 480 MiB and Qwen3.5 4B 1024 MiB, exactly. The total is conservative by about 10% (8.8 GB projected for Gemma 4 12B, 7.9 GB by llama.cpp).
- **Choice.** Candidates in the feed's order of preference; for each, the best quant that fits comfortably (≤ 75% of the budget) and is fast enough, else one that fits tightly (≤ 90%) and is fast enough, so a comfortable Q4 beats a Q8 at the edge. The pick is the first candidate that qualifies. If none is fast enough, the fastest that fits, flagged as below the target speed.

## Expected speed `[implemented; calibrated on Apple Silicon (Metal) and NVIDIA (CUDA) only]`

Decode tokens/s at the start of a conversation, with where the number came from:

- **Measured:** the same file measured on the same class of hardware. Shown as is.
- **Estimated:** decode is bound by memory bandwidth, so efficiency × bandwidth ÷ bytes read per token. Bytes per token come from the file: embedding tables are lookups, and a mixture-of-experts model reads only the experts a token is routed to. Each backend's efficiency is the lowest its measurements give, so estimates under-promise.
- **Estimated, borrowed:** a backend with no measurement of its own (Vulkan, ROCm/HIP, CPU) uses CUDA's efficiency, and says so. CPU-only machines also use an assumed 50 GB/s (dual-channel DDR4-3200, rounded down), because memory bandwidth is not probed.
- **None:** a GPU the table does not list (a laptop part, a workstation card) gets no speed rather than a guess, and is still recommended by fit.

## Acceptance

- On a fresh install the Models page recommends a working model set for Windows/NVIDIA, Windows/AMD on Vulkan, Apple Silicon and CPU-only, with the expected speed shown. **Status:** the daemon side is implemented, and unit tests hold a complete, fitting set for a reference machine of each kind (RTX 5090, RTX 4060 on Vulkan, RX 7900 XTX on Vulkan, M2 16 GB, M5 Max 128 GB, CPU-only 16 GB). Live on real hardware: only the M5 Max so far (`node scripts/itest-recommendations.mjs`). The Models page does not show recommendations yet (next step). Windows/AMD has no machine to verify on: its speeds are borrowed and must be measured before the feature is called done there.
- No change to existing perf gates: the profile is read on request only, nothing runs at startup.

## Privacy

The profile and the recommendations are computed and kept on the machine. Building the feed contacts Hugging Face from a developer's machine, never from the app. Sharing measured speeds back to improve the feed is a later, opt-in step and does not exist yet.
