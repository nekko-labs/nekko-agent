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
| **Files** | folder-open | A file browser: the files open in the agent windows, then the connected folders as trees. See [The Files view: a file browser](#the-files-view-a-file-browser). |

- The highlight slides to the picked segment (240 ms, off under reduced motion). Arrow keys, Home and End move the choice; the group is one tab stop.
- The sliders button (group, sort, show) appears only on the Agents segment, the one list it arranges.
- An empty view says so: "No terminals open", "No photo or video chats", "No folders connected".
- The pick is a per-window preference in `localStorage` (`nekko.agentPanelShows`), like the panel's width and view; anything unrecognised falls back to Agents, including a saved Browsers pick from before that segment was removed.
- The switcher itself makes no host calls.

Not verified: packaged desktop app, the Local Web UI in a real browser.

## The Files view: a file browser

User intent (Philip, 2026-11-20): "Remove the browser tab entirely. For folders, remove the beside an agent. Instead, this should just be a general file browser and show the files that are open in the agent windows. When browsing files, you should be able to open them and see them in an agent window. They should also be editable."

`[implemented 2026-11-20; unit-tested (rows, open list, active mark, folder matching, wall persistence) and checked in the hidden real-renderer fixture (file-browser-sandbox.cjs: tree unfolds in place, a file opens as an editable window and is listed as open and current); packaged app and Local Web UI not checked]`

- The **Browsers** segment is gone. The **Beside an agent** rows are gone from Files too: the panel no longer lists agents outside the Agents segment. An agent's own Browser and Files drawers (its window's buttons) are unchanged.
- **Open** (shown only when a file is open): one row per file open in the agent windows, on the wall or beside an agent, named by the file and tagged with the connected folder it sits in (the deepest one). The file whose window is the active zone is tinted and marked current. Picking a row shows its window.
- **Folders**: every folder connected on this computer, cloned repositories showing `owner/name` at the right. Picking a folder unfolds its tree in place (closed until picked, so no folder is read up front); folders inside unfold the same way, 200 rows at a time.
- Picking a file opens it in a **file window** on the wall: into the active zone, like a chat or terminal, or shows the one already open. It is the app's file editor (edit, undo, save with Ctrl/Cmd+S, auto-save when on); Markdown, HTML and Mermaid open rendered with a **Source** toggle as elsewhere. File windows are kept across restarts (the wall's saved tree now accepts `file`).
- Folders on other computers are not listed: their files cannot be browsed from this one yet.

## Browsers and Files without an agent (2026-11-15, superseded)

The Browsers segment described here was removed on 2026-11-20 and the Files rows below replaced by the file browser above. Browser and Files windows saved on a wall from before still open. The `servers:list` probe stays in the daemon, unused by the panel.

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
