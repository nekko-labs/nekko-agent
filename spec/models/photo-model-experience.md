---
title: Simple photo model setup and photo variations
area: models
---

# Simple photo model setup and photo variations

Tracking: [#2170](https://github.com/nekko-labs/nekko-agent/issues/2170).

## Intent

A person should choose one photo model, understand its download and readiness, and create a picture without learning the difference between diffusion weights, text encoders, a decoder and an executable runtime. Existing-photo work must be described according to the model's real capability, not as a generic promise to edit anything precisely.

## Backend layer — implemented, unverified

- The existing image companion preview/download APIs also accept a real catalog repository with a known companion set, so supporting files can be queued before model weights finish. An unknown repository/set returns unavailable. Catalog-only previews never scan a host working directory or invent a local model path.
- A photo turn optionally carries one `sourceImage`: an inline PNG/JPEG data URL with valid base64 and a matching raster signature, bounded at 10 MiB decoded / 14 million encoded characters. Paths, HTTP URLs, other MIME types, malformed and oversized inputs are rejected before saving a turn or loading the runtime.
- The original is retained on the user message, not in image settings. It is forwarded as the pinned stable-diffusion.cpp API's native `init_image`, with `strength` in [0,1] (default 0.65). A new text-only turn does not reuse an old source. Results record change strength and that they started from a photo, without duplicating the source.
- Existing text-only payloads remain unchanged. User prompts may not embed native `sd_cpp_extra_args` control blocks.
- The contract implements image-to-image reimagining, not masks, instruction editing, precise retouching, identity preservation, or multi-reference composition. Actual model support/quality must be checked before release.

## Planned UI layer

Models gets a Photo models section independent of chat-model onboarding, with one package setup action, total missing download size, a small checklist, progress/errors, retry and optional technical details. FLUX.2 klein 4B Q4_K_M is a compact starting option, not a hardware-fit claim. Downloaded image models remain selectable. Creation controls lead with model/shape; Steps/CFG/Seed move under Advanced. A local source-photo chooser and explicit Reimagine wording explain limitations and preserve the original. Custom companion paths and memory controls remain available.

## Privacy and compatibility

Inference stays on the Nekko computer. Setup uses the existing Hugging Face and runtime GitHub download paths; no image/prompt is added to those requests. No new cloud model service, silent download, host path/URL resolution, sandbox bypass, Relay access expansion or native-phone permission is added. Existing session persistence/incognito rules still apply. A download size is disk acquisition, not peak RAM/VRAM or performance assurance. Full native-phone photo parity is separate from this shared-renderer change and remains unverified.

## Acceptance and release blockers

1. Package plans work before and after weights arrive; unknown/missing catalogs fail closed and no relative filesystem probes occur.
2. One approved UI action queues all missing parts, reuses existing files and reports partial failure honestly. Ready requires weights, supporting files and runtime.
3. Photo input validation and transcript/source retention have Rust tests; text-only golden payloads remain stable.
4. Focused component tests, shared/desktop typechecks and production app build pass.
5. Matching actual Electron before/after captures are inspected at desktop, unfolded/tablet and folded/narrow widths; new surfaces are marked as having no before state. Full Models/ChatPane integration is exercised.
6. A clean setup and real text-to-image plus source-photo variation run succeed on the pinned runtime; output quality and source preservation are reviewed.

Current blockers: Rust toolchain unavailable to this sandbox; Rust tests/formatting and daemon compilation not run. Image inspection tools failed (browser screenshot timeout, native capture UnknownVizError); saved screenshots alone are not visual verification. No live weights were downloaded or generation performed. Keep draft until these requirements are met.

## Sources

- [Pinned runtime API](https://github.com/leejet/stable-diffusion.cpp/blob/master-1030-0a06712/examples/server/api.md)
- [Starter model](https://huggingface.co/unsloth/FLUX.2-klein-4B-GGUF)
- Existing `crates/nekko-engine/src/acquire.rs` companion sets and `crates/nekkod/src/downloads.rs` queue.
