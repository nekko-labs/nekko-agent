---
title: "Settings section nav and phone pairing placement (desktop)"
area: desktop
---

# Settings section nav and phone pairing placement (desktop)

User intent: find the QR code that links a phone without hunting through one long Settings page, and see Settings split into clear sections.

- Settings has a section list on the left: **General**, **Phone pairing**, **Style**, **Agents**, **Safety**, **Connections**, **Tools**, **System**. Clicking one jumps to that section with a fast scroll (about 200ms, ease-out; instant when the system asks for reduced motion), and the clicked item stays highlighted through the jump; the item for the section at the top of the page stays highlighted as you scroll. In a narrow window the list becomes a wrapping row above the page.
- The page is grouped to match, each group under a small heading with a divider between groups:
  - General: Appearance, Desktop behavior, Fun, Agents wall, Customization, Dictation, Notifications.
  - Phone pairing: Remote access, then Sync.
  - Style: Fonts and text ([Style](style-fonts-and-text-size.md)).
  - Agents: Chat modes, Agent loop, Hooks, Spec-driven development, Agent orchestration, Delegation routes, Automations.
  - Safety: Sandbox, Guardrails.
  - Connections: All connections off and every connection with its log ([Connections](../platform/connections-switch-and-activity-log.md)).
  - Tools: Git management, Project management, Pull requests, Terminal, MCP servers.
  - System: Updates, Developer, Experimental, Backup & restore, Data & privacy.
- Phone pairing is second in the list on purpose, so the QR is one click from opening Settings.
- In Remote access, **Paired devices** and **+ Pair a device** come first once remote access is on, and the pairing QR opens directly under the button, above the device list. Relay details, the local relay, network visibility, phone changes and phone access follow. Before remote access is on, the card offers two ways to connect, Tailscale or Nekko Cloud (see [remote control](../phone/driving-your-home-model-from-your-phone-remote-control.md)).
- The card keeps the name "Remote access", so every "Settings → Remote access" instruction in the apps and docs still points to it.
- Search within Settings still searches the whole page; the section list is not searched.
- Privacy and safety: layout only. No setting, pairing secret or relay behavior changes.

Status: implemented. The animated jump `[2026-10-23]` was checked in the same hidden renderer at 1280 and 640 wide: clicking System passes through intermediate scroll positions and lands on the section in about 195ms, with System highlighted. Checked in a hidden renderer of the full app with a stub bridge (dark theme, 1280×900 and 640×900): clicking Phone pairing highlights it and brings the card into view, Pair a device shows the QR fully on screen, no horizontal overflow. Not yet checked: light theme, the installed app, and the Local Web UI.

## Optional sidebar shortcuts (issue #1178)

Implemented. Skills and Connectors are large, wrapping chips at the very top of Settings, before the section navigation. Both sidebar shortcuts are hidden by default, including for existing settings with no saved preference. General > View settings independently opts each shortcut into the left rail. Hiding a shortcut does not disable its view or change access through Settings, the command palette or chat skill menus. Preferences persist through the existing settings API as `sidebarViews`; no credentials, permissions or remote calls are added.

Acceptance: both chips navigate to their views, each toggle saves independently, and both desktop and narrow layouts keep them legible. Verified with focused navigation tests and hidden, network-blocked Electron fixture interaction checks and matching screenshots. Packaged apps and native phone clients are not verified.
