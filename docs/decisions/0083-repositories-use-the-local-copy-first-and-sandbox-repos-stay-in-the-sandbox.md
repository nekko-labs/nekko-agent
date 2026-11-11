---
status: accepted
date: 2026-11-11
---

# 0083. Repositories use the copy already on this computer first; a sandbox chat's repositories stay in the sandbox

## Context

Decision 0076 made a repository a cloned saved folder, always cloned into `~/nekko-repos/<owner>/<name>`. Philip (#2561): repositories should not download to the drive like folders but be used like a cloud VM environment; a repository already on this computer should be used as is; when a download is unavoidable, the user picks where repositories sync.

Asked which "cloud VM" he meant, Philip chose by chat mode: the local sandbox for sandbox mode, a folder for regular mode. A hosted VM on Nekko Cloud and working only through the GitHub API (no checkout, so no builds or tests) were offered and not chosen.

## Decision

- **Regular mode: the local copy first.** `repos:clone` first looks for a clone whose `origin` is the repository: the saved folders, the repositories folder, then the usual code folders in the home folder (`code`, `src`, `Developer`, `projects`, `repos`, `GitHub` and the like), two levels deep, with a bounded scan. It reads `.git/config` instead of running git per folder, and compares remotes across https, scp-like and ssh forms. A match is tagged as the repository and added; nothing is cloned.
- **The repositories folder is chosen once.** With no local copy and no `repoCloneDir` yet, `repos:clone` returns `needsFolder` and the suggested `~/nekko-repos` without touching the disk; the repository list asks where repositories sync (use the suggestion, choose another folder, or cancel), saves the answer as `repoCloneDir` and retries. Settings > General shows and changes it. Changing it never moves repositories already added.
- **Sandbox mode: the repository lives in the sandbox.** A sandbox chat records a repository that is not on this computer on the chat, not as a saved folder. When the sandbox is set up, the daemon makes a shallow clone in the sandbox's own state folder (app data, never the user's folders), copies it into the container's private volume the same way host folders are copied, and deletes the temporary clone. A repository already on this computer is used as a normal folder, copied in like any other.

## Consequences

- A clone outside the searched folders is not found; Add folder still adds it, and it is then found as a saved folder.
- Sandbox repositories are snapshots, like every sandbox copy: apply-back stays off, and the container still has no network, so the agent cannot push from it.
- Recorded in [the chat environment spec](../../spec/context/chat-environment-folders-and-repositories.md).
