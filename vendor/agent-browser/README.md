# Maintained inherited-stdio build

Pinned source and license: see `pin.json` and `LICENSE` (upstream Apache-2.0).

Build: `node scripts/build-agent-browser.mjs`. Test: `node --test scripts/agent-browser-native.test.mjs`.

The script fetches the exact revision into ignored `.scratch`, refuses dirty upstream or unknown build-source changes, applies `stdio.patch`, verifies its exact diff and duplicated entrypoint, and runs Cargo with `--locked --release`. Rust/MSVC and network access for pinned Cargo dependencies are prerequisites on Windows. This is source/dependency reproducibility, not a claim of bit-identical binaries across toolchains. Windows x64 Rust 1.96.0 has been tested; macOS/Linux/arm64, signing and installer inclusion remain unverified. Generated executables are build outputs, not source assets.

The only binary target is `nekko_main.rs`; upstream CLI main and native daemon module are not compiled. No MCP, dashboard or daemon entrypoint is called. `DaemonState::new` initializes stream/dashboard state to absent, and the command allowlist rejects stream, inspect, plugins, batches, providers and filesystem actions. Implicit local browser launch is rejected before upstream dispatch. Explicit launch requires external CDP. All upstream environment settings are removed before state creation. The parent sends a random 32-byte capability in the first inherited stdin hello and every request, never in argv/environment; invalid authentication/framing exits closed. Stdout is bounded newline JSON; diagnostics go to stderr. No artifacts were created during IPC negative tests.

Integration is experimental. The per-tab relay uses a separate random capability delivered only through inherited stdin as the launch URL, rejects browser Origin headers, accepts one connection, and restricts discovery/attachment to the adopted tab through AgentCdpTransport. The native executable has no listener. The relay intentionally has an authenticated loopback listener, not Electron remote debugging. Production default remains Playwright until parity and release gates pass. Additional relay negative tests and complete reachable-launch-path audit remain required.
