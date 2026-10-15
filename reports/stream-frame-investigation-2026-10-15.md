# Stream-frame investigation, 2026-10-15

## Scope and provenance

Investigation helpers and reports only. No production edits, commits, budget changes, aggregation changes, or SPEC changes (no product behavior decision). Worktree base: `2c8650dd5093bff26cdd1affa62a23589ce3b522`.

Current renderer is the actual production `main.tsx`/App, bundled with esbuild production defines, minification, splitting and source maps, then Tailwind/PostCSS. This is NOT the electron-vite release build. Backend is the existing primary `apps/server/dist` with **unverified source revision**, forced `NEKKO_DAEMON=ts`, scratch seeded data, loopback scripted provider, separate browser profiles, ports 4491/4492/9492. Primary user runtime was read-only. Viewport 1440x1000, 1,000-message chat, 300 tok/s, 3-second quick streaming phase. Each valid run passed the existing on-screen growth guard.

The ordinary `git` field in generated reports describes the primary checkout, not the renderer or prebuilt backend. Added `investigationProvenance` fields disambiguate this. Renderer build provenance is in `.shots/perf-investigation/current-renderer/build-provenance.json`.

Historical `profile-head` records `f6dddebd99e8c355adc40b30fd07cff4aa784577`, Chrome 155.0.8059.39; `profile-base` records `e59da11b...`. Neither proves current main source, nor the reported CI revision `1ca39eae`. Do not compare those against current as a matched base/head result.

## Lifecycle failure found and corrected

Playwright cache was absent. Downloaded Chromium 1243 (153.0.8010.12) into the investigation directory, not the user's cache. Full Chrome launch returned exit 0, but Windows re-launched children survived and retained port 9492. The first apparent shell run actually connected to that leaked Chrome. It reported about 720 frame intervals/3s and reused renderer PID 58244 across runs. **All such early Chrome/153 measurements are discarded.** Early growth checks also failed twice at 655 -> 655 characters. These failures are not performance results.

Stopped only the owned leaked trees, PIDs 6616 and 42984. Added Windows `--do-not-de-elevate` in the perf browser helper to prevent this relaunch. Final runs use the explicit headless-shell binary, report `HeadlessChrome/153.0.8010.12`, have distinct renderer PIDs and leave no owned browser processes. Removed the two leaked scratch profiles. Downloaded binaries and isolated build dependencies remain under ignored `.shots/` for reproduction.

## Valid matched diagnostic controls

Each is a single run, not best-of aggregation. Work is the existing union-of-main-thread-tasks calculation between AnimationFrame starts, not elapsed interval. Event totals are inclusive/nested and must not be summed as disjoint costs.

| Mode | Renderer PID | Intervals | Interval p50 / p95 ms | Work p50 / p95 ms | Main busy | Paint / style / layout total ms |
|---|---:|---:|---|---|---:|---|
| Timeline only | 63248 | 140 | 20.97 / 24.78 | 3.91 / 4.82 | 18.88% | 104.896 / 74.213 / 59.902 |
| CPU profile + timeline | 25172 | 126 | 23.85 / 30.83 | 4.75 / 6.84 | 21.84% | 123.792 / 81.863 / 61.812 |
| Invalidation + timeline | 46364 | 141 | 20.98 / 25.13 | 4.34 / 5.71 | 20.93% | 104.246 / 80.694 / 56.264 |
| All CSS animation/transition off + invalidation | 47516 | 179 | 16.34 / 26.42 | 3.44 / 4.43 | 21.37% | 124.964 / 29.954 / 62.183 |

CPU profiling increased interval p95 by 6.05 ms relative to timeline-only in this pair. Invalidation collection alone had a smaller interval effect. Single samples do not establish repeatability or explain all historical inflation. All-animation ablation lowers style cost, but paint increases and busy fraction does not improve. It is diagnostic only, not a candidate shipped stylesheet or valid substitute for the normal workload.

The historical trace reanalysis yields 75 starts/74 intervals, interval p50 40.53 ms (the supplied 40.602 may use a different median convention), p95 73.67 ms, work p95 12.42 ms, 24.82% busy. Therefore 40 ms elapsed frame spacing is NOT 40 ms renderer CPU cost. Much of the spacing is outside renderer-main tasks. Browser/compositor pacing, other threads, scheduling and profiling overhead remain candidates. A V8 compactSentence sample cannot explain this gap or native rendering costs by itself.

## Hot invalidation and paint nodes

Final invalidation trace:

- `ChatMetrics.tsx:94`, context-fill `transition-transform duration-300`: 163 animation invalidations and 142 inline-style mutations. Its `::after` has 163 animation invalidations. Correlation, not proof that every pseudo-element event belongs to that bar.
- Pixel mascot eye paths: 273 animation invalidations each for open/closed paths. Rocket/status/SVG paths: 182 per grouped node-name bucket. Counts aggregate matching node names across instances, not necessarily a single node.
- Rocket streak/flame incur 52/50 layout invalidations marked Style changed. Definitions are in `styles.css:1719` onward; decorative clock handling is in `decorClock.ts`.
- Transcript: 151 Text changed layout invalidations, 98 text additions, 75 LI additions. These are expected streaming DOM growth contributors, not evidence of unnecessary global invalidation.
- Paint buckets: document node 2, 142 events/60.026 ms; chat flex container node 363, 140 events/31.860 ms. Composer beam buckets are about 1.019 and 0.517 ms. Root/container paint attribution does not prove every pixel of the viewport was rasterized, and paint events can nest.

The controlled all-animation ablation reduces style total from 80.694 to 29.954 ms but leaves substantial transcript paint/layout. Prioritize a *narrow* context-bar transition or rocket SVG diagnostic next, rather than disabling decoration globally or optimizing compactSentence based only on sampled JS.

## Reproduction and artifacts

Helpers:

- `scripts/perf/build-investigation-renderer.mjs`: direct dependencies from primary, renderer outputs only under `.shots/`.
- `scripts/perf/investigate-stream.ps1`: sequential isolated controls, stops on error; final version also includes invalidation run.
- `scripts/perf/analyze-stream-trace.mjs`: read-only interval/work/native-event/hot-node summary, retains existing stats convention.
- `scripts/perf/investigation-animations-off.css`: diagnostic ablation only.
- `scripts/perf/run.mjs`: preserves growth assertion and writes panel/scroller diagnostics on failure.

Run from this worktree:

```powershell
node scripts/perf/build-investigation-renderer.mjs C:/Users/phili/code/nekko-agent
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/perf/investigate-stream.ps1
node scripts/perf/analyze-stream-trace.mjs .shots/perf-investigation/current-invalidation/streaming.trace.json
```

Local evidence root: [`.shots/perf-investigation`](../.shots/perf-investigation/). Each `current-{timeline,profile,invalidation,animations-off}` contains `perf-report.json`, `streaming.trace.json`, and `streaming.analysis.json`; profile also has `streaming.cpuprofile`. Historical trace summary: `profile-head/streaming.analysis.json`. The final current files supersede contaminated early outputs; early analysis.txt files are not authoritative.

## Build recovery details and limits

Direct bundle first failed on `@braintree/sanitize-url` and Chevrotain `cst-dts-gen`, `gast`, `regexp-to-ast`, `types`, `utils`; restored these six packages under `.shots/perf-investigation/deps` with ignore-scripts. Primary Tailwind plugin then lacked `@alloc/quick-lru`; installed an isolated Tailwind/PostCSS toolchain there instead of modifying primary. Added esbuild `style` resolution condition for Tailwind CSS exports. No primary npm ci/install, dependency junction, or production output writes.

Verification: helper syntax checks passed; existing provenance tests 2/2 passed. Final traces parsed and distinct process IDs inspected. All final run growth guards passed. No desktop visual testing performed or needed for this investigation-only scope. Full release build, exact-source backend, historical Chrome 155 reproduction, GPU/compositor full trace, and repeated randomized matched controls remain unverified. No current production performance win is claimed.

Next distinct experiment: use the corrected owned browser lifecycle and source-built backend, capture compositor/BeginFrame scheduling alongside renderer tasks, and compare narrow context-bar-only and rocket-only ablations in alternating order. This distinguishes native rendering cost from scheduling delay without changing the budget or frame-work definition.
