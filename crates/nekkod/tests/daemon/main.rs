//! End to end: the real `nekkod` binary, exercised over HTTP and both sockets.
//!
//! One test binary with a module per domain, not a binary per file: `cargo test`
//! runs test binaries one after another, so splitting them would add up each
//! file's slowest test instead of running all of them at once.

#[path = "../common/mod.rs"]
mod common;

mod assist;
mod automation;
mod backendless;
mod claude_code;
mod claude_policy;
mod desktop;
mod engine;
mod git;
mod native;
mod remote;
mod sandbox;
mod sessions;
mod settings;
mod tools;
mod turns;
mod wire;

/// Not a test of its own: with the env var set, this process is a fake `claude -p`.
#[test]
fn fake_claude() {
    claude_code::fake_claude();
}
