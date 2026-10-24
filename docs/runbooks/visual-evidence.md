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
  iOS and Android for native.
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

Routine agent verification must run hidden, with non-focusable windows and isolated profiles. Full viewport/virtualization fixtures may stay mapped off-screen, with showInactive, when hidden rendering changes layout or animation behavior. Never place them over any user monitor. Use capturePage with stayHidden:true for renderer evidence and DOM/CDP interaction rather than OS input. Native-window evidence may use an off-screen, non-focusable owned fixture with showInactive; never position it over the active desktop, minimize/restore user windows, or claim hidden renderer pixels prove OS chrome. Launch child processes with windowsHide:true on Windows. Do not launch the normal app or run foreground native branding/permission tests during local verification. Use a disposable CI desktop for OS focus/permission behavior; local visible verification requires an explicit user request. Timing/motion modes and inspection holds must preserve the same background constraints.
