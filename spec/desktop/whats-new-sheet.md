---
title: "What's new sheet (desktop)"
area: desktop
---

# What's new sheet (desktop)

User intent (Kai, #2810, 2026-11-14): after an update the title bar says "✓ Updated to v…" and nothing else; the GitHub notes list every PR, so the changes people care about are hard to find. Show the few that matter, inside the app.

User intent (Philip, 2026-11-15): build it from the design system, with Gentleface icons and no cards.

## The sheet

- A modal over the current view, 400 wide, one floating surface. Nothing inside it has a card, border or tile.
- **Header**, left-aligned: the app icon, "What's new", then the running version as meta. A close button (✕, Gentleface `x`) at the top right. There is no "Got it" button.
- **Highlights**: up to 3 rows for the running version's line (MAJOR.MINOR). Each row is a title, one line of detail (cut with an ellipsis when it does not fit, so about 30 characters) and its PR number as right-hand meta; the row opens that PR on GitHub. Every row leads with a Gentleface icon that fits what the change is about.
- **Show N more** opens the rest in place (height opens, content fades in) and focus moves to the first row it revealed. It is not shown when a line has 3 or fewer.
- **Footer**: "See every change ↗" opens the GitHub release page for the running version (`releases/tag/v0.10.1004`). Every version the updater installs is a GitHub release with its own page. A development build (`0.10.1004-dev.…`) shows its line's highlights and opens `releases/latest`. A nightly build is not a release and has no page.
- A line with no highlights shows the header and "See every change ↗" only.
- Escape, ✕ and a click outside close it. Focus moves into the sheet on open and back to what opened it on close.

## Ways to open it

- The title-bar pill after an update: "✓ Updated to v… · What's new". "What's new" opens the sheet and dismisses the pill; the rest of the pill still only dismisses.
- Settings › Updates: a "What's new" button beside "Check now".
- About Nekko Agent: a "What's new" button.
- The command palette: "What's new", also found as "whats new", "changelog" or "release notes".
- The Local Web UI shares the renderer, so all four work there. Its "A new version is available" card keeps its link to GitHub: it is about a build that is not running yet, and the sheet only knows the running one.

## Where highlights come from

- A JSON file bundled in the build, `apps/desktop/src/renderer/whatsNew.json`, keyed by MAJOR.MINOR. The sheet makes no network call.

  ```json
  { "0.10": [{ "title": "…", "detail": "…", "pr": 2732, "icon": "settings" }] }
  ```

  `title`, `detail`, `pr` and `icon` are required. `icon` is a bundled Gentleface name chosen to match the change; a missing or unknown one shows `sparkles`.
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
- The list holds as many highlights as were written for the line; the sheet shows the first 3 and puts the rest behind "Show N more". There is no upper limit yet.
- Until the pipeline below exists, the file is written by hand.

## Privacy and security

- Nothing is fetched or sent to show the sheet. Links open in the system browser, only when clicked.
- Highlight text is rendered as plain text, never as HTML or Markdown.

## Status

| Part | Status |
| --- | --- |
| The sheet and the four ways to open it by hand | Implemented |
| Opens once on the first launch after a MAJOR.MINOR bump; "Show after updates" switch in the footer and in Settings › Updates; waits until no agent is running; never shows a version twice | Planned (#2810) |
| Highlights written at release time by the release workflow (an AI summary of the merged PRs, proofread before it ships) | Planned (#2810) |
| A larger layout for major releases | Undecided |
