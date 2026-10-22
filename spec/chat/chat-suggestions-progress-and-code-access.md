---
title: "Chat suggestions, progress and code access"
area: chat
split-from: SPEC.md (2026-10-22)
---

# Chat suggestions, progress and code access

Updated 2026-10-02. Suggested follow-up replies sit inside the top of the message box, above attachments and the draft. They keep their one-click send behavior and the Right Arrow draft suggestion. Image chats do not show reply suggestions.

Nekko gives a concise progress message before starting tool work and between meaningful action batches. Live updates remain visible in their original order between tool groups; tools and private reasoning stay in their own disclosures. Active status labels describe current work (Reading, Searching, Editing, Thinking, Writing reply), without appending "done" to an ongoing activity.

File tools work within the chat's project by default. Searches can target a single file or directory, missing paths produce an explicit error, and large source files can be read by inclusive line ranges instead of becoming inaccessible after a character cutoff. Shell guidance names the platform's actual shell. ChatGPT conversations preserve assistant commentary/final-answer phases so a progress-only response continues the task rather than prematurely ending it.
