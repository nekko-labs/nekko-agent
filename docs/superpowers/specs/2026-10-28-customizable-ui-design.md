# Customizable UI: customizations, mods and custom layouts

Date: 2026-10-28. Apps: desktop (Electron renderer) for everything. The Local Web UI (same renderer, served to a browser) and the iPhone and Android apps get customizations only. *Builder's call:* mods and custom layouts depend on a `nekko-mod://` protocol and a per-user permission prompt. A Local Web UI server can be reached by several browsers, and on Nekko Cloud machines it runs headless, so it has neither. Mods there wait until an isolated mod origin and a per-browser grant are designed.

## Intent

Philip wants people to shape Nekko Agent's interface however they like. Nekko Agent becomes the engine, and the UI on top of it is something users can rearrange, restyle, extend or replace. Every component can be moved. Simple and Expert become the two official layouts. Users can then go further in three layers, ordered from safest to riskiest:

1. **Customizations.** Toggles and built-in options applied to an official layout: which controls show, theme and colours, fonts, navigation order, which views are in the rail, and the board's arrangement. These are pure data with no code. They are safe for Nekko Labs to store, so they sync through Nekko Cloud.
2. **Mods.** Additions to an official layout, such as a new panel, a dock monitor, a command, a theme or a settings page. This is the same idea as a Claude Code plugin like ponytail adding a status line and commands. Mods contain code. They can be shared through a marketplace, always show a warning on install, and can carry a "Verified by Nekko" badge.
3. **Custom layouts.** Anything at all: new dashboards, monitors, new functionality, or a completely different shell. Custom layouts stay on the machine where they were made. Sharing them is undecided because a full layout is the most power you can hand a stranger.

Settings gets one new area that manages all three.

The package format these travel in is an open pattern (a plain zip plus a JSON manifest with a published schema), not a proprietary format. Anyone can read or write it with ordinary tools.

## Goals

1. Every user-facing surface (view, panel, pane kind, dock monitor, command, rail entry, overlay) has a stable id and is placed by data, not by hard-coded JSX.
2. Simple and Expert are two official layouts expressed in that data.
3. One customizations document per user. It can be exported and imported, and it syncs through Nekko Cloud.
4. Mods install from a file or from the marketplace, run sandboxed, ask for named permissions, and can be turned off or removed in one click.
5. Custom layouts can be created and used locally, can reuse any official surface by id, and can add their own sandboxed surfaces.
6. One package format, `.nekko` (a zip with a `nekko.json` manifest), covers all three kinds.
7. People always have a way back. A broken mod or layout can never lock someone out of the official UI.

## Non-goals (this version)

- Sharing custom layouts, through the marketplace or by file. This is "TBD" until we have seen mods in the wild.
- Mods or custom layouts on the iPhone or Android apps.
- Mods that change engine behaviour (the agent loop, tools, providers). Mods are UI. Engine extension stays with MCP servers, skills and hooks.
- Paid mods, revenue share or author payouts.
- A mod SDK published to npm. The manifest schema and a bridge type file are enough to start.

## Anti-goals (failure even if it works)

- A mod that can read the engine token or credentials at all, or read chats, read files or run tools without the user having granted that permission in a prompt they could read.
- A mod that silently reaches the network.
- A user stuck in a broken layout with no way back.
- Customizations synced in a way that leaks anything beyond UI preferences (no chat titles, paths, model keys or machine names).
- Rework: building the surface registry on top of components that are being rebuilt this week (see Sequencing).
- Simple getting busier. Simple stays the calm default, and the customization area itself is a Settings page, not a new control on every screen.

## What exists today (2026-10-28)

- **Shell is hard-coded.** `apps/desktop/src/renderer/App.tsx` has the `NAV` array (lines 62 to 73), the rail (271 to 325), a `view === ...` chain picking views (338 to 349), and fixed overlays (385 to 395). Nav order and visible rail views are already settings (`nav-order.ts`, `settings.navOrder`, `settings.sidebarViews`).
- **The board is data within closed unions.** `layout.ts` is a split tree whose `PaneKind` (line 34) is a closed union rendered by `switch` statements (`CommandWall.tsx` 126 to 134). `commandWall.ts` holds `CommandWallState`, `MONITORS` and `INSIGHT_PANELS`. `MonitorsDock.tsx` renders monitors from a hard-coded chain. Zones (`spec/desktop/dynamic-zones.md`) are panes with `zone` set.
- **Command palette** (`CommandPalette.tsx` 35 to 65) is a fixed array. Shortcuts are a fixed object in `shortcuts.ts`.
- **Themes** are data: `packages/shared/src/themes.ts` (`ThemePreset`, `THEME_PRESETS`), applied by `store.ts` `applyTheme` as CSS variables and `data-theme`/`data-preset`. Choices live in AppSettings (`theme`, `themePreset`, `accent`, `accent2`, `fontSans`, `fontMono`, `textScale`).
- **Settings** are `settings.json` in the data folder, written over IPC (`settingsUpdate`). Several small UI choices live only in localStorage.
- **Simple and Expert** ([PR #1312](https://github.com/nekko-labs/nekko-agent/pull/1312), open, being tried by Philip) adds `packages/shared/src/simple-mode.ts`: a catalogue of controls, each Show, Expert only or Hide, with copies on iPhone and Android. [Decision 0030](../../decisions/0030-simple-hides-developer-controls-per-device.md) keeps those choices per device and never synced.
- **Nekko Cloud sync** is end-to-end encrypted record sync (`crates/nekko-cloud`, `apps/nekko-agent-api/src/sync.ts`). It handles only `chat` and `account` collections today, accepts any collection name matching `^[a-z][a-z0-9-]{0,31}$`, is Pro and up, and is not yet switched on for users (waiting on the outside crypto review, ES-10).
- **Untrusted HTML** is already isolated two ways: `sandbox=""` srcdoc iframes with a `default-src 'none'` CSP (`ArtifactPreview.tsx`), and a separate preview window on a one-time-token loopback server with no engine token or preload (`src/main/artifactPreview.ts`, `src/previewPolicy.ts`).
- **No UI extension mechanism exists.**

## Design

### 1. The surface registry (the foundation)

A registry in the renderer maps surface ids to what they are and how to render them:

```ts
interface Surface {
  id: string;                 // 'view.agents', 'panel.monitors.hardware', 'control.chat.effort', 'cmd.new-chat'
  kind: 'view' | 'pane' | 'monitor' | 'panel' | 'control' | 'command' | 'overlay';
  label: string;              // i18n key
  slots: SlotId[];            // where it is allowed to go
  platforms: Array<'desktop' | 'phone'>;
  source: 'official' | { mod: string };
  render?: ComponentType;     // official surfaces only; mod surfaces render through the sandbox host
}
```

- Slots are the named places a layout fills: `rail`, `titlebar.start`, `titlebar.end`, `main`, `board.pane`, `dock.monitors`, `chat.header`, `chat.composer`, `chat.footer`, `settings.section`, `palette`, `overlay`.
- The hard-coded lists become registrations: `NAV`, the view chain, `PaneKind` switches, `MONITORS`/`INSIGHT_PANELS`, and the command palette array. `PaneKind` widens from a closed union to `string` with a registry lookup. Unknown ids render a small "missing surface" placeholder instead of crashing (for example, a layout that names a mod that has been removed).
- The Simple mode catalogue ids from PR #1312 are reused as `control.*` surface ids, so customizations saved under that catalogue carry over unchanged.

### 2. Layout documents

A layout is a JSON document, validated against a schema, that the shell renders:

```jsonc
{
  "id": "nekko.expert",
  "name": "Expert",
  "slots": {
    "rail": ["view.agents", "view.workflows", "view.models", "view.workspaces", "view.settings"],
    "titlebar.end": ["control.mode-switch"],
    "dock.monitors": ["monitor.hardware", "monitor.models", "monitor.budget"]
  },
  "visibility": { "control.chat.effort": "show", "control.chat.cost": "expert" },
  "board": { "arrangement": "dynamic", "zones": 2 },
  "theme": null                 // null means "use the person's theme"
}
```

- **Official layouts:** `nekko.simple` and `nekko.expert` ship in the app and are read-only. The Simple/Expert switch from PR #1312 becomes "switch between these two layouts". To begin with they share one structure and differ only in visibility, which is what decision 0030 describes. They are free to diverge later.
- **Custom layouts:** start as a copy of an official layout, or from blank. They can name any official surface, plus surfaces from their own package (sandboxed, as for mods).
- **The way back:** the title bar's layout switch and the command palette can always return to an official layout. Starting the app with Shift held (and a `--safe-mode` flag) loads `nekko.simple` with every mod off. If a custom layout fails to render, the error boundary falls back to the last official layout and says why.

### 3. Customizations

One document per user, applied on top of whichever official layout is active:

```jsonc
{
  "format": 1,
  "layout": "nekko.simple",
  "visibility": { "control.chat.effort": "show" },     // today's SimpleChoices
  "nav": { "order": [...], "hidden": [...] },          // today's navOrder / sidebarViews
  "theme": { "preset": "nekko-dark", "accent": null, "accent2": null, "fontSans": null, "fontMono": null, "textScale": 1 },
  "board": { "arrangement": "dynamic" },
  "placements": { "control.chat.effort": "titlebar.end" },  // moved surfaces: surface id -> slot
  "mods": { "com.example.gpu-wall": { "enabled": true } }   // which mods, not the mods themselves
}
```

- **Moving components is a customization** (Philip, 2026-10-28). Dragging an official or mod surface to another slot in Simple or Expert is saved in `placements` and syncs like any other preference. A custom layout is only needed for new code of one's own or a different shell.
  - The shell resolves each slot in this order: the official layout's slot contents, then mod default placements, then the person's `placements`. A surface is in one slot at a time, so a placement removes it from where it was.
  - A placement is honoured only if the registry allows that surface in that slot. A placement naming a surface or slot that no longer exists is kept in the document and ignored on screen, so it comes back if the surface returns.
  - Placements apply to both official layouts unless pinned to one: `"control.chat.effort": { "slot": "titlebar.end", "layout": "nekko.expert" }`.
- **What's included:** only these preference fields. Window sizes, which screen a window is on, folder paths, the board's current agents and anything naming a chat stay on the device. That boundary lets the document sync without leaking anything personal.
- **Sync** (Philip, 2026-10-28): a new `prefs` collection in the existing end-to-end encrypted Nekko Cloud sync, so it is Pro and up and goes live when sync does (after the outside crypto review, ES-10). It uses the same records, merge (newest wins per field) and revocation as chats. Nothing new is stored on the server in the clear. Without sync, customizations stay on the device, as decision 0030 has them, and move between machines by export and import.
- **Per-device overrides:** a device can pin a field as "this device only" (for example a bigger text size on a laptop). The default is to follow the synced value.
- **Export and import:** a customizations document can be exported as a `.nekko` package of kind `customization` and imported anywhere. Because it carries no code, importing one shows no warning.
- **Migration:** the first launch after this ships folds the existing AppSettings fields and Simple mode choices into the document. Nothing changes on screen.
- *Builder's call, first sync:* the first device to turn sync on uploads its document. When a later device joins, any field where its own value differs from the cloud's is pinned as "this device only", so joining never changes what is on that screen. The person can unpin fields in Customize.
- *Builder's call, mods on other devices:* the synced `mods` map never installs anything. A device that lacks a listed mod shows it under "On your other devices" in the Mods tab, with an Install button that goes through the normal install sheet.

### 4. Mods

A mod is a package of kind `mod`. It contributes surfaces into slots of the official layouts (and of custom layouts that allow it).

**What a mod can contribute (v1):**

- panels and board pane kinds (`board.pane`, `main`)
- dock monitors (`dock.monitors`)
- chat header and footer widgets (`chat.header`, `chat.footer`)
- commands in the palette, with optional default shortcuts that the user can override
- themes (pure data, the `ThemePreset` shape)
- one settings section for the mod's own options

**How a mod runs: sandboxed.** This uses the same pattern the app already uses for artifacts:

- Each mod surface renders in an iframe with `sandbox="allow-scripts"` and no `allow-same-origin`, which gives it an opaque origin. Its files are served from a custom `nekko-mod://<id>/` protocol handled in the main process.
- The CSP is `default-src 'none'` plus the mod's own scripts and styles. `connect-src` is `'none'` unless the mod holds the `network` permission, and then it lists only the hosts the manifest declares.
- A mod never gets the engine token, the preload bridge, cookies or Node.
- A mod talks to the app only through a `MessageChannel` bridge (`nekko.*`). The host checks each call against the permissions the user granted.
- The app's theme variables are pushed into the frame, so mod surfaces look native and follow theme changes.
- An optional hidden `main` frame runs background code, such as polling for a monitor.

**Bridge API and the permissions behind it (v1):**

| Permission | Grants |
| --- | --- |
| *(none)* | Theme variables, its own storage (a small key-value store), registering its commands, `ui.toast`, opening an official view |
| `chats:read` | Chat list with titles, status and model; no message content |
| `chats:content` | Message content of chats |
| `chats:write` | Start a chat, send a message, stop a chat |
| `hardware:read` | CPU, GPU and memory readings, loaded models |
| `usage:read` | Token use, cost, limits |
| `network` + `hosts` | Fetch to the listed hosts only |
| `files:read` / `files:write` | Through a picker the user drives, never a raw path |
| `tools:run` | Ask the engine to run agent tools (shell, file edits, browser, MCP tools) |

**`tools:run`** (Philip, 2026-10-28: mods may run agent tools):

- The install sheet shows it as the highest risk, in its own red row, worded as "This mod can run commands and change files on this computer, like an agent can".
- Every call goes through the engine's existing tool policy (Ask, Guardrails or YOLO), as if the mod were an agent chat. The mod gets its own policy, which defaults to **Ask** whatever the person's chat default is. Each run is logged in the activity log under the mod's name.
- Tool runs are scoped to folders the person picks for that mod, the way a chat's folder scopes an agent.
- Turning the mod off stops any tool run it started.

Credentials, the engine token and settings outside the mod's own are not available to mods at all, including through `tools:run` (the engine refuses to hand those to a mod-originated call).

**Install:**

- Installing a mod from a file or the marketplace shows a sheet with its name, author, the permissions it asks for in plain words, whether it is Verified, and a warning that mods are code written by other people. Unverified mods get a stronger warning.
- *Builder's call:* each contribution declares a default slot in its manifest. A mod's contributions appear in **Expert** in those slots, and are Expert only in Simple's visibility, so Simple never gets busier on its own. Someone who wants a mod surface in Simple chooses Show for it, as with any control. Placements are stored in the customizations document under `placements` (see section 3).
- Mods can be turned off, or removed with all their storage, in Settings.
- Updates that ask for new permissions ask again.

**Verified by Nekko:** Nekko Labs reviews a mod's source and signs that exact package hash with a Nekko Labs key, which the app pins. The badge shows only when the signature matches the installed bytes. Any change, even one byte, drops the badge until it is re-reviewed.

### 5. The package format: `.nekko`

The format is an ordinary zip. Its root holds `nekko.json`:

```jsonc
{
  "$schema": "https://nekkoagent.com/schemas/package-1.json",
  "format": 1,
  "kind": "mod",                       // "customization" | "mod" | "layout"
  "id": "com.example.gpu-wall",        // reverse-DNS, unique
  "name": "GPU wall",
  "version": "1.2.0",                  // semver
  "description": "...",
  "author": { "name": "...", "url": "..." },
  "license": "MIT",
  "engines": { "nekko-agent": ">=0.9.0" },
  "platforms": ["desktop"],
  "permissions": ["hardware:read"],
  "network": { "hosts": [] },
  "contributes": {
    "panels":   [{ "id": "gpu-wall", "label": "GPU wall", "slots": ["board.pane", "main"], "entry": "panel.html" }],
    "monitors": [],
    "commands": [{ "id": "gpu-wall.open", "label": "Open GPU wall", "shortcut": null }],
    "themes":   [],
    "settings": null
  },
  "main": null,                        // optional background entry
  "layout": null,                      // kind "layout": path to the layout document
  "customization": null                // kind "customization": the document inline
}
```

- **Open:** the JSON Schema is published on nekkoagent.com and kept in `packages/shared`. A package can be built with `zip` and a text editor, and inspected with `unzip -l`.
- **Integrity:** an optional `SIGNATURES` file at the zip root lists a SHA-256 for each file plus detached signatures over that list. "Verified" is the Nekko Labs signature. Author signatures can come later.
- **Limits:** 20 MB per package. No symlinks, absolute paths or `..` entries. The manifest is validated before anything is unpacked.
- **Kinds:** a `customization` package carries no code files. A `mod` package carries web files (HTML, JS, CSS, images, fonts). A `layout` package carries a layout document plus web files for its own surfaces.

### 6. Custom layouts

- **Three ways to make one** (Philip, 2026-10-28: all three), and the same three apply to mods:
  - **Ask Nekko.** The agent builds layouts and mods from a prompt ("build me a GPU dashboard"). A bundled skill gives it the manifest schema, the bridge API, the slot and surface ids, and a starter template. It writes into `layouts/<id>/` (or `mods-dev/<id>/` for a mod), and the result opens in the app.
  - **Edit layout mode.** Created in Settings (Duplicate an official layout, or New blank) or from the layout switch. Each slot shows its surfaces as cards that can be dragged between slots, removed, or added from a surface picker listing official and mod surfaces. The same mode, used on Simple or Expert, writes `placements` instead of a new layout.
  - **By hand.** The files in `layouts/<id>/` and `mods-dev/<id>/` are plain, and the app reloads them when they change.
- Their own surfaces (new dashboards, new functionality) are web files run in the same sandbox and bridge as mods, with the same permissions model and the same install-style prompt the first time a layout asks for a permission.
- They are stored under the data folder in `layouts/<id>/`, unpacked. A developer can edit those files directly and the app reloads them.
- *Builder's call:* permission grants are tied to a layout's id plus a hash of its code files. When the files change, whether a person or the agent changed them, a layout asking for any permission beyond the no-permission set prompts again. The agent cannot use a layout to get around the permission prompt.
- They are never synced and never uploaded. Export to `.nekko` exists only behind a developer setting, and import of a `layout` package is off, until sharing is decided.

### 7. Settings: one area for all three

A new Settings section, **Look and layout**, has three tabs:

- **Customize:** the layout switch (Simple, Expert, then custom layouts), theme, fonts and text size, nav order, and today's "Choose what Simple shows". Existing Style and Simple mode pages move here.
- **Mods:** installed mods (on/off, permissions, Verified badge, remove), Install from file, and Browse marketplace.
- **Layouts:** custom layouts (use, edit, duplicate, delete) and the safe-mode explanation.

### 8. Marketplace (v1)

- An index at `nekkoagent.com/mods/index.json` lists the mods with name, author, version, permissions, verified flag, download URL and package hash.
- The source is a public `nekko-labs/nekko-mods` repo. Authors submit by pull request, sending the built files that will ship along with their source. The review covers the shipped bytes. Merging lists a mod unverified, and CI hashes the package and regenerates the index.
- *Builder's call:* the Verified key is never held in CI. Nekko Labs signs reviewed package hashes offline, following the same kind of ceremony as the research key (`docs/research-key-ceremony.md`), and commits the signature to the repo.
- The app's Browse view reads the index and installs through the same sheet as a file install, checking the hash before unpacking.
- Moving the index into Nekko Cloud with accounts, ratings and takedowns is later work.

### Phones

The iPhone and Android apps get customizations only: theme, visibility for the controls they have (the catalogue already marks platforms), and nav where it applies, all synced through the same `prefs` record. Fields a phone does not understand are kept and passed through untouched. Mods and custom layouts on phones are out of scope for this version.

## Sequencing (what can start now without rework)

The renderer shell, the wall composer and the chat panes are being reshaped this week (Composer window consolidation, PR #1312 Simple and Expert). Work that touches those components waits. Work that does not can start now.

**Can start now (no shell files touched):**

1. Spec file, decision records (the layered model, the `.nekko` format, customizations syncing for people who turn on encrypted sync, which amends the "never synced" part of decision 0030, and mods running agent tools), and a TASKS group.
2. `packages/shared/src/nekko-package.ts`: the manifest types, JSON Schema, a never-throws validator (in the style of `parseSimpleChoices`), and path and size checks, with unit tests.
3. `SIGNATURES` hashing and verification in the same module, with a shared test vector.
4. The layout document and customizations document types, schemas and validators. They depend on nothing in the renderer. Fields that mirror `SimpleChoices` are typed independently until PR #1312 merges.
5. The mod sandbox host as a standalone piece: the `nekko-mod://` protocol handler, CSP, iframe host component, and the bridge with permission checks, exercised by a fixture page rather than mounted in the shell.

**Waits for the reshape to land:**

6. The surface registry and migrating `NAV`, views, pane kinds, monitors and the command palette onto it.
7. Simple and Expert as layout documents (after PR #1312 merges).
8. The Look and layout settings section, customizations migration and sync.
9. Mod install, the marketplace, Edit layout mode and custom layouts.

## Decided with Philip (2026-10-28)

- Three layers: customizations (sync), mods (shareable, marketplace, warning, Verified), custom layouts (local; sharing TBD).
- Moving components in Simple and Expert is a customization (`placements`) and syncs.
- Customization sync rides the end-to-end encrypted sync: Pro and up, live after ES-10.
- Mods and layouts can be made by asking Nekko, in Edit layout mode, or by hand.
- Mods may run agent tools, behind `tools:run` and the engine's tool policy.

## Builder's calls Philip should check

- Mods and custom layouts are desktop only in v1 (not the Local Web UI or phones).
- A mod's surfaces appear in Expert and are Expert only in Simple until the person chooses Show.
- On first sync, a joining device pins its differing values as "this device only", so nothing changes on its screen.
- The synced mods list never installs anything on another device.
- Marketplace v1 is a public GitHub repo plus a static index. The Verified key is signed offline, never held in CI.
- Changing a layout's or mod-in-development's code files re-prompts for its permissions, whoever made the change.
- The package extension is `.nekko`, with `nekko.json` as the manifest.

## Left to the builder

- Exact slot names and the surface id naming scheme beyond the examples above.
- Bridge method names and message shapes.
- The Edit layout mode's visual design (it follows the zones drag-and-drop language in `spec/desktop/dynamic-zones.md`).
- How the registry is split across files, and how official surfaces register (side-effect imports or one table).
- Copy for the warnings, kept plain and short.
