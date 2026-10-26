---
title: "Internet reachability and restoration recovery"
area: chat
---

# Internet reachability and restoration recovery

Status: implemented in the Rust daemon with deterministic Rust tests. Shared-renderer setting/notices and their rendered/isolated-fixture checks are the follow-up NR-2 slice. Physical Wi-Fi loss, native phone and Windows/Linux desktop remain unverified.
Tracking: [NR-1 #1163](https://github.com/nekko-labs/nekko-agent/issues/1163), [NR-2 #1164](https://github.com/nekko-labs/nekko-agent/issues/1164).

## Execution-machine detection

The daemon, not a paired browser's `navigator.onLine`, monitors public internet reachability while eligible remote-model turns exist. It is separate from the chat's Offline privacy mode. A single provider's HTTP errors, auth failures, rate limits and timeouts cannot declare internet loss.

Every five seconds after the previous sample, two concurrent, credential-free HTTPS GETs request `https://www.gstatic.com/generate_204` and `https://cp.cloudflare.com/generate_204`. Each times out after four seconds, follows no redirect and accepts only HTTP 204. Three consecutive samples where neither destination responds establish loss; two consecutive samples with either reachable establish restoration. Captive portals and simultaneous blocking of both destinations can look offline: the UI says **reachability**, not an infallible diagnosis of the entire internet.

Probes use the existing `model-providers` connection permission and activity log. All connections off or disabling Model providers prevents probes. No prompt, session id, account token, cookie or user data is sent. The destinations necessarily see the execution machine's source IP. No probe occurs solely for idle chats or local-only inference. Loopback, private/link-local literal addresses, local provider kinds, single-label hosts and `.localhost`, `.local`, `.lan`, `.internal`, `.home.arpa` endpoints are excluded. Arbitrary DNS names that resolve to private addresses are not resolved/classified by this monitor.

## Interruption and cost

On confirmed loss the model-call wrapper interrupts only the provider request. It does not cancel tool execution, pending approvals/questions, native processes or the turn's user-Stop token. Finished tools remain checkpointed. The next model call is gated even if loss happened during a tool. Existing provider-specific retry recovery (#720, 65 network attempts) is unchanged when these independent probes have not confirmed loss.

`autoResumeOnInternetRestore?: boolean` is strict opt-in: absent, false, null, strings and numbers mean off. Explicit malformed saved values normalize to false. Default off ends an affected reply as interrupted with saved progress and manual Continue. It suppresses queued prompt draining and hidden post-turn title/spec model calls for that connectivity outcome.

Opt-in retries only the same model call from the last completed step, through the existing loop yield mechanism; it never creates a second turn, switches route or reruns a completed tool. A wait is bounded to 30 minutes. Stop interrupts it immediately. Settings/provider enablement, model-provider connection permission, chat existence/archive/privacy and unchanged session provider/model selections are checked before recovery and while waiting. Turning the setting off ends the wait. Enabling it after a default-off turn already ended never restarts that chat.

The scope is native daemon model calls, including such calls inside delegated, workflow and training turns. Their owners are never independently restarted. Opaque Claude Code child-harness transport, image generation, voice, tool-specific internet access and other background integrations do not use this model wrapper and are not covered by restoration recovery.

## Notices and persistence

Affected chats receive one `lost` and one `restored` notice per observed outage, plus `resuming` only immediately before a paid request actually continues. Notices carry unique ids, epoch milliseconds, kind and plain text. Non-incognito command logs receive ISO-timestamped lines; appending a status line never resurrects an idle terminal.

The last 100 notices are stored in `Session.connectivityNotices`, not `messages`. Session-store merge locking retains them across daemon checkpoints. They are not prompts, summaries, compaction input or last-message/stalled-state signals. `session_meta` carries the live notice and does not start a run. Planned NR-2: the shared renderer shows an accessible, collapsible timestamped history and deduplicates persisted/live copies. Incognito notices are emitted live only; the planned UI retains them in bounded renderer memory. They are neither transcript nor command-log writes.

After default-off interruption, a bounded observer can report restoration for up to 30 minutes. Stop, archive/delete or a newer turn invalidate it. Observers/waits are process-local, do not survive daemon restart and never authorize a fresh run after restart. Monitoring stops when there are no active turns or pending restoration observers.

## Verification

- Deterministic injected reachability probes/state transitions; debounce/flapping and one loss/restoration pair.
- Remote/local endpoint classification, no probe registration for local inference, and no provider-error-driven state transition.
- Strict settings persistence/default-off behavior, cancellation and setting changes during a wait.
- Real Rust loop with completed tool output, induced loss and restoration: exactly one tool execution and one continued model call.
- Metadata deduplication and checkpoint merge; no transcript pollution or incognito persistence; idle log status preserved.
- Planned NR-2: shared-renderer component/event tests and hidden isolated 1280/640px before/after captures with stub bridge, no real provider calls or user data.
- Not yet verified: physical network disconnect, packaged desktop/native device behavior and actual visual inspection of captured PNGs. No screenshots or logs from user sessions are used.
