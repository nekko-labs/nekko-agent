# Visual evidence and safe verification

What a UI change has to show in its PR, and how to capture it without touching the user's desktop.

## UI changes need visual evidence

Any PR that changes what the app looks like ships the proof in its description:

- **Before/after screenshots** for every visual change, in a two-column table labeled
  `Before` / `After`, captured at the same route, viewport, theme, and data. Take the
  "before" shot from the base branch before applying the change, not from memory.
- **A short screen recording** (a few seconds, mp4 or gif) whenever the change touches
  animation, transition, gesture, scroll, or timing. A still frame cannot show motion,
  so screenshots alone do not cover those changes.
- Use the default Nekko Agent theme for screenshots and recordings. A separate
  light/dark theme pair is not required; keep before/after captures in that same
  default theme.
- Cover every surface the change actually affects: mobile and desktop widths on web,
  iOS and Android for native. Native pairs must use the same simulator/emulator device
  and OS runtime. For `native-mode-evidence.yml`, set `ios_runtime` to an exact installed
  identifier (for example `com.apple.CoreSimulator.SimRuntime.iOS-27-0`) and compare
  both `revisions.txt` manifests. Hosted images can have different runtime inventories;
  an unavailable explicit runtime must fail rather than fall back silently.
- Media belongs in the PR description, not in git. Use the shared `pr-media`
  pre-release series for all screenshots and recordings; never create a release
  per PR. GitHub caps a release at 1,000 assets, so when the newest release cannot
  take a PR's whole batch the uploader starts the next one in the series
  (`pr-media-2`, `pr-media-3`, ...) itself; never create those by hand. Write
  local image paths in the description, then upload and rewrite them:
  ```
  node scripts/pr-media.mjs 305
  ```
  The uploader prefixes filenames with `pr-305-`, verifies both the uploaded
  bytes and public URLs, and replaces matching markdown image paths in the PR
  body. It discovers local markdown image paths from the description automatically.
  Pass `owner/repo` as the second argument if needed.
  Keep basenames unique. Existing assets are immutable: rename changed evidence
  rather than overwriting it, so historical links stay accurate. Keep `.shots/`
  untracked and never delete assets still referenced by a PR or issue.
  The shared releases are evidence storage, not software releases; each must remain
  a pre-release and must not be marked Latest.
- If a change has no visual delta (refactor, types, tests, docs, build config), write
  "no visual change" rather than silently omitting the screenshots. A new screen has no
  "before": say so instead of skipping the table.

## Verification must preserve the user desktop

Routine agent verification must run hidden, with non-focusable windows and isolated profiles. Full viewport/virtualization fixtures may stay mapped off-screen, with showInactive, when hidden rendering changes layout or animation behavior. Never place them over any user monitor. Use capturePage with stayHidden:true for renderer evidence and DOM/CDP interaction rather than OS input. On macOS a shown window placed off-screen is moved back onto a display (one created at x:-5000 reports x:0 once shown), so showInactive there puts the fixture over the desktop: on macOS keep it `show: false` and check the run's recorded window bounds. Native-window evidence may use an off-screen, non-focusable owned fixture with showInactive; never position it over the active desktop, minimize/restore user windows, or claim hidden renderer pixels prove OS chrome. Launch child processes with windowsHide:true on Windows. Do not launch the normal app or run foreground native branding/permission tests during local verification. Use a disposable CI desktop for OS focus/permission behavior; local visible verification requires an explicit user request. Timing/motion modes and inspection holds must preserve the same background constraints.

## Capturing renderer evidence

`apps/desktop/scripts/layout-evidence-integration.cjs` bundles the real App
against a stub bridge and captures it in a hidden, off-screen, non-focusable
window. `NEKKO_TEST_LABEL` names the output folder (`.shots/layout-evidence/<label>`),
and `NEKKO_LAYOUT_SANDBOX=<name>-sandbox.cjs` picks the capture script (default
`layout-evidence-sandbox.cjs`). Run it once before editing for the "before" shots.

- Create capture windows with `show: false`, `focusable: false` and
  `webPreferences.backgroundThrottling: false` (leave `paintWhenInitiallyHidden`
  at its default, true), and capture with `capturePage(rect, { stayHidden: true })`.
  Never call `show()` or `showInactive()` for a hidden capture.
- `win.webContents.sendInputEvent({ type: 'mouseMove', x, y })` triggers real
  CSS `:hover` in the hidden window: it is renderer input, not OS input.
- For a GIF without ffmpeg, encode the PNG frames with `pngjs` and `omggif`
  (both in `node_modules`). Build the palette from the frames' own most common
  colors; a fixed color cube washes pale tints out to white.
- The synthetic bridge supplies an empty `RunnerView[]` for `listRunners`,
  because the real App mounts the CI-runner panel even in unrelated journeys.
  `layout-evidence-fixture.node-test.cjs` exercises that bridge without launching
  Electron. Do not silence renderer errors or make unknown responses all return
  arrays: compare the report's `errors` against a run on `main`, then repair a
  broken fixture contract separately from the feature under test (#2012).

### Empty-agent wave journey

Use `NEKKO_EXPECT_WAVE_NEW=1` and `NEKKO_LAYOUT_SANDBOX=empty-agent-wave-sandbox.cjs`
with the shared layout launcher to enforce assertions. The journey dismisses the
zones introduction through its Close control and rejects any remaining dialog.
It checks the shipped per-chat mascot's `data-chat-mascot` state before the first
token and after completion, and the separate background chat's wall indicator
while working and waiting. A real, nonempty synthetic question and matching
`pendingInput` response keep the visible question and host state consistent.
The removed global `.pixel-mascot` and Dynamic toolbar button are not queried.
Single/Multi-agent transitions use the shared View-menu helper and verify layout
selection and Escape dismissal (#1684).

The window stays hidden/nonfocusable and uses Electron offscreen rendering, so
Windows delivers frames for transitions without showing or focusing a window.
Wave clocks, reduced motion, setting disablement, stationary working artwork,
no working beams, and before-token wave removal remain enforced. The existing
300ms send wait and other state deadlines are unchanged. `NEKKO_WAVE_SKIP_CPU=1`
skips CPU sampling only; such a run is interaction evidence, not a performance
result. Saved PNGs/frames are not visually inspected evidence until reviewed.
Node regressions exercise failure propagation/isolation, not actual rendering.

### Wall-composer journey

Run the shared layout launcher with `NEKKO_LAYOUT_SANDBOX=wall-composers-sandbox.cjs`.
The current plan starts expanded: the journey explicitly folds it, checks the
working step/pass/position and the individual sub-agent cards, reopens it, then
opens a completed step before checking its task and sub-agent links. It retains
the per-window composer, voice-island and selection-height checks (#2072).
A failed journey returns a nonzero Electron status (covered by a registered
Node regression); `app.quit()` alone does not preserve `process.exitCode`.
Console diagnostics are still collected in `report.errors` and must be inspected
alongside assertions. Existing ResizeObserver scheduling warnings are tracked in
#360, not filtered out or claimed fixed by this harness repair. Baseline capture
mode (`NEKKO_TEST_SOURCE`) intentionally records assertions without enforcing them;
use the normal mode to validate a change.

### Grid model and mode-menu journey

`npm run test:grid-bugs -w @nekko-agent/desktop` exercises model selection and
mode menus in the wall at desktop/narrow widths and light/dark themes. Switching
to a single agent opens the shipped View menu, selects its focus radio, checks
both the radio and wall layout, then dismisses the menu with Escape (#2152).
Missing controls or an unapplied selection fail the journey, not a silent no-op.
The legacy Focused toolbar button is not part of this path.

For a strict comparison against an unchanged current renderer, set
`NEKKO_TEST_REVISION=<base-commit>` and `NEKKO_GRID_ASSERT_FIXED=1`. This uses the
same harness with archived renderer sources, including the fixture's StoreSidebar
imports, and keeps all grid-bugs behavior assertions enabled. Without that explicit override, historical revision captures
retain their existing capture-only checks. Inspect `status.json`, including
`errors` and `background`; generated PNGs are not automatically visually reviewed.
This harness repair does not change the separate performance setup or establish
the cause of its newest-message failures.

## Running the Local Web UI for verification

The server reads only `NEKKO_`-prefixed variables (`ENV_PREFIXES` in
`packages/shared/src/brand-env.ts`); any other prefix is ignored silently, and
the server then starts on 1440 against your real data folder. Point it at a
throwaway one:

```
NEKKO_DATA_DIR="$(mktemp -d)" NEKKO_PORT=1450 npm run start -w @nekko-agent/local-web-ui
```

Check the startup log's `data dir:` line before touching the UI. To get
provider cards without real settings, seed that folder with a `settings.json`
holding a `providers` array. `.claude/launch.json` is tracked: keep temporary
preview entries out of it, or out of your commit.

### Composer folders and suggestions journey

Set `NEKKO_LAYOUT_SANDBOX=composer-folders-sandbox.cjs` for new/active text
composers at 1000px and 390px in Simple/Detailed. It checks one folder picker
immediately before +, Suggestions below the actions, removal from Mode, folder
selection and per-chat removal without revoking saved access, and Escape focus
restoration. Synthetic bridge folders and drafts never touch real app data.
Capture the unchanged renderer with `NEKKO_TEST_SOURCE=<base-worktree>` and
`NEKKO_FOLDERS_BASELINE=1`; omit both for strict post-change assertions. Inspect
the report and PNGs separately; generated captures are not visual approval.
