# Simple and Expert

Nekko Agent has two modes. **Simple** is the everyday app: you pick a model, type, and read the answer, and the controls developers use stay out of sight. **Expert** shows every control. Everything works in both modes; Simple only hides controls, never a page.

## Switching

The switch has two icons: a chat bubble for Simple and angle brackets for Expert.

- **Desktop:** in the title bar, beside the page name.
- **iPhone and Android:** in the floating pill just under the top bar, in a chat and in the chats list.

Each computer and phone remembers its own mode. A new install starts in Simple.

## What Simple leaves out

By default, Simple shows the model name and picker, effort, how full the chat is (the context ring) and prompt suggestions, and keeps these for Expert:

- **In a chat:** cost and limits, the Mode panel, Privacy Shield, the Tools and MCP menus, the git checkout chip, Changes, Logs and the hardware strip.
- **In replies:** each reply's thinking and steps fold into one line, such as *Took 4 steps*, with **Show steps** to open them; reply stats and pull request cards are kept for Expert.

To reach a control Simple keeps out of sight, switch to Expert, or search for it in the command palette (Ctrl+K, or Cmd+K on a Mac).
- **Elsewhere:**
  - the Terminal entries on the agents wall, the model and token line on window cards, and the hardware and budget monitors
  - CI runners in Workflows
  - the Model Server's settings and expert load flags
  - Settings' Tools group, folded behind **Show advanced settings**

While a local model is loaded on your computer, the hardware gauges and the local models monitor show in Simple too, so you can see what the model is using.

When a chat gets close to the most the model can read at once, Simple says how many tokens starting a fresh chat would save, with a **Start fresh** button.

## Choosing what Simple shows

Open **Settings > Simple mode**. Each area of the app is drawn beside its controls, and each control has three choices:

- **Show:** in both modes.
- **Expert only:** out of sight in Simple.
- **Hide:** out of sight in both modes.

Use the **Preview** switch to see the drawings as Simple or as Expert. Controls the previewed mode leaves out are drawn dashed. **Reset to defaults** puts every control back.

## The chat details panel

On the desktop, the row under the message box (folder, model, effort, context, cost, tools, MCP and internet) is part of the message box. The arrow at its right end shrinks it to the model alone and opens it again; the app remembers which you chose.

## On the phones

- **Effort** opens from the small dial beside the model's name: a bar you slide or tap to set how hard the model thinks. The fuller the bar, the higher the effort.
- **The pill:** while the gauges show, tap them and the pill opens into the agent's details (hardware, loaded models, this chat). Point at one gauge with a mouse for its reading in full. The pill slides away while you scroll on and comes back when you scroll back.
- **Moving the pill:** touch and hold it, then drag. Let go near the left or right edge to dock it there, stacked; anywhere else it lies across the screen at that height. Drag it back near the top to put it under the bar again.
- **Search** is in the computer menu at the top left: **Search chats**.
- **Logs** in the same menu are grouped: what this phone logged, then each computer.
