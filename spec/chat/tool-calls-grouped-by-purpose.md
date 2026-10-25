---
title: "Tool calls grouped by what they are for"
area: chat
---

# Tool calls grouped by what they are for

**User intent:** Philip asked (2026-10-25) that when an agent makes several tool calls, the chat should group them by what they are doing and tell the user the goal of each group. For example, reading the project's guidance (`AGENTS.md`, `CLAUDE.md` and the docs they point to) should be one group, separate from the coding calls. Tasks TG-1 to TG-6 in [TASKS.md](../../TASKS.md); issue #1075.

**Status `[implemented on the desktop and Local Web UI 2026-10-25; phones planned]`.**

- **Shared classifier (TG-1): implemented.** `toolPurpose`, `toolGoal`, `purposeHeadline`, `summarizePurposes` and `groupByPurpose` in `packages/shared/src/tool-purpose.ts`, with the shared fixture `packages/shared/fixtures/tool-purpose.json` run by Vitest.
- **Desktop and Local Web UI (TG-2): implemented.** `activityRows` in `transcript.ts` splits an activity run into purpose groups, and `ActivityGroup.tsx` draws them (`PurposeGroupRow`) under a headline that summarises them. The Local Web UI serves the same renderer. Verified with unit tests and isolated renderer captures of the real `ActivityGroup` (`apps/desktop/scripts/tool-groups-integration.cjs`); not yet watched in a real Claude Code or engine run.
- **iPhone (TG-3): planned.** Today one row per tool; only consecutive `spawn_agent` calls are grouped.
- **Android (TG-4): planned.** Today one card per tool.

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
- **Reasoning and narration between calls** still fold into the activity group as today. A thought between two calls of the same purpose folds into their group; it does not break up a purpose group unless the purpose changes.
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
