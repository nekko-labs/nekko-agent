---
title: "What's new sheet (desktop)"
area: desktop
---

# What's new sheet (desktop)

User intent (Kai, #2810, 2026-11-14): after an update the title bar says "✓ Updated to v…" and nothing else; the GitHub notes list every PR, so the changes people care about are hard to find. Show the few that matter, inside the app.

User intent (Philip, 2026-11-15): build it from the design system, with Gentleface icons and no cards.

## The sheet

- A modal over the current view, 400 wide, one floating surface. Nothing inside it has a card, border or tile.
- **Header**, left-aligned: the app icon, "What's new", then the running version as meta. A close button (✕, Gentleface `x`) at the top right; the ✕ makes a quarter turn once on hover, focus or press, and stays still under reduced motion. There is no "Got it" button.
- **Highlights**: up to 3 rows for the running version's line (MAJOR.MINOR). Each row is a title, one line of detail (cut with an ellipsis when it does not fit, so about 30 characters) and its PR number as right-hand meta; the row opens that PR on GitHub. Every row leads with a Gentleface icon that fits what the change is about.
- **Show more**, at the end of the list under the third row, adds the rest to the list. The sheet keeps the size it had: the list scrolls inside it, and the header, ✕ and footer stay put (Matt, 2026-11-18: some versions will have many changes). The new rows fade in, focus moves to the first of them and it scrolls into view. Every row is reachable by Tab, which scrolls the list. It is not shown when a line has 3 or fewer.
- **Footer**: "Show after updates" and its switch on the left (see Opening after an update); "See every change ↗" on the right opens the running line's section of the website's What's new page (`nekkoagent.com/whatsnew#0.10`, Philip, 2026-11-19). A development build (`0.10.1004-dev.…`) shows its line's highlights and opens its line's section too.
- A line with no highlights shows the header and the footer only.
- Escape, ✕ and a click outside close it. Focus moves into the sheet on open and back to what opened it on close.

## Ways to open it

- The title-bar pill after an update says only "What's new" (Matt, 2026-11-18: the longer pill was too wide, and the sheet's header shows the version). It opens the sheet and goes away. Its accessible name and tooltip still say "Updated to v…".
- A small ✕ in the pill (Gentleface `x`, quieter than the label, named "Dismiss") makes it go away without opening the sheet (Matt, 2026-11-18). It is a second button beside "What's new", reached by Tab. Focus moves to the version pill that takes its place. Either way the pill is gone for that version and does not return on the next launch; the sheet stays reachable the other three ways.
- Settings › Updates: a "What's new" button beside "Check now".
- About Nekko Agent: a "What's new" button.
- The command palette: "What's new", also found as "whats new", "changelog" or "release notes".
- The Local Web UI shares the renderer, so all four work there. Its "A new version is available" card keeps its link to GitHub: it is about a build that is not running yet, and the sheet only knows the running one.

## Opening after an update

User intent (Kai, #2810, 2026-11-14): people who never click the pill never see what changed; release notes that pop up too often annoy (Obsidian, VS Code complaints), hence the four safeguards.

- On the first launch on a newer MAJOR.MINOR line (0.10 → 0.11), the sheet opens by itself, once. The title-bar pill does not show on that launch: the sheet replaces it.
- It does not open by itself on a first install, on a nightly or patch in the same line, on a development build, on a move to an older line, when the line has no highlights, in the Local Web UI (its version is the server's), or when "Show after updates" is off.
- **Doesn't interrupt work.** If an agent is running or waiting for an answer, or another dialog is open (setup, the zones intro), the sheet waits and opens once none is, in the same session. If the app quits first, it opens on the next launch.
- **Never twice.** Once the sheet has been open for a line (by itself, from the pill, Settings, About or the palette) or the pill's ✕ dismissed it, it does not open by itself for that line again. The line last shown is kept on this computer, beside the last version run, since it is a fact about this install and not a preference.
- **An off switch.** "Show after updates" in the sheet's footer and "Show what's new after updates" in Settings › Updates, under "App updates", are one setting, on by default. Off stops only the opening by itself: the pill and the four ways to open it by hand stay.

## Where highlights come from

- `docs/hub/whats-new.json`, the file the website's What's new page is built from ([whats-new-page.md](../brand/whats-new-page.md)). The build bundles it, so the sheet makes no network call. Keyed by MAJOR.MINOR; the sheet reads each line's `highlights` and, from each, `title`, `detail`, `pr` and `icon`.

  ```json
  { "0.10": { "date": "…", "tag": "…", "intro": "…", "contributors": ["…"], "highlights": [{ "title": "…", "detail": "…", "pr": 2732, "icon": "settings", "authors": ["…"] }] } }
  ```

  It ignores `$comment` and every field it does not use, including any added later. The site build rejects a malformed highlight; the sheet drops one and never fails on the file. `icon` is a bundled Gentleface name chosen to match the change; a missing or unknown one shows `sparkles` (the 0.7 to 0.9 highlights have none).
- Which icon: the one for what the change is about. No close match: the nearest row below; nothing near: `sparkles`. A topic with no row gets one, and its icon is bundled with it (`gentleface-icons.tsx`, credited in `ASSETS.md`).

  | The change is about | Icon |
  | --- | --- |
  | Settings, account, plan | `settings` |
  | Models, providers | `brain-circuit` |
  | Routing | `router` |
  | Agents | `bots` |
  | Workflows | `workflow` |
  | Automations | `bolt` |
  | Commands, the terminal | `terminal` |
  | Search | `search` |
  | Keyboard shortcuts | `keyboard` |
  | Files, projects | `folder-open` |
  | Git, pull requests | `git-pull-request` |
  | Permissions, security, privacy | `shield-check` |
  | Themes, appearance | `palette` |
  | Images, photos | `image` |
  | Web, browser | `globe` |
  | Cloud, sync | `cloud` |
  | Connectors, plugins | `puzzle` |
  | Speed, resource use | `gauge` |
  | Usage, statistics | `bar-chart-horizontal` |
  | The model server | `server` |
  | Anything else | `sparkles` |
- The list holds as many highlights as were written for the line; the sheet shows the first 3 and puts the rest behind "Show more". There is no upper limit yet.
- The file is written by hand for each release line.

## Privacy and security

- Nothing is fetched or sent to show the sheet. Links open in the system browser, only when clicked.
- Highlight text is rendered as plain text, never as HTML or Markdown.

## Status

| Part | Status |
| --- | --- |
| The sheet and the four ways to open it by hand | Implemented |
| Highlights from `docs/hub/whats-new.json`, shared with the website; "See every change ↗" opens the website page | Implemented |
| Opens once on the first launch on a newer MAJOR.MINOR line; "Show after updates" switch in the footer and in Settings › Updates; waits until no agent is running; never shows a line twice | Implemented |
| A larger layout for major releases | Undecided |
