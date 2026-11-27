---
title: "Settings section nav and phone pairing placement (desktop)"
area: desktop
---

# Settings section nav and phone pairing placement (desktop)

User intent: find the QR code that links a phone without hunting through one long Settings page, and see Settings split into clear sections.

- Settings has a section list on the left: **Profile**, **Help out the Nekko Team**, **Nekko Cloud**; then, under the label **Nekko Agent**, **General**, **Appearance**, **Agents**, **Tools**, **Storage**; then, under **Privacy and devices**, **Safety**, **Connections**, **Phone and computers**, **System**. Clicking one shows that group as its own page, from its top, and marks it in the rail ([one page per area](#one-page-per-area-under-a-labelled-rail-3102)). In a narrow window the list becomes a wrapping row above the page.
- Each page is one group under its name at page-title size (see [Quiet Settings](#quiet-settings-and-where-each-setting-lives-2563) for the order inside each):
  - Profile: About you (what Nekko calls you, the update email, what you mostly do, and the About you note sent with each chat).
  - Help out the Nekko Team: Help improve Nekko Agent (usage reports), Support by starring the project on GitHub.
  - Nekko Cloud: Account (sign in, plan, sign out). Once signed in: Sync, Fleet management (the organization, Share this computer, its computers and members), then the Danger zone (Delete everything synced, Delete account).
  - General: Notifications, Chats, Desktop behavior, Language and help, Dictation, and a pointer to Chat history, which moved to Storage.
  - Appearance: Theme, Fonts and text ([Style](style-fonts-and-text-size.md)), Animations, Agents wall, View settings, Simple mode visibility, Fun.
  - Agents: Agent loop, Customization (system prompt and server prompt wrapper), System prompt size, Spec-driven development, Agent orchestration, Delegation routes, Hooks, Automations, Claude plan features.
  - Safety: Chat modes, Sandbox, Guardrails, Security.
  - Connections: every connection with its log, then All connections off at the bottom in danger red ([Connections](../platform/connections-switch-and-activity-log.md)).
  - Tools: Git management, Project management, Pull requests, Terminal, MCP servers.
  - Storage: where Nekko's disk goes on this computer and in Nekko Cloud, with safe cleanup and Chat history ([Storage](storage-settings.md)).
  - Phone and computers: Remote access, then Connected computers and pairing (only Remote access, titled Phone pairing, in Simple until a computer is connected).
  - System: Nekko Agent service, Updates, Developer, Experimental, Backup & restore, Data & privacy.
- In Remote access, **Paired devices** and **+ Pair a device** come first once remote access is on, and the pairing QR opens directly under the button, above the device list. Relay details, the local relay, network visibility, phone changes and phone access follow. Before remote access is on, the card offers two ways to connect, Tailscale or Nekko Cloud (see [remote control](../phone/driving-your-home-model-from-your-phone-remote-control.md)).
- The card keeps the name "Remote access", so every "Settings → Remote access" instruction in the apps and docs still points to it.
- Search within Settings stays in the rail and searches every page; the section list is not searched.
- Privacy and safety: layout only. No setting, pairing secret or relay behavior changes.

Status: implemented. The animated jump `[2026-10-23]` was checked in the same hidden renderer at 1280 and 640 wide: clicking System passes through intermediate scroll positions and lands on the section in about 195ms, with System highlighted. Checked in a hidden renderer of the full app with a stub bridge (dark theme, 1280×900 and 640×900): clicking Phone pairing highlights it and brings the card into view, Pair a device shows the QR fully on screen, no horizontal overflow. Not yet checked: light theme, the installed app, and the Local Web UI.

## Optional sidebar shortcuts (issue #1178)

Implemented. Skills and Connectors are rows at the very top of the Settings rail, before the section navigation, and wrap in a narrow window. **Server** follows them (2026-11-20): unlike the two shortcuts it jumps to a section of the Settings page itself, the Agent server, which leads the page (see [Server, model browser and desktop tray](../models/server-model-browser-and-desktop-tray.md)).

**Wheel over the side menu (2026-11-20).** `[implemented, unit-tested and checked in a hidden Electron fixture]` On Settings, Models and Automations a mouse wheel turned over the side menu or the gutters scrolls the page's content, as it does over the content itself; a menu long enough to scroll still scrolls itself first and hands over at its end. Pinch zoom is left alone. Both sidebar shortcuts are hidden by default, including for existing settings with no saved preference. Customize > View settings independently opts each shortcut into the left rail. Hiding a shortcut does not disable its view or change access through Settings, the command palette or chat skill menus. Preferences persist through the existing settings API as `sidebarViews`; no credentials, permissions or remote calls are added.

Acceptance: both chips navigate to their views, each toggle saves independently, and both desktop and narrow layouts keep them legible. Verified with focused navigation tests and hidden, network-blocked Electron fixture interaction checks and matching screenshots. Packaged apps and native phone clients are not verified.

## Panel layout and return navigation (issue #1220)

Implemented, verified in a hidden, network-blocked Electron fixture at 1440×900 and 600×900. Skills and Connectors include a persistent **Back to Settings** button, including when opened through optional rail shortcuts.

Acceptance: both back buttons return to Settings; all section content remains available; narrow layouts do not overflow horizontally. No settings, credentials, permissions, or external connections change. Packaged desktop apps, Local Web UI hosting, and native phone clients have not been exercised.

## Page shell shared with Artifacts and Scheduled Tasks

User intent: Settings, Skills, Connectors and Models should feel like the same app as Artifacts and Scheduled Tasks, which are the reference. This replaces the 80% width, the floating paper panel and the accent-underlined section links from issue #1220.

All four run edge to edge on the app background, with content centred and capped at the width of the Scheduled Tasks list, in standard bordered cards. Settings has a 240px left rail that stays put while the content scrolls (inset and without its divider since 2026-11-11, see below). Its rows are shaped like the Scheduled Tasks category rows (rounded, the current one filled, with a visible keyboard focus outline) at 16px, larger than that page's on request. In a narrow window the rail becomes wrapping rows above the page. Models has no side menu ([decision 0057](../../docs/decisions/0057-models-is-one-page-without-a-side-menu.md)). The Skills tabs use the Scheduled Tasks filter buttons.

Search within Settings covers the page, so it no longer matches the Skills and Connectors rows, which are in the rail. No setting, credential or permission changes.

Status: implemented, not yet landed. Checked in a hidden renderer of the full app with a stub bridge (dark theme, 1440×900 and 600×900). Not yet checked: light theme, the installed app, and the Local Web UI.

## One inset side menu for Settings, Models and Automations (2026-11-11)

User intent: Settings and Automations should have the Models page's side menu, set in from the window's edge, and all three menus start at the top of the page rather than in the middle of it.

Settings, Models and Automations share one layout: the side menu sits inside the page's side margins (up to 80px from the app rail) with 40px to the content and no hairline divider, and its first item lines up with the top of the content. Models' menu used to be centred vertically; it now starts at the top too. Settings rows keep their 16px text and become 40px tall with 8px between section items, like Models'. Below 768px Settings and Automations turn the menu into a band above the page behind one hairline; Models keeps its two-column grid below 1000px. Layout only: no setting, permission or data changes.

Status: implemented 2026-11-11. Checked in a hidden renderer of the full app with a stub bridge (default dark theme, 1440×900 and 600×900): all three menus start 20px below the title bar at the same left edge, with no horizontal overflow. Not yet checked: the installed app and the Local Web UI.

## Customize grouping (issue #2097)

User intent: put appearance and experience settings under Settings > Customize, keeping computer connections and service management separate. This grouping applies to the existing desktop and shared Local Web UI renderer, not native phone navigation or the pending tone/catalog feature in #2055.

Implemented: a single Customize rail entry contains the existing personalization cards, including standing instructions for preferred response style. Existing setting fields, defaults, save handlers, permission boundaries and subsection anchors are retained. General keeps usage reports, dictation, notifications and chat history. Search remains available in the rail and still covers the whole settings page. Command-palette page results and indexed personalization controls target Customize; accessibility, font-size and Simple mode queries remain discoverable, and old subsection anchors still work.

Acceptance: each moved control appears once under Customize; Phone pairing stays second; System and Computers stay separate; navigation, search and preference saving work in wide and narrow layouts.

Verification: 31 initial focused settings/search tests passed. CI then caught a stale standalone Accessibility navigation assertion; the follow-up corrected it and stale command-palette destinations, added nine search-routing cases, and passed all 3,219 desktop tests across 349 files, profile/desktop production builds and desktop typecheck. Hidden Electron verified Customize search destinations and legacy style/accessibility/simple anchor positions; the fixture explicitly drains the navigation helper's two requestAnimationFrame callbacks because a never-shown window suspends them, so this proves destinations, not visible-window timing. Hidden, network-blocked Electron baseline/head captures and interaction assertions passed with no renderer errors at requested 1280x900 and 600x900 sizes. Pixel inspection remains blocked: browser screenshot timed out and native image delivery returned UnknownVizError. Captured images are not visually approved. Packaged desktop, deployed Local Web UI and native phone apps are unverified.

## Help out the Nekko Team (#2342)

Implemented first group and searchable navigation destination. The existing telemetry preference moves here without changing its value. GitHub support is an explicit API action rather than a local preference toggle; its selected state reflects a verified GitHub star. See [feedback support](../platform/send-feedback.md#optional-contact-and-github-support-2342) for privacy, animation, and verification status. This supersedes older “General keeps usage reports” and “Phone pairing stays second” placement notes above.

## Quiet Settings and where each setting lives (#2563)

User intent: Security settings moved to the quiet design system first; the rest of Settings should look and read the same way, and a setting should sit where people look for it.

Design, applied to every section (the design system's rules, nothing new):

- A section is a 16/600 heading, at most one line of help in faint ink, then its rows. Sections are separated by 40 of space, never a card, border or tinted tile. A group's first section sits 20 below the group title.
- A setting is a row: a 14/500 title, one line of detail under it, and its control on the right (a switch, a quiet field or a select). A blocked setting shows its title faint and the reason as the detail.
- Pick-one options (default chat mode, sandbox, spec-driven development, agent orchestration) are a list of rows; the chosen one's title is plum with a check. They were bordered tiles.
- Lists you edit (hooks, MCP servers, guardrails, chat worktrees, Security methods) are rows separated by space. Remove and similar actions appear on hover or focus, always on touch, in danger words.
- Secondary buttons are a wash, not an outline; fields are a faint wash with no border until focus. Destructive actions (Delete everything) are danger words until their confirmation dialog. Status is a dot and a word (an MCP server's tools or offline, a guardrail's severity).
- Long caveats wait behind a disclosure (Hooks: How hooks run) rather than filling the page.

Placement:

- General holds how the app behaves day to day: Notifications; Chats (the chat pane's top-right action, Archive idle agents after, Confirm deletions); Desktop behavior (closing the window, low memory); Language and help (language, Show tips, the setup wizard); Dictation; Chat history. These rows used to sit inside Customize > Appearance, which now holds only the theme and background animation.
- Safety leads with Chat modes, the default for new chats, and Warn before No restrictions, then Sandbox, Guardrails and Security. The chat mode is the first safety decision people make, and it used to sit under Agents.
- Customize keeps how Nekko looks and addresses you; Agents keeps how agents run.
- Search within Settings and the command palette follow the moves: their entries for the moved controls point at General or Safety, and page searches such as "chat modes" or "close window" land on the new group. Section anchors (`#notifications`, `#desktop-behavior`, `#automations`, `#customization`, `#settings-style`, `#settings-animations`, `#settings-simple`, the Security anchor) are unchanged.

Privacy and safety: layout and copy only. No setting, default, save path, permission or step-up check changes. The unused Slash commands section, which no page rendered, is removed.

Status: implemented, not yet landed. Checked with the settings, search and palette tests and a hidden renderer capture (see the PR). Not yet checked: the installed app and the Local Web UI.

## Organization section (issue #2588)

Implemented in the desktop renderer; it needs the engine's `org:*` and `fleet:*` channels, so it shows "Organizations are not available in this version of Nekko Agent yet" until a build has them. Where: Settings > Phone pairing > Organization, under Sync. Signed out, the section is not shown. Signed in but not unlocked on this computer, it says to unlock with the recovery key or by approval, in Sync. With no organization it offers to create one and lists invitations to accept. With one it shows your role, the members (owners and admins can invite by email and remove members), the **Share this computer with <Org>** switch (off by default; it lists this computer and its local models for members, uploads no chats and lets nobody run anything yet), and the Computers list: name, OS icon, a This computer tag, an online dot or Last seen, and local models collapsed after three. There is no Connect or Run action. It refreshes on the Nekko Cloud status event and re-reads the Computers list every 15 seconds while the section is on screen. Unverified: the live engine and cloud (the channels are stubbed in the captures), the packaged app and the Local Web UI.

## Profile first, Nekko Cloud as its own group (#3076)

User intent: Profile is the top item (your info, About you), Help out the Nekko Team second, Nekko Cloud account details third. Signing in to Nekko Cloud brings in the options that need an account. All connections off moves to the bottom of Connections, in red.

- **Profile** is the first group. Its About you section holds what Nekko calls you, the update email, What you mostly do (the setup wizard's card, now editable) and More about you (the `aboutUser` note, its explanation shown as the empty box's placeholder, moved out of Customize > Customization, which keeps the system prompt and the server prompt wrapper). Values, save paths and what is sent to models are unchanged.
- **Help out the Nekko Team** is second.
- **Nekko Cloud** is third. Signed out it shows only Account: the sync picture, one line on what an account is for, and Sign in to Nekko Cloud. Signed in, Account shows the email, plan and Sign out (plus Plans and billing and the team switches when those are on), then **Sync** (unchanged: status, devices, recovery key), **Fleet management** (the former Organization section, retitled: Share this computer, the organization's computers and its members) and the **Danger zone** (Delete everything synced, Delete account) last. Chat history's storage notice opens this group.
- **Phone pairing** keeps only Remote access.
- **Connections**: the per-connection switches and logs come first; **All connections off** is the last row, its title always in danger red. It still greys every row above when on.
- Search: "profile", "about you", "nekko cloud", "fleet" and "sign in" find the new groups; Phone pairing no longer matches "sync".
- `[updated 2026-11-20, #3089]` Sync lists **What syncs**: Chats and (with Library sync) Library, a switch each, greyed while Sync this computer is off. How a kind turned off and back on catches up is in [end-to-end encrypted sync](../chat/end-to-end-encrypted-sync-for-pro-and-team.md).

Privacy and safety: layout and copy only. No setting value, default, save path, permission, encryption or network behavior changes.

Status: implemented, not yet landed. Checked with the settings tests, desktop typecheck and a hidden renderer capture (see the PR). Not yet checked: the installed app and the Local Web UI.

## One page per area under a labelled rail (#3102)

User intent: approach A of the Settings redesign. Settings reads as a set of short pages, each found under a labelled part of the rail, instead of one long page you jump around in.

- The rail keeps Profile, Help out the Nekko Team and Nekko Cloud at the top with no label, then two group labels (12/500, ink-soft): **Nekko Agent** (General, Appearance, Agents, Tools) and **Privacy and devices** (Safety, Connections, Phone and computers, System). Server stays in the rail's top block with Customize, Skills and Connectors.
- One group is on screen at a time. Clicking a rail item shows its page from the top; the item is marked with the plum wash and plum title (`aria-current="page"`). The scroll spy and the animated jump are gone. Settings opens on the page you last had open in this window, Profile the first time.
- **Customize is now Appearance.** Its first section, the theme picker and background animation, is titled **Theme**. The system prompt sections (Customization and System prompt size) move to **Agents**, since they shape how agents answer. The group id stays `customize`, so links into it still work.
- **Phone pairing and Computers are one page, Phone and computers**: Remote access, then Computers. In Simple with no computer connected it is titled Phone pairing and holds only Remote access, as before. The old `settings-computers` anchor is kept on the Computers part.
- Every group stays mounted and only the others are hidden, so ids and anchors keep working. Links into Settings (command palette pages, Customize menu, the Wall view menu, Chat history's storage notice) open the page that holds their target and scroll to it.
- Search still reaches everything: while the search box is open every page is shown, as one list, and stepping through matches scrolls as before. Closing it shows the page of the last match, scrolled to that match.
- Command palette pages: Appearance (matches "customize" too), Agents (now matches "system prompt"), Phone and computers (matches "phone pairing", "qr", "computers").

Privacy and safety: layout only. No setting value, default, save path, permission or network behavior changes.

Status: implemented, not yet landed. Checked with the settings tests, desktop typecheck and a hidden Electron capture with a stub bridge (dark theme, 1280x900): 11 checks pass on the branch, 9 fail on main as expected (rail labels and order, Profile alone on open, Nekko Cloud alone from its top and marked, system prompt under Agents, Phone and computers holding both, Phone pairing in Simple, search showing every page and landing on the match's page). Not yet checked: light theme, a narrow window, the installed app and the Local Web UI.
