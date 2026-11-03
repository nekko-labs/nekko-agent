---
status: accepted
date: 2026-11-03
---

# 0043. Workflows are called Scheduled Tasks, and the chat tasks are the same thing

## Context

The desktop had a **Workflows** tab for routed, triggered automations and, separately,
"scheduled tasks" made from a chat's **⚡ Automate** menu. Both start runs unattended and
are held by the same **Pause all automations** switch. Philip asked for Workflows to be
called **Scheduled Tasks** everywhere, which collides with the existing chat tasks' name.
The CI runners also sat behind a **Workflows | CI runners** switch, a second tab inside a tab.

## Decision

- What a person reads says **Scheduled Tasks** (nav, titles) and *scheduled task* (prose,
  buttons, docs). The chat ⚡ Automate tasks are not given another name: they are scheduled
  tasks started from a chat, one concept with two places to make it.
- The CLI command is `nekko-agent scheduled-task`; `workflow` and `workflows` stay as aliases.
- Code identifiers, IPC channels (`workflow:*`), stored files (`workflows.json`) and the
  engine's run messages keep the old name. Renaming them would break stored data, older
  phones and other clients for no visible gain.
- GitHub Actions "workflows" keep GitHub's word.
- The CI runners are a section at the foot of the Scheduled Tasks list, not a switch.

## Consequences

The code and the UI now use different words for the same thing; the WorkflowsView
header comment says so. Run messages written by the engine ("Untitled workflow",
"The workflow this step triggers no longer exists") still say workflow until the engine
and its golden fixtures change together. Merging the two kinds of scheduled task into one
list is not part of this decision.
