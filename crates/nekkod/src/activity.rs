//! Whether someone is using this computer (`activity:state`), for automations
//! that run in the background: the machine's input, power and heat
//! (`nekko-machine`'s `activity.rs`), and the one signal only the daemon has,
//! a chat a person started replying here (admission.rs counts them).

use crate::routes::Ctx;
use nekko_machine::activity::{self, Activity};
use serde_json::Value;

pub const CHANNELS: &[&str] = &["activity:state"];

/// The signals now, judged against the default idle threshold.
pub async fn state(ctx: &Ctx) -> Activity {
    let readings = ctx.machine.activity().await;
    let chat = ctx.admission.as_ref().is_some_and(|a| a.attended_running());
    activity::assess(&readings, chat, activity::IDLE_AFTER_SECS)
}

pub async fn route(ctx: &Ctx, channel: &str) -> Result<Value, String> {
    match channel {
        "activity:state" => serde_json::to_value(state(ctx).await).map_err(|e| e.to_string()),
        other => Err(format!("{other} is not an activity channel")),
    }
}
