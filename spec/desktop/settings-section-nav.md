---
title: "Settings section nav and phone pairing placement (desktop)"
area: desktop
---

# Settings section nav and phone pairing placement (desktop)

User intent: find the QR code that links a phone without hunting through one long Settings page, and see Settings split into clear sections.

- Settings has a section list on the left: **Help out the Nekko Team**, **General**, **Phone pairing**, **Computers** (when available), **Customize**, **Agents**, **Safety**, **Connections**, **Tools**, **System**. Clicking one jumps to that section with a fast scroll (about 200ms, ease-out; instant when the system asks for reduced motion), and the clicked item stays highlighted through the jump; the item for the section at the top of the page stays highlighted as you scroll. In a narrow window the list becomes a wrapping row above the page.
- The page is grouped to match, each group under its name at page-title size, with one hairline between groups (see [Quiet Settings](#quiet-settings-and-where-each-setting-lives-2563) for the order inside each):
  - Help out the Nekko Team: Help improve Nekko Agent (usage reports), Support by starring the project on GitHub.
  - General: Notifications, Chats, Desktop behavior, Language and help, Dictation, Chat history.
  - Phone pairing: Remote access, then Sync, then Organization (only when signed in to Nekko Cloud).
  - Computers: Connected computers and pairing.
  - Customize: About you, Appearance, Fonts and text ([Style](style-fonts-and-text-size.md)), Animations, Agents wall, View settings, Simple mode visibility, Customization (standing instructions), Fun.
  - Agents: Agent loop, Spec-driven development, Agent orchestration, Delegation routes, Hooks, Automations, Claude plan features.
  - Safety: Chat modes, Sandbox, Guardrails, Security.
  - Connections: All connections off and every connection with its log ([Connections](../platform/connections-switch-and-activity-log.md)).
  - Tools: Git management, Project management, Pull requests, Terminal, MCP servers.
  - System: Nekko Agent service, Updates, Developer, Experimental, Backup & restore, Data & privacy.
- Phone pairing follows General (third after Help out the Nekko Team), so the QR remains one click from opening Settings.
- In Remote access, **Paired devices** and **+ Pair a device** come first once remote access is on, and the pairing QR opens directly under the button, above the device list. Relay details, the local relay, network visibility, phone changes and phone access follow. Before remote access is on, the card offers two ways to connect, Tailscale or Nekko Cloud (see [remote control](../phone/driving-your-home-model-from-your-phone-remote-control.md)).
- The card keeps the name "Remote access", so every "Settings → Remote access" instruction in the apps and docs still points to it.
- Search within Settings stays in the rail and searches the whole page; the section list is not searched.
- Privacy and safety: layout only. No setting, pairing secret or relay behavior changes.

Status: implemented. The animated jump `[2026-10-23]` was checked in the same hidden renderer at 1280 and 640 wide: clicking System passes through intermediate scroll positions and lands on the section in about 195ms, with System highlighted. Checked in a hidden renderer of the full app with a stub bridge (dark theme, 1280×900 and 640×900): clicking Phone pairing highlights it and brings the card into view, Pair a device shows the QR fully on screen, no horizontal overflow. Not yet checked: light theme, the installed app, and the Local Web UI.

## Optional sidebar shortcuts (issue #1178)

Implemented. Skills and Connectors are rows at the very top of the Settings rail, before the section navigation, and wrap in a narrow window. Both sidebar shortcuts are hidden by default, including for existing settings with no saved preference. Customize > View settings independently opts each shortcut into the left rail. Hiding a shortcut does not disable its view or change access through Settings, the command palette or chat skill menus. Preferences persist through the existing settings API as `sidebarViews`; no credentials, permissions or remote calls are added.

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

- General holds how the app behaves day to day: Notifications; Chats (the chat pane's top-right action, Complete idle agents after, Confirm deletions); Desktop behavior (closing the window, low memory); Language and help (language, Show tips, the setup wizard); Dictation; Chat history. These rows used to sit inside Customize > Appearance, which now holds only the theme and background animation.
- Safety leads with Chat modes, the default for new chats, and Warn before No restrictions, then Sandbox, Guardrails and Security. The chat mode is the first safety decision people make, and it used to sit under Agents.
- Customize keeps how Nekko looks and addresses you; Agents keeps how agents run.
- Search within Settings and the command palette follow the moves: their entries for the moved controls point at General or Safety, and page searches such as "chat modes" or "close window" land on the new group. Section anchors (`#notifications`, `#desktop-behavior`, `#automations`, `#customization`, `#settings-style`, `#settings-animations`, `#settings-simple`, the Security anchor) are unchanged.

Privacy and safety: layout and copy only. No setting, default, save path, permission or step-up check changes. The unused Slash commands section, which no page rendered, is removed.

Status: implemented, not yet landed. Checked with the settings, search and palette tests and a hidden renderer capture (see the PR). Not yet checked: the installed app and the Local Web UI.

## Organization section (issue #2588)

Implemented in the desktop renderer; it needs the engine's `org:*` and `fleet:*` channels, so it shows "Organizations are not available in this version of Nekko Agent yet" until a build has them. Where: Settings > Phone pairing > Organization, under Sync. Signed out, the section is not shown. Signed in but not unlocked on this computer, it says to unlock with the recovery key or by approval, in Sync. With no organization it offers to create one and lists invitations to accept. With one it shows your role, the members (owners and admins can invite by email and remove members), the **Share this computer with <Org>** switch (off by default; it lists this computer and its local models for members, uploads no chats and lets nobody run anything yet), and the Computers list: name, OS icon, a This computer tag, an online dot or Last seen, and local models collapsed after three. There is no Connect or Run action. It refreshes on the Nekko Cloud status event and re-reads the Computers list every 15 seconds while the section is on screen. Unverified: the live engine and cloud (the channels are stubbed in the captures), the packaged app and the Local Web UI.
