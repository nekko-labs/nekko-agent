---
title: "Tool calls grouped by what they are for"
area: chat
---

# Tool calls grouped by what they are for

**User intent:** Philip asked (2026-10-25) that when an agent makes several tool calls, the chat should group them by what they are doing and tell the user the goal of each group. For example, reading the project's guidance (`AGENTS.md`, `CLAUDE.md` and the docs they point to) should be one group, separate from the coding calls. Tasks TG-1 to TG-6 in [TASKS.md](../../TASKS.md); issue #1075.

**Status `[implemented on the desktop and Local Web UI 2026-10-25; implemented on the iPhone and Android; native offline fixtures verified on simulator and emulator 2026-10-26]`.**

- **Shared classifier (TG-1): implemented.** `toolPurpose`, `toolGoal`, `purposeHeadline`, `summarizePurposes` and `groupByPurpose` in `packages/shared/src/tool-purpose.ts`, with the shared fixture `packages/shared/fixtures/tool-purpose.json` run by Vitest.
- **Desktop and Local Web UI (TG-2): implemented.** `activityRows` in `transcript.ts` splits an activity run into purpose groups, and `ActivityGroup.tsx` draws them (`PurposeGroupRow`) under a headline that summarises them. The Local Web UI serves the same renderer. Verified with unit tests and isolated renderer captures of the real `ActivityGroup` (`apps/desktop/scripts/tool-groups-integration.cjs`); not yet watched in a real Claude Code or engine run.
- **iPhone (TG-3): implemented, verified in an offline simulator fixture.** `ToolPurpose.swift` in `NekkoProtocol` ports the classifier and the grouping (`Purpose.group`, `Purpose.role(of:)`), and its tests run the shared fixture (passed on Linux in the Swift 6.1 image). `TranscriptRow.of` in `ChatView.swift` groups adjacent same-purpose rows into `PurposeGroupRow` (`AgentRowViews.swift`); a run of `spawn_agent` calls stays the subagent group, now as the Delegate purpose. A thought with no reply text between two same-purpose calls folds into their group; a reply ends it. Local native XCTest passed on an isolated iPhone 17 Pro simulator. Matched base/head screenshots and expand/collapse recording were captured and inspected for PR #1081; live relay and physical hardware remain unverified.
- **Android (TG-4): implemented; offline renderer interactions verified on an API 32 emulator, physical hardware unverified.** `ToolPurpose.kt` in `protocol` ports the classifier and the grouping; its tests run the shared fixture (pass locally). Tool blocks now carry their input. `ChatScreen.kt` groups the transcript and `PurposeGroupCard` (`BlockViews.kt`) draws a group as one card that opens to the tool cards. Debug APK assembly and protocol tests pass locally. The debug-only `PurposeEvidenceActivity` renders deterministic offline blocks through the real `Purpose.group`, `PurposeGroupCard` and `BlockView`; `PurposeEvidenceTest` passes on an isolated API 32 emulator and checks reveal/hide plus failure visibility. Matching base/head screenshots and expand/collapse recordings were captured at 1080×1920 in the default light theme. Pixel text was checked with OCR and interaction state with the UI hierarchy; matched screenshots and decoded recording frames were inspected and published on PR #1081. This does not verify pairing, a live relay, or physical hardware.

## What the user gets

- **Consecutive calls with the same purpose collapse into one row.** The row's headline says the goal in plain words, and a quiet detail line says what was touched:

  | Purpose | Headline | Detail |
  | --- | --- | --- |
  | Guidance | *Read the project's guidance* | `AGENTS.md`, `CLAUDE.md`, `landing-a-pr.md` |
  | Explore | *Looked through the code* | 6 files, 3 searches |
  | Edit | *Edited 4 files* | `Markdown.swift`, `ChatView.swift` +2 |
  | Check | *Ran the tests*, *Built the app* or *Ran the checks* | passed, or 2 failed |
  | Run | *Ran 4 commands* | the first command |
  | Git | *Committed and pushed*, *Pushed and opened a PR*, *Checked the changes* | the first command |
  | Web | *Searched the web* or *Read 3 pages* | the query or the sites |
  | Plan | *Updated the plan* | — |
  | Delegate | Subagent group, as today | — |
  | Other | *Used 2 tools* | the tool names, for MCP and unknown tools |

  A detail line names at most three things; more than that is the first two and *+N*. Each row opens to the individual calls, which look exactly as they do today, with their output wells. While a group is running, its headline is in the present tense with the running mark (*Reading the project's guidance…*). The headline switches to the past tense once the group ends.
- **Where the purpose comes from**, in order of preference:
  1. A `description` the call already carries is used as the goal. Claude Code's Bash, Task and similar tools send one. Some examples:
     - *Check existing issues, spec format, TASKS sections*
     - *Run the desktop tests*
     - *Install dependencies*

     When consecutive calls of one purpose carry different descriptions, the headline is the first one plus *and N more*. A description on an MCP tool is not used, because there it is often data (an issue body) rather than a goal, and neither is one longer than 120 characters or spread over several lines.
  2. Otherwise a **deterministic classifier** decides the purpose from the tool name and input:
     - Guidance files: `AGENTS.md`, `CLAUDE.md`, `README*`, `CONTRIBUTING*`, `SKILL.md`, `.cursorrules`, the Markdown under `docs/runbooks/`, `docs/decisions/` or `spec/` (or those folders themselves), and `.claude/`, `.cursor/rules/` and `.github/*.md` instructions. A checkout under `.claude/worktrees/` is ordinary code.
     - Read, list, grep and glob on other paths are Explore.
     - Write, edit and patch are Edit.
     - Shell commands are split into Check (test, lint, typecheck, build: `npm test`, `cargo test`, `pytest`, `go test`, `tsc`, `eslint`, `xcodebuild test`, `gradlew :protocol:test` and the like), Git (`git`, `gh`), Explore or Guidance when every part of the command only reads (`cat`, `ls`, `rg`, `Get-Content`), and Run (everything else).
     - Web tools are Web, and plan and todo tools are Plan.
     - MCP tools (`mcp__…`) and unknown tools are Other.

     It is a pure function with no model call and no added latency, and it costs no tokens.
  3. No call is ever hidden or merged with a call of a different purpose. A group is only ever a run of adjacent calls.
- **The desktop's activity group keeps its frame.** Its rows become purpose groups, and its headline summarises them by purpose, in the order each first appears: *Read guidance, looked through the code, edited 3 files*. Past four purposes it is the first three and *and N more*. This replaces *Worked on N steps*. While the turn runs, the headline is the newest row's goal in the present tense. When a call failed, the headline adds *1 failed*. The hover tip lists each group with its count.
- **Some calls are never folded into a group:**
  - a call waiting for approval, and any `ask_user` question, because these need the user
  - a group with a single call, which is shown as a plain row
  - on the desktop, delegations, watches and memory saves, which keep the rows they have today

  A failed call stays in its group, marks the group *1 failed*, and its own row is drawn in the failure colour. A group with a failure starts open, so the failure is not hidden after the turn ends.
- **Thoughts are visible inline in chat**, prefixed with the thought icon, during streaming and in saved conversations. They are not hidden inside collapsible tool rows. A thought splits the surrounding tool groups to preserve conversation order. This is a display-only projection of provider-supplied reasoning text; it does not create another persisted message, resend text to the model, or reveal private provider metadata. Narration remains ordinary chat text. Desktop and Local Web UI implemented; native phone changes are outside this update. Verification is tracked in issue #1138.
- **All four surfaces get the same groups:** the desktop, the Local Web UI, the iPhone and Android. The phones use the same headlines and open to the existing rows. The iPhone's subagent group becomes the Delegate purpose, unchanged.

## Planned later (not in this change)

- **An engine-side `intent` argument (TG-6).** This is an optional short `intent` string on the engine's own tools (`crates/nekko-tools/src/spec.rs`), like Claude Code's `description`, so that Nekko's own runs get model-written goals too. It changes the prompt goldens and adds a few tokens per call, and it is recorded here so that the classifier ships without waiting for it. The classifier already reads an `intent` argument as a goal. If it is adopted, it needs a decision record.
- **An after-the-fact summary of a whole turn** by a small model. This is out of scope: the classifier keeps grouping instant and free.

## Boundaries

- The classifier lives in `packages/shared/src/tool-purpose.ts` (TS) with Swift and Kotlin ports, like `summarizeToolCall`. One fixture file of `(tool name, input) → purpose` cases and headline cases, `packages/shared/fixtures/tool-purpose.json`, is run by all three test suites so that the platforms cannot drift.
- Grouping is presentation only. The stored transcript, the wire events and what the model sees are unchanged, and nothing extra is sent to any model.
- Paths in headlines and details are shown as their last segment, as `summarizeToolCall` does today. Commands are cut to one line.
- Commands are parsed by splitting words, never by patterns that backtrack: the text comes from the model.

## Acceptance

- The shared fixture holds at least 60 cases across every purpose, including Windows paths, MCP tools and Claude Code tool names. It passes in Vitest, Swift (`NekkoProtocol`, Linux) and Kotlin (`protocol`) tests.
- `transcript.ts` unit tests cover these grouping rules:
  - adjacency
  - approval, question and failure exceptions
  - description headlines
  - the activity headline summary
  - streaming into an open group
- Desktop visual evidence in the PR shows a turn that reads guidance, explores, edits and runs tests, before and after, in light and dark. It also includes a short recording of a group filling while live. The phones have screenshots from CI simulators and emulators. Status stays *unverified* there until they are run.

### Phone verification fixtures (2026-10-26)

The DEBUG iOS launch argument `-uiTestPurposeGroups` feeds six calls through
`TranscriptRow.of` and `BlockView`, matching chat grouping. Local native XCTest
passed: three two-call groups, failed checks open initially, guidance reveal/hide.
Matched unchanged-base/head screenshots and a native expand/collapse recording
were inspected and published on PR #1081.

Android's debug-only `PurposeEvidenceActivity` uses `Purpose.group`,
`PurposeGroupCard` and `BlockView` with six offline calls. Instrumentation passed
on an isolated API 32 ARM64 emulator, including reveal/hide and initially visible
failure. Matched base/head screenshots and native expand/collapse recording were
inspected and published on PR #1081. Fixtures skip pairing and make no relay calls.

These checks establish native renderer behavior, not physical-device, full chat
navigation or live relay verification. Desktop verification remains as above.

## Expanded detail wrapping (desktop and Local Web UI, issue #1103)

User intent: expanded tool usage should use multiple lines and available height,
not a single horizontally scrolling row.

Implemented: expanded activity inputs, reasoning, delegation tasks, standalone
ToolCard inputs, watch prompts/results and watch wake details preserve whitespace
and indentation while wrapping even unbroken paths, URLs and long tokens to the
available width. Existing height caps remain (10, 15 or 18 rem by well), with
vertical scrolling for longer content. JSON inputs retain their original JSON
serialization, including escaped newlines inside string values; literal backslash
sequences are not interpreted as display instructions. This is presentation only:
no transcript mutation, tool execution, new data access or network requests.

Acceptance: desktop (960 px) and narrow (440 px) isolated renderer checks must
show no horizontal overflow in expanded detail wells, retained text and bounded
vertical scrolling. Native phone tool cards are outside this change. Verification
status and before/after evidence are recorded in the linked PR; screenshots still
require visual inspection, not just successful capture.

## Tool timing and model continuation (#1107)

**Status: implemented in the desktop/shared Local Web UI renderer; focused regression tests pass. Matched desktop screenshots and timing recordings have been captured and inspected. Live-provider verification is unverified.**

- Each unfinished tool keeps its wall-clock timer and running mark until its own result, including older concurrent calls and calls before a newer narration block. Purpose groups stay live while any member call is unfinished. Completed tool and group timings freeze at their recorded result times, not at turn completion. Approval-pending calls do not tick as executing tools.
- After the latest activity block's tools finish, the ongoing turn shows **Tools finished. Waiting for the model…** separately from the completed calls. The model line remains visible when the step list is folded. It disappears on narration, a new tool call, or turn completion; approval, pause and retry waits do not masquerade as model work. The turn's existing overall elapsed measurement continues separately.
- When the provider supplies public reasoning through the existing `reasoning` events, its current text is visible in a bounded, wrapping, scrollable **Thinking** preview even when the step list is folded. Without that text, the UI reports only that it is waiting, never invented reasoning or progress.
- Privacy boundary: presentation only, using existing public event text, rendered as escaped text. No provider calls, new collection, encrypted reasoning, carry metadata, hidden/internal reasoning extraction, or transcript/wire changes.
- Regression coverage: concurrent and grouped calls, older activity blocks, zero-valued timestamps, fixed completed durations, wall-clock catch-up after sleep, timer cancellation, approval/held/retry/paused states, folded public text and HTML escaping.

Parent evidence scenarios: keep the same default theme, viewport and seeded events on the unchanged base and changed worktree. Record an older long-running call while a newer one returns, then both completed during a silent model wait, then a streamed public reasoning summary with the group folded, then narration and completion. Inspect `[data-tool-elapsed]`, `[data-tool-elapsed][data-running]`, `[data-purpose-group]`, `[data-model-activity]` and `[data-public-reasoning]`. Before/after screenshots plus a short timing recording are required; test renders alone are not visual evidence.

Verification for #1107: focused timing/activity tests and desktop typecheck pass. Matching unchanged-base/working-tree Electron captures and an approximately six-second frame recording show the older parallel tool timer advancing, completed timers freezing, model-wait continuation, public-thinking preview and turn completion. The synthetic fixture runs the real ActivityGroup with deterministic events in a hidden, off-screen, non-focusable, separate-profile window and blocks network/permissions. Reproduce with `node apps/desktop/scripts/tool-timing-integration.cjs`; set `NEKKO_TEST_SOURCE` to an unchanged archive for the baseline. Live provider cadence, packaged builds and other desktop platforms remain unverified.

## Activity-specific transcript icons

`[implemented; focused tests and isolated renderer checks passed; desktop dark/light screenshots reviewed at 1000px and 460px]`

- Individual tool calls show what is happening: a file for reads/guidance, folder for directory listings, magnifier for search, pencil for edits, checkmark for checks, branch for Git, globe for web access, and list for planning. Unknown/MCP tools keep the generic tool glyph.
- Shell execution (including Python) reuses the live current-work terminal artwork, rendered statically in the transcript so completed calls never appear to be running. Tests and Git commands use their more specific purpose icons. The existing animated current-work indicator is unchanged.
- Desktop and Local Web UI tool icons at every nesting level use the theme's primary accent, matching the outer summary. This includes completed calls and collapsed purpose groups; timestamps, disclosure arrows, quiet labels and failure text retain their existing colors. Explicit icon color overrides remain supported. No new data access or execution behavior is involved.
- Purpose groups use the common icon when their calls agree, or their purpose icon for a mixed group (for example, a magnifier for mixed code exploration). The outer summary uses its latest tool/group icon. Dedicated watch, subagent, thought and narration treatments are preserved.
- Selection is deterministic from tool name and the existing shared purpose classifier, with native and Claude Code aliases and `functions.` prefixes handled. This is renderer-only: grouping, tool execution, outputs, permissions and network behavior are unchanged. Icons remain decorative beside the existing textual labels.
- Verified via a synthetic real-ActivityGroup Electron fixture with blocked networking, isolated profile, hidden/non-focusable window, expanded read/search group, and collapse/reopen interaction. Packaged-app and physical-device verification are not included. Native capture source enumeration failed on this host; screenshots cover Electron renderer pixels, not OS window chrome.

## Progressive live disclosure (#1194)

[Implemented; intermediate-event regression tests and isolated full-ChatPane interactions passed; matched desktop/narrow renderer screenshots and sampled progress frames inspected. Live-provider cadence and packaged apps remain unverified.]

Thought text renders on its first public reasoning event, outside tool disclosures. Adjacent same-purpose calls are grouped during streaming, not deferred until `done`. A tool phase opens by default only while it is the newest streaming segment, then folds when narration or the next thought moves progress on. The automatic default follows the current phase rather than being captured on mount. A person's explicit expand/collapse choice still wins. Earlier thoughts remain expanded independently of all tool disclosures. The unchanged baseline already streams thought text and purpose groups; this change fixes the stale open-state that leaves earlier phases expanded until the settled transcript replaces them.
