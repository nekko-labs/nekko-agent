# Disposable native notification setup

The old `.shots/native-old-artifacts/toast-uia.json` records `Notifications No new notifications (Do not disturb on)`. DND suppression is an evidenced prerequisite failure, not evidence of missing unpackaged app identity.

The native fixture now calls the PowerShell `setup` action before constructing/sending its notification. All independent launcher, Electron sandbox, and PowerShell gates remain mandatory: exact CI/GitHub Actions/Windows/github-hosted values, explicit disposable-desktop opt-in, and run/workspace identifiers. Do not run the desktop helper locally, spoof those gates, or use a self-hosted runner. The helper changes only the disposable hosted runner's OS state; no normal local app or user OS configuration is involved.

Setup invokes the notification center's UIA tray control, reads an explicit DND TogglePattern state (or an explicit `Turn on/off do not disturb` action label), and disables DND only if it is on. It requires an explicit off state, closes the panel, and rejects a tray label reporting DND on again. Unsupported, noninteractive, ambiguous, or unknown controls fail closed rather than sending a toast. No registry guesses, identity registration, or local fallback are added.

Evidence in `notification-native-results/`:

- `setup-before/after-uia.json` and `setup-before/after.png`: desktop around setup.
- `setup-center-before/after-uia.json` and matching PNGs: open notification center before/after the change.
- `setup-state-before/after.json`: observed DND state, source, and DND delivery prerequisite assertion.
- `setup-blocker.txt` and failure screenshot if setup fails.
- `results.json` records successful setup separately from actual OS delivery.

`deliveryAllowed` means the DND prerequisite passed, not proof that every Windows policy or per-app setting allows delivery. Existing visible unique-toast UIA evidence, OS click, Electron click callback, and OS foreground assertions are still required. Hosted image/UIA names and patterns are unverified until the workflow runs; unsupported images remain a blocker. The fixture is English-label dependent and is not installed-app identity/deep-link acceptance.

Local verification uses `node --test apps/desktop/scripts/notification-native-ci.test.cjs apps/desktop/scripts/notification-integration-safety.test.cjs`, JavaScript syntax checks, and PowerShell Parser.ParseFile only. Mocked orchestration tests prove failed setup prevents notification construction; they do not prove native UIA behavior.

Next CI run: inspect matching setup screenshots/state and toast evidence. If DND is explicitly off but delivery still fails, investigate the actual Electron failure event/UIA/logs for identity or other causes. Do not infer absent unpackaged identity from the old DND-on artifact. This setup changes verification infrastructure only, not product behavior; no product spec change is needed. No hosted run, commit, or push is performed in this local-only task.
