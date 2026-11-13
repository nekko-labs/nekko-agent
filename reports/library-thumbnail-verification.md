# Library document thumbnails, verification

Tracks [#2747](https://github.com/nekko-labs/nekko-agent/issues/2747).

## Implemented

- Markdown/plain text first-page content thumbnails, compact shared row icons, lazy document/image reads.
- Renderer-local shared LRU: 80 results / 8 MiB encoded strings, three concurrent read/decode jobs, 60-second successes / five-second failures, exact path + chat revision keys.
- Raster/SVG image thumbnails become still WebP images at no more than 640 pixels on the longest edge. Original source remains available when opened.
- Offline, inert image rendering; no document links, scripts, images, external fonts or raw HTML in the app DOM.

## Checks

- 65 focused Vitest tests pass (Library preferences, icons, canvas helpers, thumbnails/cache, artifact index, local images, first-visit guide).
- Desktop and Local Web UI TypeScript checks pass; spec index and `git diff --check` pass.
- Existing full-App Library layouts journey: 19 assertions, no renderer errors. Existing first-visit journey: 18 assertions, no renderer errors.
- Final isolated thumbnail journey: 14 assertions, no renderer errors, hidden/non-focusable Electron window, network blocked. It verifies content, PDF/unreadable fallbacks, no document iframes, no hidden-image reads, one read per supported file, layout/visit cache reuse, source-file opening, raster+SVG downsampling, chat-revision invalidation and narrow list visibility.
- Capture settings: macOS / Electron 45; 1440x900 dark/light desktop, 430x932 narrow list; same seven synthetic files and unchanged base renderer for matched before/after captures. PNGs and short layout-switch GIF are published in the PR, not committed.

Measured synthetic transformation: solid-color PNG data URL 41,962 → 1,335 characters; 1600x900 → 640x360. The SVG fixture produces a 640x480 WebP URL of 1,511 characters. This is not an end-to-end speed benchmark. See [performance history](../docs/perf-history.md).

## Limitations

- No packaged-app, Windows/Linux native-window or standalone Local Web UI browser journey was run. Evidence proves the actual desktop renderer inside Electron, not operating-system chrome. Native capture source listing failed; captured Electron PNGs were inspected through a loopback image viewer instead.
- PDFs and Office content thumbnails remain unsupported. Document rendering is a first-page text summary (including code/table text), not the full Markdown viewer.
- Cache does not persist across app reloads. Mounted thumbnails are not polled; external edits without chat revision appear on a later request after expiry. Existing HTML tiles are not part of this cache.
- Initial failed harness attempts: seeded chat image cards added unrelated reads, a Settings route lacked bridge fields, and a fixed transition delay overlapped animations. The final fixture uses a neutral Automations route with an explicit empty workflow response and waits for transitions. No errors are filtered out in the final journey.

## Reproduce

From an isolated worktree with its own dependencies:

```sh
NEKKO_TEST_SOURCE=/absolute/path/to/unchanged/base NEKKO_LIBRARY_BASELINE=1 NEKKO_TEST_LABEL=library-thumbs-before NEKKO_LAYOUT_SANDBOX=library-thumbnails-sandbox.cjs node apps/desktop/scripts/layout-evidence-integration.cjs
NEKKO_TEST_LABEL=library-thumbs-after NEKKO_LAYOUT_SANDBOX=library-thumbnails-sandbox.cjs node apps/desktop/scripts/layout-evidence-integration.cjs
```

The feature base is `afd98dd4c26b53880b80820a438a1e7e5c4852c1`. The primary worktree advanced to `0ffcf2fe78f713d11fa83c0eaca0451fb41daaf2` before the final baseline capture; `git diff afd98dd4c..0ffcf2fe7 -- apps/desktop/src/renderer` was empty, so its renderer is byte-identical to the feature base. Both source revisions therefore show the same unchanged Library. The script writes evidence and its JSON report only under ignored `.shots/layout-evidence/`.

## Security follow-up

CodeQL initially flagged the tag-stripping regex and interpolated fixture labels. Follow-up `dd6492540` removes tag stripping entirely (literal markup is XML-escaped as text in the inert image) and passes only numeric control indexes into evaluated fixture code. Ten focused thumbnail tests and the desktop typecheck pass again; CI and the full isolated journey are rerun for the follow-up. The plain-text/Markdown evidence fixture has no visual delta.
