//! Whether someone is using this computer (`activity:state`), for automations
//! that run in the background: the machine's input, power and heat
//! (`nekko-machine`'s `activity.rs`), and the one signal only the daemon has,
//! a chat a person started replying here (admission.rs counts them).

use crate::routes::Ctx;
use nekko_machine::activity::{self, Activity};
use serde_json::Value;

pub const CHANNELS: &[&str] = &["activity:state", "activity:fullscreen"];

/// The signals now, judged against `idle_after` seconds.
pub async fn state(ctx: &Ctx, idle_after: f64) -> Activity {
    let readings = ctx.machine.activity().await;
    let chat = ctx.admission.attended_running();
    activity::assess(&readings, chat, idle_after)
}

/// `activity:state({ idleAfterSeconds }?)`: the threshold given, else the
/// automations' (`automationIdleMinutes`).
pub async fn route(ctx: &Ctx, channel: &str, args: &[Value]) -> Result<Value, String> {
    match channel {
        "activity:state" => {
            let given = args.first().and_then(|o| o.get("idleAfterSeconds")).and_then(Value::as_f64);
            let idle_after = match given.filter(|s| s.is_finite() && *s > 0.0) {
                Some(s) => s,
                None => nekko_automation::run_policy::idle_after_secs(&crate::settings::current(ctx).await),
            };
            serde_json::to_value(state(ctx, idle_after).await).map_err(|e| e.to_string())
        }
        // Whether a full-screen app is in front (a game, say): the desktop app
        // holds its notices and leaves the foreground alone while it is.
        // Never which app.
        "activity:fullscreen" => {
            let fg = nekko_machine::fullscreen::foreground();
            Ok(serde_json::json!({ "quiet": fg.quiet(), "state": fg.name() }))
        }
        other => Err(format!("{other} is not an activity channel")),
    }
}
