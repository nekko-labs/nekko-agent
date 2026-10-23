---
title: "Chat suggestions, progress and code access"
area: chat
split-from: SPEC.md (2026-10-22)
---

# Chat suggestions, progress and code access

Updated 2026-10-02. Suggested follow-up replies sit inside the top of the message box, above attachments and the draft. They keep their one-click send behavior and the Right Arrow draft suggestion. Image chats do not show reply suggestions.

Nekko gives a concise progress message before starting tool work and between meaningful action batches. Live updates remain visible in their original order between tool groups; tools and private reasoning stay in their own disclosures. Active status labels describe current work (Reading, Searching, Editing, Thinking, Writing reply), without appending "done" to an ongoing activity.

File tools work within the chat's project by default. Searches can target a single file or directory, missing paths produce an explicit error, and large source files can be read by inclusive line ranges instead of becoming inaccessible after a character cutoff. Shell guidance names the platform's actual shell. ChatGPT conversations preserve assistant commentary/final-answer phases so a progress-only response continues the task rather than prematurely ending it.

## User-started PR continuation (implemented, verification pending)

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

Verification: focused eligibility/render tests and desktop typecheck are required.
User interaction, durable registration/wake, and matching desktop visual evidence
must pass before this feature is described as shipped.
