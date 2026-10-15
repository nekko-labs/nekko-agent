# Capture diagnostic — 2026-10-16

## Proven
- In-app native capture still returns Chromium NotReadableError for an isolated visible fixture window. `windowCapture.ts` maps it to a generic OS refusal string, losing the original message.
- A fresh isolated Electron 44.7.0 / Chromium 152 process successfully acquires window streams with hidden and visible recorders.
- Bundling and invoking the current production windowCapture.ts in that fresh process succeeds: 608×452 PNG from its own synthetic target.
- Windows HKCU graphicsCaptureProgrammatic consent reads Allow (read-only inspection).
- Source enumeration logs WGC CreateForWindow HRESULT -2147024891 (0x80070005, access denied) for some enumerated sources, even when the synthetic target subsequently captures successfully. These logs alone do not identify the failing tool target.
- Browser screenshot timeouts are a separate Playwright page-screenshot path; some returned successfully on a subsequent attempt. No proven shared cause.

## Not proven
No evidence yet attributes the failure to a specific Windows update, GPU driver, Electron regression, protected window, user permission change, or the recorder's hidden state. Fresh-process self-capture differs from long-running-app cross-process capture; this distinction must be tested next.

## Next distinct experiment
Keep a fresh synthetic target alive and capture it from another fresh isolated process using production code, then compare with the running app. If fresh cross-process capture succeeds while in-app capture fails, inspect the app's capture partition, handlers and runtime flags; restarting the user-owned app requires user coordination and is not performed here. Preserve original DOMException diagnostics in a separate capture fix rather than guessing or weakening window-only permissions.

## Artifacts
Raw local report: `.shots/capture-diagnostic/report.json`. Production PNG: `.shots/capture-diagnostic/production.png`. Neither is claimed as inspected visual implementation evidence.
