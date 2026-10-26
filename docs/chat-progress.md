# Following verification and PR progress

Agent chats show verification progress above the footer pull-request panel in the desktop app and Local Web UI.

## Thoughts in the conversation

When a provider supplies thought text, the desktop app and Local Web UI show it directly in the conversation with a thought-bubble icon. Thoughts stay visible while streaming and after the reply is saved, even when the tool activity is collapsed. They appear between tool groups in the order they arrived.

This changes only the display. It does not send another chat message to the model or expose provider metadata that was not already supplied as thought text.

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

Swipe horizontally on the trackpad, or drag left from non-interactive chat space, to reveal local times beside messages and working steps in the desktop or Local Web UI transcript. Swiping right or left shifts the whole row left. Expand working steps and purpose groups to see each tool call's start time. The gutter leaves room for the full time, including AM/PM.

A mouse or touch drag keeps the times visible while held still, then springs back on release. Vertical scrolling, buttons, links, editors and code blocks keep their normal behavior. Trackpad wheel events do not report finger release to the renderer, so the reveal returns after 450ms without horizontal input rather than using an exact finger-up event.

A new, empty focused chat places Nekko beside a welcoming question. Ten questions rotate every eight seconds while idle. Starting a draft or attaching a file pauses the questions. Reduced-motion preferences and hidden windows disable automatic rotation. The questions are bundled text, not requests sent to a model.
