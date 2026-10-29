---
status: accepted
date: 2026-10-25
---

# 0023. Plan a load across VRAM, RAM and disk by weight kind, and pass the placement to llama.cpp explicitly

## Context

The load drawer's planner (`capacity::compute_fit`) measures a model against one pool, the best GPU, and reports the rest as a spill to the CPU. It treats every layer as the same size. That cannot describe how people run big mixture-of-experts models on small cards: the routed experts are most of the file and few of its reads per token, so llama.cpp can keep them in RAM (`--cpu-moe`, `--n-cpu-moe`) while attention and the KV cache stay on the GPU, and some models ship a large n-gram lookup table that `--lazy-mode` reads a few KB per token straight from the file. On an 8 GB card the old planner said such a model "will not load" at any context; people run it at 256K.

llama.cpp has also defaulted `--fit on` since b7410: it re-places tensors at load time to fit each device, so a projection we show can differ from what loads.

## Options considered

1. **Extend `compute_fit`.** One planner. But its recorded answers (`tests/golden/capacity.json`) and every caller's verdicts would move, including other runtimes that cannot split by weight kind.
2. **Let llama.cpp's `--fit` decide, and show no projection.** Always fits, but the meter would be a guess and the drawer could not explain what it chose.
3. **A second planner that places bytes by kind in VRAM, RAM and on disk, and launch with that placement and `--fit off`.** The meter is exact for our own GGUFs, and the solver can explain every choice.

## Decision

Option 3. `placement.rs` reads expert, feed-forward and lookup-table byte shares from the GGUF tensor table, reuses the same KV and overhead math as `compute_fit`, and answers where each byte lands. The launch passes the solved placement explicitly with `--fit off` whenever the drawer sets one. `compute_fit` stays as it is for the other runtimes and its recorded answers.

## Consequences

- Two planners share KV and overhead math but not placement; a change to one's assumptions (OS reserve, headroom) has to be mirrored in the other.
- A split GGUF's shares come from its first shard, which holds the earliest layers. If a split MoE plans visibly wrong, read every shard.
- Turning `--fit` off means a planner mistake surfaces as a failed load rather than a silently re-placed one. The load error already names lowering context or layers; real-hardware checks (MT-6) will tell us whether the margins hold.
- New flags are gated on the installed build's `--help`, with `--override-tensor` fallbacks for expert and feed-forward placement.
