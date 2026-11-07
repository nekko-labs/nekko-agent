---
title: Customize experience
area: desktop
---

# Customize experience — #2052

Status: implementation in progress; not released or visually verified.

## Requested experience

A destination shared by desktop and iPhone, inspired by the supplied tabbed reference: **Experience** first, then **Connectors**, then **Skills**. The reference images are design references, not implementation evidence. Experience covers presentation and agent behavior, including tone, Simple/Detailed output and monitors. A labeled Simple/Detailed sliding selector sits at the top of View options. It is not a third Custom mode.

## Implemented in this branch

- Desktop: modal destination from View options and Settings. Connector and skill tabs reuse the existing catalogs and their permission/install flows. Experience exposes themes, mode, tone and visible-control preferences, with links to existing behavior/accessibility settings.
- Tone: Default, Friendly, Professional, Concise, Explanatory. Stored as a replaceable `<nekko-tone>` block inside existing additive `systemInstructions`; unrelated instructions are preserved. Reset removes only the owned block. This is not a security prompt or permission change.
- Simple/Detailed: existing per-device presentation preference; tool authorization and agent capability do not change. Existing title/composer shortcut is removed in favor of View options.
- Desktop introduction: skippable Experience step after Theme. Remotion compares the same illustrative keyboard-button task, with steps folded vs expanded. Accessible controls allow manual playback; Reduce Motion disables autoplay.
- iOS: Customize entry, Experience/Connectors/Skills tabs, native segmented mode selector, theme and visible-control/monitor preferences. Existing phone-owned connectors are unchanged. Skills lists the active computer's runnable skills without claiming local install support.
- iOS introduction includes the same rendered Remotion composition, with playback controls and Reduce Motion support.
- iOS model picker: provider limits read from existing `limits:get`, displayed using the Usage screen's percentage/reset/status bar. Load on open, refresh on pull and every 30 seconds while presented. Null responses do not become unlimited or 0% claims. Switching computer clears the readings.
- iOS message composer: model/effort/computer/folder chips lose capsule fills, retaining hit areas. Keyboard dismissal moves outside the formatting toolbar to a trailing 44pt control in a transparent inset above the software keyboard, on new, computer-hosted and phone-hosted chats.

## Verification and limitations

- Desktop shared build and typecheck passed. Focused tone/onboarding tests: 26 passed. Initial 3 wizard failures were hard-coded indices and now use step IDs.
- Isolated full-App Electron sandbox confirmed Detailed preference and tone persistence, using a separate profile with network/permissions disabled. Initial fixture lacked a runner response; fixed rather than treating fixture errors as product evidence.
- Desktop PNGs captured at `.shots/layout-evidence/customize-before` and `customize-after`; inspection blocked by browser screenshot timeout and capture `UnknownVizError`. Capture alone is not acceptance.
- Native protocol/app-state tests and phone tone persistence/provider payload tests passed in run `42344561935`; the subsequent app build failed because Customize referenced nonexistent `ThemeChoice`. Customize now reuses the existing string-backed `ThemePicker`, including match-computer/system choices; corrected compilation and the added UI assertion await a new native run. Native interaction, keyboard position/motion and limit-state evidence remain required. Baseline: `a61cc20007b41a32a1ccadded3731654d697cb8e`; matched workflow: `native-mode-evidence.yml` with `ThemeLanguageTests/testCustomizeEvidence`.
- The iOS video rendered successfully (240 frames, 30fps, 640×380, about 32 KB). Remotion reported an existing Zod version mismatch warning; output exists but has not been visually inspected.
- **Unfinished:** phone tone editing is not wired: the existing phone settings protocol does not expose computer standing-instruction edits. UI says where to manage them, rather than pretending a save works. Phone-local tone presets now persist in the existing offline store and append to the existing phone identity on the next request; native persistence/request tests passed in run `42344561935` (separate from the failed app build).
- **Unfinished:** Android Customize/onboarding parity. Existing Android mode behavior is untouched; a matching native evidence run can establish baseline but does not prove new Android support.
- **Unfinished:** screenshots/reference-image publication and linked documentation PR; all release evidence must be inspected and linked before ready/merge.

## Reproduce

Desktop: `NEKKO_LAYOUT_SANDBOX=customize-sandbox.cjs`, `NEKKO_TEST_LABEL=customize-after`, then `node apps/desktop/scripts/layout-evidence-integration.cjs` (set variables with the platform shell).

Native movie (from `apps/desktop`):

```sh
npx -y -p @remotion/cli@4.0.535 remotion render scripts/experience-render/entry.tsx Experience ../ios/App/Resources/experience-intro.mp4 --codec=h264 --crf=28 --pixel-format=yuv420p
```
