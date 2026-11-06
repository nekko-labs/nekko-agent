---
title: "Desktop: Simple and Detailed modes, what Simple hides, Settings > Simple mode and the composer details panel (2026-10-25, reframed 2026-10-28)"
area: desktop
---

# Desktop: Simple and Detailed modes (2026-10-25)

**Design principle: contextual relevance (Philip, 2026-11-03).** Simple is "when you want a cleaner, more focused view, not just non-dev mode", primarily for non-developers and for developers too. "Having details only show when relevant is key here. Contextual relevance is important to me." So a control that means nothing right now is not on screen, in either mode where that makes sense, and capability never goes away, only what sits on screen. Every new control answers two questions before it lands: when does this mean something, and what does Simple do the rest of the time.

**User intent:** Philip asked (2026-10-25) that the iPhone's new chat design ([iPhone: Simple and Detailed modes](../phone/iphone-simple-and-expert-modes.md)) also apply to the Electron desktop app, the most important surface for it, and that wide phones (open folding phones) get similar controls.

**Reframed 2026-10-28 (#1311):** Philip asked (2026-10-27) for Simple to become the experience for people who are not developers: the same capabilities, with developer controls such as effort, the context gauge and reasoning out of sight, and Settings choosing, per control, what Simple shows. He reviewed the [design](../../docs/decisions/0044-simple-hides-developer-controls-per-device.md) (per device, Simple for new installs, controls not pages), then asked for three states per control (Show, Detailed only, Hide), a drawn preview beside each area's switches, and the row under the composer to become an expandable panel of the composer.

**Status `[implemented 2026-10-28 and refreshed 2026-11-03 in apps/desktop on branch simple-expert-modes, not merged; catalogue unit-tested in packages/shared; renderer tests pass; captured in the hidden chat-modes harness (40 assertions, a scene per situation: clean Simple, a local model here and on a connected computer, changed files, a PR, background agents, a long chat, a wall window, both menus, Expert (the label at capture time), the shrinking panel and the Settings previews); not tried in the packaged app, against a real connected computer or on a real machine]`**

## Label refresh (verification pending)

Desktop and native UI labels now use **Simple** and **Detailed**, including tooltips, command palette actions, Settings choices (**Detailed only**) and previews. This is a display-label change only: stored `expert` mode and catalogue values, persistence keys, defaults and visibility rules remain unchanged. Existing preferences need no migration. Filenames and links retain their existing paths. Renderer/shared focused tests, desktop accessibility/settings assertions, native resource/catalog checks and Android app/test compilation pass. Matched native CI capture completed (iOS evidence tests pass; Android has matched baseline failures tracked in #1707); visual inspection is pending. Earlier verification above does not verify this label refresh.

## Behaviour

- **The switch.** Two icon segments in the title bar, beside the page name: a chat bubble (*Simple: everyday controls*) and angle brackets (*Detailed: every control*). Where there is no title bar (the browser builds) it sits at the top left of every chat. Kept on this computer (`localStorage`, `nekko.chatMode`), shared by every window, Simple for a new install. No keyboard shortcut: Ctrl+Shift+E already completes a chat.
- **The catalogue.** `packages/shared/src/simple-mode.ts` lists each control with its area, platforms and default. `simpleShown` decides, in this order: **Hide** always wins; a control with `needs` shows only while that holds, in every mode; **auto** waits for its condition in both modes; **Show** is on in both modes; **Detailed only** is on in Detailed, and in Simple while its `when` condition holds. The person's choices that differ from the defaults are kept on this computer (`nekko.simpleChoices`); unknown ids and values an item does not offer are ignored. Defaults: Show for the model picker, effort, Asks first, the usage ring, prompt suggestions, Changes and PR status; auto for the monitors; Detailed only for everything else. Simple never hides a page, with one exception: Settings > Computers stays out of Simple until a computer is connected.
- **What Settings offers.** Show, Detailed only and Hide. Show means both modes whenever the control applies. A monitor offers **When running** (its default), **Always** (pins it on) and **Hide**; Detailed only would mean nothing there, because Detailed also waits for a local model.
- **What makes a control relevant.**
  - *A local model is running:* `localModelRunning` in `packages/shared/src/simple-mode.ts` is the one check. It reads this computer's Model Server, and each connected computer that is online with Read on, through the existing `computers:call` of `engine:status`, the phone view of that channel. It is read every 10 s while anything on screen listens. Read off counts as no model. The strip reads the machine the model runs on (`localModelHost`): this device if one runs here, else the first connected computer running one, and it names that computer beside the count, so one machine's dials never sit next to another's model.
  - *This chat has changed files:* `listChanges`, as the header already counted them.
  - *This chat has a pull request:* the chat's PRs, or a PR its tool calls opened.
  - *Agents are at work in the background* (`agentMonitorRelevant`): a sub-agent of this chat has a live run, or its Claude Code reports background tasks. Queued messages stay out, because they are already above the message box, and so do artifacts, which are not news.
  - *A computer is connected:* `store.computers` is not empty.
- **Desktop controls in the catalogue.**
  - **Chat header:** git checkout chip (`worktree`), Changes (`changes`, contextual, reading *3 files changed*, with the lines added and removed in Detailed), Logs (`logs`), the Agent Monitor (`agent-monitor`), the hardware strip (`hardware`).
  - **Message box:** model picker (`model`; shown regardless while the chat has no usable model), effort (`effort`), Asks first (`asks`), usage ring (`context`), cost and limits (`cost`), the Mode button and panel (`mode`), Privacy Shield (`privacy`), Tools and MCP menus (`tools`), the internet switch (`internet`), prompt suggestions (`suggest`).
  - **Conversation:** reasoning and tool steps (`thinking`). Out of sight, each turn's thoughts and tool steps fold behind one line, *Took 4 steps* (*Working · 2 steps so far* while it runs, *Thought it through* with no tools), with **Show steps** / **Hide steps** for that turn, remembered while the row is in the transcript; reply stats (`stats`); PR status (`pr-status`, contextual): the live PR card in the chat and the plan sheet's PR and CI chips. Hidden, an open PR stays a plain card.
  - **Agents wall:** Connected computers (`computers`, contextual): Run on, the computer chip on a card, grouping by computer, computer icons and the hardware switch; Terminal in New, the window picker, the split compass and an empty zone's options (`terminal`); the model and token line on deck cards (`cardmeta`). The Monitors panel is not in the catalogue: see [The Monitors panel](#the-monitors-panel-2026-11-06).
  - **Workflows:** the CI runners section and its switch (`ci`).
  - **Models:** the Model server settings fold and a model's Expert load flags (`engine`).
  - **Settings:** the Tools group (git, pull requests, terminal, MCP), folded behind one *Show advanced settings* row (`set-tools`).
  - Keyboard shortcuts (a new terminal, for one) still work in Simple.
- **Finding controls that are out of sight.** The command palette (Ctrl/Cmd+K) offers *Switch to Detailed* / *Switch to Simple*, *Choose what Simple shows*, and every desktop control out of sight in the current mode. A Detailed-only one is marked *Shown in Detailed* and switches to Detailed; a hidden one is marked *Hidden in Settings* and opens Settings > Simple mode. Settings search finds every control on the Simple mode page, and the folded Tools group by its section names.
- **Settings > Simple mode.** A Settings group after Style. An intro, how many controls are out of sight in Simple, a **Preview** switch (Simple or Detailed) and **Reset to defaults**. Then one block per area: a drawing of the area on the left, built from its controls, and a row per control on the right with its hint and a Show / Detailed only / Hide switch (marked *changed* when it differs from the default). In the drawing, a control the previewed mode leaves out keeps a dashed, faded outline; hovering a row rings its control.
- **The row under the message box.** In Simple it holds the folder, the model picker, effort, **Asks first**, a spacer and the usage ring. A chat with the internet off or Incognito on also says so there, because those are worth seeing when they are on, and a control the person pinned with Show joins the row. In Detailed it is the details panel as before: everything the mode allows, with an arrow at its right end that shrinks it to the model and effort (`nekko.composer.details`). A window on the agents wall has no such row: its message box keeps the model, effort and Mode (Asks first in Simple) in its own row, and effort sits beside the model ([a composer in every wall window](a-composer-in-every-wall-window.md)).
- **Effort in both modes** sits beside the model by default, including wall windows. The borderless Effort button opens a dial and a range slider using only the model's provider-advertised choices; there is no Normal stop. Unknown capabilities show a disabled control explaining that the provider has not reported choices. Auto's quality stays in the model menu in Simple. Explicit Hide preferences remain respected.
- **Composer model title and suggestions (#1687).** The model button shows its title only; provider/account details remain in the menu and tooltip. Prompt suggestions sit in the composer's action bar, immediately left of the microphone, in Detailed only, and never appear in Simple. `[updated 2026-11-06]` This replaces their own bottom row: the row appeared after the 12th typed character and made the message box taller mid-keystroke, so the chip now takes space already in the bar and the box keeps its height. When the bar is crowded the chip gives up its words before the model and Mode give up theirs, down to its grade badge, with the count kept in its accessible name. Implemented in the renderer; covered by renderer tests and the hidden plum fixture, which also checks the box height before and after typing.
- **Asks first** is a plain view of the chat's existing tool policy, with no new behaviour: *Asks first* (`ask`), *Asks when it matters* (`guardrails`), *Works on its own* (`yolo`). There is no Plan option, because the tool policy has no plan value. Each option in its menu shows an icon, its description and a check on the current one. `ask` and `guardrails` use the icons Expert's Mode panel uses in its Approvals tiles (hand, and shield with a check); `yolo` uses the 🙌 hands-up emoji, in the current-value chip and the menu choice, where Expert's tile keeps its bolt. This is visual only, not a change to approvals. The menu opens 400px wide so each description fits on one line (implemented and verified in a hidden fixture at 1100px and 435px windows, 2026-11-06), and narrows to the window, keeping 8px clear on each side, on anything smaller. A sandbox always asks, so there it is read-only. It shows only while the Mode button does not, which keeps the full Mode panel for Detailed.
- **The usage ring** is the context ring without its count; the numbers are in its tooltip.
- **The strip above the message box** goes in Simple, unless the person pinned Mode or Privacy Shield. Incognito and Automate move into the **+** menu; they stay where they are in Detailed.
- **The Agent Monitor** is a button in the chat's header, never over the transcript. In Simple it shows only while agents work in the background, and the panel opens only from that button. Once open it stays until it is closed, so a run ending never pulls it away from someone reading it. Detailed keeps the panel open by default, as before.
- **The hardware strip and monitor** are unchanged from 2026-10-25, under the `hardware` control:
  - **The strip:** dials for CPU, memory, GPU and VRAM, and the number of loaded models.
  - **Clicking the strip** opens the **Local models** monitor.
- **A chat getting long (Simple only).** When the chat's context reaches 85% of the model's window, a line above the composer, clear of the cat, says *This chat is getting long. Starting fresh saves about N tokens.*, where N is the conversation's tokens in the context breakdown, with **Start fresh** (a new chat in the same folder) and **Not now** (until the app restarts, for that chat).
- **Effort and context in Detailed** keep their 2026-10-25 forms, the dial with a popover and the ring with a count.

## The Monitors panel (2026-11-06)

Issue: [#1887](https://github.com/nekko-labs/nekko-agent/issues/1887), following [#1666](https://github.com/nekko-labs/nekko-agent/issues/1666). Philip (2026-11-06): "the checked ones should match what's shown. Simple vs detailed view should only show/hide the panel."

- **The checked monitors are the one source of truth.** The monitors ticked in the panel's **Configure** menu are exactly the monitors it shows, in Simple and in Detailed, and its count (*5 of 6*) counts them. No mode, catalogue entry, Settings > Simple mode choice or local-model check filters them; a monitor with nothing to report (Local models with no engine, say) shows its own empty state rather than vanishing.
- **The mode only opens or closes the panel.** Each mode remembers its own open or closed state on the wall (`dock.show` for Detailed, `dock.simpleShow` for Simple). Simple starts closed, Detailed starts open, and the panel's hide and show buttons change only the current mode's state. Switching modes never changes which monitors are checked, their order or which are minimized.
- **Removed:** the `mon-hw` (Hardware, Local models; waited for a local model in both modes) and `mon-budget` (Budget, Utilization; Detailed only) catalogue items, their Settings > Simple mode rows and drawing. Saved choices for them are ignored on load. They filtered the checked monitors without touching the checkboxes, so Simple with five monitors checked showed one (Automations), and Detailed without a local model showed three.

Status `[implemented 2026-11-06 in apps/desktop and packages/shared; unit-tested (MonitorsMode.test.tsx renders the real dock with useShown and the local-model probe unmocked, in both modes); captured in the hidden full-App fixture (monitors-mode-sandbox.cjs) before and after: Simple 5 checked / 1 shown before, 5 / 5 after; not tried in the packaged app]`

## Message box bottom row (2026-11-03)

Issue: [#1599](https://github.com/nekko-labs/nekko-agent/issues/1599). Philip: nothing should ever go below the message box; a lower row belongs inside it.

- **Simple and Detailed.** The row under the message box (the details panel above) is the box's own bottom row, under the editor and the bar with + and Send, behind a hairline. The "this chat needs a model" note sits at the top of that row, inside the box.
- **New chat.** On the wall's new chat the model and effort already ride the composer's bar, so the copy that floated under the box is gone. A new chat outside the wall keeps the model and effort as the box's bottom row.
- **Wall windows** still have no footer row ([a composer in every wall window](a-composer-in-every-wall-window.md)). An archived chat has no message box and now shows no footer either.
- Nothing renders under the message box in any of these.

Verification: `AgentWindowIndicators.test.tsx` and `cleanStart.test.tsx` check the controls sit inside the box after its bar and that no control follows the box; captured before and after in the hidden chat-modes and new-chat harnesses.

## Wide phones

- **iPhone app, regular width** (an open folding phone, iPad): each pane in `PanesView` shows the same `ChatView`, so the switch, the model and effort control, the context gauge and the Detailed panel apply per pane.
- **Android** (Galaxy Fold and other foldables): the same design since 2026-10-25 (T217b), see [iPhone Simple and Detailed modes, Android](../phone/iphone-simple-and-expert-modes.md#android-2026-10-25-t217b).

## Not yet

- Unload from the desktop's Detailed monitor.
- A real-hardware check (NVIDIA, Apple Silicon unified memory) of the strip's labels and temperatures.

### Composer spacing (#1791)

Implemented in the shared renderer: the effort gauge trigger has no enclosing border (hover and keyboard focus feedback remain). `[updated 2026-11-06]` Prompt Suggestions sits in the model/action bar beside the microphone, in new and full chats, in Detailed only (see *Composer model title and suggestions* above); it no longer has a row of its own. Windows desktop/narrow synthetic verification is tracked in #1791; packaged and native mobile UI are outside this change.
