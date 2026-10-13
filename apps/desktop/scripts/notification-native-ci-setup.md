# Disposable native notification setup

The old `.shots/native-old-artifacts/toast-uia.json` records `Notifications No new notifications (Do not disturb on)`. DND suppression is an evidenced prerequisite failure, not evidence of missing unpackaged app identity.

The native fixture now calls the PowerShell `setup` action before constructing/sending its notification. All independent launcher, Electron sandbox, and PowerShell gates remain mandatory: exact CI/GitHub Actions/Windows/github-hosted values, explicit disposable-desktop opt-in, and run/workspace identifiers. Do not run the desktop helper locally, spoof those gates, or use a self-hosted runner. The helper changes only the disposable hosted runner's OS state; no normal local app or user OS configuration is involved.

Setup attempts the notification center's UIA tray InvokePattern, but does not treat a returned call as proof of opening. It polls for an explicit DND control for up to five seconds. Unsupported/failed invoke or a timeout falls back to a real OS mouse click on the disposable desktop only: reacquire the uniquely identified tray button, require enabled/visible positive bounds wholly inside the virtual screen, and verify the center-point UIA hit is that button or its descendant before clicking. It then polls for another five seconds and fails closed if no explicit DND control appears. No Win+N fallback, registry guesses, identity registration, or local fallback are added.

Once open, setup reads an explicit DND TogglePattern state (or an explicit `Turn on/off do not disturb` action label) and disables DND only if it is on. It polls through transiently absent controls, requires an explicit off state, closes via a verified tray click, waits for the DND control to disappear, and rejects a tray label reporting DND on again. Cleanup does not blindly toggle a center that never opened. A cleanup error is recorded separately so it does not replace an original setup failure. Unsupported, noninteractive, ambiguous, or unknown controls fail closed rather than sending a toast.

## Diagnosis of native run 38360444123

The provided `.shots/native-dnd-artifacts/notification-native-results/setup-before-uia.json` and `setup-center-before-uia.json` are byte-identical (11,413 bytes, SHA-256 `4fa48b14001f204825179e4720ff02e1b20ef0fd06fe4198cfb8657d9d0b20cd`). They expose only the taskbar notification entry, `Notifications No new notifications (Do not disturb on)`, at `984,720,28,48`, not an open notification center or explicit DND action/toggle. Session metadata reports interactive session 2. UIA also exposes a System Properties paging-file dialog; there is no evidence that it caused the invocation failure.

All four captured PNGs have 1024x768 IHDR dimensions. The setup-before and setup-center-before PNGs differ in bytes/hash (250,132 and 249,805 bytes respectively); that difference alone is not proof of an opened panel. These are metadata checks, not visual inspection of their pixels. The old helper unconditionally set `$opened = $true` immediately after InvokeElement and slept only 500 ms, then failed at DndControl. The logged failure is not the helper's unsupported-InvokePattern exception, so unsupported invocation cannot be claimed as the observed root cause. The demonstrated cause is an ineffective/unverified opening followed by a premature DND query. Old artifacts lack supported-pattern and invocation-result metadata to explain the shell provider's behavior more precisely. The fix records both and uses a verified mouse fallback, without weakening any independent CI gate.

Evidence in `notification-native-results/`:

- `setup-before/after-uia.json` and `setup-before/after.png`: desktop around setup.
- `setup-center-attempts.json`: invoke/fallback outcomes, verified mouse target coordinates, and observed control/close results.
- `setup-center-invoke/mouse-uia.json` and matching PNGs: evidence after each bounded open attempt, including failed attempts. UIA snapshots record supported patterns.
- `setup-center-before/after-uia.json` and matching PNGs: notification center with explicit DND control observed before/after the change.
- `*-capture.json`: PNG capture timestamp, virtual-screen origin/dimensions, foreground handle, and session ID. Capturing is not visual inspection.
- `setup-center-close-blocker.txt`: independent cleanup error, when present.
- `setup-state-before/after.json`: observed DND state, source, and DND delivery prerequisite assertion.
- `setup-blocker.txt` and failure screenshot if setup fails.
- `results.json` records successful setup separately from actual OS delivery.

`deliveryAllowed` means the DND prerequisite passed, not proof that every Windows policy or per-app setting allows delivery. Existing visible unique-toast UIA evidence, OS click, Electron click callback, and OS foreground assertions are still required. Hosted image/UIA names and patterns are unverified until the workflow runs; unsupported images remain a blocker. The fixture is English-label dependent and is not installed-app identity/deep-link acceptance.

Local verification uses `node --test apps/desktop/scripts/notification-native-ci.test.cjs apps/desktop/scripts/notification-integration-safety.test.cjs`, JavaScript syntax checks, and PowerShell Parser.ParseFile only. Mocked orchestration tests prove failed setup prevents notification construction; they do not prove native UIA behavior.

Next CI run: inspect matching setup screenshots/state and toast evidence. If DND is explicitly off but delivery still fails, investigate the actual Electron failure event/UIA/logs for identity or other causes. Do not infer absent unpackaged identity from the old DND-on artifact. This setup changes verification infrastructure only, not product behavior; no product spec change is needed. No hosted run, commit, or push is performed in this local-only task.
