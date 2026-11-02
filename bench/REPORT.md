# Local inference speed on Apple Silicon: Nekko, llama.cpp, Ollama, LM Studio and MLX

Status: first round, measured 2026-10-27 to 2026-10-30. One machine (M5 Max, 128 GB), one model (Qwen3-8B), three
workloads. The public summary is [docs/benchmarks.md](../docs/benchmarks.md).

## Summary

**Code edits: Nekko returns the edited file 4–6x sooner than every other runtime measured.**
On a cool chip it took 2.5 s, against 11.4 s for LM Studio with MLX, 12.3 s for
mlx-lm, 13.8 s for plain llama.cpp, 13.9 s for Ollama and 14.6 s for LM Studio
with GGUF. After minutes of nonstop work: about 3 s against 13–18 s. Every
server made the correct edit in every request, and the servers running the same
weights wrote the same file. The difference is Nekko's default speculative
decoding, explained in the next section.

**Chat: Nekko is 1.6–6.7x faster with speculative decoding, how much depending
on what the model writes, and it was never slower in any of the 48 requests
measured.** It costs about 60 ms more before the first token (130 ms on a hot
chip).

**Plain decode, with speculative decoding off, is a draw among the llama.cpp
servers, and MLX is faster.** Nekko, Ollama and LM Studio (GGUF) run within 3%
of plain llama.cpp on a cool chip. mlx-lm decodes 13% faster and LM Studio's
MLX engine 22% faster, on an MLX file 13% smaller than the GGUF; LM Studio's MLX
engine is 8% faster than mlx-lm on the very same files.

So "4–6x faster on code edits than anything measured, and faster on chat" is
supported on this Mac and model. "Faster than everything on plain decode" is
not: MLX is ahead there. [What this means for Nekko](#what-this-means-for-nekko)
lists what could close that gap.

**A hint worth checking:** on code edits Nekko used roughly 4–7x less GPU energy
per token than the others (GPU power from `powermetrics`, one run). It needs a
proper energy measurement before it is claimed.

The heat of the chip moves the numbers more than the choice of server: after a
few minutes of nonstop work, decode falls 6–20%. Every result is reported in
two scenarios, burst and sustained.

## How speculative decoding makes Nekko faster

**Why generating text is slow.** A model writes one token (about one word
piece) at a time, and for every token the chip reads all of the model's
weights from memory: about 5 GB for this model. Memory bandwidth, not
arithmetic, sets the pace, which is why plain decode sits near 90–100 tokens
per second on this Mac whichever llama.cpp server runs it.

**The trick.** Reading the weights once costs about the same whether they are
applied to one token or to dozens: checking 64 tokens in one pass is not much
slower than writing one. So if someone can guess the next tokens, the model
can check a whole guess in one pass and keep every token it would have written
anyway.

**Where Nekko gets the guesses.** llama.cpp's n-gram speculative decoding, which
Nekko turns on by default (`--spec-default`), looks at the last tokens the
model wrote, finds the same sequence earlier in the conversation (the prompt or
the reply so far), and proposes the tokens that followed it there. There is no
second model; the guess is a lookup in text already in memory, so it is nearly
free.

**Code edits.** The reply copies most of the prompt: the file comes back with
one name changed. For every reply in the steady-state code-edit runs, Nekko
generated 1,216 tokens, proposed 1,280 (as 20 drafts of 64, the default
maximum, would give; the server reports only the total) and accepted 1,182
(92%). Each pass of the model yields the draft tokens it accepts plus one of its
own, so those 1,216 tokens took about **34 passes over the weights instead of
1,216**. The measured speedup is about 7x on decode, smaller than that ratio
because a pass that checks 64 tokens does more arithmetic than a pass that
writes one; the whole reply is about 5x sooner because reading the prompt takes
the same time either way.

**Chat.** There is less to copy, and how much depends on the reply. With the
chat prompt here (background notes that Qwen3's thinking tends to restate),
Nekko produced all its tokens 5.6x and 6.7x faster than plain llama.cpp in two
runs of 16 requests (an earlier run of 8, set aside by the checks, gave 2.5x);
single replies ranged from 161 to 937 tokens per second. With a one-sentence
question that leaves little in the prompt to copy, it was 1.6x faster, from
copying the reply's own repetitions. The slowest of the 48 speculative chat
requests in valid runs (109 tok/s, on the short question) was still faster than
plain llama.cpp (82–97).

**The reply does not change.** At temperature 0 the model keeps a drafted token
only if it is exactly the token it would have chosen. On code edits Nekko's
replies were identical, token for token, to plain llama.cpp's; on chat, the
replies Nekko wrote most often were texts plain llama.cpp also wrote.

**What it costs.** About 60 ms more before the first token on a cool chip and
130 ms on a hot one (311 against 248 ms; 422 against 290 ms), against 8–12 ms
with it off. And it is the workload most sensitive to heat: checking 64 tokens
per pass is more arithmetic, so the GPU works harder (56–65 W against about
51 W for plain llama.cpp), and under sustained load it lost 12.8% of its speed
against 8.8% for plain llama.cpp, while staying about 7x ahead.

## The question

"Benchmark local model tokens per second against vLLM, Ollama, LM Studio and
the like." This measures speed, not model quality: the same weights run under
each server, and only how fast the answer arrives is compared.

- **Decode**: tokens generated per second, one at a time. Limited mostly by
  memory bandwidth.
- **Prefill**: prompt tokens processed per second, all at once. Limited mostly
  by compute.
- **TTFT** (time to first token): how long the user waits before anything
  appears. Mostly prefill.

vLLM is out of scope: it targets NVIDIA and AMD GPUs on Linux, and this round
has only a Mac.

## Method

- **The same weights for every server of a format.** `Qwen3-8B-Q4_K_M.gguf`
  from the official `Qwen/Qwen3-8B-GGUF` repository for the llama.cpp-based
  servers, checked by sha256 in every run, including Ollama's and LM Studio's
  copies. `Qwen/Qwen3-8B-MLX-4bit` for the MLX servers, checked by a hash over
  every file of the folder.
- **The same request for every server**, through each one's OpenAI-compatible
  streaming API, temperature 0, seed 42. A random id at the start of each
  prompt stops servers from reusing a cached prompt. Every server counted the
  same prompt tokens, so they apply the same chat template.
- **Measured by the client, the same way for everyone**: TTFT from sending to
  the first token; decode as (tokens - 1) / (last token time - first token
  time). Where a server reports its own timings (llama-server, Nekko) they agree
  with the client within 0.5%.
- **Compared in the same run.** The servers compared stay loaded and requests
  alternate between them, so all see the same chip temperature. Plain
  llama-server is in every comparison, as the shared reference and as a
  thermometer.
- **Two scenarios.** Burst: a 20 s pause before every request, so each starts on
  a cool chip (chats with gaps). Sustained: measured after 240 or 420 s of
  nonstop requests (an agent working without a break); `powermetrics` shows
  macOS reports thermal pressure "Heavy" from about 3 minutes in.
- **Warmup and repetitions.** One unmeasured request per server, three for code
  edits and for speculative decoding; then 8 measured requests per server, 16
  for speculative decoding on chat. Medians with min and max; for speculative
  decoding on chat, all tokens over all generation time (see below).
- **Baseline.** llama.cpp's own `llama-bench`, with no HTTP and no app, gives
  the engine's ceiling on the same build and file.

### Why the numbers can be trusted

The scripts record the conditions themselves and refuse to run, or file the
run apart, when one is not met:

- on AC power and not charging, Low Power Mode off, no thermal warning;
- no model process running except the servers being measured, including LM
  Studio's, which hold models inside LM Studio's own worker processes;
- no other process using more than 50% CPU during the measurement;
- the scripts committed to git, so the code that ran is known;
- every chat reply uses the full token budget, every code edit finishes on its
  own, and servers on the same edit generate the same length;
- decode moves less than 3% from the first requests to the last. A speculative
  decoding server on chat is exempt, because its speed follows each reply; the
  servers without it must hold still instead.

Each run folder holds `raw.jsonl` (every request, with every token's arrival
time and the reply's text) and `manifest.json` (the server command lines and
versions, the weights' hashes, the machine, power and process state before,
during and after, the settings and the verdict). The tables below are generated
from those files by `bench/scripts/report.py`, which also re-checks every run against
the current rules.

The reference server measured in separate sessions over three days gave the
same burst decode within 0.2% (96.2–96.4 tok/s).

## What was measured

| | Engine | Settings |
| --- | --- | --- |
| llama-bench | llama.cpp build 11224 (the build Nekko ships) | `-ngl 999`, everything else default |
| Plain llama-server | llama.cpp build 11224 | only the model and the port; defaults chose 4 slots of 40,960 tokens |
| Nekko, speculative decoding off | llama.cpp build 11224 behind Nekko's router | Nekko's saved settings: `--ctx-size 32768 --cache-reuse 256 --no-cache-idle-slots`, slot count left to llama-server |
| Nekko, speculative decoding on | the same | the same plus `--spec-default` (n-gram speculative decoding, no draft model): **Nekko's default** |
| Ollama 0.40.11 | its bundled llama-server, llama.cpp build 11845 | all defaults: 40,960 context, one slot, flash attention auto, batch 2048 |
| LM Studio 0.4.16, GGUF | its llama.cpp runtime 2.66.0, inside its own worker | `lms load` defaults: 8,192 context, 4 parallel, its default repeat penalty |
| LM Studio 0.4.16, MLX | its MLX runtime mlx-llm 1.13.1 (MLX 0.32.3) | `lms load` defaults, as above |
| mlx-lm 0.32.2 | MLX 0.32.4 | only the model and the port |

LM Studio applies a repeat penalty by default, so at temperature 0 its text
differs from the others'; with the penalty off its GGUF text is the same as
plain llama-server's. Its code edits were correct either way. Its MLX engine
reports 511 completion tokens for a 512-token budget while streaming as much
text; the checks accept that and the decode figure is off by 0.2%.

The three workloads:

- **Chat**: a fixed prompt of about 455 tokens with background notes, 512 tokens
  generated, Qwen3's thinking on.
- **Short chat**: a one-sentence question (about 48 tokens) with little to copy,
  512 tokens generated: the unfavourable case for n-gram speculative decoding.
- **Code edit**: a 156-line Python file (`bench/scripts/code_edit_source.py`) with the
  request to rename one function everywhere and reply with the whole file,
  about 1,280 prompt tokens and 1,216 generated, thinking off with Qwen3's own
  `/no_think` switch. Every reply is saved and checked against the expected
  file. The MLX servers and LM Studio stream the empty thinking block Qwen3
  emits; the llama.cpp servers hide it, so their time to first token includes
  about 4 generated tokens (~45 ms).

## Results

<!-- results:start -->

_Generated by `bench/scripts/report.py` from the run manifests. Do not edit by hand._

Machine: Apple M5 Max (Mac17,6), 128 GB, macOS 26.6.2 (25G83).

### llama-bench-b11224-qwen3-8b

Run `runs/20261027T175042Z-llama-bench-b11224-qwen3-8b`: `~/.nekko-agent/engine/macos-arm64-metal/llama-b11224/llama-bench -m ~/.nekko-agent/models/chat/Qwen_Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf -p 512 -n 256 -r 5 -o json -ngl 999`.

Weights: `Qwen3-8B-Q4_K_M.gguf`, 5.03 GB, sha256 `d98cdcbd03e17ce4…`.

| Test | tok/s, mean ± stddev | Samples |
| --- | --- | --- |
| pp512 | 2778.1 ± 1.7 | 2776.9, 2779.7, 2777.4, 2776.2, 2780.1 |
| tg256 | 98.3 ± 0.9 | 98.9, 98.8, 98.7, 98.3, 96.6 |

### burst-nekko-vs-llama-server-default-qwen3-8b

Run `runs/20261028T101107Z-burst-nekko-vs-llama-server-default-qwen3-8b`: chat: ~455-token prompt with background notes, 512 tokens generated; burst, 20 s pause before every request; 1 warmup and 8 measured requests per server, alternating.

Weights: `Qwen3-8B-Q4_K_M.gguf`, 5.03 GB, sha256 `d98cdcbd03e17ce4…`.

| Server | Decode tok/s, median (min–max) | TTFT ms, median | Prefill tok/s (server), median | Whole reply, s, median | Decode drift |
| --- | --- | --- | --- | --- | --- |
| nekko | 96.1 (96.0–96.3) | 256 | 2178 | 5.57 | -0.1% |
| llama-server-default | 96.3 (96.2–96.4) | 248 | 2263 | 5.56 | -0.1% |

- nekko against llama-server-default: decode -0.2%, whole reply 1.00x as fast.

Notes recorded with the run: Nekko: router on 11500, saved settings, speculative decoding off. llama-server b11224: only -m and --port.

### sustained-nekko-vs-llama-server-default-qwen3-8b

Run `runs/20261028T103234Z-sustained-nekko-vs-llama-server-default-qwen3-8b`: chat: ~455-token prompt with background notes, 512 tokens generated; sustained, measured after 240 s of nonstop requests; 1 warmup and 8 measured requests per server, alternating.

Weights: `Qwen3-8B-Q4_K_M.gguf`, 5.03 GB, sha256 `d98cdcbd03e17ce4…`.

| Server | Decode tok/s, median (min–max) | TTFT ms, median | Prefill tok/s (server), median | Whole reply, s, median | Decode drift |
| --- | --- | --- | --- | --- | --- |
| nekko | 86.7 (86.2–86.9) | 298 | 1804 | 6.19 | -0.4% |
| llama-server-default | 87.0 (86.6–87.2) | 286 | 1860 | 6.16 | -0.4% |

- nekko against llama-server-default: decode -0.4%, whole reply 1.00x as fast.

Notes recorded with the run: Nekko: router on 11500, saved settings, speculative decoding off. llama-server b11224: only -m and --port.

### burst-ollama-vs-llama-server-default-qwen3-8b

Run `runs/20261028T142018Z-burst-ollama-vs-llama-server-default-qwen3-8b`: chat: ~455-token prompt with background notes, 512 tokens generated; burst, 20 s pause before every request; 1 warmup and 8 measured requests per server, alternating.

Weights: `Qwen3-8B-Q4_K_M.gguf`, 5.03 GB, sha256 `d98cdcbd03e17ce4…`.

| Server | Decode tok/s, median (min–max) | TTFT ms, median | Prefill tok/s (server), median | Whole reply, s, median | Decode drift |
| --- | --- | --- | --- | --- | --- |
| ollama | 95.4 (95.3–95.6) | 246 | 2295 | 5.60 | -0.1% |
| llama-server-default | 96.4 (96.2–96.5) | 243 | 2249 | 5.55 | -0.2% |

- ollama against llama-server-default: decode -1.0%, whole reply 0.99x as fast.

Notes recorded with the run: Ollama 0.40.11 (brew, ollama serve, all defaults), GGUF imported with a FROM-only Modelfile, blob sha256 d98cdcbd...5785. It ran its bundled llama-server build 11845 with -c 40960 -np 1 --flash-attn auto -b 2048 -ub 2048 --context-shift --keep 4. Reference: llama-server b11224 with only -m and --port.

### sustained-ollama-vs-llama-server-default-qwen3-8b

Run `runs/20261028T144401Z-sustained-ollama-vs-llama-server-default-qwen3-8b`: chat: ~455-token prompt with background notes, 512 tokens generated; sustained, measured after 240 s of nonstop requests; 1 warmup and 8 measured requests per server, alternating.

Weights: `Qwen3-8B-Q4_K_M.gguf`, 5.03 GB, sha256 `d98cdcbd03e17ce4…`.

| Server | Decode tok/s, median (min–max) | TTFT ms, median | Prefill tok/s (server), median | Whole reply, s, median | Decode drift |
| --- | --- | --- | --- | --- | --- |
| ollama | 85.5 (85.2–85.8) | 296 | 1777 | 6.27 | -0.5% |
| llama-server-default | 86.2 (85.7–86.4) | 294 | 1765 | 6.22 | -0.3% |

- ollama against llama-server-default: decode -0.8%, whole reply 0.99x as fast.

Notes recorded with the run: Ollama 0.40.11 (brew, ollama serve, all defaults), GGUF imported with a FROM-only Modelfile, blob sha256 d98cdcbd...5785. It ran its bundled llama-server build 11845 with -c 40960 -np 1 --flash-attn auto -b 2048 -ub 2048 --context-shift --keep 4. Reference: llama-server b11224 with only -m and --port.

### burst-code-edit-nekko-spec-vs-llama-server-vs-ollama-qwen3-8b

Run `runs/20261029T034529Z-burst-code-edit-nekko-spec-vs-llama-server-vs-ollama-qwen3-8b`: code edit: rename a function in a 156-line file and reply with the whole file; burst, 20 s pause before every request; 3 warmup and 8 measured requests per server, alternating.

Weights: `Qwen3-8B-Q4_K_M.gguf`, 5.03 GB, sha256 `d98cdcbd03e17ce4…`.

| Server | Decode tok/s, median (min–max) | TTFT ms, median | Prefill tok/s (server), median | Whole reply, s, median | Decode drift |
| --- | --- | --- | --- | --- | --- |
| nekko-spec | 684.6 (681.7–686.4) | 671 | 2331 | 2.46 | -0.3% |
| llama-server-default | 92.2 (92.1–92.7) | 605 | 2471 | 13.78 | -0.1% |
| ollama | 91.2 (91.0–91.8) | 558 | 2748 | 13.90 | -0.1% |

- nekko-spec against llama-server-default: decode 7.4x, whole reply 5.61x as fast.
- ollama against llama-server-default: decode -1.2%, whole reply 0.99x as fast.

- nekko-spec speculative decoding: 1182 draft tokens accepted per reply (median; 1182–1182), 92% of those drafted.

- nekko-spec replies: [1216] tokens, 1 different text in 8 replies, 8/8 correct edits.
- llama-server-default replies: [1216] tokens, 1 different text in 8 replies, 8/8 correct edits.
- ollama replies: [1216] tokens, 1 different text in 8 replies, 8/8 correct edits.

Notes recorded with the run: Code edit. Nekko: router on 11500, saved settings, speculative decoding ON (--spec-default, n-gram, no draft model). llama-server b11224: only -m and --port. Ollama 0.40.11 defaults (bundled llama-server build 11845). 3 warmup requests per server: Nekko with speculative decoding is faster for its first 2-3 requests after loading, then steady (diagnosis run 20261029T033406Z).

### sustained-code-edit-nekko-spec-vs-llama-server-vs-ollama-qwen3-8b

Run `runs/20261029T041309Z-sustained-code-edit-nekko-spec-vs-llama-server-vs-ollama-qwen3-8b`: code edit: rename a function in a 156-line file and reply with the whole file; sustained, measured after 240 s of nonstop requests; 3 warmup and 8 measured requests per server, alternating.

Weights: `Qwen3-8B-Q4_K_M.gguf`, 5.03 GB, sha256 `d98cdcbd03e17ce4…`.

| Server | Decode tok/s, median (min–max) | TTFT ms, median | Prefill tok/s (server), median | Whole reply, s, median | Decode drift |
| --- | --- | --- | --- | --- | --- |
| nekko-spec | 600.1 (598.8–607.0) | 914 | 1697 | 2.95 | -0.7% |
| llama-server-default | 84.4 (84.1–84.9) | 622 | 2361 | 15.03 | -0.8% |
| ollama | 83.3 (82.9–83.6) | 731 | 1970 | 15.33 | -0.7% |

- nekko-spec against llama-server-default: decode 7.1x, whole reply 5.10x as fast.
- ollama against llama-server-default: decode -1.3%, whole reply 0.98x as fast.

- nekko-spec speculative decoding: 1182 draft tokens accepted per reply (median; 1182–1182), 92% of those drafted.

- nekko-spec replies: [1216] tokens, 1 different text in 8 replies, 8/8 correct edits.
- llama-server-default replies: [1216] tokens, 1 different text in 8 replies, 8/8 correct edits.
- ollama replies: [1216] tokens, 1 different text in 8 replies, 8/8 correct edits.

Notes recorded with the run: Code edit. Nekko: router on 11500, saved settings, speculative decoding ON (--spec-default, n-gram, no draft model). llama-server b11224: only -m and --port. Ollama 0.40.11 defaults (bundled llama-server build 11845). 3 warmup requests per server: Nekko with speculative decoding is faster for its first 2-3 requests after loading, then steady (diagnosis run 20261029T033406Z).

### burst-chat-mlx-lm-vs-llama-server-default-qwen3-8b

Run `runs/20261029T062418Z-burst-chat-mlx-lm-vs-llama-server-default-qwen3-8b`: chat: ~455-token prompt with background notes, 512 tokens generated; burst, 20 s pause before every request; 1 warmup and 8 measured requests per server, alternating.

Weights:

- mlx-lm: `Qwen3-8B-MLX-4bit`, 4.37 GB, sha256 `a4ff938f55ffbba1…` (over every file in the folder)
- llama-server-default: `Qwen3-8B-Q4_K_M.gguf`, 5.03 GB, sha256 `d98cdcbd03e17ce4…`

| Server | Decode tok/s, median (min–max) | TTFT ms, median | Prefill tok/s (server), median | Whole reply, s, median | Decode drift |
| --- | --- | --- | --- | --- | --- |
| mlx-lm | 108.5 (108.4–108.9) | 241 | n/a | 4.95 | -0.3% |
| llama-server-default | 96.4 (96.1–96.6) | 249 | 2265 | 5.55 | -0.3% |

- mlx-lm against llama-server-default: decode +12.6%, whole reply 1.12x as fast.

- mlx-lm replies: [512] tokens, 8 different texts in 8 replies.
- llama-server-default replies: [512] tokens, 3 different texts in 8 replies.

Notes recorded with the run: mlx-lm 0.32.2 (MLX 0.32.4), mlx_lm.server with only --model and --port, Qwen/Qwen3-8B-MLX-4bit (4-bit, group size 128, 4.35 GB). Reference: llama-server b11224 with only -m and --port, GGUF Q4_K_M (5.03 GB). Different weights: the MLX file is 13% smaller.

### burst-code-edit-nekko-spec-vs-llama-server-vs-mlx-lm-qwen3-8b

Run `runs/20261029T071127Z-burst-code-edit-nekko-spec-vs-llama-server-vs-mlx-lm-qwen3-8b`: code edit: rename a function in a 156-line file and reply with the whole file; burst, 20 s pause before every request; 3 warmup and 8 measured requests per server, alternating.

Weights:

- nekko-spec: `Qwen3-8B-Q4_K_M.gguf`, 5.03 GB, sha256 `d98cdcbd03e17ce4…`
- llama-server-default: `Qwen3-8B-Q4_K_M.gguf`, 5.03 GB, sha256 `d98cdcbd03e17ce4…`
- mlx-lm: `Qwen3-8B-MLX-4bit`, 4.37 GB, sha256 `a4ff938f55ffbba1…` (over every file in the folder)

| Server | Decode tok/s, median (min–max) | TTFT ms, median | Prefill tok/s (server), median | Whole reply, s, median | Decode drift |
| --- | --- | --- | --- | --- | --- |
| nekko-spec | 685.8 (684.2–690.1) | 669 | 2339 | 2.45 | -0.4% |
| llama-server-default | 92.3 (91.9–92.5) | 608 | 2476 | 13.78 | -0.4% |
| mlx-lm | 102.8 (102.3–103.0) | 455 | n/a | 12.29 | +0.3% |

- nekko-spec against llama-server-default: decode 7.4x, whole reply 5.61x as fast.
- mlx-lm against llama-server-default: decode +11.4%, whole reply 1.12x as fast.

- nekko-spec speculative decoding: 1182 draft tokens accepted per reply (median; 1182–1182), 92% of those drafted.

- nekko-spec replies: [1216] tokens, 1 different text in 8 replies, 8/8 correct edits.
- llama-server-default replies: [1216] tokens, 1 different text in 8 replies, 8/8 correct edits.
- mlx-lm replies: [1216] tokens, 1 different text in 8 replies, 8/8 correct edits.

Notes recorded with the run: Code edit. Nekko: router on 11500, speculative decoding ON (--spec-default). llama-server b11224: only -m and --port, GGUF Q4_K_M. mlx-lm 0.32.2 (MLX 0.32.4) with only --model and --port, MLX 4-bit (13% smaller file). 3 warmup requests per server. mlx-lm streams Qwen3's empty think block, the llama.cpp servers hide it, so their TTFT includes ~4 generated tokens.

### sustained-chat-mlx-lm-vs-llama-server-default-qwen3-8b

Run `runs/20261029T082749Z-sustained-chat-mlx-lm-vs-llama-server-default-qwen3-8b`: chat: ~455-token prompt with background notes, 512 tokens generated; sustained, measured after 420 s of nonstop requests; 1 warmup and 8 measured requests per server, alternating.

Weights:

- mlx-lm: `Qwen3-8B-MLX-4bit`, 4.37 GB, sha256 `a4ff938f55ffbba1…` (over every file in the folder)
- llama-server-default: `Qwen3-8B-Q4_K_M.gguf`, 5.03 GB, sha256 `d98cdcbd03e17ce4…`

| Server | Decode tok/s, median (min–max) | TTFT ms, median | Prefill tok/s (server), median | Whole reply, s, median | Decode drift |
| --- | --- | --- | --- | --- | --- |
| mlx-lm | 102.0 (101.8–102.1) | 273 | n/a | 5.29 | -0.3% |
| llama-server-default | 87.6 (87.5–88.3) | 239 | 2206 | 6.07 | -0.1% |

- mlx-lm against llama-server-default: decode +16.5%, whole reply 1.15x as fast.

- mlx-lm replies: [512] tokens, 8 different texts in 8 replies.
- llama-server-default replies: [512] tokens, 3 different texts in 8 replies.

Notes recorded with the run: mlx-lm 0.32.2 (MLX 0.32.4), mlx_lm.server with only --model and --port, Qwen/Qwen3-8B-MLX-4bit (4-bit, group size 128, 4.35 GB). Reference: llama-server b11224 with only -m and --port, GGUF Q4_K_M (5.03 GB). 420 s preheat: a 240 s preheat left llama-server oscillating between 88 and 96 tok/s while mlx-lm held flat. powermetrics recorded alongside.

### sustained-code-edit-nekko-spec-vs-llama-server-vs-mlx-lm-qwen3-8b

Run `runs/20261029T093818Z-sustained-code-edit-nekko-spec-vs-llama-server-vs-mlx-lm-qwen3-8b`: code edit: rename a function in a 156-line file and reply with the whole file; sustained, measured after 420 s of nonstop requests; 3 warmup and 8 measured requests per server, alternating.

Weights:

- nekko-spec: `Qwen3-8B-Q4_K_M.gguf`, 5.03 GB, sha256 `d98cdcbd03e17ce4…`
- llama-server-default: `Qwen3-8B-Q4_K_M.gguf`, 5.03 GB, sha256 `d98cdcbd03e17ce4…`
- mlx-lm: `Qwen3-8B-MLX-4bit`, 4.37 GB, sha256 `a4ff938f55ffbba1…` (over every file in the folder)

| Server | Decode tok/s, median (min–max) | TTFT ms, median | Prefill tok/s (server), median | Whole reply, s, median | Decode drift |
| --- | --- | --- | --- | --- | --- |
| nekko-spec | 599.8 (595.1–615.6) | 831 | 1842 | 2.87 | -1.4% |
| llama-server-default | 84.6 (84.4–84.9) | 624 | 2331 | 15.02 | -0.3% |
| mlx-lm | 95.8 (95.5–96.1) | 574 | n/a | 13.26 | -0.3% |

- nekko-spec against llama-server-default: decode 7.1x, whole reply 5.23x as fast.
- mlx-lm against llama-server-default: decode +13.3%, whole reply 1.13x as fast.

- nekko-spec speculative decoding: 1182 draft tokens accepted per reply (median; 1182–1182), 92% of those drafted.

- nekko-spec replies: [1216] tokens, 1 different text in 8 replies, 8/8 correct edits.
- llama-server-default replies: [1216] tokens, 1 different text in 8 replies, 8/8 correct edits.
- mlx-lm replies: [1216] tokens, 1 different text in 8 replies, 8/8 correct edits.

Notes recorded with the run: Code edit. Nekko: router on 11500, speculative decoding ON (--spec-default). llama-server b11224: only -m and --port, GGUF Q4_K_M. mlx-lm 0.32.2 (MLX 0.32.4) with only --model and --port, MLX 4-bit (13% smaller file). 3 warmup requests per server. 420 s preheat: after 240 s Nekko kept slowing while the others held. mlx-lm streams Qwen3's empty think block, the llama.cpp servers hide it. powermetrics recorded alongside.

### burst-chat-lm-studio-gguf-vs-llama-server-default-qwen3-8b

Run `runs/20261029T135509Z-burst-chat-lm-studio-gguf-vs-llama-server-default-qwen3-8b`: chat: ~455-token prompt with background notes, 512 tokens generated; burst, 20 s pause before every request; 1 warmup and 8 measured requests per server, alternating.

Weights: `Qwen3-8B-Q4_K_M.gguf`, 5.03 GB, sha256 `d98cdcbd03e17ce4…`.

| Server | Decode tok/s, median (min–max) | TTFT ms, median | Prefill tok/s (server), median | Whole reply, s, median | Decode drift |
| --- | --- | --- | --- | --- | --- |
| lm-studio | 93.8 (93.5–94.0) | 337 | n/a | 5.79 | -0.1% |
| llama-server-default | 96.3 (96.2–96.3) | 250 | 2257 | 5.56 | -0.1% |

- lm-studio against llama-server-default: decode -2.6%, whole reply 0.96x as fast.

- lm-studio replies: [512] tokens, 7 different texts in 8 replies.
- llama-server-default replies: [512] tokens, 4 different texts in 8 replies.

Notes recorded with the run: LM Studio 0.4.16, llama.cpp runtime 2.66.0, server on 1234, GGUF imported with lms import --copy (same sha256), loaded with lms load defaults: context 8192, parallel 4. LM Studio applies a repeat penalty by default, so its text differs from llama-server's at temperature 0; with the penalty off it is the same. Reference: llama-server b11224 with only -m and --port.

### burst-code-edit-nekko-spec-vs-llama-server-vs-lm-studio-gguf-qwen3-8b

Run `runs/20261029T141908Z-burst-code-edit-nekko-spec-vs-llama-server-vs-lm-studio-gguf-qwen3-8b`: code edit: rename a function in a 156-line file and reply with the whole file; burst, 20 s pause before every request; 3 warmup and 8 measured requests per server, alternating.

Weights: `Qwen3-8B-Q4_K_M.gguf`, 5.03 GB, sha256 `d98cdcbd03e17ce4…`.

| Server | Decode tok/s, median (min–max) | TTFT ms, median | Prefill tok/s (server), median | Whole reply, s, median | Decode drift |
| --- | --- | --- | --- | --- | --- |
| nekko-spec | 685.7 (684.7–689.7) | 677 | 2332 | 2.46 | -0.3% |
| llama-server-default | 92.3 (92.1–92.8) | 598 | 2472 | 13.78 | -0.1% |
| lm-studio | 87.2 (87.1–87.6) | 613 | n/a | 14.55 | +0.0% |

- nekko-spec against llama-server-default: decode 7.4x, whole reply 5.61x as fast.
- lm-studio against llama-server-default: decode -5.5%, whole reply 0.95x as fast.

- nekko-spec speculative decoding: 1182 draft tokens accepted per reply (median; 1182–1182), 92% of those drafted.

- nekko-spec replies: [1216] tokens, 1 different text in 8 replies, 8/8 correct edits.
- llama-server-default replies: [1216] tokens, 1 different text in 8 replies, 8/8 correct edits.
- lm-studio replies: [1216] tokens, 1 different text in 8 replies, 8/8 correct edits.

Notes recorded with the run: Code edit. Nekko: router on 11500, speculative decoding ON (--spec-default). llama-server b11224: only -m and --port. LM Studio 0.4.16, llama.cpp runtime 2.66.0, lms load defaults (context 8192, parallel 4, its default repeat penalty), same GGUF by sha256. 3 warmup requests per server. LM Studio streams Qwen3's empty think block, llama-server hides it.

### sustained-code-edit-nekko-spec-vs-llama-server-vs-lm-studio-gguf-qwen3-8b

Run `runs/20261029T155338Z-sustained-code-edit-nekko-spec-vs-llama-server-vs-lm-studio-gguf-qwen3-8b`: code edit: rename a function in a 156-line file and reply with the whole file; sustained, measured after 420 s of nonstop requests; 3 warmup and 8 measured requests per server, alternating.

Weights: `Qwen3-8B-Q4_K_M.gguf`, 5.03 GB, sha256 `d98cdcbd03e17ce4…`.

| Server | Decode tok/s, median (min–max) | TTFT ms, median | Prefill tok/s (server), median | Whole reply, s, median | Decode drift |
| --- | --- | --- | --- | --- | --- |
| nekko-spec | 560.8 (559.9–568.4) | 962 | 1672 | 3.13 | -0.6% |
| llama-server-default | 77.7 (77.5–78.2) | 686 | 2144 | 16.34 | -0.2% |
| lm-studio | 69.9 (67.2–70.2) | 930 | n/a | 18.32 | +0.2% |

- nekko-spec against llama-server-default: decode 7.2x, whole reply 5.22x as fast.
- lm-studio against llama-server-default: decode -10.0%, whole reply 0.89x as fast.

- nekko-spec speculative decoding: 1182 draft tokens accepted per reply (median; 1182–1182), 92% of those drafted.

- nekko-spec replies: [1216] tokens, 1 different text in 8 replies, 8/8 correct edits.
- llama-server-default replies: [1216] tokens, 1 different text in 8 replies, 8/8 correct edits.
- lm-studio replies: [1216] tokens, 1 different text in 8 replies, 8/8 correct edits.

Notes recorded with the run: Code edit. Nekko: router on 11500, speculative decoding ON (--spec-default). llama-server b11224: only -m and --port. LM Studio 0.4.16, llama.cpp runtime 2.66.0, lms load defaults (context 8192, parallel 4, its default repeat penalty), same GGUF by sha256. 3 warmup requests per server. LM Studio streams Qwen3's empty think block, llama-server hides it.

### sustained-chat-nekko-spec-vs-llama-server-vs-lm-studio-gguf-qwen3-8b

Run `runs/20261029T163057Z-sustained-chat-nekko-spec-vs-llama-server-vs-lm-studio-gguf-qwen3-8b`: chat: ~455-token prompt with background notes, 512 tokens generated; sustained, measured after 420 s of nonstop requests; 3 warmup and 16 measured requests per server, alternating.

Weights: `Qwen3-8B-Q4_K_M.gguf`, 5.03 GB, sha256 `d98cdcbd03e17ce4…`.

| Server | Decode tok/s, median (min–max) | TTFT ms, median | Prefill tok/s (server), median | Whole reply, s, median | Decode drift |
| --- | --- | --- | --- | --- | --- |
| nekko-spec | 651.9 (172.7–661.6) | 422 | 1642 | 1.21 | -13.9% |
| llama-server-default | 82.4 (80.9–83.0) | 290 | 1868 | 6.48 | -1.3% |
| lm-studio | 76.1 (75.1–77.2) | 456 | n/a | 7.17 | -2.1% |

- nekko-spec against llama-server-default: decode 7.9x, whole reply 5.37x as fast.
- lm-studio against llama-server-default: decode -7.6%, whole reply 0.90x as fast.

- nekko-spec speculative decoding: 500 draft tokens accepted per reply (median; 310–500), 90% of those drafted.
- nekko-spec on chat: 458.3 tok/s over all its tokens and generation time (5.6x llama-server-default); its speed follows each reply, and 11 of its 16 replies were the same text, so the median is not the figure to quote.

- nekko-spec replies: [512] tokens, 6 different texts in 16 replies.
- llama-server-default replies: [512] tokens, 6 different texts in 16 replies.
- lm-studio replies: [512] tokens, 10 different texts in 16 replies.

Notes recorded with the run: Chat. Nekko: router on 11500, speculative decoding ON (--spec-default), its default; its speed varies with each reply. llama-server b11224: only -m and --port. LM Studio 0.4.16, llama.cpp runtime 2.66.0, lms load defaults (context 8192, parallel 4, its default repeat penalty), same GGUF by sha256. 3 warmup requests per server.

### burst-chat-nekko-spec-vs-llama-server-default-qwen3-8b

Run `runs/20261029T165259Z-burst-chat-nekko-spec-vs-llama-server-default-qwen3-8b`: chat: ~455-token prompt with background notes, 512 tokens generated; burst, 20 s pause before every request; 3 warmup and 16 measured requests per server, alternating.

Weights: `Qwen3-8B-Q4_K_M.gguf`, 5.03 GB, sha256 `d98cdcbd03e17ce4…`.

| Server | Decode tok/s, median (min–max) | TTFT ms, median | Prefill tok/s (server), median | Whole reply, s, median | Decode drift |
| --- | --- | --- | --- | --- | --- |
| nekko-spec | 935.1 (161.2–936.8) | 311 | 2150 | 0.86 | +103.6% |
| llama-server-default | 96.3 (96.2–96.3) | 248 | 2262 | 5.55 | -0.0% |

- nekko-spec against llama-server-default: decode 9.7x, whole reply 6.47x as fast.

- nekko-spec speculative decoding: 500 draft tokens accepted per reply (median; 250–500), 93% of those drafted.
- nekko-spec on chat: 641.3 tok/s over all its tokens and generation time (6.7x llama-server-default); its speed follows each reply, and 14 of its 16 replies were the same text, so the median is not the figure to quote.

- nekko-spec replies: [512] tokens, 3 different texts in 16 replies.
- llama-server-default replies: [512] tokens, 6 different texts in 16 replies.

Notes recorded with the run: Chat. Nekko: router on 11500, speculative decoding ON (--spec-default), its default; its speed varies with each reply. llama-server b11224: only -m and --port. 3 warmup requests per server.

### burst-chat-short-nekko-spec-vs-llama-server-default-qwen3-8b

Run `runs/20261029T171336Z-burst-chat-short-nekko-spec-vs-llama-server-default-qwen3-8b`: short chat: a one-sentence question, 512 tokens generated; burst, 20 s pause before every request; 3 warmup and 16 measured requests per server, alternating.

Weights: `Qwen3-8B-Q4_K_M.gguf`, 5.03 GB, sha256 `d98cdcbd03e17ce4…`.

| Server | Decode tok/s, median (min–max) | TTFT ms, median | Prefill tok/s (server), median | Whole reply, s, median | Decode drift |
| --- | --- | --- | --- | --- | --- |
| nekko-spec | 150.8 (108.6–351.2) | 173 | 533 | 3.55 | +2.8% |
| llama-server-default | 97.1 (97.0–97.2) | 110 | 584 | 5.37 | -0.2% |

- nekko-spec against llama-server-default: decode 1.6x, whole reply 1.51x as fast.

- nekko-spec speculative decoding: 212 draft tokens accepted per reply (median; 63–428), 57% of those drafted.
- nekko-spec on chat: 154.2 tok/s over all its tokens and generation time (1.6x llama-server-default); its speed follows each reply, and 1 of its 16 replies were the same text, so the median is not the figure to quote.

- nekko-spec replies: [512] tokens, 16 different texts in 16 replies.
- llama-server-default replies: [512] tokens, 13 different texts in 16 replies.

Notes recorded with the run: Short chat: a one-sentence question with little in the prompt to copy, the unfavourable case for n-gram speculative decoding. Nekko: router on 11500, speculative decoding ON (--spec-default). llama-server b11224: only -m and --port. 3 warmup requests per server.

### burst-chat-lm-studio-mlx-vs-mlx-lm-vs-llama-server-qwen3-8b

Run `runs/20261029T173624Z-burst-chat-lm-studio-mlx-vs-mlx-lm-vs-llama-server-qwen3-8b`: chat: ~455-token prompt with background notes, 512 tokens generated; burst, 20 s pause before every request; 1 warmup and 8 measured requests per server, alternating.

Weights:

- lm-studio-mlx: `Qwen3-8B-MLX-4bit`, 4.37 GB, sha256 `a4ff938f55ffbba1…` (over every file in the folder)
- mlx-lm: `Qwen3-8B-MLX-4bit`, 4.37 GB, sha256 `a4ff938f55ffbba1…` (over every file in the folder)
- llama-server-default: `Qwen3-8B-Q4_K_M.gguf`, 5.03 GB, sha256 `d98cdcbd03e17ce4…`

| Server | Decode tok/s, median (min–max) | TTFT ms, median | Prefill tok/s (server), median | Whole reply, s, median | Decode drift |
| --- | --- | --- | --- | --- | --- |
| lm-studio-mlx | 117.5 (117.2–117.7) | 286 | n/a | 4.63 | +0.3% |
| mlx-lm | 108.6 (108.3–108.8) | 237 | n/a | 4.95 | +0.3% |
| llama-server-default | 96.3 (96.1–96.4) | 245 | 2246 | 5.56 | -0.1% |

- lm-studio-mlx against llama-server-default: decode +22.0%, whole reply 1.20x as fast.
- mlx-lm against llama-server-default: decode +12.9%, whole reply 1.12x as fast.

- lm-studio-mlx replies: [511] tokens, 8 different texts in 8 replies.
- mlx-lm replies: [512] tokens, 8 different texts in 8 replies.
- llama-server-default replies: [512] tokens, 6 different texts in 8 replies.

Notes recorded with the run: LM Studio 0.4.16 with its MLX engine (mlx-llm runtime 1.13.1), lms load defaults (context 8192, parallel 4, its default repeat penalty), against mlx-lm 0.32.2 (MLX 0.32.4) on the same MLX 4-bit files. LM Studio MLX reports 511 completion tokens for a 512-token budget. Reference and thermometer: llama-server b11224, GGUF Q4_K_M, only -m and --port.

### burst-code-edit-lm-studio-mlx-vs-mlx-lm-vs-llama-server-qwen3-8b

Run `runs/20261029T175922Z-burst-code-edit-lm-studio-mlx-vs-mlx-lm-vs-llama-server-qwen3-8b`: code edit: rename a function in a 156-line file and reply with the whole file; burst, 20 s pause before every request; 3 warmup and 8 measured requests per server, alternating.

Weights:

- lm-studio-mlx: `Qwen3-8B-MLX-4bit`, 4.37 GB, sha256 `a4ff938f55ffbba1…` (over every file in the folder)
- mlx-lm: `Qwen3-8B-MLX-4bit`, 4.37 GB, sha256 `a4ff938f55ffbba1…` (over every file in the folder)
- llama-server-default: `Qwen3-8B-Q4_K_M.gguf`, 5.03 GB, sha256 `d98cdcbd03e17ce4…`

| Server | Decode tok/s, median (min–max) | TTFT ms, median | Prefill tok/s (server), median | Whole reply, s, median | Decode drift |
| --- | --- | --- | --- | --- | --- |
| lm-studio-mlx | 111.7 (107.2–111.8) | 481 | n/a | 11.36 | +0.1% |
| mlx-lm | 103.0 (102.8–103.0) | 452 | n/a | 12.26 | -0.0% |
| llama-server-default | 92.2 (91.8–92.7) | 605 | 2478 | 13.79 | +0.0% |

- lm-studio-mlx against llama-server-default: decode +21.1%, whole reply 1.21x as fast.
- mlx-lm against llama-server-default: decode +11.7%, whole reply 1.12x as fast.

- lm-studio-mlx replies: [1216] tokens, 1 different text in 8 replies, 8/8 correct edits.
- mlx-lm replies: [1216] tokens, 1 different text in 8 replies, 8/8 correct edits.
- llama-server-default replies: [1216] tokens, 1 different text in 8 replies, 8/8 correct edits.

Notes recorded with the run: Code edit. LM Studio 0.4.16 with its MLX engine (mlx-llm runtime 1.13.1), lms load defaults (its default repeat penalty), against mlx-lm 0.32.2 (MLX 0.32.4) on the same MLX 4-bit files. Reference and thermometer: llama-server b11224, GGUF Q4_K_M. 3 warmup requests per server. Both MLX servers stream Qwen3's empty think block; llama-server hides it.

### sustained-code-edit-lm-studio-mlx-vs-mlx-lm-vs-llama-server-qwen3-8b

Run `runs/20261029T182624Z-sustained-code-edit-lm-studio-mlx-vs-mlx-lm-vs-llama-server-qwen3-8b`: code edit: rename a function in a 156-line file and reply with the whole file; sustained, measured after 420 s of nonstop requests; 3 warmup and 8 measured requests per server, alternating.

Weights:

- lm-studio-mlx: `Qwen3-8B-MLX-4bit`, 4.37 GB, sha256 `a4ff938f55ffbba1…` (over every file in the folder)
- mlx-lm: `Qwen3-8B-MLX-4bit`, 4.37 GB, sha256 `a4ff938f55ffbba1…` (over every file in the folder)
- llama-server-default: `Qwen3-8B-Q4_K_M.gguf`, 5.03 GB, sha256 `d98cdcbd03e17ce4…`

| Server | Decode tok/s, median (min–max) | TTFT ms, median | Prefill tok/s (server), median | Whole reply, s, median | Decode drift |
| --- | --- | --- | --- | --- | --- |
| lm-studio-mlx | 100.0 (99.7–101.8) | 714 | n/a | 12.86 | -0.1% |
| mlx-lm | 93.1 (93.0–93.7) | 690 | n/a | 13.74 | +0.2% |
| llama-server-default | 78.0 (77.8–78.3) | 820 | 1712 | 16.42 | +0.4% |

- lm-studio-mlx against llama-server-default: decode +28.2%, whole reply 1.28x as fast.
- mlx-lm against llama-server-default: decode +19.4%, whole reply 1.19x as fast.

- lm-studio-mlx replies: [1216] tokens, 1 different text in 8 replies, 8/8 correct edits.
- mlx-lm replies: [1216] tokens, 1 different text in 8 replies, 8/8 correct edits.
- llama-server-default replies: [1216] tokens, 1 different text in 8 replies, 8/8 correct edits.

Notes recorded with the run: Code edit. LM Studio 0.4.16 with its MLX engine (mlx-llm runtime 1.13.1), lms load defaults (its default repeat penalty), against mlx-lm 0.32.2 (MLX 0.32.4) on the same MLX 4-bit files. Reference and thermometer: llama-server b11224, GGUF Q4_K_M. 3 warmup requests per server. Both MLX servers stream Qwen3's empty think block; llama-server hides it.

### llama-bench-b11224-qwen3-8b-depth512

Run `runs/20261030T044522Z-llama-bench-b11224-qwen3-8b-depth512`: `~/.nekko-agent/engine/macos-arm64-metal/llama-b11224/llama-bench -m ~/.nekko-agent/models/chat/Qwen_Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf -p 512 -n 256 -r 5 -o json -ngl 999 -d 512`.

Weights: `Qwen3-8B-Q4_K_M.gguf`, 5.03 GB, sha256 `d98cdcbd03e17ce4…`.

| Test | tok/s, mean ± stddev | Samples |
| --- | --- | --- |
| pp512 | 2587.0 ± 4.4 | 2585.3, 2593.1, 2581.1, 2588.5, 2587.0 |
| tg256 | 97.4 ± 0.7 | 97.8, 97.8, 97.7, 97.6, 96.1 |

### sustained-chat-lm-studio-mlx-vs-mlx-lm-vs-llama-server-qwen3-8b

Run `runs/20261030T045253Z-sustained-chat-lm-studio-mlx-vs-mlx-lm-vs-llama-server-qwen3-8b`: chat: ~455-token prompt with background notes, 512 tokens generated; sustained, measured after 420 s of nonstop requests; 1 warmup and 8 measured requests per server, alternating.

Weights:

- lm-studio-mlx: `Qwen3-8B-MLX-4bit`, 4.37 GB, sha256 `a4ff938f55ffbba1…` (over every file in the folder)
- mlx-lm: `Qwen3-8B-MLX-4bit`, 4.37 GB, sha256 `a4ff938f55ffbba1…` (over every file in the folder)
- llama-server-default: `Qwen3-8B-Q4_K_M.gguf`, 5.03 GB, sha256 `d98cdcbd03e17ce4…`

| Server | Decode tok/s, median (min–max) | TTFT ms, median | Prefill tok/s (server), median | Whole reply, s, median | Decode drift |
| --- | --- | --- | --- | --- | --- |
| lm-studio-mlx | 111.6 (109.8–113.7) | 305 | n/a | 4.88 | -1.1% |
| mlx-lm | 101.2 (100.6–104.2) | 229 | n/a | 5.29 | -2.3% |
| llama-server-default | 87.9 (87.3–91.4) | 242 | 2195 | 6.06 | -2.1% |

- lm-studio-mlx against llama-server-default: decode +27.1%, whole reply 1.24x as fast.
- mlx-lm against llama-server-default: decode +15.2%, whole reply 1.15x as fast.

- lm-studio-mlx replies: [511] tokens, 8 different texts in 8 replies.
- mlx-lm replies: [512] tokens, 7 different texts in 8 replies.
- llama-server-default replies: [512] tokens, 5 different texts in 8 replies.

Notes recorded with the run: LM Studio 0.4.16 with its MLX engine (mlx-llm runtime 1.13.1), lms load defaults (context 8192, parallel 4, its default repeat penalty), against mlx-lm 0.32.2 (MLX 0.32.4) on the same MLX 4-bit files. LM Studio MLX reports 511 completion tokens for a 512-token budget. Reference and thermometer: llama-server b11224, GGUF Q4_K_M, only -m and --port.

### Runs not used

Saved under `runs/` because they passed the checks in force when they ran, but they fail the current rules, so no number above comes from them.

- `runs/20261027T175105Z-llama-bench-b11224-qwen3-8b-depth512`: the battery is charging; wait until it is charged.
- `runs/20261028T092442Z-llama-server-default-b11224-qwen3-8b`: llama-server-default: decode drifted -6.5%; no scenario: neither paused between requests nor preheated; the battery is charging; wait until it is charged.
- `runs/20261028T093603Z-calibrate-burst-pause20`: the battery is charging; wait until it is charged.
- `runs/20261028T093853Z-calibrate-sustained-preheat180`: the battery is charging; wait until it is charged.

<!-- results:end -->

## What the results say

Code edit (whole file returned, median of 8):

| | Burst | Sustained |
| --- | --- | --- |
| **Nekko** (speculative decoding) | **2.5 s** | **2.9–3.1 s** |
| LM Studio, MLX | 11.4 s | 12.9 s |
| mlx-lm | 12.3 s | 13.3–13.7 s |
| Plain llama.cpp | 13.8 s | 15.0–16.4 s |
| Ollama | 13.9 s | 15.3 s |
| LM Studio, GGUF | 14.6 s | 18.3 s |

Sustained runs were measured in different sessions, and the reference moved
between them (15.0–16.4 s), so compare sustained figures within a run: there
Nekko is 4.6x mlx-lm, 5.1–5.2x plain llama.cpp and Ollama, and 5.9x LM Studio
with GGUF, and through the shared reference about 4x LM Studio with MLX.

Chat decode, against plain llama.cpp in the same run:

| | Burst | Sustained |
| --- | --- | --- |
| Nekko, speculative decoding on (all tokens over all time) | **6.7x** (1.6x on the short chat) | **5.6x** |
| LM Studio, MLX | +22.0% | +27.0% |
| mlx-lm | +12.6% | +15–16% |
| Nekko, speculative decoding off | -0.2% | -0.3% |
| Ollama | -1.0% | -0.8% |
| LM Studio, GGUF | -2.6% | -7.6% |

- **On plain decode the llama.cpp servers are level**; the small, consistent
  gaps come from how each one wraps the same engine. LM Studio with GGUF loses
  most, and more under heat or on code edits (-5.5% burst, -10% sustained).
- **MLX's lead is mostly the smaller file.** Decode reads the whole file for
  every token; tokens per second times file size gives about 485 GB/s for
  llama.cpp and 472 GB/s for mlx-lm, so the engines read memory at about the
  same rate. LM Studio's MLX engine is 8% faster than mlx-lm on the very same
  files (+8.2% chat, +8.4% and +7.4% code edit, +10% sustained chat); why is not
  known (see below).
- **Prefill**: Nekko about 3–4% slower than plain llama-server; Ollama about 11%
  faster on the 1,280-token prompt, where its batch of 2048 starts to matter;
  mlx-lm about 100 ms quicker to the first token there. LM Studio is slower to
  the first token than plain llama.cpp in both formats (+87 ms on chat with GGUF,
  +30–75 ms with MLX against mlx-lm).
- **The servers add no measurable overhead on decode**: plain llama-server's
  burst decode (96.3) sits just under `llama-bench` at 512 tokens of context
  (97.4) and at an empty context (98.3).
- **Heat matters more than the server**: sustained decode is 6–20% below burst
  depending on the server (LM Studio with GGUF loses most), and prefill about 20% for the llama.cpp servers.

## What we learned about measuring

- **The chip heats up within a minute.** Eight back-to-back requests drifted
  6.5% downward. Hence the two scenarios and the drift check.
- **Charging matters.** A sustained run with the battery charging settled near
  72 tok/s; the same setup fully charged held 87. Charging now fails the checks.
- **Not every server feels heat the same way, and the GPU clock does not
  explain it.** `powermetrics` (attached to two runs) showed thermal pressure
  going Nominal, Moderate at about 2 minutes, Heavy at about 3. Plain llama.cpp's
  decode swung between 88 and 96 tok/s while the GPU clock fell steadily;
  mlx-lm held flat for 5 minutes and then slowed by about 4%. A 240 s preheat
  was not always enough to reach a steady state; 420 s was.
- **A server's own state can look like heat.** Nekko with speculative decoding
  is faster for its first 2–3 requests after loading (757, 722, then 685–687
  tok/s for 17 more), so such runs warm every server with 3 requests.
- **A median can mislead with speculative decoding on chat.** In one run 11 of
  Nekko's 16 replies were the same text, one that repeats a lot, so its median
  was 652 tok/s while all its tokens over all its time came to 458. The report
  quotes the latter, and a range across runs.
- **Servers differ in small ways that break naive scripts.** Thinking arrives
  as `reasoning_content` (llama-server, LM Studio) or `reasoning` (Ollama,
  mlx-lm); LM Studio applies a repeat penalty by default and holds its models
  inside its own worker processes; its MLX engine counts one token fewer.
- **A setting left on by mistake invalidates a run.** Early runs showed 600–860
  tok/s because speculative decoding was still on; the server's draft counters
  showed it, and the scripts now reject drafts unless they are the point.
- Early exploratory runs (on battery, conditions not recorded) are kept apart in
  `exploratory/` and used for nothing here.

## What this means for Nekko

These are proposals the data raises, not results.

1. **Bring n-gram speculative decoding to MLX.** Nekko can already start
   `mlx_lm.server` (`mlx_args` in `crates/nekko-engine/src/launch.rs`), but there
   its speculative decoding needs a separate draft model; the n-gram kind that
   gives the gains above is llama.cpp's. MLX's faster decode combined with
   n-gram drafting would be the fastest option on a Mac for both chat and code.
2. **Find out why LM Studio's MLX engine is 8% faster than mlx-lm** on the same
   files. Its package is named `nax`, which may mean it uses the M5's GPU neural
   accelerators; that is a guess. If the cause is reusable, Nekko's MLX path
   could adopt it; the engine's code and licence need checking first.
3. **Cut the cost of speculative decoding before the first token** (+60–130 ms)
   and the 3–4% prefill gap: both are Nekko's own, measured, and can be traced
   flag by flag.
4. **Measure a newer llama.cpp build and a larger batch** for long prompts, as
   Ollama uses (build 11845 against Nekko's 11224, batch 2048), before adopting
   them.

## Not covered yet

1. **Other edits.** One file and one kind of edit (a rename) were measured.
   Edits that rewrite more of the file copy less, and speculative decoding
   helps less; a few more edit kinds would show the range.
2. **Energy per edit**, measured properly (whole machine, several runs), to
   confirm or drop the 4–7x hint.
3. **Long prompts** (8k tokens and more, as in agent sessions), where batch size
   and the newer llama.cpp build in Ollama may matter.
4. **Resuming a chat after a pause**, where Nekko's cache settings were 40%
   faster than Ollama on NVIDIA.
5. **Another model** (a mixture-of-experts one) and **another Mac**, since most
   users do not have an M5 Max with 128 GB.
6. **Model quality**: MLX 4-bit compresses harder than Q4_K_M; whether that
   costs answer quality is not measured.

## Reproducing

Scripts are standard-library Python. Start the servers, then for example:

```
python3 bench/scripts/stream_bench.py --name <name> --scenario burst --pause 20 \
  --target a=http://127.0.0.1:<port>/v1 --target b=http://127.0.0.1:<port>/v1 \
  --model <name> --model-file <path to the weights> --runs 8
python3 bench/scripts/report.py
```

`--workload` picks chat, chat-short or code-edit; `--speculative` allows draft
tokens; `--target-model` and `--target-model-file` set a different model name or
weights per server. The exact command line of every server measured is in its
run's `manifest.json`.
