---
status: accepted
date: 2026-11-09
---

# 0076. Repositories join a chat as cloned folders; the connector token reaches git only through scoped environment config

## Context

#2404 asks for a chat's folders to become an environment of local folders and repositories from a git provider, added and removed from the chat, with a way to connect a provider when none is. The agent should also ask, rather than guess, when someone asks it to change a project that is not in the environment.

Everything downstream of a chat's folders (the index, memory, worktree chats, tools' working directory, the jail) is keyed to saved folders in `settings.workspaces`. A repository that is not on disk cannot be read, built or tested by the tools.

## Decision

- **A repository is a saved folder with a `repo` tag.** `repos:clone` clones it, then saves it through the same path as `workspace:addByPath`, adding `repo: { provider, fullName, webUrl }`. No second kind of environment entry exists, so every folder rule applies unchanged. Removing it from a chat or revoking access never deletes the clone.
- **Clones go to `~/nekko-repos/<owner>/<name>`**, or `settings.repoCloneDir`. The path is predictable, outside the app data directory (people open and keep these), and free of spaces for shells. An existing clone of the same remote there is reused. Any other content is never touched.
- **The token reaches git only as an extra header scoped to the provider's origin**, passed with `GIT_CONFIG_COUNT/KEY/VALUE` (git 2.31+). It never appears on the command line (process listings) or in `.git/config`. The daemon refuses any clone URL that is not the provider's `https` origin plus the listed `fullName`. The clone keeps a plain `https` remote, so later fetches and pushes use the user's own git credentials. Writing the token into the remote, or into a credential helper we would then own, was rejected.
- **`repos:list` is separate from `connector:fetch`.** Fetch feeds chat context in a frozen shape (golden-pinned) without clone URLs or default branches, and its GitHub query searches issues. Listing runs under the `connectors` connection id, so the Connections switch covers it.
- **The agent widens the environment through `ask_user` option actions**, not a new tool: `pickFolder`, `addFolder { path }`, `connectRepo`. The user stays the one who adds a folder or repository (a click on the question card). The agent never gains a tool that grants itself access to new folders, and the existing question flow, phones included, keeps working because an unknown action is just a label.

## Consequences

- Private repositories need a connector token with repository read access. An older git without `GIT_CONFIG_*` support fails private clones with an auth error.
- Phones show actioned options as plain answers until #2415.
- No setting UI for the clone folder yet.
