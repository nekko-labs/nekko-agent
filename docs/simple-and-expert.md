# Simple and Detailed

Nekko Agent has two modes. **Simple** is a cleaner, more focused view: details show only when they matter. **Detailed** shows every control. Everything works in both.

## Switching

The switch has two icons: a chat bubble for Simple and angle brackets for Detailed.

- **Desktop:** in the title bar, beside the page name.
- **iPhone:** at the top of the chats list's view menu (the filter icon) and of a chat's **More** menu.
- **Android:** in the floating pill just under the top bar, in a chat and in the chats list.

Each computer and phone remembers its own mode. A new install starts in Simple.

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
- **Asks first** is how the agent checks with you. Choose **Asks first**, **Asks when it matters** or **Works on its own**. Each choice has the same icon as in Expert's Mode panel (a hand, a shield and a bolt) and a one-line description.
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
- **Asks first** sits beside the model in Simple, and in **More** in Detailed.
- **Changes** is in **More** on the iPhone and an icon with a count on Android, once the agent has changed files.
- **The pill:** it shows while the hardware gauges do (on Android it also holds the switch). Tap the gauges and the pill opens into the agent's details (hardware, loaded models, this chat). Point at one gauge with a mouse for its reading in full. The pill slides away while you scroll on and comes back when you scroll back.
- **Moving the pill:** touch and hold it, then drag. Let go near the left or right edge to dock it there, stacked; anywhere else it lies across the screen at that height. Drag it back near the top to put it under the bar again.
- **Search** is in the computer menu at the top left: **Search chats**.
- **Logs** in the same menu are grouped: what this phone logged, then each computer.
