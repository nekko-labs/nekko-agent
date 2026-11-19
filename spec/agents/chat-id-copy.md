---
title: "Chat menu: copy chat ID with one click"
area: agents
---

# Chat menu: copy chat ID with one click

The chat context menu's first row shows the Chat ID (`s_...`). Previously the
user had to select the text manually to copy it.

## User intent

Right-click a chat in the agent list, then click the Chat ID row (or press
Enter/Space when it has focus) to copy the ID without leaving the menu. A brief
"Copied" confirmation replaces the copy icon for 1.5 s, then the icon returns.

## Behaviour

- **Single chat selected**: the Chat ID row is a focusable, clickable item. Hover reveals a copy icon (fades in via `quiet-row-action`). Click or Enter/Space copies the ID to clipboard and shows "Copied" for 1.5 s. Menu stays open.
- **Multi-select** ("N sessions selected"): row is unchanged -- no copy icon, no click action.
- **Archived chat menu**: no Chat ID row (unchanged).
- Keyboard: `role="menuitem"`, `tabIndex={0}`, Enter and Space both trigger copy. Screen readers receive an `aria-live="polite"` announcement when "Copied" appears.
- Motion: copy icon fades in at `--dur-fast` (120 ms) on hover/focus via the `quiet-row-action` / `data-quiet-row` CSS utility. "Copied" text appears as a status word change.
- Clipboard method: `navigator.clipboard.writeText`.
- Closing the menu resets the copied state.

## Acceptance criteria

- [ ] Right-click a single chat -> context menu opens with Chat ID row.
- [ ] Hover the Chat ID row -> copy icon appears.
- [ ] Click the row -> ID is on the clipboard, "Copied" appears briefly, menu stays open.
- [ ] Tab to the Chat ID row, press Enter -> same result.
- [ ] Tab to the Chat ID row, press Space -> same result.
- [ ] Right-click with multiple chats selected -> "N sessions selected" row has no copy icon or click action.
- [ ] "Copied" feedback disappears after ~1.5 s and copy icon is shown again on hover.

## Implementation

`apps/desktop/src/renderer/views/WorkspacesView.tsx`: the `{menu.ids.length === 1 ? ...}` branch of the context menu's first row is now a `role="menuitem"` div with `data-quiet-row` (for the icon's fade) and Click/KeyDown handlers. `copiedChatId` state drives the icon vs. "Copied" toggle. Closes #3047.

Status: implemented; desktop verification pending.
