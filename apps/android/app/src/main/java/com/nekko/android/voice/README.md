# Android voice parity (#2110): parent integration handoff

## Status / specification supplement

Implemented here, **not yet wired into the app's chat screens**:

- `VoiceConversation`: explicitly started half-duplex capture → respond → plain-text local playback → listen again. Stop invalidates asynchronous completions and discards unsent speech. A prompt already sent / agent already running is not undone. Silence, empty replies, errors and deadlines stop visibly, without blind retry.
- `ConversationAudio`: Android **12/API 31+ dedicated on-device** `SpeechRecognizer`, offline installed `TextToSpeech` voice, input-cap-aware long-reply chunking, identity-owned cancellation, audio focus, final results only. No recording files, cloud fallback, background microphone or new service.
- `VoiceSafety`: activity/navigation lifecycle pause/stop/destroy, screen-off, becoming-noisy and audio-device changes stop voice. Return never restarts it. `VoiceConversationSheet` additionally gates sends on the current authorization and hides its **separate dialog window** while unauthorized (an activity LockGate alone cannot cover a dialog).
- `VoiceListening`: continuous final-utterance command/dictation capture, or one held utterance. Normal Finish drains the final transcript; Abort drops it and invalidates commands. SpeechRecognizer supplies utterance boundaries. `VoiceSegmenter` is the pure PCM counterpart that cuts the composer's tap-mode dictation (`DictationController` with `continuous = true`, `Recorder.stream`) into pieces for the computer's Whisper; it is never a second microphone opened beside SpeechRecognizer.
- `VoiceCommands`: iOS addressed grammar and the shared non-desktop fixture. Ordinary and unknown commands become draft text, not actions. Desktop navigation produces an explicit computer-only notice.
- `VoiceRunner`: serialized segments, send/erase/clear/status/new chat/settings/chat lookup, confirmation-gated complete/merge, ship/question/go-ahead, short-lived wake carry, 60-second consumed-once confirmation, stale-button IDs and navigation-tail parking. Host callbacks keep the app's existing Change proof/step-up and connection checks.
- `HoldToTalk`: monotonic-clock permission/start/release reducer, 400 ms minimum from actual recorder readiness, early-release discard. `HoldToTalkButton` supports pointer cancellation and semantic start/finish activation; permission completion never starts capture.
- `VoiceCommandPrompt`: standalone choice/confirmation component, vertical buttons (narrow phone/tabletop safe).

No existing Android voice sources were changed. No changes to ChatScreen, NewChatScreen, Outbox, Wire, strings, manifest, build dependencies, branches or commits. Android 9–11 and phones without installed on-device recognition retain existing one-shot computer/phone dictation; hands-free mode reports unavailable rather than covertly using online recognition. There is no platform wake-word daemon.

The canonical `spec/phone/native-android-app.md` and `reports/voice-image-readiness.md` must be updated **by the parent with the integration**, distinguishing the implemented cores from wired/verified behavior. This file is the owned-scope specification supplement, not a claim that #2110 is already shipped.

## Integrate the conversation sheet

1. Add a Voice conversation entry to the composer's + menu. It only opens the sheet; opening does not start recording. Cancel legacy dictation before opening and enforce **one audio owner across both foldable panes**, not one per pane.
2. Use a stable `targetKey = "$computerId:$sessionId"`. Dismiss/dispose when either changes, on navigation or completion, or when the app locks. Pass `authorized = unlocked && !privacyCovered && sameComputerAndChat && online && !readOnly && !waitingForUser`. Do not include the conversation's **own** running turn in the authorization gate: it must be allowed to await its reply. Refuse Start over an unrelated running/queued turn or nonempty composer/armed skill/photos/outbox rather than overwriting or queuing something inadvertently.
3. Bind the callback once to the original computer and session; never read whichever chat/computer happens to be active after suspension. The separate **required `isAuthorized` lambda must read live lock/cover, connection and target state** (e.g. `appLock.status.value`, `appLock.covered.value`, current repo state), not merely capture the last recomposed `voiceAuthorized` Boolean. This closes the lock-before-recomposition race at I/O boundaries. Supply the dictation language (or empty for system language). Render `VoiceConversationSheet` only when the entry is open:

   ```kotlin
   VoiceConversationSheet(
       targetKey = "$computerId:$sessionId",
       authorized = voiceAuthorized,
       isAuthorized = { liveVoiceAuthorizationFor(computerId, sessionId) },
       respond = { words -> sendAndAwaitFreshVoiceReply(words) },
       onDismiss = { voiceOpen = false },
       language = phoneLanguage,
       labels = translatedVoiceLabels,
   )
   ```

4. Implement `sendAndAwaitFreshVoiceReply` in the parent integration layer:
   - Recheck the above preflight **immediately before sending**; voice must not silently enter the offline outbox or another turn's queue.
   - Snapshot current message IDs / transcript position and the original target, then submit exactly one prompt through the normal send path (retain existing exactly-once IDs; never implement a retry here).
   - **`ChatViewModel.send` / `ChatController.send` returns before the turn ends**: `ChatController` launches its request on its own scope. Do NOT return the last cached assistant block right after `send()` or use the first idle state as completion.
   - Observe the specific new run's completion and freshly reloaded transcript. Return only the new assistant text after the submitted prompt (exclude old replies, reasoning, tools and other chats). On disconnect, approval/question, deletion, failure, completion without a new assistant reply, or target change: throw a visible error / stop rather than read stale content or continue listening. `VoiceConversation` bounds waiting to 300 seconds and strips Markdown for speech.
   - The callback must be cancellation-cooperative (use cancellable Flow awaiting, clean up event subscriptions). Stopping voice does not call `chat:abort`; an already submitted agent turn may finish in the chat. No automatic resend on timeout or unlock.
5. Add a manifest package-visibility query beside the existing recognition query (outside this owned scope):

   ```xml
   <intent>
       <action android:name="android.intent.action.TTS_SERVICE" />
   </intent>
   ```

   `RECORD_AUDIO` and the recognition service query already exist. No extra service/permission/library is needed. Permission grant displays a notice and requires Start again. Installed offline speech/voice language packs may need to be provisioned via Android's system settings; this code never downloads models itself.
6. Supply translated `VoiceLabels`; also translate the new core notices/command labels in the parent's localization pass. English defaults in these new files are not a claim of localized parity. Existing string files were intentionally not edited.

## Integrate addressed commands / hold-to-talk

Construct one `VoiceRunner(scope, host)` bound to the original target. Implement its `Host`:

| Host member | Parent wiring / guard |
| --- | --- |
| `text` | Current composer draft; preserve user edits. |
| `allowed()` | Synchronous foreground/unlocked/original-target/online check, also checked after suspension. |
| `send()` | Normal guarded composer send; return true only when accepted, no silent offline queue success for voice. Clear draft only via the normal successful send path. |
| `complete()` | Existing view-model complete path; keep Change proof policy. |
| `ship()` | Fresh PR list, running state and exact current question call ID for this chat. |
| `merge(pr)` | Existing signed/proof/step-up PR merge path; revalidate PR ID/state; null only on confirmed success. |
| `answer(questionId, text)` | Match the **same** still-pending question ID; use the existing answer format/proof path, never answer a replacement question. |
| `chats/open/newChat/openSettings` | Existing navigation; target changes must invalidate the old capture. |
| `park(text)` | Preserve in the intended destination draft, no send. |
| `toast/tap/status/title` | Existing presentation and haptic facilities. |

`VoiceRunner` performs no wire calls or permission expansion. Its host defaults are safe/no-op, so wire every capability before exposing it. Every asynchronous host proof/step-up flow must recheck target/authorization **after authentication and immediately before the wire mutation**; core cancellation cannot undo an action the host has already invoked.

For continuous commands, use `VoiceListening(scope, runner)` with:

```kotlin
VoiceListening.IO(
    capture = { audio.capture(language) },
    finishCapture = { audio.finishCapture() },
    stopAudio = { audio.stop() },
    allowed = { liveVoiceAuthorizationFor(computerId, sessionId) && safety.foreground },
)
```

- `start(io)` is explicit opt-in. `finish()` normally stops and drains the last utterance. `abort()` is mandatory for background/lock/cover, target change, disconnect, audio interruption and disposal. Attach `VoiceSafety(context, lifecycleOwner) { listening.abort() }`, call `start()` from a `DisposableEffect`, and close it at disposal. Feed lock/cover/disconnect changes immediately; an `allowed()` predicate alone does not revoke a confirmation permanently across unlock.
- Do not automatically restart on foreground/unlock. Conversation and continuous/hold modes are mutually exclusive; never let both own audio. Disable all behind-lock voice prompts as well as the dialog.
- For holds, pass one `HoldToTalk` to `HoldToTalkButton`. Actions: ASK_PERMISSION → request permission only; START → `listening.start(io, held = true)`; FINISH → `listening.finish()`; DISCARD → `listening.abort()`; NONE → no action. In `audio.capture(onReady = { ... })`, call `hold.didStart(SystemClock.elapsedRealtime())` and route its DISCARD action back to abort. On startup error, `hold.reset()` before the next press. The release clock starts on `onReady`, not permission request or coroutine launch.
- Collect `runner.pending` and render `VoiceCommandPrompt` only while authorized. `onAnswer` launches `runner.answer(intent, pendingId)` on Main. Never invoke an option closure directly. Normal held completion retains the prompt for the next hold; continuous Finish, Abort and timeout clear it. Expiration uses a monotonic clock.
- All core public calls, host callbacks, platform audio calls and UI wiring must run on **Main**. PCM segmenter ownership is single-threaded; no background shared mutable capture state.

## Verification actually performed

- SDK-free compilation of the seven real Kotlin cores plus the existing real `MarkdownTree.kt`, Kotlin **2.4.21**, coroutines/serialization **1.11.0**, JVM target **17**, JUnit **4.13.2**, executed using the installed Windows JDK **24**.
- **51 tests passed** across seven new suites: conversation 10, grammar 5 (including the shared non-desktop fixture cases), segmenter 7, hold 4, runner 14, listening 8, speech chunking 3.
- Late/noncooperative capture, reply and playback; no overlapping Start; stop/finish-before-dispatch; held recognition cannot execute before physical release and can still be discarded; authorization recheck; empty speech/reply; timeout; scope cancellation; final drain vs abort; wake expiry; confirmation expiry/consumption/stale taps; complete/merge/question flow; navigation-tail parking; chunk-invariant PCM and Unicode-safe TTS chunks.
- Temporary compiler/test dependencies were downloaded under ignored `.shots/android-voice-jvm/`, matching existing pinned dependencies and digest-checked against Maven. No SDK locations accessed and no Gradle/app dependency changes. The harness may be rerun there with `powershell -NoProfile -ExecutionPolicy Bypass -File .shots/android-voice-jvm/test.ps1`; it is not an app build.

## Native integration update

The follow-on integration is now implemented in `ChatVoiceControls.kt`, `VoiceComposer.kt`, `VoiceTurn.kt`, `ChatScreen`/`Composer`, `ChatViewModel` and `ChatController.sendVoice`. It adds the TTS manifest query, voice resources, live post-proof authorization and a shared audio lease including legacy dictation across panes. `spec/phone/android-hands-free-voice.md` is the canonical implementation/verification record. The SDK-free integration harness is `apps/android/scripts/voice-integration-check.ps1`: **134 tests passed**, including shared-image regressions. `VoiceIntegrationEvidenceTest` is a synthetic native Ready/draft/lock/voice-off fixture, not executed here.

## Unfinished integration / release blockers

- Android build/native/audio evidence and translations remain unverified/incomplete as detailed in the canonical spec. Rust/TS host authorization is parent-owned; no host changes were made here.
- **Android/Compose compilation, lint, instrumentation and real audio behavior are unverified.** SDK access is constrained/denied in this workspace; no alternate SDK access attempted. Run the standard native build in permitted CI/tooling:

  ```sh
  cd apps/android
  ./gradlew :app:testDebugUnitTest --tests 'com.nekko.android.voice.*'
  ./gradlew :app:compileDebugKotlin :app:lintDebug :app:assembleDebug
  ```

- New UI has **no before state**. No screenshots/video captured or inspected; no app/emulator launched. Parent must capture and inspect the integrated sheet, hold gesture and confirmation flow in an isolated emulator, including folded, unfolded and tabletop layouts, TalkBack and increased font size. Follow `docs/runbooks/visual-evidence.md` for publication; don't treat JVM tests as native evidence.
- Hardware/OS verification: microphone permission denial/regrant, API 28–30 unavailability, API 31+ missing language/recognizer/TTS packs, Start/Stop repeatedly, silent turns, long replies, background/lock/cover while capture/send/playback is pending, disconnect/reconnect, incoming calls, Bluetooth/wired route changes, navigation and folding between panes. Confirm no capture/playback resumes without another explicit Start, no duplicated prompts, no speech leaks over the lock and no stale reply is spoken.
- No commits, branch changes, PR changes or issue edits were made for this subtask. This is an implementation handoff, not a claim of end-to-end parity certification.
