# 0113. YOLO never asks in Claude chats

Date: 2026-11-22. Status: accepted. Issue: #3167. Builds on [0100](0100-deletes-run-inside-a-chat-worktree-and-drive-wiping-deletes-are-refused.md).

## Context

An approval offers **Allow all this session** and **Always allow all**. Both switch the chat to YOLO, described as "No restrictions. Deny rules still block." In a Nekko engine chat YOLO never asks. In a Claude chat (the user's own Claude Code, through the approval bridge) YOLO still asked for high-severity commands (a recursive force delete, a download piped to a shell) and for edits outside the chat's folders. Claude Code's commands name relative paths, and Nekko cannot see its working directory, so decision 0100's worktree exemption almost never applied there. Philip clicked "Allow all" and the next delete asked again, so the choice looked broken.

## Decision

- **YOLO in a Claude chat allows every permission prompt**, as in a Nekko engine chat.
- **What still blocks is unchanged:** a guardrail rule set to `deny`, and a delete that could wipe a drive or a home folder (0100), in every mode.

## Alternatives not taken

- **Keep the high-severity ask and reword the buttons** to say destructive commands still ask in Claude chats. Honest, but "Allow all" would still not allow all, and the two engines would keep meaning different things by YOLO.
- **Hide "Allow all" on prompts YOLO would still ask about.** Leaves no one-click way out of repeated delete prompts.
- **Let "Allow all" also allow the rule that triggered the prompt for the rest of the chat.** Needs a per-rule allow on a chat, which does not exist, for a narrower result than YOLO already promises.

## Consequences

- In a Claude chat in YOLO, `rm -rf <relative path>`, `curl ... | sh` and edits outside the chat's folders run without asking. A person who wants those to ask uses Guardrails, or sets the rule to `deny`.
