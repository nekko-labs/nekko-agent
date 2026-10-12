# Local inference benchmarks

How fast Nekko Agent's engine runs a model compared with Ollama and LM Studio, on the same machine and the same model file, measured the same way. vLLM is supported by the harness but not measured here (it has no native Windows build).

The numbers are from one machine. They are not a promise about yours; run the harness (below) to get your own.

## Results, 2026-09-30

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

### Reading the results honestly

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
