---
title: "Run here or in a subagent"
area: agents
---

# Run here or in a subagent

`[implemented on desktop and Local Web UI 2026-11-03; on iPhone and Android 2026-11-03; unit tested; the real ChatPane checked in a hidden renderer, and both phones end to end against a real computer and relay, including what is sent; not yet tried with a live model]`

More work for a chat keeps filling its context. A subagent does the work separately and reports back, so the main chat stays light, but that used to mean asking for it in words.

## Desktop and Local Web UI

Implemented on this branch (#2285): contextual suggested actions and their **This chat / Subagent** sliding selector are the only follow-up row. The leftover **Do it here / In a subagent / Here uses more context** row is removed, including while typing, answering an agent question, or streaming. Typed drafts use the existing composer Send/Enter path, which runs in this chat; users can still explicitly request delegation in their own message. No new selector or duplicate controls are added to the composer.

The suggestion slider and its gating are unchanged: no delegation on Solo, offline, incognito, Sandbox, child chats, blocked computers, or with spawn_agent disabled. Questions/approvals remain independently actionable. This renderer-only change does not change native phone controls.

**What it does.** The message becomes *Do this in a subagent, then report back:* followed by your words. It is sent and shown as your message, on every engine, so there is nothing hidden and no new path: the model delegates with `spawn_agent`, or Claude Code with its `Agent` tool. The agent is being asked, not forced, so a model can still decline.

**On iPhone and Android.** The same two actions, for a typed follow-up. They sit just above the message box, beside the phone's other next steps (the PR chip), and the box itself is unchanged. The phones have no suggested next step, so there is nothing to offer in an empty box. On the native phones, a picked skill or saved prompt counts as a slash command, and the row stays away while the computer is out of reach (a message then waits on the phone, and the phone can't tell whether delegation will run). The phone learns the computer's strategy from its settings, read only; a computer from before this doesn't say, so its phones offer the choice even on **Solo**, where the agent simply does the work itself.

**On a Claude plan** this is a message the person wrote and chose to send, so it needs no new row in the [Claude policy](../product/claude-policy.md).

## Contextual suggested follow-ups (implemented; isolated verification passed in #1699 and #1760)

User intent: a generated suggestion about inspecting saved PNGs should offer concrete responses, not just “Do it here” and “In a subagent”. The side-call model now returns 2–3 distinct, self-contained user messages in the existing `ReplySuggestions.options` list. Avoid generic yes/no answers, duplicate choices, invented approvals, and execution-location choices. No useful next step means no options. No additional model call is introduced.

Desktop and Local Web UI show these as primary buttons beneath “Suggested follow-ups”, clearly separate from an agent question. Clicking sends exactly the visible choice. A compact sliding two-position control defaults to “This chat”; where existing delegation restrictions allow it, “Subagent” wraps the chosen response in the existing delegation instruction. Choosing a location alone never sends. Contextual buttons remain usable when delegation is unavailable. Typed drafts use the composer’s existing Send/Enter behavior, without the legacy placement row.

Compatibility: an older engine returning only `next` gets a single full-message button, never a fabricated yes/no alternative. Suggestions are bounded to four unique text choices, escaped as ordinary React text. A pending question, approval, error, live/held reply, blocked computer, image chat, or nonempty draft suppresses the suggestion row. Suggestions belong to the latest assistant reply and disappear after sending. They do not authorize tools or bypass approvals. Native phones have no generated suggestions and are unchanged.

Acceptance: verify exact direct and delegated send payloads, no send on render/location selection, empty/malformed/legacy options, provider-independent delegation gating, no stale row after sending, and readable wrapping at desktop and 390px web widths. Synthetic ChatPane interaction checks and focused unit tests pass; before/after pixel inspection and live-model quality remain unverified until recorded in the PR.

### Compact destination slider (implemented and isolated verification passed)

The desktop/Local Web UI suggestion row uses a labeled, keyboard-accessible radio pair, “This chat” and “Subagent”, with a sliding pill instead of a native dropdown. Arrow keys select the destination; changing it never sends. Each row has its own radio group. Reduced-motion preferences disable the slide transition. Delegation gating, exact message text, and the composer’s typed-send behavior remains unchanged. No new persistence, network calls, permissions, or tool authorization are introduced. Acceptance includes direct/delegated payloads, no send on selection, and narrow-width readability.

Verification for this refinement: 30 focused tests, 2,885 desktop tests, desktop typecheck and production build pass. Hidden isolated Electron checks cover desktop/390px one-row layout, cross-pane overflow, top/bottom placement, right-edge clamping, formatting selection/active state, keyboard radio selection and exact follow-up send text. Matched dark-theme before/after screenshots and edge captures were inspected; actual-frame slider motion was captured. Full ChatPane and composer clipboard/undo regressions pass. Packaged Windows/Linux and native phone editors were not exercised; the native editors are unchanged.

### Empty-composer placement controls (implemented, isolated verification passed)

An agent question alone no longer shows execution-location buttons. The real ChatPane regression journey checks empty, whitespace-only, slash-command, typed and cleared drafts at 1200px and 390px, plus exact direct/delegated payloads, no sends while editing, and controls disappearing after sending. Matched baseline/head screenshots in the default theme were captured and inspected at both widths. The separate contextual-suggestion journey still passes its exact-send and stale-response checks. These checks use a synthetic bridge in a hidden, non-focusable Electron window with isolated storage and network blocked; they do not prove live-model delegation or packaged Windows/Linux behavior. Native phones are unchanged and already require a typed draft.


### Remove duplicate legacy desktop controls (#2285)

Acceptance: no legacy row for empty, whitespace, slash-command, typed or cleared drafts at 1200px/390px, including while an agent question is visible. Editing or selecting the suggestion destination must not send; composer Send must preserve the typed draft; suggested actions must preserve exact direct/delegated payloads, stale-response rejection and wrapping. No additional model/network calls, permissions or tool approvals. Verified on this branch: desktop production build/typecheck, 27 focused tests and three sandbox syntax regressions pass. Hidden real ChatPane checks pass 20 draft/question assertions plus 11 contextual-choice assertions, including exact composer/direct/delegated payloads and stale-response rejection. Matched default-theme 1200px/390px before/after screenshots were captured and inspected; the old row is gone and the existing slider/actions remain. Native phones, live models and packaged applications are not implied by renderer fixtures. Earlier empty-composer visibility rules above are historical and superseded for desktop/web.
