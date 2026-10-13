# Performance history

A running log of every change that measurably moved Nekko Agent's performance,
for better or worse. It exists so we can see the trend over time, learn from the
dead ends, and later write about it.

Regressions, null results and measurement fixes belong here as much as wins: a
change that made one number worse to make another better is the most useful kind
of entry.

## Adding an entry

Any PR that measures a performance change adds an entry here in the same PR (see
AGENTS.md). Newest first, under the month. Keep to this shape:

```
### #123 Short title (YYYY-MM-DD)
Area: dev build | packaging | renderer | GPU/memory | local inference | engine daemon | perf harness
Result: improvement | regression | mixed | no effect | measurement fix
Conditions: machine, OS, browser, warm/cold, sample size

| Metric | Before | After |
|---|---|---|
| ... | ... | ... |

Why: one sentence on what changed. Source: the PR, a report, or a commit.
```

Only record numbers that were actually measured, quoted exactly from their
source. If a PR was performance-motivated but measured nothing, list it under
[Unmeasured](#unmeasured) instead of guessing.

## Themes

Threads worth an article, with the entries that tell each story:

- **The speed contract.** Budgets written down (#214), enforced in CI (#217),
  then a month of fighting the warm-switch gate on shared runners: #302, #370,
  #389, #395, #399, #406, #438, ending with the discovery that part of the
  slowness was the harness itself (#460) and a decoration clock (#461).
- **Moving the engine into Rust (PF14).** Each move out of the TypeScript host
  into `nekkod` mostly erased the "host is busy" penalty (hundreds of ms to
  single digits) while sometimes costing a few ms when idle: #225, #235, #239,
  #442, #444, #451, #459, #468, #475.
- **GPU and energy.** Animations are not free: #405 (stepped animations, 52
  Energy Impact), #419 (a 70 MB layer for a spinner), #421 (a memory gate so it
  can't come back).
- **Local inference.** #152 (we were reporting half the real tok/s), #196, #218,
  #222.
- **Developer loop.** #342, #490, #503.

## 2026-10

### #516 Group drag fix: CI latency diagnostics (2026-10-13)
Area: renderer / perf harness. Result: inconclusive, mixed diagnostic results.
Conditions: GitHub Actions Ubuntu shared runner, CI run 38378954525 attempt 1. Same-run head/base diagnostics used `--quick --only latency --profile --timeline --no-gpu`; 40 composer samples, 10 warm switches, 11 cold switches. Profiling differs from the full gate, so these are not proof of a regression or improvement.

| Diagnostic p95 metric | Unchanged base | PR head |
|---|---|---|
| Composer keypress to paint | 22.0 ms | 25.1 ms |
| Warm chat switch | 26.8 ms | 22.3 ms |
| Cold chat frame painted | 28.4 ms | 26.4 ms |

The full head gate's best streaming frame-work p95 was 10.4 ms against a 10 ms gate (198 samples). The latency-only base diagnostic skips this metric, so no matched base number is available. Both base and head diagnostics missed warm/cold switch budgets. A single failed-job rerun was requested to distinguish runner variability; no budgets were relaxed. The group-drag change does not alter streaming logic, but causality remains unverified. Source: [PR #516](https://github.com/nekko-labs/nekko-agent/pull/516), [CI logs](https://github.com/nekko-labs/nekko-agent/actions/runs/38378954525/job/115234283340).

### #503 npm install at the start of npm run dev (2026-10-13)
Area: dev build. Result: regression (deliberate, small)
Conditions: Windows, warm npm cache, nothing to install

| Metric | Before | After |
|---|---|---|
| Added to every `npm run dev` | 0 s | 1.6 s ("up to date in 1s") |

Why: a pull that changed dependencies should never launch against stale
`node_modules`; the no-op cost was judged worth it.
Source: [#503](https://github.com/nekko-labs/nekko-agent/pull/503).

### #490 Faster npm run dev (2026-10-12)
Area: dev build. Result: improvement
Conditions: Windows, warm tree, RTX 5090 / Ryzen 9 9950X3D box

| Metric | Before | After |
|---|---|---|
| Pre-launch build, nothing changed | ~17 s | 3.9 s |
| `electron-vite build` (removed from dev) | 13.4 s | 0 s |
| Rebuild after a one-file `nekkod` change | 60 s | 8.8 s |
| First build of the new `dev-daemon` profile (one time) | n/a | ~75 s |

Why: dev ran a production `electron-vite build` that `electron-vite dev` then
redid, and compiled `nekkod` with thin LTO. Dev now skips the desktop bundle and
builds the daemon in a `dev-daemon` profile (no LTO, incremental, 256 codegen
units). Source: [#490](https://github.com/nekko-labs/nekko-agent/pull/490).

### #488 Smaller Windows installer (2026-10-12)
Area: packaging. Result: improvement

| Metric | Before | After |
|---|---|---|
| Raw size (DirectML.dll on demand) | +18 MB | 0 |
| Installer size | | about -8.8 MB |
| On-demand DirectML fetch | n/a | 18,527,776 bytes in 0.8 s (range requests) |

Rejected: `opt-level = "s"` took `nekkod` from 49 to 41 MB but saved only about
1.7 MB compressed and slowed the daemon. The "15-20% faster" CUDA claim is
explicitly unmeasured (T190).
Why: DirectML is delay-loaded and fetched when first needed.
Source: [#488](https://github.com/nekko-labs/nekko-agent/pull/488).

### #480 Engine and perf integration (2026-10-12)
Area: renderer, perf harness. Result: mixed

| Metric | Value |
|---|---|
| Local frame work p95 | 4.4 ms |
| Beam writes | 12 per second (from the 30 Hz tick) |
| Windows terminal p95 (budget 20.8 ms) | 58.1 ms; unchanged relay branch 61.9 ms |

The Windows/ConPTY overrun is a known, pre-existing limitation; the hosted Linux
gate passed. Source: [#480](https://github.com/nekko-labs/nekko-agent/pull/480).

### #475 Context panel into nekkod, PF14 (2026-10-12)
Area: engine daemon. Result: improvement

| Metric | Before | After |
|---|---|---|
| `context:preview` p50 | 1.73 ms | 0.75 ms |
| Previews served in the same time | 10,598 | 23,838 |

Source: [#475](https://github.com/nekko-labs/nekko-agent/pull/475).

### #468 Git status and design board into nekkod, PF14 (2026-10-12)
Area: engine daemon. Result: mixed

| Metric | Before | After |
|---|---|---|
| `design:get`, host busy | 315 ms | 1.0 ms |
| `gitStatus`, host busy (p95) | 758 ms (1455) | 298 ms (498) |
| `gitStatus`, idle | 27 ms | 35 ms (worse) |

Source: [#468](https://github.com/nekko-labs/nekko-agent/pull/468).

### #461 Decoration clock (2026-10-12)
Area: renderer. Result: mixed, mostly improvement
Conditions: Ubuntu 24.04 container, 4 CPUs, Chrome 155, no GPU; p95 per attempt

| Metric | Before | After |
|---|---|---|
| Stream | 7.0 / 7.3 ms | 6.3 / 7.0 ms |
| Composer | 11.3 / 15.1 ms | 9.2 / 11.6 ms |
| Terminal | 5.6 / 6.5 ms | 4.8 / 5.5 ms |
| Warm switch | 9.8 / 9.9 ms | 10.4 / 10.4 ms (slightly worse) |
| Cold switch | 14.8 / 20.7 ms | 13.0 / 18.5 ms |

Why: looping decorations step on a 30 Hz clock instead of every frame. An
earlier attempt, reverted by #438, had looked bad (warm 18-19 ms, terminal 25-36
ms), but that was the harness artifact fixed in #460. Source: commit `a5aca024`.

### #460 Perf harness frame pump (2026-10-12)
Area: perf harness. Result: measurement fix

| Metric | Without pump | With pump |
|---|---|---|
| Bare page, click to paint p50/p95 | 16.5 / 17.3 ms | 0.7 / 0.8 ms |
| Warm switch p95 (container, #438 clock) | 18.9 ms | 10.4 ms (22.5 in one slow burst) |
| Cold switch p95 | 18.7 ms | 13.0 / 19.9 ms |
| Terminal p95 | 37.2 ms | 4.8 / 5.1 ms |

Why: after an empty frame Chromium waits for the next 60 Hz tick, so a page with
nothing animating measured up to a full frame slower than it is. The harness now
runs a 1 px compositor animation while a sample is in flight. Lesson: part of the
long warm-switch fight was the ruler, not the app. Source: commits `c8de287b`,
`f8e00208`.

### #459 Files, memory and workspace index into nekkod, PF14 (2026-10-12)
Area: engine daemon. Result: improvement. Medians.

| Metric | Before (idle / busy) | After (idle / busy) |
|---|---|---|
| `file:read` | 1.3 / 264 ms | 0.6 / 0.7 ms |
| `dir:list`, busy | 263 ms | 1.7 ms |
| `workspace:files`, busy | 262 ms | 1.5 ms |
| `workspace:search` | 69.6 / 325 ms | 28.6 / 33.4 ms |
| `workspace:index` | 106 / 377 ms | 48.8 / 58.7 ms |

Source: commit `16ef4180` (numbers in `a2dc47f0`, `25cc07b5`).

### #451 GPU and system stats into nekkod, PF14 (2026-10-12)
Area: engine daemon. Result: improvement. Host busy, medians.

| Metric | Before | After |
|---|---|---|
| `gpu:stats` (p95) | 732 ms (981) | 55 ms (117) |
| `system:stats` | 249 ms | 1.8 ms |
| `machine:readiness` | 1103 ms | 423 ms |
| `machine:readiness`, idle | 442 ms | 391 ms |

Source: [#451](https://github.com/nekko-labs/nekko-agent/pull/451).

### #444 Auto-title and queue drain into nekkod, PF14 (2026-10-11)
Area: engine daemon. Result: improvement

| Metric | Before | After |
|---|---|---|
| Done to follow-up's first text, idle | 23 ms | 21 ms |
| Same, host busy | 1101 ms | 790 ms |

Source: [#444](https://github.com/nekko-labs/nekko-agent/pull/444).

### #442 Chat turns into nekkod, PF14 (2026-10-11)
Area: engine daemon. Result: mixed
Conditions: fake bench, 10 turns per route, host busy unless noted

| Metric | Before | After |
|---|---|---|
| Approve to result | 451 ms | 5.1-5.8 ms |
| Approve answered | 450-451 ms | 1.0-1.3 ms |
| First text | 1221-1480 ms | 1048-1268 ms |
| Approve to result, idle | 2.5 ms | 5.6-6.2 ms (about 3 ms slower) |

Source: [#442](https://github.com/nekko-labs/nekko-agent/pull/442).

### #439 Web edition behind nekkod (2026-10-11)
Area: engine daemon. Result: mixed

| Metric | Before | After |
|---|---|---|
| Windows terminal keypress to paint p50/p95 | 16.7 / 18.2 ms | 17.3 / 18.5 and 17.1 / 18.1 ms (no change) |
| Linux terminal p50/p95 | 4.9 / 5.7 ms | 4.1 / 4.9 ms |
| Linux echo | 2.4 ms | 1.4 ms |

First text 39-48 ms. The perf job was red (warm 27.9, cold 26.2 ms), as was
main. Source: [#439](https://github.com/nekko-labs/nekko-agent/pull/439).

### #438 Warm switch as a visibility flip (2026-10-11)
Area: renderer. Result: mixed, mostly improvement

CI, EPYC 9V74, p95 per attempt:

| Metric | Before | After |
|---|---|---|
| Warm switch | 26.5 / 25.3 / 24.5 (fail) | 15.1 / 13.1 ms |
| Cold frame | 25.4 / 23.8 / 24.4 | 19.6 / 19.7 ms |
| Composer | 23.1 / 25.9 / 25.2 | 22.8 / 23.1 ms |
| Stream frame work | 9.0 / 8.5 / 8.6 | 12.6 / 9.8 ms (worse) |
| Terminal | 6.2 / 6.3 / 5.7 | 7.7 / 6.4 ms |

On EPYC 7763 stream frame work failed its gate of 10 (11.0 / 10.8 / 10.5).
Locally (3 alternating runs, p50/p95): warm 11.3/15.1 to 7.1/8.6 ms, cold
11.0/13.5 to 10.2/11.6, composer 6.1/8.9 to 5.2/7.7, stream 4.1/5.6 to 3.8/5.1.
Tile memory 444-473 MB to 140-250 MB.
Why: settings-scoped subscriptions, and no slide animation leaving Focus.
Source: [#438](https://github.com/nekko-labs/nekko-agent/pull/438).

### #421 Memory contract in the perf job (2026-10-10)
Area: perf harness. Result: new gate

| Metric | Value | Gate |
|---|---|---|
| Worst animated layer | #419's beam 9.6x; current main 0x | 2x |
| Tile memory | ~160-245 MB | 320 MB |
| Leaks | ~0.1 MB / 0 / 0 | |

Cleanup also found 324 stale browser profiles (3 GB) in TEMP.
Source: [#421](https://github.com/nekko-labs/nekko-agent/pull/421).

### #419 Working beam GPU layer (2026-10-10)
Area: GPU/memory. Result: improvement
Conditions: CDP LayerTree, 150% scaling

| Metric | Before | After |
|---|---|---|
| Layer per working wall window | 4194x4194 device px (~70 MB) | 2100x1350 (~11 MB) |

Why: the beam rotated a square `2 * max(w, h)` on a side.
Source: [#419](https://github.com/nekko-labs/nekko-agent/pull/419).

### #406 Avoid workspace work on switch (2026-10-09)
Area: renderer. Result: no effect / regression
Conditions: M1 Max, headless Chrome 149, no GPU, quick run

| Metric | Before | After |
|---|---|---|
| Warm switch p95 | 11.5 ms | 14.9 ms (worse) |
| Cold switch p95 | 15.6 ms | 14.0 ms |

The shared CI failures it targeted (head warm/cold p95 on #394, #396, #399,
#400, #401: 28.9/28.1, 27.0/27.1, 28.2/26.7, 28.6/27.8, 26.8/25.7) were not
resolved; "no performance win" was established.
Source: [#406](https://github.com/nekko-labs/nekko-agent/pull/406),
`reports/shared-perf-gates.md`.

### #405 Stepped working animations (2026-10-09)
Area: renderer, GPU/energy. Result: improvement
Conditions: macOS Apple Silicon, average CPU over 6 s. Starting point: Energy
Impact 52, GPU near 66%.

| Scenario | GPU process before | after | Renderer before | after |
|---|---|---|---|---|
| Composer beam | 14.0% | 3.2% | 2.6% | 1.3% |
| 3 wall beams | 24.3% | 3.5% | 3.1% | 1.3% |
| 3 status rockets | 14.3% | 3.5% | 13.6% | 5.9% |
| Needs-you glow | 21.1% | 3.7% | 9.9% | 4.4% |
| Busy wall | 22.5% | 7.8% | 14.4% | 7.4% |
| Busy wall, app unfocused | 22.5% | 0.1% | 14.4% | 0.0% |

CI perf failed on EPYC 7763 (warm 27.0 vs 20.8, cold 25.8 vs 25).
Why: `steps()` timing and pausing animations when unfocused.
Source: [#405](https://github.com/nekko-labs/nekko-agent/pull/405).

### #399 Switch perf investigation (2026-10-09)
Area: renderer. Result: no effect (no fix found)

Head CI p95: warm 26.7 (gate 20.8), cold frame 26.4 (gate 25), stream 9.9 (gate
10). Profiled quick runs, head vs base: warm 29.3 vs 41.7, cold 33.2 vs 32.4 ms.
The slow tails were not attributed to the PR.
Source: `reports/pr399-switch-perf-investigation.md`.

### #395 Stop wall windows re-rendering (2026-10-08)
Area: renderer. Result: improvement
Conditions: local, Chrome for Testing 149, 40 warm switches; CI baseline was
~14 ms of script per switch (~9 ms React, ~3 ms commit)

| Metric | Before | After |
|---|---|---|
| `ChatPaneImpl` per switch | 0.73 ms | 0.17 ms |
| `CommandWall` | 0.57 ms | 0 ms |
| `McpMenu` | 0.18 ms | 0 ms |
| Cold switch script | 4.7 ms | 3.1 ms |

Local warm/cold p95 16.7/15.2 ms; CI not yet known to pass at merge.
Source: [#395](https://github.com/nekko-labs/nekko-agent/pull/395).

### #389 Warm-switch gate on shared runners (2026-10-08)
Area: perf harness. Result: no effect

The warm-switch gate (20.8 ms) "failed in 28 of the last 40 runs"; the runner
measured 18 to 25 ms. Budgets were deliberately not loosened.
Source: [#389](https://github.com/nekko-labs/nekko-agent/pull/389).

### #378 macOS memory accounting (2026-10-08)
Area: GPU/memory. Result: measurement fix

| Metric | Before | After |
|---|---|---|
| Memory used, same Mac | "roughly 59 GiB" (Activity Monitor: ~35 GB) | 34677 MiB of 65536 MiB |

Why: count anonymous minus purgeable, plus wired and compressor (vm_stat),
instead of total minus free. Source:
[#378](https://github.com/nekko-labs/nekko-agent/pull/378),
`reports/usage-memory-savings-investigation.md`.

### #370 Composer sizing layout work (2026-10-07)
Area: renderer. Result: unmeasured after

Motivated by the post-#367 CI misses: streaming 13.4 ms (gate 10), warm switch
35.1 ms (20.8), cold frame 33.4 ms (25), and warm `getBoundingClientRect` self
time 73.8 ms vs 3.0 ms on base. No after numbers were recorded.
Source: [#370](https://github.com/nekko-labs/nekko-agent/pull/370).

### #342 Faster renderer builds (2026-10-06)
Area: dev build. Result: improvement
Conditions: paired Windows renderer builds

| Metric | Before | After |
|---|---|---|
| Renderer build | 12.64 s | 10.30 s (18.5% faster) |
| Lazy ELK chunk | | +38,144 bytes (+1.1%) |

Why: stop tree-shaking ELK's prebundled layout engine.
Source: [#342](https://github.com/nekko-labs/nekko-agent/pull/342).

### #302 Command Center responsiveness (2026-10-04)
Area: renderer. Result: mixed (switches within noise)
Conditions: headless Edge, no GPU, 58 real sessions, medians of 8-9 switches

| Metric | Before | After |
|---|---|---|
| Open chat from the wall, idle / 4 streams | 40 / 56 ms | 40 / 64 ms |
| Newest reply in view | 87 ms | 53 ms |
| Back to the wall | 88 / 104 ms | 80 / 104 ms |
| Status on the first frame | 0 of 4 | 4 of 4 |

A reverted experiment made returning to the wall faster (88 to 48 ms) but the
newest reply slower (87 to 148 ms).
Source: [#302](https://github.com/nekko-labs/nekko-agent/pull/302).

### #285 Perf harness: a third attempt (2026-10-03)
Area: perf harness. Result: harness change

CI moved from two attempts to three because "a cold-switch budget was missed by
0.1 ms". Source: [#285](https://github.com/nekko-labs/nekko-agent/pull/285).

## 2026-09

### #239 File and shell tools in nekkod (2026-09-30)
Area: engine daemon. Result: mixed
Conditions: warm grep over 3,000 files, 3 runs

| Metric | TS host | Daemon |
|---|---|---|
| Grep, idle | 98 ms | 84-86 ms |
| Grep, host busy | 98-99 ms | 116-125 ms (worse) |
| Regex with no match | | 185 ms (still slower in Rust) |

The first Rust version was "2 to 3 times slower" than Node until a substring fast
path, one open per file and a whole-file UTF-16 regex.
Source: [#239](https://github.com/nekko-labs/nekko-agent/pull/239).

### #235 Chat replies on the Rust loop (2026-09-30)
Area: engine daemon. Result: no effect ("about the same"), 3 turns each

| Metric | TS | Daemon |
|---|---|---|
| First text p50, idle | 843 ms | 714 ms |
| First text p50, busy | 710 ms | 729 ms |
| Gap p50, busy | 7 ms | 4 ms |
| Gap max, idle | 42 ms | 39 ms |

Source: [#235](https://github.com/nekko-labs/nekko-agent/pull/235).

### #231 Providers in Rust (2026-09-30)
Area: local inference. Result: smoke test, no comparison

148 tok/s decode, 218 tokens, Gemma 4 12B on llama.cpp b11011.
Source: [#231](https://github.com/nekko-labs/nekko-agent/pull/231).

### #225 Session reads in nekkod (2026-09-30)
Area: engine daemon. Result: improvement
Conditions: 301 chats including a 7.1 MB image chat; busy = 8 concurrent TS jobs

| Metric | TS host | nekkod |
|---|---|---|
| Open image chat, idle | 28 ms | 14 ms |
| List chats, idle | 30 ms | 21 ms |
| Open image chat, busy | 403 ms | 13.6 ms |
| List chats, busy | 797 ms | 22 ms |

Source: [#225](https://github.com/nekko-labs/nekko-agent/pull/225).

### #222 Laya decision models (2026-09-30)
Area: local inference. Result: new feature (provider comparison)
Conditions: RTX 5090 / Ryzen 9 9950X3D, release build

| Provider | 1 question | 10 questions |
|---|---|---|
| DirectML fp16 | 8.6 ms | 81 ms |
| DirectML fp32 | 15 ms | 154 ms |
| CPU fp32 / fp16 / int8 | 94 / 106 / 68 ms | 733 / 707 / 731 ms |

DirectML with dynamic shapes cost 86 ms per call, so shapes are pinned. Release
`nekkod` was "~30 MB". Source: [#222](https://github.com/nekko-labs/nekko-agent/pull/222).

### #219 Model server router in nekkod (2026-09-30)
Area: engine daemon. Result: regression (negligible)

| Metric | Direct | Through the router |
|---|---|---|
| One-token request, median of 30, RTX 5090 | 27.29 ms | 27.39 ms |

Source: [#219](https://github.com/nekko-labs/nekko-agent/pull/219).

### #218 Faster local inference (2026-09-30)
Area: local inference. Result: mixed, mostly improvement
Conditions: RTX 5090, Gemma 4 12B Q4_K_M, median of 3

| Metric | Before | After |
|---|---|---|
| Decode | 127 tok/s | 154 tok/s |
| Code edit | 117 tok/s | 534 tok/s |
| 4 concurrent requests | 283 tok/s | 256 tok/s (worse; noisy, 256-343) |
| New 8k chat, first turn | 2.3 s | 1.7 s (Ollama: 1.3 s) |
| Revisit | 1.7 s | 0.8 s |
| TTFT, short prompt | 98 ms | 99 ms |
| Prefill | 5,968 tok/s | 5,832 tok/s |
| Agent later turns | 219 ms | 253 ms |
| Six turns end to end | 8.4 s | 7.9 s |
| Six-chat rotate | 32.0 s | 27.1 s |

An attached draft model drops decode from 155 to 74 tok/s, so it stays opt-in.
Why: n-gram speculative decoding, `--no-cache-idle-slots`, `--cache-reuse 256`.
Source: [#218](https://github.com/nekko-labs/nekko-agent/pull/218),
[benchmarks](benchmarks.md).

### #217 Speed contract, PF1-PF5 (2026-09-30)
Area: renderer. Result: improvement
Conditions: Ryzen 9 9950X3D, Edge 154, Windows, back to back vs main; p95 (p50)

| Metric | Before | After |
|---|---|---|
| Composer keypress to paint | 87.5 (75.2) ms | 6.3 (4.8) ms |
| Frame work at 300 tok/s | 52.2 (32.3) ms | 2.7 (1.5) ms |
| Warm chat switch | 1,564 (1,438) ms | 5.3 (4.8) ms |
| Cold switch, first frame | 36.4 (16.2) ms | 7.9 (7.2) ms |
| Cold switch, newest screenful | 1,442 (1,391) ms | 31.2 (26.1) ms |

`content-visibility: hidden` alone took warm switch "from ~7 to ~5 ms". The
first harness numbers were wrong and were redone. Last CI run vs the 2x gate:
composer 16.2/16.7, warm 14.1/16.7, cold frame 15.7/16.7, cold history 89.0/200.
Why: `useShallow` selectors, a windowed transcript, incremental markdown, a
`sessions:summaries` channel and an 8-chat LRU (~24 MB).
Source: [#217](https://github.com/nekko-labs/nekko-agent/pull/217).

### #215 nekkod and a terminal that keeps up (2026-09-30)
Area: engine daemon. Result: improvement (sub-ms idle cost)
Conditions: desktop app, Windows, RTX 5090 box

| Metric | Before | After |
|---|---|---|
| Keypress to frame while printing 40 MB, p95 / max | 7.6 / 10.9 ms | 7.1 / 7.4 ms |
| Longest frame during that flood | 20.9 ms | 4.4 ms |
| Idle echo (cmd) p50 | 0.5 ms | 0.8 ms (worse) |

ghostty-web measured 27.3 ms p95 under the same flood, so it stays experimental.
Why: 8 ms output coalescing and flow control in `nekko-term`, xterm on WebGL.
Source: [#215](https://github.com/nekko-labs/nekko-agent/pull/215).

### #196 The Nekko engine (2026-09-16)
Area: local inference. Result: new capability

Qwen3 4B Q4_K_M at 32k context: 7.94 GB measured vs 7.75 GB projected; 162-292
tok/s; cold load on demand 3.4 s.
Source: [#196](https://github.com/nekko-labs/nekko-agent/pull/196).

### #181 VRAM fit planner (2026-09-08)
Area: GPU/memory. Result: new capability

hermes-4-70b projected at 37.0 GB against 49.7 GB free (M1 Max 64 GB, LM Studio).
Source: [#181](https://github.com/nekko-labs/nekko-agent/pull/181).

## 2026-08

### #152 True tok/s (2026-08-28)
Area: local inference. Result: measurement fix
Conditions: M1 Max 64 GB, LM Studio, `qwen3.8-27b-uncensored-mlx`

| Metric | Before | After |
|---|---|---|
| Reported tok/s, same generation | 9 tok/s | 19 tok/s |

Why: tok/s was divided by the whole turn instead of generation time (1.80 s to
first token excluded). The model was never slow; we were reporting half its
speed. Source: [#152](https://github.com/nekko-labs/nekko-agent/pull/152).

## Unmeasured

Performance-motivated changes with no recorded numbers. Measure them if they
are ever revisited.

- #476 (2026-10-12) runtime control plane into nekkod: "No latency numbers".
- #463 (2026-10-12) voice into nekkod (PF14).
- #293 (2026-10-04) idle limits and retries: configuration only.
- #255 (2026-10-03) token-speed spikes fixed.
- #214 (2026-09-30) speed contract budgets (8 ms keypress to paint) written down.
- #102 (2026-07-25) CPU/memory/GPU/VRAM monitors: readings only.
- Commit `65a9d538` (2026-10-12) hidden perf browsers on Windows.
