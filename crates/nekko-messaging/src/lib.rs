//! Inbound messaging channels for the engine daemon (PF14): a port of the TS
//! host's `packages/host/src/messaging` (Telegram first).
//!
//! Everything here is pure: the Bot API requests and replies
//! ([`telegram`]), `messaging-state.json` ([`state`]), the Auto model pick
//! the bridge uses ([`auto`]), and the bridge itself as a state machine with
//! no I/O ([`bridge::Bridge`]): inputs (settings, agent events, poll results,
//! timers, completions) go in, effects (Telegram calls, timers, chat turns,
//! approvals, state writes) come out. The daemon runs the effects
//! (crates/nekkod/src/messaging.rs); `tests/golden.rs` replays the TS
//! service's recorded script through the same machine.

pub mod auto;
pub mod bridge;
pub mod state;
pub mod telegram;

pub use bridge::{Bridge, Effect, TgCall};

use serde_json::Value;

/// `${v}` for a value that may be absent (`undefined`).
pub(crate) fn show(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(v) => nekko_js::display(v),
    }
}
