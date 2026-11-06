# Cold-chat paint: investigation checkpoint

## Scope and status

Reduce cold-switch mount cost under the existing **33 ms** CI gate. Do not increase the gate or claim a Linux fix from macOS results. The branch now contains the SVG clock candidate below; no repair PR has been opened or merged. Its acceptance remains the original 33 ms budget, regardless of independent changes on main.

- Source: `bdd59fa3870f52e5dff3884308a782b14e372db6`.
- Primary tracking: [#1998](https://github.com/nekko-labs/nekko-agent/issues/1998), related [#712](https://github.com/nekko-labs/nekko-agent/issues/712).
- [#1999](https://github.com/nekko-labs/nekko-agent/pull/1999) independently recalibrated main to 48 ms. This investigation does not use that recalibration as acceptance: its exact-source comparisons retain 33 ms.
- Keychain [#1750](https://github.com/nekko-labs/nekko-agent/pull/1750) already merged as `d4c5d73341760525c1342f08c55ab9c7fd4236c8`; #1749 is closed. Its stale live plan was reconciled; no more keychain landing work is pending.

## Constraints and isolation

Existing development Electron and daemon instances are user-owned and remain untouched. Local performance runs use synthetic chat records, a scratch data directory, `NEKKO_FILE_VAULT=1`, and the existing debug daemon. Debug-daemon and macOS figures are **not** release/Linux verification. Visual/interaction evidence uses a hidden, non-focusable, network-blocked Electron fixture with its own profile, no daemon, and synthetic records. The existing app runtime is reused as an executable only, never as a profile.

## Source findings

`CommandWall.tsx` keeps stable window/zone keys but intentionally keys `ChatPane` by session ID. Replacing a zone therefore remounts the transcript and composer, preserving separation of chat-local state. Removing that key is not a safe one-line optimization: drafts, attachments, scroll memory and local menus must remain isolated. Current six-zone harness setup is different from the earlier growing board; prior measurements are not directly comparable.

The first traced cold phase attributed about 1334 ms Paint, 1348 ms Layerize, 684 ms UpdateLayoutTree, 140 ms Layout across the full phase, including settling time. Nested events overlap: these are not an additive click-cost breakdown and do not prove a specific function is the bottleneck.

## Rejected candidate: bounded content containment

Diagnostic CSS only, never applied to production source:

```css
.command-wall-window .command-wall-content { contain: layout paint; }
```

Apple M1 Max, same installed HeadlessChrome `156.0.8078.4`, full `--only latency --no-gpu` workload (40 warm switches, 33 cold switches, 150 typing samples):

| Measurement | Cold frame p95 | Cold history p95 | Warm p95 | Typing p95 |
| --- | ---: | ---: | ---: | ---: |
| Base with timeline tracing | 20.2 ms | 38.3 ms | 9.7 ms | 7.3 ms |
| Containment, uninstrumented | 18.4 ms | 37.7 ms | 9.0 ms | 5.5 ms |
| Base, uninstrumented control | 17.3 ms | 39.1 ms | 10.1 ms | 4.8 ms |

**Rejected:** the apparent improvement vanishes against the uninstrumented control. Do not ship this CSS or attribute the tracing overhead to a renderer repair. Every run reported the terminal measurement skipped (the reused debug host did not open a terminal); streaming-frame and memory phases were not requested.

Raw local reports:
- [Traced base](../.shots/cold-mount/base-trace/perf-report.md)
- [Containment diagnostic](../.shots/cold-mount/contain/perf-report.md)
- [Uninstrumented base](../.shots/cold-mount/base-plain/perf-report.md)

## Baseline interaction and visual evidence

The new `apps/desktop/scripts/cold-chat-paint-sandbox.cjs` uses the existing integration fixture to exercise a six-zone Focus board with 10 chats and 400 messages each. All six checks passed:

1. Off-board chat replaces the active zone.
2. Six windows remain on the board.
3. The newest message renders.
4. A replacement has a separate editor and empty draft.
5. The outgoing draft survives a later remount.
6. The narrow editor fits horizontally.

The window remained hidden and unfocused. Baseline desktop and narrow PNGs were captured and inspected through the local evidence gallery; no after-state exists yet. Twelve native capture frames of a cold switch are saved for a later motion comparison, but playback has not been inspected. The 400px layout has a vertically scrolling stage; the width assertion is not a claim that the composer fits vertically without scrolling.

![Baseline: Focus desktop](../.shots/layout-evidence/cold-chat-before/focused-1440.png)

![Baseline: Focus narrow](../.shots/layout-evidence/cold-chat-before/focused-400.png)

## Browser experiment plan (historical; results below)

[Linux diagnostic 42230357748](https://github.com/nekko-labs/nekko-agent/actions/runs/42230357748) checks out the exact unchanged source on **one runner**, builds once, then runs official Chrome for Testing headless shells in order **155 / 156 / 155**, without tracing. It then collects a cold-switch timeline for each browser. Versions, download provenance, source SHA, CPU, Node version, full samples and compressed traces are retained as an artifact.

The temporary `investigate/cold-chat-browser` branch replaces its own dispatch-only workflow for this diagnostic. **It is not a merge candidate and must not be merged into main.** Source and budgets under test are unchanged. The first dispatch failed before collecting samples because checkout treated an abbreviated SHA as a branch name; the second dispatch corrects that with the full SHA. That is a diagnosed input correction, not a blind performance rerun.

Interpretation:
- If browser versions separate on the same runner, inspect trace differences before choosing a renderer workaround. Do not pin an older browser merely to make CI green.
- If they do not separate, reject the browser hypothesis and use cold-switch mount profiling at the same source/workload. Do not repeat rejected containment/icon trials.
- Any renderer candidate must preserve session identity and pass draft/scroll isolation, matched latency, memory, and inspected before/after visual evidence under the default theme. Keep the existing gate.

## Focused checks

- 50 tests passed across `CommandWall.test.tsx`, `WallWindowComposer.test.tsx`, and `composerDrafts.test.ts`.
- `node scripts/spec-index.mjs --check` and `git diff --check` passed.
- Baseline web build passed. The hidden integration fixture passed six checks with zero focus/visibility errors.

## Baseline checkpoint limitations (historical)

At that checkpoint, no production fix had been demonstrated, no repair PR opened, and no gate changed. Baseline screenshots do not verify a future candidate. A local YAML validation initially referenced the absent `yaml` package; validation subsequently passed with the already installed `js-yaml`, and GitHub accepted the workflow. Delegation failed before child creation due to invalid routing parameters; no child is running. Continue directly rather than silently assuming delegated work exists.


## Same-runner Linux browser control (2026-11-06)

Run [42230357748](https://github.com/nekko-labs/nekko-agent/actions/runs/42230357748)
checked out exact source `bdd59fa3870f52e5dff3884308a782b14e372db6`, built the
release daemon and renderer once, then ran the unchanged complete latency
workload in order 155 → 156 → 155 on the same AMD EPYC 9V74 Linux runner.
The official headless shells were 155.0.8035.0 and 156.0.8078.4. Each phase had
33 cold samples, 40 warm samples and 150 composer samples; one attempt, no GPU.

| Phase | Cold frame p95 | Newest history p95 | Warm p95 | Composer p95 |
| --- | --- | --- | --- | --- |
| Chrome 155 before | 32.9 ms | 50.2 ms | 10.6 ms | 5.9 ms |
| Chrome 156 middle | 29.6 ms | 50.1 ms | 10.0 ms | 5.9 ms |
| Chrome 155 after | 31.1 ms | 50.1 ms | 9.7 ms | 5.9 ms |
| Chrome 155 traced | 32.1 ms | 50.0 ms | 11.6 ms | 6.6 ms |
| Chrome 156 traced | 34.5 ms | 50.0 ms | 11.2 ms | 7.0 ms |

All five reports' nearest-rank p95s were recomputed from the raw attempt samples.
The traced 156 phase exceeded 33 ms: the job's green report-only exit is **not**
gate clearance. This comparison does not support a Chrome156-specific slowdown
or justify browser pinning. It also does not establish the cause of earlier CI
failures on different runners. The first dispatch 42230171853 failed checkout
because the abbreviated SHA was interpreted as a branch; it collected no data.
The temporary workflow branch is diagnostic-only and must not merge.

In 33 click dispatches per trace, median synchronous style-recalculation time
was 4.448 ms (155) / 3.698 ms (156); worst 6.394 / 6.032 ms. The warmest three
initial clicks did no synchronous style recalculation. Only about 1.5 ms total
synchronous layout appeared across the full click phase. These events indicate
mount-time style work, not a browser-version conclusion. Raw reports, compressed
traces and derived per-click attribution are in ignored
`.shots/cold-mount/linux-browser-compare/`.

## SVG clock candidate rationale (initial checkpoint)

A local CPU-profiled baseline attributed **78.7 ms** of samples across the cold
switch phase to native `setCurrentTime`, under GfIcon's layout-effect `stop`
(mount/unmount). Profiled cold frame p95 was 16.5 ms, history 33.7 ms, warm 7.6 ms,
composer 4.1 ms. These are instrumented macOS/debug-daemon diagnostics, not a
Linux release-daemon result.

Unlike the earlier experiment hiding motion SVGs, the candidate removes
redundant clock seeks themselves: synchronously pause a fresh SVG at time zero;
on removal cancel callbacks/listeners without seeking a discarded SVG. Key the
motion SVG by icon identity so name changes cannot inherit its old playhead.
Actual interaction playback and return-to-rest frames are unchanged. Nothing is
scheduled later to evade the first-frame probe. No budget or harness changes.

Hidden, network-blocked Electron baseline and candidate each passed ten checks
covering all16 animated glyphs initially paused at zero, hover, one-shot reset,
focus-event handler, disabled controls, touch hover, click, live reduced motion,
name replacement and unmount. Both used separate disposable profiles and no
daemon/credential access; the user-owned app was not interacted with. Native
keyboard focus in a hidden non-focusable window is not proven. Baseline fixture
errors (counting static Stop as animated, sampling less than the2.3s interval,
and relying on native focus in a hidden window) were diagnosed and corrected
before accepting the baseline. The initial resting baseline PNG was inspected;
after/motion review and paired uninstrumented measurements are pending.


## 2026-11-06 — SVG clock candidate local checkpoint (#1998)

Same M1 Max / Chrome156.0.8078.4 / debug daemon, full six-zone latency workload, immutable base/head renderer builds, uninstrumented, one attempt and33 cold samples each. No concurrent tests or builds. All p95s recomputed from raw samples. Milliseconds:

| Phase | Cold p50 | Cold p95 | History p95 | Warm p95 | Composer p95 |
|---|---|---|---|---|---|
| base-1 | 16 | 20.3 | 33.5 | 11.8 | 3.9 |
| head-1 | 13.4 | 20.2 | 29.7 | 12.7 | 4.3 |
| head-2 | 12.6 | 17.9 | 31.9 | 10.4 | 3.5 |
| base-2 | 15.2 | 22 | 33.7 | 11.6 | 4.1 |

The median improved in both pairs; p95 was nearly unchanged in the first pair and lower in the reverse pair. Promising but insufficient for a Linux repair claim. Raw data: `.shots/cold-mount/icon-paired/`; base/head bundles in `icon-builds/`.

Candidate-only five-lap memory check: heap12.4→12.8MB (0.10MB/lap), DOM2401→2401, listeners2252→2252; six/six windows working, tile memory197.80MB. Worst animated-layer/clip ratio unavailable, not a measured zero; no native GPU claim. Raw report inspected, not accepted from report-only exit status.

65 focused tests pass (10 lifecycle,5 artwork,36 CommandWall,6 composer,8 drafts). No VirtualTranscript test file exists at this revision; none counted. Desktop typecheck, web builds, sandbox syntax, spec-index and diff checks pass. Enhanced hidden Electron baseline/candidate each pass11 checks, including replacing an actively playing icon and waiting past its unmounted timer deadline. The six-zone fixture passes6 isolation/history/horizontal-fit checks.

Resting/reduced-motion native PNGs are byte-identical. Inspected baseline/candidate resting artwork,8 sampled native motion frames each, and matching dark wide/narrow full-chat screenshots. Both narrow screenshots share the existing absence of a visibly accessible composer at this fixture size; the fit check verifies horizontal bounds only. Native keyboard focus, light theme, real-device motion and native GPU remain unverified. Review browser/server closed; no further screenshot replays needed to decide this candidate.

Matched Linux base/head/head/base plus CPU profiles: [run 42243393085](https://github.com/nekko-labs/nekko-agent/actions/runs/42243393085), only the candidate icon file applied to exact bdd59fa source. See the upload failure and recovery below. The 33 ms acceptance budget and full harness are unchanged.


## Linux SVG comparison: artifact failure and recovery (2026-11-06)

[Run 42243393085](https://github.com/nekko-labs/nekko-agent/actions/runs/42243393085) completed its measurements and returned report-only success. The retained job log prints these cold-frame figures (ms); these have **not** been recomputed from raw samples because no artifact was retained:

| Phase | Cold p50 | Cold p95 | Cold p99 | Pass 33 ms? |
|---|---:|---:|---:|---|
| base-1 | 27.2 | 36.9 | 39.3 | No |
| head-1 | 25.3 | 33.7 | 34.0 | No |
| head-2 | 25.6 | 32.9 | 33.0 | Yes |
| base-2 | 27.9 | 36.1 | 37.6 | No |
| profiled base | 35.2 | 43.9 | 45.4 | No |
| profiled head | 33.8 | 40.8 | 43.4 | No |

The upload action warned `No files were found with the provided path: .diagnostic-out/`. The Actions artifacts API confirmed `total_count: 0`; downloading by artifact name failed. The hidden output directory was excluded by upload-artifact's hidden-file policy. Raw sample/CPU attribution cannot be reconstructed from the printed percentile table. The first head p95 still fails 33 ms; neither the green diagnostic job nor a separate gate recalibration on main establishes a repair.

Diagnostic-only commit `fd869553b` changes output to visible `diagnostic-out/`, explicitly enables hidden files for that specific synthetic output path, inventories outputs, requires all six JSON reports and both CPU profiles, and makes absent upload files an error. It changes no app, budget, workload or browser selection. One recovery run was dispatched: [42251252142](https://github.com/nekko-labs/nekko-agent/actions/runs/42251252142), with the same exact source and icon candidate. This is recovery from a diagnosed evidence-publication failure, not a performance retry-until-green. The diagnostic branch must never merge. Inspect raw samples and seek/style attribution before choosing further implementation work; do not repeat browser/screenshot loops.


## Additional candidate verification while Linux evidence recovers

A full local contract (not `--quick`, not report-only, one attempt, no GPU) ran at `a3a7df7bd8620b3506aec838e98780157d478ca2`, using the same M1 Max, Chrome156.0.8078.4 and reused debug daemon as the local controls. It exited zero. Raw nearest-rank statistics were inspected/recomputed:

| Row | p50 | p95 | Max | Samples |
|---|---:|---:|---:|---:|
| Composer keypress | 3.0 ms | 4.1 ms | 9.6 ms | 150 |
| Streaming main-thread frame work | 2.0 ms | 3.44 ms | 13.82 ms | 359 |
| Warm switch | 9.4 ms | 10.6 ms | 10.9 ms | 40 |
| Cold frame | 17.4 ms | 22.9 ms | 23.2 ms | 33 |
| Cold history | 20.4 ms | 35.1 ms | 40.4 ms | 33 |

All measured timing rows passed, with cold frame judged against 33 ms. Terminal keypress was **skipped**, not passed: no terminal pane opened. The five-lap retention check observed heap12.5056→12.9589MB (0.11334MB/lap), DOM2579→2579 and listeners2275→2275. All six wall windows were working; software-compositor tile memory184.359375MB. The report's zero overdraw is an unavailable clip ratio (`overdrawLayer` empty), **not** a measured zero. These are macOS/debug-daemon and SwiftShader observations, not native GPU or Linux-release verification. Raw report: `.shots/cold-mount/candidate-full-contract/`.

65 focused tests and desktop typecheck passed again; syntax/spec-index/diff checks passed. Existing baseline/candidate motion PNGs were assembled into30-frame GIFs without launching or interacting with any app. Encoded files were decoded to verify frame counts and dimensions (2880×1480 native pixels for1440×740 CSS viewport); frame delays follow source-file capture timestamps (~3.6s from first to last frame). Previously inspected native source frames/contact sheets remain the evidence; assembled GIF playback has **not** been inspected. This is not a new recording, a new capture, or a timing-precision claim. No browser/screenshot loop was reopened.


The additional local loopback integration suites all exited zero: turn variants8 checks, daemon relay24, messaging12, small services9 (**53 checks** total). They used the existing debug binary at `/Users/gomi/code/nekko-agent/target/debug/nekkod`, a worktree-built relay, synthetic providers/servers and disposable data/home directories, with `NEKKO_FILE_VAULT=1`. All owned servers/processes exited and no matching harness/fixture server remained afterward. This is local flow coverage with a reused binary, not a current-head release-daemon CI result. MCP HTTP was not run locally: the available Hypergate checkout lacks built core output; the required isolated CI job still needs to cover it. No existing Hypergate/user daemon was contacted or changed. Logs: `.shots/cold-mount/itests/`.
