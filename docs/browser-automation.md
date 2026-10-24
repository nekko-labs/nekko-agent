# Browser automation

## Dedicated browser

The desktop `browser` tool opens hidden, sandboxed Electron Chromium windows owned by the current chat, never your personal browser. Each chat has a separate in-memory session and up to eight tabs. Every browser action goes through Nekko's existing approval policy. Explicit visibility shows the owned window without activating it.

Navigate HTTP(S), inspect, click/fill the first match, type, press keys/chords, wait for content, scroll, extract text/links, evaluate page JavaScript, screenshot, manage tabs, read logs and take a snapshot.

A **snapshot** lists what the agent can act on: the page's links, buttons, fields and other interactive elements, one per line, each with a short ref such as `@e3`. The agent can then click `@e3` or fill `@e5` instead of guessing a CSS selector or writing a script to find the field. Pass a CSS selector to snapshot only part of the page. Refs belong to the page as it was; after the page changes, the agent takes a new snapshot. Approved screenshots go to the selected model. Evaluation runs in the page, not the app; pages can see text you enter.

Popups, downloads, JavaScript dialogs and device permissions are blocked. Local file navigation/uploads are blocked. Idle hidden sessions close after ten minutes. Requires a local desktop chat, not web/server/CLI or sandboxed execution.

## Native default (2026-10-17, release verification incomplete)

The default now uses pinned native Rust agent-browser 0.39.1 against Electron's existing Chromium. No extra browser download or global driver. Each adopted tab has a native process and a single-client authenticated loopback CDP relay restricted to its Electron debugger. There is no app-wide remote debugging port and no silent Playwright fallback. Missing native resources produce an explicit error.

The unmodified upstream Windows command daemon is unsafe for this boundary: it accepts unauthenticated TCP commands, and MCP stdio delegates to it. The user selected a maintained patch instead. Its only binary entrypoint uses inherited stdin/stdout, authenticates every command using a random capability delivered on inherited stdin, rejects all argv, clears upstream configuration and denies implicit browser launch and extra entrypoints. The CDP relay's distinct capability is also delivered privately on inherited stdin, not environment/argv.

Build the exact patch with `node scripts/build-agent-browser.mjs` (Rust toolchain and native linker required). Dist/release call this builder and package the native binary, license and pin outside asar. Source/dependency pinning is verified, not bit-identical output across toolchains. Windows x64 has been tested; installer/signing and macOS/Linux/arm64 remain unverified.

## Speed (2026-10-18)

A hidden window that has gone idle renders only about one frame a second, so clicks used to wait about a second and screenshots about two. The browser now keeps the hidden window's frames coming for just the duration of a click or screenshot; the window stays hidden. On a sample signup task (open the page, find the form, fill it, submit, check the result, take a screenshot) a new chat's browser finished in about half a second instead of about three and a third, on Windows. Opening the browser itself takes about 60 ms. A chat that keeps its browser open skips that and reuses the page cache. See [performance history](perf-history.md) and the [benchmark report](../reports/agent-browser/flow-benchmark.md).

## Checks and evidence

- `node --test scripts/agent-browser-native.test.mjs`: native framing/auth/argv/no-listener security.
- `node scripts/agent-browser-native-smoke.mjs [outDir]`: isolated hidden Electron native action/security fixture plus 20 cold-chat and 20 warm-inspect samples. Set `NEKKO_SMOKE_ELECTRON` to a matching owned Electron executable when needed.
- `apps/desktop/src/main/agentNativeRelay.test.ts`: wrong/missing auth, Origin, second-client and owned-target negative checks.
- `apps/desktop/src/main/agentCdpTransport.test.ts`, `agentBrowserActions.test.ts`, `agentBrowser.test.ts`: transport/page/bridge behavior.
- `node scripts/agent-browser-flow-benchmark.mjs [out.json] [--rounds 20] [--launches 12] [--drivers native,native-nowake,playwright]`: whole-task benchmark (navigate, locate, fill, submit, verify, screenshot) through the real bridge in hidden Electron, with first-in-process, fresh-chat and warm-session scenarios, tool calls, retries, reply bytes and startup phase timings. A `-nowake` driver runs without the hidden-frame wake.
- `scripts/agent-browser-benchmark.mjs`: explicit Playwright baseline-only helper; not the production default.
- `scripts/perf/lib/browser.mjs`: existing separate renderer-performance helper, not yet migrated by this task.

Full workspace typecheck/build and all 1362 desktop tests pass. Native fixture covers four wait states, duplicate-selector first match, keyboard submission, extraction, logs/page errors, tabs and popup/dialog/permission/file-navigation boundaries. Matching screenshot dimensions are 1359x873; parent actual-pixel review and public evidence publication are pending. All 956 host tests pass with explicit worktree-owned debug daemon (1 skipped); Rust browser/capture golden parity passes. Alternating benchmarks include native-child memory: cold navigation is slower, warm inspect slightly slower, working-set snapshots lower. This is a trade-off, not a speedup. Unpacked Windows native binary/license/pin hashes match staging; full signed installer and unrelated daemon resource staging remain unverified. See [performance history](perf-history.md), [raw baseline](../reports/agent-browser/playwright-baseline.json), [initial candidate](../reports/agent-browser/native-candidate-v2.json), [patch documentation](../vendor/agent-browser/README.md) and [original feasibility](../reports/agent-browser/feasibility.md).

## Continuing a PR after a reply

A settled chat with an open PR offers **Watch CI and merge when passing** below
reply status. Choose it to request a normal agent continuation that verifies the
PR and arms a durable watch while waiting. **Skip** dismisses that reply's offer
without starting background work. A registered watcher shows its PR and wake
deadline in chat; detailed watcher history remains in the transcript. This does
not bypass review requirements, approvals, draft blockers or merge protections.
