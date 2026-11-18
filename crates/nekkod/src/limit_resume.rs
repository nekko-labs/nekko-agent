//! Carrying a chat on by itself when the usage limit that stopped it resets (#2811).
//!
//! A reply that fails on a used-up plan or rate limit leaves a Reply failed
//! notice; when the reset time is known it offers **Continue at <time>**.
//! Pressing it saves `turnFailure.continueAt` (epoch ms). This arms a timer for
//! it, re-arms every saved one when the daemon starts, and a minute after the
//! reset resumes the chat the way Retry does, posting a `limit_reset` event the
//! desktop shows as a reminder.
//!
//! The user asked for this run, so it is theirs, only delayed (Philip,
//! 2026-11-15): not `unattended`, counted as user usage, and allowed on a
//! Claude plan, unlike automations and the context auto-continue.
//!
//! The schedule lives on the failure, so whatever retires the failure retires
//! it too: a new turn, Dismiss, or Cancel. The timer re-reads the chat before
//! it acts and does nothing unless the same schedule is still there.

use crate::routes::Ctx;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// How long after the reset the chat continues: a reset time is printed to
/// the minute, and the provider's clock is not ours.
pub const AFTER_RESET_MS: u64 = 60_000;
/// How often a waiting timer checks the wall clock. One long sleep would run
/// late after the computer sleeps, since tokio's clock stops with it.
const TICK: Duration = Duration::from_secs(30);

/// The schedule each armed chat is waiting for.
fn armed() -> std::sync::MutexGuard<'static, HashMap<String, u64>> {
    static ARMED: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
    ARMED.get_or_init(Mutex::default).lock().unwrap_or_else(|e| e.into_inner())
}

/// The chat's saved schedule, if its failure still carries one.
pub fn continue_at(session: &Value) -> Option<u64> {
    let at = session.get("turnFailure")?.get("continueAt")?.as_f64()?;
    (at.is_finite() && at > 0.0).then_some(at as u64)
}

/// Whether the chat should be continued now for the schedule `at`: the same
/// schedule is still saved, its time (plus the margin) has come, the failure
/// still ends the transcript, and the chat can take a turn.
pub fn due(session: &Value, at: u64, now: u64) -> bool {
    let t = |k: &str| nekko_js::truthy(session.get(k));
    let last = session.get("messages").and_then(Value::as_array).and_then(|m| m.last()).and_then(|m| m.get("id"));
    let after = session.get("turnFailure").and_then(|f| f.get("afterMessageId"));
    continue_at(session) == Some(at)
        && now >= at.saturating_add(AFTER_RESET_MS)
        && (after.is_none_or(Value::is_null) || after == last)
        && t("providerId")
        && t("modelId")
        && !t("archivedAt")
        && !t("activeRun")
}

/// Follow a `session:setOptions` that touched `turnFailure`: arm the schedule
/// it saved, or drop the one it removed.
pub fn follow(ctx: &Ctx, id: &str, saved: &Value) {
    match continue_at(saved) {
        Some(at) => arm(ctx, id, at),
        None => {
            armed().remove(id);
        }
    }
}

/// Wait for `at` and continue the chat then. Arming the same schedule twice is
/// one timer; a different one replaces it.
pub fn arm(ctx: &Ctx, id: &str, at: u64) {
    {
        let mut a = armed();
        if a.get(id) == Some(&at) {
            return;
        }
        a.insert(id.to_string(), at);
    }
    let (ctx, id) = (ctx.clone(), id.to_string());
    tokio::spawn(async move {
        let when = at.saturating_add(AFTER_RESET_MS);
        loop {
            if armed().get(&id) != Some(&at) {
                return;
            }
            let left = when.saturating_sub(nekko_js::now_ms());
            if left == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(left).min(TICK)).await;
        }
        {
            let mut a = armed();
            if a.get(&id) != Some(&at) {
                return;
            }
            a.remove(&id);
        }
        fire(&ctx, &id, at).await;
    });
}

/// Every schedule saved before this daemon started (an overdue one continues now).
pub fn start(ctx: &Ctx) {
    let ctx = ctx.clone();
    tokio::spawn(async move {
        let store = ctx.sessions.clone();
        let saved =
            tokio::task::spawn_blocking(move || store.list_containing("\"continueAt\"")).await.unwrap_or_default();
        for session in saved {
            if let (Some(id), Some(at)) = (session.get("id").and_then(Value::as_str), continue_at(&session)) {
                arm(&ctx, id, at);
            }
        }
    });
}

fn running(ctx: &Ctx, id: &str) -> bool {
    ctx.compactions.is_compacting(id)
        || ctx.admission.is_admitting(id)
        || crate::routes::running_chats(ctx).iter().any(|r| r == id)
}

async fn fire(ctx: &Ctx, id: &str, at: u64) {
    let store = ctx.sessions.clone();
    let sid = id.to_string();
    let Some(session) = tokio::task::spawn_blocking(move || store.get(&sid)).await.ok().flatten() else { return };
    if !due(&session, at, nekko_js::now_ms()) || running(ctx, id) {
        return;
    }
    // The schedule is spent whatever happens next: a second failure leaves a
    // plain Retry notice, never a loop.
    let mut failure = session["turnFailure"].clone();
    if let Some(f) = failure.as_object_mut() {
        f.remove("continueAt");
    }
    let (store, sid) = (ctx.sessions.clone(), id.to_string());
    let _ = tokio::task::spawn_blocking(move || store.set_options(&sid, &json!({ "turnFailure": failure }))).await;
    ctx.hub.publish("agent:event", json!({ "type": "limit_reset", "sessionId": id, "continuing": true }), false);
    // As the chat's Retry sends it, and attended: the user asked for it.
    let opts = json!({
        "sessionId": id,
        "providerId": session.get("providerId"),
        "modelId": session.get("modelId"),
        "text": "",
        "resume": true,
    });
    if let Err(e) = crate::routes::route(ctx, "chat:send", vec![opts]).await {
        ctx.hub.publish(
            "agent:event",
            json!({ "type": "error", "sessionId": id, "message": format!("The usage limit reset, but the chat could not continue: {e}") }),
            false,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const AT: u64 = 1_763_215_200_000;

    fn chat() -> Value {
        json!({
            "id": "s1", "providerId": "p", "modelId": "m",
            "messages": [{ "id": "u1" }, { "id": "a1" }],
            "turnFailure": { "message": "You've hit your session limit · resets 3pm", "afterMessageId": "a1", "continueAt": AT },
        })
    }

    #[test]
    fn reads_the_saved_schedule() {
        assert_eq!(continue_at(&chat()), Some(AT));
        assert_eq!(continue_at(&json!({ "turnFailure": { "message": "x" } })), None);
        assert_eq!(continue_at(&json!({ "turnFailure": null })), None);
        assert_eq!(continue_at(&json!({})), None);
    }

    #[test]
    fn is_due_a_minute_after_the_reset() {
        assert!(!due(&chat(), AT, AT));
        assert!(!due(&chat(), AT, AT + AFTER_RESET_MS - 1));
        assert!(due(&chat(), AT, AT + AFTER_RESET_MS));
    }

    #[test]
    fn is_not_due_once_anything_retired_the_schedule() {
        let late = AT + AFTER_RESET_MS;
        // Another schedule replaced it.
        assert!(!due(&chat(), AT - 1, late));
        let with = |k: &str, v: Value| {
            let mut c = chat();
            c[k] = v;
            c
        };
        // Dismissed, or a new turn started (both drop the failure).
        assert!(!due(&with("turnFailure", Value::Null), AT, late));
        assert!(!due(&with("messages", json!([{ "id": "u1" }, { "id": "a1" }, { "id": "u2" }])), AT, late));
        assert!(!due(&with("activeRun", json!({ "startedAt": 1 })), AT, late));
        assert!(!due(&with("archivedAt", json!(1)), AT, late));
        assert!(!due(&with("modelId", json!("")), AT, late));
    }
}
