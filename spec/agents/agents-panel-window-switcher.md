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
| **Browsers** | globe | The pages served on this computer, then **New browser**, then (under **Beside an agent**) one row per active agent. See [Browsers and Files without an agent](#browsers-and-files-without-an-agent). |
| **Files** | folder-open | The folders connected on this computer, then (under **Beside an agent**) one row per active agent. Picking an agent row shows the agent and slides its **Files** drawer out. |

- The highlight slides to the picked segment (240 ms, off under reduced motion). Arrow keys, Home and End move the choice; the group is one tab stop.
- In Browsers and Files, the agent whose drawer of that kind is out is tinted and marked current. Picking it again leaves the drawer open.
- The sliders button (group, sort, show) appears only on the Agents segment, the one list it arranges.
- An empty view says so: "No terminals open", "No photo or video chats", "No pages served on this computer", "No folders connected". The **Beside an agent** heading and its rows appear only when there are agents.
- The pick is a per-window preference in `localStorage` (`nekko.agentPanelShows`), like the panel's width and view; anything unrecognised falls back to Agents.
- The switcher itself makes no host calls; the Browsers view reads `servers:list` (below).

Not verified: packaged desktop app, the Local Web UI in a real browser, and very long agent lists in the Browsers and Files views.

## Browsers and Files without an agent

User intent (Philip, 2026-11-15): "the website tab and folders tab should be able to be opened without a connected agent. Web should be served and the folders should be based on currently connected folders and repositories." Issue #2824.

`[implemented 2026-11-15; unit-tested (probe parsing, page test, folder matching, panel rows, wall persistence), daemon integration-tested, probe checked live on macOS; Windows netstat path unit-tested only; packaged app not checked]`

**Browsers** lists the web pages served on this computer, most often dev servers:

- One row per page: its `<title>` (else `localhost:<port>`), with the connected folder it runs from at the right (the deepest connected folder holding the serving process's working folder, so a repository wins over the folder around it), else `:<port>`. Hover shows the address and the serving program.
- Picking a row opens a **Browser window** on the wall at that address: no agent is created or needed. **New browser** opens one on a blank page to type an address into.
- The list is read when the view is shown and every 5 seconds while it stays shown and the window is visible.

What counts as a page (`servers:list`, nekkod, probe in `nekko-machine/src/servers.rs`):

- A TCP port listening on loopback or every address (`lsof` on macOS and Linux, `netstat -ano` on Windows). Ports bound only to another network address are left out.
- Asked for `/` once (1 s limit, `Accept: text/html`); it counts when the reply is a redirect or HTML with a 2xx status or a 401 (a sign-in page). JSON APIs and other apps' HTML error pages (an internal 404) are left out. Well-known non-web ports (SSH, mail, DNS, printing, databases, caches) are never asked.
- Never listed: the daemon itself, the app that started it (the desktop app, or the Local Web UI's server), and the app's model servers (`llama-server`, RPC, speech and image servers).
- Windows asking within 3 seconds share one scan.
- Privacy and security: local only. The channel is not in the phone/relay channel list, so a paired phone or remote computer cannot read it; the scan stays on this computer and sends nothing out. The page request carries no credentials or cookies.

**Files** lists the folders connected on this computer (Settings' saved folders, in their order), cloned repositories showing their `owner/name` at the right. Picking one opens a **Files window** on the wall rooted at that folder, no agent needed. Folders on other computers are not listed here: their files cannot be browsed from this one yet.

On the wall:

- A Browser or Files window is a wall window like a chat or terminal: it opens into the active zone, picking the same page or folder again only shows it, and it is kept across restarts (the wall's saved tree now accepts `browser` and `files` windows). Its strip shows the page's host and port, or the folder's name.
- A window's split compass still offers only chats and terminals; Browser and Files windows come from the Agents panel.
- The agent drawers (an agent's own Browser and Files beside it) are unchanged.
