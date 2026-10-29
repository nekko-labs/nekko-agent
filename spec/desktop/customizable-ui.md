---
title: "Customizable UI: customizations, mods and custom layouts"
area: desktop
---

# Customizable UI: customizations, mods and custom layouts

`[Planned. Implemented 2026-10-28: the .nekko package format (manifest checks and signatures), the layout and customization documents, and the mod sandbox's policy and bridge, all unit-tested and not yet used by the app. Nothing a person sees has changed.]`

User intent (Philip, 2026-10-28): "Let's enable people to customize their UI however they want." Nekko Agent becomes the engine, and the UI on top of it is something people can rearrange, restyle, extend or replace. All components can be moved. Simple and Expert are the official layouts. People can share what they make as a package in an open, non-proprietary format. Design: [2026-10-28-customizable-ui-design.md](../../docs/superpowers/specs/2026-10-28-customizable-ui-design.md). Decisions: [0032](../../docs/decisions/0032-three-layers-and-the-nekko-package.md), [0033](../../docs/decisions/0033-mods-may-run-agent-tools-behind-a-permission.md).

## Three layers, safest first

1. **Customizations.** Toggles and built-in options on top of Simple or Expert. These cover which controls show (the Show, Expert only and Hide choices), where components sit (moving the effort control into the title bar, for example), theme, accents, fonts and text size, the rail's order and entries, and the board's arrangement. They carry no code. With encrypted sync turned on (Pro and up) they follow the person to every device, and any field can be kept "this device only". Without sync they stay on the device and move by export and import.
2. **Mods.** Additions to Simple and Expert: panels, board panes, dock monitors, chat header and footer widgets, palette commands, themes, and a settings page. Mods are code written by other people. They come from a file or the marketplace, always show what they ask for before installing, and can carry a **Verified by Nekko** badge. A new mod's surfaces appear in Expert, and Simple only shows them once the person chooses Show.
3. **Custom layouts.** Anything at all: new dashboards, monitors, new functionality, or a different shell. They are made by asking Nekko to build one, in an Edit layout mode, or by hand in a folder. They stay on the computer where they were made. Sharing them is undecided.

Settings gets one area, **Look and layout**, with Customize, Mods and Layouts tabs.

## The `.nekko` package

- A plain zip with a `nekko.json` manifest at its root. The manifest gives the kind (`customization`, `mod` or `layout`), a reverse-DNS id, name, semver version, author, licence, the platforms it supports, the permissions it asks for, the network hosts it may reach, and what it contributes.
- The schema is published (`packages/shared/schemas/nekko-package-1.json`), so anyone can make or inspect a package with ordinary tools.
- An optional `SIGNATURES` file lists a SHA-256 for every file plus signatures over that list. The Verified badge means the Nekko Labs key signed exactly these bytes.
- Limits: 20 MB, no symlinks, absolute paths or `..` entries, and the manifest is checked before anything is unpacked. A `customization` package holds no code. `nekko.*` ids are reserved for the official layouts.

## Boundaries

- **Sandbox.** Every mod and custom-layout surface runs in a sandboxed frame with its own opaque origin, served from `nekko-mod://<id>/`. It never gets the engine token, the preload bridge, cookies or Node. Its content policy blocks all network use unless it holds the `network` permission, and then it can reach only the HTTPS hosts its manifest lists.
- **Permissions**, asked in plain words when installing: `chats:read`, `chats:content`, `chats:write`, `hardware:read`, `usage:read`, `network`, `files:read` and `files:write` (through a picker), and `tools:run`. Updates that add permissions ask again. A custom layout whose code files change asks again, whoever changed them.
- **`tools:run`** lets a mod ask the engine to run agent tools. It is shown as the highest risk. Every call goes through the tool policy with the mod as the actor, and that policy defaults to Ask. Calls are limited to folders the person picks and logged under the mod's name. Credentials and the engine token are never reachable, even this way.
- **The way back.** The layout switch and the command palette always return to Simple or Expert. Holding Shift at launch, or `--safe-mode`, starts in Simple with every mod off. A custom layout that fails to draw falls back to the last official layout.
- **Privacy.** Synced customizations hold only preferences: no chat titles, folder paths, keys or machine names. The synced list of mods never installs anything. It only offers Install on other devices.
- **Scope.** Mods and custom layouts are desktop only at first. The Local Web UI and the phones get customizations only.

## Status

- Implemented and unit-tested, not yet wired into the app:
  - `packages/shared/src/nekko-package.ts`: manifest and entry checks.
  - `nekko-package-signature.ts`: the listing, signing and verification.
  - `ui-layout.ts`: layout and customization documents, and slot resolution.
  - `apps/desktop/src/modPolicy.ts`: the sandbox content policy and path resolution.
  - `renderer/mods/bridge.ts`: the permission-checked bridge.
- Planned: the surface registry and moving official components onto it, Simple and Expert as layout documents, the Look and layout settings, migration and sync, mod install with the `nekko-mod://` protocol, the marketplace, Edit layout mode, custom layouts, and the authoring skill. These wait for the current composer and Simple/Expert rework to land (TASKS CUI-6 to CUI-12).
