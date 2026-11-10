---
title: "Profiles"
area: platform
---

# Profiles

**Status: planned. Designed 2026-11-10, nothing implemented.** No profile entity, switcher, storage layout or API exists in the code yet. The design canvas (private to Philip) holds the screens and diagrams; this file is the written source. Why this shape: [decision 0078](../../docs/decisions/0078-profiles-are-a-scope-below-the-data-folder.md).

## Intent

One person, one Nekko account, several separate lives: Personal, Work, a client. A profile keeps its own chats, settings, permissions, connectors, model accounts, repositories and folders. Switching profile changes everything the app shows and everything an agent can reach.

The requirement that drives the design (Philip, 2026-11-10): **a model running in one profile must not have access to another profile's content.** Not through a tool, a search, a saved note, a connector, a sub-agent, a scheduled run or a prompt the app assembles.

This is not the existing "data profile" (the `~/.nekko-agent` folder, [legacy consolidation](../../docs/legacy-profile-consolidation.md)), the Claude Code named accounts ([accounts and switching](../models/accounts-and-switching.md)), or the Auto mode tiers. In the UI and the docs, "profile" means this feature from now on; the data folder is "the data folder".

## Who the boundary is against

- **In scope:** a model in profile A, including one steered by text it read (a web page, a file, an MCP result), using every tool and every piece of context the app gives it.
- **Out of scope:** a person at the unlocked computer. They can switch profile. A per-profile lock (passcode or the OS biometric) is a later addition, not part of this design.
- **Out of scope:** the daemon itself. `nekkod` serves every profile and can read every profile's data. The boundary is what it hands to a model.
- **Not a network boundary.** The one network switch ([decision 0020](../../docs/decisions/0020-one-network-switch-enforced-in-the-engine.md)) stays machine-wide.

## What the user sees

- **Switcher.** The profile's mark (a coloured square with its initial) sits at the bottom of the left rail, under Send feedback; its name shows beside it when the rail expands (Philip, 2026-11-10: at the bottom of the navbar, not the top). It opens a menu upward with two jobs. Quick switch: the profiles as dense rows, each with its agent status in words ("1 needs you · 2 working"). Then Profile details, which opens Settings > Profiles on the current profile, and New profile. `Ctrl/Cmd+1..9` switches. The whole window crossfades (200ms); nothing from the old profile stays on screen.
- **Agents keep working.** Switching away does not stop a profile's agents, scheduled runs or workflows. Their approvals wait in that profile; the switcher row and the OS notification say which profile needs you. A notification names the profile and the chat title only when that profile's own notification setting allows it.
- **A chat belongs to one profile for life.** New chats, sub-agents, scheduled agents and workflow runs take the profile they were made in.
- **New profile.** Name and colour. It starts empty. Optional one-time copies from the current profile: look and shortcuts, permission rules, skills and prompts. Chats, saved notes, folders, connectors and sign-ins are never copied.
- **Settings > Profiles.** The list, then the selected profile: name, colour, what is only in it (counts), what every profile shares, Export this profile, Delete profile. Deleting asks once, says what goes, and cannot be undone, so it is a confirmation and not an Undo toast.
- **Crossing over is the user's act only.** A chat's menu has Move to profile (with Undo). Moving drops the chat's folder attachments and connector choices; the user re-adds them in the new profile. No agent tool can move, copy, list or name another profile.
- **A folder in two profiles.** Adding a folder that another profile already has asks: "Share this folder with Personal? It is in Work. Adding it here lets models in both profiles read and change it." The default button keeps it in one profile.
- **When a model reaches across.** The tool row reads "Could not read `<path>`. That folder is in your Work profile." with Continue in Work. The model is told only that the path is outside what it may read: never the other profile's name, nor that one exists.
- **Phones.** The chat list's title is the profile; tapping it opens a sheet of the profiles this phone may open. Profiles are made and deleted on a computer. iOS and Android ship together ([in step](../phone/ios-and-android-stay-in-step.md)).
- **First run after the update.** Everything a user has becomes one profile named Personal. Nothing asks them to choose, and nothing changes until they make a second one.

## What is per profile and what is shared

| | Scope | How it is kept apart |
| --- | --- | --- |
| Chats, pictures, command logs, pending file changes | Profile | `profiles/<id>/sessions/`, `changes/`; a chat's profile is fixed at creation |
| Saved notes, skills, prompts, About you | Profile | The context builder only reads through the profile's scope |
| Settings, saved modes, permission and guardrail rules | Profile | `profiles/<id>/settings.json`; an approval in one profile grants nothing in another |
| Model accounts, API keys, connector and MCP tokens | Profile | A vault namespace per profile |
| Connectors and MCP servers | Profile | One server process per profile, started with that profile's tokens and environment |
| Folders, repositories, chat worktrees, clone folder | Profile | The profile's tool roots; search index per profile |
| In-app browser | Profile | Its own cookie and storage partition |
| Scheduled agents, workflows, watches, sub-agents | Profile | Inherit their creator's profile; run under it in the background |
| Claude Code and Codex | Profile | Their own config directory per profile ([decision 0014](../../docs/decisions/0014-claude-agent-accounts-through-claude-config-dir.md)) |
| Audit trail | Profile | `profiles/<id>/audit/` |
| Downloaded models, the engine, Model Server, calibration | Shared | Hold no user content |
| Nekko account, device keys, paired phones, linked computers, runners | Shared | One account owns every profile; a paired device carries the list of profiles it may open |
| Network switch, updates, the daemon log | Shared | The machine log records events, never chat or file content |

## Technical design

### Data model

- `Profile { id, name, color, createdAt }`. `id` is `p_` plus 12 random hex characters, never reused, never shown.
- `<data>/profiles.json` is the machine-level registry: the profiles, and the last profile each window used. It is the only place a profile's name is stored outside its own folder.
- A chat record gains `profileId`. It is written once. Loading a chat whose `profileId` does not match the folder it sits in fails closed.

### On disk

```
<data>/
  profiles.json
  profiles/<id>/
    settings.json   sessions/   memory/   changes/   audit/
    skills.json   tasks.json   workflows*.json   comments.json   design.json
    agent-watches.json   workflow-checkouts/   sandboxes/   harness/
  models/  logs/  run/  cloud/  remote.json  runners/  desktop/   (machine level)
```

`settings.json` splits in two. Machine settings (engine, Model Server, network switch, updates, hardware) stay at `<data>/settings.json`. Everything else moves under the profile: providers, connectors, MCP servers, folders, guardrails, prompts, saved modes, favourites, skill sources, clone folder, look.

### Migration

At first start on the new version, under the existing data-folder lock, the daemon creates `profiles/<id>/` for a profile named Personal and moves the per-profile files into it. The move is journaled in `migration.json` and resumes after a crash; a rename within one volume, so no copy and no extra disk. Secrets are re-keyed lazily: a legacy name is read once, written under the profile's namespace, verified, then removed, the same order [decision 0051](../../docs/decisions/0051-one-macos-keychain-item-per-profile.md) uses. An older build opening a migrated folder refuses to start instead of showing an empty app.

### Enforcement, outermost first

1. **Scope by construction.** A `ProfileScope` is the only way to reach a per-profile store. The daemon builds one set of stores per profile (`SessionStore`, `Settings`, `Accounts`, memory, tasks, workflows, watches) from the scope's own folder, where today it builds one set from `data_dir` (`crates/nekkod/src/main.rs`). No store takes a raw path from a request. Every IPC and HTTP route resolves the caller's profile first; a chat id from another profile is "not found", indistinguishable from a chat that never existed. A lint fails CI on `data_dir.join(` outside the scope module and the machine-level allowlist.
2. **Tool roots.** `ToolContext` (`crates/nekko-tools/src/context.rs`) carries the scope. `app_data_root` becomes the profile's folder. `assert_in_jail` (`crates/nekko-tools/src/sandbox.rs`) gains a deny set that is checked before everything else and in every sandbox mode, including Off and Ask everything: the `profiles/` tree outside this profile, the machine-level secrets fallback file, and every folder that belongs only to other profiles. A denied path cannot be approved: the approver is never asked, because approval in this profile must not grant another profile's content. Resolution reuses the existing symlink-resolved recheck and adds Windows cases (junctions, 8.3 names, `\\?\` and UNC forms, case folding).
3. **Shell and processes.** `bash` and `start_process` run as the OS user, so the file-tool jail does not contain them. Three measures, in this order of delivery:
   - A guardrail that cannot be turned off or approved: a command whose arguments or working directory resolve into the deny set is refused before it runs. This is a check on the command text and is best effort.
   - The process environment and working directory come from the scope: no other profile's tokens, config directories or paths in the environment.
   - An OS sandbox for agent commands that makes the deny set unreadable to the process tree: Seatbelt on macOS, Landlock on Linux, a restricted token with deny entries on Windows. Nekko Cloud machines already run tools in a per-user jail ([decision 0017](../../docs/decisions/0017-nekko-cloud-machines-run-tools-in-a-per-user-jail.md)); the profile becomes part of that jail's identity.
4. **Sealed at rest.** Each profile's chats, notes and settings are encrypted on disk with a key held in that profile's vault namespace. A shell command that reads another profile's folder directly gets ciphertext. This closes the gap in layer 3 for app data on every OS without waiting for the sandbox. It does not protect another profile's own folders and repositories, which are ordinary files; only the sandbox does.
5. **Separate processes and sign-ins.** MCP servers and connector clients are keyed by `(profile, server)` and never shared, since a server holds state and credentials. The in-app browser uses the partition `persist:profile-<id>`. Claude Code and Codex get a config directory under the profile.
6. **Context assembly.** Memory, skills, prompts, chat search, recent chats, the workspace index and embeddings are all built from the scope. The engine's saved prompt state (KV slots on disk and in memory) is tagged with the profile and is never restored for another one.
7. **Callers from outside.** The CLI and the app's own MCP and API server authenticate with a token bound to one profile (`nekko-agent --profile <name>`; the default is the profile the user last used). A token cannot name a different profile.

### Sync and phones

The account record lists profiles. Each profile's chats are sealed under a per-profile key wrapped by the account keyring ([sync encryption](../../docs/SYNC-ENCRYPTION.md)); a device receives a profile's key only when the user allows that profile on it, so a work laptop can hold Work and nothing else. A paired phone's record lists the profiles it may open on each computer; a request for another is refused by the computer, not hidden by the phone.

### Proof

- **Canary suite.** Seed profile B with a marked string in every store (chat text, a note, a setting, a token, a file in its folder, a task, an MCP result, a browser cookie). From profile A, drive every tool, every IPC and HTTP route, context assembly, search and a full agent turn. Fail if a marker appears in any reply, prompt sent to a model, log, or file A can read. A new store or tool that is not covered fails the suite's own inventory check.
- **Path property tests** for the deny set on each OS.
- **Migration tests** from a recorded pre-profiles data folder, including an interrupted move.

## Acceptance criteria

- [ ] With two profiles, no chat, note, setting, folder, connector, token, task or search result from one appears in the other's UI.
- [ ] The canary suite passes on Windows, macOS and Linux and runs in `gate`.
- [ ] A file tool call into another profile's folder or data is refused in every sandbox mode and never raises an approval.
- [ ] A refusal shown to the model carries no other profile's name, id or existence.
- [ ] Agents, scheduled runs and workflows continue under their own profile after a switch, and their approvals wait there.
- [ ] MCP servers and connectors start once per profile with that profile's credentials.
- [ ] An existing install opens as one profile, Personal, with every chat and setting where it was.
- [ ] Deleting a profile removes its folder, its vault namespace, its browser partition and its server processes.
- [ ] iOS and Android show the same switcher and open only the profiles the computer allows them.

## Known limits, to state wherever the feature is described

- Until the OS sandbox lands, a shell command can still read **another profile's folders and repositories** if it guesses their path: they are ordinary files owned by the same OS user. App data (chats, notes, settings, tokens) is covered earlier by encryption at rest.
- Claude Code and Codex run their own tools as the OS user. Their history and sign-in are per profile; their file access is bounded by their own permission system, not ours.
- A folder the user adds to two profiles is shared by choice.
- Profiles do not hide anything from a person using the unlocked computer.

Marketing copy must not claim more than the layers that have shipped. "Models in one profile cannot see another profile's chats, notes, settings or connectors" is true after phases 1 and 2. "Cannot read its folders" is true for the file tools after phase 1 and for shell commands only after phase 3.

## Delivery

Each phase is a stack of two to four PRs with its own issue.

1. **Scope and storage.** Registry, `ProfileScope`, per-profile stores, migration, settings split, vault namespaces, file-tool deny set, the shell guardrail, per-profile MCP and connector processes, the canary suite. No UI: a hidden second profile for the tests.
2. **Desktop and Local Web UI.** Switcher, New profile, Settings > Profiles, Move to profile, the shared-folder question, the boundary row, per-profile browser partition, encryption at rest. This is the first release that can be announced.
3. **OS sandbox for agent commands**, per platform.
4. **Sync and phones.** Per-profile keys, per-device profile choice, iOS and Android switchers.
5. **Profile lock** (passcode or biometric), if wanted.
