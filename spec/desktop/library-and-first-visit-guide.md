---
title: Library and its first-visit guide
area: desktop
---

# Library and its first-visit guide

## Intent

The rail destination formerly called Artifacts is **Library**. Someone opening it for the first time should understand what appears there without knowing the term artifact. This completes the introduction requested in issue #1272 and applies the Library name to the rail, page title, command palette and voice navigation.

## Implemented

- Library keeps the existing `artifacts` route, file index and preview behavior. Files are not moved or copied by this rename. Chat artifact cards, the Agent Monitor's Artifacts disclosure, and the separate Nekko Artifacts publishing server keep their existing names.
- The first visit opens an illustrated, static guide in both Simple and Detailed output modes. Three short explanations cover creating files in a chat, finding and previewing them, returning to the source chat, and keeping or sharing a file through its usual app. A sample request ends the guide with something to try.
- **Explore Library**, the close control, Escape and the scrim dismiss the guide. Dismissal is saved in this renderer profile's local storage; returning to Library or reloading does not reopen it. **Library guide** always reopens it. Clearing browser/app profile storage resets the first-visit state. If storage is blocked the guide still closes, but dismissal cannot survive remounting.
- On narrow shared-web/desktop windows the list uses the available width. Selecting a file switches to its preview, with **Back to Library** returning to the list. Wide windows retain the list and preview side by side.
- The existing index reads up to the 60 most recent eligible top-level chats. It is not a scan of every file on the computer or a backup. Deleted files can remain listed until their source chat changes.

## Designs from every agent, and the designs folder

Requested 2026-11-12 (#2677): designs made in Claude Code chats were missing from Library; design canvases should show whoever made them, and agents should be able to find and use them. Checked against 299 saved chats on one Mac: Claude Code chats record the files they write as `Write` with a `file_path` (33 calls in 39 chats, two of them HTML designs) and name them in code formatting, so neither half of the index saw them. (#2675 has since made a page, image or PDF named in code formatting count as a link, which lists those; a design the reply never names, and every other kind of file, still depends on the `Write` call.)

Implemented, not yet released:

- **Files Claude Code wrote.** A `Write` call in a Claude Code chat counts as a written file, the same as Nekko's own `write_file`, with the same rules for what is an output (no source folders, no project housekeeping files). Reading or editing a file does not list it. An agent's own notes under `.claude/` (Claude Code's memory and plans) are never listed.
- **Designs by name.** An HTML page or image is filed under **Designs** when its own file name says so: `design`, `mockup` (or `mock-up`, `mock`), `prototype`, `wireframe`, `concept`, `canvas`, `artboard` or their plurals, as a whole word (`checkout-design.html`, `pricing_wireframe.png`, `prototype.html`). The folder rule is unchanged: anything under `nekko-designs/`, `design(s)/`, `mockup(s)/` or `prototype(s)/`. Other kinds keep their kind (`ci-runners-design.md` stays a document).
- **The designs folder.** Library also lists the pages and images in each saved project's `nekko-designs/` folder and one level of subfolders (`nekko-designs/login/index.html`), whoever put them there: an agent on any provider, the Design tab, a person, or a tool outside Nekko Agent. Up to 40 subfolders and 300 files per project are read. A design a chat also produced keeps its chat; one no chat mentions shows "<project> designs folder" where the chat title would be, has no date, sorts after the chat-made designs, and offers **Open file** as its main action, with no **Open chat**. The folder is listed again whenever a chat changes.
- **Agents know the folder.** The shared prompt tells Nekko's own agents what a design is, that it goes in the project's `nekko-designs/` folder and never in `reports/`, to look there before designing or building an interface, and to version a design as files. The rules, and how Claude Code chats are told, are in [Rich responses, reports, and design workspace](../code/rich-responses-reports-and-design-workspace.md#a-report-and-a-design-are-different-outputs-2026-11-13). See [decision 0089](../../docs/decisions/0089-designs-are-files-in-the-projects-designs-folder.md) and the options in [the report](../../reports/design-canvases-for-agents-2026-11-12.md).

Not done: on a Claude plan, Claude Code chats are not told by Nekko (the Claude policy's `context_note` row is off there), so they follow the project's `AGENTS.md` or `CLAUDE.md`; files Claude Code changes with `Edit` are not listed; a design in a chat's own worktree is found through its chat, not the folder listing. The Design board follows the same folder: see [the Design tab](../code/designing-draw-it-or-describe-it-design-tab.md#the-board-follows-the-designs-folder-2026-11-12-2680).

Verified in the hidden, isolated full-App Electron journey (`library-designs-sandbox.cjs`, 9 checks, matched captures on unchanged `main`) and focused unit tests. Packaged builds, Windows paths in a running app and the Local Web UI in other browsers were not checked.

## Browsing: kinds, groups and layouts

Requested 2026-11-09: a slider at the top for All and then each kind; collapsible groups under All; groups with their headings and the files as large square previews without a card box; the setup answer's group first (a Developer sees theirs first); previews of the newest files of each kind in the empty space beside the list; a layout slider of icons in the top right (list, small icons, large icons, full cards) with smooth transitions, keeping the list on the left in every layout except List, where the list sweeps across the full width.

Implemented, not yet released:

- **Kind slider.** A sliding segmented control at the top: **All**, then one segment per kind that has files, each with its count. The highlight slides between segments; arrow keys, Home and End move the choice (one tab stop). Picking a kind shows only that kind, in the list and the previews, with every file. If a kind's last file leaves (for example after hiding completed chats), the slider returns to All. The kind shown is not saved; Library opens on All.
- **Groups.** Under All every kind is a group with its heading and count. Clicking a heading folds or unfolds that group, in the list and the previews together, with a short height animation; folded content leaves the tab order. Every group starts expanded; the folded set is saved in this profile's local storage.
- **Setup answer leads.** The kind matching the setup answer to "What do you mostly do?" comes first in the slider, the list and the previews: Developer, Web pages; Designer, Designs; Writer or researcher and Student, Documents; Product or business, Office files. Just exploring, no answer, or a lead kind with no files keeps the usual order (Documents, Web pages, Designs, Diagrams, Data, Office files, Images).
- **Layout slider.** An icon slider in the top right picks **List**, **Small icons**, **Large icons** (the default) or **Full cards**, saved in local storage. In the three preview layouts the list stays on the left and the space beside it shows each kind's newest files: 16 small icons, 8 large icons or 4 full cards per kind under All, with **See all N** switching the kind slider to that kind. Small and large icons are a square picture with the name under it and no card background or border; full cards add the source chat, date, **Open chat** and **Open file**. **List** spreads the list across the page with file name, source chat and date columns; picking a file there narrows the list back to the left for the preview, and closing the preview widens it again. The layout slider is hidden on narrow windows, where the list keeps the full width as before.
- **Previews.** Each picture is original line art drawn from the file's kind, with a variant chosen from its path and the extension in the corner, tinted per kind and mixed into the theme's own surfaces. Library still reads no file contents to draw them; a file is only read when picked for preview.
- **HTML pages run live.** Picking an `.html` design serves it with its folder so its own stylesheets, scripts and images load, offline unless **Load from internet** is switched on: see [HTML previews run with their folder](html-previews-run-with-their-folder.md).
- **Preview close.** On wide windows the preview header has a close control that returns to the previews (or the full-width list).
- **No files yet.** Requested 2026-11-09: keep the placeholder illustration for someone with no artifacts. Once every candidate chat has been read and none produced a file, the original Library illustration fills the page in every layout (including List and narrow windows) with "What your agents made", a line on how files arrive and a request to try. The kind and layout sliders hide, since there is nothing to sort. If **Include completed chats** is off, the placeholder offers to turn it on. While chats are still being read the usual list and right-hand illustration show, so the placeholder never flashes before older chats are checked. A filter that matches nothing still says "Nothing matches." in the list.
- **Motion.** Layout and kind changes run as view transitions (340 ms, ease-out): on-screen previews morph from their old place and size to the new one, labels and group headings glide without stretching, and items leaving or arriving fade quickly. When the list itself changes it plays as a panel sweeping to its new width rather than a crossfade. Only items on screen get transition names. With the OS reduced-motion setting, or a browser without view transitions, changes are instant; the slider highlight and folds also stop animating.

Verified in the hidden, isolated full-App Electron journey (`library-layouts-sandbox.cjs`, 16 checks) and the existing first-visit journey (18 checks), plus focused unit tests. Packaged builds, the Local Web UI in other browsers, and light-theme captures of the new layouts were not checked. Diagram files linked in a reply are not indexed by the existing artifact index (separate, unchanged behavior), so the Diagrams group appears only for diagrams the agent wrote.

## Privacy and boundaries

The guide uses original inline artwork and reads no files or external resources. Dismissal saves only a boolean in local storage. Listing a project's designs folder reads file and folder names only, in folders the person already saved as projects; no file is opened until it is picked, and nothing outside `nekko-designs/` is listed. File previews retain their existing isolation and permission boundaries. Files remain in their original folders; nothing is published automatically. Hosted publishing remains separate planned work, not a Library action added here. The native phone apps do not have this page and are unchanged.

## Acceptance and verification

- First visit shows the guide, dismissal persists across leaving/re-entering and reload, and the page control reopens it.
- Modal keyboard dismissal, file opening, source-chat navigation, filtering and narrow-screen return behavior remain usable.
- Focused tests cover copy, storage failure/persistence, static artwork, voice navigation and the unchanged artifact index. The full-App isolated Electron journey records desktop/narrow screenshots in default dark and light themes and checks actual interactions.
- Visual and packaged-platform verification status is recorded in the implementing PR; code existence is not proof of shipped or verified behavior.
