---
title: "Chat environment: folders and repositories"
area: context
---

# Chat environment: folders and repositories

Tracked by #2404.

## Intent

A chat's folders are its **environment**: the local folders and the git repositories it can work in. People add and remove both from the chat itself, without leaving for Settings. When someone asks the agent to change a project that is not in the environment, the agent asks how to find it instead of guessing or editing the wrong folder.

## Implemented

- **Environment picker** `[implemented, desktop + Local Web UI]`: the composer's folder button opens an **Environment** menu with a **Folders** section (local folders, then **Add folder…**) and a **Repositories** section (folders cloned from a git provider, shown with the provider's mark and `owner/name`). Every row keeps the existing controls: pick as primary, star as a default for new chats, remove from this chat, revoke saved access. **No folder** sits at the bottom. The button's accessible name is `Environment: <names>`.
- **Add repository** `[implemented]`: with a GitHub or GitLab connector connected, **Add repository…** (and **+ → Repository** in the composer) shows a searchable list of the repositories the account can reach (GitHub: owner, collaborator and organization repositories, most recently pushed first; GitLab: member projects on the connector's instance, searched on the server). Picking one clones it and wires it into the chat: primary when the chat has none, otherwise supporting. A repository already cloned shows "On this computer" and is reused rather than cloned again.
- **Connect repositories** `[implemented]`: with no git provider connected, the Repositories section offers **Connect repositories**, which opens Connectors.
- **Where clones go** `[implemented]`: `~/nekko-repos/<owner>/<name>` (GitLab subgroups nest), or `settings.repoCloneDir` when set (no UI for it yet). A folder already at that path that is a clone of the same remote is reused; anything else there is left untouched and the add fails with a message to move it or add it as a folder.
- **Repository tag** `[implemented]`: a cloned folder is a normal saved folder (`settings.workspaces`) with `repo: { provider, fullName, webUrl }`, so indexing, memory, worktrees and primary/supporting rules are unchanged. The system prompt's folder list names it `name (repository github:owner/name)` so the model can match "the app repo" to its folder.
- **Agent asks when a project is missing** `[implemented]`: when `ask_user` is offered, the system prompt tells the agent that a request to change a project or repository not among the chat's folders gets a question first. `ask_user` options can carry an `action`:
  - `pickFolder`: answering opens the folder picker and adds the chosen folder.
  - `addFolder` with `path`: answering adds that folder (one the agent found after searching).
  - `connectRepo`: answering swaps the options for the repository list (or **Connect repositories**), and picking one clones and adds it.
  A plain option such as "Search this computer" stays a normal answer, and the agent then searches with its file tools. The answer the agent reads carries what was added and its full path. A cancelled picker keeps the question open. An unknown or malformed action is dropped and the option works as a plain answer.

## Privacy and security

- The connector token reaches git only as an `http.<provider origin>/.extraheader` passed through `GIT_CONFIG_*` environment variables: never on the command line, never written to the clone's `.git/config`, and never sent to any host but the provider's own origin. The daemon refuses a clone URL that is not `https://<provider origin>/<fullName>[.git]`.
- Repository names must be plain path segments (no `..`, separators or spaces), so a clone cannot land outside the clone folder.
- Listing and cloning are network calls under the **Connectors** connection, so Settings > Connections can switch them off.
- Later fetches and pushes in the clone use the user's own git credentials, as in any other folder.
- Option actions only add folders to the environment; they never remove, delete or overwrite anything.

## Not yet

- iPhone and Android: the phones show actioned options as plain answers and have no repository list. Folder adding on phones already exists (`workspace:addByPath`); the repository list is to follow in #2415 (see the gaps row in [iOS and Android stay in step](../phone/ios-and-android-stay-in-step.md)).
- A chat on another connected computer runs options as plain answers (the folder picker would open on this computer, not that one).
- No setting UI for the clone folder; no private-repository clone over SSH; clones of very large repositories are capped at 15 minutes.
- In Workspace Jail mode a folder added mid-turn may only become reachable on the next turn.

## Verification status

- Rust unit tests: repository listing (both providers, query filtering, one provider failing), clone planning (token scoping, URL and name validation, existing-folder handling), option-action parsing. Shared and renderer unit tests: option-action parsing, the Environment menu sections, the repository browser's states, and the question card's action bookkeeping.
- **Pending:** an end-to-end clone against a real GitHub account, and visual evidence of the menu and the question card's repository step.
