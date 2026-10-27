# Always-on voice, voice commands and Live Activity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Always-on dictation with "Nekko …" voice commands on desktop and iPhone, one combined iPhone Live Activity with display levels, a mic, remote start and a close button, and a first-open Remotion video.

**Architecture:** One command grammar, written in TS (desktop) and Swift (iOS), held equal by a shared JSON fixture. Always-on listening reuses each app's existing capture and cuts it into segments on silence; each segment is transcribed and either typed or run as a command. The iOS Live Activity becomes one activity whose content state lists up to 8 chats; its views move to code shared by the app (settings preview) and the widget extension.

**Tech Stack:** Electron + React + zustand + vitest (desktop); SwiftUI + ActivityKit + AppIntents + Speech + XCTest (iOS); Node relay (`apps/relay-server`) and Rust `crates/nekko-remote`; Remotion 4.0.535 (`@remotion/player` on desktop, rendered MP4 on iOS).

**Spec:** [docs/superpowers/specs/2026-10-27-always-on-voice-design.md](../specs/2026-10-27-always-on-voice-design.md)

## Global Constraints

- Wake word regex stays `/^ne[ck]k?o\b[\s,:.!-]*/i` (Nekko, Neko, Neco, Necko). Without it, nothing is a command.
- A "Nekko …" phrase that matches no command is typed as text, never dropped.
- Merge a PR and complete a chat only after a confirm. Confirm copy ends "Say 'Nekko, yes' or tap Confirm."
- Segment cap 30 s; silence cut from `voice.silenceMs` (default 1200 ms, clamped 300 to 5000 as today).
- iOS on-device speech: `requiresOnDeviceRecognition = true` always; refuse when unsupported. No audio or transcript leaves the user's devices except to their own paired computer.
- Live Activity: one activity for all chats; at most 8 chats in the content state; short titles about 8 characters; finished chats stay 2 hours; close label picked once per chat from `["Looks good", "Cool", "Excellent", "Nice", "Perfect"]`, "Got it" for failed.
- Live Activity mic requires Face ID or passcode (`.requiresAuthentication`); `AudioRecordingIntent` on iOS 18+, opens the app listening on iOS 17. Push-to-start needs iOS 17.2+.
- Level defaults: app lock on gives Minimal, off gives Standard.
- No em dashes anywhere (UI copy, docs, commits). No AI attribution in commits or PRs.
- Each part lands as its own PR from its own branch off `main` (`gh pr merge --auto`), with the spec file under `spec/` updated in the same PR and `node scripts/spec-index.mjs` run when a spec file is added.

## Review Focus

1. Overlapping segments: a segment finishing transcription after a later one. Expected: text and commands apply in spoken order. Test in Task 1.2.
2. "Nekko" inside a sentence vs. after a sentence break ("Tell Nekko to create a new session" vs. "Fix it. Nekko, send it"). Expected: only the second runs a command. Test in Task 1.1.
3. The focused chat changes while listening. Expected: text goes to the chat focused when the segment finishes, not the one focused when listening started. Test in Task 1.2.
4. Live Activity with more than 8 chats, or a chat finishing while another needs you. Expected: "+N" chip; focus jumps to the one that needs you. Test in Task 3.1.
5. iOS phone engine on a language without on-device support. Expected: dictation refuses with the reason and sends nothing anywhere. Test in Task 2.2.

---

## Part 1: Desktop (one PR, branch `voice-desktop`)

### Task 1.1: Command grammar and shared fixture

**Files:**
- Modify: `apps/desktop/src/renderer/voiceCommands.ts`
- Create: `packages/shared/fixtures/voice-commands.json`
- Modify: `apps/desktop/src/renderer/voiceCommands.test.ts`

**Interfaces:**
- Produces:
  - `VoiceIntent` gains `{ kind: 'erase' } | { kind: 'clear' } | { kind: 'send' } | { kind: 'status' } | { kind: 'ship' } | { kind: 'open-chat'; query: string } | { kind: 'pick'; n: 1 | 2 | 3 } | { kind: 'yes' } | { kind: 'no' }`. Existing kinds unchanged.
  - `splitVoiceSegments(text: string): VoiceIntent[]`: splits a transcript at sentence ends (`.`, `!`, `?` followed by space) and parses each with `parseVoiceIntent`; consecutive dictation pieces are joined back into one dictation intent.
  - Fixture shape: `{ "cases": [{ "say": string, "intent": object, "platforms"?: ["desktop" | "ios"] }] }`. iOS reads the same file in Task 2.2.

- [ ] **Step 1: Write the failing tests.** Add a `describe('shared fixture')` that loads `packages/shared/fixtures/voice-commands.json` and asserts `parseVoiceIntent(c.say)` equals `c.intent` for every case whose `platforms` is absent or includes `desktop`. Put the existing test phrases in the fixture plus at least these:

```json
{ "say": "Nekko, erase that.", "intent": { "kind": "erase" } },
{ "say": "Neko scratch that", "intent": { "kind": "erase" } },
{ "say": "Nekko cancel that", "intent": { "kind": "erase" } },
{ "say": "Nekko clear everything", "intent": { "kind": "clear" } },
{ "say": "Nekko, send it.", "intent": { "kind": "send" } },
{ "say": "Nekko ship it", "intent": { "kind": "ship" } },
{ "say": "Nekko, how's it going?", "intent": { "kind": "status" } },
{ "say": "Nekko new agent session", "intent": { "kind": "new-session" } },
{ "say": "Nekko let's make a new change", "intent": { "kind": "new-session" } },
{ "say": "Nekko open the other one related to billing", "intent": { "kind": "open-chat", "query": "billing" } },
{ "say": "Nekko switch to login redirect", "intent": { "kind": "open-chat", "query": "login redirect" } },
{ "say": "Nekko the second one", "intent": { "kind": "pick", "n": 2 } },
{ "say": "Nekko, yes.", "intent": { "kind": "yes" } },
{ "say": "Nekko cancel", "intent": { "kind": "no" } },
{ "say": "Tell Nekko to create a new session", "intent": { "kind": "dictation", "text": "Tell Nekko to create a new session" } }
```

  Add `splitVoiceSegments` tests: `"Fix the login bug. Nekko, send it."` gives `[{kind:'dictation',text:'Fix the login bug.'},{kind:'send'}]`; `"Tell Nekko to send it."` gives one dictation intent.
- [ ] **Step 2: Run** `npx vitest run apps/desktop/src/renderer/voiceCommands.test.ts`. Expected: the new cases FAIL.
- [ ] **Step 3: Implement** the new kinds in `parseVoiceIntent` and add `splitVoiceSegments`. "open the (other )?one (about|related to|on) X", "switch to X" and "open X" become `open-chat` only when X is not a known view name (views keep winning). Keep `unknown` as the parser's result for unmatched commands; Task 1.2 types it.
- [ ] **Step 4: Run** the same command. Expected: PASS, including the old cases.
- [ ] **Step 5: Commit** `git commit -m "Voice: Nekko command grammar for erase, send, ship, status and open chat"`.

### Task 1.2: Always-on segmented capture

**Files:**
- Modify: `apps/desktop/src/renderer/voiceCapture.ts`
- Create: `apps/desktop/src/renderer/voiceSegments.ts`, `apps/desktop/src/renderer/voiceSegments.test.ts`

**Interfaces:**
- Produces:
  - `startVoiceCapture` options gain `onSegment?: (wav: number[]) => void` (always-on mode). When given, a silence after speech or 30 s of audio cuts the buffered samples into a WAV, calls `onSegment`, clears the buffer and keeps capturing; `onSilence` is not called. The 60 s overall cap applies only without `onSegment`.
  - `createSegmentQueue(transcribe: (wav: number[]) => Promise<string>, apply: (text: string) => void): { push(wav: number[]): void; drain(): Promise<void> }` in `voiceSegments.ts`: transcribes concurrently, applies results strictly in push order; an empty or failed transcription is skipped without blocking later ones.

- [ ] **Step 1: Write failing tests** in `voiceSegments.test.ts`: push A (resolves after 50 ms) then B (resolves at once); `apply` is called with A's text then B's. A rejected transcription is skipped and B still applies. `drain()` resolves after the last apply.
- [ ] **Step 2: Run** `npx vitest run apps/desktop/src/renderer/voiceSegments.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `createSegmentQueue` and the `onSegment` branch in `startVoiceCapture` (reset `speech`, `lastSpeech`, `chunks`, `count` after each cut; segments under 0.25 s of audio are dropped, matching the phone rule).
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Voice: segment always-on capture and apply transcripts in order"`.

### Task 1.3: Always-on button, command execution and toasts

**Files:**
- Modify: `apps/desktop/src/renderer/components/DictationButton.tsx`
- Modify: `apps/desktop/src/renderer/components/ChatPane.tsx:3246` (pass `onSend`, `onErase`, `onClear`)
- Create: `apps/desktop/src/renderer/voiceActions.ts`, `apps/desktop/src/renderer/voiceActions.test.ts`
- Modify: `apps/desktop/src/main/index.ts` (nothing uses `powerMonitor` yet): on `powerMonitor` `lock-screen` and `suspend`, send `voice:stop` to the renderer on `lock-screen` and `suspend`; expose `window.nekko.onVoiceStop(cb)` in `apps/desktop/src/preload/index.ts`.

**Interfaces:**
- Consumes: `splitVoiceSegments`, `createSegmentQueue`, `startVoiceCapture({ onSegment })`.
- Produces:
  - `DictationButton` props: `{ sessionId: string; onText(text: string): void; onErase(): void; onClear(): void; onSend(): void }`. `ChatPane` tracks the last dictated segment's length so `onErase` removes exactly that text.
  - `shipAction(input: { prs: PrInfo[]; running: boolean; pending?: PendingInput }): 'merge' | 'go-ahead' | 'ask' | 'still-working' | 'nothing'` in `voiceActions.ts`: open non-stacked PR and no pending question gives `merge`; open PR and pending question gives `ask`; no PR and (idle or pending question) gives `go-ahead`; running with no PR gives `still-working`.
  - `pickChat(sessions: SessionSummary[], query: string): { open: string } | { choose: SessionSummary[] }` using `searchChats(sessions, query, { scope: 'chats', limit: 3 })` from `views/chatFinder.ts`: one hit opens it; otherwise the top 3 to choose from.

- [ ] **Step 1: Write failing tests** in `voiceActions.test.ts` for every `shipAction` branch and for `pickChat` (one match opens; two matches return both; zero returns `{ choose: [] }`).
- [ ] **Step 2: Run** `npx vitest run apps/desktop/src/renderer/voiceActions.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `voiceActions.ts`, then rework `DictationButton`:
  - The button toggles always-on (single-shot mode removed). While on: red mic, `aria-pressed`, a strip with the level meter and the last heard phrase.
  - Each applied transcript goes through `splitVoiceSegments` (or one dictation intent when `voice.commandsEnabled === false`). `dictation` and `unknown` call `onText` with the session focused at apply time (`useStore.getState().activeSessionId` routed through the `ChatPane` that owns it; a button whose session is not active ignores text).
  - No confirm: `erase`, `clear`, `send`, `new-session` (`newChat()`), `navigate`, `go`, `status`, `open-chat` (`openChatPane(id)`), `ship` → `go-ahead` (`onText("Go ahead and build it.")` then `onSend()`).
  - Confirm, answerable by `yes`/`no` intents or buttons: `complete-session`, `ship` → `merge` (`window.nekko.prAction(url, 'merge')`, then `refreshSessionPrs`, the same calls `PrActionCard.act` makes), `ship` → `ask`, `open-chat` with several hits (`pick` answers it).
  - `status` toasts `"<title>: <lane title>, <current step or 'Watching PR'>"` from `sessionLane` and the live run (`getLiveRun(sessionId)` from `liveRuns.ts`).
  - Every executed command calls `pushToast('success', label)`: "Erased", "Cleared", "Sent", "New chat", "Merging <owner/repo#n>", "It's still working", "Nothing to ship".
  - Stops on toggle, `voice.enabled` false, and `onVoiceStop`.
- [ ] **Step 4: Run** `npm run typecheck -w @nekko-agent/desktop && npx vitest run apps/desktop/src/renderer`. Expected: PASS.
- [ ] **Step 5: Verify in the app** per `docs/runbooks/visual-evidence.md` (hidden, isolated profile): toggle on, speak or inject a WAV through a stubbed `voiceTranscribe` returning "Fix the bug. Nekko, send it."; the draft is sent and listening stays on after 5 s of silence. Screenshot light and dark.
- [ ] **Step 6: Commit** `git commit -m "Voice: always-on dictation with Nekko commands on desktop"`.

### Task 1.4: Desktop first-open video and docs

**Files:**
- Create: `apps/desktop/src/renderer/components/VoiceIntro.tsx` (Remotion composition `VoiceIntroVideo` plus the dialog), following `ZonesIntro.tsx` (lazy import, `Player`, remembered setting)
- Modify: `packages/shared/src/voice.ts` (add `introSeen?: boolean`)
- Modify: `apps/desktop/src/renderer/components/DictationButton.tsx` (first toggle with `!voice.introSeen` opens `VoiceIntro` before listening), `VoiceSettings.tsx` ("Watch how voice works" link)
- Create: `docs/voice.md`; Modify: `docs/hub/nav.json`; Modify: `spec/models/system-speech-models.md` (always-on, commands table, intro)

**Interfaces:**
- Produces: `VoiceIntroVideo` (Remotion component, 1280×720, 30 fps, 30 to 45 s), exported so Task 5.1 renders it to MP4 for iOS. Scenes and captions per the spec's "First-open video" section, final card text verbatim: "Speech is turned into text on your own computer or phone. We never store, hear, or train on your voice, and your chats stay yours."

- [ ] **Step 1: Load the `remotion-motion-graphics` skill** and storyboard the five scenes in the component file.
- [ ] **Step 2: Write a failing test** `VoiceIntro.test.tsx`: closing the dialog (button, Escape, backdrop) calls the settings update with `{ introSeen: true }`; the final caption string is present in the composition.
- [ ] **Step 3: Implement** the composition and dialog; light and dark both readable.
- [ ] **Step 4: Run** `npx vitest run apps/desktop/src/renderer/components/VoiceIntro.test.tsx && npm run typecheck -w @nekko-agent/desktop`. Expected: PASS.
- [ ] **Step 5: Record** a short capture of the video playing for the PR (`node scripts/pr-media.mjs <pr>`).
- [ ] **Step 6: Commit, push, open the PR** (issue linked, "Unfinished work / release blockers" section), `gh pr merge --auto`.

---
## Part 2: iPhone voice (one PR, branch `voice-ios`, after Part 1 merges)

### Task 2.1: Segmenter and grammar in NekkoProtocol

**Files:**
- Create: `apps/ios/Protocol/Sources/NekkoProtocol/VoiceCommands.swift`, `apps/ios/Protocol/Sources/NekkoProtocol/VoiceSegmenter.swift`
- Create: `apps/ios/Protocol/Tests/NekkoProtocolTests/VoiceCommandsTests.swift`, `VoiceSegmenterTests.swift`

**Interfaces:**
- Consumes: `packages/shared/fixtures/voice-commands.json` (Task 1.1), read by repo-relative path as `ToolPurposeTests.swift:7-13` does.
- Produces:
  - `public enum VoiceIntent: Equatable { case dictation(String), newSession, completeSession, navigate(String), go(String), erase, clear, send, status, ship, openChat(String), pick(Int), yes, no, unknown(String) }`, `public func parseVoiceIntent(_ text: String) -> VoiceIntent`, `public func splitVoiceSegments(_ text: String) -> [VoiceIntent]`, same rules as the TS twin. `navigate` and `go` carry the desktop view or target as a string; the app decides what they do on a phone.
  - `public struct VoiceSegmenter { init(sampleRate: Double, silenceSeconds: Double, maxSeconds: Double = 30, threshold: Float); mutating func feed(_ samples: [Float]) -> [Float]? }`: returns a finished segment's samples on silence-after-speech or at `maxSeconds`, nil otherwise; segments under 0.25 s are dropped.

- [ ] **Step 1: Write failing tests.** `VoiceCommandsTests.testSharedFixture` decodes the fixture and checks every case whose `platforms` is absent or includes `ios` (map the fixture's JSON intent to `VoiceIntent`). `VoiceSegmenterTests`: 1 s of tone then 1.3 s of zeros (silence 1.2 s) yields one segment; 31 s of tone yields a segment at 30 s; 0.1 s of tone then silence yields nothing.
- [ ] **Step 2: Run** `cd apps/ios/Protocol && swift test --filter 'VoiceCommandsTests|VoiceSegmenterTests'`. Expected: FAIL.
- [ ] **Step 3: Implement** both files.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "iOS voice: shared Nekko grammar and silence segmenter"`.

### Task 2.2: Always-on Dictation with on-device-only phone speech

**Files:**
- Modify: `apps/ios/App/Platform/Dictation.swift`
- Modify: `apps/ios/App/Views/ChatView.swift` (Composer L721-1078, `HoldToTalkButton` L683-718, insertion L942)
- Modify: `apps/ios/App/Views/SettingsView.swift` Dictation section (L173-186): Tap now reads "Tap to keep listening"
- Test: `apps/ios/Tests/AppTests.swift`

**Interfaces:**
- Consumes: `VoiceSegmenter`, `splitVoiceSegments`.
- Produces:
  - `Dictation.startListening(store:) async` and `stopListening()`. Capture moves from `AVAudioRecorder` to an `AVAudioEngine` input tap (16 kHz mono via `AVAudioConverter`) feeding `VoiceSegmenter`; each segment is written as WAV `Data` and transcribed with the existing `transcribeOnComputer` / `transcribeOnPhone` (the phone path keeps `SFSpeechURLRecognitionRequest` on a temp file per segment). Results are published in order as `var heard: [Words]` (append-only per session) so the Composer applies each once.
  - `transcribeOnPhone` sets `requiresOnDeviceRecognition = true` unconditionally and, when `!recognizer.supportsOnDeviceRecognition`, throws `DictationError.noOnDevice` whose message reads "This phone can't turn speech into text on the phone for <language>, so dictation is off. Turn on Nekko Voice on your computer to dictate." Nothing is sent.
  - Hold mode keeps `press`/`letGo` (one segment per hold).
  - The Composer runs intents: `dictation`/`unknown` append to `text` (tracking the last segment's range for `erase`); `clear`; `send` calls `send()`; `newSession` sets `app.newChatRequested`; `openChat` matches `store.summaries` titles and `firstUserText` case-insensitively (one hit sets `app.openChat`, several show a 3-row picker answered by tap or `pick`); `status` shows a toast built from `store.activity[id]` and `chat.watches`; `ship` uses `chat.pullRequests()` and `GitModel.prAction(url, .merge)` after confirm, else sends "Go ahead and build it."; `completeSession` confirms then `store.completeChat`; `navigate("settings")` opens Settings; other `navigate`/`go` toast "That one works on the computer" and type nothing. `Haptics.tap()` on each command.
  - Listening stops on `scenePhase != .active`.
- [ ] **Step 1: Write failing tests** in `AppTests.swift`: a stubbed transcriber returning "Fix it. Nekko, send it." makes the Composer's intent runner call send with "Fix it."; "Nekko erase that" after two segments leaves only the first; the phone path with a recognizer stub whose `supportsOnDeviceRecognition == false` throws `noOnDevice` and never creates a request.
- [ ] **Step 2: Run** the `NekkoNative` scheme tests (`xcodebuild ... build-for-testing` then `test-without-building -only-testing:NekkoNativeTests`, as in `.github/workflows/ios-native.yml`). Expected: FAIL.
- [ ] **Step 3: Implement.** Extract the intent runner into a small `@MainActor` type in `ChatView.swift`'s file (or `App/Views/VoiceRunner.swift`) so the tests drive it without UI.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Verify on the simulator** per `docs/runbooks/visual-evidence.md`: listening stays on through 5 s of silence; lock the simulator and it stops. Screenshots light and dark.
- [ ] **Step 6: Commit** `git commit -m "iOS voice: always-on dictation, Nekko commands, on-device-only phone speech"`.

### Task 2.3: iPhone first-open video

**Files:**
- Create: `apps/ios/App/Resources/voice-intro-light.mp4`, `voice-intro-dark.mp4` (rendered from `VoiceIntroVideo`, Task 1.4, with `npx remotion render`; script in `apps/desktop/scripts/render-voice-intro.mjs`)
- Create: `apps/ios/App/Views/VoiceIntroView.swift` (AVKit `VideoPlayer`, Turn on / Not now)
- Modify: `apps/ios/App/Platform/Prefs.swift` (`voiceIntroSeen`, `flag("voiceIntroSeen", false)`), the Composer mic first tap, `SettingsView` Dictation footer link "Watch how voice works"
- Modify: `apps/ios/project.yml` (resources), `spec/phone/native-ios-app.md`, `docs/voice.md`

- [ ] **Step 1: Write a failing test**: first mic tap with `voiceIntroSeen == false` presents the intro and does not start listening; dismissing sets `voiceIntroSeen = true`.
- [ ] **Step 2: Run, implement, run** (scheme tests). Expected: FAIL then PASS. Each MP4 under 3 MB.
- [ ] **Step 3: Commit, push, open the PR**, `gh pr merge --auto`.

---

## Part 3: One Live Activity for all chats, app side (one PR, branch `live-activity-card`)

Until Part 4 lands, the card updates only while the app is running (no push token is registered for it), so nothing content-bearing goes through the relay yet.

### Task 3.1: Card state model

**Files:**
- Modify: `apps/ios/App/Shared/AgentRunActivity.swift` (rename to `NekkoCardAttributes`; keep the intents file-local)
- Create: `apps/ios/Protocol/Sources/NekkoProtocol/LiveCard.swift`, `apps/ios/Protocol/Tests/NekkoProtocolTests/LiveCardTests.swift`

**Interfaces:**
- Produces:
  - `public enum LiveLevel: String, Codable, CaseIterable { case none, minimal, standard, detailed }`.
  - `public enum LiveChatState: String, Codable { case needsYou, working, watching, done, failed }`.
  - `public struct LiveChat: Codable, Hashable { id: String; short: String; state: LiveChatState; step: String; reply: String; closeWord: String; finishedAt: Date?; callId: String?; severity: String? }`.
  - `public struct LiveCardState: Codable, Hashable { chats: [LiveChat]; focusId: String?; more: Int; listening: Bool; heard: String }` (the ActivityKit `ContentState`; decodes with missing fields defaulting, as today's `init(from:)` does).
  - `public func buildCard(chats: [LiveChat], previous: LiveCardState?, pinnedFocus: String?, level: LiveLevel, now: Date) -> LiveCardState?`: sorts needsYou, working, watching, done, failed (then most recent); drops `done`/`failed` older than 2 h; keeps 8, counts the rest in `more`; focus is a chat that newly entered needsYou, else `pinnedFocus` if still present, else the first; at `minimal` blanks `short`, `step`, `reply`; at `standard` blanks `reply`; returns nil when no chats remain or level is `none`.
  - `public func shortTitle(_ title: String) -> String` (first word or two, at most 8 characters plus "…").
  - `public func closeWord(for id: String, failed: Bool) -> String`: "Got it" when failed, else a stable pick from the five words by a hash of `id`.
- [ ] **Step 1: Write failing tests** for every rule above, including 10 chats → 8 kept and `more == 2`, a done chat at 2 h 1 min dropped, focus jumping to a newly needsYou chat over `pinnedFocus`, `closeWord` stable across calls.
- [ ] **Step 2: Run** `cd apps/ios/Protocol && swift test --filter LiveCardTests`. Expected: FAIL.
- [ ] **Step 3: Implement** `LiveCard.swift`. The widget target has no NekkoProtocol dependency (`project.yml` L96-109): add the package dependency to the widget target, or put `LiveCard.swift` in `App/Shared/` and the tests in `NekkoNativeTests`. Prefer the package dependency.
- [ ] **Step 4: Run** again. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "iOS Live Activity: one card state for all chats"`.

### Task 3.2: Shared card view, mascot and status icons

**Files:**
- Create: `apps/ios/App/Shared/LiveCardView.swift` (Lock Screen view, Dynamic Island expanded/compact/minimal content)
- Move: `PixelCat` from `apps/ios/App/Views/ChatMascot.swift:39-70` to `apps/ios/App/Shared/PixelCat.swift` (internal, used by both targets)
- Create: `apps/ios/App/Shared/LiveStatusGlyph.swift`: the `ChatStatusIcon` glyphs (rocket, question mark, clock, check, Zz) plus a failed glyph, driven by `LiveChatState`, with fixed colors (the Lock Screen card is always dark)
- Modify: `apps/ios/Widgets/NekkoWidgets.swift` (L71-213 become a thin wrapper around `LiveCardView`)

**Interfaces:**
- Consumes: `LiveCardState`, `LiveLevel`.
- Produces: Dynamic Island compact is `PixelCat` leading and the most urgent chat's `LiveStatusGlyph` plus the chat count trailing; minimal is the glyph alone; expanded is the Lock Screen layout. `struct LiveCardView: View { let state: LiveCardState; let level: LiveLevel; let interactive: Bool }` (`interactive == false` in the settings preview draws buttons without intents). Layout per the spec's "One card for all chats": mascot with status badge on the left; focused chat's short title, step, and at detailed the reply; bottom strip of chips (`Button(intent: FocusChatIntent(id))`) with "+N" (`NextPageIntent`); mic at the end of the strip at detailed; close button `Button(intent: DismissChatIntent(id))` with a checkmark and `closeWord` when the focused chat is done or failed; while `listening`, the dictation area (level, `heard`, Cancel, "Send to <short>") replaces the strip. Chat text uses `.privacySensitive()`. Focus changes animate with `.contentTransition(.opacity)` and `.transition(.push(from: .bottom))`.
- [ ] **Step 1: Write a failing snapshot-style test** in `apps/ios/Tests/AppTests.swift` rendering `LiveCardView` with `ImageRenderer` at 360 pt width for each level and for the listening state, asserting the rendered height is at most 160 pt and that minimal contains no chat title string (check through the accessibility labels).
- [ ] **Step 2: Run, implement, run.** Expected: FAIL then PASS.
- [ ] **Step 3: Commit** `git commit -m "iOS Live Activity: shared card view with mascot, status icons and chip strip"`.

### Task 3.3: Card lifecycle, intents and the levels setting

**Files:**
- Modify: `apps/ios/App/Platform/RunActivities.swift` (one `Activity<NekkoCardAttributes>` instead of one per chat)
- Modify: `apps/ios/App/Shared/AgentRunActivity.swift` (intents: `FocusChatIntent(sessionId)`, `NextPageIntent`, `DismissChatIntent(sessionId)`; keep `AnswerApprovalIntent`, `AllowToolIntent`, `StopRunIntent`)
- Modify: `apps/ios/App/AppModel.swift` (L120-125, L232-235), `apps/ios/App/Platform/Prefs.swift` (replace `liveActivities: Bool` with `liveActivityLevel: String`; migration: stored `liveActivities == false` gives `none`, else app lock on gives `minimal`, off gives `standard`)
- Modify: `apps/ios/App/Views/SettingsView.swift` (L165-172 "While a chat runs": a "Live Activities" row opening `LiveActivitySettingsView`)
- Create: `apps/ios/App/Views/LiveActivitySettingsView.swift`: `LiveCardView(state: .sample, level: selected, interactive: false)` on a dark Lock Screen backdrop above a four-row picker (None, Minimal, Standard, Detailed); the preview updates on selection. Footer for Standard and Detailed: "Chat titles and status are shown when your phone is unlocked. While the app is closed they reach your phone through the relay and Apple's push service." Footer for Minimal: "No chat text leaves your computer for the Lock Screen."
- Modify: the Security footer at `SettingsView.swift:122` (app lock no longer controls the Lock Screen; point to Live Activities)

**Interfaces:**
- Consumes: `buildCard`, `LiveCardView`.
- Produces: `RunActivities.refresh(now: Date)` rebuilds the card from `store.summaries`, `store.activity`, live run steps and watches, calling `buildCard`; it starts the activity when the result is non-nil and none is running, updates it (2 s throttle unless urgent, as today), and ends it when nil. `RunActivities.pinnedFocus` is set by `FocusChatIntent`; `DismissChatIntent` adds the id to a dismissed set the build skips until that chat runs again. `IntentRouter` gains `focus`, `nextPage`, `dismiss`.
- [ ] **Step 1: Write failing tests** (`AppTests.swift`): the Prefs migration (three cases); `refresh` with two running chats starts exactly one activity (inject an activity factory); dismissing the only done chat ends it.
- [ ] **Step 2: Run, implement, run.** Expected: FAIL then PASS.
- [ ] **Step 3: Verify on the simulator**: one card with 3 chats, chip tap moves focus, settings preview changes per level. Screenshots for the PR.
- [ ] **Step 4: Update** `spec/phone/native-ios-app.md` (Live Activities section: one card, levels, mascot) and commit, push, open the PR, `gh pr merge --auto`.

---

## Part 4: Card pushes and remote start through the relay (one PR, branch `live-activity-push`, after Part 3)

**Files:**
- Modify: `crates/nekko-remote/src/agent.rs` (`relay_frames` L475-495, `activity_frame` L500-555, `phases` L117)
- Modify: `crates/nekko-remote/tests/golden.rs` and `crates/nekko-remote/tests/golden/agent.json` (hand-edited in the same PR, per `docs/runbooks/golden-fixtures.md`)
- Modify: `apps/relay-server/src/server.ts` (`case 'activity'` L268-280, `register-activity` L341-366), `apps/relay-server/src/push.ts` (`activityPayload` L61-72, `sendActivity` L225-233), tests `push.test.ts`, `relay.test.ts`
- Modify: `apps/ios/Protocol/Sources/NekkoProtocol/RelayClient.swift:402`, `apps/ios/Protocol/Sources/NekkoKit/Computers.swift:935`, `apps/ios/App/Platform/RunActivities.swift`
- Modify: `packages/shared/src/remote.ts:264-279` (document `card`, `card-start`, `register-card`)

**Interfaces:**
- Produces:
  - Phone → relay: `{type:"register-card", deviceId, token, startToken?, level, app?}`; `level` is `minimal | standard | detailed`. Replaces per-chat `register-activity` for the card (keep the old frame accepted for older phones).
  - Phone → computer (encrypted RPC): `card:set { level?, focus?, dismiss? }` on a new phone-allowed channel, so the computer knows the highest level any phone wants and honours focus and dismiss.
  - Computer → relay: `{type:"card", state}` where `state` is `LiveCardState` JSON built by the computer with the same rules as `buildCard` (port it to Rust in `agent.rs`, and add `LiveCard` cases to a new `packages/shared/fixtures/live-card.json` read by both `LiveCardTests` and a Rust test); text fields are included only when some phone asked for standard or detailed. `{type:"card-start", state}` is sent when no card is up and a run starts that was woken by a PR watch or is in a chat a phone sent `chat:send`/`chat:queue` to in the last 2 hours.
  - Relay: for `card`, pushes `event: "update"` (or `"end"` when `state.chats` is empty) to every registered card token in the room, blanking `short`, `step` and `reply` for devices registered at `minimal` and `reply` at `standard`; for `card-start`, pushes `event: "start"` with `attributes-type: "NekkoCardAttributes"` and `attributes` to each `startToken`. Payload under 4 KB (truncate `step` and `reply` to 60 characters).
  - iOS: register `Activity<NekkoCardAttributes>.pushToStartTokenUpdates` (iOS 17.2+) and the card's `pushTokenUpdates`; send `card:set { level }` on connect and on level change.
- [ ] **Step 1: Write failing tests**: `push.test.ts` for the three payload shapes and per-level blanking; `relay.test.ts` for `register-card` validation and `card` fan-out; a Rust unit test in `agent.rs` for the card build, the 2-hour rule and the remote-start rule; the shared `live-card.json` cases in Rust and Swift.
- [ ] **Step 2: Run** `npx vitest run apps/relay-server && cargo test -p nekko-remote --locked && (cd apps/ios/Protocol && swift test --filter LiveCardTests)`. Expected: FAIL.
- [ ] **Step 3: Implement** relay, Rust agent and iOS registration; update `agent.json` golden frames by hand.
- [ ] **Step 4: Run** the same commands plus `npm run typecheck -w @nekko-agent/relay-server`. Expected: PASS.
- [ ] **Step 5: Note in the PR's release blockers** that APNs delivery and push-to-start are unverified until the relay has the production APNs key and a device runs it; update `spec/phone/native-ios-app.md` ("Live Activities while suspended") accordingly. Commit, push, open the PR, `gh pr merge --auto`.

---

## Part 5: Live Activity mic and reply line (one PR, branch `live-activity-mic`, after Part 4)

**Files:**
- Modify: `apps/ios/App/Shared/AgentRunActivity.swift` (add `TalkToChatIntent`)
- Modify: `apps/ios/App/Platform/Dictation.swift` (a `captureOnce(store:) async throws -> String` that records one segment with `VoiceSegmenter` and transcribes it with the user's engine)
- Modify: `apps/ios/App/AppModel.swift` (`IntentRouter.talk`), `apps/ios/App/Platform/RunActivities.swift` (`listening`, `heard`, "Sent: …" until the reply arrives)
- Modify: `apps/ios/Info.plist` only if `AudioRecordingIntent` requires it (check Apple's docs first; do not add the `audio` background mode unless required)

**Interfaces:**
- Consumes: `LiveCardState.listening`/`heard`, `ChatModel.send(_:skill:images:)`, `Dictation.captureOnce`.
- Produces: `struct TalkToChatIntent: LiveActivityIntent` (and `AudioRecordingIntent` under `@available(iOS 18, *)`) with `@Parameter sessionId`, `authenticationPolicy = .requiresAuthentication`. `perform()` sets `listening = true`, calls `captureOnce`, sends the text to that chat (`chat:send`, or `chat:queue` mid-run through `ChatModel.send`), sets `heard = "Sent: <text>"`, `listening = false`. On iOS 17 the button is `Link`-style: it opens `nekko-agent://chat/<id>?listen=1`, which opens the chat with always-on listening started. The reply line (`LiveChat.reply`) is the first sentence of `lastReplyText`, at most 60 characters.
- [ ] **Step 1: Write failing tests**: `captureOnce` with a stubbed engine returns its text and refuses with `noOnDevice` as in Task 2.2; the intent runner with a stubbed `captureOnce` sends exactly one message to the given session and sets `heard`; the reply extraction ("Got it. Working on it now." gives "Got it.").
- [ ] **Step 2: Run, implement, run** (scheme tests). Expected: FAIL then PASS.
- [ ] **Step 3: Verify on a physical iPhone** (the simulator has no Lock Screen Face ID flow): Face ID then speak from the Lock Screen; record the result, and if it fails, file it as a release blocker rather than weakening the auth policy.
- [ ] **Step 4: Update** `spec/phone/native-ios-app.md` and `docs/voice.md`; commit, push, open the PR, `gh pr merge --auto`.
