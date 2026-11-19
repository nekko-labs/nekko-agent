---
title: "Markdown width control in FilePane"
area: code
---

# Markdown width control in FilePane

## User intent

Markdown files open by default in a narrow reading column (`max-w-3xl`, 48 rem), which wastes horizontal space for tables and wide code blocks. Users want a wider column without permanently leaving reading mode.

## What was built (shipped 2026-11-19, #3046)

A compact **Narrow / Wide / Full** segmented toggle (`SlideToggle`) appears in the FilePane toolbar whenever a Markdown file is in preview mode. The selection is persisted in `localStorage` under `nekko.md.width` and defaults to **Wide**.

| Option | CSS constraint | Tailwind class |
| --- | --- | --- |
| Narrow | 48 rem (original default) | `max-w-3xl` |
| Wide | 64 rem (new default) | `max-w-5xl` |
| Full | no max-width | `w-full` |

The toggle is hidden in Source mode and for non-Markdown files. All surfaces that use `FilePane` (the main command wall, the Library/Artifacts view, and the Design canvas fallback) inherit the preference automatically.

## Acceptance criteria

- [x] New Markdown files open at Wide by default
- [x] Existing users who stored `nekko.md.width=narrow` get Narrow (no regression)
- [x] The toggle is only visible when a `.md` or `.markdown` file is in Preview mode
- [x] Switching width is instant with the SlideToggle slide animation
- [x] Preference persists across app restarts via `localStorage`
- [x] Tables and code blocks do not overflow their container at any width (they receive `overflow-x: auto` from the Markdown stylesheet)
- [x] Design-system compliant: `SlideToggle` uses existing CSS, no hex values, no Tailwind palette colours

## Implementation notes

- Key file: `apps/desktop/src/renderer/components/FilePane.tsx`
- Storage key: `nekko.md.width` (string enum `'narrow' | 'wide' | 'full'`)
- Toggle component: `components/library/SlideToggle.tsx`
- The `readMdWidthPref()` helper mirrors the existing `readAutoSavePref()` pattern
