---
title: "Agent panel view options (2026-10-17)"
area: agents
split-from: SPEC.md (2026-10-22)
---

# Agent panel view options (2026-10-17)

`[implemented; unit-tested; verified in an isolated web-edition sandbox (separate NEKKO_DATA_DIR) with matched before/after captures; packaged desktop app not checked]` The Agents panel has a sliders button beside its **+**, and right-clicking any group header opens the same menu at the pointer. It arranges the panel the way a mail or task list's view menu does:

- **Group by:** Activity (default since 2026-10-26; the agent loop since 2026-11-03: Draft, Exploring, Building, Verifying, Shipping; called Status before), Project (the default until then), Date (Today, Yesterday, Previous 7 days, Previous 30 days, Older, by last update or by creation when sorting by creation), or None (one plain list with no headers). Outside Project grouping, completed chats gather in one **Completed** group at the bottom, folded until opened.
- **Sort by:** Manual (default: the order cards were dragged into, newest first for the rest), Last updated, Date created or Name, with Descending / Ascending. Picking Name starts A to Z and a date starts newest first. Manual has no direction.
- **Show:** **Metadata** (the model, context, git and sub-agent lines under each card's title; off leaves the title row alone), **Model provider** `[added 2026-10-23, removed 2026-11-06]`, **Automations** (chats an automation started) and **Empty groups** (projects or buckets with no active agents; the General bucket still hides when empty).
- **Reset to defaults** restores the original panel and is disabled when nothing differs.
- Dragging cards into order works only when grouped by project in manual order, the one arrangement where that order is what the panel shows; projects can be dragged only when grouped by project. Group header **+** and terminal buttons appear only in project grouping.
- The choice is a per-window preference in `localStorage` (`nekko.agentPanelView`), like the panel width; invalid saved values fall back field by field. No host calls, storage schema, permissions or network use change.

## Bounded agent groups

Implemented for the shared desktop and Local Web UI renderer: every active group initially mounts up to **20 top-level rows**, after filtering and sorting. This includes Project, Activity, Date, Computer, None, Terminals and Photos and videos. **Show more (N)** mounts all remaining rows in that group in one click, not another page. Completed lists separately start at 20 when opened and expand fully in the same way. Expansion is local to the mounted panel, independent per list, and resets when the grouping changes.

Hidden rows are not mounted and do not initiate PR-detail prefetches. Lightweight session summaries remain available for correct ordering, group counts, activity indicators and search; this is renderer partial mounting, not backend pagination or transcript loading. Subagent rows remain nested beneath a mounted parent. No storage, permissions or network access are added.

Opening a hidden agent (including a terminal or a child of a hidden parent) keeps its top-level row in the twentieth slot without mounting the intervening rows. Completed selection follows the same rule, and with no completed chat open, the chat the completion tip points at is the one kept in reach. Shift-selection ranges include only displayed rows.

Acceptance: boundary tests for 0, 19, 20, 21 and larger lists; independent one-click full expansion; selected hidden rows remain reachable; no full-transcript reads or hidden-card PR prefetches; matching wide/narrow and horizontal renderer captures. Native phone lists and backend summary pagination are outside this change. Visual verification status is recorded in the PR evidence.

## Group header hierarchy

Implemented: project, status, date and Completed group labels use the theme's primary accent color and 14px medium sentence-case text (no caps or letter spacing since the 2026-11 design pass), with accent disclosure chevrons. Vertical groups have 20px of separation and a faint inset 1px divider centred in each gap (2026-11 panel polish), with 4px between each heading and its contents. Horizontal groups use a 24px gap and a vertical divider instead, retaining their column alignment and compact card density. Dividers appear only between groups, never before the first, and do not intercept input or replace the project drag/drop padding. Collapsing, project actions, drag/drop, and ungrouped lists are unchanged. No new storage, network access or permissions.

Verification: CSS/markup regression tests cover spacing, theme-aware dividers and unchanged drag/drop padding. Matching isolated full-App Electron captures were inspected in light/dark at 1440px for both column and row layouts. The 760px captures verify the bottom-navigation icon and horizontal scrolling, but the vertical panel is hidden/covered on both base and change (existing narrow-drawer limitation, [#1909](https://github.com/nekko-labs/nekko-agent/issues/1909)); narrow column visual acceptance is not claimed. Group collapse/expand and divider placement checks pass. Packaged-app verification remains separate.

## Cards that need you, and the model line (2026-10-23)

`[implemented; unit-tested; verified in the hidden layout-evidence fixture with before/after captures in both themes; packaged desktop app not checked]`

- A card whose agent is waiting on you (a question or approval) or stopped on an error takes the same highlighted background as the active card, so it can be found in a column without reading.
- The waiting glyph is orange (`--attention`, its own token, louder than the amber warning) and drawn a size larger than its slot, like the working rocket, so the titles stay aligned.
- The model line names the model alone ("Opus 5.5"), followed by the context readout. The hover title reads "provider / model id". `[updated 2026-11-06]` The card no longer shows the provider as a line of its own under the model, and the **Show > Model provider** toggle is gone: the line cost every card a row for something the model name nearly always implies. A card on another computer still names that computer on the line under the model. `[updated 2026-11-08; render and tests in WorkspaceCardContext.test.tsx, captured in a hidden window with synthetic cards]` The model line reads *where · logo model*, then the context readout: the computer the chat runs on (see below), the provider's logo drawn in the model's colour (Anthropic, OpenAI, Google, OpenRouter, Ollama, LM Studio, vLLM; a custom endpoint has none and shows nothing in its place), then the model. The computer is named only once a second computer is connected, and then on every chat card, *This Mac* (or *This PC*, *This computer*) included, with its icon when it has one. Grouped by Computer, the group heading names it, so the card does not.


## Compact horizontal row

Implemented: the horizontal Agents panel has no block padding below the cards or their collapse wrapper, and adjacent groups have no vertical gap. Its five controls occupy a two-column grid at the left, rather than a five-button stack that determines the row height. Column controls and collapsed-panel placement are unchanged. Choices, grouping and scrolling retain their behavior; no new settings or permissions.

Acceptance: the card bottoms meet the horizontal scrollbar, with no unused panel space after the scrollbar. Hidden full-App DOM measurements at 1440x900 found a card-to-scrollbar difference below 1px and no space after the list. CSS regression tests cover the grid and padding. Before/after captures exist; pixel inspection and native-window verification remain unverified.

## Activity grouping, chiplet cards and the arced move (2026-10-26)

`[groups superseded 2026-11-03: see Activity follows the agent loop below; default grouping, chiplet cards and the move stand]`

`[implemented; unit-tested; verified in the hidden layout-evidence fixture (agent-activity-motion-sandbox.cjs) with before/after captures and motion frames in the default dark theme; packaged desktop app not checked]`

- **Activity is the default grouping.** A fresh panel (or **Reset to defaults**) groups agents by what they are doing: Needs input, Working, Error, Done, with Completed folded at the bottom. The menu calls it **Activity** and lists it first; Project and Date are still there. A window that already saved a view keeps it, so someone who used the view menu before sees no change until they pick Activity or reset. Dragging cards into order still needs Project grouping in Manual order, so it is off by default now.
- **Idle is now Done.** An agent that has stopped with nothing waiting on you is in **Done**, the same agents the Idle group held (finished turns, and agents kept idle by a watch). It is not the same as **Completed**, which still holds chats you closed out.
- **Chat rows are flat, with a selected-row background (updated by #1906).** The selected agent has a persistent theme-accent soft background across its rounded row, so the active chat is clear without hovering or comparing title weight. Unselected chats, including needs-input/error rows, remain transparent with no border or shadow at rest. Hover/focus feedback is described below. Selection retains the stronger title, status retains its semantic icon/colour, and keyboard focus retains an explicit outline. The highlight follows the selected chat in the column, horizontal panel and narrow-screen drawer. Terminal tiles keep their neutral surface. No storage, network use or permissions change. Implemented; 28 focused tests and the desktop typecheck pass. Matching isolated Windows Electron captures at 1440×900 in the default Nekko dark theme were inspected for the column and horizontal panel; selection switching, Enter activation and hover persistence pass. At 480×900 the style follows selection, but the drawer is covered by the chat wall on both main and this change ([baseline issue #1909](https://github.com/nekko-labs/nekko-agent/issues/1909)); narrow visual acceptance remains blocked by that existing issue. Packaged apps, other operating systems and light-theme pixels were not checked. The earlier chiplet treatment below is superseded for chats.
- **Earlier chiplet treatment (terminals only).** Each card is its own rounded tile with a full hairline border and a raised surface, a small gap between tiles, instead of a flush row with an accent spine on the left. The active chat's border takes the accent; a card waiting on you or stopped on an error keeps the highlighted background. Terminals stay neutral.
- **Moving between groups is animated.** When an agent changes group (a working agent finishes and drops to Done, one asks a question and rises to Needs input), its card glides from the old place to the new one over about 0.7s along a curve that bows out to the right, so the eye can follow which agent moved. Only in Activity or Date grouping, never when the grouping itself is switched, never into or out of a folded group, and not at all when the OS asks for reduced motion. Other cards settle into place without animating.
- Acceptance: the motion frames show the card leaving Working, passing to the right of the groups between, and landing in Done with no clipping at group edges (the flying copy sits on a fixed layer above the panel; the real card is hidden until it lands). No storage, host calls, permissions or network use change. The phone's chat list view menu is unchanged.

## Activity follows the agent loop (2026-11-03)

`[implemented; unit-tested; daemon test over real sockets for chats a window is not showing; verified in the hidden layout-evidence fixture (agent-activity-motion-sandbox.cjs) with before/after captures and motion frames in the default dark theme; not yet watched in a real chat in the packaged desktop app]`

**User intent:** Philip asked (#1560) for the panel's statuses to follow the agent loop: "draft (only show when drafts exist), exploring, building, verifying, and shipping". He then asked for Needs input back above them, so a chat waiting on him cannot get lost in a phase. Then (#1587): "remove the shipping group and add done for ones that are complete and another group for watching for ones with watchers still active", because finished agents piled up in the phase they stopped in.

- **The groups** were Needs input, Draft, Exploring, Building, Verifying, Watching and Done, in that order (Exploring folded into Building on 2026-11-04, see below), with Completed folded at the bottom as before. The phases hold agents that are working; Watching and Done hold the ones that have stopped. There is no Shipping group (#1587).
- **Needs input** holds chats parked on a question or an approval, and a chat whose sub-agent is, since a sub-agent has no card of its own. Answering sends the chat back to its phase. Like Draft it shows only while it has a chat, whatever **Show > Empty groups** says.
- **Draft** holds chats nothing has been sent in yet. Unlike the others it shows only while it has a chat, whatever **Show > Empty groups** says. A chat with earlier turns and unsent text in its composer stays in its phase.
- **A chat's phase is its latest tool call that names one.** Reading, searching and web tools are Exploring. Edits are Building. Tests, builds, linters and type checks are Verifying. `git commit`, `git push`, `gh pr create`, `gh pr merge` and `gh release create` are Shipping, which the engine still names but the panel files under Verifying: an agent landing its work is still checking it. It is the latest rather than the furthest, because the loop goes round: an edit after a failed test is Building again. Reading only sends a chat back to Exploring from a new message of yours: within one reply, the reads an agent does while wrapping up (a runbook, a memory file, a last screenshot) leave it where it got to. A watch waking the agent to check on its work is not a new message (#1581).
- **Everything else leaves a chat where it was:** plans, sub-agents, MCP tools, reading git (`git status`, `git diff`, `gh pr view`) and commands with no clear purpose. A chat that has been sent something starts at Exploring and stays there until a call says otherwise, so a chat that only talks is in Exploring.
- **A chat that stops leaves the loop.** It goes to **Done**, or to **Watching** while it has an armed watch (the card's Zz). When the watch wakes it, it goes back to its phase while it works, and to Watching or Done when it stops again. A new message does not reset the phase. **Done** is not **Completed**: Completed still holds the chats you closed out.
- **What an agent is doing now stays on the card:** the rocket while it works, the orange **?** when it waits on you, the warning on an error, the check when finished. An error has no group of its own, so a card stopped on an error stays in its phase. The wall's ring is unchanged. A reply that finishes while you are on another page, such as Settings, shows finished when you come back: the mark a send puts on a chat ends with the turn, whether or not the chat is open.
- **A live group says so in its heading.** While a chat in Building or Verifying is working, and while Watching holds a chat, the heading shows a small Nekko animation after the name (hammering bricks, ticking a checklist, keeping watch by a radar ping) and a green count at the far right, open or folded. A phase group holding only chats stopped on an error shows neither, so it never looks busy. Other groups, and other groupings, keep the grey count shown when folded, also at the far right. The animation runs only in this panel and pauses, like all app animation, while the app is not active. **Settings > Animations > Agent activity animation** (on unless turned off) is the only switch for it: off holds Nekko on a still frame and keeps the green count. By the owner's decision it deliberately ignores the system's reduced-motion preference, including Windows with Animation effects off, so someone who relies on that preference must turn this setting off ([decision 0048](../../docs/decisions/0048-agent-activity-animation-answers-to-its-own-setting.md)).
- **Every window hears a move.** The engine works the phase out from the saved transcript (`crates/nekko-store/src/phase.rs`, which runs the shared tool-purpose fixture) and adds it to the chat's summary, so it survives a restart and reaches another computer's chats. Tool calls only stream to the windows showing a chat, so when a phase changes the engine sends `session_meta` once the step is saved, and every window re-reads its list. Each move costs one list refresh, not one per call.
- A working chat summarised by an older computer has no phase and shows in Exploring. Incognito chats are not saved, so they show in Exploring while they work too.
- Phones keep their own Status grouping (Needs you, Working, Watching, Done; Idle until 2026-11-05). The summary carries the phase if they take it up later. No new storage, permissions or network use.

## Exploring folds into Building (2026-11-04)

`[implemented; unit-tested (agentPanelView, workingAgents, claudeAgentPlan, PlanRail, phase.rs, plan_update.rs); not yet watched in the packaged desktop app]`

**User intent:** Philip: "let's unify the exploring and building phases on the left agent panel and in the agent plan into just building phase", and "starting a fresh chat and kicking it off, I noticed that it went straight to done. Instead, it should be in exploring or building phase."

- **The groups** are Needs input, Draft, Building, Verifying, Watching and Done. Reading, searching and editing are all Building; the engine (`phase.rs`) names reads `building` too, keeping the wrap-up rule: within one reply, reads after a test or a push leave the chat where it got to. A summary from an older engine that still says `exploring` is filed under Building.
- **A chat just sent is Building at once.** The engine says nothing until the model's first token, which for a Claude Agent chat can take many seconds, and a sent chat with no status used to sit in Done meanwhile. The panel now hears the chat pane's own send (`reportAgentWorking` in `workingAgents.ts`) and marks the chat working the moment it is sent. Sends from another window or a phone still wait for the first event.
- **A finished chat stays finished.** `[implemented; unit-tested (AgentWindowIndicators); not yet watched in the packaged desktop app]` News about a chat that is not a turn (Claude Code's background task count, compaction progress) leaves its status alone. It can arrive after the turn's `done`, and it used to mark the chat working with nothing left to clear it, so the chat sat in its last phase, usually Verifying. A chat whose Claude Code still runs background tasks therefore shows as Done, or Watching with an armed watch, until a task wakes it.
- **The agent plan** drops Explore the same way; see [the plan sheet](../chat/plan-sheet-on-the-composer.md).
- No storage, permissions or network use change.

## An agent asked to watch something is Watching (2026-11-05)

`[implemented; unit-tested (agentPanelView, sessionSummaryRefresh, routes.rs, session.rs, a daemon test with a simulated Claude Code); not yet watched in the desktop app with a live Claude Code watcher]`

**User intent:** with the automatic watch setting off, an agent asked by hand to watch a PR should still show in Watching, not Done. This is a manual way in for the specific agents someone asks, added to the logic and not replacing it.

- Claude Code chats have no `agent_watch`, so an agent asked to watch something starts a background watcher. The panel only counted armed watches, so that chat looked finished.
- **This adds to Watching; nothing else about it changes.** A stopped chat with an armed watch, including the default PR watch, is Watching as before. A stopped chat is now also Watching while its Claude Code runs a background watcher, whatever **Watch each PR until it is merge-ready** says, and its card shows the Zz. When the watcher ends, the chat goes to its phase if that wakes it, then to Done.
- **A background watcher** is a `Monitor` task, or a background command that polls in a loop (`while`, `until` or `for` with a sleep) or follows a `gh` watch (`gh run watch`, `gh pr checks --watch`). Claude Code does not label its tasks, so this is read from the call that started the task (`is_watcher` in `session.rs`). A background test run, dev server or sub-agent is not a watcher and leaves the chat in Done.
- A watcher counts only while Claude Code reports a background task, and all of them clear when it reports none, so a missed end cannot hold a chat in Watching.
- The engine adds `backgroundWatchCount` to chat summaries, kept apart from `activeWatchCount`, which phones and live cards read as "Watching PR". Phones are unchanged. Every window re-reads its list on `claude_code_background`.
- The count lives in memory with the Claude Code child, so it goes with the child. No new storage, permissions or network use.

## Subagents under their parent (2026-11-03)

`[implemented; unit tested; checked in an isolated hidden renderer, not in the packaged app]`

A subagent used to leave the panel the moment it had a reply and stopped running, and landed in the saved-chats list instead, so afterwards you could not see how the work was split. Now every subagent stays under its parent, in the order it was started, by the same rule as the rest of the panel: details show while they are relevant.

- A **working** subagent always has a row.
- A **finished** subagent keeps its row, with its done mark, while its chat is working or open, or while one of its subagents is open.
- Otherwise finished subagents fold away, and the card's **N sub-agents** line, which now counts all of them, stands in. Opening the chat brings them back.

Archived subagents do not appear. A subagent whose parent is archived stays in saved chats, as before.

## Scheduled Tasks navigation icon (2026-11 panel polish)

Implemented: the shared desktop/Local Web UI rail uses Gentleface 0.3.0's **workflow-clock**, solid-round on its native 16px grid at 22px. The exact upstream workflow and clock subpaths are colored indigo and amber to match the rail's playful palette, independent of the selected text color. Existing rail hover/active effects and accessible navigation labels remain unchanged. The artwork is bundled locally under the existing MIT notice; there are no runtime downloads, new dependencies or permissions. This changes the navigation icon, not the New scheduled task action's workflow icon or scheduling behavior.

Verification: icon markup/palette regression coverage, desktop typecheck and production build pass. Synthetic full-App checks identify the actual Scheduled Tasks rail icon in both themes. Matching before/after screenshots were inspected in both themes, including the shared renderer’s 760px bottom navigation. Packaged apps and native phone UI are not tested by this renderer-only change.

## Agent-row hover glow

Implemented; 25 focused tests and desktop typechecking pass. Matching hidden Electron captures at 1440px (column and horizontal panel) and 460px (horizontal panel), plus sampled motion frames, were inspected in the default dark theme. Actual pointer hover/leave/click, selected-row persistence, keyboard-visible focus and reduced motion pass. The narrow vertical drawer remains covered by the chat wall on both base and head ([existing issue #1909](https://github.com/nekko-labs/nekko-agent/issues/1909)); its visual acceptance remains unverified. Packaged apps, native OS chrome and other platforms were not checked. Hovering a chat row in the Agents panel adds a theme-accent background wash and a subtle inner/outer glow, fading in and out over 120 ms with no lift, scale or layout movement. Keyboard-visible focus gets the same feedback plus its explicit outline. The selected row keeps its persistent, stronger background even when another row is hovered; hover never changes selection or opens a chat. Reduced motion makes the feedback immediate. Hover-only feedback is limited to hover-capable pointers. Terminal tiles and the compact completed/sub-agent rows retain their existing treatment.

Acceptance: actual pointer hover/leave restores the resting state, selected and unselected rows stay distinguishable, keyboard focus stays visible, and reduced motion removes the transition. Verify matching default-theme column, horizontal-panel and narrow-screen captures plus a short motion recording. No storage, network, permissions or host behavior changes.

## First-class terminal rows

Implemented: terminal entries come from the terminal registry, not only terminal-anchored workspaces. Every real terminal has one row, including split, minimized and exited terminals; read-only agent command logs stay out. Terminals retain the dedicated Terminals activity group, existing project/date/name sorting, and drag-to-zone behavior. Rows use terminal-reported smart titles with saved-title fallback, explicit activity/attention/exit state, and a PR-number hint. The active terminal keeps its selection highlight rather than jumping to a chat. Working shell Close uses the existing confirmation before stopping processes. See [terminal session context](terminal-session-context.md) for signal boundaries, verification and limitations.


## Independent card details (2026-11-06, #2000)

Implemented in source; native visual acceptance is pending the linked evidence runs:

- View > Card details exposes independent Model, Context window, Pull requests and Last reply time (Last updated on phones) switches. Desktop/Local Web UI also expose Git branch, Sub-agent count and Window count. Existing preview/computer choices stay in Show. The desktop Metadata switch remains as a legacy master for the metadata rows; PR and reply time follow their own switches even with Metadata off.
- Missing or malformed detail keys default on. Explicit saved booleans, including legacy Metadata off and Always show groups on, are preserved. Reset restores all details on and empty groups off. Preferences are device-local, not host settings.
- Hiding a model does not hide context or PRs. The PR chip follows the last visible detail row, or the title if none remain. Titles, pins, activity, attention and pending offline prompts are never hidden by detail choices. A context compaction label follows the context toggle.
- All clients default empty groups off (iOS already did); an explicit saved opt-in survives.
- iOS chat-list row/section separators are hidden. Its group headings use the desktop's accent chevron and medium label; only live Building/Verifying/Watching show Nekko's activity mark after the label and a green count capsule. Other collapsed headings use a neutral count; expanded inactive headings omit it. Native activity marks use still frames, not the desktop animation.
- Phone rows project existing summary model IDs, transcript token estimates and model-matched Claude-reported used/window counts. A missing window stays unknown (used tokens only); no model capacity is invented. Android PR numbers come from summary URLs; iOS retains state-aware PR badges. Neither toggle changes model requests, context budgeting or PR fetching.

Acceptance: preference migration and roundtrip tests on all three clients; desktop server-render matrix for independent visibility and PR relocation; native real-view UI toggle tests plus matching baseline/head screenshots. Native simulator evidence and published media remain required before landing. Full live context-gauge parity on phones (catalog capacity and open-chat bundle estimates) is not implemented by this change.
