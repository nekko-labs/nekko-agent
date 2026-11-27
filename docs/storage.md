# Storage

**Settings → Storage** shows where Nekko Agent's disk space goes on this computer and in Nekko Cloud, and offers the cleanup that is safe for each kind of data.

## This computer

One bar shows the whole disk: what Nekko keeps, what other apps and files use, and what is free. Below it, one row per kind of data, largest first, each with its size:

| Row | What it holds | Cleanup |
| --- | --- | --- |
| Agent worktrees | Every extra checkout of your projects' repositories, made by chats or by agents running `git worktree add`, and how much of that is build output (`node_modules`, `target` and the like). | **Remove idle worktrees…** and **See all** (Settings → Tools → Git management). |
| CI runner images | The macOS and Linux images your [CI runners](ci-runners.md) use, and any old image they no longer use. | **Review images…**: remove an unused image, one at a time. |
| Models | Downloaded models and their runtimes. | **Open Models**, to remove a model on its own. Never cleaned in bulk. |
| App caches | The desktop app's browser caches. | **Clear caches…** Desktop app only. |
| Chat history | Your chats, their command logs and pictures. | The range cleanup that used to be under General. |
| Other Nekko data | Settings, logs, backups and usage. | None. |

Measuring runs in the background and never holds up the app: the page opens with the last result, a row still being measured says *Measuring…*, and **Measure again** starts a fresh count.

### Remove idle worktrees

The preview lists every worktree it would remove, with its size and why it is safe, and you can untick any of them (or use **Select all** and **Deselect all**). A worktree is offered only when all of these hold, checked again right before it is removed:

- it has no uncommitted changes, untracked files included;
- it isn't locked and no running chat uses it;
- no program is working inside it;
- nothing happened in it for 3 days;
- every commit in it is on a remote, or its branch's pull request merged.

The branch is always kept, so you can check it out again later. Only the folder goes.

## Nekko Cloud

On Pro (5 GB) and Enterprise (20 GB), a second bar shows your plan's storage split into synced chats, Library files, kept revisions (old versions of Library files, held for 30 days) and shares. Manage them from **Library** and **Sync settings**. Syncing keeps a copy in Nekko Cloud; it doesn't free space on this computer.

## When the disk runs low

When less than 20 GB is free on the disk Nekko's data lives on, a quiet line at the top of the window says so and links to Storage. Under 5 GB it turns to a warning. **Not now** hides it for a day, or until another 5 GB is used.

## Never deleted by cleanup

Cleanup on this page never removes models, Library files, prompts, evidence, commits or branches, and every cleanup shows what goes and how much it frees before you confirm.

The phone apps don't show this page; freeing space on a computer is done at that computer. The Local Web UI shows the same page without App caches.
