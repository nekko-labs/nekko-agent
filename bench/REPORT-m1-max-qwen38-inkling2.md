# Qwen3.8-27B and Inkling 2 Mini on an M1 Max: DFlash2, classic, LM Studio

Status: measured 2026-11-27 to 2026-11-29 on one machine (Apple M1 Max, 64 GB),
two models at the same quantization (Q4_K_M), two workloads, cool chip (burst)
only. The first round, on an M5 Max with Qwen3-8B, is [REPORT.md](REPORT.md);
the method and the checks are the same and are described there.

## Summary

**Qwen3.8-27B, code edit: Nekko returns the edited file 3.9x sooner than plain
llama.cpp or LM Studio** (28.5 s against 111 s), decoding at 71.8 tok/s against
13.0. Every reply in every run was the correct edit, and Nekko's replies were
the same text as plain llama.cpp's.

**Qwen3.8-27B, chat: DFlash2 makes Nekko 2.6x faster than plain llama.cpp or
LM Studio** (33.5 tok/s against 13.1), against 1.5x (20.0 tok/s) for Nekko's
current default without it.

**DFlash2 against classic.** "Classic" is Nekko's current default: n-gram
speculative decoding, which guesses the next tokens by finding them earlier in
the conversation. On a code edit the reply copies the prompt, so classic
already gets almost all of the gain and DFlash2 adds 3% (71.8 against 69.7
tok/s). On chat there is little to copy, and DFlash2's drafter model, which
predicts a block of 8 tokens at a time, is what makes the difference: 33.5
against 20.0 tok/s.

**LM Studio and plain llama.cpp are level** on this model (within 0.1% on both
workloads). LM Studio's defaults leave its own speculative decoding off; with
it on it was not measured (see [Not covered](#not-covered-yet)).

**Inkling 2 Mini is a different story, and Nekko cannot run it yet.** Its
GGUFs use the `inkling2_loop` architecture, which llama.cpp added just after
b12565, the build Nekko pins; LM Studio's runtime already has it. The Inkling
numbers below come from the official llama.cpp b12818 run with Nekko's exact
command line: what Nekko would deliver once its pin moves, not what the app
does today. On that basis:

- **Code edit: about 1.9x sooner** (48.6 s against 91.8 s for plain llama.cpp
  and 97.1 s for LM Studio; decode 62 against 23 tok/s). These three runs are
  exploratory, not valid: Inkling still thinks briefly with reasoning off, every
  reply differs a little, and Nekko's speed followed the text (drift +7 to +8%,
  over the 3% limit). The LM Studio run failed only because a report script was
  edited while it ran. Their raw data is kept in `exploratory-kept/`.
- **Chat: no gain.** DFlash2 26.3 tok/s and classic 24.8 against 24.6 for plain
  llama.cpp, and the whole reply arrives 7% (DFlash2) and 11% (classic) later,
  because Nekko's default load doubles the time to the first token on this model
  (4.9 s against 2.4 s on chat, 17 s against 9 s on the code edit, prefill about
  130 against 215 tok/s), with or without the drafter. LM Studio decodes 7%
  below plain llama.cpp.

**For marketing:** "Nekko returns code edits 3.9x sooner than LM Studio" and
"2.6x faster chat with DFlash2" hold for Qwen3.8-27B on this Mac, with the
conditions stated. Nothing should be claimed for Inkling 2 Mini until Nekko's
engine pin loads it and the prefill penalty is explained.

## What was measured

| | Engine | Settings |
| --- | --- | --- |
| Nekko + DFlash2 | llama.cpp b12565 (Nekko's pinned build), behind Nekko's router | Nekko's default load plus the DFlash2 drafter chosen as Draft model: `--ctx-size 65536 --cache-type-k q8_0 --cache-type-v q8_0 --cache-reuse 256 --no-cache-idle-slots --spec-default --spec-draft-model <drafter> --spec-draft-ngl all --spec-type draft-dflash --spec-draft-n-max 7` |
| Nekko classic | the same build | Nekko's default load, no drafter (n-gram `--spec-default`). Started directly with Nekko's exact command line: Nekko's memory budget keeps one 27B model loaded, so the two Nekko arms cannot sit behind the router together |
| LM Studio | its llama.cpp runtime 2.81.0 | `lms load` defaults: 8,192 context, 4 parallel, its repeat penalty, its speculative decoding off |
| Plain llama.cpp | llama.cpp b12565 | only the model, the port and `-c 8192` (the reference in every run) |

- **Weights.** Qwen3.8-27B: `Qwen3.8-27B-Q4_K_M.gguf` from `ggml-org/Qwen3.8-27B-GGUF`
  (19.4 GB) and its drafter `Qwen3.8-27B-DFlash2-Q4_K_M.gguf` (1.1 GB). Inkling 2
  Mini: `Inkling-2-Mini-Q4_K_M.gguf` from `bartowski/Inkling-2-Mini-GGUF` (18.7 GB)
  and the community drafter `maternion/Inkling-2-Mini-DFlash2-GGUF` Q8_0 (0.5 GB).
  LM Studio reads the same file through a hard link (`lms import -L`), so every
  server of a model reads identical bytes, checked by sha256 in every run.
- **Pairs, not a line-up.** Each configuration is measured against plain
  llama.cpp, alternating request by request. On 64 GB, macOS lets the GPU hold
  about two 27B models: with four loaded, requests failed with Metal
  `kIOGPUCommandBufferCallbackErrorOutOfMemory`.
- **Plain llama.cpp gets `-c 8192`.** Its default allocates each model's full
  262,144-token context and took free memory to 4%. 8,192 matches LM Studio's
  default and holds every prompt here.
- **Thinking.** Qwen3.8 ignores Qwen3's `/no_think` switch and reasons in the
  reply, and how long it reasons changes with the random id that defeats
  prompt caching, so code-edit replies came out 1,495 or 2,827 tokens long.
  Code edits now send `--no-think`: `chat_template_kwargs` (Qwen3.8 reads
  `enable_thinking`, Inkling 2 reads `reasoning_effort`) and a top-level
  `reasoning_effort: none` (LM Studio), the same body to every server. Qwen3.8
  then writes the 1,313-token file with no reasoning. Chat keeps thinking on, as
  in the first round, with a fixed 512-token budget. The edit is judged on the
  reply's last python block.
- **Workloads** as in the first round: the code edit renames one function in a
  156-line file and returns the whole file; chat is a ~455-token prompt, 512
  tokens generated. Burst only: a 20 s pause before every request.

## Results

<!-- results:start -->

_Generated by `bench/scripts/report.py` from the run manifests. Do not edit by hand._

Machine: Apple M1 Max (MacBookPro18,2), 64 GB, macOS 27.2.1 (26B131).

### burst-code-edit-nekko-dflash2-vs-llama-server-qwen38-27b

Run `runs/20261127T182234Z-burst-code-edit-nekko-dflash2-vs-llama-server-qwen38-27b`: code edit: rename a function in a 156-line file and reply with the whole file; burst, 20 s pause before every request; 3 warmup and 6 measured requests per server, alternating.

Weights: `Qwen3.8-27B-Q4_K_M.gguf`, 19.40 GB, sha256 `d15d4b6de55f662a…`.

| Server | Decode tok/s, median (min–max) | TTFT ms, median | Prefill tok/s (server), median | Whole reply, s, median | Decode drift |
| --- | --- | --- | --- | --- | --- |
| nekko-dflash2 | 71.8 (71.7–71.8) | 10199 | 136 | 28.48 | +0.1% |
| llama-server-plain | 13.0 (13.0–13.0) | 10146 | 138 | 111.25 | -0.0% |

- nekko-dflash2 against llama-server-plain: decode 5.5x, whole reply 3.91x as fast.

- nekko-dflash2 speculative decoding: 1285 draft tokens accepted per reply (median; 1285–1285), 90% of those drafted.

- nekko-dflash2 replies: [1313] tokens, 1 different text in 6 replies, 6/6 correct edits.
- llama-server-plain replies: [1313] tokens, 1 different text in 6 replies, 6/6 correct edits.

Notes recorded with the run: M1 Max 64 GB, burst. Every llama.cpp arm runs llama.cpp b12565 (Nekko's pinned build). Pairwise against llama-server-plain (-m --port -c 8192; its default context would take the whole 64 GB) because two 27B servers fill the GPU working set. nekko-dflash2: Nekko router on 11500, preset draftModelId=Qwen3.8-27B-DFlash2-Q4_K_M; Nekko argv --ctx-size 65536 --cache-type-k q8_0 --cache-type-v q8_0 --cache-reuse 256 --no-cache-idle-slots --spec-default --spec-draft-model <drafter> --spec-draft-ngl all --spec-type draft-dflash --spec-draft-n-max 7. nekko-classic: llama-server started with Nekko's exact default argv (n-gram --spec-default, no drafter), outside the router because Nekko's memory budget keeps one 27B model resident. lm-studio: LM Studio, llama.cpp runtime 2.81.0, lms load defaults (8192 context, parallel 4, its repeat penalty), same file by hard link. Code edits are judged on the reply's last python block (Qwen3.8 reasons inline despite /no_think).

### burst-code-edit-nekko-classic-vs-llama-server-qwen38-27b

Run `runs/20261127T184753Z-burst-code-edit-nekko-classic-vs-llama-server-qwen38-27b`: code edit: rename a function in a 156-line file and reply with the whole file; burst, 20 s pause before every request; 3 warmup and 6 measured requests per server, alternating.

Weights: `Qwen3.8-27B-Q4_K_M.gguf`, 19.40 GB, sha256 `d15d4b6de55f662a…`.

| Server | Decode tok/s, median (min–max) | TTFT ms, median | Prefill tok/s (server), median | Whole reply, s, median | Decode drift |
| --- | --- | --- | --- | --- | --- |
| nekko-classic | 69.7 (69.7–69.7) | 10048 | 139 | 28.95 | +0.0% |
| llama-server-plain | 13.0 (13.0–13.0) | 10103 | 138 | 111.18 | -0.1% |

- nekko-classic against llama-server-plain: decode 5.4x, whole reply 3.84x as fast.

- nekko-classic speculative decoding: 1274 draft tokens accepted per reply (median; 1274–1274), 90% of those drafted.

- nekko-classic replies: [1313] tokens, 1 different text in 6 replies, 6/6 correct edits.
- llama-server-plain replies: [1313] tokens, 1 different text in 6 replies, 6/6 correct edits.

Notes recorded with the run: M1 Max 64 GB, burst. Every llama.cpp arm runs llama.cpp b12565 (Nekko's pinned build). Pairwise against llama-server-plain (-m --port -c 8192; its default context would take the whole 64 GB) because two 27B servers fill the GPU working set. nekko-dflash2: Nekko router on 11500, preset draftModelId=Qwen3.8-27B-DFlash2-Q4_K_M; Nekko argv --ctx-size 65536 --cache-type-k q8_0 --cache-type-v q8_0 --cache-reuse 256 --no-cache-idle-slots --spec-default --spec-draft-model <drafter> --spec-draft-ngl all --spec-type draft-dflash --spec-draft-n-max 7. nekko-classic: llama-server started with Nekko's exact default argv (n-gram --spec-default, no drafter), outside the router because Nekko's memory budget keeps one 27B model resident. lm-studio: LM Studio, llama.cpp runtime 2.81.0, lms load defaults (8192 context, parallel 4, its repeat penalty), same file by hard link. Code edits are judged on the reply's last python block (Qwen3.8 reasons inline despite /no_think).

### burst-code-edit-lm-studio-vs-llama-server-qwen38-27b

Run `runs/20261127T191331Z-burst-code-edit-lm-studio-vs-llama-server-qwen38-27b`: code edit: rename a function in a 156-line file and reply with the whole file; burst, 20 s pause before every request; 3 warmup and 6 measured requests per server, alternating.

Weights: `Qwen3.8-27B-Q4_K_M.gguf`, 19.40 GB, sha256 `d15d4b6de55f662a…`.

| Server | Decode tok/s, median (min–max) | TTFT ms, median | Prefill tok/s (server), median | Whole reply, s, median | Decode drift |
| --- | --- | --- | --- | --- | --- |
| lm-studio | 13.0 (12.7–13.0) | 10048 | n/a | 111.23 | +0.0% |
| llama-server-plain | 13.0 (13.0–13.0) | 10049 | 139 | 111.09 | +0.1% |

- lm-studio against llama-server-plain: decode -0.1%, whole reply 1.00x as fast.

- lm-studio replies: [1313] tokens, 1 different text in 6 replies, 6/6 correct edits.
- llama-server-plain replies: [1313] tokens, 1 different text in 6 replies, 6/6 correct edits.

Notes recorded with the run: M1 Max 64 GB, burst. Every llama.cpp arm runs llama.cpp b12565 (Nekko's pinned build). Pairwise against llama-server-plain (-m --port -c 8192; its default context would take the whole 64 GB) because two 27B servers fill the GPU working set. nekko-dflash2: Nekko router on 11500, preset draftModelId=Qwen3.8-27B-DFlash2-Q4_K_M; Nekko argv --ctx-size 65536 --cache-type-k q8_0 --cache-type-v q8_0 --cache-reuse 256 --no-cache-idle-slots --spec-default --spec-draft-model <drafter> --spec-draft-ngl all --spec-type draft-dflash --spec-draft-n-max 7. nekko-classic: llama-server started with Nekko's exact default argv (n-gram --spec-default, no drafter), outside the router because Nekko's memory budget keeps one 27B model resident. lm-studio: LM Studio, llama.cpp runtime 2.81.0, lms load defaults (8192 context, parallel 4, its repeat penalty), same file by hard link. Code edits are judged on the reply's last python block (Qwen3.8 reasons inline despite /no_think).

### burst-chat-nekko-dflash2-vs-llama-server-qwen38-27b

Run `runs/20261127T215445Z-burst-chat-nekko-dflash2-vs-llama-server-qwen38-27b`: chat: ~455-token prompt with background notes, 512 tokens generated; burst, 20 s pause before every request; 3 warmup and 16 measured requests per server, alternating.

Weights: `Qwen3.8-27B-Q4_K_M.gguf`, 19.40 GB, sha256 `d15d4b6de55f662a…`.

| Server | Decode tok/s, median (min–max) | TTFT ms, median | Prefill tok/s (server), median | Whole reply, s, median | Decode drift |
| --- | --- | --- | --- | --- | --- |
| nekko-dflash2 | 33.8 (24.9–56.3) | 3731 | 127 | 19.04 | -19.7% |
| llama-server-plain | 13.1 (13.1–13.2) | 4157 | 125 | 43.13 | -0.1% |

- nekko-dflash2 against llama-server-plain: decode 2.6x, whole reply 2.26x as fast.

- nekko-dflash2 speculative decoding: 452 draft tokens accepted per reply (median; 389–491), 49% of those drafted.
- nekko-dflash2 on chat: 33.5 tok/s over all its tokens and generation time (2.6x llama-server-plain); its speed follows each reply, and 2 of its 16 replies were the same text, so the median is not the figure to quote.

- nekko-dflash2 replies: [512] tokens, 15 different texts in 16 replies.
- llama-server-plain replies: [512] tokens, 11 different texts in 16 replies.

Notes recorded with the run: M1 Max 64 GB, burst. Every llama.cpp arm runs llama.cpp b12565 (Nekko's pinned build). Pairwise against llama-server-plain (-m --port -c 8192; its default context would take the whole 64 GB) because two 27B servers fill the GPU working set. nekko-dflash2: Nekko router on 11500, preset draftModelId=Qwen3.8-27B-DFlash2-Q4_K_M; Nekko argv --ctx-size 65536 --cache-type-k q8_0 --cache-type-v q8_0 --cache-reuse 256 --no-cache-idle-slots --spec-default --spec-draft-model <drafter> --spec-draft-ngl all --spec-type draft-dflash --spec-draft-n-max 7. nekko-classic: llama-server started with Nekko's exact default argv (n-gram --spec-default, no drafter), outside the router because Nekko's memory budget keeps one 27B model resident. lm-studio: LM Studio, llama.cpp runtime 2.81.0, lms load defaults (8192 context, parallel 4, its repeat penalty), same file by hard link. Code edits are judged on the reply's last python block (Qwen3.8 reasons inline despite /no_think).

### burst-chat-nekko-classic-vs-llama-server-qwen38-27b

Run `runs/20261127T222531Z-burst-chat-nekko-classic-vs-llama-server-qwen38-27b`: chat: ~455-token prompt with background notes, 512 tokens generated; burst, 20 s pause before every request; 3 warmup and 16 measured requests per server, alternating.

Weights: `Qwen3.8-27B-Q4_K_M.gguf`, 19.40 GB, sha256 `d15d4b6de55f662a…`.

| Server | Decode tok/s, median (min–max) | TTFT ms, median | Prefill tok/s (server), median | Whole reply, s, median | Decode drift |
| --- | --- | --- | --- | --- | --- |
| nekko-classic | 18.2 (13.6–51.1) | 3637 | 130 | 31.95 | -21.0% |
| llama-server-plain | 13.1 (13.1–13.2) | 4155 | 125 | 43.13 | +0.0% |

- nekko-classic against llama-server-plain: decode +38.7%, whole reply 1.35x as fast.

- nekko-classic speculative decoding: 224 draft tokens accepted per reply (median; 67–468), 54% of those drafted.
- nekko-classic on chat: 20.0 tok/s over all its tokens and generation time (1.5x llama-server-plain); its speed follows each reply, and 2 of its 16 replies were the same text, so the median is not the figure to quote.

- nekko-classic replies: [512] tokens, 14 different texts in 16 replies.
- llama-server-plain replies: [512] tokens, 12 different texts in 16 replies.

Notes recorded with the run: M1 Max 64 GB, burst. Every llama.cpp arm runs llama.cpp b12565 (Nekko's pinned build). Pairwise against llama-server-plain (-m --port -c 8192; its default context would take the whole 64 GB) because two 27B servers fill the GPU working set. nekko-dflash2: Nekko router on 11500, preset draftModelId=Qwen3.8-27B-DFlash2-Q4_K_M; Nekko argv --ctx-size 65536 --cache-type-k q8_0 --cache-type-v q8_0 --cache-reuse 256 --no-cache-idle-slots --spec-default --spec-draft-model <drafter> --spec-draft-ngl all --spec-type draft-dflash --spec-draft-n-max 7. nekko-classic: llama-server started with Nekko's exact default argv (n-gram --spec-default, no drafter), outside the router because Nekko's memory budget keeps one 27B model resident. lm-studio: LM Studio, llama.cpp runtime 2.81.0, lms load defaults (8192 context, parallel 4, its repeat penalty), same file by hard link. Code edits are judged on the reply's last python block (Qwen3.8 reasons inline despite /no_think).

### burst-chat-lm-studio-vs-llama-server-qwen38-27b

Run `runs/20261127T230006Z-burst-chat-lm-studio-vs-llama-server-qwen38-27b`: chat: ~455-token prompt with background notes, 512 tokens generated; burst, 20 s pause before every request; 3 warmup and 8 measured requests per server, alternating.

Weights: `Qwen3.8-27B-Q4_K_M.gguf`, 19.40 GB, sha256 `d15d4b6de55f662a…`.

| Server | Decode tok/s, median (min–max) | TTFT ms, median | Prefill tok/s (server), median | Whole reply, s, median | Decode drift |
| --- | --- | --- | --- | --- | --- |
| lm-studio | 13.1 (12.5–13.2) | 4108 | n/a | 43.09 | -0.0% |
| llama-server-plain | 13.1 (13.1–13.2) | 4075 | 126 | 43.04 | +0.1% |

- lm-studio against llama-server-plain: decode -0.1%, whole reply 1.00x as fast.

- lm-studio replies: [512] tokens, 1 different text in 8 replies.
- llama-server-plain replies: [512] tokens, 7 different texts in 8 replies.

Notes recorded with the run: M1 Max 64 GB, burst. Every llama.cpp arm runs llama.cpp b12565 (Nekko's pinned build). Pairwise against llama-server-plain (-m --port -c 8192; its default context would take the whole 64 GB) because two 27B servers fill the GPU working set. nekko-dflash2: Nekko router on 11500, preset draftModelId=Qwen3.8-27B-DFlash2-Q4_K_M; Nekko argv --ctx-size 65536 --cache-type-k q8_0 --cache-type-v q8_0 --cache-reuse 256 --no-cache-idle-slots --spec-default --spec-draft-model <drafter> --spec-draft-ngl all --spec-type draft-dflash --spec-draft-n-max 7. nekko-classic: llama-server started with Nekko's exact default argv (n-gram --spec-default, no drafter), outside the router because Nekko's memory budget keeps one 27B model resident. lm-studio: LM Studio, llama.cpp runtime 2.81.0, lms load defaults (8192 context, parallel 4, its repeat penalty), same file by hard link. Code edits are judged on the reply's last python block (Qwen3.8 reasons inline despite /no_think).

### burst-chat-nekko-dflash2-vs-llama-server-inkling-2-mini

Run `runs/20261128T163129Z-burst-chat-nekko-dflash2-vs-llama-server-inkling-2-mini`: chat: ~455-token prompt with background notes, 512 tokens generated; burst, 20 s pause before every request; 3 warmup and 16 measured requests per server, alternating.

Weights: `Inkling-2-Mini-Q4_K_M.gguf`, 18.66 GB, sha256 `ed38ac618a24ee65…`.

| Server | Decode tok/s, median (min–max) | TTFT ms, median | Prefill tok/s (server), median | Whole reply, s, median | Decode drift |
| --- | --- | --- | --- | --- | --- |
| nekko-dflash2 | 25.1 (22.8–38.9) | 4891 | 130 | 24.87 | +6.4% |
| llama-server-plain | 24.6 (24.5–24.9) | 2430 | 214 | 23.23 | -1.0% |

- nekko-dflash2 against llama-server-plain: decode +2.2%, whole reply 0.93x as fast.

- nekko-dflash2 speculative decoding: 412 draft tokens accepted per reply (median; 381–467), 44% of those drafted.
- nekko-dflash2 on chat: 26.3 tok/s over all its tokens and generation time (1.1x llama-server-plain); its speed follows each reply, and 1 of its 16 replies were the same text, so the median is not the figure to quote.

- nekko-dflash2 replies: [512] tokens, 16 different texts in 16 replies.
- llama-server-plain replies: [512] tokens, 16 different texts in 16 replies.

Notes recorded with the run: M1 Max 64 GB, burst. Inkling 2 Mini (inkling2_loop) does not load on Nekko's pinned llama.cpp b12565, so every llama.cpp arm here runs the official b12818 release (commit a38695013, archive sha256 b05fc72e...) and both Nekko arms are llama-server started with Nekko's exact argv, not through Nekko's router. This is what Nekko would deliver after its engine pin moves to b12818 or later; it is not what the shipped app does today. Drafter: maternion/Inkling-2-Mini-DFlash2-GGUF Q8_0 (community conversion). --no-think sets reasoning_effort none; Inkling still thinks briefly at effort 0. Pairwise against llama-server-plain (-m --port -c 8192; its default context would take the whole 64 GB) because two 27B servers fill the GPU working set. nekko-dflash2: Nekko router on 11500, preset draftModelId=draft/maternion_Inkling-2-Mini-DFlash2-GGUF/Inkling-2-Mini-DFlash2-Draft-Q8_0; Nekko argv --ctx-size 65536 --cache-type-k q8_0 --cache-type-v q8_0 --cache-reuse 256 --no-cache-idle-slots --spec-default --spec-draft-model <drafter> --spec-draft-ngl all --spec-type draft-dflash --spec-draft-n-max 7. nekko-classic: llama-server started with Nekko's exact default argv (n-gram --spec-default, no drafter), outside the router because Nekko's memory budget keeps one 27B model resident. lm-studio: LM Studio, llama.cpp runtime 2.81.0, lms load defaults (8192 context, parallel 4, its repeat penalty), same file by hard link. Code edits are judged on the reply's last python block (Qwen3.8 reasons inline despite /no_think).

### burst-chat-nekko-classic-vs-llama-server-inkling-2-mini

Run `runs/20261128T165723Z-burst-chat-nekko-classic-vs-llama-server-inkling-2-mini`: chat: ~455-token prompt with background notes, 512 tokens generated; burst, 20 s pause before every request; 3 warmup and 16 measured requests per server, alternating.

Weights: `Inkling-2-Mini-Q4_K_M.gguf`, 18.66 GB, sha256 `ed38ac618a24ee65…`.

| Server | Decode tok/s, median (min–max) | TTFT ms, median | Prefill tok/s (server), median | Whole reply, s, median | Decode drift |
| --- | --- | --- | --- | --- | --- |
| nekko-classic | 23.1 (22.0–40.1) | 4764 | 134 | 26.53 | -4.6% |
| llama-server-plain | 24.2 (23.9–24.9) | 2402 | 219 | 23.56 | -0.2% |

- nekko-classic against llama-server-plain: decode -4.2%, whole reply 0.89x as fast.

- nekko-classic speculative decoding: 124 draft tokens accepted per reply (median; 33–389), 39% of those drafted.
- nekko-classic on chat: 24.8 tok/s over all its tokens and generation time (1.0x llama-server-plain); its speed follows each reply, and 1 of its 16 replies were the same text, so the median is not the figure to quote.

- nekko-classic replies: [512] tokens, 16 different texts in 16 replies.
- llama-server-plain replies: [512] tokens, 16 different texts in 16 replies.

Notes recorded with the run: M1 Max 64 GB, burst. Inkling 2 Mini (inkling2_loop) does not load on Nekko's pinned llama.cpp b12565, so every llama.cpp arm here runs the official b12818 release (commit a38695013, archive sha256 b05fc72e...) and both Nekko arms are llama-server started with Nekko's exact argv, not through Nekko's router. This is what Nekko would deliver after its engine pin moves to b12818 or later; it is not what the shipped app does today. Drafter: maternion/Inkling-2-Mini-DFlash2-GGUF Q8_0 (community conversion). --no-think sets reasoning_effort none; Inkling still thinks briefly at effort 0. Pairwise against llama-server-plain (-m --port -c 8192; its default context would take the whole 64 GB) because two 27B servers fill the GPU working set. nekko-dflash2: Nekko router on 11500, preset draftModelId=draft/maternion_Inkling-2-Mini-DFlash2-GGUF/Inkling-2-Mini-DFlash2-Draft-Q8_0; Nekko argv --ctx-size 65536 --cache-type-k q8_0 --cache-type-v q8_0 --cache-reuse 256 --no-cache-idle-slots --spec-default --spec-draft-model <drafter> --spec-draft-ngl all --spec-type draft-dflash --spec-draft-n-max 7. nekko-classic: llama-server started with Nekko's exact default argv (n-gram --spec-default, no drafter), outside the router because Nekko's memory budget keeps one 27B model resident. lm-studio: LM Studio, llama.cpp runtime 2.81.0, lms load defaults (8192 context, parallel 4, its repeat penalty), same file by hard link. Code edits are judged on the reply's last python block (Qwen3.8 reasons inline despite /no_think).

### burst-chat-lm-studio-vs-llama-server-inkling-2-mini

Run `runs/20261128T172615Z-burst-chat-lm-studio-vs-llama-server-inkling-2-mini`: chat: ~455-token prompt with background notes, 512 tokens generated; burst, 20 s pause before every request; 3 warmup and 8 measured requests per server, alternating.

Weights: `Inkling-2-Mini-Q4_K_M.gguf`, 18.66 GB, sha256 `ed38ac618a24ee65…`.

| Server | Decode tok/s, median (min–max) | TTFT ms, median | Prefill tok/s (server), median | Whole reply, s, median | Decode drift |
| --- | --- | --- | --- | --- | --- |
| lm-studio | 22.4 (22.3–22.5) | 2436 | n/a | 25.27 | -0.3% |
| llama-server-plain | 24.1 (24.0–24.2) | 2421 | 219 | 23.61 | +0.6% |

- lm-studio against llama-server-plain: decode -7.2%, whole reply 0.93x as fast.

- lm-studio replies: [512] tokens, 8 different texts in 8 replies.
- llama-server-plain replies: [512] tokens, 8 different texts in 8 replies.

Notes recorded with the run: M1 Max 64 GB, burst. Inkling 2 Mini (inkling2_loop) does not load on Nekko's pinned llama.cpp b12565, so every llama.cpp arm here runs the official b12818 release (commit a38695013, archive sha256 b05fc72e...) and both Nekko arms are llama-server started with Nekko's exact argv, not through Nekko's router. This is what Nekko would deliver after its engine pin moves to b12818 or later; it is not what the shipped app does today. Drafter: maternion/Inkling-2-Mini-DFlash2-GGUF Q8_0 (community conversion). --no-think sets reasoning_effort none; Inkling still thinks briefly at effort 0. Pairwise against llama-server-plain (-m --port -c 8192; its default context would take the whole 64 GB) because two 27B servers fill the GPU working set. nekko-dflash2: Nekko router on 11500, preset draftModelId=draft/maternion_Inkling-2-Mini-DFlash2-GGUF/Inkling-2-Mini-DFlash2-Draft-Q8_0; Nekko argv --ctx-size 65536 --cache-type-k q8_0 --cache-type-v q8_0 --cache-reuse 256 --no-cache-idle-slots --spec-default --spec-draft-model <drafter> --spec-draft-ngl all --spec-type draft-dflash --spec-draft-n-max 7. nekko-classic: llama-server started with Nekko's exact default argv (n-gram --spec-default, no drafter), outside the router because Nekko's memory budget keeps one 27B model resident. lm-studio: LM Studio, llama.cpp runtime 2.81.0, lms load defaults (8192 context, parallel 4, its repeat penalty), same file by hard link. Code edits are judged on the reply's last python block (Qwen3.8 reasons inline despite /no_think).

<!-- results:end -->

## What the results say

Qwen3.8-27B (valid runs; chat figures are all tokens over all generation time):

| | Code edit: whole reply | Code edit: decode | Chat: decode |
| --- | --- | --- | --- |
| **Nekko + DFlash2** | **28.5 s (3.9x)** | **71.8 tok/s** | **33.5 tok/s (2.6x)** |
| Nekko classic (today's default) | 29.0 s (3.8x) | 69.7 tok/s | 20.0 tok/s (1.5x) |
| LM Studio | 111.2 s | 13.0 tok/s | 13.1 tok/s |
| Plain llama.cpp | 111.1 s | 13.0 tok/s | 13.1 tok/s |

Inkling 2 Mini (llama.cpp b12818; code edits exploratory):

| | Code edit: whole reply | Code edit: decode | Chat: decode | Chat: whole reply |
| --- | --- | --- | --- | --- |
| Nekko + DFlash2 | 48.6 s (1.9x) | 62.4 tok/s | 26.3 tok/s (1.1x) | 0.93x |
| Nekko classic | 48.8 s (1.9x) | 62.6 tok/s | 24.8 tok/s (1.0x) | 0.89x |
| LM Studio | 97.1 s | 22.3 tok/s | 22.4 tok/s (-7%) | 0.93x |
| Plain llama.cpp | 89 to 92 s | 23.3 to 24.0 tok/s | 24.1 to 24.6 tok/s | reference |

- **Where DFlash2 earns its place: chat on a dense model.** On Qwen3.8 chat it
  accepted about 450 drafted tokens per 512-token reply and lifted Nekko from
  1.5x to 2.6x. On code edits n-gram drafting already copies the file, and the
  two are within 3%.
- **Why Inkling gains less.** It is a mixture of experts (128 experts, 8 used per
  token) that runs its layers in a loop, so plain decode is already 1.8x faster
  than dense Qwen3.8 (24 against 13 tok/s) and a check of 8 drafted tokens
  touches more experts than writing one does. Its drafter accepted 44% of what
  it drafted on chat, against 49% for Qwen3.8.
- **Nekko's default load costs Inkling half its prefill.** Both Nekko arms, with
  and without the drafter, read the prompt at about 130 tok/s against about 215
  for plain llama.cpp; on Qwen3.8 the same flags cost nothing (136 against 138).
  The suspects are the q8_0 KV cache Nekko defaults to (#3327) and the 65,536
  context; not isolated yet.
- **The replies do not change on the dense model.** On Qwen3.8 code edits Nekko's
  1,313-token replies were the same text as plain llama.cpp's in every request,
  and all were correct. An earlier check (#3541) found one prompt where DFlash2
  with the q8_0 cache diverged from target-only output after 110 tokens; with an
  f16 cache it matched exactly.
- **LM Studio and plain llama.cpp:** level on Qwen3.8; LM Studio 7% slower on
  Inkling decode in both workloads.

## Not covered yet

1. **Ollama.** Not installed on this Mac; the first round found it level with
   plain llama.cpp on Qwen3-8B.
2. **LM Studio with its own speculative decoding.** LM Studio 0.4 offers MTP and
   draft-model speculative decoding (`lms load --speculative-draft-mtp`), off by
   default. A claim against "LM Studio" should say "default settings" until that
   is measured.
3. **MLX and the other engines.** MLX DFlash2 on Qwen3.8 was 3x *slower* than
   plain MLX in #3541's checks (single runs); Basalt and squid5090 are NVIDIA-only.
4. **Sustained load, long prompts, other Macs.** Burst only, prompts under 2,000
   tokens, one M1 Max.
5. **Inkling through Nekko's router**, once the engine pin loads it, and the
   prefill penalty traced flag by flag.

## Reproducing

```
python3 bench/scripts/stream_bench.py --name <name> --scenario burst --pause 20 --speculative \
  --workload code-edit --no-think --max-tokens 6144 --runs 6 --warmup 3 \
  --target a=http://127.0.0.1:<port>/v1 --target llama-server-plain=http://127.0.0.1:8090/v1 \
  --model m --model-file <weights>
python3 bench/scripts/report.py --report REPORT-m1-max-qwen38-inkling2.md --only qwen38 inkling
```

Chat: `--workload chat --runs 16` (8 for a server without speculative decoding).
Every server's command line is in its run's `manifest.json`.
