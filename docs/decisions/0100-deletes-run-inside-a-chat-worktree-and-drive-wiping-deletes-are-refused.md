---
status: accepted
date: 2026-11-14
---

# 0100. Deletes run inside a chat worktree, and drive-wiping deletes are refused

## Context

Every delete asked. `rm -rf build` inside a Nekko chat worktree asked in Guardrails and, being a high-severity `rm-rf` match, asked in YOLO for Claude Code chats too, even though a worktree is a disposable checkout made for that chat. Meanwhile nothing refused a delete that would wipe a drive or a home folder: in the Nekko engine YOLO never prompts, so `rm -rf /`, `rm -rf ~` or `rm -rf "$DIR/"` with an empty `DIR` ran unasked, and in the other modes they were one click away. Philip asked (2026-11-14, #2780) for deletes in scoped folders to run without a prompt and for a delete that does not name a real path to be explicitly blocked.

## Options considered

1. **A user `allow` rule for `rm`.** Already possible, but a regex cannot tell where a path points, so it allows `rm -rf ~` as readily as `rm -rf build`.
2. **Allow deletes in every chat folder.** Simple, but a chat folder is usually the user's own checkout, where uncommitted work has no other copy, and prompt-injected text could delete it unasked.
3. **Allow deletes only in folders Nekko made for the chat, and refuse wipe-everything deletes outright,** both judged by reading the command (the same strict reader as decision 0010) and resolving each path, links followed.

## Decision

**Option 3.** Without a check-in from Philip (the approval prompt could not reach him), the scope is the narrow default:

- **Delete roots:** a chat folder inside a Nekko chat worktree (`<git dir>/nekko-worktrees/<name>`, with the worktree's `.git` file present), and `~/.nekko-agent/scratch`. Not the rest of `~/.nekko-agent` (settings, chats, memory, models) and not the user's own checkout. A delete runs without asking only when every segment of the command is read-only, user-allowed or such a delete, every path resolves inside a root (strictly inside for a plain path; a sh wildcard may sit at the root), no `.git` or git directory lies between the root and the path, and the command is `rm`, `rmdir` or `unlink` as written (not `/bin/rm`, `sudo rm`), `Remove-Item` or its aliases, or `del`/`rd`. PowerShell and cmd wildcards, brace expansion, wildcards that start with a dot, `rmdir -p`, piped-in paths and an unknown working directory all ask. Claude Code's working directory is its own, so only absolute paths count there. A user who set the `rm-rf` rule to deny keeps the deny.
- **Refused in every mode:** a delete with no path (unless its paths come from a pipe or `xargs`), the filesystem or a drive root, the home folder or any folder above it, recursively a folder right under a root or a mount point, `--no-preserve-root`, and recursively a path that starts with a variable. It sees through `sudo`, `env`, `xargs`, `timeout`, `nohup`, `VAR=value`, `sh -c`, `eval`, `cmd /c`, `powershell -Command`, `find` with `-delete` or `-exec rm` and no test, and `cd` before the delete. A command the strict reader refuses is read loosely for this check only. It is built in, not a rule in Settings, so a user `allow` rule does not lift it.

## Consequences

- An agent cleaning build output in its worktree is no longer interrupted, and an agent can never empty a drive or a home folder, even in YOLO.
- A legitimate `rm -rf "$TMPDIR/x"` or `rm -rf /opt` is refused and cannot be approved; the agent has to write the path out, or the user runs it themselves. The refusal says why.
- The check reads shell text, not what the shell will do. Anything it cannot see (a script file, an alias, `python -c`) still asks under decision 0010 but is not refused. Path checks happen before the command runs, so a link swapped in between is not caught, as with the file jail.
- `classify_command_in` (the Settings tester and the golden set) applies the refusal with no delete roots, so five recorded golden cases moved from ask or allow to deny.
- Spec: [spec/context/context-guardrails-memory-the-differentiators.md](../../spec/context/context-guardrails-memory-the-differentiators.md).
