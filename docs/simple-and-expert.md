# Simple and Expert

Nekko Agent has two modes. **Simple** is the everyday app: you pick a model, type, and read the answer, and the controls developers use stay out of sight. **Expert** shows every control. Everything works in both modes; Simple only hides controls, never a page.

## Switching

The switch has two icons: a chat bubble for Simple and angle brackets for Expert.

- **Desktop:** in the title bar, beside the page name.
- **iPhone and Android:** at the top left of a chat and of the chats list.

Each computer and phone remembers its own mode. A new install starts in Simple.

## What Simple leaves out

By default, Simple shows the model name and picker and prompt suggestions, and keeps these for Expert:

- **In a chat:** effort, the context ring, cost and limits, the Mode panel, Privacy Shield, the Tools and MCP menus, the git checkout chip, Changes, Logs and the hardware strip.
- **In replies:** the reasoning text (folded to one line), reply stats, and pull request cards.
- **Elsewhere:**
  - the Terminal entries on the agents wall, the model and token line on window cards, and the hardware and budget monitors
  - CI runners in Workflows
  - the Model Server's settings and expert load flags
  - Settings' Tools group, folded behind **Show advanced settings**

## Choosing what Simple shows

Open **Settings > Simple mode**. Each area of the app is drawn beside its controls, and each control has three choices:

- **Show:** in both modes.
- **Expert only:** out of sight in Simple.
- **Hide:** out of sight in both modes.

Use the **Preview** switch to see the drawings as Simple or as Expert. Controls the previewed mode leaves out are drawn dashed. **Reset to defaults** puts every control back.

## The chat details panel

On the desktop, the row under the message box (folder, model, effort, context, cost, tools, MCP and internet) is part of the message box. The arrow at its right end shrinks it to the model alone and opens it again; the app remembers which you chose.
