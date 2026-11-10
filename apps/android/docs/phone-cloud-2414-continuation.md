# Android #2414 continuation checkpoint

This supersedes the authentication and verification claims in the original [handoff](phone-cloud-2414-handoff.md). Parent owns iOS, global docs, publication and landing. No PR, push or PR merge performed here.

## Recovered work and integration

- Original implementation retained: `fb66d4e608c122ab5b74a653ae0617831178b218`.
- Current main integrated cleanly by merge commit `2999d352f` on `feat/android-phone-cloud-2414`. Non-Android changes in that merge are inherited upstream, not authored by this continuation. Parent can cherry-pick the subsequent Android-only fix commit onto its integrated branch.
- Reused the saved baseline APK and evidence, rather than rebuilding the feature.
- Two explicitly routed `chatgpt-mupjbttk / gpt-6.1-sol` subagents audited provider/transport and chat lifecycle respectively. Parent reviewed and ran their changes.

## Fixes

- Bedrock **Mantle Anthropic Messages** sends `x-api-key`, not `Authorization: Bearer`. This route is not Bedrock's OpenAI route. See [official Messages endpoint documentation](https://platform.claude.com/docs/en/build-with-claude/claude-in-amazon-bedrock). Removed Sonnet 4.6 from this route's catalog.
- Revalidate stored provider configuration before attaching credentials; reject invalid header values and unsafe URL/model paths. Apply bounded reply token requests on OpenAI-wire providers too.
- Bounded model lists, SSE lines, frames, full streams and accumulated reply text; sanitized terminal failures; SSE content-type requirement; no invented EOF delimiter. OpenAI requires `[DONE]`, allowing errors after `finish_reason` to be handled.
- Disable/remove/key rotation and owner-scope cancellation cancel provider model/Test requests and chat replies. Stale success/failure results cannot replace newer model loads. Late stream callbacks cannot rewrite a newer attempt or forgotten chat. Cleanup releases task registrations even on failed persistence.
- Native Stop regression now uses Compose touch dispatch (`performClick`) rather than invoking the accessibility action directly.
- No tools, photos, sync, relay requests or dependencies added.

## Checks actually run

Using installed SDK `%LOCALAPPDATA%/Android/Sdk` and JBR `C:/Program Files/Android/Android Studio/jbr`, with process-local clean PATH, one worker and 1.5 GB heap (see original handoff commands):

| Check | Result |
| --- | --- |
| `:protocol:test` | 455 declared, 454 passed, one opt-in relay integration skip, zero failures |
| `:app:testDebugUnitTest` | 576 passed, zero failures/skips |
| Phone provider/store regression suites | 12 and 19 tests respectively, included above |
| `:app:assembleDebug`, `:app:assembleDebugAndroidTest` | Passed |
| `:app:lintDebug` | Passed |
| Native full matrix: 360 dp narrow / expanded, light / dark | 18 passes, two expected expanded-only assumption skips, zero failures |
| Native touch Stop / retry / Keystore persistence / forget, narrow and expanded, light and dark | Four passes; no accessibility-only Stop shortcut |
| `git diff --check` | Passed |

Full matrix ran the initially built accessibility-action fixture; separate native touch runs use the rebuilt final instrumentation fixture. Test transport is synthetic and no paid endpoint is contacted.

## Isolation and evidence

Only the freshly created agent AVD `PhoneCloud2414` on `emulator-5586` was used. It lives under ignored `.shots/android-cloud-2414/isolated-avd/`. Only hardware configuration was derived from the installed profile: **no user data, snapshots or writable images were copied**. Fresh data was created by the emulator. Launch used `-no-window -no-audio -no-snapshot`, software GPU, no cameras; Wi-Fi/mobile data were disabled before native runs completed. Existing user AVDs and connected physical device `BYZL24112900103126` were not targeted, reset, installed to or stopped. This does not undo the historical isolation mistake recorded by the original handoff.

Local ignored evidence: `.shots/android-cloud-2414/continued/`:

- `before-first-run-{narrow,expanded}.png` and `after-first-run-{narrow,expanded}.png`: same clean first-run route, default light theme, viewport and data per pair. Retained baseline APK is from the original checkpoint's pre-feature base, **not a rebuilt current-main APK**; upstream changes may also contribute to pixel differences. Hierarchies inspected and entry/copy changes confirmed. Narrow pair is 1080×2400 at density 420; expanded is 1600×2200 at density 240.
- `cloud-2414/*`: refreshed native screen captures in all four size/theme variants, including book/tabletop/unfolded. The new phone/provider/chat surfaces have **no before state** in the pre-feature baseline.
- `native-*.log`, `raw-*.log`: actual instrumentation results.
- `evidence-index.json`: APK/image hashes, dimensions and explicit review status. Build/lint logs are one directory above.
- `cloud-2414-touch.mp4`: 45-second native touch video captured locally; capture is not playback inspection or visual approval.
- Display overrides reset and only the agent-started emulator stopped after verification; sandbox AVD retained for reproducibility.

## Exact remaining limitations / blockers for parent

1. **Pixel/video inspection is blocked by the available tools:** this session can capture native media and inspect UI hierarchies/assertions, but has no image/video viewing tool. Parent must open and inspect the evidence, fix defects if any, then publish it under repository rules before visual verification is claimed. No evidence has been uploaded here.
2. Live authentication, billable replies and account entitlement behavior were not exercised: no approved test credentials supplied. In particular, validate Mantle's corrected auth with an entitled test token and validate expiring Vertex tokens if live verification is required.
3. Foundry custom deployment names are unsupported by the fixed catalog. Use deployment names matching offered IDs or add explicit deployment-name configuration before claiming arbitrary Foundry deployment support.
4. Physical hinge/posture transitions and OEM keyboards remain untested. Synthetic narrow, book, tabletop and flat assertions do not establish physical folding-device parity. Touch-dispatched Stop checks do not prove all possible IME-animation timings.
5. Direct-chat forms remain English-only. No localization expansion was attempted.
6. SecureStore writes across slots are not transactional. Failed writes can leave partial persistence; a failed Forget write cannot guarantee durable deletion. Partial streamed text can be lost on process death because writes occur at attempt start/cleanup, not each token.

Parent must not treat these captured files as visually reviewed evidence. This branch is a committed implementation checkpoint, not authorization to publish or merge a PR.

## Authorized publication continuation

The parent subsequently authorized push and a **draft** Android PR, not merge. This supersedes the publication prohibition above, not its evidence limitations. The iPhone counterpart remains separate, unshipped draft PR #2462. Both PRs use `Refs #2414`; the issue stays open until both land. No iOS files or parent worktree were edited.

Latest `origin/main` merged cleanly as `694cf532e`. On this integrated result, `:protocol:test` (455 declared, 454 passed, one opt-in skip), `:app:testDebugUnitTest` (576 passed), `:app:assembleDebug`, `:app:assembleDebugAndroidTest` and `:app:lintDebug` passed. Spec-index and whitespace checks passed. Logs remain ignored under `.shots/android-cloud-2414/`.

Selected existing captures are published as **captured, inspection pending**, not visual approval. Parent is inspecting the local evidence served at `localhost:18414`. Published continuation captures are associated with `ad7039c52`, not the latest integration; upstream icon changes may affect the integrated appearance. The first-run before APK is the older saved base `5f886f7a4`, not rebuilt current main. Both facts must remain visible in the PR. New provider/chat surfaces have no before state. Required visual inspection and integrated-result evidence remain release blockers until confirmed; no merge is authorized by this checkpoint.

Historical incident, not corrected away: the original session launched the existing `Medium_Phone_API_36.1` AVD with `-wipe-data`, possibly clearing pre-existing emulator-only data. No restoration is claimed. The physical phone was untouched. The continuation used only the separate `PhoneCloud2414` isolated AVD; this does not undo the original incident.
