# Scheduled Tasks overview

The reserved overview in `FirstWorkflowWizard` uses `ScheduledTasksDemo.tsx` through
Remotion's player, just like the other app onboarding demos. It inherits the live
app theme, makes no network requests and does not autoplay. Nekko is the existing
`PeekNekkoArt`, not a new mascot asset. The six captions and full transcript live
beside the composition so copy and timing can be reviewed together.

## Render MP4s

From the repository root after `npm ci`:

```sh
node apps/desktop/scripts/render-scheduled-tasks-demo.mjs
```

This uses the existing pinned Remotion CLI recipe and writes light/dark H.264
exports to `.shots/scheduled-tasks-demo/`. Exports and verification media are not
committed: publish PR evidence with `scripts/pr-media.mjs`. The app plays the
composition directly, so custom themes do not need a separate encoded asset.
The render entry mirrors the default light/dark palette from `styles.css`.

## Audit

```sh
npx vitest run apps/desktop/src/renderer/components/ScheduledTasksDemo.test.tsx apps/desktop/src/renderer/components/FirstWorkflowWizard.test.tsx
npm run typecheck -w @nekko-agent/desktop
NEKKO_LAYOUT_FIXTURE=scheduled-tasks-demo-fixture.tsx NEKKO_LAYOUT_SANDBOX=scheduled-tasks-demo-sandbox.cjs NEKKO_TEST_LABEL=scheduled-after node apps/desktop/scripts/layout-evidence-integration.cjs
```

The fixture has no host bridge, synthetic data only and denied network/device
permissions. Its window stays hidden and non-focusable with isolated userData.
It captures six held scenes at 1100px and 390px in both themes, asserts text/page
fit, and checks play/pause and the transcript. Inspect the captures and exported
motion before claiming visual verification. Use the unchanged wizard fixture
against the base revision for matching before screenshots.

The demo is silent with visible captions. Synthetic results and accelerated
progress are labeled; it is not evidence of a live automation run. Category and
individual example videos are separate follow-up work under #1171.
