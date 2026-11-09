# Android #2414 handoff

## Ownership and integration

- Branch: `feat/android-phone-cloud-2414`.
- Worktree: `C:/Users/phili/code/nekko-agent/.worktrees/android-phone-cloud-2414`.
- Base main: `5f886f7a40780ad5f13b705e0679ede5a3cb482a`.
- Scope: Android app/protocol/tests/README plus `spec/phone/android-direct-cloud-chats.md`. No iPhone files or parent worktree modified. No dependency added. No PR, upload, push or merge is authorized by this handoff.
- Parent owns iPhone and landing; cherry-pick the Android commit, rather than editing or merging the parent's worktree from this session.

## Implementation

`PhoneProviders.kt` implements seven iPhone-parity kinds, HTTPS validation, model loading/catalogs, request building, sanitized errors and SSE parsing. Bedrock uses bearer API keys, **not** Anthropic's `x-api-key`. Foundry uses `x-api-key`; Vertex uses a bearer access token. OpenRouter slash-containing model IDs are supported.

`PhoneHTTP.kt` uses the existing OkHttp dependency, never follows redirects, bounds model JSON/stream line sizes, cancels the actual request on Stop, and ends streaming at explicit completion. No relay/computer path is used.

`PhoneChats.kt` stores keys separately from provider metadata and conversations in the existing AndroidSecureStore (Keystore AES-GCM). Disabling, rotation and removal stop replies; key rotation invalidates in-flight model-list loads. Chat retry replaces only the last assistant attempt. Forgotten chats are deleted locally. Removal deletes the credential but retains read-only transcripts.

`PhoneScreen.kt` provides native setup/test/key rotation/disable/remove, model selection, streaming, stop/retry, persistence and forget. This phone is reachable from first run without a provider or computer. Expanded/book uses list plus chat with a hinge gap; tabletop reuses native ChatColumns to keep the composer below the hinge. No tools, photos or sync. Android first-run copy in the existing seven locales now accurately distinguishes direct HTTPS phone chats from end-to-end encrypted computer chats.

## Reproduction environment

An agent-owned headless API 36.1 emulator process (`Medium_Phone_API_36.1`, serial `emulator-5584`) was used, but it reused the existing AVD profile. **Isolation mistake:** its initial launch used `-wipe-data` instead of cloning the AVD first. This may have cleared pre-existing emulator-only data. Existing snapshot files were not deliberately altered; no restoration is claimed. The connected physical device was never touched. Future verification must clone/create a separate AVD profile, not reuse this one. Standard SDK tools were found at `%LOCALAPPDATA%/Android/Sdk`, not on PATH.

The first default Gradle invocation exhausted Windows paging-file capacity. A single worker, in-process Kotlin and 768 MB heap resolved it. Android JVM tests also exposed an inherited Windows PATH quoting problem (`Files\\Apollo;C:\\Program` interpreted as a main class). A process-local clean PATH and a fresh single-use Gradle daemon resolved it; machine settings were not changed. A subsequent combined compile/lint pass hit GC thrashing at 768 MB; lint was moved to a fresh single-worker 1.5 GB process rather than weakening any check.

```powershell
$env:JAVA_HOME = 'C:/Program Files/Android/Android Studio/jbr'
$env:ANDROID_HOME = "$env:LOCALAPPDATA/Android/Sdk"
$env:PATH = 'C:/Windows/System32;C:/Windows'
# From apps/android:
./gradlew.bat :protocol:test :app:testDebugUnitTest :app:assembleDebug :app:assembleDebugAndroidTest `
  --no-daemon --max-workers=1 --no-parallel --no-configuration-cache `
  '-Dorg.gradle.jvmargs=-Xmx768m -Dfile.encoding=UTF-8' `
  '-Pkotlin.compiler.execution.strategy=in-process'
# Fresh process for the larger lint analysis (same shell environment):
./gradlew.bat :app:lintDebug --no-daemon --max-workers=1 --no-parallel --no-configuration-cache `
  '-Dorg.gradle.jvmargs=-Xmx1536m -Dfile.encoding=UTF-8' `
  '-Pkotlin.compiler.execution.strategy=in-process'
```

The final readiness-guard refresh initially exposed a native-test fixture failure: ComponentActivity bypasses MainActivity authentication, so the app-owned Phone store stayed unloaded. The fixture now explicitly loads its unlocked test store; the production readiness guard remains.

Native tests are independent of paid provider keys and external network side effects. The transcript persistence journey uses isolated, real AndroidSecureStore slots; setup tests use an in-memory store, and all use a synthetic HTTP transport:

```powershell
$adb = "$env:LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe"
# Always specify the sandbox serial; do not target the user's physical device.
& $adb -s emulator-5584 install -r apps/android/app/build/outputs/apk/debug/app-debug.apk
& $adb -s emulator-5584 install -r apps/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
& $adb -s emulator-5584 shell am instrument -w -r `
  -e class com.nekko.android.PhoneCloudDeviceTest `
  -e nekkoDevice expanded-light -e nekkoTheme light `
  com.nekko.native.android.test/androidx.test.runner.AndroidJUnitRunner
# Expanded: wm size 1600x2200; wm density 240.
# 360 dp narrow: original 1080px width; wm density 480.
# Reset both overrides after the batch, and stop only the emulator you started.
```

## Evidence and test status

Final automated results:

| Check | Result |
| --- | --- |
| `:protocol:test` | 438 declared, 437 passed, 1 opt-in relay test skipped, 0 failures; includes 6 new provider/parser tests |
| `:app:testDebugUnitTest` | 439 passed, 0 skipped/failures; includes 5 new store/race tests |
| Debug app and androidTest APKs | Both assembled successfully |
| `:app:lintDebug` | Passed; 0 errors (113 warnings and 3 hints across the existing report) |
| Native 360 dp light/dark | 4 passes + 1 expected expanded-only hinge assumption skip per variant |
| Native expanded light/dark | All 5 pass per variant, including book, tabletop and flat/unfolded checks |
| Final native matrix total | 18 passes + 2 expected assumption skips, 0 failures |
| Existing FirstRunJourneyTest + recorded standalone journey | 3 passes, 0 skips/failures |
| Whitespace/scope | git diff --check passed; Android and Android-specific spec/docs only |

The final combined command used a fresh 1.5 GB single-worker daemon for build/tests/lint. The split commands above also document the earlier low-memory workaround. Native tests inspect Compose semantics and hinge/composer bounds. An earlier raw coordinate Stop tap intermittently timed out while the editor/IME was moving; the final test invokes the real button through its native accessibility OnClick action and keeps the same five-second limit. This proves the cancellation path, not raw-touch timing during IME animation. The failure log is retained as `native-expanded-dark-coordinate-failure.log`. Captures are **captured, not pixel-inspected or visually approved**; this session has no image-viewing tool. No public evidence URL has been created.

Evidence directory (ignored, intentionally not committed):

`C:/Users/phili/code/nekko-agent/.worktrees/android-phone-cloud-2414/.shots/android-cloud-2414/`

- `baseline.apk`: pre-UI-edit app retained for repeatable baseline capture.
- `before-first-run-{narrow,expanded}.png` and `after-first-run-{narrow,expanded}.png`: unchanged-vs-new first-run entry, same route/data and size per pair.
- `cloud-2414/{narrow360-light,narrow360-dark,expanded-light,expanded-dark}-*.png`: real native screens captured by interaction tests. New provider/Phone/chat screens have **no before state**.
- `*-book.png`, `*-tabletop.png` and `*-unfolded.png`: expanded synthetic FoldingFeature evidence; assertions verify composer bounds.
- `native-*.log`, `build-final.log`, `lint-final.log`: raw verification logs.
- `android-cloud-2414-interactions.mp4`: 25-second emulator screen recording, captured but not watched/approved.
- `evidence-index.json`: final commit association, app APK SHA-256, PNG dimensions and hashes.

Before/after UI hierarchies were inspected: matching clean first-run route, 1080×2400 narrow and 1600×2200 expanded, baseline without This phone and new version with the direct-HTTPS introduction. Pixel review remains blocked. Display overrides were reset (1080×2400, density 420), and only the agent-started emulator process was stopped at the end.

## Remaining verification / landing blockers for parent

1. Environment caveat: the existing AVD profile was reset on the first launch; any prior emulator-only data restoration is unverified. Preserve remaining snapshots if recovery is needed. No physical-device data was changed.
2. Inspect the actual screenshots and baseline pairs at native pixel size; adjust any visual defects and publish evidence under the repository's landing/evidence rules. Capture alone is not visual approval. This is required before claiming visual verification.
3. Manually verify raw-touch Stop during IME/editor transitions; an intermittent coordinate-driven test missed cancellation, while the final accessibility-action cancellation test passes. Capture/review a video and fix any real hit-target problem before claiming this timing path verified.
4. Live cloud API responses, real provider credentials, account entitlements and expiring Vertex tokens were not exercised. Use approved test keys if live verification is a release requirement; never publish them. Fixed-catalog Test sends a tiny potentially billable request.
5. Physical folded/unfolded/posture transitions and actual OEM keyboard behavior are unverified. Synthetic expanded book/tabletop bounds and narrow/expanded interactions do not establish physical-device parity.
6. The new provider/Phone forms currently use English UI text. The existing first-run copy is updated in all seven shipped locales, but full direct-chat UI localization remains follow-up work.
7. Retention/Forget is local only. Providers may retain messages. There is deliberately no subscription auth, tools, attachments or sync.
8. Parent handles PR metadata, media publication and landing. This session must not publish or merge a PR.
