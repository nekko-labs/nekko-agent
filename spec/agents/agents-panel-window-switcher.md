---
title: "Agents panel: one column, with a window-type switcher (2026-11-14)"
area: agents
---

# Agents panel: one column, with a window-type switcher (2026-11-14)

User intent (Philip, 2026-11-14): remove the panel's vertical/horizontal toggle and the row layout behind it, and put a sliding toggle row at the top of the Agents panel with an icon for each kind of window: agents, terminals, browser, files, and so on. Issue #2787.

`[implemented 2026-11-14; unit-tested (switcher, views, saved choice, retired orientation dropped); packaged desktop app not checked]`

## One column

- The Agents panel is always a column beside the wall. The "Show agents in a row" / "Show agents in a column" button, the row of cards above the wall, its sideways wheel scrolling and its compact header are gone.
- The header keeps **Hide agents** at its left and view options, search and **+** at its right. Collapsed, the show button still heads a strip down the wall's left edge.
- A saved wall from before keeps its shown/hidden state; a saved `orientation` is dropped on load, so someone who had the row gets the column. The setting is now `agentPanel: { show }`.

## The window-type switcher

A sliding segmented control (the Library's `SlideToggle`, icon-only) sits under the header and spans the panel's width. One Gentleface icon per kind of window, named in its tooltip and to screen readers:

| Segment | Icon | Lists |
| --- | --- | --- |
| **Agents** (default) | bots | The agent cards, grouped and sorted by the view options, as before. Terminals and photo/video chats no longer appear here as groups at the top. |
| **Terminals** | terminal | Every open terminal, one card each. |
| **Photos and videos** | image | Photo and video chats. |
| **Browsers** | globe | One row per active agent; picking a row shows that agent and slides its **Browser** drawer out. |
| **Files** | folder-open | One row per active agent with its project folder; picking a row shows the agent and slides its **Files** drawer out. |

- The highlight slides to the picked segment (240 ms, off under reduced motion). Arrow keys, Home and End move the choice; the group is one tab stop.
- In Browsers and Files, the agent whose drawer of that kind is out is tinted and marked current. Picking it again leaves the drawer open.
- The sliders button (group, sort, show) appears only on the Agents segment, the one list it arranges.
- An empty view says so: "No terminals open", "No photo or video chats", "No agents to open a browser beside", "No agents whose files to browse".
- The pick is a per-window preference in `localStorage` (`nekko.agentPanelShows`), like the panel's width and view; anything unrecognised falls back to Agents.
- No host calls, permissions, storage schema or network use change.

Not verified: packaged desktop app, the Local Web UI in a real browser, and very long agent lists in the Browsers and Files views.
