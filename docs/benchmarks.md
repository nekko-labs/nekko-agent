# Local inference benchmarks

How fast Nekko Agent runs a local model compared with plain llama.cpp, Ollama, LM Studio and MLX, on the same machine and the same model weights, measured the same way. vLLM is supported by the NVIDIA harness but not measured here: it targets NVIDIA and AMD GPUs on Linux.

The numbers are from one machine per section. They are not a promise about yours; run the harness (below) to get your own. The runner, every run's raw data and the full report are in [`bench/`](../bench/README.md), for anyone to check and improve.

## Apple Silicon, 2026-10-30

**Model:** Qwen3-8B. GGUF `Qwen3-8B-Q4_K_M.gguf` (official `Qwen/Qwen3-8B-GGUF`) for the llama.cpp-based servers, the same file by sha256 for each; `Qwen/Qwen3-8B-MLX-4bit` for the MLX servers, 13% smaller. **Machine:** MacBook Pro, Apple M5 Max, 128 GB, macOS 26.6.2, on AC power. Medians of 8 requests per server (16 for speculative decoding on chat), servers alternating request by request. **Burst**: a 20 s pause before each request, a cool chip. **Sustained**: after 4–7 minutes of nonstop requests, a hot chip.

### Code edit: rename a function in a 156-line file and return the whole file

Every server made the correct edit in every request, and the servers running the same weights wrote the same file.

| Whole file returned | Burst | Sustained |
| --- | --- | --- |
| **Nekko Agent** | **2.5 s** | **2.9–3.1 s** |
| LM Studio 0.4.16, MLX | 11.4 s | 12.9 s |
| mlx-lm 0.32.2 | 12.3 s | 13.3–13.7 s |
| llama.cpp `llama-server` (b11224), defaults | 13.8 s | 15.0–16.4 s |
| Ollama 0.40.11 | 13.9 s | 15.3 s |
| LM Studio 0.4.16, GGUF | 14.6 s | 18.3 s |

Sustained runs were measured in separate sessions, so compare them within a run: there Nekko Agent was 4.6x mlx-lm, 5.1–5.2x llama.cpp and Ollama, and 5.9x LM Studio with GGUF.

### Chat: a ~455-token prompt with background notes, 512 tokens generated

| Decode, against llama.cpp in the same run | Burst | Sustained |
| --- | --- | --- |
| **Nekko Agent** (speculative decoding on, its default) | **6.7x** | **5.6x** |
| Nekko Agent, on a one-sentence question with little to copy | **1.6x** | not measured |
| LM Studio 0.4.16, MLX | +22% | +27% |
| mlx-lm 0.32.2 | +13% | +15–16% |
| Nekko Agent, speculative decoding off | -0.2% | -0.3% |
| Ollama 0.40.11 | -1.0% | -0.8% |
| LM Studio 0.4.16, GGUF | -2.6% | -7.6% |

llama.cpp itself decoded 96 tokens/s on a cool chip and 82–88 on a hot one. With speculative decoding on, Nekko Agent's speed follows what each reply repeats, so the figures above are all its tokens over all its generation time. Single replies ranged from 161 to 937 tokens/s on this prompt and from 109 to 351 on the one-sentence question; none of the 48 speculative chat requests was slower than llama.cpp.

### How speculative decoding makes Nekko Agent faster

A model writes one token at a time, and for every token the chip reads all of the model's weights from memory, about 5 GB here. Memory bandwidth sets the pace, which is why plain decode sits near 90–100 tokens/s whichever llama.cpp server runs it. Reading the weights once costs about the same whether they are applied to one token or to dozens, so if the next tokens can be guessed, the model can check a whole guess in one pass and keep every token it would have written anyway.

Nekko Agent turns on llama.cpp's n-gram speculative decoding (`--spec-default`) by default: it looks at the last tokens the model wrote, finds the same sequence earlier in the conversation, and proposes the tokens that followed it there. No second model; the guess is a lookup in text already in memory. In a code edit the reply copies most of the prompt: of 1,216 tokens generated, 1,182 came from accepted guesses, so the reply took about 34 passes over the weights instead of 1,216, and arrived about 5x sooner. At temperature 0 a guessed token is kept only if it is exactly the token the model would have chosen, so the reply is the same: Nekko Agent's code edits were identical, token for token, to llama.cpp's.

### Where Nekko Agent is not ahead

- **Plain decode.** With speculative decoding off, Nekko Agent runs at llama.cpp's speed, level with Ollama and LM Studio's GGUF engine. The MLX servers decode 13–27% faster, mostly because their file is 13% smaller (tokens per second times file size is about the same for MLX and llama.cpp), and LM Studio's MLX engine is 8% faster than mlx-lm on the very same files, for reasons not yet known.
- **Time to first token.** Speculative decoding adds about 60 ms before the first token on a cool chip and 130 ms on a hot one; with it off, Nekko Agent is within 8–12 ms of llama.cpp. Its prefill is 3–4% slower than llama.cpp's.
- **Heat.** Speculative decoding works the GPU harder and lost the most under sustained load (12.8% against 8.8% for llama.cpp), while staying about 7x ahead on code edits.

### How it was measured

The same request went to every server through its OpenAI-compatible streaming API at temperature 0, with a random id at the start of each prompt so no server could reuse a cached prompt; every server counted the same prompt tokens. Time to first token and decode (tokens after the first, over the time from the first token to the last) were measured by the client the same way for everyone; where llama-server reports its own timings they agreed within 0.5%. Plain llama-server was in every comparison as the shared reference: its burst decode stayed within 0.2% (96.2–96.4 tokens/s) across three days of sessions.

The runner records the conditions of every run and keeps only runs that pass its checks: AC power and not charging, no other model loaded, no other busy process, the weights hashed, every reply complete, and the speed of the servers without speculative decoding steady from the first request to the last. Heat moves the numbers more than the choice of server (6–20% between burst and sustained), so every comparison alternates its servers within one run. The full report, with every run's tables, what each server ran with and what the measurements taught us, is [bench/REPORT.md](../bench/REPORT.md).

## NVIDIA RTX 5090, Windows, 2026-09-30

**Model:** `gemma-4-12B-it-Q4_K_M.gguf` (lmstudio-community), the same file for every server. **Machine:** NVIDIA RTX 5090 32 GB, AMD Ryzen 9 9950X3D, Windows 11. Median of 3 runs; 32k context; everything on the GPU.

| Measure | Nekko Agent engine | llama.cpp as the engine ran it before | Ollama 0.23.0 | LM Studio (llama.cpp CUDA 12, 2.46.0) |
| --- | --- | --- | --- | --- |
| Decode, tokens/s | **154** | 127 | 115 | 116 |
| Code edit that repeats its input, tokens/s | **534** | 117 | 106 | 108 |
| Four requests at once, total tokens/s | **256** | 283 | 113 | 210 |
| Time to first token, short prompt | **99 ms** | 98 ms | 153 ms | 114 ms |
| Prefill of an 8k-token prompt, tokens/s | 5,832 | 5,968 | **6,170** | 5,886 |
| New agent session (8k-token context), first turn to first token | 1,719 ms | 2,280 ms | **1,280 ms** | 2,565 ms |
| Agent session, later turns to first token | 253 ms | 219 ms | **211 ms** | 288 ms |
| Agent session, six turns end to end | 7.9 s | 8.4 s | **7.6 s** | 9.3 s |

Six chats visited in turn, three rounds each, more chats than the server has slots (what a person with several agent chats open does):

| | Nekko Agent engine | llama.cpp default prompt cache | llama.cpp, no RAM prompt cache | Ollama | LM Studio |
| --- | --- | --- | --- | --- | --- |
| Revisit of a chat, to first token | **790 ms** | 1,729 ms | 1,894 ms | 1,290 ms | 1,600 ms |
| All three rounds, end to end | **27.1 s** | 32.0 s | 38.4 s | 31.7 s | 33.3 s |

### Reading these results honestly

- **Where Nekko Agent is clearly ahead:** edits that repeat their input (about 4.5x the other servers, from n-gram speculative decoding), plain decode (about a third faster), coming back to a chat that lost its slot (about 40% faster than Ollama), and parallel requests (Ollama serves one at a time by default).
- **Where it is not:** the first turn of a brand-new long conversation is slower than Ollama's (1.7 s against 1.3 s), and prefill is level with everyone. The first-turn gap was 2.3 s before this work; the remaining difference is under investigation.
- **Noise:** run-to-run variation was about 10% on prefill and larger on the four-request number (the same configuration measured 256, 283 and 343 tokens/s across runs). Differences smaller than that are not claims.
- "Nekko Agent engine" here is `llama-server` from the pinned llama.cpp build started with exactly the flags the engine now passes, measured without the engine's router in front of it. The router (Rust, in the engine daemon) adds about 0.1 ms per request: 27.39 ms against 27.29 ms straight to the model server, median of 30 one-token requests.

### What changed to get there

Measured flag by flag on the same model and build (b11011):

- **`--spec-default`** (n-gram speculative decoding from the conversation, no draft model): code edit 117 to 506-534 tokens/s, decode 127 to 154-155.
- **`--no-cache-idle-slots`**: llama.cpp's default copies every idle slot to its RAM prompt cache when a new request arrives. Keeping them in place cut the first turn of a new chat from 2.3 s to 1.7 s and a revisit of an evicted chat from 1.7 s to 0.8 s. The RAM cache still catches what a slot really loses (turning it off entirely was worse on both).
- **`--cache-reuse 256`**: reuse cached chunks around an edit in the middle of a prompt.
- **Vision models keep it.** With Gemma's projector loaded as well, the code edit ran at 633 tokens/s and decode at 152; llama.cpp only drops `--cache-reuse` for multimodal models.
- **A draft model is opt-in, not automatic.** Gemma 4 E4B as the draft for the 12B raised the code edit to 624 tokens/s but halved ordinary decode (155 to 74) because only 55% of its guesses were accepted. A draft helps only when it is much smaller than its target.
- Parallel slots and a shared KV pool were already llama.cpp's default (`-np` auto with a unified cache), so nothing changed there.

Each flag is passed only when the installed engine build supports it (the engine reads the binary's `--help` once), so an older engine keeps working without them.

## Reproducing

### Apple Silicon results: `bench/`

The Apple Silicon results come from the runner in [`bench/`](../bench/README.md): standard-library Python, nothing to install. It measures; it does not start servers. Start each server with the same weights, then:

```bash
python3 bench/scripts/stream_bench.py --name burst-chat-a-vs-b \
  --scenario burst --pause 20 \
  --target a=http://127.0.0.1:8080/v1 --target b=http://127.0.0.1:8090/v1 \
  --model <model name> --model-file <the .gguf, or an MLX model folder> --runs 8
python3 bench/scripts/report.py
```

`--workload` picks `chat`, `chat-short` or `code-edit`; `--scenario sustained --preheat 420` measures a hot chip. The runner refuses to start, or files the run apart, when a condition would make the numbers wrong: on battery or charging, another model loaded, another process busy, uncommitted scripts, speed drifting during the run. [bench/README.md](../bench/README.md) lists every check, and every run folder records the server command lines, the weights' hashes and the machine's state.

### NVIDIA results: `crates/nekko-bench`

The harness is `crates/nekko-bench`. It measures; it does not start servers.

```bash
cargo build --release -p nekko-bench
```

Start each server with the same GGUF, then list them in a config file:

```json
{
  "machine": "RTX 5090 32 GB, Windows 11",
  "model": "gemma-4-12B-it Q4_K_M",
  "repeats": 3,
  "targets": [
    { "name": "Nekko Agent engine", "baseUrl": "http://127.0.0.1:18095/v1", "model": "gemma" },
    { "name": "Ollama", "baseUrl": "http://127.0.0.1:11434/v1", "model": "bench-gemma" },
    { "name": "LM Studio", "baseUrl": "http://127.0.0.1:1234/v1", "model": "bench-gemma" }
  ]
}
```

```bash
target/release/nekko-bench bench.json --out results.json --markdown results.md
```

`--only decode,agent` runs a subset. The workloads: `decode`, `prefill`, `agent` (six turns over an 8k-token context), `rotate` (six chats, three rounds), `code-edit`, `concurrent` (four at once).

How each server was started for the results above:

- **Nekko Agent engine:** `llama-server --model <gguf> --alias gemma --port 18095 --ctx-size 32768 --n-gpu-layers 999 --cache-reuse 256 --spec-default --no-cache-idle-slots`
- **llama.cpp as before:** the same without the last three flags.
- **Ollama:** a Modelfile with `FROM <gguf>`, `PARAMETER num_ctx 32768`, `PARAMETER num_gpu 999`, then `ollama create bench-gemma -f Modelfile`.
- **LM Studio:** `lms server start` and `lms load google/gemma-4-12b --context-length 32768 --gpu max --identifier bench-gemma`.

The harness counts tokens from each server's usage report when it sends one, and times the first streamed piece of text or reasoning as the first token.

## Switching models

How long it takes to switch to a local model that is not loaded, depending on where its weights are: a cold file on a fast SSD, a cold file on a slow disk, or a file already in memory. This is the groundwork for the model scheduler ([#1462](https://github.com/nekko-labs/nekko-agent/issues/1462)); the full write-up is in [the Phase 0 report](../reports/model-switching-phase0-2026-11-01.md).

RTX 5090, Windows 11, llama.cpp b11149 CUDA, default load mode, 2026-11-01:

| Model | From | Cold | Already in memory |
| --- | --- | --- | --- |
| Qwen3 8B Q4_K_M (5.0 GB) | 7200 rpm hard disk | 24.4 s | 3.0 s |
| Gemma 4 12B Q4_K_M (7.4 GB) | 7200 rpm hard disk | 35.2 s | 4.6 s |
| Qwen3 8B Q4_K_M (5.0 GB) | PCIe 5 NVMe | 3.4 s | 2.5 s |
| Gemma 4 12B Q4_K_M (7.4 GB) | PCIe 5 NVMe | 6.1 s | 5.5 s |

From a hard disk, having the model in memory makes the switch 7-8 times faster. From a fast NVMe the disk is not what you wait for: llama.cpp's direct I/O load mode (`--load-mode dio`) loads Qwen3 8B cold in 1.8 s.

### Measuring it: `nekko-bench switch`

Unlike the serving benchmark, this one starts `llama-server` itself, because the load is what it measures. For each model and each folder you list, it writes a fresh copy with the OS cache bypassed, measures the disk's raw read speed on it, loads it cold, reads it once through the cache, and loads it again. Each load is split by the server's own log clock into startup, weights and serve, and the first and a second request are timed. It stops rather than load a model that would leave less than `minFreeGb` of memory.

```json
{
  "machine": "RTX 5090 32 GB, Windows 11",
  "server": "C:/Users/me/.nekko-agent/engine/win-x64-cuda/llama-server.exe",
  "repeats": 3,
  "args": ["--n-gpu-layers", "999", "--ctx-size", "4096"],
  "volumes": [
    { "name": "NVMe", "dir": "C:/bench" },
    { "name": "HDD", "dir": "E:/bench" }
  ],
  "models": [
    { "name": "Qwen3 8B Q4_K_M", "path": "C:/models/Qwen3-8B-Q4_K_M.gguf" },
    { "name": "Qwen3 8B Q4_K_M, direct I/O", "path": "C:/models/Qwen3-8B-Q4_K_M.gguf", "args": ["--load-mode", "dio"] }
  ]
}
```

```bash
target/release/nekko-bench switch switch.json --out results.json --markdown results.md
```

Each volume needs free space for one copy of the largest model. Close games and other GPU-heavy programs first: they hold VRAM and slow the requests.
