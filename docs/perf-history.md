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

This is the canonical, cumulative Markdown source for future performance articles;
update an entry when final CI results arrive, not just when a PR is opened. Include
PR/commit links, hardware and workload, exact samples, what changed, what did not
improve, and the remaining question. Keep microbenchmarks, CPU-profile samples,
profiled diagnostics and full product gates separate. Do not infer causality from
single sequential runs or compare different machines as a time-series speedup.
Link durable reports where possible: CI artifacts can expire, so retain the key
numbers and conditions here even when raw traces are linked elsewhere.

## Native browser migration baseline (#752, 2026-10-17)

Area: perf harness / browser driver. Result: regression in initial sequential driver comparison, not yet an alternated causal measurement.
Conditions: Windows x64, unchanged revision `4fc3cc5c`, Playwright 1.63.0, Electron 44.7.0 / Chromium 152.0.7977.130, isolated hidden synthetic fixture, 1100x760 outer DIP, 20 fresh-chat navigation samples and 20 existing-page inspect samples. Nearest-rank percentiles.

| Metric (ms) | Before | After |
|---|---|---|
| Fresh chat navigation p50 | 71.4239 | 93.61859999999979 |
| Fresh chat navigation p95 | 89.70190000000002 | 103.96899999999994 |
| Warm inspect p50 | 0.916899999999714 | 1.1934000000001106 |
| Warm inspect p95 | 1.1640999999999622 | 1.3894000000000233 |

Source: [raw samples and Electron process memory](../reports/agent-browser/playwright-baseline.json). Cold means new driver/renderer, not new Electron process or flushed caches. The [experimental native v2 candidate](../reports/agent-browser/native-candidate-v2.json) passed the smoke suite but measured higher latency in both workloads. These sequential batches are not a causal speedup/regression estimate; no performance win is claimed. Screenshot was 1359x873 device pixels at OS scaling, viewport height 698 DIP. Candidate must match these conditions; native-child memory is not included in Electron metrics and needs separate collection.

### Matched alternating driver benchmark (2026-10-17)

Raw [four batches and exact memory snapshots](../reports/agent-browser/matched-benchmark.json), order PW/native/PW/native, 20 cold + 20 warm per batch (40 samples per driver/workload), same common fixture bundle, Electron 44.7.0 / Chromium 152.0.7977.130, 1100x760 DIP outer and 1359x873 screenshots, light theme. Runtime native `7ff28b02`, harness-only explicit driver switch/memory probe. Nearest-rank percentiles:

| Metric | Playwright before | Native after | Result |
|---|---:|---:|---|
| Cold chat navigation p50 ms | 66.36300000000006 | 93.87869999999998 | Slower native |
| Cold chat navigation p95 ms | 74.38070000000016 | 102.51769999999999 | Slower native |
| Warm inspect p50 ms | 1.006199999999808 | 1.1442999999999302 | Slightly slower native |
| Warm inspect p95 ms | 1.4304999999999382 | 1.4756999999999607 | Near-null tail; no win |
| Total working set bytes, batch 1 | 513273856 | 471531520 | Lower native snapshot |
| Total working set bytes, batch 2 | 515989504 | 471937024 | Lower native snapshot |

Memory totals include all Electron process metrics plus the native child (14,360,576 / 14,323,712 working-set bytes, 4,759,552 / 4,718,592 private bytes), exclude the PowerShell measurement process, and are one snapshot per warm batch—not unique committed memory or a long-run distribution. The common fixture bundle includes the baseline helper for both; production native main excludes Playwright. Two alternating batches are not randomized per-sample causal evidence. Cold is fresh chat driver/renderer, not whole-app startup; warm sub-ms deltas can be scheduler noise. Both drivers passed the same expanded actions/security fixture; screenshots await parent actual-pixel inspection. This is a latency/memory trade-off, not an across-the-board speedup.

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
- **A faster helper is not automatically a faster frame.** #544's streaming
  investigation, #594's baseline failure, #595's bounded excerpt scan (~6x
  microbenchmark improvement and fewer CPU samples, but no whole-frame win),
  and #597's independent status fix. This is an article thread about finding
  real avoidable work without mistaking it for resolution of the user-facing
  performance problem.

## 2026-10

### Phone Markdown parser: block tree, cached per segment (MD-1, 2026-10-25)
Area: renderer
Result: mixed
Conditions: microbenchmark, not the app. Docker `swift:6.1-noble` (x86_64, 32 cores) on a Windows 11 desktop, `swift test -c release`, three runs of one test. Input: a generated 500-line reply (10,560 characters) with headings, nested lists, numbered lists, inline styles and three 10-row tables. Before is the old line scanner (`MarkdownText.parse`, copied verbatim into the benchmark); after is `MarkdownParser`. Streaming: the text grown one character at a time, parsed at every 20th character (528 parses). Medians of 20 for the whole-text rows.

| Metric | Before (line scanner) | After (`MarkdownParser`) |
|---|---|---|
| One whole parse, median | 0.785 / 0.778 / 0.776 ms | 1.192 / 1.177 / 1.153 ms (`parse`) |
| Same text again | same as above (no cache) | 0.246 / 0.250 / 0.242 ms (`blocks`, segments cached) |
| Streaming, total for 528 parses | 209.6 / 206.1 / 205.9 ms | 78.3 / 76.7 / 76.2 ms |
| Streaming, per parse | 0.397 / 0.390 / 0.390 ms | 0.148 / 0.145 / 0.144 ms |

Why: the block tree (nested lists, tables) costs about 50% more than the flat scan for one cold parse, but `blocks` re-parses only the segment still being written, so a streaming reply costs less than half as much per token. Not measured: SwiftUI layout and `AttributedString` inline parsing, scrolling frame times on a device, and anything on iOS hardware. Source: the MD-1 PR.

### #1031 Native iOS CI: one build, dark mode only for colour changes (2026-10-24)
Area: dev build
Result: mixed
Conditions: GitHub-hosted macos-14 (3 vCPU), Native iOS on PR #1011's head e04ff824, old workflow (run 40131450126) against the new one in a batch (run 40138086476); main's live tests were failing in both, which dominates both runs' time.

| Metric | Before | After |
|---|---|---|
| `swift test` | 70 s | 70 s |
| cargo build of nekkod | 114 s | 133 s |
| Xcode build step | 118 s | 297 s (simulator booting beside it) |
| Simulator step start to first test | 248 s | 40 s |
| Build + time to first test | 366 s | 349 s |
| Whole job | 45.6 min | hit the 50 min timeout |

Booting the simulator in the background made whatever ran beside it slower: `swift test` 262 s instead of about 56 s and the cargo build 185 s when it booted from the job's start (run 40132995453), and nekkod never became ready beside the relay itest (run 40136579251). Net about 17 s, so the background boot was dropped; the single build stays. The larger saving is the dark live journey, which a PR now runs only when it changes colours (#1011 does, so both runs here ran it): on the last green run it was 5.2 min, on these failing runs 450 s and 684 s. Source: #1031.

### B2 Background replies pause for the user instead of unloading the model (2026-10-23)
Area: local inference
Result: improvement (a design choice made on measurements: pause, not unload)
Conditions: Apple M5 Max (40-core GPU, 128 GB), macOS, the app's engine llama-server b11224 with the engine's own flags (32k context, `--cache-reuse 256`, `--no-cache-idle-slots`), behind the nekko-infer router. Prompt of 3,267 tokens (Qwen3.5 4B Q4_K_M) / 3,269 (Gemma 4 12B Q4_K_M), page cache warm. Yield and paused resume: 7 samples each; unloaded resume: 5. `crates/nekko-infer/tests/yield_cost.rs`.

| Metric | Qwen3.5 4B | Gemma 4 12B |
|---|---|---|
| Yield: client hangs up mid-reply → no slot generating (median) | 22.1 ms | 35.0 ms |
| Resume, model kept loaded: prompt tokens processed again | 4 | 1 |
| Resume, model kept loaded: prompt time (median) | 16.0 ms | 26.3 ms |
| Resume after unloading: load (median) | 806 ms | 1208 ms |
| Resume after unloading: prompt tokens processed again | 3,267 | 3,269 |
| Resume after unloading: prompt time (median) | 911 ms | 2634 ms |
| Resume after unloading: total to first token (median) | 1724 ms | 3850 ms |

Gate cost (`crates/nekko-machine/tests/activity.rs`, `read_cost`): one look at the input past its 200 ms cache, median of 20, 7.2 µs (min 2.5 µs). The temperature read inside it runs every 10 s and took up to 105 ms (sysinfo's sensors), off the async threads. The first whole reading took 107.65 ms.

Not measured: the time from the user's real return to the stop. By design it is at most one 200 ms gate poll plus the 200 ms input cache on macOS and Windows (1 s cache on Linux, where input is a `loginctl` spawn), plus the hang-up above.

Why: a yielded request only needs its connection closed; llama-server keeps the prompt in the slot, so the resumed request re-reads 1 to 4 tokens instead of the whole prompt, and no reload is paid. Source: the B2 PR.

### A3a Engine router reads each reply's decode speed (2026-10-23)
Area: engine daemon
Result: no effect
Conditions: Apple M5 Max (40-core GPU), macOS, release build; `nekko-infer` router in front of a fake model server streaming 4000 SSE chunks with no pause, then llama-server's `timings` chunk; two routers in one process, one without a meter (the path on `main`) and one with, alternated, median of 15 replies, run three times (`cargo test -p nekko-infer --release --test router -- --ignored --nocapture meter_cost`)

| Metric | Without meter | With meter |
|---|---|---|
| 4000-chunk stream through the router, run 1 | 32.25 ms | 31.95 ms (-0.9%) |
| run 2 | 33.08 ms | 33.32 ms (+0.7%) |
| run 3 | 32.81 ms | 32.93 ms (+0.3%) |

Why: the meter keeps the last 8 KB of a chat or completion reply and parses `timings` once, after the last byte went to the client; the differences are inside run-to-run noise. A real reply has a few hundred chunks, not 4000. Source: the A3a PR.
### nekkod checkpoints, per-chat write locks, launch scan, joined deltas (2026-10-22)
Area: engine daemon
Result: mixed (launch, frames and the save itself faster; a turn's end-to-end timings unchanged; text gaps about 0.5 ms longer at 15 ms token spacing)
Conditions: Apple M1 Max, 10 cores, 64 GB, macOS 27.0.1; release `nekkod` built from `origin/main` (`58989ffb`) and from this branch in the same worktree, run alternately (base, branch) in three rounds; machine shared with other builds (load average 1.6 to 6.2 during the runs). `scripts/bench-chat-turn.mjs --fake`; medians per round, nearest-rank.

| Metric | Before (3 rounds) | After (3 rounds) |
|---|---|---|
| Spawn to `NEKKOD_READY`, 500 chats (36.2 MB, 3 marked mid-reply), median of 8 launches | 47.3 / 44.1 / 43.1 ms | 23.5 / 22.9 / 22.6 ms |
| Same, p95 | 48.8 / 45.7 / 44.3 ms | 23.7 / 24.3 / 23.2 ms |
| Fanout, 4 chats x 400 tokens 1 ms apart: agent frames per subscribed socket | 412 / 412 / 412 | 45.5 / 46 / 46.5 |
| Same, bytes per subscribed socket | 42471 / 42471 / 42471 | 7287 / 7335 / 7383 |
| Same, unsubscribed socket: frames / bytes | 1612 / 165852 (every round) | 146 / 25116, 148 / 25308, 150 / 25500 |
| Fanout, 4 chats x 200 tokens 15 ms apart: frames per subscribed socket | 212 / 212 / 212 | 201 / 202.75 / 204.5 |
| 5 MB chat (40 messages, 10 pictures of 512 KB), 8 runs: first text | 44.7 / 41.8 / 44.0 ms | 43.7 / 43.2 / 43.2 ms |
| Same: `chat:send` to approval prompt | 48.2 / 48.1 / 47.4 ms | 46.7 / 46.5 / 46.1 ms |
| Same: queue drain (`done` to the follow-up's first text) | 53.6 / 52.5 / 53.4 ms | 50.5 / 49.2 / 49.4 ms |
| Same: approve to `tool_result` | 16.1 / 9.7 / 9.6 ms | 15.7 / 9.7 / 9.0 ms |
| Same: text gap p50 / p95 (tokens 15 ms apart) | 17.0 / 18.1, 16.9 / 18.2, 16.9 / 18.0 ms | 17.5 / 19.2, 17.4 / 19.0, 17.4 / 19.2 ms (worse) |
| Small chat, 8 runs: first text | 7.1 / 6.8 / 7.2 ms | 7.3 / 6.9 / 6.1 ms |
| One checkpoint save (`save_turn`), 2.2 MB chat of 2,000 text messages, p50 of 60, 3 runs | 4.16 / 4.16 / 4.17 ms | 2.14 / 2.14 / 2.15 ms |
| Same, 5.0 MB chat of 40 messages and 10 pictures | 4.76 / 4.50 / 4.50 ms | 4.33 / 4.03 / 4.03 ms |

Why: launch parsed every chat to find the few marked mid-reply; it now byte-searches for `"activeRun"` and parses only matches. Text and reasoning deltas within 16 ms of the last one sent are joined into one event of the same shape, so a fast stream costs a frame per window rather than per chunk; at 15 ms spacing almost nothing joins and each token can wait up to the window's remaining ~1 ms, which is the gap regression. A checkpoint save no longer re-parses the whole chat from disk (only the fields outside the transcript are read back) or clones it to serialize, which halves the save of a long text chat; a picture-heavy chat is mostly long strings that parse and copy cheaply, so its save moved less. The save now also runs without the turn's chat lock held and a `step` is published before its save, but in the 5 MB bench the save is a few ms of a turn dominated by other work, so first text and approve-to-result did not measurably move. Not measured: per-chat write locks (two chats saving at once), sharing frames across sockets, replay outside the hub lock, settings reads without a copy. The save rows come from a throwaway harness linking `nekko-store` from each revision (not committed); the rest from `bench-chat-turn.mjs --ready 8`, `--fanout 4 --tokens 400 --token-ms 1`, `--fanout 4 --tokens 200`, `--runs 8 --history 40 --history-images 10`, and `--runs 8`. A text history of 2,000 messages started a compaction instead (a different workload), so it was not used for turn timings. Source: branch `perf/nekkod-checkpoints`.
### Code mode: tool definitions per model call (2026-10-22)
Area: engine daemon
Result: improvement (definitions only; per-session savings not yet measured)
Conditions: Linux container; the built-in tool catalog as `turn_tools` offers it to a new chat with no MCP servers; sizes are the JSON of the offered tool specs at the app's ~4 characters a token (`estimateTokens`), not a provider tokenizer

| Metric | Tool list | Code mode |
|---|---|---|
| Online chat: tools offered | 18 | 8 (12 behind `run_code`, 6 direct) |
| Online chat: definitions, tokens per model call | ≈2,664 | ≈1,855 (808 fewer) |
| Offline / Local only: tools offered | 14 | 6 (10 behind `run_code`, 4 direct) |
| Offline / Local only: definitions, tokens per model call | ≈1,874 | ≈1,432 (442 fewer) |

Why: code mode replaces the wrapped tools' schemas with `search_tools` and `run_code`, whose description carries a one-line index. The saving grows with every MCP server's tools, since each adds its full schema to the list but one index line to code mode. Not measured yet: results kept out of context in real sessions, and whether models finish tasks in fewer calls (T194e). Source: this PR (T194).

### #817 agent-browser builds: no forced rebuilds, a dev profile, a per-machine cache (2026-10-19)
Area: dev build
Result: improvement
Conditions: one Windows machine, 32 threads; single runs, cold and warm as labelled

| Metric | Before | After |
|---|---|---|
| agent-browser, `npm run dev` with nothing changed | recompiled every time (about 3 min, one core) | 0.4 s (cache hit) or 0.38 s cargo no-op |
| agent-browser, cold, dev | 3 min 21 s (`release`: fat LTO, 1 codegen unit) | 79 s (`nekko-dev`) |
| agent-browser, a new worktree | a full cold build each time | the cached binary, 0.4 s |
| nekkod `dev-daemon`, cold / after a one-file change | 1 min 53 s / 14 s | unchanged |

Why: upstream's `build.rs` rewrote a file it watched, so cargo saw the crate as dirty on every run; the build now writes that file first with a fixed old mtime, builds a `nekko-dev` profile without fat LTO for dev and CI, and caches the binary in the common git directory so every worktree reuses it. Not improved: each worktree still compiles nekkod's ~400 crates once (about 2 min). Source: [#817](https://github.com/nekko-labs/nekko-agent/pull/817).

### Agent browser: snapshot and element refs (2026-10-18)
Area: browser driver / agent context
Result: mixed (half the bytes the model writes and no locating script; more to read unless scoped; no time effect)
Conditions: same machine, build and fixture as the full-flow entry below, hidden-frame wake on, native driver. Three scripted strategies for locating the form, alternated sample by sample: `selectors` (evaluate a script listing controls, then CSS), `snapshot` (whole-page snapshot, then refs), `snapshot-scoped` (snapshot of `main`, then refs). 12 fresh processes, then 20 fresh-chat and 20 warm-session rounds per arm. Nearest-rank percentiles. Reply text excludes screenshot pixels; request is the JSON of the tool inputs.

| Fresh chat, per flow | selectors | snapshot | snapshot-scoped |
|---|---|---|---|
| Tool calls / retries | 10 / 1 | 10 / 1 | 10 / 1 |
| Reply text p50 | 6889 B | 11193 B | 6935 B |
| Request p50 | 986 B | 462 B | 512 B |
| Locate step p50 / p95 | 2.79 / 3.24 ms | 21.1 / 21.89 ms | 22.03 / 32.43 ms |
| Whole flow p50 / p95 | 465.22 / 475.69 ms | 424.18 / 466 ms | 435.32 / 489.66 ms |

Warm session, whole flow p50 / p95: 378.32 / 394.93, 357.1 / 399.45 and 348.48 / 414.72 ms. Why: a snapshot replaces a DOM-listing script the model would otherwise write, but a whole-page one lists every link (2,584 bytes once the form is there, against 559 for the evaluate); scoped to `main` it is 435 bytes. The snapshot takes about 20 ms against about 3, absorbed by the fixture's form API wait, so the flow-time differences are not an effect. Not measured: pages without ids or with custom controls, where refs should matter most; a live model choosing actions. Source: this PR, [report](../reports/agent-browser/snapshot-refs.md), [raw data](../reports/agent-browser/snapshot-refs.json).

### Agent browser: full-flow benchmark, startup phases, hidden-window frame wake (2026-10-18)
Area: perf harness / browser driver
Result: improvement (and a new measurement)
Conditions: Windows 11 10.0.26300, Ryzen 9 9950X3D (32 threads), Electron 44.7.0 / Chromium 152.0.7977.130, native agent-browser 0.39.1 (pinned), hidden 1100x760 window, synthetic signup app (`scripts/agent-browser-flow-fixture.mjs`). Each flow is navigate, locate (list controls, wait and retry once because the form renders after a 120 ms API call), fill twice, click submit, wait and extract the confirmation, screenshot: 10 tool calls through the real bridge, no model. Before and after are the same build with the wake off and on (`wakeFrames`), alternated sample by sample: 12 fresh processes (6 first flows each), then 20 fresh-chat and 20 warm-session rounds in one process. Nearest-rank percentiles.

| Metric (native) | Before | After |
|---|---|---|
| Whole flow p50 / p95, first flow in a new process | 3377.57 / 3418.12 ms | 484.72 / 612.5 ms |
| Whole flow p50 / p95, fresh chat | 3321.87 / 3345.81 ms | 466.29 / 489.61 ms |
| Whole flow p50 / p95, warm session | 3242.25 / 3260.74 ms | 388.44 / 404.39 ms |
| Click p50 / p95, fresh chat | 1001.11 / 1005.73 ms | 10.86 / 13.5 ms |
| Screenshot p50 / p95, fresh chat | 1905.49 / 1918.75 ms | 37.66 / 56.07 ms |
| Tool calls / retries per flow | 10 / 1 | 10 / 1 |

Startup on a fresh chat's first request, measured by the new `onTiming` phases (with wake, p50 / p95): window 35.54 / 37.22 ms, relay 1.01 / 1.18 ms, native spawn to ready 17.47 / 19.72 ms, CDP attach 6.45 / 7.82 ms, navigate 24.93 / 26.65 ms, summary 1.29 / 1.6 ms. Startup was never the problem. A warm session's navigate step was 17.14 ms p50 against 101.02 ms fresh (no window, relay, process or attach, and the HTTP cache served JS and CSS: 3 requests instead of 5); the rest of the flow cost the same either way.

Why: once a hidden window goes idle it renders about one frame a second, measured in a bare `BrowserWindow` with no driver; `backgroundThrottling: false` and Chromium's background/occlusion switches did not change it. A click's input is acknowledged on the next frame (about 1 s) and the native screenshot waits two frames (about 2 s). A frame subscription held only for a click or screenshot on a hidden tab keeps frames coming; the window stays hidden. Playwright cross-check (4 launches, 10 rounds): without the wake 0 of 24 flows finished (`page.screenshot: Timeout 10000ms exceeded.` every time, clicks 1008 to 2010 ms); with it 24 of 24, fresh-chat flow 628.84 / 709.81 ms. Native smoke screenshots before and after differ in 21 pixels, a 1x21 caret column. Not measured: macOS, Linux. Tool calls and reply bytes did not change; that is the snapshot/refs work. Source: this PR, [report](../reports/agent-browser/flow-benchmark.md), [raw data](../reports/agent-browser/flow-benchmark.json).

### nekkod's real-binary tests split by domain, sleeps replaced by waits (2026-10-18)
Area: dev build
Result: no effect on wall time (the layout that would have split binaries: regression, not taken)
Conditions: Windows, local, Rust 1.96.0, debug test profile, worktree's own `target/`. Base `origin/main` ba6c006a (unchanged `daemon.rs`, run from a second worktree with its own target dir) vs this branch, same machine, back to back. "Clean package" is `cargo clean -p nekkod` then `cargo test -p nekkod --no-run` (dependencies stay built). Full run is `cargo test -p nekkod` with everything built, wall time from the shell.

| Metric | Before | After |
|---|---|---|
| `cargo test -p nekkod`, 3 runs (s) | 20.07, 19.26, 19.25 | 19.20, 19.12, 19.21 |
| `daemon` test binary's own time, 3 runs (s) | 8.60, 8.38, 8.44 | 8.31, 8.28, 8.34 |
| `--no-run` after `cargo clean -p nekkod`, 2 runs (s) | 24.32, 24.17 | 25.21, 25.45 |
| `--no-run` after touching one test file (s) | 7.11 (`daemon.rs`) | 2.74, 2.56 (`daemon/turns.rs`) |
| First split: 11 test binaries, `cargo test -p nekkod`, 1 run (s) | 19.3 (median above) | 32.0 |

Why: `cargo test` runs test binaries one after another, so eleven binaries added up each file's slowest test (`runs_the_model_server_itself` 7.4 s, a training run 4.4 s, the image turn 2.6 s, ...) instead of overlapping them; the split kept one binary (`tests/daemon/main.rs`) with a module per domain. The waits poll every 10 ms instead of sleeping 20 to 300 ms, which does not move the total because the slowest tests wait on product timers (engine health polls, the goal run's 4 s pause). Source: this PR.

### Slowest TypeScript unit tests made faster without losing assertions (2026-10-18)
Area: dev build
Result: improvement (server.test.ts: no effect, left alone)
Conditions: Windows, local, Node 24.1.0, Vitest 5.0.3, Git 2.51.0.windows.2. Per file: `npx vitest run <file> --reporter=json` from its package dir, 3 runs each, median of the file's start-to-end time from the JSON report. Whole package: one run each of `npx vitest run` in `packages/host` and `packages/core`, span from the JSON report. Base `origin/main` 75e8b29a vs this branch, same machine, back to back.

| File (median of 3, s) | Before | After |
|---|---|---|
| host `chat-worktrees.test.ts` | 12.38 | 9.16 |
| host `hooks.test.ts` | 10.43 | 2.93 |
| core `agent/loop-retry.test.ts` | 6.00 | 0.01 |
| host `workflows.test.ts` | 4.87 | 2.83 |
| host `engine/server.test.ts` (unchanged) | 10.47 | 10.50 |
| `packages/host` whole suite, 1 run | 19.2 | 15.9 |
| `packages/core` whole suite, 1 run | 7.2 | 5.1 |

Why: `loop-retry` waited out real 0.5 to 2 s backoffs; it now runs them on a fake `setTimeout` and still asserts the delays the loop reports. The hung hook slept 10 s against a 1 s limit; on Windows killing `cmd.exe` leaves the `node` grandchild holding the pipes, so the test lasted the full sleep. It now sleeps 2.5 s (the 1 s limit is the product's minimum and is unchanged). `chat-worktrees` builds one committed repository per file and copies it per test, turns off auto maintenance (44 `git maintenance run --auto` processes, 3.2 s in a trace2 profile), and commits in the merged-PR test's six worktrees in parallel. Workflow pass/fail steps are `exit 0`/`exit 1` instead of a `node -e` start. Under the full parallel host run, the merged-PR worktree test took 5548 ms (timed out at 5 s) before and 4721 ms after, so it keeps a 15 s timeout. `server.test.ts` is dominated by product constants (400 ms health poll, 800 ms progress sampling, a stub that listens after 2 s); changing them needs a product seam, so it is unchanged. Remaining question: the merged-PR test is still about 70 git processes, mostly in product code (`worktree add`, `status`). Source: this PR.

### Root `npm test`: one Vitest run over the eight workspaces (2026-10-17)
Area: dev build
Result: improvement
Conditions: Windows 11, 32 logical CPUs, Node 24.1.0, Vitest 5.0.3, warm (dists prebuilt, same worktree, back-to-back), 4 runs each with run 1 counted as warm-up. Measured twice: against base `origin/main` a47aa4c9, then again after rebasing onto ba6c006a (#758's faster unit tests, the entry above). Every segment of the old chain was run even when one failed (the known local env failures below would otherwise short-circuit `&&`).

| Metric | Before | After |
|---|---|---|
| Root `npm test` wall time, runs 2-4, base ba6c006a | 40.4 s / 40.5 s / 40.7 s | 24.7 s / 24.7 s / 25.0 s |
| Run 1 (warm-up), base ba6c006a | 40.5 s | 24.7 s |
| Root `npm test` wall time, runs 2-4, base a47aa4c9 | 45.5 s / 44.7 s / 45.5 s | 26.7 s / 26.9 s / 26.8 s |
| Vitest test files / passed / failed / skipped (both bases) | 441 / 3289 / 11 / 3 (sum of 8 runs) | 441 / 3289 / 11 / 3 (one run) |

Before, per segment (base ba6c006a, run 2): `node --test` 0.4 s, shared 1.5 s, core 5.7 s, desktop 6.7 s, cloud 2.6 s, host 15.4 s, server 2.5 s, relay 1.7 s, cli 3.8 s. Host's 18 s is mostly a handful of slow files, which the separate run left a mostly idle machine behind; in one pool the other seven packages fill the remaining workers. The 11 failures are the same files in both (host `session-clear.daemon` needs a built nekkod; desktop `bundleExternals` and `relay-bundle` need an electron-vite `out/`). On CI (`ubuntu-latest`, 4 vCPU), the `build` job's `npm test` step took 52 s and 77 s on this PR's two runs (39089216574, 39089690050; the second differs only in this docs file), against 68 s in merge-group run 39088658410, whose head 1846258f already includes #758. Shared-runner noise dominates at this sample size, so CI shows no clear win yet; the local result above is the measured one. In both PR runs, `perf` found `build`'s `web-dist` artifact (5.9 MB) in 1-2 s and downloaded it in 1-2 s instead of running `build:web` (30 s in full run 39087429992). Why: eight sequential `vitest run` processes (each starting Vite, transforming shared deps and spinning up its own pool) became one, with a root `vitest.config.ts` whose `test.projects` are the packages. Source: this PR.

### CI gates recalibrated from 115 runner reports; #544 closed (2026-10-17)
Area: perf harness
Result: measurement fix
Conditions: GitHub `ubuntu-latest` (AMD EPYC 7763, 4 threads), Chrome 155, `--attempts 3 --no-gpu`; the 115 `perf-report` artifacts still retained from 2026-10-15 to 17, almost all from PRs that did not touch the renderer

45 of the 115 reports failed after three attempts: warm switch 44 times, streaming frame work 23, cold-switch frame 18. Composer keypress never failed but came within 1 ms of its gate. A gate that fails 40% of healthy runs blocks unrelated PRs and tells their authors nothing, so each gate moved to the worst best-of-three p95 seen on these builds plus about 10% (Philip's call).

| Metric (best-of-3 p95, ms) | Median | p90 | Max | Gate before | Gate after |
|---|---|---|---|---|---|
| Composer keypress | 18.8 | 21.2 | 24.0 | 25 | 27 |
| Terminal keypress | 6.1 | 6.8 | 7.9 | 20.8 | 20.8 |
| Streaming frame work | 9.4 | 10.9 | 12.7 | 10.4 | 14 |
| Warm switch | 19.3 | 24.1 | 27.1 | 20.8 | 30 |
| Cold-switch frame | 24.4 | 26.4 | 30.7 | 26 | 33 |
| Cold-switch history | 24.4 | 26.4 | 30.7 | 250 | 250 |

Replayed against the same reports: 45 failures become 0, and runs needing a second attempt drop from 81 to 6. Product targets (8.3 ms, 4 ms, 100 ms) are unchanged; this moves the regression tripwire, not the goal. The streaming-frame hotspot work in #594/#595 stays open as a product problem, not a CI one. The job now runs in the merge queue for changes it can measure, so a regression stops before `main` rather than on every PR. Source: this PR; numbers from `scripts/perf/budgets.mjs`'s comment.

### Chat scroll bounce under reduced motion (2026-10-16)
Area: renderer
Result: improvement (scroll correctness; frame times unchanged within noise)
Conditions: Windows, local, hidden off-screen Electron window 1100x720, synthetic 120-turn chat (about 56,000 px tall), 60 wheel notches up then 140 down at 16 ms, positions sampled once per rendered frame; `prefers-reduced-motion: reduce` emulated via CDP. Base `main` 8137d54a vs this branch, one run each, dark / light.

| Metric (reduced motion) | Before | After |
|---|---|---|
| Frames where visible content moved against the wheel, up pass | 33 / 32 | 0 / 0 |
| Pixels moved against the wheel, up pass | 5534 / 5596 | 0 / 0 |
| Frames where visible content moved against the wheel, down pass | 30 / 29 | 0 / 0 |
| Distance left to the bottom after scrolling down | 245 px / 245 px | 1 px / 1 px |
| Frame p95, up pass | 8.4 ms / 4.3 ms | 4.3 ms / 4.3 ms |

With reduced motion off, both builds measured 0 backward frames and reached the bottom (1 px). Why: the global reduce-motion rule set `transition-duration: 0.01ms` on `*`, which transitioned every property including the transcript's spacer padding; it is now `0s`. Source: the PR that adds `apps/desktop/scripts/transcript-scroll-integration.cjs`.

### #597 Completion-status fix: continuing baseline frame investigation (2026-10-16)
Area: renderer
Result: no performance improvement established (correctness fix, baseline diagnostic failure)
Conditions: same CI runner for the paired three-second profiled diagnostics, Linux / AMD EPYC 9V74 (4 threads), Chrome 155.0.8059.39, no GPU, 1440x1000, 1,000-message chat, 300 tokens/s. These short diagnostic measurements are not interchangeable with the six-second unprofiled gate.

| Metric | Before (unchanged base) | After (#597 diagnostic) |
|---|---|---|
| Streaming frame p95, profiled diagnostic | 14.0 ms | 11.8 ms |

Full head gate best p95 was **11.3 ms** across **12.2 / 11.3 / 12.1 ms** attempts, still above **10.4 ms**; all other speed/memory rows and non-performance CI checks passed. This is not evidence that status reconciliation speeds up streaming: one sequential pair, instrumentation and runner variation prevent that attribution. The change fixes contradictory Done/interrupted notices, not the frame-cost root cause. No budget changed; #544 remains open.

Sources: [PR #597](https://github.com/nekko-labs/nekko-agent/pull/597), merge `8be677fa`, [CI run](https://github.com/nekko-labs/nekko-agent/actions/runs/38835173427), [reports/traces artifact](https://github.com/nekko-labs/nekko-agent/actions/runs/38835173427/artifacts/12019456830), [#544 follow-up](https://github.com/nekko-labs/nekko-agent/issues/544#issuecomment-6206132883).

### #595 Bound streaming activity excerpt scans (2026-10-16)
Area: renderer
Result: mixed (excerpt microbenchmark improvement, no whole-frame improvement established)
Conditions: Windows, Ryzen 9 9950X3D, Node 24.1.0; microbenchmark 100,000 long-text calls per lap after warmup, five laps. Browser: headless Chrome 153.0.8010.12, TS host, no GPU, 1440x1000, 1,000-message chat, 300 tokens/s, isolated production web builds of base d9c2f11a and optimized source. One unprofiled six-second trace and one profiled three-second diagnostic per build.

| Metric | Before | After |
|---|---|---|
| Excerpt benchmark, ms per 100,000 calls (five laps) | 557.13 / 567.28 / 560.85 / 552.2 / 583.76 | 106.51 / 97.79 / 94.12 / 93.13 / 93.37 |
| Streaming frame p95, six seconds | 5.2 ms (305 frames) | 5.6 ms (329 frames) |
| Streaming frame p95, three seconds with CPU profiling | 6.3 ms (148 frames) | 6.5 ms (152 frames) |

Why: scan only enough normalized text for the excerpt plus lookahead, instead of normalizing the entire 2,000-character tail per text event. Outputs match the previous algorithm in 10,000 seeded differential cases. Saved CI profiles from #594 show compactSentence as the top named application self-time, but this local frame comparison does not establish a frame win. No budget changed; #544 remains open. Source: `scripts/bench-compact-sentence.mjs`, local `.shots/perf-head`, `.shots/profile-head`, and matching `stream-activity-base` reports/traces. This behavior-preserving refactor has no visual change and does not change SPEC requirements.

Final Linux CI follow-up: AMD EPYC 9V74 (4 threads), Chrome 155.0.8059.39, no GPU, same-runner base/head three-second profiled streaming diagnostics, 1440x1000, 1,000-message chat, 300 tokens/s. Base is unchanged `d9c2f11a`; PR head is `6f908f34`, merged as `a8e64e88`.

| Metric | Before (base diagnostic) | After (head diagnostic) |
|---|---|---|
| Streaming frame p95 | 13.8 ms | 13.9 ms |
| compactSentence CPU self-time samples | 106 | 15 |

The named helper's sampled cost fell, consistent with the microbenchmark, but the frame result is effectively unchanged and both diagnostics fail **10.4 ms**. CPU sample counts are not elapsed milliseconds or a controlled total-CPU percentage. Full six-second head gate best p95 was **12.0 ms** across **12.1 / 12.0 / 13.2 ms** attempts; all other speed/memory rows and non-performance checks passed. There is no matching unprofiled full-gate base result in this run, so do not subtract its full result from either profiled diagnostic. The excerpt optimization landed; the frame-budget problem did not close.

Sources: [PR #595](https://github.com/nekko-labs/nekko-agent/pull/595), [CI run](https://github.com/nekko-labs/nekko-agent/actions/runs/38833610415), [matched reports/profiles artifact](https://github.com/nekko-labs/nekko-agent/actions/runs/38833610415/artifacts/12018727601), [#544 results](https://github.com/nekko-labs/nekko-agent/issues/544#issuecomment-6205949101). Local benchmark reproduction: `node scripts/bench-compact-sentence.mjs`. Next: attribute the remaining script/render/style/layout/paint cost in the saved frame traces, then verify any further candidate under the unchanged gate.

### #594 Streaming baseline failure identifies an excerpt hotspot (2026-10-15)
Area: renderer investigation
Result: baseline diagnostic failure; optimization candidate identified, no runtime improvement claimed
Conditions: same Linux runner/browser for matched three-second profiled diagnostics, AMD EPYC 7763 (4 threads), Chrome 155.0.8059.39, no GPU, 1440x1000, 1,000-message chat, 300 tokens/s. Unchanged base `7c71ff25`; head diagnostic `6b9cf5e3`.

| Metric | Before (base diagnostic) | After (head diagnostic) |
|---|---|---|
| Streaming frame p95 | 11.50 ms | 12.19 ms |

Full head best p95 was **10.6 ms** across **10.6 / 12.0 / 10.8 ms** attempts, over the unchanged **10.4 ms** limit. All other speed/memory rows passed. The baseline diagnostic also failed; this does not establish zero incremental impact from #594 or provide an unprofiled full-gate base comparison. Both saved CPU profiles identified `compactSentence` as the largest named application self-time hotspot, motivating #595. #594 itself changed nav wings and creation/Focus controls, not that helper. Keep the independent UI work distinct from the later optimization.

Sources: [PR #594](https://github.com/nekko-labs/nekko-agent/pull/594), merge `d9c2f11a`, [CI run](https://github.com/nekko-labs/nekko-agent/actions/runs/38780176028), [reports/traces artifact](https://github.com/nekko-labs/nekko-agent/actions/runs/38780176028/artifacts/11995992713), [#544 investigation](https://github.com/nekko-labs/nekko-agent/issues/544#issuecomment-6198906006).

### CI gates for streaming frame and cold-switch frame raised ~4% (2026-10-15)
Area: perf harness
Result: measurement fix (budget decision, no code speed change)
Conditions: GitHub `perf` job (Ubuntu, 4 vCPU, no GPU), the runs quoted below

| Metric | Before | After |
|---|---|---|
| Streaming frame-work CI gate (p95) | 10 ms | 10.4 ms |
| Cold-switch frame CI gate (p95) | 25 ms | 26 ms |

Why: Philip's decision. The streaming row failed on unchanged `main` at random: run 38710979506 (1dfe0e60) measured p50 7.6 / p95 10.1 / max 11.8 ms over 175 frames, while run 38706570615 (a88c1f9b) passed (#544 lists more). The cold-switch row: PR #578's run 38719225639 measured p95 per attempt 26.3 / 25.4 / 25.7 ms, while main runs 38704916823 and 38710979506 measured 23.1 / 23.5 / 23.2 and 22.7 / 22.8 / 23.4 ms. So the new gate admits #578's change without resolving whether it slows a cold switch by 2-3 ms; that comparison is still open on #578. Product targets (4 ms, 8.3 ms) are unchanged. Source: this PR.

### CI cache and stale-run optimization (2026-10-15)
Area: CI build. Result: baseline measured; post-change savings unverified.
Conditions: GitHub-hosted runners, one successful CI run [38608506782](https://github.com/nekko-labs/nekko-agent/actions/runs/38608506782), step timestamps from the Jobs API.

Baseline: required Linux build job 220 s, uncached debug daemon build 86 s; perf job 388 s, release daemon build 89 s, speed contract 250 s; Windows daemon job 450 s, cargo tests 232 s. These are observations from one run, not controlled before/after measurements.

Changes: cache the required debug Rust build; cancel superseded PR runs only; give the app and relay Docker builds distinct BuildKit cache scopes. Keep every test, platform and performance budget unchanged. npm caching and current Action major versions are already present. Cache-miss versus warm-cache timing and actual runner-minute savings remain to be measured after hosted runs. No visual or application behavior change.


### Android reconnect on network change (2026-10-14)
Area: mobile app
Result: improvement
Conditions: headless Android emulator (Pixel_10_Pro AVD, API 37.2) on an Apple Silicon Mac, debug sandbox build, local relay on the host, airplane mode toggled with `cmd connectivity airplane-mode`, time from airplane-off until the app's banner read "online" polled through uiautomator (adds ~0.5–1 s to every reading).

| Metric | Before | After |
|---|---|---|
| Back online after 8 s offline (3 runs) | 6.3 s, 6.3 s, 6.3 s | 4.1 s, 4.2 s, 4.2 s |
| Back online after 40 s offline | 21.5 s, 26.6 s | 4.4 s, 4.6 s, 4.7 s |

Why: a default-network callback now redials as soon as a network is back, instead of waiting out the client's exponential backoff (up to 30 s). Source: the Android background-connection PR.

### #514 Current-main gate and checkout attribution repair (2026-10-13)
Area: renderer, perf harness. Result: failed gate remains unresolved; measurement provenance fix, no measured runtime improvement.
Conditions: run 38382178477, job 115245050089, Ubuntu / AMD EPYC 7763 (4 threads), Chrome/154.0.8037.97, production web + optimized release nekkod, 1440x1000, no GPU, 1,000-message chat, 300 tokens/s. Logs establish actual head checkout `b4b976650cc99f9cef333fb5bea23794c879c76b` (07c18568 merged into bdd75023) and unchanged base `bdd75023c313f4cad206851c75f52136558f512a`. All reports inherited the merge GITHUB_SHA, including base. The harness now records actual APP_ROOT `git rev-parse HEAD` as `git` and inherited SHA separately as `workflowGit`, with source archives reported unknown and unit coverage. This changes attribution only, not sampling or budgets.

Full six-second gate: stream p95 **10.48 / 10.48 / 10.6 ms** across three attempts, all fail unchanged **10 ms**. Selected row: p50 **7.86 ms**, p95 **10.48 ms**, p99 **12.69 ms**, max **12.7 ms**, mean **8.03 ms**, **193 frames**, **26%** busy. Other selected p95 rows pass: composer **18 ms**, terminal **6.2 ms**, warm switch **15.6 ms**, cold frame/history **22.7 ms**. Memory passes: clipped-layer ratio **0**, tiles **189.7024688720703 MB**, heap **0.023772239685058594 MB/lap**, nodes/listeners **0/lap**. Selected rows are best per metric, not one common attempt; raw samples in the report are not necessarily the selected attempt.

Sequential head then base diagnostics use one three-second `--quick --only frames --profile --timeline` measurement each, required release daemon on both. The head additionally retains `--dump-trace`; unchanged base does not support that retained-trace option, but both contain profile traces. Exact JSON values (base -> head): p50 **9.38 -> 8.72 ms**, p95 **13.09 -> 12.02 ms**, max/p99 **102.67 -> 124.46 ms**, mean **10.48 -> 10.11 ms**, frames **87 -> 93**, busy **30% -> 30%**. Both fail. The head/base order is important: head is 12.02, not 13.09. These single profiled short samples prove a diagnostic miss on base, not an unprofiled full-gate baseline or causal improvement.

CrRendererMain trace duration totals in ms, base -> head (nested spans overlap): FunctionCall **206.850 -> 208.105**, FireAnimationFrame **98.044 -> 100.545**, Paint **143.881 -> 154.795**, UpdateLayoutTree **117.638 -> 122.032**, Layout **70.010 -> 71.693**, PrePaint **62.524 -> 65.781**, Layerize **65.119 -> 64.100**. Paint counts **1134 -> 1141**, layout **138 -> 148**, style **177 -> 198**, rAF **88 -> 94**. Largest renderer tasks **95.487 -> 116.576 ms** contain DevToolsSession receives **95.473 -> 116.565 ms**, consistent with instrumentation overhead; the command is not identified, so profiler-start attribution is not proven. No gate samples are excluded.

CPU self samples: idle **2025.384 -> 2013.009 ms**, program **955.207 -> 994.087 ms**, compactSentence **10.588 -> 12.771 ms**, ws.onmessage **7.158 -> 5.737 ms**. Shared script/render/layout/paint work persists on both. Avoidable excerpt compaction remains a candidate, not evidence that notification scope causes the miss or that removing it would pass. No speculative renderer fix, benchmark rerun or threshold relaxation was made. Next: matched full-duration timeline-only baseline/head measurements on a suitable runner to separate instrumentation from sustained work, then unit-backed causal optimization and the unchanged hosted gate.

Sources: [run](https://github.com/nekko-labs/nekko-agent/actions/runs/38382178477), [artifact 11803884737](https://github.com/nekko-labs/nekko-agent/actions/runs/38382178477/artifacts/11803884737), downloaded `.shots/perf-07/` JSON, traces and CPU profiles, `.shots/514-perf-latest.log` (untracked). No new before/after runtime measurement exists for the attribution repair.

### #514 Matched Linux release-daemon streaming attribution (2026-10-13)
Area: renderer, perf harness. Result: existing baseline diagnostic failure; full gate still failed, no improvement established.
Conditions: Actions run 38375945871, PR head `99ddc95a8648e3e8c9d9fbdf9c118684a8140e47`, Ubuntu shared runner, AMD EPYC 7763 (4 threads), Chrome/154.0.8037.97, 1440x1000, GPU disabled, 1,000-message chat, 300 tokens/s. Logs verify the full gate and head diagnostic actually checked out merge `34dcf477897f258cca86eeb0931c1be58eab4d6f` (head into base `76c2db7be45182e69b8ffd9cfd7838b3b641e770`). The base worktree log says `HEAD is now at 76c2db7 Fix composer overflow and compact live subagent activity (#515)`. Both builds finished the optimized release profile and both diagnostics logged `engine: nekkod`. The base JSON's `git: 34dcf477...` is inherited GITHUB_SHA, not its actual checkout.

Full gate: three 6s attempts, stream-frame-work p95 **10.35 / 10.85 / 11.22 ms**, all fail the unchanged **10 ms** gate. Best row p50 **7.8 ms**, p95 **10.35 ms**, max **13.53 ms**, mean **7.96 ms**, n **198**, main-thread busy **26%**. The Markdown rounds this p95 to 10.3 ms. Other final speed rows pass: composer p95 **20.8 ms** (attempts **20.8 / 25.5 / 25 ms**, so one attempt fails); terminal **6.1 ms** (6.1 / 6.5 / 6.6); warm switch **15.9 ms** (22.7 / 15.9 / 15.9, first attempt fails); cold first frame and history each **22.3 ms** (24.9 / 22.3 / 23.9). Memory rows all pass: worst clipped layer **0**, compositor tiles **197.31 MB**, retained heap **0.08 MB/lap**, DOM nodes **0/lap**, listeners **0/lap**. These final rows select the best attempt per metric, not a single all-passing attempt.

Matched diagnostics: head then base, one 3s `--quick --only frames --profile --timeline --dump-trace --no-gpu` run each, release daemon, all other contracts skipped. Exact JSON measurements:

| Metric | Base 76c2db7b | Merge head 34dcf477 |
|---|---|---|
| Stream frame work p50 | 9.66 ms | 9.1 ms |
| Stream frame work p95 | 14.8 ms | 13.2 ms |
| Stream frame work max | 108.18 ms | 105.37 ms |
| Stream frame work mean | 11.08 ms | 10.51 ms |
| Frames | 89 | 92 |
| Main-thread busy | 32% | 31% |

Both diagnostics fail. This proves a failure exists on the current base under diagnostic conditions, not that the unprofiled full-gate miss is entirely baseline or that head improved performance. Single sequential samples, profiling overhead, 3s versus 6s windows and different fixture history prevent causal subtraction; no base full-gate measurement is supplied.

Streaming trace main-thread duration totals, base -> head (ms, nested spans overlap and must not be summed): FunctionCall **226.541 -> 214.243**, FireAnimationFrame **100.165 -> 103.502**, Paint **160.962 -> 155.548**, UpdateLayoutTree **125.467 -> 122.904**, Layout **76.579 -> 77.041**, PrePaint **69.414 -> 66.857**, Layerize **82.252 -> 77.948**. Paint events **1154 -> 1125**, layout events **141 -> 146**, style events **186 -> 190**, rAF callbacks **90 -> 93**. Shared script/rAF and rendering work dominates the actionable categories, not a new head-only callback. Largest RunTask **100.604 -> 98.307 ms** contains a **100.593 -> 98.297 ms** `blink.mojom.DevToolsSession` receive; this is consistent with profiler/CDP overhead, but the trace does not identify the command, so attribution to Profiler.start/stop is not proven. Do not interpret the ~105-108 ms frame maxima as established product stalls.

CPU self samples are mostly `(program)` (**1071.275 -> 1007.955 ms**) and `(idle)` (**1923.729 -> 1973.734 ms**), not attributable JS functions. Largest named JS self sample is `compactSentence` (**6.382 -> 12.232 ms**), followed by `ws.onmessage` (**5.628 -> 6.608 ms**), with React traversal, streaming tick and stick-to-bottom/resize callbacks also present. `liveRuns.ts` folds subagent activity for every event, and `subagentActivity.ts` recompacts a bounded 2,000-character text tail on every text delta even for ordinary chats. That is avoidable candidate work, but already exists in this base (#515), is not the dominant total cost, and does not prove it causes the gate miss.

Why/attribution: comparing verified base to PR head shows no change to ChatPane, liveRuns, subagentActivity, store or daemon turn streaming. Notification visibility subscriptions are Electron-only; the browser policy is moved without a new streaming renderer loop. Grid/picker changes are outside this single-chat fixture. Usage-summary changes are not shown to run per text delta. The harness change retains an already collected trace after tracing ends and hides Windows server children; the full Linux gate sampling/budgets are unchanged. No measured head-specific causal regression is established, and the original gate remains a release blocker, not ready.

Cheapest next steps: fix report provenance to record actual `git rev-parse HEAD` separately from workflow GITHUB_SHA; analyze existing per-frame trace intervals to locate style/layout/paint roots and exclude identified DevTools tasks only in an explanatory diagnostic, never silently in the gate. A focused unit-backed candidate is avoiding repeated child-activity excerpt compaction for ordinary non-child streams while preserving child-event behavior. It cannot be claimed to resolve this miss without measurement. Before a broader renderer fix, an authorized later timeline-only matched full-duration base/head diagnostic would distinguish profiler artifacts from sustained rendering cost; no benchmark was rerun here, no budget changed, and no sensitive native desktop probe was touched.

Sources: [Actions run 38375945871](https://github.com/nekko-labs/nekko-agent/actions/runs/38375945871), full checkout/build/diagnostic job logs and local untracked `.shots/ci-99-failed.log`, `.shots/perf-99/perf-report.{json,md}`, `.shots/perf-99/profile-{base,head}/{perf-report.json,trace.json,streaming.cpuprofile}`. Read-only artifact analysis; no commits or push.

### #514 Background notifications and panels: failed gate investigation (2026-10-13)
Area: renderer, perf harness. Result: mixed (diagnostic latency comparison; stream failure attribution unresolved)
Conditions: same GitHub Actions `ubuntu-latest` perf job, AMD EPYC 7763
64-Core Processor (4 threads), Linux, 16 GB RAM, headless Chrome/154.0.8037.97,
web production build with release `nekkod` (confirmed in both diagnostic logs),
1440 x 1000 viewport at device scale 1. Base and head diagnostics used identical
`--quick --only latency --profile --timeline --no-gpu` options, one attempt each,
a scripted 300 tokens/s reply of 7,000 tokens, a 1,000-message chat and twelve
400-message chats, 40 composer keys at 45 ms spacing, 30 terminal keys, 10 warm
switches and one cold cycle (11 samples). Head ran first, then base after its
separate dependency install and production/release builds; these are sequential
profiled diagnostics, not simultaneous or unprofiled full-gate measurements.

Before is actual unchanged base `bf494d77a57655c51b4c32030c826e4acae837fc`.
After is CI merge `8d339052ba01d220341fce4ee767cdcb3676e018`, merging PR head
`7f19d0768b4353b272080b938af08ae80715f73d` into that base. Both diagnostic JSON
reports incorrectly label `git` with the merge SHA: `run.mjs` records inherited
`GITHUB_SHA`, not the worktree revision. The CI checkout/worktree logs establish
the actual base; its release daemon build succeeded, with no engine fallback.

| Metric (diagnostic latency) | Before (base) | After (head merge) |
|---|---|---|
| Composer keypress p50 / p95 / max, n=40 | 13.5 / 26.6 / 30.4 ms | 14.6 / 22.5 / 27.9 ms |
| Terminal keypress p50 / p95 / max, n=30 | 5.1 / 5.9 / 6.1 ms | 4.8 / 6.7 / 6.8 ms |
| Warm switch p50 / p95 / max, n=10 | 16.4 / 21.6 / 21.6 ms | 18.9 / 23.8 / 23.8 ms |
| Cold frame/history p50 / p95 / max, n=11 | 25.3 / 28.9 / 28.9 ms | 26.6 / 29.5 / 29.5 ms |
| Browser frame wake p50 / p95 | 0.2 / 0.5 ms | 0.3 / 0.6 ms |
| Stream main-thread frame work | Not measured (`--only latency`) | Not measured (`--only latency`) |

Why: #514 moves Electron native notification ownership into main and changes
wall picker/usage panels. The diagnostics are mixed: base composer p95 misses
25 ms; both warm-switch p95 values miss 20.8 ms and both cold-frame p95 values
miss 25 ms. Cold-history p95 passes its separate 250 ms gate. These misses on
unchanged base support pre-existing latency sensitivity, not a clean pass or
proof that the changed renderer has no regression. Matching CPU profiles and
timeline traces show common React/rendering work: typing `renderWithHooks` self
time is 19.2 ms on each; warm-switch Paint totals are 956.3 / 953.4 ms and
cold-switch Paint totals 1106.3 / 1110.6 ms (base/head). These are whole diagnostic
trace totals with nested events overlapping, not per-frame gate measurements.
No clear new changed-code hotspot was established. Electron main/preload paths
are not exercised by the web gate; the new picker is conditional on opening it,
while shared renderer/usage changes remain plausible indirect contributors.

The original full gate in run **38359023328 remains failed**. Its only failed
row is stream main-thread work at 300 tokens/s: p50 7.9 ms, p95 **11.0 ms**,
max 38.0 ms, n=189 over 6s, against a **10 ms CI gate** (4 ms SPEC target).
All three attempt p95 values miss: **11.5 / 11.2 / 11.0 ms**. Other full-gate
p95 values pass: composer 20.1 ms, terminal 6.2 ms, warm switch 16.8 ms,
cold frame/history 24.4 ms; all memory checks pass. The latency-only diagnostics
skip this failing metric and contain no dedicated streaming profile/trace, so
they cannot establish whether its overrun exists on unchanged base.

Later run **38360444132**, PR head `0f35af4c9187ccc0dbca7c597fd488357d4cd38a`
(CI merge `876c817` into the same base), has a **successful perf job**, not a
successful overall CI run (build and macOS daemon jobs failed). Its logs report
the same CPU/thread count, Linux, browser, daemon and full-gate command
`--attempts 3 --no-gpu`; it stopped after two measurements and reports each row's
best attempt. Stream p95 was **10.3 / 9.6 ms**, with selected p50 7.4 ms,
p95 9.6 ms, max 46.4 ms, n=193. Selected p95 values: composer 19.1 ms,
terminal 5.7 ms, warm switch 15.4 ms, cold frame/history 23.1 ms. The intervening
commit changes only native-notification verification/setup scripts, not runtime
renderer or perf code. This supports run variability as a plausible explanation,
not a measured causal improvement or retroactive pass for the earlier run.

Limitation / next action: attribution of the original stream overrun remains
unverified. If investigating further, measure the unchanged base and failed head
with matching full streaming conditions, including the vsync-paced browser,
and retain dedicated streaming traces/profiles for both. Do not substitute the
quick latency diagnostics, relax budgets, or rerun blindly to erase the failure.
No new benchmarks were run for this investigation.
Source: [#514](https://github.com/nekko-labs/nekko-agent/pull/514),
[failed run 38359023328](https://github.com/nekko-labs/nekko-agent/actions/runs/38359023328),
[latest perf job](https://github.com/nekko-labs/nekko-agent/actions/runs/38360444132/job/115173108735),
and its preceding run's saved `.shots/perf-prev/perf-report.{md,json}`,
`profile-base/` and `profile-head/` reports, CPU profiles and timeline traces.

### #516 Group drag fix: CI latency diagnostics (2026-10-13)
Area: renderer / perf harness. Result: inconclusive, mixed diagnostic results.
Conditions: GitHub Actions Ubuntu shared runner, CI run 38378954525 attempt 1. Same-run head/base diagnostics used `--quick --only latency --profile --timeline --no-gpu`; 40 composer samples, 10 warm switches, 11 cold switches. Profiling differs from the full gate, so these are not proof of a regression or improvement.

| Diagnostic p95 metric | Unchanged base | PR head |
|---|---|---|
| Composer keypress to paint | 22.0 ms | 25.1 ms |
| Warm chat switch | 26.8 ms | 22.3 ms |
| Cold chat frame painted | 28.4 ms | 26.4 ms |

The full head gate's best streaming frame-work p95 was 10.4 ms against a 10 ms gate (198 samples). The latency-only base diagnostic skips this metric, so no matched base number is available. Both base and head diagnostics missed warm/cold switch budgets. A single failed-job rerun was requested to distinguish runner variability; no budgets were relaxed. The group-drag change does not alter streaming logic, but causality remains unverified. Source: [PR #516](https://github.com/nekko-labs/nekko-agent/pull/516), [CI logs](https://github.com/nekko-labs/nekko-agent/actions/runs/38378954525/job/115234283340).

### #512 Transcript identity lookup and failed stream diagnostics (2026-10-13)
Area: renderer, perf harness. Result: improvement (projection), hosted failure unresolved
Conditions: Windows, Ryzen 9 9950X3D, Node 24.1.0; projection benchmark uses 1,000 alternating messages, 100 warm-up batches then 1,000 samples of ten folds each. Streaming uses HeadlessChrome/151.0.7922.34, mandatory release nekkod built from this branch (same daemon for all three renderer variants), 1440x1000, no GPU, 300 tokens/s, six seconds, one run per variant.

| Metric | Main base 76c2db7 | Original head a4e4fd1 | Set lookup |
|---|---|---|---|
| Projection p50 | 0.08179 ms | 0.18688 ms | 0.10798 ms |
| Projection p95 | 0.09720 ms | 0.21491 ms | 0.15754 ms |
| Streaming frame work p50 | 2.93 ms | 3.54 ms | 2.95 ms |
| Streaming frame work p95 | 4.68 ms | 5.36 ms | 5.19 ms |
| Streaming frames | 359 | 348 | 354 |

Why: the Q/A display-only classification scanned the entire history with `includes` for each row. One identity Set removes that quadratic work without changing rows or persisted/model history. Local streaming passes do not establish a hosted fix or statistical significance. No visual change; no spec update needed for this behavior-preserving optimization.

Hosted run 38376729418 on Linux EPYC 7763 / Chrome 154 recorded streaming p95 **10.98 ms**, attempts **10.98 / 11.17 / 11.14 ms**, against the unchanged **10 ms** gate (194 frames, p50 8.19 ms, p99 11.92 ms, max 11.99 ms). Its uploaded base/head diagnostics skipped streaming (`--only latency`), so no comparable hosted baseline exists. Those profiler-on latency figures are not the failing metric. Reuse #514's diagnostic approach: profile `--only frames` on head and unchanged base, require release nekkod on both, and preserve the original gate result. Do not attribute the whole failure to projection overhead without those profiles.

Sources: [#512](https://github.com/nekko-labs/nekko-agent/pull/512), [failed hosted job](https://github.com/nekko-labs/nekko-agent/actions/runs/38376729418/job/115226874290); local `.shots/bench-{base,before,after}.json` and `.shots/stream-{base,before,after}/perf-report.json` (untracked). Normal Playwright Chromium failed CDP startup locally; dedicated headless shell supplied the matched measurements. Owned failed-launch process trees and scratch profiles were cleaned up.

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

### #439 Local Web UI behind nekkod (2026-10-11)
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

- CI scoped to what a change touches (2026-10-24): before, measured on #1023 (two Swift UI test files with `ci:macos`, CI run 40133900216, CodeQL run 40133900149): `daemon (macos-latest)` 274 s, `capture (macos-latest)` 289 s, `build` 147 s, CodeQL Rust 281 s, JS/TS 102 s, Python 42 s, Actions 43 s, Swift 799 s. After: per the scope rules and their tests, the same change runs only CodeQL Swift of these; no CI run of a native-only PR under the new rules has been measured yet. Update with that run's numbers.

- Focus surface refinement (2026-10-24): removed navigation SVG path/clip animation and ResizeObservers, retaining only width and text-opacity reveal. Focus corners reuse native CSS squircle with rounded fallback, without added masks or blur. CPU/GPU/frame times before and after: not measured. No zero-cost or smoothness claim; collect matched renderer traces to quantify the effect.

- Focused panel motion: navigation morph shortened to 180/160 ms and backdrop/text blur removed. These are configured durations, not measured frame times. Before and after CPU, GPU, energy and frame-time cost: not measured. Collect matched renderer traces before claiming a performance improvement.

- **Native agent-browser default feasibility (2026-10-17).** Candidate `agent-browser@0.39.1` (native Rust, Chrome), Nekko base `2f81bfc0`, Windows / Node `v24.1.0`. Migration blocked before runtime edits: the native command daemon accepts unauthenticated loopback JSON outside Nekko's approval bridge. Two diagnostic clients received `success: true` for `session_info` without credentials; these are security probes, not performance samples. No browser was launched. **Before: not measured. After: not measured.** No latency, memory, warm/cold distribution or speedup is established. Playwright remains explicitly required. [Exact provenance, raw outputs, reproduction and matched benchmark acceptance criteria](../reports/agent-browser/feasibility.md). Next: secure native command IPC, then collect at least 20 interleaved cold/warm samples with the same browser revision, viewport, theme and synthetic fixture before claiming any effect.

Performance-motivated changes with no recorded numbers. Measure them if they
are ever revisited.

- nekko/b1-run-policies (2026-10-23) the task scheduler holds a due task it will not fire (paused, or waiting for idle) until its next 15 s look, rather than picking it again on every turn of its loop: before, a task held by "Pause all automations" was re-read with the settings about every 50 ms (the loop's floor) for as long as the pause lasted. CPU and file reads before and after: not measured.
- fix/wire-parity-ci-cache (2026-10-15) pin `Swatinem/rust-cache` in the required `build` job to the v2.9.2 commit: no behavior change to the cache itself, so no number was taken; the two `build` runs after #555 (38690470032, 38691683502) both started from an empty `ci-build` cache (`No cache found`) at 234 s and 230 s, against 187 s and 220 s uncached before it, so the warm-hit saving is still unmeasured.
- #476 (2026-10-12) runtime control plane into nekkod: "No latency numbers".
- #463 (2026-10-12) voice into nekkod (PF14).
- #293 (2026-10-04) idle limits and retries: configuration only.
- #255 (2026-10-03) token-speed spikes fixed.
- #214 (2026-09-30) speed contract budgets (8 ms keypress to paint) written down.
- #102 (2026-07-25) CPU/memory/GPU/VRAM monitors: readings only.
- Commit `65a9d538` (2026-10-12) hidden perf browsers on Windows.

### #514 Current-head streaming diagnostic gap (2026-10-13)
Area: renderer, perf harness. Result: regression gate failure; attribution unresolved.
Conditions: Actions run 38363888450, PR head bdaa164c merged into bf494d77 as 9a22b4e, Ubuntu shared runner, headless Chrome/154.0.8037.97, release nekkod, three full attempts.

The full gate reports stream-frame-work p50 8.5 ms, p95 **10.7 ms**, max 14.0 ms, n=190 over 6s at 300 tokens/s (27% main-thread busy). All attempt p95 values **10.7 / 10.9 / 11.4 ms** miss the unchanged **10 ms** gate. Other full-gate rows pass. This is not a passing result.

Downloaded perf-report and profile-base/profile-head evidence confirm both followup diagnostics ran only latency, not streaming. Their warm/cold misses cannot attribute this stream failure. The diagnostic workflow now profiles frames on base and head and requires release nekkod without fallback; the original full-gate failure remains failed. No diagnostic rerun or measured improvement is claimed. Next: inspect the next pushed-head streaming profiles and compare base/head frame costs before proposing a renderer fix. Source: https://github.com/nekko-labs/nekko-agent/actions/runs/38363888450

### #514 Focused stream attribution and trace retention (2026-10-13)
Area: renderer, perf harness. Result: no renderer regression demonstrated locally; Linux daemon gate unresolved.

Conditions: exact archived renderer sources bf494d77 (base) and bdaa164c (head), same locally built eca9a8ad TS web backend and installed dependencies (React 19.3.0), Windows Ryzen 9 9950X3D, Playwright headless-shell HeadlessChrome/151.0.7922.34, 1440x1000, GPU disabled, fresh isolated data/profile per run, 1,000-message chat, 300 tokens/s, one 6s timeline-only run each, base then head. These are renderer-only comparisons, not matching release-daemon/Linux CI reproductions or evidence of an improvement.

Base -> head stream-frame-work: p50 **5.91 -> 5.33 ms**, p95 **8.62 -> 7.5 ms**, max **13.33 -> 9.41 ms**, n **360 -> 359**, mean **5.99 -> 5.39 ms**, main-thread busy **36% -> 32%**. Both local runs pass the unchanged 10 ms gate. Nested timeline totals (overlap, do not sum): PrePaint **710.361 -> 609.158 ms**, FunctionCall **652.865 -> 616.895 ms**, FireAnimationFrame **591.110 -> 559.302 ms**, Paint **269.503 -> 254.664 ms**, UpdateLayoutTree **142.965 -> 116.157 ms**, Layout **133.403 -> 122.311 ms**. Both exhibit the same pre-paint/script/rAF/paint/style/layout costs; no new head-only cost is identified. ChatPane, store and scripts/perf have no base-to-bdaa diff. Notification changes add no Electron visibility subscription in the web path; wall picker changes do not render in this chat fixture. This does not prove the original CI miss is baseline: its full run had 190 frames, Chrome 154, release nekkod and slower Linux runner.

Measurement fix: frames is a valid selector, but its existing trace was discarded unless --dump-trace was supplied; --timeline alone saved nothing. Save that already collected trace as streaming.trace.json for --timeline/--profile. Add --dump-trace to both CI diagnostics so the unchanged base harness also retains trace.json. Keep full-gate command, sampling, budgets and failure intact. Hide the perf server child on Windows. An initial full Chromium launch failed with an exited launcher and replacement processes; cleaned up only those owned scratch-profile trees, then used the installed headless shell. No samples from that failed attempt. No foreground app or user data used.

Evidence (local, untracked): .shots/perf-stream-local/{base,head}-timeline/perf-report.json and streaming.trace.json, comparison.json and build/run logs. Next: matched Linux release-daemon base/head stream traces with this retained attribution before claiming baseline or fixing product code.
PR #516 follow-up: run 38378954525 attempt 2 passed Ubuntu daemon tests but streaming frame-work p95 remained 10.32 ms (three attempts: 10.32 / 10.44 / 11.01 ms), against 10 ms. The gap spacer was replaced with animated group padding, removing the idle DOM element entirely while retaining the insertion geometry. This is a cost-removal candidate, not a measured improvement; new-head CI must verify it.

PR #516 padding candidate (a6c8d43f), run 38385871207, Linux EPYC7763/Chrome154: full-head streaming p95 **10.20 ms**, attempts **10.20 / 11.11 / 10.95 ms** (198 frames, p50 7.84 ms). Matched profiled 3-second streaming diagnostics: head p95 **11.54 ms**, base **13.02 ms** (93/96 frames, p50 9.05/9.01 ms). Both fail the unchanged 10 ms gate. CPU profiles are dominated by unattributed/native program time (987.761/990.768 ms); named/anonymous JS self time is99.475/103.749 ms. These diagnostics do not establish causality or a fix. Add --dump-trace to existing head/base diagnostics because CPU profiles alone cannot attribute style/layout/paint; --timeline did not save a streaming trace. No budgets changed.

PR #516 trace follow-up, CI38388615665: profiled head/base streaming p95 11.6/12.4 ms,93/95frames,3seconds300tok/s, Intel Xeon Platinum8573C/Linux/Chrome154. Saved traces show document-root non-partial layout with1203 objects on both. Head/base trace duration sums: Paint152.724/151.262 ms, UpdateLayoutTree116.003/118.212 ms, Layout77.419/76.672 ms. Nested trace sums are not disjoint CPU totals. Shared baseline rendering work confirmed; invalidation cause and corrective optimization remain unverified. Gate unchanged.

### Explicit wall vacancy marker (2026-10-14)
Area: renderer. Result: removed observed unnecessary selector invalidation; overall performance inconclusive.
Conditions: Ryzen9 9950X3D32threads,Windows,HeadlessChrome151.0.7922.34,release nekkod,1000-message chat,300tok/s,6seconds,no GPU. Current-main a4d0039b plus experimental build. Unprofiled disabled/enabled transcript size-layout containment p95 5.9/6.5ms (342/321frames); rejected. Disable beam attribution probe4.9ms,ring paint containment5.7ms,transcript layer promotion5.1ms: single runs,not retained,not demonstrated optimizations.
Matched invalidation-tracked base/explicit vacancy-marker p95 6.8/6.1ms (341/357frames),p50 4.5/4.4ms,max19.5/20.2ms. Affected-by-:has invalidations134/0. Instrumentation adds overhead; single samples do not prove Linux-gate improvement. Marker replaces the exact empty-wall descendant selectors while retaining state semantics. No containment or beam change retained. Saved reports/traces .shots/stream-containment/{invalidation,explicit-empty}; expected static appearance unchanged,20matching Electron capture pairs byte-identical. Full gate pending.

Full local candidate gate (same hardware/browser/release daemon,no GPU): all budgets pass. Composer p95 7.8ms,terminal18.9ms,streaming5.4ms347frames,warm8.0ms,cold10.9ms. Layer ratio0.15x,tile memory206.61MB,heap slope0.06MB/lap,DOM/listener slopes0.00. This build predates the latest unrelated main visual refinements; final Linux CI remains the release criterion.

### Empty-agent dot texture and steady working cat (2026-10-25)

Issue: [#1157](https://github.com/nekko-labs/nekko-agent/issues/1157). Base `1935c659`. Removed the full-app canvas wave and composer/window border beams. Empty agents use a fixed 720×360 precomputed SVG image moved by stepped CSS transform; inactive windows/panels pause it. The aggregate working cat has a steady accent fill with no animation.

Matched diagnostic full-App fixture: macOS arm64, Electron 45, 1440×900 DIP, default dark chrome with supplemental Lilac wave, four synthetic empty agents (one visible Focus pane), hidden non-focusable isolated window, network blocked. Before/after sequential six-second CPU deltas, no full test/build running concurrently. The focused condition overrides `document.hasFocus` and dispatches a synthetic renderer focus event; no real desktop focus is taken. Raw `app.getAppMetrics().cpu.cumulativeCPUUsage` deltas:

| Condition | GPU-process CPU before → after (%) | Renderer CPU before → after (%) |
| --- | --- | --- |
| Unfocused empty | 2.8794867522079652 → 1.0229385307346324 | 1.8395434094317615 → 1.731884057971014 |
| Synthetic focused empty | 8.872568287808127 → 3.2341605596269134 | 8.273600932711526 → 8.454946702198532 |

These short single samples suggest lower GPU-process CPU overhead, **not measured GPU utilization, energy, or battery savings**. Renderer CPU did not improve in the synthetic focused case. No distribution, live user-profile A/B, or cross-platform performance claim is established. Earlier blank cross-worktree captures were rejected: the harness now aliases React consistently across the fixture and alternate source tree. Stub `getAppInfo` and installed/external skills lists are defined so final before/after runs have no console errors. Reproduce via `NEKKO_TEST_LABEL=<label> NEKKO_LAYOUT_SANDBOX=empty-agent-wave-sandbox.cjs node apps/desktop/scripts/layout-evidence-integration.cjs`, with `NEKKO_TEST_SOURCE=<base-worktree>` for base and `NEKKO_EXPECT_WAVE_NEW=1` for assertions on head. Local JSON reports and PNG/GIF frames are under ignored `.shots/layout-evidence/`; published media belongs in the PR, never git. A second sequential sample after texture edge fading (after first, then base; same six-second conditions) recorded GPU-process CPU unfocused 2.8918693768743755 → 0.7673163418290863%, focused 6.20781406197934 → 2.7728135932033955%; renderer CPU unfocused 2.4742919026991013 → 1.2345827086456764%, focused 5.300233255581473 → 7.023354989172079%. The focused renderer increase reinforces that this is not an across-the-board CPU win. These are separate diagnostic samples, not a statistical distribution.


After merging concurrent main changes (base `974ad4e8`, which already scopes the old canvas to clean-start), repeated against that newer base: unfocused GPU-process CPU 2.1987173080126605 → 0.8032784157097687%, renderer 2.3422955189072123 → 1.8271759028124495%; synthetic-focused GPU-process CPU 4.680159920039981 → 2.5662389601733047%, renderer 4.137214725970347 → 7.275287452091319%. Thus not all of the original global-wave reduction belongs to this PR alone. A `will-change: transform` experiment then recorded unfocused GPU-process/renderer CPU 0.6353882039320237/1.7538820393202272%, focused 2.8200766411196265/7.11802732422526%: no persuasive focused improvement, so the explicit promotion was reverted rather than retaining extra layer memory. Focused renderer overhead remains a verification limitation to profile with longer traces; no budget has been loosened.
