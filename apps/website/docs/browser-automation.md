# Browser automation

## Current dedicated browser

The desktop `browser` tool opens a hidden, sandboxed Chromium window owned by the current chat. It does not attach to your personal browser. Each chat has a separate in-memory session and up to eight tabs. Every browser action goes through Nekko's approval policy. Explicit visibility shows the owned window without activating it.

You can navigate HTTP(S) pages, inspect text, click or fill the first matching element, type, press keys, wait for content, scroll, extract text or links, evaluate page JavaScript, take screenshots, manage tabs and read logs. Screenshots are sent to the selected model when approved. Evaluation runs in the page, not in the app; pages can see text you enter.

Popups, downloads, JavaScript dialogs and device permissions are blocked. Local file navigation and uploads are blocked. Idle hidden sessions close after ten minutes. Browser control requires a local desktop chat; this dedicated browser is not supplied by web/server/CLI or sandboxed execution.

## Native agent-browser migration status

**Not migrated (2026-10-17).** Dedicated mode still requires pinned `playwright-core@1.63.0`, driving Electron's own Chromium through a per-chat in-process CDP transport without an app debugging port. This is an explicit security limitation, not a silent fallback.

Vercel `agent-browser@0.39.1` was evaluated as the native Rust/Chrome replacement. Its Windows daemon accepts unauthenticated commands over a loopback TCP socket. That would create a second action entry point outside Nekko's approvals. Random session names and a token-protected CDP relay do not protect that command socket. MCP stdio uses the same daemon.

Do not install a global browser driver, enable Electron remote debugging, attach a user browser or replace the default with raw CLI commands to work around this blocker. Native migration requires authenticated/private command IPC first, followed by security and behavior parity tests and matched before/after measurements. No performance comparison has been established.

## Testing and diagnostics

Existing checks remain at their actual paths:

- `apps/desktop/scripts/browser-automation-smoke.mjs`: dedicated Electron browser behavior/security smoke.
- `apps/desktop/src/main/agentCdpTransport.test.ts`: CDP policy and owned-target tests.
- `apps/desktop/src/main/agentBrowserActions.test.ts`: page-action behavior.
- `apps/desktop/src/main/agentBrowser.test.ts`: private bridge behavior.
- `scripts/perf/lib/browser.mjs`: owned Chromium helper for the existing performance harness.
- `scripts/agent-browser-ipc-probe.mjs`: Windows-only native daemon authentication diagnostic; it does not launch a browser or switch defaults.

See the [feasibility report](https://github.com/nekko-labs/nekko-agent/blob/main/reports/agent-browser/feasibility.md) for immutable upstream sources, exact executable provenance, raw probe output, safe reproduction commands and the implementation/measurement acceptance criteria. The separate E2E worktree has not been changed by this investigation.
