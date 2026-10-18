# Keeping development storage bounded

Use `npm run clean:builds` periodically to preview reproducible outputs older than 14 days. Review the JSON before running `npm run clean:builds -- --apply`. Add `--global` for recognized user-level download caches; add `--protect=<absolute-path>` for other consumers. Immediate cleanup requires `--older-than=0`.

The command never removes worktrees, source, tracked files, .shots evidence, app data, model directories or installed Rust toolchains. It skips junctions, protects primary dev dependencies/runtime/output/dev-daemon and skips checkouts whose tracked files cannot be verified. Windows refuses active build/install processes and protects processes referencing secondary checkouts. On Unix, stop builds/apps and pass `--idle-confirmed` before applying; automatic process checks are not implemented there.

Deletion is irreversible; rebuilding/refetching needs tools, network and time. Preserve diagnostic/release evidence independently before retiring a checkout. A failed deletion can be partial and is reported; don't blindly retry while another process uses the directory.

## Working habits

- Run a dry-run before/after large development batches. Keep a small number of active verification sandboxes.
- Retire merged, clean worktrees through Git only after confirming no active processes or unpublished work. This command deliberately does not delete checkouts or branches.
- Avoid permanent per-task Rust pools; use a few explicitly owned toolchain/profile-compatible pools, with protection for current consumers.
- Share dependency installs only when lockfile, platform and runtime match. Avoid cross-worktree mutation of a shared install.
- Do not blanket-delete `.cache`: model downloads live there.
- CI capture and performance artifacts have explicit 14-day retention. Published PR evidence has separate durable storage. Changing retention does not retroactively delete old artifacts.

## Current limitations

File sizes are logical bytes, not NTFS allocated sizes. Newest modification is used conservatively instead of access time (reads need not update timestamps). No background scheduler or automatic disk quota is installed. Existing model/runtime/toolchain installations and hosted historical artifacts require separate inventory and consent, not silent deletion.
