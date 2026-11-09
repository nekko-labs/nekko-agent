# GPT chats hanging, the nekkod crash, and where performance goes (2026-11-09)

Investigation of three reports: GPT chats stay on "Thinking" while Claude chats finish, a suspected memory leak, and a general performance review. Evidence comes from this machine's `~/.nekko-agent` data (1,035 chats, 547 MB of session files, three rotated connection logs covering 39 hours), the Windows Application event log, the dev daemon's PDB, and a 20-minute live sample of the running app's processes.

## Summary

| Problem | Cause | Status |
| --- | --- | --- |
| GPT chats sit on "Thinking" for about 15 minutes | A stalled ChatGPT response keeps its connection alive, so the 5-minute socket idle limit never fires; the server drops it about 15 minutes later | Fixed: 3-minute no-progress limit, retried |
| GPT chats stay on "Thinking" after the app "closed" | nekkod aborted out of memory; nothing tells the window a run died, and the 30 s `loop:alive` probe went away with the TS host | Fixed: the window reconciles against `chat:running` |
| nekkod crash (0xC0000409) | `std::alloc::rust_oom`: an allocation failed. Unbounded transcript copies per checkpoint, whole-file parses per output chunk, whole-file reads | Largest causes fixed; see follow-ups |
| Steady background load | Polling and full-file reads on timers | Quick wins fixed; structural items listed |

Why Claude chats did not show this: they run in a Claude Code child process with its own timeouts and retries, and none of their traffic goes through nekkod's ChatGPT provider. They are still exposed to the daemon crash.

## 1. GPT chats hanging on "Thinking"

### Stalled streams

Across the week's GPT sessions there is a recurring gap of 907 to 921 s between a tool result and the next reply (13 occurrences in 10 chats). The tool before it varies (read_file, bash, spawn_agent, grep), so the tool is not the cause. On 2026-11-08 at 13:26:12 the model request went out and its headers returned in 941 ms; the next request for that chat went out at 13:41:14, with no retry in between. The 5-minute socket idle limit (`NEKKO_STREAM_IDLE_MS`) did not fire, so bytes were still arriving: keep-alives or `response.in_progress` with no items. The reply that followed was often an empty `update_plan` step, because the cut-off stream was accepted as finished and the loop's empty-reply nudge asked again.

Reasoning time is not the explanation: over 6,632 recorded GPT calls the longest reasoning was 132 s (p99 33 s, p99.9 66 s).

Fix (`crates/nekko-agent/src/providers/chatgpt.rs`): a response that produces no item, delta or part for 3 minutes (`NEKKO_STREAM_STALL_MS`) fails with "ChatGPT stopped sending", which the loop retries. A body that ends after the response started, without `response.completed` or `[DONE]`, also fails and is retried instead of being kept as a truncated step.

### Runs orphaned by a daemon crash

At 08:03 JST nekkod exited with 0xC0000409. The new daemon marked the in-flight replies "The app closed while this reply was running", but the window only ends a live run on a `done` or `error` event, which a dead daemon never sends. Three chats were asked "is this stuck?" four minutes later. The spec still describes a 30 s `loop:alive` probe; it was lost when the TS host was deleted on 2026-10-19.

Fix (`apps/desktop/src/renderer/liveRuns.ts`): while any run is live, the window asks `chat:running` every 30 s. A run that was confirmed running and is missing from two lists in a row (or was never confirmed and has been silent for 20 minutes) is ended, and its pane re-reads the chat.

## 2. The nekkod crash and memory

- Windows Application log: `nekkod.exe` faulted with 0xC0000409 at 08:03:09 (also 10/31 and 11/01), and Windows filed a `RADAR_PRE_LEAK_64` report for nekkod on 10/31.
- Symbolized against `target/dev-daemon/nekkod.pdb` (same build): fault offset `0x20b73f1` is `std::alloc::rust_oom` (`library/std/src/alloc.rs:429`). The process aborted because an allocation failed, not because of a panic, which also explains why no panic line reached `nekkod.log`.
- The crashed daemon started at 21:52:04Z and died at 23:03:34Z: 71 minutes from about 220 MB to exhausting a 61 GB commit limit. That is a burst, not a slow leak.

Causes found in the code, most likely first:

| # | Cause | Where | Fixed here |
| --- | --- | --- | --- |
| 1 | Every checkpoint (`step`, `tool_result`, `done`...) deep-copied the whole transcript onto an unbounded channel. A long chat's transcript is tens of MB as a `Value`; quick tools produced copies faster than the forwarder saved them | `nekkod/src/turns.rs` | Yes: one pending copy per turn |
| 2 | Every chunk of command output parsed the whole chat file to check whether the chat is a sandbox chat | `nekkod/src/agent_logs.rs` | Yes: read once, fields only |
| 3 | `read_file` read the whole file even for a line range; `edit_file` and the change tracker too | `nekko-tools/src/exec.rs`, `changes.rs` | Yes: streamed range above 16 MB, edit limit 64 MB |
| 4 | The hourly merged-worktree sweep and Settings' worktree list parsed all 1,035 chats with transcripts | `nekkod/src/worktrees.rs` | Yes: fields only |
| 5 | Hub broadcast buffers hold 16,384 frames each, freed only when every receiver reads; one slow socket pins them all. RPC replies queue unbounded | `nekkod/src/hub.rs:152`, `wire.rs:469` | No |
| 6 | Background process buffers (up to 1M UTF-16 units each) are dropped only when read after exit | `nekko-tools/src/process.rs:320` | No |
| 7 | Agent terminal buffers live until the UI closes them | `nekkod/src/agent_logs.rs` | No |
| 8 | Relay events queue unbounded while a connect hangs with no timeout | `nekko-remote/src/socket.rs:239` | No |

Live sample after the restart (08:13 to 08:34, 30 s interval): nekkod 224 to 184 MB private (peak 271), flat. The renderer of the dev build moved between 788 MB and 1,736 MB in a GC sawtooth with no clear upward trend in 20 minutes. The GPU process held 685 to 893 MB, 250 threads and about 3,600 handles, consistent with hidden agent browser views that keep painting.

To confirm which cause dominated, a `#[global_allocator]` wrapper that logs the failing `Layout` size and a backtrace to `nekkod.log` before aborting would say whether it was one giant request or accumulated growth.

## 3. Performance

Measured on this machine:

- **Session files are mostly screenshots.** 547 MB across 1,035 chats; screenshot data URLs are about 72% of the bytes. One 3.7 MB chat: tool screenshots 2.3 MB, tool output 0.8 MB, message text 13 KB.
- **Every checkpoint rewrites the whole file**, pretty-printed, after re-reading it for its fields: about two full rewrites per tool call per running chat.
- **Connectivity probes**: 14,118 requests to each of two endpoints in 39 hours, every one logged (fixed: one endpoint unless it fails, 20 s once online).
- **Polling storms**: when the engine stopped, the window had about 250 `workspace:gitStatus` calls queued at once (fixed: one in flight per card, none while hidden; the daemon side reads fields only).

Ranked opportunities not yet done:

1. **Move screenshots out of the chat JSON** into files beside it, referenced by hash and served on demand. Shrinks every save, every `session:get` over the socket, and the renderer heap together. The biggest structural win.
2. **Debounce non-final checkpoint saves** to one per 2 s per chat (always flush on `done`/`error`), write compact JSON (about 18% smaller), and stop re-reading the file for its fields on every save.
3. **Bound the hub and sockets**: smaller broadcast capacity, a send timeout that drops a stuck socket, a bounded `out_tx`, and no images in published `tool_result` frames.
4. **Turn end fetches the transcript three times** (`ChatPane.tsx` `loadSession` plus two `getSession` calls for suggestions) and every `session_meta` reloads it whole.
5. **The sidebar re-renders every card** on each session refresh because `refreshSessions` replaces every object; reuse unchanged objects by `id` + `updatedAt`.
6. **Hidden agent browsers keep painting** (`backgroundThrottling: false`, up to 8 per chat, closed after 10 minutes idle): lower their frame rate while not capturing.
7. **`agent-watches.json` holds 686 watches, 685 finished**, re-parsed on every 15 s tick and every summaries listing: prune finished ones.
8. **Evict exited process buffers and agent terminal buffers**, and time out the relay connect.
9. **GPU meter** spawns `nvidia-smi` every 2 s against a 1 s cache (now paused while hidden; the cadence itself is unchanged).

Note: the app measured here was the dev build (`npm run dev`), which runs React in development mode; renderer memory should be re-measured on a packaged build before drawing conclusions about it.

## Changes in this round

- PR A, `fix/gpt-stall-stale-runs`: stall limit and truncated-stream retry for ChatGPT; window-side run reconciliation; spec updated.
- PR B, `perf/background-load`: items 1-4 of the memory table, the connectivity, git status, resource meter and session cache changes, and an Unmeasured entry in `docs/perf-history.md`.
