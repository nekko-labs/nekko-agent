# Scheduled Tasks overview: implementation and post-setup audit

## Scope and sources

One 42-second Remotion overview replaces **See what you can automate** in
`FirstWorkflowWizard.tsx`. Tracking: #2301; broader category/example production
remains under #1171. Source of truth: the wizard's manual-only seeds, existing
`WorkflowEditor`, `docs/automations.md`, `docs/workflows.md`, and the existing
`FirstPromptIntro`/`VoiceIntro` Remotion conventions. No real data is shown.

## Design

Six scenes: choose a page-update idea, provide its target and instructions,
review model/tools/access, save and run manually, inspect the report, then
explicitly add a schedule. Existing `PeekNekkoArt` stays present; its eyes and
subtle vertical movement are frame-driven and it smiles at completed work.
Colors and font inherit app tokens; exported light/dark MP4s mirror default
palettes. The composition is silent, with visible captions and a full readable
transcript. It is labeled illustrative, synthetic output is labeled, accelerated
run progress is labeled, and watching never calls host APIs.

## Checks actually run

- Seven Vitest tests: wizard safety/seeds, timeline continuity, reading time,
  all scene boundaries and held frames, mascot presence, player opt-in behavior
  and transcript parity.
- Desktop TypeScript check; spec-index check; `git diff --check`.
- Three existing sandbox syntax regression tests.
- Isolated hidden Electron fixture at 1100×1000 and 390×1000, light and dark.
  Four before/after overview pairs and six held video scenes per size/theme.
  Text boxes fit; no horizontal page overflow; play advances; pause holds;
  transcript expands. No renderer errors and no window focus/visibility.
- Inspected all six held scenes in light and dark and the narrow player, plus
  matching overview slot evidence and a 9-second frame-sampled motion GIF spanning
  the manual-run transition. Encoded MP4 duration/decoding and representative
  decoded frames checked separately, not inferred from a successful render.
- Both 960×600, 30fps, 42-second H.264 MP4 exports render successfully with the
  existing pinned CLI recipe (about 0.7 MB each). Publish as PR media, not git blobs.

## Audit fixes

The first pass opened at an invisible fade-in frame and the captions crowded
controls. The player now opens on a visible held frame and captions have a
larger safe area. The final scene remains visible at the end rather than fading
to an empty card. The initial hidden-window playback test did not advance under
normal hidden painting; using Electron's offscreen rendering fixed the harness
without showing or focusing the window. Typechecking caught and removed an
unsupported Player prop and an ES-library-incompatible array method.

## Limitations and follow-ups

- This is an illustrated workflow explanation, not live automation verification.
  No scheduler, model, web source, connector, real permissions or user data used.
- Responsive phone-width renderer checked; native iOS/Android, Windows/Linux and
  native fullscreen behavior are not verified by this macOS fixture.
- Category and individual-example videos remain honestly labeled placeholders;
  finish those separately under #1171. No new external mascot/font assets.
- The existing npx Remotion recipe reports a zod-version warning from its tool
  environment; both exports succeed. No dependency versions changed to hide it.
  `npm ci` also reports existing dependency audit findings; this media change does
  not remediate or expand dependencies.

## Reproduce

See `apps/desktop/scripts/scheduled-tasks-demo-render/README.md`. Raw evidence
stays under ignored `.shots/`; the PR description contains published media links.
