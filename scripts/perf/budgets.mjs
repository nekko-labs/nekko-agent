/**
 * The speed contract's budgets, as p95 in milliseconds. The source of truth is
 * the table under "Speed & responsiveness" in SPEC.md; keep the two in step.
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
 * ms there, main 22.7-23.5 ms). `--strict`
 * (`npm run perf:strict`) judges against the targets themselves, for runs on
 * real hardware.
 */
export const BUDGETS = [
  { id: 'composer_keypress', label: 'Keypress to paint, chat composer, 1,000-message chat, reply streaming', target: 8.3, ci: 25 },
  { id: 'terminal_keypress', label: 'Keypress to paint, terminal', target: 8.3, ci: 20.8 },
  { id: 'stream_frame_work', label: 'Main-thread work per frame while a reply streams at 300 tokens/s', target: 4, ci: 10.4 },
  { id: 'warm_switch', label: 'Switch to a warm chat, to paint', target: 8.3, ci: 20.8 },
  { id: 'cold_switch_frame', label: 'Switch to a cold chat, frame painted', target: 8.3, ci: 26 },
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
  { id: 'gpu_overdraw', label: 'Worst animated compositor layer against the box that clips it, Grid wall of streaming agents', unit: 'x', budget: 2, measure: (m) => m.gpu.overdraw },
  { id: 'gpu_tiles', label: 'Compositor tile memory, Grid wall of streaming agents at 2x', unit: 'MB', budget: 320, measure: (m) => m.gpu.tileMb },
  { id: 'heap_per_lap', label: 'JS heap kept per lap of chat switches, after warm-up', unit: 'MB', budget: 2, measure: (m) => m.leak.heapMbPerLap },
  { id: 'nodes_per_lap', label: 'DOM nodes kept per lap of chat switches, after warm-up', unit: 'nodes', budget: 50, measure: (m) => m.leak.nodesPerLap },
  { id: 'listeners_per_lap', label: 'Event listeners kept per lap of chat switches, after warm-up', unit: 'listeners', budget: 20, measure: (m) => m.leak.listenersPerLap },
];
