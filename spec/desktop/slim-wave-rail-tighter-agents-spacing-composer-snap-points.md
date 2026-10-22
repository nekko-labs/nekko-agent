---
title: "Slim wave rail, tighter Agents spacing, composer snap points"
area: desktop
split-from: SPEC.md (2026-10-22)
---

# Slim wave rail, tighter Agents spacing, composer snap points

The rail colour and gutters below are historical and superseded by the compact-board update above.

[Implemented 2026-10-14; renderer captures inspected in an isolated hidden fixture; native macOS window not checked] The left nav rail is 52px wide. Its icons are centred vertically on a faded-accent band (accent mixed 14% into the paper colour, 20% when expanded) whose top and bottom curve back into the window's left edge within ~14% of each end. Hovering or keyboard focus expands it to 188px with a spring width transition and the labels/items sliding in; reduced motion disables the transition. On macOS the title bar leaves 92px (was 78px) before the app mark so it clears the traffic lights with breathing room. On the Agents page the gaps between rail, agent list, agent window and the right edge shrink (page padding 4/6px, list-to-window 2px, wall-to-dock 6px), widening the agent window from 644 to 746px at 1440×900 with the dock open. The right panel dock defaults to 368px (about 10% narrower). The composer height drag, in both the chat pane and the Agents wall composer, snaps to the default (content-fitted) height and to full height when released within 24px of either; snapping to default clears the saved height. No settings shape, host action or permission changes.

## Agents toolbar without overflow

Implemented: the top Agents toolbar has only the three direct creation actions (New agent, New image session, New terminal), with no ellipsis or Add window overflow button in any layout or viewport. The empty-wall picker remains available, anchored beside New terminal. Existing sessions, saved layouts and permissions are unchanged. Acceptance: all three direct actions remain accessible and no overflow trigger is rendered in desktop or web chrome. Verified with 29 focused tests and inspected matching hidden Electron toolbar captures at 1440px and 390px in light and dark; synthetic clicks preserve all three direct actions. Native OS chrome is unchanged and not covered by renderer captures.

## Repository-row creation controls

Implemented (drag-start fix 2026-10-15, see *Model picker, tool categories, Artifacts tab and wall polish*): the Agents panel repository-row plus creates a multimodal agent chat and the terminal icon creates a shell using the clicked repository, without changing the globally selected repository or saved default folders. A new window becomes visible in Focus without changing layout mode; an incompatible wall filter resets to All so the result is not hidden. Composer agent selection is independent of a terminal being the Focus hero. On narrow screens the agent-list overlay closes after successful creation, but stays open on failure. Both row controls remain disabled for that repository while creation is pending; failures show a repository-specific error toast and allow retry. Existing session configuration cleanup remains in place.

Acceptance: one host creation per pending repository action, explicit repository payloads even when another repository/default is selected, existing wall panes retained, visible Focus results, Grid/Dynamic mode preserved, and error feedback on host failures. Verification uses synthetic host responses, isolated profiles and network-disabled off-screen non-focusable Electron windows. Real host terminal spawning and non-macOS desktop behavior remain unverified; these controls do not themselves run agent prompts or write repository files.

## Streaming wall empty-state styling

Implemented candidate: wall vacancy styling is derived from wall state, not a descendant selector reconsidered as streamed content grows. Empty, filtered-no-match and creation states retain their appearance. Isolated Windows Electron fixtures pass geometry checks with byte-identical static captures at desktop/narrow widths and light/dark themes. Linux CI performance and packaged cross-platform verification remain pending; budgets are unchanged.
