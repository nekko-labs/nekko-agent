---
status: accepted
date: 2026-11-26
---

# 0121. Advertise one input shape for `edit_file`

## Context

The model-facing `edit_file` schema allowed a single pair of replacement fields and an `edits` array in the same call. The runtime correctly rejected that combination, but the prose warning did not prevent repeated invalid calls. See [#3521](https://github.com/nekko-labs/nekko-agent/issues/3521) and the [file-edit spec](../../spec/code/recoverable-file-edits.md).

## Options considered

1. Keep both formats in the model-facing schema and require exactly one with a JSON Schema union. This preserves both advertised forms but depends on providers supporting the union.
2. Advertise one object with a required `edits` array. A single edit is a batch of one. Keep accepting the legacy top-level pair at runtime for direct callers.

## Decision

Use one closed object schema for the tool, with `path` and an `edits` array of 1–100 closed replacement objects. This removes the ambiguity without splitting the tool or relying on union support. Runtime validation, approvals and filesystem boundaries do not change.

## Consequences

Models use the existing literal replacement and 8 MiB batch rules even for a single edit. Direct callers retain the legacy single-pair behavior. The daemon's loopback Codex Responses test catches catalog or serializer drift; it does not measure live model adherence.
