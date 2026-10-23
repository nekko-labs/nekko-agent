---
title: "Settings section nav and phone pairing placement (desktop)"
area: desktop
---

# Settings section nav and phone pairing placement (desktop)

User intent: find the QR code that links a phone without hunting through one long Settings page, and see Settings split into clear sections.

- Settings has a section list on the left: **General**, **Phone pairing**, **Agents**, **Safety**, **Tools**, **System**. Clicking one jumps to that section; the item for the section at the top of the page stays highlighted as you scroll. In a narrow window the list becomes a wrapping row above the page.
- The page is grouped to match, each group under a small heading with a divider between groups:
  - General: Appearance, Desktop behavior, Fun, Agents wall, Customization, Dictation, Notifications.
  - Phone pairing: Remote access, then Sync.
  - Agents: Chat modes, Agent loop, Hooks, Spec-driven development, Agent orchestration, Delegation routes, Automations.
  - Safety: Sandbox, Guardrails.
  - Tools: Git management, Terminal, MCP servers.
  - System: Updates, Developer, Experimental, Backup & restore, Data & privacy.
- Phone pairing is second in the list on purpose, so the QR is one click from opening Settings.
- In Remote access, **Paired devices** and **+ Pair a device** come first once remote access is on, and the pairing QR opens directly under the button, above the device list. Relay details, the local relay, network visibility, phone changes and phone access follow. Before remote access is on, the card says that turning it on gives a QR code for the phone to scan.
- The card keeps the name "Remote access", so every "Settings → Remote access" instruction in the apps and docs still points to it.
- Search within Settings still searches the whole page; the section list is not searched.
- Privacy and safety: layout only. No setting, pairing secret or relay behavior changes.

Status: implemented. Checked in a hidden renderer of the full app with a stub bridge (dark theme, 1280×900 and 640×900): clicking Phone pairing highlights it and brings the card into view, Pair a device shows the QR fully on screen, no horizontal overflow. Not yet checked: light theme, the installed app, and the Local Web UI.
