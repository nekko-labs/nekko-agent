/**
 * The speed contract's budgets, as p95 in milliseconds. The source of truth is
 * the table in spec/platform/speed-responsiveness-the-speed-contract.md; keep the two in step.
 *
 * `target` is the product budget, met on a desktop at 120 Hz (8.3 ms is one
 * frame there). The GitHub `perf` job runs on a 4-vCPU runner with no GPU and a
 * 60 Hz display, where the same work takes about twice as long, so by default
 * a run is judged against `ci`, two and a half times the target: a regression
 * gate. At exactly twice, a healthy build's p95 sat at 94-104% of the gate
 * because the runner swings about 30% run to run, so the job went red at
 * random; at 2.5x it sits near 80% and still fails on the regressions it is
 * for (composer keypress was 87 ms before the speed work). By 2026-10-03 the
 * runner had the composer keypress and the cold-switch frame at 21-23 ms on
 * every attempt of every run, 100-110% of a 2.5x gate, while the same build
 * measured 8 ms and 12 ms on a desktop, so those two sit at 3x (25 ms); the
 * rest keep 2.5x. On 2026-10-15 Philip raised two gates by about 4%: the
 * streaming frame from 10 to 10.4 ms (main flapped at a p95 of 10.1-10.4 ms,
 * #544) and the cold-switch frame from 25 to 26 ms (#578 measured 25.4-26.3
 * ms there, main 22.7-23.5 ms).
 *
 * Recalibrated 2026-10-17 (Philip: "update it to a reasonable number"), closing
 * #544. 45 of 115 CI reports (2026-10-15 to 17, mostly unrelated PRs) failed
 * after three attempts: warm switch 44 times, streaming frame 23, cold-switch
 * frame 18; composer keypress never failed but sat at up to 24 of 25 ms. The
 * best-of-three p95 on those healthy builds ran to warm 27.1, streaming 12.7,
 * cold frame 30.7 and composer 24.0 ms, so each gate is now that maximum plus
 * about 10%: 30, 14, 33 and 27 ms. Replayed against the same 115 reports: 0
 * fail, 6 need a second attempt. The gates catch a regression of roughly a
 * third over today's median; trends below that are docs/perf-history.md's job.
 * The product targets are unchanged.
 *
 * Cold-switch frame recalibrated 2026-11-06 (issue #712), from 33 to 48 ms,
 * explicitly approved by Philip. No other gate or product target changes.
 * Since #1521 (2026-11-03) the harness measures the six-zone board the app
 * really shows, where a cold switch remounts a chat into the active zone
 * (#1998); the 33 ms gate had been set on a converted two-zone board. Over 778
 * CI reports from 2026-11-03 to 06 (mostly PRs that do not touch the
 * renderer) the best-of-three p95 had a median of 36.9 ms, p95 44.0, p99 46.9
 * and max 51.2 ms; 512 of them failed 33 ms. At 48 ms, 2 fail and 34 need a
 * second attempt. 48 ms is about a third above that median, the sensitivity
 * of the 2026-10-17 calibration, not that calibration's max-plus-10% (56 ms).
 * Lower it again with #1998. `--strict`
 * (`npm run perf:strict`) judges against the targets themselves, for runs on
 * real hardware.
 */
export const BUDGETS = [
  { id: 'composer_keypress', label: 'Keypress to paint, chat composer, 1,000-message chat, reply streaming', target: 8.3, ci: 27 },
  { id: 'terminal_keypress', label: 'Keypress to paint, terminal', target: 8.3, ci: 20.8 },
  { id: 'stream_frame_work', label: 'Main-thread work per frame while a reply streams at 300 tokens/s', target: 4, ci: 14 },
  { id: 'warm_switch', label: 'Switch to a warm chat, to paint', target: 8.3, ci: 30 },
  { id: 'cold_switch_frame', label: 'Switch to a cold chat, frame painted', target: 8.3, ci: 48 },
  { id: 'cold_switch_history', label: 'Switch to a cold chat, newest screenful of history painted', target: 100, ci: 250 },
];

/**
 * The memory contract: what the app may hold, measured once a run (counts
 * vary far less than timings). `measure` reads the figure from the memory
 * phase's result; a run fails when it is above `budget`.
 *
 * Calibrated 2026-10-10 (Grid wall, six agents streaming, 2x, SwiftShader):
 * - Overdraw: no animated layer is bigger than its clip today (0x). The beam
 *   that rotated an oversized square (fixed in #419) measured 9.6x, and it
 *   was ~70 MB of tiles per busy window on a real display.
 * - Tiles: 175-185 MB today; that beam put it at 265 MB. Chromium's tile
 *   budget is 512 MB, past which it logs "tile memory limits exceeded" and
 *   content stops drawing, so the gate holds well clear of it.
 * - Leaks: 0.2-0.5 MB of heap and no DOM nodes or listeners kept per lap.
 */
export const MEMORY_BUDGETS = [
  // Not a cost but a precondition: the GPU rows below mean nothing for a board
  // with fewer working windows than the phase set working.
  { id: 'gpu_board', label: 'Board windows not working when the GPU figures were read (of the six set working)', unit: 'windows', budget: 0, measure: (m) => m.gpu.wanted - m.gpu.working },
  { id: 'gpu_overdraw', label: 'Worst animated compositor layer against the box that clips it, Grid wall of streaming agents', unit: 'x', budget: 2, measure: (m) => m.gpu.overdraw },
  { id: 'gpu_tiles', label: 'Compositor tile memory, Grid wall of streaming agents at 2x', unit: 'MB', budget: 320, measure: (m) => m.gpu.tileMb },
  { id: 'heap_per_lap', label: 'JS heap kept per lap of chat switches, after warm-up', unit: 'MB', budget: 2, measure: (m) => m.leak.heapMbPerLap },
  { id: 'nodes_per_lap', label: 'DOM nodes kept per lap of chat switches, after warm-up', unit: 'nodes', budget: 50, measure: (m) => m.leak.nodesPerLap },
  { id: 'listeners_per_lap', label: 'Event listeners kept per lap of chat switches, after warm-up', unit: 'listeners', budget: 20, measure: (m) => m.leak.listenersPerLap },
];

/**
 * Report-only probes: measured on every run and printed in the CI summary, but
 * with no budget, so they cannot fail a run (a row here has no `budget`, `ci` or
 * `target`, and a test holds that). Added 2026-11-26 (#3374) to measure the
 * renderer and daemon optimizations that follow it. A probe becomes a budget
 * only through the recalibration rule above: from real runner samples, with
 * Philip's approval, in its own entry in docs/perf-history.md.
 *
 * `probe` is the phase that produces it (`--only <probe>`), `measure` reads the
 * figure from that phase's result, `digits` is how many decimals to print.
 */
const p95 = (xs) => (xs?.length ? [...xs].sort((a, b) => a - b)[Math.max(1, Math.ceil(0.95 * xs.length)) - 1] : null);
const med = (xs) => (xs?.length ? [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)] : null);
export const REPORT_ONLY_PROBES = [
  { id: 'long_stream_frame_p50', probe: 'long', label: 'Main-thread work per frame, 16 KB mixed-markdown reply streaming at 300 tokens/s: p50', unit: 'ms', digits: 2, measure: (m) => med(m.work) },
  { id: 'long_stream_frame_p95', probe: 'long', label: 'Main-thread work per frame, 16 KB reply streaming: p95', unit: 'ms', digits: 2, measure: (m) => p95(m.work) },
  { id: 'long_stream_frame_p95_last_third', probe: 'long', label: 'Main-thread work per frame, 16 KB reply streaming: p95 of the last third of the frames (the longest reply)', unit: 'ms', digits: 2, measure: (m) => p95(m.lastThird) },
  { id: 'concurrent_frame_p50', probe: 'concurrent', label: 'Main-thread work per frame in chat A (streaming) while chat B finishes turns: p50', unit: 'ms', digits: 2, measure: (m) => med(m.work) },
  { id: 'concurrent_frame_p95', probe: 'concurrent', label: 'Main-thread work per frame in chat A (streaming) while chat B finishes turns: p95', unit: 'ms', digits: 2, measure: (m) => p95(m.work) },
  { id: 'concurrent_frame_max', probe: 'concurrent', label: 'Main-thread work per frame in chat A (streaming) while chat B finishes turns: worst frame', unit: 'ms', digits: 2, measure: (m) => (m.work?.length ? Math.max(...m.work) : null) },
  { id: 'startup_fcp_p50', probe: 'startup', label: 'Cold profile: first contentful paint, median of the loads', unit: 'ms', digits: 0, measure: (m) => m.fcp.p50 },
  { id: 'startup_interactive_p50', probe: 'startup', label: 'Cold profile: main view interactive (rail and a board window on screen, a frame and a task later), median', unit: 'ms', digits: 0, measure: (m) => m.interactive.p50 },
  { id: 'startup_interactive_max', probe: 'startup', label: 'Cold profile: main view interactive, slowest load', unit: 'ms', digits: 0, measure: (m) => m.interactive.max },
  { id: 'renderer_js_bytes', probe: 'startup', label: 'Renderer production build: total JavaScript, raw', unit: 'KiB', digits: 0, measure: (m) => (m.build ? m.build.totalBytes / 1024 : null) },
  { id: 'renderer_js_gzip_bytes', probe: 'startup', label: 'Renderer production build: total JavaScript, gzip', unit: 'KiB', digits: 0, measure: (m) => (m.build ? m.build.totalGzipBytes / 1024 : null) },
  { id: 'renderer_js_loaded_bytes', probe: 'startup', label: 'Renderer JavaScript loaded by the time the main view is interactive, raw', unit: 'KiB', digits: 0, measure: (m) => m.loadedJsBytes / 1024 },
  { id: 'renderer_js_chunks', probe: 'startup', label: 'Renderer production build: JavaScript chunks', unit: 'chunks', digits: 0, measure: (m) => m.build?.count ?? null },
  { id: 'idle_hidden_renderer_main', probe: 'idle', label: 'Idle CPU, window hidden, no agent: renderer main thread', unit: '% of a core', digits: 2, measure: (m) => m.noAgent.rendererMainPct },
  { id: 'idle_hidden_agent_renderer_main', probe: 'idle', label: 'Idle CPU, window hidden, one agent running: renderer main thread', unit: '% of a core', digits: 2, measure: (m) => m.agent.rendererMainPct },
  { id: 'idle_hidden_agent_chrome_total', probe: 'idle', label: 'Idle CPU, window hidden, one agent running: whole Chromium process tree', unit: '% of a core', digits: 2, measure: (m) => m.agent.chromePct },
  { id: 'idle_hidden_agent_gpu', probe: 'idle', label: 'Idle CPU, window hidden, one agent running: GPU process', unit: '% of a core', digits: 2, measure: (m) => m.agent.gpuPct },
  { id: 'idle_hidden_agent_browser', probe: 'idle', label: 'Idle CPU, window hidden, one agent running: browser process', unit: '% of a core', digits: 2, measure: (m) => m.agent.browserPct },
  { id: 'idle_hidden_agent_server', probe: 'idle', label: 'Idle CPU, window hidden, one agent running: Local Web UI server and nekkod (stands in for the main process)', unit: '% of a core', digits: 2, measure: (m) => m.agent.serverPct },
];
