---
title: "Search everything from the command palette (desktop)"
area: desktop
---

# Search everything from the command palette (desktop)

User intent (Philip, 2026-10-28): "searching with command k should also show any partially matching settings. have the search results show the toggle or setting that they can quick change literally in the window without having to go to the page."

User intent (Philip, 2026-11-09): "I want the ctrl+k to be able to search anything. let's combine the search capabilities of the agent panel search. first show based on relevancy, and show/filter by type. Message results should be lower. Let's add in synonyms for search results like settings, preferences, pref, config, etc. have the search result findings be highlighted in the search result. the search results should have two rows. first is the breadcrumb of where it is. messages -> message name. second is the context it's found and the highlighted match."

## What it searches

- One box finds commands, Settings groups, individual settings, chats (title, first prompt, latest reply, project folder, provider), the messages inside every chat and the artifacts chats made. Chats, messages and artifacts come from the same transcript index the Agents panel search uses (`views/chatFinderIndex.ts`): read once per chat version, only when something is typed (or the Artifacts filter is open), with a "Reading chats N of M" line while it fills. Incognito chats never show.
- Matching ignores case, accepts partial words and needs every typed word to be found somewhere in the result.
- **Synonyms.** A typed word that belongs to a synonym group also matches the rest of the group, and so does the start of one from four letters (`prefe`). Groups include settings / preferences / prefs / pref / config / configuration / options; theme / appearance / colors; delete / remove; chat / agent / conversation / session; notifications / alerts; shortcut / hotkey / keybinding; privacy / telemetry; connectors / integrations / MCP / plugins; library / artifacts / files; terminal / shell / console; project / folder / workspace / group, and a few more (`paletteSearch.ts`). Synonyms apply to titles, paths and descriptions but not to message bodies or chat descriptions, where "new" standing for "add" or "start" would match nearly everything. A literal match always outranks a synonym match.

## How results are ordered and filtered

- **Relevance first.** A word in the title beats one in the path, which beats the description, which beats a message body; a word that starts a word beats one inside a word; a title equal to or starting with the whole query gets a lift. Ties lean commands, then settings, then chats, then artifacts, then by recency. The type label every result of a kind carries ("Chats", "Commands") is not searched, so "agent" does not list every chat; Settings groups are the exception, so "prefs" lists them.
- **Messages are always last.** Every message result sorts after every other kind. Under **All** at most 8 message results show, a chat already found by its title or description is not repeated as a message result, and a link opens the Messages filter for the rest.
- **Filter by type.** Chips under the box: All, Commands, Settings (groups and settings), Chats, Messages, Artifacts, each with its match count once something is typed. Click a chip, or press **Tab** / **Shift+Tab** in the box to step through them.
- With nothing typed, All lists the commands and the five latest chats; a type chip lists everything of that type (Messages asks for a word).

## How a result reads

- **Two rows.** The first is the breadcrumb of where it lives, ending in the result's name: *Commands › New agent*, *Settings › Customize › Text size*, *Chats › nekko-agent › Fix the theme picker*, *Messages › Release notes for 0.9*, *Artifacts › Fix the theme picker › Theme tokens*. The second is the text it was found in: a snippet around the match from the message or description, else the result's own description (what a command does, the words a setting also answers to, a file's name and path).
- **Highlights.** Every matched word (or the synonym that matched) is marked in both rows with the same amber wash Find in chat uses.
- At the right: a command's shortcut, a setting's own switch or dropdown, "Open" for a Settings group, and a chat's age ("Completed" when it is), plus the number of matching messages on a message result.

## Acting on a result

- Enter or a click runs a command, opens a Settings group, or opens a chat (switching to the Agents view). A message result opens its chat with Find in chat seeded with the matched word, so it lands on the highlight. An artifact opens the chat that made it.
- A setting changes in place and the palette stays open (from 2026-10-28): its switch or dropdown saves at once through the same settings write the Settings page uses; Enter flips a switch or steps to the next choice, Shift+Enter steps back. Covered in place: the app-wide switches and choices listed in `settingsIndex.ts` (Help improve Nekko Agent, sidebar shortcuts, background animation, language, chat pane action, idle completion, tips, delete confirmation, close behavior, mascot, tray farewell, desktop notifications, text size, internet recovery, prompt caching, git checkout and baseline, server controls and the Experimental flags). Per-item controls stay on their page and are reached through the group entry.

## Privacy and safety

The search runs in the renderer over the settings list and chats already on this machine; nothing is sent anywhere and nothing new is stored. Transcripts are read through the same local `getSession` the chat view uses and kept only in memory while the app runs. A setting change is the same local settings write as on the Settings page, with the same error toast.

## Status

- Settings in the palette: implemented 2026-10-28.
- Search everything: implemented 2026-11-09. Unit-tested (`paletteSearch.test.ts`: synonym expansion, literal over synonym, no synonyms in message bodies, messages after every other kind, chat/message de-duplication, the All message cap, filters and counts, type labels not searched, snippets, highlight ranges) and checked in a hidden, off-screen renderer of the real App with synthetic chats (`apps/desktop/scripts/palette-search-sandbox.cjs`, 9 checks, dark, 1100x760): prefs ranks Go to Settings first with Settings marked, chat breadcrumbs name their project, artifacts and messages read as two rows with the match marked, messages sort last, and the Messages filter shows only messages. Not checked: the installed app, light theme, narrow windows, a large real chat history (speed), and the Local Web UI (which shares the palette).
