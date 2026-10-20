//! The pure half of a chat turn, for the engine daemon (PF14, `chat:turn`),
//! ported from `packages/host/src/turn-plan.ts` and the shared helpers it
//! uses:
//!
//! - `plan`: the tools a turn offers and the system prompt it sends;
//! - `input`: how the user's input lands in the transcript, the post-turn
//!   title prompt and its cleaning, and the options a queued prompt runs with;
//! - `ask`: reading an `ask_user` call and writing back the answers;
//! - `plan_update`: `update_plan` on a chat's live plan;
//! - `stats`: a reply's totals, kept on its last message;
//! - `delegate`: what a `spawn_agent` child's run comes back as;
//! - `scope`: effort, MCP servers and connectors narrowed per chat;
//! - `side`: the suggested-replies and prompt-fill side calls;
//! - `variants`: compaction, image turns and starting a queued prompt at once.
//!
//! The tool specs and the fixed text a turn uses come from the TS sources
//! through `src/catalog.json`, which `turn-plan.golden.test.ts` writes and
//! checks; `tests/golden.rs` holds every function here to what the TS one
//! produced, key order included where the result is saved to a chat file.

pub mod ask;
pub mod catalog;
pub mod decide;
pub mod delegate;
pub mod input;
pub mod plan;
pub mod plan_update;
pub mod providers;
pub mod scope;
pub mod side;
pub mod stats;
pub mod variants;
pub mod workflow_access;

pub use ask::{format_ask_answers, parse_ask_request};
pub use input::{apply_turn_input, clean_title, send_options_for_queued_item, title_prompt};
pub use plan::{host_tool_approval, turn_can_ask, turn_system_prompt, turn_tools};
pub use plan_update::{PlanOutcome, apply_plan_update, plan_echo};
pub use scope::{chat_connectors, chat_effort, chat_mcp_tools};
pub use side::{clean_fill, fill_prompt, parse_reply_suggestions, suggest_prompt};
pub use stats::{TurnStats, attach_turn_stats};

use serde_json::{Value, json};

/// A JavaScript number as JSON: whole numbers as integers, as `JSON.stringify` prints them.
pub fn num(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9.0e15 { json!(n as i64) } else { json!(n) }
}

/// The value at `key` if it is a non-empty string after nothing at all (JS truthiness of a string field).
pub(crate) fn truthy(v: &Value, key: &str) -> bool {
    nekko_js::truthy(v.get(key))
}

/// `s.toLowerCase()`.
pub(crate) fn lower(s: &str) -> String {
    s.to_lowercase()
}
