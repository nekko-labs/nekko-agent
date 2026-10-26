---
status: accepted
date: 2026-10-25
---

# 0026. Keep thinking on, with local Expert overrides

## Options considered

1. Keep per-chat switches: preserves fine-grained choice but allows stale off flags
   to follow a chat across cloud model changes.
2. Keep thinking on, with local Expert overrides: removes accidental cloud
   suppression while preserving deliberate per-model tuning.

## Decision

Cloud chat turns always enable thinking, ignoring legacy per-chat off preferences.
Remove the composer switch and keep a default-on, per-model Thinking preference
only in the built-in local model's Expert settings. MLX has no supported override.

## Context

A stale chat flag must not silently suppress reasoning or its progress when a
person changes cloud models. Local-model tuning belongs beside the model's other
expert settings, rather than among everyday message controls. Keep saved chat
fields readable without making them effective; no transcript migration is needed.

## Consequences

Resolve the local override in engine admission for the actual chosen model,
including Auto routing. Send only the provider's native supported knob. Cloud
providers do not receive llama.cpp template fields. Reasoning output and the
passive progress indicator stay available.

See [Models & providers](../../spec/models/models-providers.md).
