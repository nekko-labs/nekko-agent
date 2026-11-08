---
title: "Settings section nav and phone pairing placement (desktop)"
area: desktop
---

# Settings section nav and phone pairing placement (desktop)

User intent: find the QR code that links a phone without hunting through one long Settings page, and see Settings split into clear sections.

- Settings has a section list on the left: **General**, **Phone pairing**, **Computers** (when available), **Customize**, **Agents**, **Safety**, **Connections**, **Tools**, **System**. Clicking one jumps to that section with a fast scroll (about 200ms, ease-out; instant when the system asks for reduced motion), and the clicked item stays highlighted through the jump; the item for the section at the top of the page stays highlighted as you scroll. In a narrow window the list becomes a wrapping row above the page.
- The page is grouped to match, each group under a small heading with a divider between groups:
  - General: Usage reports, Dictation, Notifications, Chat history.
  - Phone pairing: Remote access, then Sync.
  - Computers: Connected computers and pairing.
  - Customize: View settings, Appearance, Desktop behavior, Fun, Agents wall, Customization (About you and standing instructions), Fonts and text ([Style](style-fonts-and-text-size.md)), Accessibility, Simple mode visibility.
  - Agents: Chat modes, Agent loop, Hooks, Spec-driven development, Agent orchestration, Delegation routes, Automations.
  - Safety: Sandbox, Guardrails.
  - Connections: All connections off and every connection with its log ([Connections](../platform/connections-switch-and-activity-log.md)).
  - Tools: Git management, Project management, Pull requests, Terminal, MCP servers.
  - System: Updates, Developer, Experimental, Backup & restore, Data & privacy.
- Phone pairing is second in the list on purpose, so the QR is one click from opening Settings.
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

All four run edge to edge on the app background, with content centred and capped at the width of the Scheduled Tasks list, in standard bordered cards. Settings has a 240px left rail behind a hairline divider that stays put while the content scrolls. Its rows are shaped like the Scheduled Tasks category rows (rounded, the current one filled, with a visible keyboard focus outline) at 16px, larger than that page's on request. In a narrow window the rail becomes wrapping rows above the page. Models has no side menu ([decision 0057](../../docs/decisions/0057-models-is-one-page-without-a-side-menu.md)). The Skills tabs use the Scheduled Tasks filter buttons.

Search within Settings covers the page, so it no longer matches the Skills and Connectors rows, which are in the rail. No setting, credential or permission changes.

Status: implemented, not yet landed. Checked in a hidden renderer of the full app with a stub bridge (dark theme, 1440×900 and 600×900). Not yet checked: light theme, the installed app, and the Local Web UI.

## Customize grouping (issue #2097)

User intent: put appearance and experience settings under Settings > Customize, keeping computer connections and service management separate. This grouping applies to the existing desktop and shared Local Web UI renderer, not native phone navigation or the pending tone/catalog feature in #2055.

Implemented: a single Customize rail entry contains the existing personalization cards, including standing instructions for preferred response style. Existing setting fields, defaults, save handlers, permission boundaries and subsection anchors are retained. General keeps usage reports, dictation, notifications and chat history. Search remains available in the rail and still covers the whole settings page. Command-palette page results and indexed personalization controls target Customize; accessibility, font-size and Simple mode queries remain discoverable, and old subsection anchors still work.

Acceptance: each moved control appears once under Customize; Phone pairing stays second; System and Computers stay separate; navigation, search and preference saving work in wide and narrow layouts.

Verification: 31 initial focused settings/search tests passed. CI then caught a stale standalone Accessibility navigation assertion; the follow-up corrected it and stale command-palette destinations, added nine search-routing cases, and passed all 3,219 desktop tests across 349 files, profile/desktop production builds and desktop typecheck. Hidden Electron verified Customize search destinations and legacy style/accessibility/simple anchor positions; the fixture explicitly drains the navigation helper's two requestAnimationFrame callbacks because a never-shown window suspends them, so this proves destinations, not visible-window timing. Hidden, network-blocked Electron baseline/head captures and interaction assertions passed with no renderer errors at requested 1280x900 and 600x900 sizes. Pixel inspection remains blocked: browser screenshot timed out and native image delivery returned UnknownVizError. Captured images are not visually approved. Packaged desktop, deployed Local Web UI and native phone apps are unverified.
