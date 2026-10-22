---
title: "Search within Settings (desktop)"
area: desktop
split-from: SPEC.md (2026-10-22)
---

# Search within Settings (desktop)

User intent: find a setting by keyword without scrolling through the whole Settings page.

- A search icon sits at the far right of the **Appearance** heading. Clicking it replaces the icon with a floating search bar in the same spot that stays on screen while the page scrolls under it.
- The search runs one second after typing stops, or immediately on Enter. It matches visible Settings text, ignoring case and including partial words. The page scrolls the first match into view and highlights it, with every other match highlighted more faintly. A counter shows "n of N", or "No results".
- Up/down arrow buttons, the ArrowUp/ArrowDown keys and Enter / Shift+Enter step through matches, wrapping at the ends. The arrows are disabled when there is nothing to step to. The X or Escape closes the bar, clears the highlights and brings the icon back.
- Privacy and safety: the search runs entirely in the page and sends nothing anywhere. Highlights use the CSS Custom Highlight API, so the settings controls are never rewritten and no setting changes.

Status: implemented. Checked in a hidden renderer of the real Settings view (dark theme, 1280×900): debounce timing, Enter bypass, scroll-into-view, arrow stepping and wrap-around, disabled arrows on a single match, and close/clear. Not yet checked: light theme, narrow windows, and the installed app. Text hidden from the page (collapsed panels, dropdown options) is not searched. The bar is fixed in place, so it can cover a line of content and does not follow the header if the window is resized while it is open.
