# Browser automation

## Dedicated browser

The desktop `browser` tool opens hidden, sandboxed Electron Chromium windows owned by the current chat, never your personal browser. Each chat has a separate in-memory session and up to eight tabs. Every browser action goes through Nekko's existing approval policy. Explicit visibility shows the owned window without activating it.

Navigate HTTP(S), inspect, click/fill the first match, type, press keys/chords, wait for content, scroll, extract text/links, evaluate page JavaScript, screenshot, manage tabs and read logs. Approved screenshots go to the selected model. Evaluation runs in the page, not the app; pages can see text you enter.

Popups, downloads, JavaScript dialogs and device permissions are blocked. Local file navigation/uploads are blocked. Idle hidden sessions close after ten minutes. Requires a local desktop chat, not web/server/CLI or sandboxed execution.

## Native default (2026-10-17, release verification incomplete)

The default now uses pinned native Rust agent-browser 0.39.1 against Electron's existing Chromium. No extra browser download or global driver. Each adopted tab has a native process and a single-client authenticated loopback CDP relay restricted to its Electron debugger. There is no app-wide remote debugging port and no silent Playwright fallback. Missing native resources produce an explicit error.

The unmodified upstream Windows command daemon is unsafe for this boundary: it accepts unauthenticated TCP commands, and MCP stdio delegates to it. The user selected a maintained patch instead. Its only binary entrypoint uses inherited stdin/stdout, authenticates every command using a random capability delivered on inherited stdin, rejects all argv, clears upstream configuration and denies implicit browser launch and extra entrypoints. The CDP relay's distinct capability is also delivered privately on inherited stdin, not environment/argv.

Build the exact patch with `node scripts/build-agent-browser.mjs` (Rust toolchain and native linker required). Dist/release call this builder and package the native binary, license and pin outside asar. Source/dependency pinning is verified, not bit-identical output across toolchains. Windows x64 has been tested; installer/signing and macOS/Linux/arm64 remain unverified.

## Checks and evidence

- `node --test scripts/agent-browser-native.test.mjs`: native framing/auth/argv/no-listener security.
- `node scripts/agent-browser-native-smoke.mjs [outDir]`: isolated hidden Electron native action/security fixture plus 20 cold-chat and 20 warm-inspect samples. Set `NEKKO_SMOKE_ELECTRON` to a matching owned Electron executable when needed.
- `apps/desktop/src/main/agentNativeRelay.test.ts`: wrong/missing auth, Origin, second-client and owned-target negative checks.
- `apps/desktop/src/main/agentCdpTransport.test.ts`, `agentBrowserActions.test.ts`, `agentBrowser.test.ts`: transport/page/bridge behavior.
- `scripts/agent-browser-benchmark.mjs`: explicit Playwright baseline-only helper; not the production default.
- `scripts/perf/lib/browser.mjs`: existing separate renderer-performance helper, not yet migrated by this task.

Full workspace typecheck/build and all 1362 desktop tests pass. Native fixture covers four wait states, duplicate-selector first match, keyboard submission, extraction, logs/page errors, tabs and popup/dialog/permission/file-navigation boundaries. Matching screenshot dimensions are 1359x873; parent actual-pixel review and public evidence publication are pending. All 956 host tests pass with explicit worktree-owned debug daemon (1 skipped); Rust browser/capture golden parity passes. Alternating benchmarks include native-child memory: cold navigation is slower, warm inspect slightly slower, working-set snapshots lower. This is a trade-off, not a speedup. Unpacked Windows native binary/license/pin hashes match staging; full signed installer and unrelated daemon resource staging remain unverified. See [performance history](https://github.com/nekko-labs/nekko-agent/blob/main/docs/perf-history.md), [raw baseline](https://github.com/nekko-labs/nekko-agent/blob/main/reports/agent-browser/playwright-baseline.json), [initial candidate](https://github.com/nekko-labs/nekko-agent/blob/main/reports/agent-browser/native-candidate-v2.json), [patch documentation](https://github.com/nekko-labs/nekko-agent/blob/main/vendor/agent-browser/README.md) and [original feasibility](https://github.com/nekko-labs/nekko-agent/blob/main/reports/agent-browser/feasibility.md).
