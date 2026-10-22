# Decision models

A decision model answers typed questions about a piece of text with calibrated probabilities, in one forward pass, without generating any text. Nekko Agent runs one natively in its engine daemon: **Laya**, an open-weight model from Convai Innovations (Apache 2.0).

## What Laya and Jev are

TypeSafe Jev is a closed, hosted "System One" decision API: you send a `state` (text or JSON) and named questions, and get back typed answers. [Laya](https://huggingface.co/convaiinnovations/laya) is an open-weight model trained for the same job, and its own server (`laya-serve`) speaks Jev's request and response shape. Nekko Agent speaks it too, so a Jev client works against the local engine by changing its base URL.

Three question types:

| type | `criteria` | answer |
| --- | --- | --- |
| `choice` | an object of label -> description, or a list of labels | `{ "type": "choice", "choice": "billing", "confidence": 0.86, "probabilities": { "billing": 0.97, ... } }` |
| `score` | the ordered list of levels, index 0 first | `{ "type": "score", "score": 1.44, "confidence": 0.14, "legend": { "0": "not urgent", ... }, "probabilities": { "0": 0.12, ... } }` |
| `noul` | optional `{ "true": ..., "false": ... }` descriptions | `{ "type": "noul", "noul": 0.82 }` (the probability it is true) |

Every answer also carries Laya's two extras, `answer_confidence` (the top probability, which is what the temperatures are fitted on) and `action.act_probability` (the act/escalate head, which Laya's own README says carries no usable signal yet). The response has `model`, `answers`, `usage` (`input_tokens`, `output_tokens: 0`, and how much of the state was cut to fit), and `latency_ms`.

## The local runtime

`crates/nekko-decide`, inside `nekkod`. No Python at run time: the checkpoint is an ONNX export run by ONNX Runtime (the `ort` crate with prebuilt binaries), and the tokenizer is the checkpoint's `tokenizer.json` (the `tokenizers` crate).

- **Same input as the reference, token for token.** Prompt construction, option markers, the 48-token per-option cap and the head budget, state truncation (from the back for a conversation list, so the newest turn survives), the Python `json.dumps` rendering of JSON states and structured criteria, and temperature clamping all follow the `laya` package (0.3.22). The golden test checks every question's token sequence against the package's own.
- **One call, all questions.** A bad question becomes that question's `error` entry; the others are still answered. Request caps are `laya-serve`'s: 64 questions, 50,000 state characters, 100 options per choice, 32 score levels, 512 options in all.
- **Execution providers.** DirectML on Windows, CoreML on macOS, CUDA on Linux only in a build made with `--features cuda` against a CUDA build of ONNX Runtime (not the release builds; see "CUDA on Linux" below), and CPU everywhere. Each accelerator gets a probe batch at load; one that cannot build or run the graph falls back to CPU at load time, and `decide:status` reports the provider actually in use and why any were skipped.
- **Fixed shapes on DirectML and CoreML.** DirectML only runs fast on a shape it compiled when the session was created: a dynamic session answered its first-seen shape in 15 ms and every other shape in about 85 ms. Accelerated sessions therefore pin one row of `max_len` tokens and 128 option slots, and run a call's questions one after another. CPU and CUDA batch every question of a call in one run.
- **Surfaces.** Daemon channels `decide:load` (`[dir, precision?]` or `[{ dir, precision?, ep?, name? }]`), `decide:unload`, `decide:status` and `decide:run` (`[{ model?, state, questions }]`); on the engine's OpenAI-compatible port, `POST /v1/decisions` (Jev's path) and `POST /v1/systemone` (`laya-serve`'s), behind the same API key and CORS as every other route, answering 409 when no decision model is loaded.
- **Model directory.** `model_fp16.onnx` (default), `model.onnx` (fp32, may have a `.data` file beside it) or `model_int8.onnx`, plus `tokenizer.json` (at the root or under `tokenizer/`) and `rl_agent_config.json`.

## Measured

RTX 5090, Ryzen 9 9950X3D, Windows 11, release build, the English checkpoint, the README's support-ticket email as the state (`cargo run --release -p nekko-decide --example latency -- <dir> <ep> <precision>`). p50 of 100 (DirectML) or 10 (CPU) calls after warm-up:

| | 1 question | 10 questions | load |
| --- | --- | --- | --- |
| DirectML, fp16 | **8.6 ms** | 81 ms | 1.5-2.7 s |
| DirectML, fp32 | 15 ms | 154 ms | 2.5 s |
| DirectML, fp16, dynamic shapes (not used) | 86 ms | 102 ms | |
| CPU, fp32 | 94 ms | 733 ms | 3.7 s |
| CPU, fp16 | 106 ms | 707 ms | 2.5 s |
| CPU, int8 | 68 ms | 731 ms | 1.0 s |

Laya's README reports 39.5 ms and 158.6 ms on a T4 with torch. Batching ten questions into one DirectML run would be faster than ten runs of one, but only with a second fixed-shape session, which doubles GPU memory; not done.

The same machine and model files, measured again on 2026-10-17 for every checkpoint (p50 of 100 calls; CUDA in Docker under WSL2 on the same GPU, `scripts/decision-models/cuda-golden.sh`; Linux CPU in the same container):

| | laya-en, 1 / 10 questions | laya-multilingual | laya-typed-decisions | load (laya-en) |
| --- | --- | --- | --- | --- |
| DirectML, fp16 (Windows) | 8.4 / 86 ms | 10.6 / 106 ms | 17.4 / 175 ms | 1.4 s |
| DirectML, fp32 (Windows) | 15.6 / 155 ms | | | 1.9 s |
| CUDA, fp16 (Linux) | 10.5 / 13.3 ms | 8.0 / 9.1 ms | 10.9 / 13.2 ms | 5.3 s |
| CUDA, fp32 (Linux) | 10.3 / 20.6 ms | 8.0 / 11.6 ms | 10.3 / 20.6 ms | 10.6 s |
| CPU, fp32 (Windows) | 90 / 787 ms | | | 1.7 s |
| CPU, fp32 (Linux, what Linux release builds run) | 71 / 560 ms | | | 10 s |

CUDA batches a call's questions into one run, so ten questions cost little more than one; DirectML runs them one after another on its fixed shape. The typed-decisions model is slower on DirectML than the English one with the same architecture because its 1,024-token budget is the fixed shape every question is padded to.

### CUDA on Linux (PF33)

`--features cuda` makes `ort` download pyke's ONNX Runtime 1.28 build with CUDA 13. **That build does not run on an RTX 50-series (Blackwell, sm_120) GPU**: its CUDA kernels are compiled for sm_75, sm_80 and sm_90 only and carry no PTX, so every session fails its probe ("CUDA failure 209: no kernel image is available for execution on the device") and the runtime falls back to the CPU, correctly but silently fast-less. Microsoft's own 1.28.3 build (`onnxruntime-linux-x64-gpu_cuda13`, sm_75 to sm_120 plus sm_120 PTX) works when linked dynamically (`ORT_LIB_LOCATION=<its lib> ORT_PREFER_DYNAMIC_LINK=1`); mixing its provider library with pyke's static core does not ("ComputeAsync is not implemented"). With it, all three checkpoints pass the golden test on CUDA (fp32 max error 0.0001, fp16 0.017 / 0.020 / 0.006, every answer the same). ONNX Runtime's CUDA provider runs fp32 MatMuls in TF32 by default, which moved fp32 probabilities by up to 0.004; the runtime now turns TF32 off.

**Decision: Linux release builds do not ship CUDA.** What shipping it would take: Microsoft's `libonnxruntime.so` (27 MB) and CUDA provider (267 MB) beside `nekkod`, 295 MB on top of a 203 MB AppImage and 157 MB .deb, plus a CUDA 13 runtime and cuDNN 9 that are not on most Linux machines and are over 1 GB to bundle. What it buys: about 60 ms per question (71 to 10 ms) and 0.5 s per ten-question call. Decision calls are agent tool calls next to chat-model turns that take seconds, so the CPU is fast enough, and Windows (DirectML) and Macs (CoreML) already get the GPU without any of this. Revisit if Linux users ask for it; the way to do it would be a separately downloaded runtime (as DirectML.dll is fetched on demand) rather than a bigger package. Self-builders can use the commands in `scripts/decision-models/cuda-golden.sh`.

### CoreML on macOS

`.github/workflows/decision-models.yml` (run by hand, and on changes to `crates/nekko-decide`) downloads the exports, checks their SHA-256 sums, and runs the golden test with CoreML requested on a `macos-14` (Apple silicon) runner, writing which provider actually ran each checkpoint to the job summary. GitHub's macOS runners are virtual machines without the Neural Engine, and Apple's paravirtualized GPU may or may not take the model, so a CPU fallback there does not prove one on a real Mac, while a CoreML pass proves the graph compiles and answers correctly under CoreML. The first run (2026-10-17) did not get that far: the golden set under CoreML on the VM was still running when the job hit its 60-minute limit, so it showed neither a CoreML run nor a fallback. The workflow now asks the latency example first, which reports the provider in use and any fallback reason within minutes. Its second run (2026-10-17, laya-en fp16 on `macos-14`) answered: **CoreML took the model, with no fallback**, but it is unusably slow in the VM: load 127 s, one question 32.8 s p50 (39.7 s p95, 5 runs), against about 0.07 s on a CPU, and the ten-question call did not finish inside the step's 30 minutes. The runner's GPU is paravirtualized and it has no Neural Engine, so this says nothing yet about a real Mac, but if a real Mac is anywhere near this slow, CoreML must not be the default there (`Ep::accelerators()` would need to prefer the CPU on macOS). That is what the Mac check below decides.

**Checking CoreML on a Mac** (Apple silicon, about 3 GB of disk and 10 minutes): with Rust and the GitHub CLI installed, from a checkout of this repository run

```sh
bash scripts/decision-models/mac-check.sh            # laya-en
bash scripts/decision-models/mac-check.sh laya-en laya-multilingual laya-typed-decisions
rm -rf ~/nekko-decision-check                       # afterwards
```

It downloads the exports (checked against `SHA256SUMS`), runs the golden test with CoreML requested and on the CPU in fp16 and fp32, and the latency example, then prints a summary. What to look for: each line says `on coreml` (CoreML ran it) or `on cpu` (it fell back; the latency run above prints the reason), the token check says 86, the answers say 86/86, and the max error stays under 0.02 for fp16 and 0.001 for fp32. Paste the summary and the latency lines into the PR or TASKS.md (PF33).

## Accuracy against the reference

`crates/nekko-decide/tests/golden/` holds 60 requests (86 questions: all three types, 1 to 30 options, states from empty to far past the 512-token window, JSON and conversation states, unicode, structured criteria, `option_order`) and what the official `laya` 0.3.22 package answered on CPU in fp32, once per checkpoint (`golden.json` for English, `golden-multilingual.json`, `golden-typed-decisions.json`; `LAYA_GOLDEN` picks one). The test runs when `LAYA_MODEL_DIR` points at a model directory and is skipped otherwise, so CI never downloads the model. Every row below has every token sequence identical to the reference's (86/86).

Measured on the hosted files (`decision-models-v1`), RTX 5090, Windows (DirectML, CPU) and Linux in Docker (CUDA). Max and mean absolute probability error; answers the same as the reference's:

| | laya-en | laya-multilingual | laya-typed-decisions |
| --- | --- | --- | --- |
| fp32, CPU | 0.0001 / 0.00002, 86/86 | 0.0000 / 0.00002, 86/86 | 0.0000 / 0.00003, 86/86 |
| fp32, DirectML | 0.0001 / 0.00002, 86/86 | 0.0001 / 0.00002, 86/86 | 0.0000 / 0.00003, 86/86 |
| fp16, DirectML | 0.0186 / 0.00097, 86/86 | 0.0157 / 0.00080, 86/86 | 0.0057 / 0.00057, 86/86 |
| fp16, CPU | 0.0173 / 0.00049, 86/86 | 0.0029 / 0.00016, 86/86 | 0.0053 / 0.00036, 86/86 |
| int8, CPU | 0.048 / 0.0037, 86/86 | 0.125 / 0.0068, 85/86 | 0.025 / 0.0023, 85/86 |
| fp32, CUDA (Linux) | 0.0000 / 0.00002, 86/86 | 0.0001 / 0.00002, 86/86 | 0.0000 / 0.00003, 86/86 |
| fp16, CUDA (Linux) | 0.0167 / 0.00058, 86/86 | 0.0196 / 0.00076, 86/86 | 0.0060 / 0.00039, 86/86 |

The test fails fp32 over 1e-3, fp16 over 0.02 and int8 over 0.06, and fp32 or fp16 on any changed answer. That means the multilingual int8 file fails it (one answer flips, a 0.125 move on a 15-option near-tie): its 256k-token embedding table is a Gather, which the weight-only quantizer leaves in fp32, so the file is larger than fp16 (929 MB against 646 MB) and less accurate. It is on the release for completeness but not in the app's catalog. The typed-decisions int8 flip is a near-tie on a 14-option question and inside int8's bound.

## The hosted export

The app downloads the exports from a release of this repository, [`decision-models-v1`](https://github.com/nekko-labs/nekko-agent/releases/tag/decision-models-v1). It is never marked the latest release, because the app's updater (`crates/nekkod/src/native.rs`) and the website read `releases/latest`. Assets are named `<checkpoint>.<file>`; `SHA256SUMS` lists all of them, `LICENSE` is upstream's Apache-2.0 license and `NOTICE` says what was changed. The catalog (`crates/nekkod/src/decision-catalog.json`) pins every file's size and SHA-256.

| checkpoint | upstream (pinned) | fp16 | fp32 | int8 | tokenizer |
| --- | --- | --- | --- | --- | --- |
| `laya-en` | `convaiinnovations/laya@55cf4c4` | 846 MB | 1,689 MB | 612 MB | 3.6 MB |
| `laya-multilingual` | `convaiinnovations/laya-multilingual@e4e9ddf` | 646 MB | 1,290 MB | 929 MB (not offered) | 34 MB |
| `laya-typed-decisions` | `convaiinnovations/laya-typed-decisions@1a793eb` | 846 MB | 1,689 MB | 612 MB | 3.6 MB |

The revisions are the ones laya 0.3.22 itself pins as reviewed (`laya.revisions.PINNED_REVISIONS`); their weights are byte-identical to `main` today. Upstream's license is Apache-2.0 (the GitHub repository's `LICENSE`, and every checkpoint's model card), which allows redistributing the weights and derivative works with the license and a notice of changes; upstream ships no NOTICE file of its own.

**Download in the app.** Model Server's Decisions tab lists all three. Downloading one precision queues its four small files and the model file as one group in the engine daemon's download queue (`decisions:download`, `crates/nekkod/src/decisions.rs`, the same queue as chat models: resumable, cancellable, shown in Downloads). Each file is checked against its published size and SHA-256 before it is renamed into place, so a file that is not the published one is refused and deleted, never loaded; a file already on disk at its published size is kept. Measured: laya-en fp16 (0.85 GB) from the real release into an empty data directory in 62 s, loaded on DirectML fp16 in 2.2 s, and the README's support email answered `billing` (0.988) in 19 ms (`scripts/itest-decision-download.mjs`).

## The export recipe

`scripts/decision-models/` rebuilds every hosted file from the pinned checkpoints (README there). Python is used at build time only, in a throwaway virtual environment.

1. fp32: laya's own `scripts/export_onnx.py` recipe (torch dynamo exporter, opset 18, dynamic batch, sequence and option counts, traced from batch-2 dummies).
2. Clear `allowzero` on every `Reshape` (DirectML refuses `allowzero=1`; no shape tensor in this graph holds a literal 0, so the result is identical).
3. fp16: `onnxruntime.transformers.float16.convert_float_to_float16(model, keep_io_types=True)` after deleting the graph's `value_info` (stale intermediate types are what broke the tozp file). For laya-en and laya-typed-decisions the rotary-embedding angle nodes (`Cos`/`Sin` and what feeds them, 14 small nodes) stay in fp32: the angles reach ~500 rad at 512 tokens, where fp16 resolves only 0.25 rad, and plain fp16 put laya-en at 0.0213 on DirectML, just over the test's 0.02. The multilingual model measured better plain (0.0157 against 0.0343), so it is converted plain. Keeping nodes in fp32 makes the converter insert duplicate Casts out of order; the script drops the duplicates and sorts the graph.
4. int8: weight-only, `MatMulNBitsQuantizer` with 8 bits, block size 128, symmetric, `accuracy_level=4`. Laya's own recipe (`quantize_dynamic`) quantizes activations per tensor and moves logits by up to 3.7 on the English checkpoint, flipping 20 of 86 answers.
5. The tokenizer and config files are upstream's own bytes, fetched fresh (loading laya rewrites the cached `tokenizer_config.json` of the multilingual checkpoint in place).

`reference.py` regenerates the golden files; rerun on the English checkpoint it reproduces the committed `golden.json` (identical tokens, probabilities within 4e-6, from torch 2.14.0 to 2.14.1).

The only other public export, `tozp/laya-onnx`, was traced with TorchScript at opset 14 from a batch-1, 512-token dummy input: its decision head only runs at exactly 512 tokens, and at 512 its logits are off by up to 4 against the reference (36 of 86 golden answers match). Its fp16 file also fails to load on ONNX Runtime's CPU provider (a type error in a converter-inserted Cast, and an access violation with full optimizations). The runtime refuses exports below opset 17 with a message saying why, since that CPU failure would otherwise take the daemon down.

## Limitations and open items

- **No automatic routing between checkpoints.** laya's `Router` picks the multilingual checkpoint for non-Latin scripts; here the user picks the model they load, and one is loaded at a time. `laya-multilingual` runs at its shipped 1,024-token budget (the 8,192-token mode is not offered).
- **The model's own limits.** The English checkpoint is near chance on the typed-decisions benchmark zero-shot, ships over-confident (the `choice:11+` temperature is clamped from 0.10 to 0.5, as laya does, and those confidences are uncalibrated), and many options share a 192-token head budget, so questions with dozens of options lose accuracy. See Laya's README, "Honest Limits".
- **Not verified here:** CoreML on a real Mac (the checklist above is for that; it falls back to the CPU if it fails), and a DirectML machine older than this one. CUDA is verified on Linux in Docker on an RTX 5090, with Microsoft's ONNX Runtime build.
- **Windows runtime libraries.** ONNX Runtime is statically linked, and on Windows it makes `nekkod` import the Visual C++ runtime's `MSVCP140.dll` (Rust already needed `VCRUNTIME140.dll` from the same package). pyke's prebuilt ONNX Runtime is compiled against the DLL runtime (`/MD`), so `nekkod` cannot link the runtime statically; instead the installer and the npm package ship the runtime DLLs app-local beside `nekkod` (`scripts/vc-runtime.mjs`), and a PC without the Visual C++ Redistributable still starts it.
- **DirectML is not shipped.** `nekkod` delay-loads `DirectML.dll` (`crates/nekkod/build.rs`), and before the DirectML provider starts `crates/nekko-decide/src/directml.rs` loads a copy at least 1.15: Windows' own `System32\DirectML.dll` (Windows 11 has carried one since 2024), or one the host fetched. On a Windows whose copy is older (Windows 10), loading a model fetches Microsoft's `DirectML.dll` 1.15.4 once, reading only that entry out of the `Microsoft.AI.DirectML` NuGet package with HTTP range requests (about 9 MB of a 200 MB package) and checking it against a pinned SHA-256 (`packages/host/src/engine/directml.ts`). If that fails the model loads on the CPU and the load message says why. This took 18 MB off every install.
