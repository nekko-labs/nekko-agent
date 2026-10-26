---
title: "Chat suggestions, progress and code access"
area: chat
split-from: SPEC.md (2026-10-22)
---

# Chat suggestions, progress and code access

Updated 2026-10-02. Suggested follow-up replies sit inside the top of the message box, above attachments and the draft. They keep their one-click send behavior and the Right Arrow draft suggestion. Image chats do not show reply suggestions.

Nekko gives a concise progress message before starting tool work and between meaningful action batches. Live updates remain visible in their original order between tool groups; tools and private reasoning stay in their own disclosures. Active status labels describe current work (Reading, Searching, Editing, Thinking, Writing reply), without appending "done" to an ongoing activity.

File tools work within the chat's project by default. Searches can target a single file or directory, missing paths produce an explicit error, and large source files can be read by inclusive line ranges instead of becoming inaccessible after a character cutoff. Shell guidance names the platform's actual shell. ChatGPT conversations preserve assistant commentary/final-answer phases so a progress-only response continues the task rather than prematurely ending it.

## User-started PR continuation (implemented)

After a settled assistant reply, a chat with a known open PR offers **Watch CI and
merge when passing** and a secondary **Skip**, immediately below reply status.
The primary action sends an explicit user continuation request through the normal
agent flow. It is not a direct GitHub merge operation and grants no permission to
bypass reviews, protections, required visual evidence, or draft release blockers.
The agent registers the existing durable PR watcher when waiting, with a bounded
deadline, and continues the normal workflow on wake. Watch registration remains
subject to existing engine/tool availability and approval policy.

Rendering the offer never starts a watch. Active scheduler records render a
watcher status row, including the PR link, deadline, waiting state and polling
retry information. Existing tool transcript watcher rows retain detailed history.
Active watches suppress duplicate offers for the same URL. Skip dismisses only
the current reply's offer in this mounted chat; it does not cancel an existing
watch or alter the PR. A later reply may offer continuation again. Merged and
closed PRs, interrupted replies, and busy/blocked turns do not offer this action.
Multiple open PRs get distinct labeled offers. No new credentials, external
services, scheduler, or background activity are introduced before user action.

Verification: focused eligibility/render tests and desktop typecheck; a hidden
Electron fixture for the click payloads and watcher row; and a real-daemon test
(`a_user_started_pr_watch_registers_and_wakes_the_chat_when_ci_changes`) in which
the request registers a PR watch against a loopback GitHub, a PR the host cannot
read arms nothing, and a CI change wakes the chat through a normal continuation
turn. Not verified: a merge against real GitHub (the merge itself is the agent's
normal workflow, not part of this feature).

## Swipe for times

User intent (Philip, 2026-10-24, extended 2026-10-25): pulling a chat left on the macOS desktop app shows each entry's time at the right, as standard chat apps do, and that includes tool calls.

A horizontal trackpad swipe in either direction (including a rightward swipe with natural scrolling) slides the whole transcript row up to 112px left and fades in a time beside each message, each run of working steps, and, when a run is opened, each tool call and each group of calls in it (the call's start time). Times are local `h:mm` in the same small sans text everywhere. The gutter fits a complete localized time, including AM/PM, inside the viewport. A primary mouse or touch drag left holds the reveal even while stationary and springs back only on pointer release, cancellation or window blur. Vertical drags, buttons, links, editors and code blocks retain their usual interaction. Trackpad wheel events have no finger-up signal in the renderer: a 450ms idle fallback tolerates short pauses, but cannot detect stationary fingers. Letting go springs the rows back and hides the times. The row motion is driven by a CSS variable so rendering new content cannot overwrite an imperative transform. No horizontal scroll is introduced. Renderer-only: no new data is recorded. `[implemented on the desktop (CT-5, CT-7, CT-8); 6 focused gesture tests and hidden Electron held-drag, release and full nested-tool timestamp bounds checks pass at 1100px and 430px; both trackpad directions and whole-row displacement checked at 1100px and 460px; physical trackpad and touch hardware unverified]`
