---
title: "Live card: status dashboard and app-wide voice"
area: phone
---

# Live card: status dashboard and app-wide voice

**Status: planned design, not implemented or device-verified.** This design supersedes the intended hierarchy of the existing chat-row card; the implementation described in [native iOS](native-ios-app.md) remains current until the work below lands. [Editable visual proposal](live-card-status-dashboard.html).

## The three goals

1. **See what is happening.** The card is a status dashboard of agents, not a miniature chat list. Lead with counts such as **3 Building**, **2 Need input**, and **20 Done**. Make attention distinguishable without relying on color alone.
2. **Control Nekko by voice without opening the app.** **Talk to Nekko** is the main CTA. Voice is app-wide, as explicitly selected by Philip, not implicitly directed to whichever chat happens to be focused. Authentication and platform microphone restrictions still apply.
3. **Open the app when needed to handle statuses.** **Open app** is a visibly secondary action leading to the agent list, where the user can review work, answer questions, and handle approvals. Chat-specific controls must not compete with voice on the resting card.

## Resting-card hierarchy

- Small header: Nekko Agent and the computer/scope the counts describe.
- Three equally legible count columns: Building, Need input, Done. Show zero rather than making the layout jump. Building means actively running, including non-code work; it is not limited to compilation.
- A compact secondary line exposes Watching and Failed when nonzero. Failed must not be folded into Done. Offline/stale state takes precedence over optional detail and never looks like fresh progress.
- Wide accent-filled **Talk to Nekko** button with microphone icon. Its visual weight exceeds all other actions.
- Quiet **Open app** link beside or below voice, with a sufficiently large hit area.
- No default chat rows, per-chat elapsed timers, Allow/Deny/Stop button strip, or celebratory close button. Those actions remain in the app; voice may request them only through the safeguards below.

## Count correctness and scope

- Compute totals from the full eligible set **before** the eight-chat detail limit or ActivityKit byte-budget reduction. Do not display clipped row totals as global counts.
- Maintain existing eligibility initially: running, needs-input, watching, and finished within the last two hours. Done is not an all-time completed-chat counter. Completed/archived or deleted sessions leave according to the existing card rules.
- Preserve mutually exclusive statuses. Waiting for input takes precedence over running. Count a chat once; do not double-count a parent and its reported sub-agent progress as the same work.
- Scope is the card's connected computer initially, not silently every paired computer. Name that scope. App-wide voice means all eligible agents on that computer, not permission to control unrelated computers.
- Carry optional authoritative per-state totals in pushed state, with matching Rust, Swift and Kotlin builders and byte-budget tests. On old payloads without totals, show known counts with an explicit partial-count indicator; never guess the status of `more` chats.
- Reconcile foreground and pushed totals, preserve local voice state during pushes, and retain counts through detail trimming.

## App-wide voice behavior

- The destination is **Nekko**, not `focusId`. Asking for status summarizes the same scoped dashboard. Requests to act on an agent resolve an explicit target; ambiguous names require clarification rather than selecting the first or most urgent chat.
- Tapping voice is explicit consent to start a bounded listening session, after Face ID/passcode where required. Expose Listening, Processing, clarification/confirmation, success, and failure. Include Cancel/Stop listening. Do not restart the microphone after cancellation or a late transcription callback.
- Plain speech must never silently become a prompt to the last focused chat. Unrecognized commands produce an honest response and an app handoff, not an unrelated side effect.
- Tool approvals, destructive actions and other sensitive operations keep existing authorization and confirmation requirements. A global voice command is not blanket approval. Bind confirmations to the exact target and action; reject stale confirmations.
- Show accurate delivery state: queued is not sent, sent is not completed, disconnected is not successful. No secret, credential or full transcript belongs in the Lock Screen payload by default.
- On supported iOS versions, investigate the existing authenticated `AudioRecordingIntent` path for background capture. On versions that require foregrounding, label the fallback honestly; do not promise no-app control there.
- Android must offer the same goals using supported notification/voice entry points. If its background microphone rules require foreground UI, document that limitation and track the parity gap instead of claiming equivalence.

## Implementation and verification still required

- [ ] Whole-set counts across Rust push producer, relay filtering, Swift and Kotlin models; compatibility and payload-budget tests.
- [ ] Native dashboard layout, accessibility, localization, Settings preview, compact/expanded Dynamic Island and Android notification adaptation.
- [ ] App-wide voice dispatcher independent of a selected chat, explicit target resolution and confirmation state machine.
- [ ] Tests for mixed statuses, 20+ done, zero counts, stale/offline state, expired finished tail and old payloads.
- [ ] Tests for status queries, ambiguous targets, authentication failure, cancel/late results, denial, offline queueing and forbidden operations.
- [ ] Matched native before/after evidence at the same device/runtime, theme and data. The HTML proposal is not native evidence.
- [ ] Physical-iPhone verification of Face ID, recording from the Lock Screen while the app is backgrounded, cancellation, reconnect and push reconciliation. Simulator rendering does not prove these capabilities.
- [ ] Android device verification of notification entry, microphone lifecycle and platform restrictions.

## Existing implementation references

- `apps/ios/App/Shared/LiveCardView.swift`: two chat rows, remainder tally and small Detailed-level chat mic.
- `apps/ios/App/Shared/AgentRunActivity.swift`: authenticated `TalkToChatIntent`.
- `apps/ios/App/AppModel.swift`, `wireTalk`: captured words sent to a specific session through the outbox.
- `apps/ios/Protocol/Sources/NekkoProtocol/LiveCard.swift`: eight-chat details and two-hour finished tail.
- `crates/nekko-remote/src/card.rs`: pushed card producer.
- `apps/android/app/src/main/java/com/nekko/android/connection/LiveCards.kt`: Android card state adaptation.
