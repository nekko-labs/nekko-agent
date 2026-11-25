---
title: "Orchestrate built-in model playbooks"
area: chat
---

# Orchestrate built-in model playbooks (#3175)

Nekko adds one short, role-specific instruction to the existing Orchestrate coordinator or worker system prompt. The six reusable playbooks emphasize grounding, code boundaries and regression checks, visual evidence, narrow triage, acceptance review, or distinguishing claims from tool results. These are editorial defaults based on shipped catalog entries, model labels and their intended uses; they are **not benchmarked prompts**, claims about model behavior, or evidence that a model has a particular capability. For example, the visual playbook only asks for visual evidence when an image is available.

## Coverage matrix

| Nekko chat adapter or preset | Curated exact coverage | Unlisted variants / source |
| --- | --- | --- |
| Local Model Server (`llamacpp`) | All 13 chat-capable IDs in the bundled recommendation feed, including canonical managed GGUF download IDs for each listed quantization | Recognizable filenames or tags are family hints. Live feed additions, MLX imports, renamed files, extra folders and unknown quants are not exact rows. Source: [`model-feed.json`](../../crates/nekko-machine/src/model-feed.json), engine [`acquire.rs`](../../crates/nekko-engine/src/acquire.rs) and [`library.rs`](../../crates/nekko-engine/src/library.rs). |
| Anthropic API | All 10 fallback rows (e.g. `claude-haiku-4-5-20251001`) | Live Messages catalog; unlisted Claude versions are family matches. |
| Amazon Bedrock | All 10 fallback rows, including the `anthropic.` prefix (e.g. `anthropic.claude-opus-4-7`) | Recognized regional/profile variants are family matches, never exact via prefix stripping. |
| Google Cloud Vertex AI | All 9 fallback rows, including `claude-haiku-4-5@20251001` | Unlisted Claude versions are family matches; no unlisted deployment is assumed to be a Claude model. |
| Microsoft Foundry | All 8 fallback rows, including `claude-haiku-4-5` | Claude-shaped deployment names can be family hints; opaque deployment names are neutral. The four Messages lists come from [`anthropic.rs`](../../crates/nekko-agent/src/providers/anthropic.rs). |
| OpenAI API | 11 reviewed IDs across GPT, o-series and Codex, e.g. `gpt-5`, `gpt-4.1`, `o3`, `gpt-5.3-codex` | Live `/models`; numbered GPT and selected o-series shapes are family hints. Sources: catalog fixtures and the [pricing snapshot](../../packages/shared/src/model-pricing-snapshot.ts). |
| ChatGPT subscription | `gpt-6.1-sol`, `gpt-6-sol`, `gpt-6-astra`, `gpt-6-luna` | The [subscription adapter](../../crates/nekko-agent/src/providers/chatgpt.rs) discovers the account's available models; these four are examples from its code and [fixtures](../../crates/nekko-agent/tests/golden/models.json), not a bundled picker list. GPT/o-series/Codex variants are family hints. |
| OpenRouter | 16 reviewed publisher-qualified IDs across Claude, OpenAI, Gemini, Gemma, Qwen, DeepSeek, Llama and Devstral | The live catalog isn't the pricing snapshot. Recognized publisher + family pairs may infer a playbook; e.g. a `:free` variant is never made exact by stripping the suffix. |
| Google Gemini preset (`openai-compat`) | `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-3.1-pro-preview`, on the HTTPS `generativelanguage.googleapis.com` host only | Live discovery; numbered Gemini versions and `models/` aliases are family hints. The [setup presets](../../apps/desktop/src/renderer/components/providers/providerPresets.ts) ship endpoints, not model lists. |
| Ollama (`ollama`) | `llama3:8b`, `qwen3:8b`, two literal tag examples from the adapter's catalog fixtures | Live `/api/tags`. Other tags can match recognized local families. |
| Ollama Cloud preset (`openai-compat`) | None; no fixed tag list | Local-family tag matching via the compatibility adapter; never inherits an exact Ollama route match. |
| LM Studio (`lmstudio`), vLLM (`vllm`) | None; the server defines the IDs | Live discovery; recognizable local model IDs in repository or GGUF names may infer a playbook. Arbitrary aliases are neutral. |
| Generic OpenAI-compatible (`openai-compat`) | None; the server defines the IDs | Known local families, common bare hosted families, and recognized publisher-qualified IDs can infer guidance. A compatible endpoint borrowing a vendor's name does not establish provenance. |
| Claude Code / Claude Agent (`claude-code`) | Excluded | The external CLI harness owns its prompt. This does not exclude Nekko's own ChatGPT subscription HTTP adapter. |

The full literal ID lists live with the [selector](../../crates/nekkod/src/orchestrate_state/playbook.rs). The three embedding-only entries and image-generation recommendations are not part of the chat catalog coverage.

## Selection and boundaries

- **Exact user overlay wins.** A nonblank `promptProfiles.modelInstructions[providerId::modelId]` for the admitted route stays in its existing system-prompt location once and suppresses the built-in line. An overlay for another provider, a related ID, or a blank value does not suppress it. The base Orchestrate role and existing permission instructions stay in place.
- **Curated exact ID** is a literal, case-sensitive match in the adapter's table (or a managed path built from the bundled artifact list). It describes the match, not the deployed weights or the model's availability. **Inferred family** is a case-insensitive, shape-based match, not proof of equivalence to a curated model. Case changes, vendor prefixes, quant suffixes and date/tag differences are not silently normalized into exact matches. **Neutral fallback** uses only the available inputs and tools without assuming their capabilities.
- The selector examines at most 256 bytes of model ID and adds one bounded line (at most 180 bytes in the current library). It does not prompt from live catalog text, make network requests, create new prompt settings, change model or tool selection, or add anything to saved history. Existing tier/route guidance stays independent. Provider IDs, endpoints and model ID strings are not copied into the built-in sentence.
- Only admitted Orchestrate coordinator and worker turns receive the new line. Existing exclusions for ordinary, Solo, sandbox, offline, incognito, privacy-shielded and otherwise ineligible turns still apply. Ordinary prompt profiles, context preview, and external CLI prompts do not use the library.

## Verification

The catalog tests enumerate the shipped Claude Messages lists and exercise the engine download ID shape for every bundled chat quant. Selector tests cover reviewed hosted and local IDs, aliases, unknown future models, lookalike endpoints, non-chat name markers and the render bound. Daemon loopback request tests check the coordinator/worker text, exact override precedence, route isolation, and omissions on restricted turns. These checks verify selection and composition, not live provider behavior or prompt effectiveness.

Verified on macOS arm64 with `cargo test --locked -p nekkod --bin nekkod --test daemon orchestrate`: 11 unit tests and 3 daemon request tests passed. Catalog assertions cover 37 Claude fallback rows and 24 managed GGUF quantizations across the 13 chat-capable feed models. The serialized requests distinguish `gpt-5.3-codex` on the OpenAI adapter (curated) from the same ID on a generic compatible endpoint (inferred), exercise a neutral future alias and an exact user override, and confirm a spawned worker gets its own curated code guidance. These use local scripted responses, not live inference. The prompt profile, context, delegation guard, `nekko-turn`, and `nekko-context` regression checks also passed (86 tests).
