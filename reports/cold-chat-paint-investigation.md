# Cold-chat paint: investigation checkpoint

## Scope and status

Reduce cold-switch mount cost under the existing **33 ms** CI gate. Do not increase the gate or claim a Linux fix from macOS results. Production renderer source and performance budgets are unchanged at this checkpoint.

- Source: `bdd59fa3870f52e5dff3884308a782b14e372db6`.
- Primary tracking: [#1998](https://github.com/nekko-labs/nekko-agent/issues/1998), related [#712](https://github.com/nekko-labs/nekko-agent/issues/712).
- [#1999](https://github.com/nekko-labs/nekko-agent/pull/1999) proposes a gate recalibration, awaiting approval. This investigation does not adopt that proposal.
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

## Pending distinct experiment

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

## Known limitations

No production fix has been demonstrated, no repair PR opened, and no gate changed. Baseline screenshots do not verify a future candidate. A local YAML validation initially referenced the absent `yaml` package; validation subsequently passed with the already installed `js-yaml`, and GitHub accepted the workflow. Delegation failed before child creation due to invalid routing parameters; no child is running. Continue directly rather than silently assuming delegated work exists.
