---
status: accepted
date: 2026-10-22
---

# 0009. Pass nekkod's config on stdin, and track its children in a record rather than per spawn site

## Context

`nekkod` took its launch config (with the engine's bearer token) from the `NEKKOD_CONFIG` environment variable and removed it after reading. Removing a variable does not change a process's initial environment as the OS shows it: on macOS `ps eww <pid>` prints it to any process of the same user, the commands the agent runs included.

Separately, on macOS nothing ended nekkod's children when nekkod died without cleaning up: it only handled Ctrl-C, and macOS has no parent-death signal. A SIGTERM (logout, Activity Monitor, the app's own stop after its grace period) left stdio MCP servers running with ppid 1. Children are started from many crates (MCP, model servers, terminals, tool processes, hooks, voice, the Claude Code harness), several of which other work was changing at the same time.

See [the window and the engine daemon](../../spec/platform/how-its-built-the-window-and-the-engine-daemon.md).

## Options considered

1. **Config in a 0600 temp file, unlinked after reading.** Keeps stdin untouched. Leaves a file with the token on disk if nekkod dies before reading it, and needs a temp directory every launcher agrees on.
2. **Config as stdin's first line (`--config-stdin`).** Stdin is already the shutdown channel and every launcher holds it open; nothing touches the disk or the environment. Chosen.
3. **Register each child at its spawn site** (a pidfile per child group). Exact, but touches every crate that spawns, and misses anything a new spawn site forgets.
4. **One record of nekkod's live descendants, refreshed every two seconds, plus nekkod leading its own process group on macOS.** Covers every spawn site without touching them, at the cost of a short window in which a brand-new child is not yet recorded. Chosen.

## Decision

Launchers write the config as the first line of nekkod's stdin, and `NEKKOD_CONFIG` is no longer read (`--config <path>` stays for hand runs). nekkod handles SIGTERM and SIGHUP as a graceful shutdown, ends any child still running at the end, and keeps `<dataDir>/run/children.json` (pid, process group, start time) so the next nekkod on the folder ends a SIGKILL'd predecessor's leftovers, matching start times so a recycled pid is never signalled. An exclusive lock on `<dataDir>/nekkod.lock` keeps it to one daemon per folder.

## Consequences

- Every launcher (desktop, CLI and Local Web UI through the CLI, the itest and bench scripts, the Rust test rigs) must use `--config-stdin`; an out-of-tree launcher that set `NEKKOD_CONFIG` now fails at start with a message saying so.
- A child started in the two seconds before a hard kill can still be missed; a per-spawn registry could close that if it matters.
- Processes in another session are never swept, so anything meant to outlive nekkod must detach with `setsid` (the updater's install script does).
- On Linux a program opened with `xdg-open` stays in nekkod's parent's process group, which nekkod does not sweep; nekkod deliberately does not lead its own group there.
