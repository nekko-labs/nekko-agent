# PR #516 stall diagnosis and prevention

## Outcome so far

The requested group-drag fix is implemented and functionally verified, but [PR #516](https://github.com/nekko-labs/nekko-agent/pull/516) remains unmerged. All latest checks pass except the streaming performance gate. No CI work is currently pending on the inspected head a6c8d43f. The user app and unrelated primary-checkout edits were not changed.

## Evidence

- Local merged-branch app build and desktop typecheck pass; 983 desktop tests, five syntax tests and 64 isolated Electron drag assertions pass.
- Latest hosted full-head streaming frame-work p95: 10.20 ms, against the unchanged 10 ms budget. Internal attempts: 10.20 / 11.11 / 10.95 ms.
- Same-run profiled streaming diagnostics: head p95 11.54 ms (93 frames), unchanged base p95 13.02 ms (96 frames), three seconds at 300 tokens/s. Profiling and shorter duration differ from the full gate; this is not proof of a speed improvement or no regression.
- CPU profiles mostly attribute time to the native/unattributed `(program)` bucket. Named JavaScript is only part of the workload. No saved streaming trace was available to attribute browser layout/paint work.
- The diagnostic workflow used `--timeline` but streaming traces are saved only by `--dump-trace` in `scripts/perf/run.mjs`.
- An unrelated Ubuntu router test hit an occupied ephemeral port; its single diagnosed rerun passed. A CodeQL harness finding was fixed. Main-branch conflicts were resolved. These are no longer current blockers.

Sources: [latest CI](https://github.com/nekko-labs/nekko-agent/actions/runs/38385871207), [performance job](https://github.com/nekko-labs/nekko-agent/actions/runs/38385871207/job/115257399228), `docs/perf-history.md`, local untracked `.shots/run-38385871207/` profiles and reports.

## Why this became a loop

1. Each bounded watch was treated as a fresh time budget rather than part of one investigation.
2. Completed failures were described as waiting, obscuring the real blocking condition.
3. Repeated diagnostics did not initially measure the failing streaming metric on base, then omitted the trace needed to investigate native rendering.
4. A small drag fix became entangled with baseline streaming-performance work. Removing idle spacer DOM was reasonable cost reduction, but did not resolve the gate and was not a measured fix.
5. New documentation commits and moving main restarted expensive checks and caused generated-doc conflicts.

## Prevention implemented in this follow-up

- Save streaming traces in both head/base failure diagnostics (`--dump-trace`). No thresholds or gate logic are changed.
- Add repository guidance requiring a cumulative investigation budget, no watches for completed failures, one diagnosed transient rerun, matching failing-metric evidence, and separation of baseline repair from a small feature.

## Recommended next action

Run one trace-producing diagnostic batch with the new workflow. Inspect the native rendering/layout/paint costs on head and unchanged base, then open a focused baseline performance repair if confirmed. Keep the drag PR unmerged until its gate passes. Do not keep re-arming watches without background work or a distinct experiment.

A product/policy alternative would be a deliberately reviewed baseline-aware regression policy, with an explicit tracked absolute-budget violation. That changes release policy and is not implemented or assumed authorized here. Raising budgets or overriding red checks is not a fix.

## Limitations

Physical OS dragging, packaged release behavior and macOS/Linux group-drag runtime checks remain untested. The synthetic Electron tests and inspected media prove renderer interactions, not native input behavior. No numerical performance benefit is claimed for the prevention changes.

## Trace batch outcome (run 38388615665)

All checks completed; only perf failed. Both requested streaming traces were successfully saved and inspected. Same-run profiled diagnostics on Intel Xeon Platinum 8573C, Linux, Chrome154: head p95 11.6 ms (93frames), unchanged base12.4 ms (95frames), three seconds300tok/s. Trace durations (not disjoint CPU totals): head/base Paint152.724/151.262 ms, UpdateLayoutTree116.003/118.212 ms, Layout77.419/76.672 ms, PrePaint70.901/69.644 ms. Paint samples include the full1440x1000 document and command-wall-layout; layout samples have document roots, partialLayout:false, totalObjects1203 on both. This establishes a shared broad rendering workload, not the specific invalidation cause or a proven drag regression/no-regression.

Next distinct work: use invalidation tracking to attribute document-wide layout/paint, test a scoped containment/render-update candidate on matching base/head, verify visual correctness, and pass the unchanged full gate. Keep this baseline repair separate from further drag changes. No additional automatic gate reruns or watches are scheduled for this completed failure.
