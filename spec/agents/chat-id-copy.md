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
"Copied" confirmation crossfades over the copy icon for 1.5 s, then the icon
returns. Clicking again while "Copied" is showing resets the 1.5 s clock.

## Behaviour

- **Single chat selected**: the Chat ID row is a focusable, clickable item. Hover reveals a copy icon (fades in via `quiet-row-action`). Click or Enter/Space copies the ID to clipboard and shows "Copied" for 1.5 s. Menu stays open.
- **Multi-select** ("N sessions selected"): row is unchanged -- no copy icon, no click action.
- **Archived chat menu**: no Chat ID row (unchanged).
- Keyboard: `role="menuitem"`, `tabIndex={0}`, Enter and Space both trigger copy. Screen readers receive an `aria-live="polite"` announcement when "Copied" appears.
- Motion: copy icon fades in at `--dur-fast` (120 ms) on hover/focus via the `quiet-row-action` / `data-quiet-row` CSS utility. The icon and "Copied" text are both in the DOM simultaneously -- the icon fades to opacity 0 and "Copied" fades to opacity 1 using `--dur-med` (200 ms) `var(--ease-out)` transitions, so the swap is a crossfade rather than a pop.
- Timer management: `copiedTimerRef` tracks the active timeout. Clicking copy again clears and restarts the timer. Closing the menu clears the timer and resets state.
- Clipboard method: `navigator.clipboard.writeText`.
- The Chat ID text carries `select-all` so it can still be selected directly.
- Closing the menu resets the copied state and clears any pending timer.

## Acceptance criteria

- [ ] Right-click a single chat -> context menu opens with Chat ID row.
- [ ] Hover the Chat ID row -> copy icon appears.
- [ ] Click the row -> ID is on the clipboard, "Copied" appears briefly, menu stays open.
- [ ] Tab to the Chat ID row, press Enter -> same result.
- [ ] Tab to the Chat ID row, press Space -> same result.
- [ ] Right-click with multiple chats selected -> "N sessions selected" row has no copy icon or click action.
- [ ] "Copied" feedback disappears after ~1.5 s and copy icon is shown again on hover.
- [ ] Clicking copy while "Copied" is showing resets the 1.5 s clock (no double-fire).
- [ ] Closing the menu while "Copied" is showing does not leave orphaned setTimeout.
- [ ] The Chat ID text can be selected via keyboard/mouse (select-all).

## Implementation

`apps/desktop/src/renderer/views/WorkspacesView.tsx`:
- `copiedChatId` state drives the crossfade; `copiedTimerRef` tracks the active setTimeout.
- `doCopyId(id)` handler clears any existing timer, sets `copiedChatId`, and starts a fresh 1500 ms timer.
- The `onClose` callback clears `copiedTimerRef` and resets `copiedChatId`.
- The icon span and "Copied" span live in the DOM together, with `opacity` driven by `copiedChatId` and CSS `transition: opacity var(--dur-med) var(--ease-out)`.
- The Chat ID text is wrapped in `<span className="select-all">`.
- Closes #3047.

Status: implemented; desktop verification pending.
