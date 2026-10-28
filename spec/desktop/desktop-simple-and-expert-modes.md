---
title: "Desktop: Simple and Expert modes, what Simple hides, Settings > Simple mode and the composer details panel (2026-10-25, reframed 2026-10-28)"
area: desktop
---

# Desktop: Simple and Expert modes (2026-10-25)

**User intent:** Philip asked (2026-10-25) that the iPhone's new chat design ([iPhone: Simple and Expert modes](../phone/iphone-simple-and-expert-modes.md)) also apply to the Electron desktop app, the most important surface for it, and that wide phones (open folding phones) get similar controls.

**Reframed 2026-10-28 (#1311):** Philip asked (2026-10-27) for Simple to become the experience for people who are not developers: the same capabilities, with developer controls such as effort, the context gauge and reasoning out of sight, and Settings choosing, per control, what Simple shows. He reviewed the [design](../../docs/decisions/0030-simple-hides-developer-controls-per-device.md) (per device, Simple for new installs, controls not pages), then asked for three states per control (Show, Expert only, Hide), a drawn preview beside each area's switches, and the row under the composer to become an expandable panel of the composer.

**Status `[implemented 2026-10-28 in apps/desktop on branch simple-expert-modes, not merged; catalogue unit-tested in packages/shared; renderer tests pass; captured in the hidden chat-modes harness (18 assertions: Simple and Expert controls, the shrinking panel, the Settings previews and a choice reaching the chat); not tried in the packaged app or on a real machine]`**

## Behaviour

- **The switch.** Two icon segments in the title bar, beside the page name: a chat bubble (*Simple: everyday controls*) and angle brackets (*Expert: every control*). Where there is no title bar (the browser builds) it sits at the top left of every chat. Kept on this computer (`localStorage`, `nekko.chatMode`), shared by every window, Simple for a new install. No keyboard shortcut: Ctrl+Shift+E already completes a chat.
- **The catalogue.** `packages/shared/src/simple-mode.ts` lists each control Simple can hide, with its area, platforms and default. Each is **Show** (both modes), **Expert only** or **Hide** (neither); the person's choices that differ from the defaults are kept on this computer (`nekko.simpleChoices`). Unknown or malformed saved values are ignored. Defaults: Show for the model picker, the context ring and prompt suggestions (Philip, 2026-10-28: "simple shows context"), Expert only for everything else. The monitors (`hardware`, `mon-hw`, and the phone's `ph-monitors`) at Expert only also show in Simple **while a local model is loaded** on the Model Server (Philip, 2026-10-28); the desktop reads `engine:status` every 10 s while any gated control is on screen. Show always shows them, Hide never does. Simple never hides a page.
- **Desktop controls in the catalogue.**
  - **Chat header:** git checkout chip (`worktree`), Changes (`changes`), Logs (`logs`), the hardware strip (`hardware`).
  - **Message box:** model picker (`model`; shown regardless while the chat has no usable model), effort (`effort`), context ring (`context`), cost and limits (`cost`), the Mode button and panel (`mode`), Privacy Shield (`privacy`), Tools and MCP menus (`tools`), prompt suggestions (`suggest`).
  - **Conversation:** reasoning and tool steps (`thinking`). Out of sight, each turn's thoughts and tool steps fold behind one line, *Took 4 steps* (*Working · 2 steps so far* while it runs, *Thought it through* with no tools), with **Show steps** / **Hide steps** for that turn, remembered while the row is in the transcript; reply stats (`stats`); the pull request dock (`ph-git`).
  - **Agents wall:** Terminal in New, the window picker and the split compass (`terminal`); the model and token line on deck cards (`cardmeta`); the Hardware and Local models monitors (`mon-hw`); Budget, Utilization, Cost and Tokens monitors (`mon-budget`).
  - **Workflows:** the CI runners section and its switch (`ci`).
  - **Models:** the Model server settings fold and a model's Expert load flags (`engine`).
  - **Settings:** the Tools group (git, pull requests, terminal, MCP), folded behind one *Show advanced settings* row (`set-tools`).
  - Keyboard shortcuts (a new terminal, for one) still work in Simple.
- **Finding controls that are out of sight.** The command palette (Ctrl/Cmd+K) offers *Switch to Expert* / *Switch to Simple*, *Choose what Simple shows*, and every desktop control out of sight in the current mode. An Expert-only one is marked *Shown in Expert* and switches to Expert; a hidden one is marked *Hidden in Settings* and opens Settings > Simple mode. Settings search finds every control on the Simple mode page, and the folded Tools group by its section names.
- **Settings > Simple mode.** A Settings group after Style. An intro, how many controls are out of sight in Simple, a **Preview** switch (Simple or Expert) and **Reset to defaults**. Then one block per area: a drawing of the area on the left, built from its controls, and a row per control on the right with its hint and a Show / Expert only / Hide switch (marked *changed* when it differs from the default). In the drawing, a control the previewed mode leaves out keeps a dashed, faded outline; hovering a row rings its control.
- **The composer details panel.** The row that sat under the composer card (folder, model and effort, context ring, cost, Tools, MCP, internet) is now a panel inside the card, under the toolbar, with an arrow at its right end. Shrunk, it keeps only the model picker; open, it shows everything the mode allows. The choice is remembered across chats (`nekko.composer.details`). The wall's shared composer has no panel, as before.
- **Expert: the hardware strip and monitor** are unchanged from 2026-10-25, now under the `hardware` control:
  - **The strip:** dials for CPU, memory, GPU and VRAM, and the number of loaded models.
  - **Clicking the strip** opens the **Local models** monitor.
- **A chat getting long (Simple only).** When the chat's context reaches 85% of the model's window, a line above the composer says *This chat is getting long. Starting fresh saves about N tokens.*, where N is the conversation's tokens in the context breakdown, with **Start fresh** (a new chat in the same folder) and **Not now** (until the app restarts, for that chat).
- **Effort and context** keep their 2026-10-25 forms, the dial with a popover and the ring with a count, whenever they are shown.

## Wide phones

- **iPhone app, regular width** (an open folding phone, iPad): each pane in `PanesView` shows the same `ChatView`, so the switch, the model and effort control, the context gauge and the Expert panel apply per pane.
- **Android** (Galaxy Fold and other foldables): the same design since 2026-10-25 (T217b), see [iPhone Simple and Expert modes, Android](../phone/iphone-simple-and-expert-modes.md#android-2026-10-25-t217b).

## Not yet

- Unload from the desktop's Expert monitor.
- A real-hardware check (NVIDIA, Apple Silicon unified memory) of the strip's labels and temperatures.
