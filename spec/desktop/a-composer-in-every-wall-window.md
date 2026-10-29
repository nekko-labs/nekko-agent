---
title: "A composer in every wall window (implemented 2026-10-28; desktop build check pending)"
area: desktop
---

# A composer in every wall window (2026-10-28)

Issue: [#1317](https://github.com/nekko-labs/nekko-agent/issues/1317). Decision: [0030](../../docs/decisions/0030-a-composer-in-every-wall-window.md). Supersedes the shared wall composer described under *Agent board: the wall* in [chat and cowork](../chat/chat-cowork-unified-surface.md).

## Intent

One composer for the whole wall made the user pick a window before typing and left it unclear which agent a message went to. The user wants each agent window to carry its own composer again, with fewer borders and cleaner lines.

## Behavior (implemented)

- In the tiled layouts (Dynamic and Fixed), every agent window is the full chat: transcript, plan sheet and its own composer at the foot. The shared wall composer, its six-place dock picker, its resize grips and the tether to the selected window are gone. A saved dock or composer size from before is ignored.
- The **selected** window's composer is open: the editor, then one bar. The other windows' composers **rest as one row**: **+**, the draft (or the placeholder) and Send. Clicking a window, Ctrl+Tab / Ctrl+Shift+Tab or Ctrl+1…9 selects it, opens its composer and puts the caret in it. Drafts stay with their window.
- The composer bar, left to right: **+** (Photo / Video, File, Folder, Skill), the **model**, the **Mode** button and **Automate**; then Stop while a reply runs, the microphone and **Send**. Approvals (Ask, Guardrails, YOLO), effort, internet, incognito, tools and folders live in the Mode panel, not on the bar. The bar never wraps: labels truncate.
- Send is a plain arrow on the wall (it queues while a reply runs). The pixel Nekko moved to the window header.
- No strip above the editor and no footer row under the composer on the wall. The Agent tab's own chat is unchanged.
- **Window header**: an agent window shows its keyboard number, then **Nekko as the agent's icon** (the robot head is gone), wearing a status badge; a terminal shows the terminal icon, then the same Nekko. The badge is the iPhone Live Activity's shapes and tints, drawn dark on the tint. Working is a rocket on green, needs you a question mark on orange, stopped with an error a cross on red, done a check on green (Nekko smiles), watching Zz on blue (Nekko sleeps). It never animates on the wall. A terminal uses the same mascot: asleep while its shell is open, done or failed once the shell exits by its exit code.
- **Terminal icon, everywhere.** The app's terminal icon is a bare prompt and cursor (`>_`) without a frame, in every place it appears (toolbar, menus, window headers, sidebar, settings).
- Focus is unchanged: the hero is the full chat; the parked ones keep their composers as before.

## Not done

- A terminal cannot yet tell a running command from an idle prompt, so an open shell shows as asleep rather than working.
- The shared composer's component (`WallComposer`), its sizing helpers and the hidden-capture scripts written for it are no longer used and are still in the tree; removing them is a follow-up.

## Verification

Unit coverage: `WallWindowComposer.test.tsx` (bar order, resting row, no footer, arrow Send, terminal status), `StatusIcon.test.tsx` (header order and badges), `CommandWall.test.tsx` (every tiled chat is full), `composerSizing.test.ts` and `AgentPanelHeader.test.tsx` (no shared composer row). Hidden, off-screen Electron captures (`wall-composers-sandbox.cjs`) check three tiled windows each with a composer, only the selected one open, a resting composer under 64 px tall, the header order and badge, and that clicking another window opens its composer and rests the first. Not checked in a packaged build.
