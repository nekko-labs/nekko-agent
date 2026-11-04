---
title: "Agent panel view options (2026-10-17)"
area: agents
split-from: SPEC.md (2026-10-22)
---

# Agent panel view options (2026-10-17)

`[implemented; unit-tested; verified in an isolated web-edition sandbox (separate NEKKO_DATA_DIR) with matched before/after captures; packaged desktop app not checked]` The Agents panel has a sliders button beside its **+**, and right-clicking any group header opens the same menu at the pointer. It arranges the panel the way a mail or task list's view menu does:

- **Group by:** Activity (default since 2026-10-26; the agent loop since 2026-11-03: Draft, Exploring, Building, Verifying, Shipping; called Status before), Project (the default until then), Date (Today, Yesterday, Previous 7 days, Previous 30 days, Older, by last update or by creation when sorting by creation), or None (one plain list with no headers). Outside Project grouping, completed chats gather in one **Completed** group at the bottom, folded until opened.
- **Sort by:** Manual (default: the order cards were dragged into, newest first for the rest), Last updated, Date created or Name, with Descending / Ascending. Picking Name starts A to Z and a date starts newest first. Manual has no direction.
- **Show:** **Metadata** (the model, context, git and sub-agent lines under each card's title; off leaves the title row alone), **Model provider** (where the card's model comes from, as subtext on its own line under the model; disabled while Metadata is off) `[added 2026-10-23]`, **Automations** (chats an automation started) and **Empty groups** (projects or buckets with no active agents; the General bucket still hides when empty).
- **Reset to defaults** restores the original panel and is disabled when nothing differs.
- Dragging cards into order works only when grouped by project in manual order, the one arrangement where that order is what the panel shows; projects can be dragged only when grouped by project. Group header **+** and terminal buttons appear only in project grouping.
- The choice is a per-window preference in `localStorage` (`nekko.agentPanelView`), like the panel width; invalid saved values fall back field by field. No host calls, storage schema, permissions or network use change.

## Group header hierarchy

Implemented: project, status, date and Completed group labels use the theme's primary accent color and 14px medium sentence-case text (no caps or letter spacing since the 2026-11 design pass), with accent disclosure chevrons. Vertical groups have 16px of separation and 4px between each heading and its contents, so headings stand apart from agent-card metadata. Horizontal groups retain their existing column alignment. Collapsing, project actions, drag/drop, and ungrouped lists are unchanged. No new storage, network access or permissions.

Verification: regression tests and isolated matching light/dark renderer captures cover the hierarchy; packaged-app verification remains separate.

## Cards that need you, and the model line (2026-10-23)

`[implemented; unit-tested; verified in the hidden layout-evidence fixture with before/after captures in both themes; packaged desktop app not checked]`

- A card whose agent is waiting on you (a question or approval) or stopped on an error takes the same highlighted background as the active card, so it can be found in a column without reading.
- The waiting glyph is orange (`--attention`, its own token, louder than the amber warning) and drawn a size larger than its slot, like the working rocket, so the titles stay aligned.
- The model line names the model alone ("Opus 5.5"), followed by the context readout. The provider ("Claude", "Local", "ChatGPT (subscription)") is fainter subtext on the line under it, toggled by **Show > Model provider** (on by default). The hover title still reads "provider / model id".


## Compact horizontal row

Implemented: the horizontal Agents panel has no block padding below the cards or their collapse wrapper, and adjacent groups have no vertical gap. Its five controls occupy a two-column grid at the left, rather than a five-button stack that determines the row height. Column controls and collapsed-panel placement are unchanged. Choices, grouping and scrolling retain their behavior; no new settings or permissions.

Acceptance: the card bottoms meet the horizontal scrollbar, with no unused panel space after the scrollbar. Hidden full-App DOM measurements at 1440x900 found a card-to-scrollbar difference below 1px and no space after the list. CSS regression tests cover the grid and padding. Before/after captures exist; pixel inspection and native-window verification remain unverified.

## Activity grouping, chiplet cards and the arced move (2026-10-26)

`[groups superseded 2026-11-03: see Activity follows the agent loop below; default grouping, chiplet cards and the move stand]`

`[implemented; unit-tested; verified in the hidden layout-evidence fixture (agent-activity-motion-sandbox.cjs) with before/after captures and motion frames in the default dark theme; packaged desktop app not checked]`

- **Activity is the default grouping.** A fresh panel (or **Reset to defaults**) groups agents by what they are doing: Needs input, Working, Error, Done, with Completed folded at the bottom. The menu calls it **Activity** and lists it first; Project and Date are still there. A window that already saved a view keeps it, so someone who used the view menu before sees no change until they pick Activity or reset. Dragging cards into order still needs Project grouping in Manual order, so it is off by default now.
- **Idle is now Done.** An agent that has stopped with nothing waiting on you is in **Done**, the same agents the Idle group held (finished turns, and agents kept idle by a watch). It is not the same as **Completed**, which still holds chats you closed out.
- **Cards are chiplets.** Each card is its own rounded tile with a full hairline border and a raised surface, a small gap between tiles, instead of a flush row with an accent spine on the left. The active chat's border takes the accent; a card waiting on you or stopped on an error keeps the highlighted background. Terminals stay neutral.
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
- **What an agent is doing now stays on the card:** the rocket while it works, the orange **?** when it waits on you, the warning on an error, the check when finished. An error has no group of its own, so a card stopped on an error stays in its phase. The wall's ring is unchanged.
- **A live group says so in its heading.** While a chat in Building or Verifying is working, and while Watching holds a chat, the heading shows a small Nekko animation after the name (hammering bricks, ticking a checklist, keeping watch by a radar ping) and a green count at the far right, open or folded. A phase group holding only chats stopped on an error shows neither, so it never looks busy. Other groups, and other groupings, keep the grey count shown when folded, also at the far right. The animation runs only in this panel and pauses, like all app animation, while the app is not active. **Settings > Accessibility > Agent activity animation** (on unless turned off) is the only switch for it: off holds Nekko on a still frame and keeps the green count. By the owner's decision it deliberately ignores the system's reduced-motion preference, including Windows with Animation effects off, so someone who relies on that preference must turn this setting off ([decision 0048](../../docs/decisions/0048-agent-activity-animation-answers-to-its-own-setting.md)).
- **Every window hears a move.** The engine works the phase out from the saved transcript (`crates/nekko-store/src/phase.rs`, which runs the shared tool-purpose fixture) and adds it to the chat's summary, so it survives a restart and reaches another computer's chats. Tool calls only stream to the windows showing a chat, so when a phase changes the engine sends `session_meta` once the step is saved, and every window re-reads its list. Each move costs one list refresh, not one per call.
- A working chat summarised by an older computer has no phase and shows in Exploring. Incognito chats are not saved, so they show in Exploring while they work too.
- Phones keep their own Status grouping (Needs you, Working, Idle). The summary carries the phase if they take it up later. No new storage, permissions or network use.

## Exploring folds into Building (2026-11-04)

`[implemented; unit-tested (agentPanelView, workingAgents, claudeAgentPlan, PlanRail, phase.rs, plan_update.rs); not yet watched in the packaged desktop app]`

**User intent:** Philip: "let's unify the exploring and building phases on the left agent panel and in the agent plan into just building phase", and "starting a fresh chat and kicking it off, I noticed that it went straight to done. Instead, it should be in exploring or building phase."

- **The groups** are Needs input, Draft, Building, Verifying, Watching and Done. Reading, searching and editing are all Building; the engine (`phase.rs`) names reads `building` too, keeping the wrap-up rule: within one reply, reads after a test or a push leave the chat where it got to. A summary from an older engine that still says `exploring` is filed under Building.
- **A chat just sent is Building at once.** The engine says nothing until the model's first token, which for a Claude Agent chat can take many seconds, and a sent chat with no status used to sit in Done meanwhile. The panel now hears the chat pane's own send (`reportAgentWorking` in `workingAgents.ts`) and marks the chat working the moment it is sent. Sends from another window or a phone still wait for the first event.
- **The agent plan** drops Explore the same way; see [the plan sheet](../chat/plan-sheet-on-the-composer.md).
- No storage, permissions or network use change.

## Subagents under their parent (2026-11-03)

`[implemented; unit tested; checked in an isolated hidden renderer, not in the packaged app]`

A subagent used to leave the panel the moment it had a reply and stopped running, and landed in the saved-chats list instead, so afterwards you could not see how the work was split. Now every subagent stays under its parent, in the order it was started, by the same rule as the rest of the panel: details show while they are relevant.

- A **working** subagent always has a row.
- A **finished** subagent keeps its row, with its done mark, while its chat is working or open, or while one of its subagents is open.
- Otherwise finished subagents fold away, and the card's **N sub-agents** line, which now counts all of them, stands in. Opening the chat brings them back.

Archived subagents do not appear. A subagent whose parent is archived stays in saved chats, as before.
