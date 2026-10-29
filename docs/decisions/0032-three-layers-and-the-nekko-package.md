---
status: accepted
date: 2026-10-28
---

# 0032. Three layers of customization, and one open `.nekko` package format

## Context

Philip asked (2026-10-28) for people to customize the UI however they want: every component movable, Simple and Expert as official layouts, custom layouts of their own, and a shareable, non-proprietary file format. He split it into three layers with different risk: customizations (safe, synced), mods (code, shareable through a marketplace with a warning and a Verified badge) and custom layouts (anything, local only, sharing undecided). Design: [2026-10-28-customizable-ui-design.md](../superpowers/specs/2026-10-28-customizable-ui-design.md).

## Options considered

1. **One mechanism for everything.** Every change is a package with code. Simple to describe, but a theme tweak would then carry the warnings of a mod, and nothing could sync safely.
2. **Three layers with one format.** Customizations are data. Mods and layouts are code in a sandbox. All three travel as the same zip with a JSON manifest whose `kind` says which it is.
3. **A separate format per layer.** Less in each manifest, but three parsers, three schemas and three import paths for one idea.

For storage of synced customizations: plain records on Nekko Cloud for every signed-in user, or the existing end-to-end encrypted sync, which is Pro and up.

## Decision

Option 2. The format is `.nekko`: an ordinary zip with `nekko.json` at the root, a published JSON Schema, and an optional `SIGNATURES` file (per-file SHA-256 plus signatures over the listing). Moving official components is a customization (`placements`), not a custom layout.

Customizations sync through the end-to-end encrypted sync as a `prefs` collection (Philip's choice), so they reach people with Pro and up once sync is switched on after the outside crypto review. This amends [0030](0030-simple-hides-developer-controls-per-device.md) (on PR #1312): Simple's choices stay on the device for anyone without sync, and follow the person when sync is on, with any field pinnable as "this device only".

## Consequences

- The manifest, signatures, layout and customization documents live in `packages/shared` so the desktop, the Local Web UI and Nekko Cloud read them the same way.
- Free users move customizations between machines by export and import only.
- Verified means the Nekko Labs key signed these exact bytes. The key is held offline, never in CI.
- If people mostly want to share whole layouts rather than mods, that is the sign the "layouts stay local" call needs revisiting first.
