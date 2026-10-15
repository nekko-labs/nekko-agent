# Repeated narrow stream-frame controls, 2026-10-15

## Decision

**Keep budget 10 ms and production React/CSS unchanged. Do not ship either diagnostic override as a gate fix.** Current no-profile six-second baseline passes the existing work metric in both repeats. Neither ablation reproduces or explains the historical work-p95 failure of 12.42 ms on a different browser/revision.

Of the two decorations, **rocket animation is the stronger narrowly attributed optimization target** in this environment: both runs beat both baselines on work p95 and interval p95, and reduce layout. Treat this as a priority ranking for a separately designed optimization preserving status feedback, not approval to remove animation. Context transition removal reliably saves style work but gives almost no work/interval improvement against baseline-2. It is not a convincing frame gate repair.

**Elapsed interval is strongly affected by this headless software-compositor path.** Do not call 22-33 ms intervals renderer CPU cost, and do not attribute the gap to compactSentence from JS samples. Parent's compactSentence evaluation is separate and untouched. This investigation is concluded with these recommendations, not left awaiting another experiment.

## Controlled setup

- Worktree: `C:/Users/phili/code/nekko-agent/.worktrees/investigate-stream-frame`, HEAD `2c8650dd5093bff26cdd1affa62a23589ce3b522`.
- Reused existing diagnostic renderer and existing downloaded HeadlessChrome/153.0.8010.12. No downloads/install performed this continuation. Renderer is esbuild production main.tsx + Tailwind, not electron-vite release output. Build provenance: [build-provenance.json](../.shots/perf-investigation/current-renderer/build-provenance.json).
- Same prebuilt `C:/Users/phili/code/nekko-agent/apps/server/dist` for all controls, with `NEKKO_DAEMON=ts`. SHA256 inventory of every file before/after is identical. Backend source revision is **unverified**; generated perf-report git metadata is not proof of renderer/backend source. Inventories: [before](../.shots/perf-investigation/narrow-controls/backend-before.json), [after](../.shots/perf-investigation/narrow-controls/backend-after.json).
- Seeded scratch data and per-run scratch Chromium profiles; mock provider loopback; 1440x1000, 1,000-message chat, 300 tok/s. User desktop app read-only, not used as evidence. Concurrent user app activity is an uncontrolled machine-noise source.
- Six-second streaming capture, `--only frames --timeline --scheduling --report-only`, **no --quick, no --profile, no invalidation tracking**. Same trace categories in all six: `toplevel`, `devtools.timeline`, frame, metadata, `cc`, `viz`, `gpu`, `benchmark`, `disabled-by-default-cc.debug.scheduler`. Categories verified available by CDP.
- Order: baseline-1, context-1, rocket-1, baseline-2, rocket-2, context-2. Two blocks, ablation order reversed in block two. All results included, no best-of aggregation or retries of valid runs. Two repeats establish direction here, not statistical significance or transfer to desktop hardware composition.
- Each run passed existing live streaming growth guard and used a distinct renderer PID. No CPU profiles generated.
- Computed-style snapshots verify all 13 context fills retain 0.3s transform transition in baseline/rocket, only context controls have `none/0s`. Eight rocket nodes retain named animations in baseline/context and have `animation:none` only in rocket controls. These are all matched instances, not a single DOM instance; no blanket animation or pseudo-element override.

## Results

Work is existing union of renderer-main toplevel tasks between AnimationFrame starts. Interval is elapsed spacing between those starts. Event totals are inclusive/nested and must not be added into a disjoint cost estimate. Style is UpdateLayoutTree. Capture spans are approximately 5.97-6.00s.

| Run | Renderer PID | Intervals | Work p50 / p95 ms | Interval p50 / p95 ms | Main busy | Style / paint / layout total ms |
|---|---:|---:|---|---|---:|---|
| baseline-1 | 64144 | 247 | 4.38 / 7.13 | 23.45 / 32.91 | 18.68% | 147.156 / 212.371 / 112.105 |
| context-1 | 63548 | 256 | 4.16 / 5.29 | 23.20 / 28.18 | 18.37% | 119.078 / 206.594 / 113.496 |
| rocket-1 | 61216 | 277 | 3.83 / 4.71 | 21.26 / 24.44 | 18.11% | 124.353 / 213.118 / 97.299 |
| baseline-2 | 30640 | 265 | 4.02 / 5.23 | 22.46 / 26.27 | 18.37% | 142.135 / 203.309 / 111.249 |
| rocket-2 | 63964 | 276 | 3.88 / 4.82 | 21.43 / 24.63 | 18.25% | 128.011 / 213.213 / 92.535 |
| context-2 | 22908 | 266 | 4.03 / 5.04 | 22.40 / 25.96 | 18.18% | 116.227 / 203.913 / 111.359 |

Baseline-1 has a considerably worse tail than baseline-2; attributing the entire first-block delta to an override would overstate the effect.

Against corresponding block baseline:

- Context: work p95 -25.8% / -3.6%; interval p95 -14.4% / -1.2%; style total -19.1% / -18.2%; layout essentially unchanged. Paint -2.7% / +0.3%.
- Rocket: work p95 -33.9% / -7.8%; interval p95 -25.7% / -6.2%; style total -15.5% / -9.9%; layout -13.2% / -16.8%. Paint +0.4% / +4.9%, partly with more frames, so no absolute paint saving is established.
- Busy fraction stays approximately 18-19% in all cases. The better cadence does not represent elimination of all rendering load.
- All six work-p95 values are below unchanged 10 ms gate; maxima in five runs exceed 10 ms, which is not the p95 gate criterion.

## Compositor scheduling evidence

All traces contain real cc/viz scheduling events, not just renderer task samples. The following table uses specific event names and phases, avoiding duplicate async begin/end/flow counts.

| Run | Viz timer gap p50 / p95 ms | Renderer ProxyMain::BeginMainFrame gap p50 / p95 ms | SoftwareRenderer::DoDrawQuad inclusive total ms |
|---|---|---|---:|
| baseline-1 | 23.26 / 33.87 | 23.25 / 34.82 | 5592.064 |
| context-1 | 22.95 / 28.06 | 22.98 / 28.13 | 5593.484 |
| rocket-1 | 21.25 / 23.99 | 21.23 / 24.03 | 5594.449 |
| baseline-2 | 22.50 / 25.42 | 22.55 / 25.40 | 5583.096 |
| rocket-2 | 21.44 / 24.37 | 21.45 / 24.42 | 5596.368 |
| context-2 | 22.38 / 25.81 | 22.28 / 25.86 | 5592.146 |

`VizCompositorThread | DelayBasedBeginFrameSource::OnTimerTick | X` and renderer `ProxyMain::BeginMainFrame | X` have nearly identical spacing, which also tracks AnimationFrame spacing. Viz spends about 5.58-5.60 seconds in SoftwareRenderer::DoDrawQuad spans during each six-second capture; DirectRenderer::DrawFrame also spans most of the capture. These are wall-duration trace spans, not OS CPU counters, and overlap enclosing draw tasks. They establish the software-rendering path and long Viz occupancy, not GPU utilization or exact scheduler causality.

Compositor `BeginFrame | I` timestamps have 16.67 ms gaps in all six traces. They are consistent with nominal frame timing, but must not be mistaken for actual delivery cadence: timer/main-frame event timestamps above show the slower path. Available evidence supports substantial non-renderer-main pacing under headless software rendering; it does **not** identify an OS scheduling bug, prove hardware desktop slowness, or retroactively explain Chrome 155 historical traces.

## Failed paths and limits

1. Initial location probe at `code/.worktrees/investigate-stream-frame` failed; actual worktree is beneath `code/nekko-agent/.worktrees`. No alternate checkout created.
2. Source-backend feasibility bundle, with local-source host/core/shared/CLI aliases, failed on missing local `@browserbasehq/stagehand` imported by host tools. [Build log](../.shots/perf-investigation/backend-build.log), [helper](../scripts/perf/build-investigation-backend.mjs). Did not download, install, externalize an unresolved dependency into a supposedly working exact-source backend, or write production outputs. Used matching prebuilt for attribution as authorized. Feasibility helper is not a release build recipe.
3. First batch invocation stopped before any browser launch: PowerShell did not provide Get-FileHash. Replaced it with .NET SHA256 and ran the batch once successfully. This was not a performance rerun.
4. Earlier continuation's contaminated browser runs and failed growth checks remain discarded as documented in the [prior report](stream-frame-investigation-2026-10-15.md). No new growth failures.
5. Final process check found no owned Chrome or prebuilt-server process. Only the inspection shell matched its own command string. Ports had TIME_WAIT entries but no listeners. PowerShell's combined inspection command returned nonzero despite useful output; independent Node port probe confirmed all three ports bindable. No user process stopped.
6. No exact-source backend runtime, release renderer build, Chrome 155 reproduction, actual desktop-window visual evidence, or hardware-compositor equivalence verified. No product change made, so no SPEC/production CSS/React edit or visual shipping claim. Only two repeats per condition, machine not exclusive, trace-category overhead not separately quantified in this batch.

## Reproduction and artifacts

From this worktree:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/perf/investigate-stream.ps1
node scripts/perf/summarize-narrow-controls.mjs
```

The existing browser and renderer under `.shots/perf-investigation` are prerequisites; no download is implicit. Runner stops on failure. Each run directory contains perf-report.json, streaming.trace.json, streaming.analysis.json, diagnostic-targets.json, and its ordinary report. Batch stdout is captured in root log files. Machine-readable complete results: [summary.json](../.shots/perf-investigation/narrow-controls/summary.json). [Evidence directory](../.shots/perf-investigation/narrow-controls/).

Helpers changed/added only in scripts/perf: narrow CSS overlays, batch driver, analyzer, summary helper, source-backend feasibility helper, and opt-in `--scheduling` capture in run.mjs. Existing Windows do-not-de-elevate helper change remains pending. No commit, PR, budget/aggregation modification, or production React/CSS change.

Verification: helper syntax checks and provenance tests 2/2 passed; six traces parsed; target styles and categories inspected; backend hashes unchanged; all growth guards passed and reports retained. Concrete handoff: parent can use these results to reject blanket CSS removal and distinguish native/headless cadence from JS attribution while finishing compactSentence independently.
