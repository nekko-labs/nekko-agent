---
title: "Tool calls grouped by what they are for (planned 2026-10-25)"
area: chat
---

# Tool calls grouped by what they are for (planned 2026-10-25)

**User intent:** Philip asked (2026-10-25) that when an agent makes several tool calls, the chat should group them by what they are doing and tell the user the goal of each group. For example, reading the project's guidance (`AGENTS.md`, `CLAUDE.md` and the docs they point to) should be one group, separate from the coding calls. Tasks TG-1 to TG-6 in [TASKS.md](../../TASKS.md).

**Status `[planned; nothing implemented]`.** How each client shows tool calls today:

- **Desktop and Local Web UI:** consecutive steps fold into one activity group, *Worked on N steps* (T101, `ActivityGroup.tsx`). Inside the group every call is its own numbered row, with no sense of purpose.
- **iPhone:** one row per tool. Only consecutive `spawn_agent` calls are grouped.
- **Android:** one card per tool.
- **Labels:** tool calls carry only a name and input, and every label is derived on the client (`summarizeToolCall`, `Transcript.toolLabel`).

## What the user gets

- **Consecutive calls with the same purpose collapse into one row.** The row's headline says the goal in plain words, and a quiet detail line says what was touched:

  | Purpose | Headline | Detail |
  | --- | --- | --- |
  | Guidance | *Read the project's guidance* | `AGENTS.md`, `CLAUDE.md`, `landing-a-pr.md` |
  | Explore | *Looked through the code* | 6 files, 3 searches |
  | Edit | *Edited 3 files* | `Markdown.swift`, `ChatView.swift` +1 |
  | Check | *Ran the tests* or *Built the app* | passed, or 2 failed |
  | Run | *Ran 4 commands* | the first command |
  | Git | *Committed and pushed*, *Opened PR #123* | the branch |
  | Web | *Searched the web* or *Read 3 pages* | the query or the sites |
  | Plan | *Updated the plan* | — |
  | Delegate | Subagent group, as today | — |
  | Other | *Used 2 tools* | the tool names, for MCP and unknown tools |

  Each row opens to the individual calls, which look exactly as they do today, with their output wells. While a group is running, its headline is in the present tense with the running mark (*Reading the project's guidance…*). The headline switches to the past tense once the group ends.
- **Where the purpose comes from**, in order of preference:
  1. A `description` the call already carries is used as the goal. Claude Code's Bash, Task and similar tools send one. Some examples:
     - *Check existing issues, spec format, TASKS sections*
     - *Run the desktop tests*
     - *Install dependencies*
     
     When consecutive calls of one purpose carry different descriptions, the headline is the first one plus *and N more*.
  2. Otherwise a **deterministic classifier** decides the purpose from the tool name and input:
     - Guidance files: `AGENTS.md`, `CLAUDE.md`, `README*`, `CONTRIBUTING*`, `SKILL.md`, `.cursorrules`, anything under `docs/runbooks/`, `docs/decisions/` or `spec/`, and `.claude/` or `.github/` instructions.
     - Read, list, grep and glob on other paths are Explore.
     - Write, edit and patch are Edit.
     - Shell commands are split into Check (test, lint, typecheck, build: `npm test`, `cargo test`, `pytest`, `go test`, `tsc`, `eslint`, `xcodebuild test` and the like), Git (`git`, `gh`) and Run (everything else).
     - Web tools are Web, and plan and todo tools are Plan.
     
     It is a pure function with no model call and no added latency, and it costs no tokens.
  3. No call is ever hidden or merged with a call of a different purpose. A group is only ever a run of adjacent calls.
- **The desktop's activity group keeps its frame.** Its rows become purpose groups, and its headline summarises them: *Read guidance, looked through the code, edited 3 files*. This replaces *Worked on N steps*. The hover tip lists each group with its count.
- **Some calls are never folded into a group:**
  - a call waiting for approval, and any `ask_user` question, because these need the user
  - a failed call, which keeps its own visible row and marks its group *1 failed*
  - a group with a single call, which is shown as a plain row
  
  A group whose run includes a failure stays open after the turn ends, so the failure is not hidden.
- **Reasoning and narration between calls** still fold into the activity group as today. They do not break up a purpose group unless the purpose changes.
- **All four surfaces get the same groups:** the desktop, the Local Web UI, the iPhone and Android. The phones use the same headlines and open to the existing rows. The iPhone's subagent group becomes the Delegate purpose, unchanged.

## Planned later (not in this change)

- **An engine-side `intent` argument.** This is an optional short `intent` string on the engine's own tools (`crates/nekko-tools/src/spec.rs`), like Claude Code's `description`, so that Nekko's own runs get model-written goals too. It changes the prompt goldens and adds a few tokens per call, and it is recorded here so that the classifier ships without waiting for it. If it is adopted, it needs a decision record.
- **An after-the-fact summary of a whole turn** by a small model. This is out of scope: the classifier keeps grouping instant and free.

## Boundaries

- The classifier lives in `packages/shared` (TS) with Swift and Kotlin ports, like `summarizeToolCall`. One fixture file of `(tool name, input) → purpose` cases, `packages/shared/fixtures/tool-purpose.json`, is run by all three test suites so that the platforms cannot drift.
- Grouping is presentation only. The stored transcript, the wire events and what the model sees are unchanged, and nothing extra is sent to any model.
- Paths in headlines and details are shown as their last segment, as `summarizeToolCall` does today. Commands are cut to one line.

## Acceptance

- The shared fixture holds at least 60 cases across every purpose, including Windows paths, MCP tools and Claude Code tool names. It passes in Vitest, Swift (`NekkoProtocol`, Linux) and Kotlin (`protocol`) tests.
- `transcript.ts` unit tests cover these grouping rules:
  - adjacency
  - approval, question and failure exceptions
  - description headlines
  - the activity headline summary
  - streaming into an open group
- Desktop visual evidence in the PR shows a turn that reads guidance, explores, edits and runs tests, before and after, in light and dark. It also includes a short recording of a group filling while live. The phones have screenshots from CI simulators and emulators. Status stays *unverified* there until they are run.
