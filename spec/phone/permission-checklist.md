---
title: iPhone and iPad permissions checklist
area: phone
---

# iPhone and iPad permissions checklist

Tracks [#2249](https://github.com/nekko-labs/nekko-agent/issues/2249).

## Intent and scope

The last new-user onboarding step, after pairing, explains each system permission in a themed checklist. The same page is available from **Settings → Device access → Permissions**, without interrupting existing users after an upgrade. The user chose a checklist only, no video. A happy Nekko appears beside the introduction; her expression is not proof that access has been granted.

Connection and alerts come first: notifications (approvals, questions, replies and failures) and local-network discovery. Optional tools follow: Live Activities, camera pairing, microphone, speech recognition, device authentication and add-only Photos saving. Picking photos and files needs no blanket library or storage permission. Needs-you alerts use notification authorization; they are not another system permission. There is no request for Bluetooth, tracking, location, contacts, full photo-library access or an invented background-running permission.

## Acceptance criteria and privacy

- Nothing is requested on page appearance. Each actionable row requests only its stated access after a deliberate tap. Prompts are serialized, not stacked.
- A checkmark represents actual system authorization, or successful device authentication. Device authentication checks do not enable or disable App lock. Available authentication hardware alone is not a successful check.
- Denied access links to system Settings. Restricted and unavailable capabilities cannot be requested. Quiet/provisional notification authorization is distinguished from normal alerts.
- Live Activities reports the system setting and links to Settings, never starts a dummy activity to manufacture a prompt. The app's separate Live Activity content controls still apply.
- Local-network discovery uses the existing bounded Bonjour browser. No pairing or automatic connections result. Because iOS has no public authorization getter, an empty result is **not checked**, not success or denial; the explanation names visibility and Settings as next checks. A discovered service verifies access only for the current check; leaving the screen/background clears that evidence.
- Microphone access never starts a recording. Speech requests never start recognition or send audio anywhere. Dictation still requires language/on-device support at use time. Photos access is add-only and does not read or save anything during onboarding.
- Returning to the foreground refreshes authorization from the OS. Leaving the screen stops discovery and cancels its task. Continue finishes onboarding even with no optional access granted. Finishing refreshes notification enrollment; computer/relay availability and system alert preferences still control delivery.
- iPhone, iPad, split-view widths and large accessibility text use scrolling cards with wrapping descriptions and a pinned Continue control. Status is text plus an icon, not color alone. The existing palette supplies the theme, not hard-coded colors.

## Implementation and verification status

Implemented in this foundation layer: permission reader/request coordinator and focused native unit tests for capture status, checks, inventory and request cancellation. The reusable checklist, onboarding replacement, Settings entry point and native UI tests are planned in the next stack layer. Build, test and inspected simulator evidence results are recorded in the linked PR; physical hardware, real local-network authorization, authentication hardware and APNs delivery must not be claimed from simulator-only checks. English source strings use the native localization APIs; new translations have not been supplied.

Android parity is planned in [#2251](https://github.com/nekko-labs/nekko-agent/issues/2251), with the gap recorded in [phone parity](ios-and-android-stay-in-step.md).
