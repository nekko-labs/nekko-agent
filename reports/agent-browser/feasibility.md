# Native agent-browser default: blocked feasibility review

Date: 2026-10-17. Nekko base: `2f81bfc0`. No runtime migration was made.

## Finding

The exact current npm candidate is **agent-browser@0.39.1**, native Rust with direct CDP, Chrome engine, not the former Node daemon or Lightpanda. Its Windows command daemon exposes an unauthenticated TCP endpoint. This is incompatible with Nekko's requirement that its private, approved browser bridge be the only action entry point. **Do not change the default yet.** `playwright-core@1.63.0` remains required for dedicated mode, not merely a benchmark dependency.

This finding concerns embedding the daemon under Nekko's stronger same-user shell threat model. It is not a claim that upstream promises that boundary or that Nekko currently exposes this endpoint.

## Exact provenance

| Item | Value |
|---|---|
| npm version | `0.39.1` |
| npm tarball SHA-1 | `e91bd81d4c4e80788fcdd1b2366f82f42dfd5ff9` |
| npm integrity | `sha512-0zdIq0v2r9Gio7K5wIe/e2W9nyLoVC6tUGpGV+btuynBQT9aCgOk5IEIyK+6OtfKRzQjp96DQ/3akBqxccigTQ==` |
| Windows x64 executable SHA-256 | `af1ff5f2afd5c187fb50ac3bbc1e7114baadc180d67cef63f644af9031be5049` |
| Release source tag | `1165952d74ceed98fdc2dd97190ad41f44dd0e24` (`v0.39.1`) |
| Upstream main checked | `dac13bb87468fe9d74a040d862720f6cc17a9565` |
| Local Node / platform | `v24.1.0` / `win32` |
| Required Node | `>=24.0.0` (Nekko currently advertises `>=22.12.0`) |

Registry: <https://registry.npmjs.org/agent-browser/0.39.1>. The package includes native binaries; it was packed with `--ignore-scripts`, not installed globally or added to dependencies. No user browser was attached.

## Source findings

All source links are immutable release-tag revisions. `git diff` of the following command IPC implementation files against the main revision above was empty.

- [daemon.rs](https://github.com/vercel-labs/agent-browser/blob/1165952d74ceed98fdc2dd97190ad41f44dd0e24/cli/src/native/daemon.rs#L353-L420): Windows binds `127.0.0.1`, tries a session-derived port then an ephemeral port, writes a `.port` file and accepts clients. A random session or private socket directory is not TCP authentication.
- [daemon.rs handler](https://github.com/vercel-labs/agent-browser/blob/1165952d74ceed98fdc2dd97190ad41f44dd0e24/cli/src/native/daemon.rs#L535-L586): reads newline JSON and calls `execute_command` without checking a client capability. The HTTP-line rejection is not client authentication.
- [connection.rs](https://github.com/vercel-labs/agent-browser/blob/1165952d74ceed98fdc2dd97190ad41f44dd0e24/cli/src/connection.rs#L365-L418): namespace/session hashes and `.port` discovery are routing, not authorization.
- [mcp.rs](https://github.com/vercel-labs/agent-browser/blob/1165952d74ceed98fdc2dd97190ad41f44dd0e24/cli/src/mcp.rs#L1-L9): stdio MCP delegates to the CLI and same daemon. It does not remove the socket.
- [browser.rs](https://github.com/vercel-labs/agent-browser/blob/1165952d74ceed98fdc2dd97190ad41f44dd0e24/cli/src/native/browser.rs#L698-L866): external CDP supports WebSocket connections and headers; initial discovery uses `Target.setDiscoverTargets`, `Target.getTargets`, `Target.attachToTarget`. Nekko currently rejects these. A narrowly scoped relay could implement chat-owned discovery, but is not a drop-in adapter.
- [browser.rs close](https://github.com/vercel-labs/agent-browser/blob/1165952d74ceed98fdc2dd97190ad41f44dd0e24/cli/src/native/browser.rs#L1379-L1391): attached external browsers are disconnected rather than closed. Nekko would still need to own Electron tab creation/destruction and detach before destroy.

## Minimal dynamic evidence

[Raw isolated result](daemon-auth-probe-isolated.json) and [initial result](daemon-auth-probe.json) both show an independent TCP client receiving `success: true` for `session_info` without authentication. The isolated reproduction verifies the daemon PID, session, socket directory and `browserLaunched: false`, then ends only its owned process tree and removes its temporary directory. It strips inherited browser/provider settings. No Chrome/Electron window, profile or user app was launched. This proves command acceptance, not an executed malicious browser action. Source review establishes that the same handler dispatches browser actions.

Reproduce from the task worktree on Windows, with Node 24 and npm:

```sh
npm pack agent-browser@0.39.1 --ignore-scripts --pack-destination .scratch
tar -xf .scratch/agent-browser-0.39.1.tgz -C .scratch
node scripts/agent-browser-ipc-probe.mjs .scratch/package/bin/agent-browser-win32-x64.exe .scratch/new-probe.json
```

The probe rejects an unexpected executable digest and refuses to overwrite evidence. It deliberately never requests launch, navigation, evaluation or attachment. `.scratch` is ignored. Output includes ephemeral PID/path values, not user browser data.

## Why the proposed alternatives do not unblock this release

| Approach | Assessment |
|---|---|
| Authenticated loopback CDP relay over `AgentCdpTransport` | Plausible CDP boundary, but the native command socket remains a second unauthenticated way to invoke page actions. |
| Random namespace, session, port or private profile | Isolation of storage/lifecycle, not caller authentication. Local shell processes can connect to TCP ports. |
| MCP stdio | Still starts the same daemon. |
| Action policy / confirmation categories | Action filtering is not caller identity; Nekko and an untrusted client use the same action names. A broker-bound per-request capability is needed. |
| Separate app-owned headless Chrome | Still exposes daemon command IPC; additionally requires proof of permissions, visibility, dialog/download and lifecycle parity. |
| Node wrapper around arbitrary CLI strings | Not an approved integration; both argument control and IPC bypass remain concerns. |

## Exact unblock and follow-on implementation

1. Upstream or an explicitly maintained native patch must provide private inherited stdio/pipe IPC with no listener, or authenticated command IPC whose capability arrives through a private inherited channel, not shell-visible environment or command arguments. On Windows an owner-bound private pipe with appropriate access control plus capability validation is another option. The daemon's dashboard/stream surfaces also need a complete entry-point audit. A same-user ACL alone does not distinguish agent shell commands.
2. Add negative tests: missing/wrong capabilities never reach execution, a second client cannot drive a session, renderer-origin requests are rejected, no unowned daemon is attached, cleanup ends only owned process trees. Then rerun the probe against the fixed candidate.
3. Build a capability-authenticated per-chat CDP relay with owned-only target discovery/attachment. Keep `AgentCdpTransport` page policy, no Electron debugging switch, no UI targets, popup/dialog/download/permission blocks, hidden non-focusable ownership, tab caps, timeouts and detach-before-destroy.
4. Replace the Playwright `Page` action interface with a typed bounded native command adapter, including first-match selector behavior, keyboard chords, all four wait states, fresh screenshots, per-tab logs, tab selection and cleanup. Do not fall back silently to Playwright.
5. Before implementation, capture baseline with unchanged Electron Chromium, exact 1100x760 viewport/content dimensions, synthetic fixture, fixed theme and revision. Alternate base/candidate for at least 20 cold and 20 warm samples each where practical. Save all raw timings, percentiles, process memory and provenance. Measure any separate Chrome revision as a separate experiment, not a driver-only comparison.
6. Run security/action tests, full typecheck/build and relevant host/daemon suites. Schema parity is required only if schemas change. Capture matching hidden before/after pixels and interaction evidence, publish through `scripts/pr-media.mjs`, and obtain parent actual-pixel signoff before landing behavioral changes.
7. Coordinate default testing scripts with the separate `e2e-playwright` task. That worktree was listed but not modified. No workflow has been renamed to imply an unimplemented migration.

## Performance and verification limitations

No baseline or candidate browser timings, memory numbers, screenshots or visual comparisons were collected. No performance gain, regression or null effect is established. This is an **unmeasured blocked migration**, not a completed benchmark. Existing testing/perf helpers remain unchanged. Full app build/typecheck and host/daemon suites are not evidence for a migration that was not implemented. Native browser feature parity, packaging, macOS/Linux, stream authentication and hidden external-Chrome lifecycle remain unverified.

The release blocker is specific: native Windows command IPC lacks caller authentication. Parent review can choose an upstream contribution or an explicitly maintained fork/patch, but cannot make the current listener meet Nekko's boundary by approving it away.
