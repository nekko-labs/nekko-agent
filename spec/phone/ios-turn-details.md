---
title: iOS persisted turn details
area: phone
---

# iOS persisted turn details

Status: implemented; native app build and core interaction checks passed in run 42127842332. Largest Dynamic Type content measurement and inspected visual evidence remain pending. Tracks #1883.

## Behavior

The computer-backed iOS chat shows a footer for every assistant message carrying the host's persisted `ChatMessage.turnStats` (shared/chat.ts). This is the turn's recorded identity and usage, **not** the chat's currently selected provider, model or effort, and not a `done` event's guessed measurements.

- Show model ID, provider ID, effort when supplied, input/output tokens, elapsed seconds and decode tokens/second when measurable. Input includes `inputTokens + cacheReadTokens + cacheWriteTokens`, matching desktop TurnStatsLine.
- `outputTokens / (outputMs / 1000)` is valid only for positive output tokens and finite provider decode time **at least 100ms**, matching `decodeRate`. Never substitute `wallMs`; missing, zero, negative, invalid or sub-100ms decode time means no speed label.
- Show the Done checkmark only when `stop == complete` **and the persisted message is not interrupted**. Missing stop, `loop`, `runaway`, unknown stop, old messages, running overlays and `done` events alone must not invent success. The footer can still show measurements on non-successful replies.
- Replies without persisted stats have no invented footer. Unknown effort/stop values do not become supported meanings.
- Footer identity belongs to the persisted message, while its anchor uses `ChatModel.shownIds` if its reply is still displayed under a carried live ID. A tool-only reply anchors after its last tool call. A stats-only empty reply retains an anchor.
- A footer ends a tool-purpose group. Simple's collapsed steps keep the footer visible; expanding steps must not duplicate it. Detailed mode uses the same footer data.
- The caption wraps at phone widths, uses Dynamic Type and provides a combined VoiceOver label. Light/dark, largest Dynamic Type, layout and readability still require native visual inspection.

## Persistence and privacy

`TurnStats` is a narrow typed projection of the shared schema: provider/model IDs; known effort/stop; input/output/cache token counts; provider decode and wall times; call count. Counts/times must be finite and nonnegative; malformed required fields omit the stats, malformed optional fields are ignored. Arbitrary provider payloads, prompts, credentials and future metadata are not retained in the projection or saved transcript.

The projection participates in `ChatMessage` equality so metric-only reloads update data. The existing consent-gated `SavedTranscripts` copy includes this same projection, with no new cache, cloud sync, telemetry, notification forwarding or consent bypass. Existing transcript caps, retention and deletion rules remain unchanged. Legacy v1 saved transcripts continue to decode without metrics.

Rust `nekko_remote::phone::{redact,session_view,computer_session_view}` already keeps persisted message metadata while truncating tool output/removing tool images. No sanitizer implementation change was needed. `crates/nekko-remote/tests/turn_stats_phone.rs` guards both metric/interruption preservation and the existing privacy shaping.

Phone-only provider chats, richer provider display-name lookup and additional metrics not present in the persisted schema are out of scope.

## Automated regression coverage

- Protocol `TurnDetailsTests`: schema projection, cache-inclusive input, finite values, decode-time boundary (99/100ms), missing-time behavior, explicit stop/interruption semantics, legacy/user messages, carried-ID/tool-only/stats-only anchors.
- Kit `TurnDetailsPersistenceTests`: consented offline round trip, no writes without a transcript cache, unknown metadata exclusion, and a real live-to-saved `ChatModel` reload with selected versus actually used model/effort.
- Native `TurnDetailsRowTests`: closed/open Simple mode, exactly one footer after carried IDs, and same-purpose groups separated at each turn's footer.
- Native UI `TurnDetailsTests`: real ChatView fixture, successful/interrupted/loop/legacy replies, unknown decode speed, folded tool-only reply, largest Dynamic Type, screenshot attachments.
- Rust `cargo test -p nekko-remote --test turn_stats_phone`: metrics survive the phone and paired-computer transcript projections without changing tool output/image privacy behavior.

Local verification: Swift 6.2 Docker focused protocol/Kit suites passed (21 tests). Three row tests also passed against the unmodified `TranscriptRow`/`FoldItem` source extracted from ChatView into a temporary Linux test package. Swift frontend syntax parsing passed for changed/new UI files and tests. Rust focused tests passed (2 tests). Linux does not provide SwiftUI or native evidence. The unshimmed package build fails on Linux in unchanged existing String(localized:) call sites; testing used a temporary Linux-only String initializer shim **only in a copied package**, not a repository change. This shim is not native localization verification.

## Native verification

The memory-only TurnDetailsFixture is routed by `-uiTestTurnDetails`; no provider requests or real computer connections are made. Native UI tests cover completion, interruption, unknown speed, legacy history, folded tool steps and largest Dynamic Type. The evidence workflow overlays only the fixture, debug measurement helper, launch hooks and capture-only test onto the exact base revision. It pins both matrix jobs to iPhone 18 Pro / iOS 27.0 rather than choosing different newest-installed runtimes. Screenshots must be inspected before claiming visual verification.

Run [42127842332](https://github.com/nekko-labs/nekko-agent/actions/runs/42127842332) built both exact revisions successfully. All three native row tests and five of six UI tests passed. The largest Dynamic Type test alone failed: its combined XCUI accessibility frame extended from -0.333333 to 402.333323 points on a 402-point screen. This symmetric one-physical-pixel expansion is not proof of overflowing text. Those artifacts also recorded different simulator runtimes (before 27.0, after 27.2), so they do not establish a matched-runtime visual comparison.

The replacement bounds check measures the actual selectable metric Text and footer's SwiftUI global geometry, strictly inside the 16-point transcript gutters and visible transcript height. A second launch uses a pass-through TextRenderer to report actual typographic line bounds, line count and truncation; its metric/footer size must equal the normal selectable view before those readings count. It requires multiple lines, no truncation, every line inside the measured Text, and a larger line height than the default font. A no-selection diagnostic control compares geometry and records the XCUI frame without changing production selection behavior. JSON readings plus the combined XCUI frame are kept as native test attachments and log output. The probe is compiled only in DEBUG, requires explicit fixture measurement flags, and records no real transcript data. Native execution of these stronger assertions is pending; their existence alone does not verify layout or pixels. Run [42132475147](https://github.com/nekko-labs/nekko-agent/actions/runs/42132475147) stopped before tests: the DEBUG text renderer lacked iOS 18 API availability guards while building for the app's iOS 17 deployment target. The renderer call and type now carry explicit iOS 18 availability guards; the deployment target remains iOS 17. This failed run produced no content measurements or screenshots.
