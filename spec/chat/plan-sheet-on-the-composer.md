---
title: "Plan sheet on the composer (2026-10-25; folded summary, loop kinds and sub-agent chips 2026-10-28)"
area: chat
---

# Plan sheet on the composer (2026-10-25)

Issue: [#1149](https://github.com/nekko-labs/nekko-agent/issues/1149).

## Intent

The agent's plan was split from the place the user works: it sat in the Agent Monitor column, while verification and PR state sat under the composer. The user wants the full plan of the session tied to the composer, with fewer lines and borders.

## Behavior (implemented)

- In the full chat view, the agent's plan is a card tucked behind the composer. It rises out from under the composer's top edge when the plan first appears, and has no border: a slightly raised surface separates it from the transcript.
- `[superseded 2026-10-28, see below]` The header shows "Plan", progress ("2 of 4") and **Change plan**, which opens the existing plan-change prompt. Clicking the header collapses the card to one line with the current step's title.
- Each step has up to three rows: its title; one line of detail (the agent's note); and, only when the step has something to show, a slim row of chips.
- Finished and skipped steps squeeze to their title. While the pointer (or keyboard focus) is anywhere on the card, every squeezed step opens to its full rows. The grow and shrink take 120 ms; reduced motion turns them off.
- Chips are attached by the app, not reported by the model. The app replays the transcript's `update_plan` calls in order, and a PR the agent created (the same rule as the PR dock: a successful `gh pr create` or POST to `pulls`) or a file or preview it linked belongs to the step that was active at that point. Replayed steps map onto the live plan by title. A PR chip shows its number, state and CI rollup (passing, failing, or "CI 6 of 9" while running) from the existing PR poller and opens the PR; a file chip opens it in the file pane, and a preview chip opens its URL.
- The Agent Monitor no longer shows the plan; it keeps artifacts, project, sub-agents and queued follow-ups.
- Step status marks are unchanged from [per-step plan working icons](per-step-plan-working-icons.md) and still do not animate.
- An archived chat has no composer, so it shows no plan card.
- `[superseded 2026-10-28]` In Grid and Dynamic layouts the agent windows show only their transcripts, so the shared composer carries the selected agent's plan card, and **Change plan** opens its prompt there. Every wall window now has its own composer and plan sheet ([a composer in every wall window](../desktop/a-composer-in-every-wall-window.md)). The card is not shown on a clean-start chat.

## Verification and CI on the card (implemented, second PR)

- A step with an explicit verification report shows a chip: Verified, Checking, Check failed, Check blocked, Check pending or Check unknown, with the device ("Verified on macOS"). Its tooltip says it is agent-reported and gives the report's age (stale for waiting reports). It opens the evidence link only when that link is safe. The report's detail replaces the step's note on the detail row. A done step without a report shows no chip.
- CI checks of each open PR sit in one slim row under the last step that has a verification report (else the step that opened the PR, else the running step): failing and running checks by name, failing first, and the passing ones folded into "N passed", which opens the PR's checks page.
- The separate Verification panel under the composer (and inside each agent window) is gone. When the card shows CI, the PR card keeps its actions and review threads but drops its CI lines, and the PR actions start tucked away behind their slim "1 pull request · Show actions" row; without a plan the PR card still shows CI and opens as before.
- Below the composer the agent window reads as one surface: the PR row has no border or shadow, and the footer controls have no divider or separate background.

## Verification

Unit coverage for step matching (`planStepLinks.test.ts`) and the card's rendering (`PlanRail.test.tsx`). Hidden, off-screen Electron captures (`plan-sheet-sandbox.cjs`) check that the card is tucked behind the composer, the right column has no plan, finished steps are squeezed, the PR and link chips land on the right steps, and hovering the card opens every finished step. Not verified in a packaged build.

## Folded summary, loop kinds, sub-agents and task links (implemented 2026-10-28)

Issue: [#1317](https://github.com/nekko-labs/nekko-agent/issues/1317).

- **Shape.** The sheet is narrower than the composer (84%), tucked behind its top edge with curved shoulders where its sides meet the composer, and filled with the composer's surface plus a touch of accent, so no dividing line separates them.
- **Folded by default.** One or two lines: the step being worked (its progress mark, loop kind, title, pass and place, "2 of 4"), then one row of chips for it: the sub-agents as one count ("Sub-agents 1 (rocket) 2 (check)": running and done), then its verification, PRs, task links and files. When the step has no task link of its own, the chat's (the first step's) shows, so the folded sheet always says what the work is for. Clicking it opens the whole plan; the header ("Plan · 1 of 4 done") folds it again.
- **Open.** Every step with its loop kind in a fixed column, its title and pass, its detail line, and its chips underneath: task links, each sub-agent (title and a running or done glyph; clicking opens its chat, on the wall as a window), verification, PRs, CI checks and files. Finished steps still squeeze and open on hover or focus.
- **Loop kinds.** A step can say where it sits in the work loop: Explore, Build, Verify or Ship (`update_plan`'s `kind`). Shown as a small caps word before the title, in the accent while that step is being worked. A step without one shows none.
- **Passes.** When a finished step is set active again (a Verify step sending the work back to Build), the plan counts another pass on it, shown as "Pass 2" with a loop arrow.
- **Where sub-agents and task links land.** The app places them, not the model: a sub-agent on the step being worked when its chat was created (else the last step worked before then), a task link (Linear, Jira, GitHub issue, Trello, Asana, ClickUp, Todoist) on the step being worked when it appeared in the chat. Anything from before the first step, such as the task the chat was started from, goes on the first step. A link already shown on an earlier step is not repeated.
- **Agent Monitor on the wall.** Wall windows no longer open the Agent Monitor rail, and the floating sub-agents chip only shows on a window without a plan: the plan sheet carries both. The Agent tab keeps its Agent Monitor.
- **Change plan is gone**, with its prompt. Telling the agent to change course is an ordinary message (or Ctrl+Enter to steer a running reply).

Verification: `planStepLinks.test.ts` (placement by time, first-step fallback, task-link parsing), `PlanRail.test.tsx` (folded line, kind, pass, sub-agent count and per-step chips), `plan-step-kind.test.ts` and the `nekko-turn` Rust test (kinds and passes). Hidden, off-screen Electron captures (`wall-composers-sandbox.cjs`) check the folded line, the sub-agent count, the Linear chip, the tuck behind the composer, and the open plan's per-step chips. Not checked in a packaged build.

## Claude Agent chats (implemented 2026-10-31)

Issue: [#1401](https://github.com/nekko-labs/nekko-agent/issues/1401).

- **Intent.** A Claude Agent chat (Claude Code, on a plan or a key) showed no plan sheet: the sheet fills from Nekko's `update_plan`, which Claude Code doesn't have. It plans with its own tools, which showed only as tool calls.
- **Behavior.** The harness reads Claude Code's own plan calls from its stream-json, and nekkod keeps the chat's `agentPlan` in step with them, so the same sheet shows. `TodoWrite` replaces the whole plan (its list is the full plan each time). `TaskCreate` adds a step (`task_<id>`, the id from its result, the description's first line as the note), and `TaskUpdate` changes or removes it (`pending`/`in_progress`/`completed` read as pending/active/done; `deleted` drops it). Only calls that succeeded count, and only the main thread's: a sub-agent's plan is its own. Each change is saved with the call's checkpoint and announced with `session_meta`.
- **Policy.** Display only and on for every auth, Claude plan included: Nekko adds no tool, prompt or flag to Claude Code (see [Claude policy](../product/claude-policy.md)).
- **Not covered.** Step chips (PRs, files, sub-agents) are placed by replaying `update_plan` calls, so on a Claude Agent chat the steps carry no chips yet. Loop kinds and verification reports have no Claude Code counterpart.

Verification: `nekko-harness` unit tests (`plan.rs`, and the mapper only handing up a successful main-thread call) and `claude_codes_own_plan_is_the_chats_plan` in nekkod's daemon tests (a fake Claude Code's `TaskCreate`/`TaskUpdate` end up as the saved plan). Not checked against a live Claude Code turn or on screen.

## Claude Agent chats without a plan of their own, and their PRs (implemented 2026-11-01)

- **Intent.** Even when Claude Code writes no plan, the sheet should say what it was asked to do and where the work landed (its PRs).
- `[superseded 2026-11-01, see below]` **Turn plan.** A Claude Agent chat with no `agentPlan` showed one step per request it sent Claude Code ("Ask Claude Code: <first line>"), the last 8, with the newest active while Claude Code works and the rest done (`claudeAgentPlan.ts`, built in the renderer, never saved). Claude Code's own plan replaces it as soon as it writes one. Other chats are unchanged: no plan, no sheet. With the sheet showing, the PR card leaves CI to it, as it does for any plan.
- **Chips.** A PR, file or task link lands on the turn it came from. On Claude Code's own plan, the step it had in progress (`TodoWrite`'s `in_progress` item, or a `TaskUpdate` to `in_progress`, matched by title) is the step being worked.
- **PRs Claude Code opens.** `collectSessionPrUrls` now accepts Claude Code's `Bash` tool as well as Nekko's `bash`, and sets a heredoc body aside before its checks, since Claude Code passes `--body` as `"$(cat <<'EOF' ... EOF)"`. A batch around it (`&&`, `;`, `|`) is still refused. This also fixes the PR card and the "1 pull request" row on Claude Agent chats, which never saw those PRs before.

Verification: `claudeAgentPlan.test.ts`, `planStepLinks.test.ts` (turn steps, `TodoWrite`, `TaskCreate`/`TaskUpdate`), `packages/shared/src/pr.test.ts` (Claude Code's heredoc create, chained commands refused). Hidden, off-screen Electron captures (`claude-agent-plan-sandbox.cjs`) check that the sheet shows on a Claude Agent chat, the running turn is the folded line, and the PR chip sits on the turn that opened it. Not checked against a live Claude Code turn.

## Claude Code's plan rebuilt, and an activity plan instead of the turn plan (implemented 2026-11-01)

Issue: [#1468](https://github.com/nekko-labs/nekko-agent/issues/1468).

- **Intent.** Philip saw no plan on a Claude plan chat, and the fallback plan only restated each prompt as a row ("Ask Claude Code: nekko agent", since his prompts start with that line). In that chat Claude Code made 107 tool calls and never called `TodoWrite` or `TaskCreate` (in Claude Code 2.1 the task tools are deferred, so a headless turn often skips planning), and chats from before nekkod kept Claude Code's plan (#1401) never got one saved.
- **Claude Code's plan, rebuilt.** A Claude Agent chat with no `agentPlan` rebuilds Claude Code's own plan from the transcript's successful `TodoWrite`, `TaskCreate` and `TaskUpdate` calls, with the same ids, titles, statuses and notes nekkod keeps (`claudeCodeOwnPlan`).
- **Activity plan.** Without any plan calls, the sheet shows the work loop of the latest request, read from Claude Code's tool calls (`claudeCodeActivityPlan`): **Send the request to Claude Code** (its first line as the note), then **Explore** "Look through the code" (`Read`, `Grep`, `Glob`, web reads, and `Bash` that is none of the below), **Build** "Make the changes" (`Edit`, `Write`, `git add/commit`), **Verify** "Check the work" (`Bash` tests, builds, lints, type checks, `gh pr checks`) and **Ship** "Open a pull request" (`gh pr create/merge`, `git push`). A phase is active while Claude Code's latest call is in it, done once it has calls, and pending ahead of it while Claude Code works. A finished turn keeps only the phases it touched. A request Claude Code only answered shows no plan. Notes count the calls ("82 reads and searches", "12 edits", "9 checks run").
- **Chips.** On the activity plan, a PR, file or task link lands on the phase of the call that produced it, so the PR Claude Code opened sits on Ship.
- **PRs Claude Code opens, continued.** Besides its heredoc body, `collectSessionPrUrls` now allows the shape Claude Code really runs: one leading `cd <dir> &&` (a plain or quoted path) and a trailing `2>&1` and/or `| tail -N` / `| head -N`, reading the URL from gh's last output line. Anything else chained (`cd a && cd b`, a second `&&` command, `| grep`, `$(...)` in the path) is still refused.

Verification: `claudeAgentPlan.test.ts` (phases by tool and command, the loop while working and after, no plan for an answer, the rebuilt task and todo plans), `planStepLinks.test.ts` (the PR on Ship), `packages/shared/src/pr.test.ts` (leading cd, trailing trim, warnings before the URL, chained commands refused). Run against Philip's real Claude Agent chats: the two that used `TaskCreate`/`TaskUpdate` now show those tasks, and the 2026-11-01 chat shows Send, Explore, Build, Verify and Ship with PR #1466 on Ship. Hidden, off-screen Electron captures (`claude-agent-plan-sandbox.cjs`) check the folded line is the current phase, five steps rather than one per prompt, and the PR chip on Ship. Not checked against a live Claude Code turn.
