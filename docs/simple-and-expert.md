# Simple and Detailed

Nekko Agent has two modes. **Simple** is a cleaner, more focused view: details show only when they matter. **Detailed** shows every control. Everything works in both.

## Switching

The switch has two icons: a chat bubble for Simple and angle brackets for Detailed.

- **Desktop and Local Web UI:** open **View** in the app’s top-right corner. Under **Interface detail**, select the **Simple** or **Detailed** radio row. **Customize** opens **Settings > Customize**, not a modal. These app-wide controls no longer sit in the agent panel’s view menu.
- **iPhone:** at the top of the chats list's view menu (the filter icon) and of a chat's **More** menu.
- **Android:** at the top of the chats list's view menu (the sort icon) and of a chat's ⋮ menu.

Each computer and phone remembers its own mode. A new install starts in Simple.

## Agent output detail

On desktop and the Local Web UI, open **Customize > Experience > Agent output detail**. The same three choices appear in the first-run introduction:

- **Minimal:** Simple mode with the Changes chip, prompt suggestions and context ring hidden, for fewer extras. Reply statistics stay out of sight.
- **Regular:** Simple mode with those extras at their defaults and a tidy summary of the agent's work.
- **Detailed:** Detailed mode, with tool steps, reasoning when the provider supplies it, and reply statistics.

Try each choice beside the animated sample reply. It is an illustrative example, not a live agent run. Pause or play the preview; Reduce Motion shows the finished example instead. The choice saves immediately on this device and is restored when you reopen Customize. It does not change answer length, model instructions, permissions or the monitors you selected. Other per-control overrides still apply. Choosing Regular or Detailed resets the three Minimal-specific overrides to their defaults.

The iPhone and Android still use their existing native Simple/Detailed controls; the three-choice Customize section described here is the shared desktop/web surface.

## What shows when

Some things appear only when they mean something, in both modes:

- **Changes** appears once the agent has changed files, and says how many: *3 files changed*.
- **Pull request status** appears once the chat has a pull request.
- **The hardware gauges** under a chat's title appear while a local model is running on this computer or on a connected one. **Settings > Simple mode** can keep them on all the time.

## The Monitors panel on the agents wall

The monitors you tick in the panel's **Configure** menu are exactly the ones it shows, in Simple and in Detailed. Switching modes only opens or closes the panel; it never changes which monitors are in it. Simple starts with the panel closed and Detailed with it open, and each mode remembers whether you last opened or closed it there.
- **Anything about other computers** appears once you have connected one. To connect the first, switch to Detailed and open **Settings > Computers**.

## What Simple shows

In the message box's bottom row, Simple shows the folder, the model, how the agent asks you, and a ring for how full the chat is. Hover over the ring for the numbers.

- **Effort** is inside the model menu.
- **Approvals** controls when the agent checks with you. Choose **Always ask**, **Ask when it matters** or **No restrictions**. These names are the same in Simple, Detailed, Settings, and on phones. Each choice uses a Gentleface icon: hand, shield with a check, and running person. Detailed shows approvals beside the model too, with **Mode** and its secondary controls on the next row inside the message box. The row wraps when needed instead of squeezing the labels.
- The **Approvals** menu ends with a row of three icon switches: **Incognito**, **Privacy Shield** and **Internet access**. Each is the same setting as in the Mode panel, so switching it here changes it everywhere. The menu stays open while you flip them. Internet access stays on while the chat uses a cloud model. In a sandbox the menu still opens for these switches, but approvals stay on **Always ask**.
- Choosing **No restrictions** first shows a warning on desktop and phones: the agent never asks, so a web page or tool output it reads can get your files or data sent out. Deny rules still block. Tick **Don't warn me again** to skip the warning; **Settings > General > Warn before No restrictions** turns it back on on desktop. The desktop warning applies in the Mode panel, the Settings default, saved modes, and the approval bar's **Allow all** buttons. Sandbox remains locked to **Always ask**.
- **Incognito and Automate** are in the **+** menu.
- **The Agent Monitor** appears while agents are working in the background.
- **In replies:** the agent's steps sit under the same one-line summary as in Detailed, such as *Read guidance*. Click the arrow beside it to see each step. The model's thinking stays out of sight; Detailed shows it. On a phone, each reply's thinking and steps fold into one line, such as *Took 4 steps*, with **Show steps** to open them.

Simple keeps these for Detailed:

- **In a chat:** cost and limits, the Mode panel, Privacy Shield, the Tools and MCP menus, the internet switch, the git checkout chip and Logs.
- **In replies:** reply stats.
- **Elsewhere:**
  - the Terminal entries on the agents wall and the model and token line on window cards
  - CI runners in Workflows
  - the Model Server's settings and expert load flags
  - Settings' Tools group, folded behind **Show advanced settings**

To reach a control Simple keeps out of sight, switch to Detailed, or search for it in the command palette (Ctrl+K, or Cmd+K on a Mac).

When a chat gets close to the most the model can read at once, Simple says how many tokens starting a fresh chat would save, with a **Start fresh** button.

## Choosing what Simple shows

Open **Settings > Simple mode**. Each area of the app is drawn beside its controls, and each control has three choices:

- **Show:** in both modes, whenever it applies.
- **Detailed only:** out of sight in Simple.
- **Hide:** out of sight in both modes.

The hardware gauges wait for a local model instead, so theirs are **When running**, **Always** and **Hide**. The Monitors panel is not on this page: its own **Configure** menu chooses its monitors for both modes.

Use the **Preview** switch to see the drawings as Simple or as Detailed. Controls the previewed mode leaves out are drawn dashed. **Reset to defaults** puts every control back.

## The chat details panel

In Detailed on the desktop, the bottom row (folder, model, effort, context, cost, tools, MCP and internet) is part of the message box. The arrow at its right end shrinks it to the model alone and opens it again, and Nekko Agent remembers which way you left it.

## On the phones

- **Effort** is in the menu under the model's name: a bar you slide or tap to set how hard the model thinks. The fuller the bar, the higher the effort. Detailed also shows a small dial beside the name.
- **Approvals** sits beside the model in Simple, and in **More** in Detailed.
- **Changes** is in **More** on the iPhone and an icon with a count on Android, once the agent has changed files.
- **The pill:** it shows while the hardware gauges do, on the iPhone and on Android alike. Tap the gauges and the pill opens into the agent's details (hardware, loaded models, this chat). Point at one gauge with a mouse for its reading in full. The pill slides away while you scroll on and comes back when you scroll back.
- **Moving the pill:** touch and hold it, then drag. Let go near the left or right edge to dock it there, stacked; anywhere else it lies across the screen at that height. Drag it back near the top to put it under the bar again.
- **Tucking the pill away:** swipe it into its edge (a side it is docked at, or up into the bar) and only a slim arrow tab stays. Tap the tab, or swipe it back out, to bring the pill back.
- **Search** is in the computer menu at the top left: **Search chats**.
- **Logs** in the same menu are grouped: what this phone logged, then each computer.
