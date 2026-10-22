---
title: "Anthropic image-dimension rejection prevention and continuation"
area: models
split-from: SPEC.md (2026-10-22)
---

# Anthropic image-dimension rejection prevention and continuation

Implemented with focused request-payload and recovery tests: both the Rust daemon and TypeScript fallback bound decodable outgoing image copies to 1568 pixels per side, preserving aspect ratio. This applies to historical user attachments and tool screenshot evidence on every request, including Retry and new text messages, preventing the stricter 2000-pixel-per-side limit on requests containing more than 20 images from repeatedly rejecting saved oversized screenshots. Stored originals and completed tool steps remain unchanged; no extra provider call or automatic tool rerun is introduced. Normalization stays local, deduplicates within each request, and adds no network disclosure or permissions. Small images retain their encoding; oversized animated inputs may become static PNGs. Rust supports PNG/JPEG/GIF/WebP; the TypeScript decoder supports its Jimp formats, with unsupported/corrupt images retained for provider validation. Image-count, byte-size and context limits remain separate constraints, not guarantees of recovery. Regression tests verify 21-image old histories, repeated requests, a subsequent text turn, original preservation, and failed-turn busy-gate cleanup followed by Retry or a new message. No visual change. Live Anthropic, packaged desktop and cross-platform verification remain untested.
