# Empty “Working” conversation investigation

## Finding and confidence

A reproducible bug independently of device sync can leave an empty live reply
with token statistics and no event left to stop it. This is a plausible cause of
the reported symptom, **not confirmation of the exact reported conversation**.
Live user data was outside the workspace sandbox and was not accessed.

1. `crates/nekko-harness/src/map.rs`: `Mapper::assistant` emits an `error` for an
   API error message. `Mapper::finish` later emits `usage` and deliberately does
   not repeat an already-shown error.
2. Previously `crates/nekkod/src/hub.rs` classified `usage` as streaming progress,
   created a new retained turn, and offered an accounting-only replay on reconnect.
3. Previously `apps/desktop/src/renderer/liveRuns.ts` allowed `usage` to create a
   run. It discarded the failed run and its text, then created a new empty one.
4. `ChatPane` adopts an existing run on mount. A reopened chat could therefore
   show only Starting/Working, token totals, and an indefinitely running clock;
   the phantom live run also suppressed persisted failure recovery.

## Fix

Usage enriches an existing run, but is not evidence that a new turn has started.
The daemon retains it only when a turn exists, without resuming a pending wait
or announcing a new running summary. The desktop does not create a run from it.
Real next-turn text, reasoning, tool activity, retry and compaction still start
runs. Active accounting and finished-reply handoff retain their existing behavior.
Provider billing and persisted usage logging are unchanged.

## Sync assessment and separate recovery gaps

`crates/nekko-cloud/src/lib.rs` checks the local busy callback before applying
incoming chat records; locally running chats are skipped. The merge uses the
session timestamp and a whole-record write for nonbusy chats. This inspection
does not prove all multi-device races impossible. No live two-device reproduction
or original-session event log was available.

Two separate code-inspection findings remain outside this focused fix:

- `ChatPane` awaits `sendChat` after setting its local streaming state without
  catching a rejected send in that path. A transport rejection may leave a local
  busy indicator. Reproduce a rejected send and reconcile against host state
  before implementing recovery; an accepted request with a lost acknowledgement
  must not be duplicated automatically.
- `wire.rs` reports `daemon:lagged` when a socket misses broadcast events; the
  preload only dispatches channels with listeners, and no lag listener was found.
  Reproduce dropped terminal events and implement ordered resynchronization,
  accounting for completed as well as still-running turns.

These are hypotheses for other stuck states, not proven causes of the screenshot.
Tracking: #2253.

## Verification

- New renderer regressions fail on the unchanged implementation (3 failures).
- New daemon regression fails on the unchanged hub (usage incorrectly starts a turn).
- Fresh isolated `npm ci --ignore-scripts`, shared/profile/CLI and desktop builds,
  desktop typecheck, then all **3,340 desktop tests in 360 files pass**.
- Daemon hub-filter run: 46 tests pass (includes GitHub-named runner tests matched
  by the substring filter); wire tests: 3 pass.
- Harness: 29 unit and 26 integration tests pass. Installed-provider smoke is
  intentionally ignored; no live provider request was made.
- Hidden, non-focusable Electron fixture uses a synthetic bridge, separate
  profiles, denied permissions and blocked network. Matched base `49f9b6310`
  and fixed captures at 1100×760 and 390×760, dark theme, show the prompt retained,
  no phantom Stop/run, saved failure and Retry visible, and real new progress
  still able to start a turn. Captures were visually inspected. Narrow captures
  are renderer coverage, not native iOS/Android device evidence.
- Matched short GIFs record the reopened state over several seconds. The
  synthetic elapsed clock is fixed at 540 seconds for deterministic comparison.
- `git diff --check`, focused hub rustfmt, sandbox syntax tests and spec validation
  pass. Whole-workspace rustfmt fails in unchanged sources, independently proven
  on the base revision and tracked in #2260; unrelated files were not reformatted.
- The fixture records the exact baseline ResizeObserver-loop diagnostic on both
  versions separately from unexpected errors (known baseline tracker #360).

## Limitations

No live original-chat, multi-device sync, native mobile, Windows or Linux UI run
was performed. No conversations or user settings were modified, and no claim is
made that every possible “Working” failure is fixed. Restarting into an updated
daemon clears any phantom hub state retained by an older daemon; the fix prevents
future accounting-only starts rather than mutating existing user records.
