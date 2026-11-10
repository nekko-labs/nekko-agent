---
title: iPhone and iPad permissions checklist
area: phone
---

# iPhone and iPad permissions checklist

Tracks [#2249](https://github.com/nekko-labs/nekko-agent/issues/2249).

## Intent and scope

The last new-user onboarding step, after pairing, walks through each system permission in a guided, themed checklist. The same page is available from **Settings → Device access → Permissions**, without interrupting existing users after an upgrade. The user chose a checklist only, no video. Nekko sits beside the title and reacts: she blinks while waiting, cheers when a row is allowed and looks startled at a denial. Her expression is decoration, never proof that access has been granted.

## Guided flow

- One row is open at a time, showing a one-line reason, the action, and **Not now**. Every other row is a single compact line: a status shape (empty circle, check, warning, dash) plus its title and, once settled, a short status word.
- Allowing a row animates its check, nudges the progress count (“2 of 8”) and opens the next unfinished row below it, wrapping to the top. **Not now** marks the row Skipped and moves on the same way. A denial keeps the row open with **Settings** and **Not now**, so recovery is one tap.
- Tapping any compact row opens it; rows already allowed show **Settings**. Rows fade in one after another on first appearance. With Reduce Motion on, rows and the mascot change state without movement.
- When every row is allowed, skipped or unavailable, the title becomes “All set”, Nekko stays happy and Continue reads Done. Skipping is remembered only for this visit.
- Copy is one short line per row. The footer says nothing is required, that picking photos and files needs no library access, and where to find Nekko Agent if Settings opens its home page.

Connection and alerts come first: notifications (approvals, questions, replies and failures) and local-network discovery. Optional tools follow: Live Activities, camera pairing, microphone, speech recognition, device authentication and add-only Photos saving. Picking photos and files needs no blanket library or storage permission. Needs-you alerts use notification authorization; they are not another system permission. There is no request for Bluetooth, tracking, location, contacts, full photo-library access or an invented background-running permission.

## Acceptance criteria and privacy

- Nothing is requested on page appearance. Each actionable row requests only its stated access after a deliberate tap. Prompts are serialized, not stacked.
- A checkmark represents actual system authorization, or successful device authentication. Device authentication checks do not enable or disable App lock. Available authentication hardware alone is not a successful check.
- Denied access links to system Settings. If the OS opens Settings home, the page explains how to find Nekko Agent (under Apps on newer iOS versions). Restricted and unavailable capabilities cannot be requested. Quiet/provisional notification authorization is distinguished from normal alerts.
- Live Activities reports the system setting and links to Settings, never starts a dummy activity to manufacture a prompt. The app's separate Live Activity content controls still apply.
- Local-network discovery uses the existing bounded Bonjour browser. No pairing or automatic connections result. Because iOS has no public authorization getter, an empty result is **not checked**, not success or denial; the explanation names visibility and Settings as next checks. A discovered service verifies access only for the current check; leaving the screen/background clears that evidence.
- Microphone access never starts a recording. Speech requests never start recognition or send audio anywhere. Dictation still requires language/on-device support at use time. Photos access is add-only and does not read or save anything during onboarding.
- Returning to the foreground refreshes authorization from the OS, including microphone capture authorization and restricted access. Leaving the screen stops discovery and cancels its task. Continue finishes onboarding even with no optional access granted. Finishing refreshes notification enrollment; computer/relay availability and system alert preferences still control delivery.
- iPhone, iPad, split-view widths and large accessibility text use scrolling cards with wrapping descriptions and a pinned Continue control. Status is text plus an icon, not color alone. The existing palette supplies the theme, not hard-coded colors.

## Implementation and verification status

Implemented in the task branch: permission reader/request coordinator, reusable checklist, onboarding replacement and Settings entry point. Native unit and onboarding UI tests cover the inventory and status rules. The real system Settings microphone recovery test taps the trailing switch (the label area is inert on iOS 26) and waits for both the OS toggle and the checklist to report access. Build, test and inspected simulator evidence results are recorded in the linked PR; physical hardware, real local-network authorization, authentication hardware and APNs delivery must not be claimed from simulator-only checks. English source strings use the native localization APIs; new translations have not been supplied.

Android parity is planned in [#2251](https://github.com/nekko-labs/nekko-agent/issues/2251), with the gap recorded in [phone parity](ios-and-android-stay-in-step.md).

## Strict Settings-return evidence (implemented harness, native result pending)

The opt-in `PermissionReturnTimingTests` comparison drives the baseline inline card
and current accordion by their actual AX capability. Setup requires the full target
frame inside the scroll viewport and above the pinned Continue footer, not merely
XCTest isHittable; target geometry and a pre-request screenshot are retained. The
first native baseline run compiled but tapped below the visible microphone control
and failed before denial, so it supplied no Settings-return measurement. This
visibility repair still requires native verification. Both perform a real microphone
denial and public Settings switch change from 0 to 1. Both then call `app.activate()`
without a process-state-dependent launch branch. A monotonic ten-second budget
starts before activation and includes activation/session setup and the first AX
predicate that requires both the status element and Allowed. Screenshots, full AX
and timing attachments are collected only after the timed assertion. The manual
mode-evidence workflow retains a recording for this test on each disposable phone.

Source regressions cannot certify native timing. A completed comparison must be
inspected for exact app/harness/device/runtime identities, actual return actions,
process state and timing on both revisions. Different observed process paths do not
prove symmetric foreground refresh, even with the same requested action. A timeout
or return-process failure remains a failure; no deadline, permission or startup
waiver is implied. Existing native suites and their assertions remain unchanged.
