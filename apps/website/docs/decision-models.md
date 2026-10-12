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
- **Execution providers.** DirectML on Windows, CoreML on macOS, CUDA on Linux when built with `--features cuda` (that ONNX Runtime build is several hundred MB and needs the CUDA 13 runtime, so it is not the default), and CPU everywhere. Each accelerator gets a probe batch at load; one that cannot build or run the graph falls back to CPU at load time, and `decide:status` reports the provider actually in use and why any were skipped.
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

## Accuracy against the reference

`crates/nekko-decide/tests/golden/` holds 60 requests (86 questions: all three types, 1 to 30 options, states from empty to far past the 512-token window, JSON and conversation states, unicode, structured criteria, `option_order`) and what the official `laya` 0.3.22 package answered on CPU in fp32. The test runs when `LAYA_MODEL_DIR` points at a model directory and is skipped otherwise, so CI never downloads the model.

| | token sequences identical | same answer | max abs probability error | mean |
| --- | --- | --- | --- | --- |
| fp32, CPU and DirectML | 86/86 | 86/86 | 0.0001 | 0.00002 |
| fp16, DirectML | 86/86 | 86/86 | 0.018 | 0.001 |
| fp16, CPU | 86/86 | 86/86 | 0.014 | 0.0005 |
| int8, CPU | 86/86 | 86/86 | 0.048 | 0.004 |

The test fails fp32 over 1e-3, fp16 over 0.02 and int8 over 0.06, and fp32 or fp16 on any changed answer.

## The export

There is no usable hosted ONNX export of Laya today. `tozp/laya-onnx` was traced with TorchScript at opset 14 from a batch-1, 512-token dummy input: its decision head only runs at exactly 512 tokens, and at 512 its logits are off by up to 4 against the reference (36 of 86 golden answers match). Its fp16 file also fails to load on ONNX Runtime's CPU provider (a type error in a converter-inserted Cast, and an access violation with full optimizations). The runtime refuses exports below opset 17 with a message saying why, since that CPU failure would otherwise take the daemon down.

The files measured above were made from the official checkpoint (`convaiinnovations/laya`, root) with offline Python tooling that is not part of the app:

1. fp32: laya's own `scripts/export_onnx.py` (dynamo exporter, opset 18, dynamic batch, sequence and option counts).
2. Clear `allowzero` on every `Reshape` (DirectML refuses `allowzero=1`; no shape tensor in this graph holds a literal 0, so the result is identical).
3. fp16: `onnxruntime.transformers.float16.convert_float_to_float16(model, keep_io_types=True)` after deleting the graph's `value_info` (stale intermediate types are what broke the tozp file).
4. int8: weight-only, `MatMulNBitsQuantizer` with 8 bits, block size 128, symmetric, `accuracy_level=4`. Laya's own recipe (`quantize_dynamic`, per-channel) quantizes activations per tensor and moves logits by up to 3.7 on this checkpoint, flipping 20 of 86 answers.

## Limitations and open items

- **Only the English checkpoint.** `laya-multilingual` (mmBERT-base, 1,024 tokens) and `laya-typed-decisions` need exports of their own that someone hosts; the runtime reads their `rl_agent_config.json` budgets, but neither has been exported or measured. Hosting a correct English export (the recipe above) is open too.
- **The model's own limits.** The English checkpoint is near chance on the typed-decisions benchmark zero-shot, ships over-confident (the `choice:11+` temperature is clamped from 0.10 to 0.5, as laya does, and those confidences are uncalibrated), and many options share a 192-token head budget, so questions with dozens of options lose accuracy. See Laya's README, "Honest Limits".
- **Not verified here:** CoreML on a Mac and CUDA on Linux (both fall back to CPU if they fail), and a DirectML machine older than this one.
- **Windows runtime libraries.** ONNX Runtime is statically linked, so the release `nekkod` is about 30 MB, and on Windows it now imports the Visual C++ runtime's `MSVCP140.dll` (Rust already needed `VCRUNTIME140.dll` from the same package) and `DirectML.dll`, which is staged next to `nekkod`.
