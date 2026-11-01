# Model switching, Phase 0: where a load's time goes (2026-11-01)

Phase 0 of the model scheduler ([#1462](https://github.com/nekko-labs/nekko-agent/issues/1462)): measure what switching to a local model costs from each place its weights can be, before designing tiers around guesses. Harness: `nekko-bench switch` ([how it works](../docs/benchmarks.md#switching-models)). Raw results and configs: [`model-switching-phase0/`](model-switching-phase0/).

**Machine:** RTX 5090 32 GB (PCIe 5 x16), 47 GB RAM, Windows 11, Samsung 9100 PRO 4 TB (PCIe 5 NVMe), WD Gold 20 TB (SATA, 7200 rpm). llama.cpp b11149 CUDA, as Nekko installs it, with `--n-gpu-layers 999 --ctx-size 4096` and the default load mode (`auto`, which is mmap) unless noted. Medians of 3 runs on NVMe, 2 on the HDD.

**Caveat:** a game was running on the same GPU for most of these runs. It explains the one failed run (CUDA out of memory, retried) and the noisy first-token times. The load times were steady across repeats (within about 15%), so the conclusions stand, but MS0-4 re-runs this on an idle machine.

## Results

*Cold*: a fresh copy no page of which is in memory. *Warm*: the same file already in the OS page cache, which is what a Warm tier leaves behind. *Ready*: spawn to `/health` answering. *Startup*: spawn to the server opening the model file (the process, backend libraries, CUDA init). *Weights*: opening the file to the model loaded (read, upload, context), for the warm load. *Hot token*: time to first token of a request to the loaded model.

| Model | Size | From disk | Raw read | Cold ready | Warm ready | Warm speedup | Startup | Warm weights | Hot token |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Qwen3 8B Q4_K_M | 5.03 GB | HDD | 234 MB/s | 24.38 s | 2.98 s | 8.2x | 0.16 s | 2.78 s | 162 ms |
| Gemma 4 E4B Q4_K_M | 5.34 GB | HDD | 220 MB/s | 25.48 s | 3.44 s | 7.4x | 0.13 s | 3.24 s | 221 ms |
| Gemma 4 12B Q4_K_M | 7.38 GB | HDD | 236 MB/s | 35.23 s | 4.61 s | 7.6x | 0.14 s | 4.43 s | 221 ms |
| Qwen3 8B Q4_K_M | 5.03 GB | NVMe | 10323 MB/s | 3.42 s | 2.50 s | 1.4x | 0.12 s | 2.33 s | 37 ms |
| Gemma 4 E4B Q4_K_M | 5.34 GB | NVMe | 10468 MB/s | 4.02 s | 3.48 s | 1.2x | 0.13 s | 3.31 s | 222 ms |
| Gemma 4 12B Q4_K_M | 7.38 GB | NVMe | 10395 MB/s | 6.13 s | 5.54 s | 1.1x | 0.14 s | 5.35 s | 394 ms |
| Qwen3 8B, `--load-mode none` | 5.03 GB | NVMe | 10595 MB/s | 2.13 s | 1.41 s | 1.5x | 0.13 s | 1.28 s | 116 ms |
| Qwen3 8B, `--load-mode dio` | 5.03 GB | NVMe | 10779 MB/s | 1.82 s | 1.24 s | 1.5x | 0.11 s | 1.10 s | 35 ms |

## What it means for the scheduler

1. **On a slow disk the Warm tier is the whole win: 7-8x.** A 5 GB model from the HDD takes 24 s cold and 3 s from memory, and from memory it is as fast as from the NVMe. The issue's hypothesis ("a 7B Q4 under ~3 s from Warm against 10-40 s cold") holds: 2.98 s against 24.4 s.
2. **On a fast NVMe the Warm tier buys 10-40%.** The disk reads at 10 GB/s; a 5 GB model still takes 2.3-3.3 s to land from memory. Reading is not the bottleneck there; llama.cpp's load path is.
3. **The load mode matters more than the tier on a fast disk.** The default (mmap) moves weights at about 2 GB/s even from memory. `--load-mode dio` (direct I/O) loads the same model **cold in 1.82 s, faster than mmap from memory (2.50 s)**, and `none` is close behind. That is a quick win for every load, independent of the scheduler: MS1 should pick the load mode by where the weights are (direct I/O from a fast local SSD, mmap or `none` when they are Warm, since direct I/O skips the page cache by design), after confirming it on the other platforms and on a slow disk.
4. **Startup is negligible: 0.11-0.18 s.** The process, backend libraries and CUDA init are not worth a pre-started server pool. Drop that idea from the risks.
5. **A loaded model answers at once.** The first request after a load is no slower than later ones (warm-up runs inside the load). So "Hot" means a switch costs only the request itself, 35-400 ms here, and the noise in that column is the game sharing the GPU.
6. **Staged earns its place.** Copying a model from the HDD to the NVMe turns a 24-35 s cold load into 3.4-6.1 s, without holding RAM. For people whose library lives on a big slow disk, Staged is the tier that survives a reboot or memory pressure.

## Acceptance numbers for #1462

- Warm against cold from a slow library disk: **at least 6x** (measured 7.4-8.2x on a 7200 rpm HDD).
- A ~5 GB model from Warm: **ready within 3.5 s** on a PCIe 4/5 desktop GPU (measured 2.5-3.5 s with mmap), and lower once the load mode is chosen per tier.
- Fast-NVMe libraries: the scheduler's gain there comes from choosing the load mode and from keeping models Hot, not from Warm.

## Sharing the machine (added after a game ran during the benchmark)

Running this while a game held the GPU showed the other half of the problem: the scheduler shares the computer with other heavy programs. A game held enough VRAM to fail one load outright, and slowed every request. The scheduler has to see that and yield:

- **Signals**: VRAM used by other processes (NVML on NVIDIA, DXGI `QueryVideoMemoryInfo` on Windows, Metal's recommended working set on macOS), an exclusive or borderless full-screen app in front (`nekko-machine` already detects this for notices: `activity:fullscreen`), the biggest RAM holder (`nekko-machine` memory state already names it), disk I/O by other processes.
- **Policy**: while another heavy program is active, no speculative preloads or staging, Warm budget shrunk, idle Hot models demoted, and a scheduled task's model loaded only when the task runs, with a smaller context or partial offload if the full fit is not there. When the program closes, re-plan.
- **Explain it**: "Paused preloading while a game is running" in the monitor chip.

This goes into #1462's design as its own section.

## Not covered yet (MS0-4)

- An idle-machine re-run on this box.
- Windows/Vulkan (AMD), Apple Silicon (unified memory: Warm and Hot share one pool), CPU-only.
- Load modes on the HDD and on more models, and a SATA SSD and a USB disk.
- How often Windows trims a Warm file from the standby list under real use.
