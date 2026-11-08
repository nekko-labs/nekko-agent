# Following verification and PR progress

Agent chats show verification progress above the footer pull-request panel in the desktop app and Local Web UI.

## Tool duration versus the ongoing reply

While a reply is active, a status line outside the collapsible steps identifies running tools, thinking, model response/wait, approval, pause or retry. It stays visible in both Simple and Expert modes. **Turn elapsed** measures the entire reply, not just the last tool.

A tool's duration freezes when that call returns—even if it returned an error and the assistant continues working. For example, a fixed **1.1s** tool time can sit beside an increasing turn timer. That is not evidence that the tool is still running. The turn status disappears when the reply ends; it does not diagnose a quiet provider as stuck or infer background CI progress from a command's output.

## Thoughts in the conversation

When a provider supplies thought text, the desktop app and Local Web UI show it directly in the conversation with a thought-bubble icon. Thoughts stay visible while streaming and after the reply is saved, even when the tool activity is collapsed. They appear between tool groups in the order they arrived.

This changes only the display. It does not send another chat message to the model or expose provider metadata that was not already supplied as thought text.

## Closing summaries

In the desktop app and Local Web UI, a closing summary after tool activity is marked by a colored left border, without a card background or rounded outline. Text, topic headers, and message actions keep their positions. Mid-turn questions and other attention panels keep their highlighted background; ordinary conversation stays plain prose.

## A flat plan, with related details together

The desktop app and Local Web UI show the agent's steps as one flat list in the order the agent published them. There are no Build, Verify or Ship labels, and checks are not gathered into a separate “Check the work” group. Each check keeps its own row and status mark; progress counts the original steps.

Related details still belong together: expand a step to see its note or check report, PRs, task links, files, previews and subagents. Unfinished steps start expanded; finished steps start folded, except the last one with results for you. You can open or close each step independently. Fold the whole plan to keep only the current step, its position and its links.

## Plan step activity

In the desktop and Local Web UI plan sheet, each active step has an accent-coloured concentric ripple, including when several steps work at once. The centre pulses every 1.5 seconds and outward rings repeat over 3 seconds. An interrupted step shows pause bars instead. Reduced motion uses still rings. Done, pending and skipped retain their usual marks. Activity indicators are not verification passes.

## Following subagents and plan links

Subagents stay listed beneath their parent in the Agents panel when you switch to another chat. Completed children remain accessible until archived; explicitly collapsed groups stay collapsed.

Subagents appear as live cards beneath the plan, whether the plan is open or folded. Select a card or a step’s subagent chip to open its chat. Link chips say what they open: **PR**, **CI**, **Task**, **File**, or **Preview**. A reported check appears on its step’s status mark, not as a separate verification chip; hover the mark for its reported state, device and freshness, or select it to open attached evidence.

## Verification checklist

The checklist reports **n of n passed**, followed by each check's state, device, current activity and last update. Expand it to follow individual checks or open an evidence link. You can collapse it to keep more room for the conversation.

| State | What it means |
| --- | --- |
| Pending | Published but not started |
| Working | The agent reports it is checking this item |
| Passed | The agent explicitly reports inspection passed |
| Failed | The reported inspection found a failure |
| Blocked | Something prevents this check; read the activity detail |
| Unknown | No reliable verification result was reported |
| Stale | No update for at least two minutes; this does not itself mean stuck |

These are agent reports, not an independent guarantee. A screenshot captured or a browser tool finished is not evidence that the pixels were inspected. Ordinary plan steps marked done do not count as verification passes. **No checklist published** means the agent has not supplied structured checks; you can ask it to publish or update its verification checklist and device/activity details.

## Pull-request progress

The PR panel shows finished/total head checks, successful/neutral/skipped, pending and failing checks, and any unknown outcomes. Finished includes failures, so all checks finished does not necessarily mean passing. **Check details** expands the named checks and their links. **CI checks** opens GitHub's checks tab.

**Review threads** shows resolved and unresolved thread counts and opens the PR files tab. These are threads, not individual comments, approvals or review requests. One thread can contain several comments.

Unknown means GitHub data could not be read completely, not that there are zero checks or threads. No checks reported is shown only for a complete empty response. The panel uses existing cached polling while the chat is visible. Its checked time is the local observation time, not GitHub's PR edit time. Failed refreshes can retain older observations, which become stale. Sign in to `gh` or reconnect GitHub if metadata remains unavailable, and confirm access to the repository.

The initial presentation is shared by desktop and Local Web UI. Native phone progress presentation is not included. Links open in the normal external-link flow and do not approve or merge a PR.

## Message times and starting a chat

Swipe left on the trackpad, or drag left from non-interactive chat space, to reveal local times beside messages and working steps in the desktop or Local Web UI transcript. The pull stops at its limit; reversing direction pulls it back immediately. Swiping right does not reveal times. Expand working steps and purpose groups to see each tool call's start time. The gutter leaves room for the full time, including AM/PM.

A mouse or touch drag keeps the times visible while held still, then springs back on release. Vertical scrolling, buttons, links, editors and code blocks keep their normal behavior. Trackpad wheel events do not report finger release to the renderer, so the return starts after a brief 80ms without horizontal input rather than using an exact finger-up event. Trackpad momentum can still generate input after your fingers lift.

A new, empty focused chat places Nekko beside a welcoming question. Ten questions rotate every eight seconds while idle. Starting a draft or attaching a file pauses the questions. Reduced-motion preferences and hidden windows disable automatic rotation. The questions are bundled text, not requests sent to a model.
