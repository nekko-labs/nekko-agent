---
title: "Storage: where Nekko's disk goes, and safe cleanup"
area: desktop
---

# Storage: where Nekko's disk goes, and safe cleanup

`[planned 2026-11-26; design approved by Philip 2026-11-26: nekko-designs/storage-settings-design-v2.html, notice option A]`

## Intent

Philip's Mac filled to 14 GB free eleven days after a manual cleanup that freed 120 GB. Agent worktrees had grown back to 164 folders (165 GB), each holding its own `node_modules`, `target`, xcresult scratch and screenshots. On the same Mac the CI runner images held 134 GB, 76 GB of it a leftover copy of an old image. Nothing in the app said so. Other people running Nekko Agent will not notice either, until the disk is full and builds, models or the system start failing.

So Settings gets a **Storage** page: one look shows where Nekko's disk goes on this computer and in Nekko Cloud, each category says what it holds and offers the cleanup that is safe for it, and a quiet notice brings people to the page when the disk runs low, even if they never open Settings.

Success: someone whose disk is filling finds out from the app, opens Storage, sees that worktrees and old runner images are the bulk, and frees that space in two confirmed clicks without losing a commit, a prompt, a Library file or a model.

## Never deleted by cleanup

Cleanup on this page never removes, in bulk or as a side effect:

- **models** or model runtimes (only one at a time, from the Models page);
- **Library content, artifacts, prompts or evidence** (screenshots and recordings a PR or a report refers to);
- **commits or branches**: a worktree's branch is always kept, and a checkout is only removed when every commit in it is on a remote or in a merged pull request;
- anything with uncommitted changes, anything locked, anything a running chat or program is using.

Every cleanup first shows what goes and how much it frees, then asks for confirmation.

## Where it lives

A new **Storage** page in the Settings rail, under **Nekko Agent**, after **Tools**. Settings search finds it under "storage", "disk", "space", "clean", "worktree", "history" and "cache".

- **Chat history moves here** from General. General keeps one line, "Chat history moved to Storage", linking to it, for one release; after that the line goes. The controls themselves (usage, the five ranges, the irreversible-deletion confirmation, the sync link) are the existing `HistorySettings`, moved, not copied.
- **Git management** keeps the full worktree list and its per-row Remove. Its rows gain each worktree's size. Storage shows the worktree total and the bulk action and links to that list; it does not list worktrees a second time.

## This computer

### The bar

One stacked bar of the whole disk: each Nekko category in its own colour, then **Other apps and files** (used space Nekko did not measure as its own), then **Free**. Under it, one legend line per segment with its size. The disk is the volume that holds Nekko's data folder; when a category lives on another volume (a models folder on an external drive, a project on another disk) its row says so and it is left out of this bar.

### The rows

One row per category, largest first, each with its size and one action. While a category is being measured its row reads "Measuring…" and the bar shows that segment as hatched; rows fill in as each finishes.

| Category | What it counts | Action |
| --- | --- | --- |
| **Agent worktrees** | Every linked worktree of each configured project's repository (chat-made and agent-made, as Git management lists them). A second line says how much of it is build output (`node_modules`, `target`, `.next`, `dist`, `build`, `DerivedData`). | **Remove idle worktrees…** (below), and **See all in Git management**. |
| **CI runner images** | `<data>/runners`: the golden images in use, VMs, logs, and any leftover image folder. Shown only when the folder exists. | **Remove** on each leftover image, one at a time (below). The images runners use are never offered. |
| **Models** | `<data>/models`, the configured models folder if it is elsewhere, and the model runtimes in `<data>/engine`. | **Open Models**. Never bulk-deleted. |
| **Chat history** | The existing usage: chat JSON, command logs and chat pictures (`sessions/blobs`). A line says how much is pictures. Phone attachments (`<data>/attachments`) are counted here too. | The existing range cleanup, moved here. |
| **App caches** | The desktop app's browser caches (HTTP cache, code cache, service worker storage, GPU shader caches). | **Clear caches…** Desktop only. |
| **Other Nekko data** | Everything else in the data folder: settings, logs, backups, usage, audit logs. | None. |

### Remove idle worktrees

Decided 2026-11-26 by Philip: the bulk action includes worktrees made outside Nekko (by an agent running `git worktree add`, as this repo's own instructions tell agents to), because those are the ones that filled his disk; the existing merged-PR sweep only ever touches chat-made ones. See [decision 0121](../../docs/decisions/0121-bulk-worktree-cleanup-includes-agent-made-worktrees.md).

A worktree is **idle** and offered for removal only when all of these hold, checked when the preview is built and again right before each removal:

- it is a linked worktree, never the main checkout;
- not locked, and not the checkout of a running chat;
- no uncommitted changes (`git status --porcelain` is empty, untracked files included; ignored build output does not count);
- **nothing happened in it for 3 days**: its Git metadata (`HEAD`, `index`, `logs/HEAD` in its Git dir) and its root folder were last modified more than 72 hours ago;
- **no running program has it open**: no process's working directory is inside it, and no Nekko terminal session is in it;
- **nothing committed would be lost**: every commit on its `HEAD` is on a remote branch (`git rev-list HEAD --not --remotes` is empty), or its branch's pull request merged with this exact head commit (the sweep's existing check, for squash merges). A detached `HEAD` with commits on no remote is never idle.

Removal runs `git worktree remove` (never `--force`) and **keeps the branch**: unlike the single Remove in Git management, the bulk action never deletes a branch, so a branch whose PR is still open, or that was pushed but not merged, can be checked out again later.

The preview lists each worktree that would go (its folder, branch, project, size and why it counts as idle: "pushed", "PR merged") with a total, plus a count of worktrees kept and why ("3 have uncommitted changes, 2 were used in the last 3 days, 1 is running"). The person can untick any row; above the list, a running count ("130 of 131 selected · 166 GB") and **Select all** and **Deselect all** (Philip, 2026-11-26: any long pick list in Storage gets both). With nothing selected the remove button is disabled. One removal failing never stops the others; the result says how much was freed and lists anything that could not be removed with Git's reason.

### Leftover CI runner images

An image folder under `<data>/runners` (a top-level folder with a `disk.img`, or a folder in `images/`) that no runner record names and that no VM or image build is using. Never offered: `images/default`, `images/linux`, the restore-image cache `images/cache` (the next macOS image build reuses it) and `images/linux-cache`. Offered, labelled for what they are: `default.new` / `linux.new` ("left by an image build that didn't finish", only while no build runs), `linux.old` ("the Linux image before the last rebuild"), and any other bundle such as a hand-made backup. An image a runner record points to outside `<data>/runners` is not counted or touched. Each is shown with its size and date and removed one at a time after confirmation ("Remove old-image-tart-2026-10-29? 76 GB. Runners don't use it. This can't be undone."). The images runners use are listed with their size and no action.

### Clear caches

Clears the desktop app's browser caches through Electron's session (HTTP cache, code caches, service worker and cache storage, shader caches). It signs nobody out and keeps local storage, settings and chats. The preview gives the size; the app may grow the caches back as it is used, and the row says so. Not offered in the Local Web UI (the browser owns its cache).

## Nekko Cloud

A bar of used space against the plan's storage (Pro 5 GB, Enterprise 20 GB; Enterprise is the stored plan `team`), split into **Synced chats** (every sync collection but Library), **Library files**, **Kept revisions** (Library revisions held for 30 days) and **Shares** (shared files and their versions), then **Free**. The figures come from the account's sync status, which gains a breakdown. Links: **Library** and **Sync settings** (Settings → Nekko Cloud). No deletion here; Library and sync keep their own controls.

- Signed out, or a plan without sync: one line, "Nekko Cloud keeps a synced, encrypted copy of your chats and Library on Pro and Enterprise.", and a link to Nekko Cloud settings. No bar.
- Sync is never presented as freeing local space: turning it on keeps the local copy.
- Over 90% of the plan's storage, the bar's used part and its line take the warning colour, saying what happens when it is full (new and changed files stop syncing).

## Low-disk notice

When the free space on the data folder's volume drops below **20 GB**, a quiet one-line band appears at the top of the main window, above the agents wall and every view (design frame 07; frame 08 is the rejected alternative, a dot on the Settings icon): "Your disk is almost full: 14 GB free. See what Nekko is using." The link opens Settings → Storage. Under **5 GB** it takes the warning colour. A fixed amount rather than a share, as with the [low-memory prompt](low-memory-prompt.md): on a 2 TB disk 10% would warn at 200 GB free.

- Checked every 5 minutes (a free-space read, no folder walk).
- **Not now** hides it for 24 hours, or until free space falls another 5 GB, whichever comes first. Back above 20 GB resets it.
- Nothing is cleaned automatically.

## Measuring

nekkod measures, never the renderer. `storage:usage` returns the last measurement at once, with each category's bytes (or `measuring`) and when it was taken, and starts a fresh one in the background when the last is over 10 minutes old or the caller asks. Folder walks run on blocking threads, one category at a time per volume, never follow symlinks, and skip folders they cannot read. Worktree sizes are measured per worktree, in parallel, and kept so Git management can show them. Free and total disk space are read directly. Opening the page, cleaning up, or the low-disk notice never waits on a walk.

## Editions

- **Desktop**: everything above.
- **Local Web UI**: the same page and notice, without App caches. Cleanup is allowed there as it is for deleting chats today: the Local Web UI is signed in with the computer's token and can already run commands on it, so no new "is this browser on this computer" check is added.
- **Phone apps**: nothing new. The phone has no Nekko disk to manage; a phone driving a computer does not see that computer's Storage page.

## Privacy and security

- Measuring reads sizes and Git state only; it never reads file contents or sends anything off the computer.
- The cloud breakdown is sizes per kind, which the service already knows; no names, paths or contents.
- Phones may not call the cleanup channels (`PHONE_DENIED_FOREVER`), like closing an app from the low-memory prompt: freeing disk on a computer is for the person at it.

## Not in this version

Automatic cleanup on a schedule; an OS notification when the app is closed; cleaning build output inside a worktree while keeping the checkout; cleaning caches other tools keep (npm, Cargo, Xcode DerivedData outside worktrees, Simulator runtimes); a per-chat breakdown of history.

Tracked in [#3504](https://github.com/nekko-labs/nekko-agent/issues/3504).
