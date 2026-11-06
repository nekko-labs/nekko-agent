---
title: Terminal session context
area: agents
---

# Terminal session context

## Passive backend metadata

Implemented and unit/real-PTY tested on macOS: the terminal registry observes PTY output once, independently of viewers, without changing output bytes. `TerminalInfo.activity` contains optional bounded title, local file-URI directory, running/idle/attention state, detail, last command exit code and the most recent exact GitHub pull-request URL. The observer accepts OSC 0/2 titles, OSC 7 `file:///` paths, OSC 133 command markers, OSC 777 notifications and the explicit `777;nekko;state;detail` hook protocol. An open shell alone does not imply a working agent. Metadata is untrusted display data and cannot authorize tools, navigation or approvals.

OSC payloads cap at 4096 bytes, URL candidates at 512, titles/details at 160 characters and directory paths at 2048 encoded bytes. Split escape sequences and UTF-8 are supported; malformed/oversized input is discarded with bounded recovery. PRs must have an exact `https://github.com/owner/repo/pull/positive-number` shape, terminated by output punctuation/whitespace or an escape sequence. Query strings and lookalike hosts are not accepted. No automatic network requests, prompt storage or cloud title generation are added.

Nekko-created PTYs receive `NEKKO_TERMINAL_ID`. The optional `scripts/claude-terminal-hook.mjs` only emits display events in those terminals, with no stdout output and no permission decisions. It uses Node and `/dev/tty` on macOS/Linux; Windows is intentionally a no-op. Hook event names/tool names are included, never prompts, tool arguments, notification bodies or transcripts. Input is capped at 64 KiB, execution at one second, and failures fail open. Global/project Claude settings are never edited by Nekko.

Verified: 27 Rust unit tests, 10 real-PTY tests (one existing latency benchmark ignored), hook event/privacy and fail-open tests. The new PTY test observes metadata without a viewer and verifies unchanged output and the terminal environment identifier. Live authenticated Claude Code hook delivery, Linux/Windows runtime behavior and packaged app integration remain unverified.

## Panel and header delivery

Planned in the next stack layer: one row per real registry terminal, including split/unanchored/exited sessions, excluding agent command logs; shared smart title/status in the row/window/header; explicit PR status refresh; three-second nonoverlapping metadata polling while the Agents view is mounted. Terminal windows/rows must retain terminal selection instead of jumping to a chat. Running terminal Close must use the existing confirmation flow. Shells without integration remain truthfully labeled Shell open; automatic shell injection and automatic Claude hook installation are not part of this delivery.
