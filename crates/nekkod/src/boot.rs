//! What the TS host did when it started (`createHost`), done here
//! (PF14 step 5 prep, part 6):
//!
//! - chats a previous run left mid-reply are written off
//!   (`reconcileInterruptedChats`): nothing else drives a turn, so every
//!   `activeRun` a fresh daemon finds is stale;
//! - the model server's provider entry exists from the first launch
//!   (`ensureEngineProvider`), since the Models tab addresses the engine
//!   through it, and the server starts when `engine.autoStart` says so;
//! - chat worktrees whose PR merged are removed, a minute after launch and
//!   hourly (`removeMergedChatWorktrees`);
//! - a chat that runs out of context with nobody watching is compacted and
//!   carried on (`startAutoContinue`, auto_continue.rs).

use crate::routes::Ctx;
use serde_json::{Map, Value, json};
use std::time::Duration;

/// The note a reply cut off by a closed app ends with (`INTERRUPTED_NOTE`, packages/core).
pub const INTERRUPTED_NOTE: &str =
    "_This reply was cut off before it finished. Everything above is kept, resume to carry on from here._";
const SWEEP_FIRST: Duration = Duration::from_secs(60);
const SWEEP_EVERY: Duration = Duration::from_secs(60 * 60);

/// `auto_start_engine` off (a one-shot CLI command): the model server is left as it is.
pub fn start(ctx: &Ctx, auto_start_engine: bool) {
    let marked = reconcile_interrupted(&ctx.sessions);
    if marked > 0 {
        eprintln!("nekkod: {marked} chat(s) were mid-reply when the app last closed");
    }
    {
        let ctx = ctx.clone();
        tokio::spawn(async move { start_engine(&ctx, auto_start_engine).await });
    }
    {
        crate::auto_continue::start(ctx);
        let ctx = ctx.clone();
        tokio::spawn(async move {
            tokio::time::sleep(SWEEP_FIRST).await;
            let mut tick = tokio::time::interval(SWEEP_EVERY);
            loop {
                tick.tick().await;
                for (root, branch) in crate::worktrees::sweep_merged(&ctx).await {
                    eprintln!("[worktrees] removed {root} ({branch}): its PR merged");
                }
            }
        });
    }
}

/// `reconcileInterruptedChats` with nothing still running: every chat that
/// still carries `activeRun` gets the interrupted reply (unless its last
/// message is the user's or already says so) and loses the marker.
pub fn reconcile_interrupted(store: &nekko_store::SessionStore) -> usize {
    let mut marked = 0;
    // Only a chat whose file has the key can carry it: the rest are never parsed.
    for session in store.list_containing("\"activeRun\"") {
        if !nekko_js::truthy(session.get("activeRun")) {
            continue;
        }
        let Some(id) = session.get("id").and_then(Value::as_str) else { continue };
        let changed = store.update_if(id, |s| {
            if !nekko_js::truthy(s.get("activeRun")) {
                return Ok(false);
            }
            let messages = s.entry("messages").or_insert_with(|| json!([]));
            if let Value::Array(list) = messages {
                let last = list.last();
                let already = last.is_some_and(|m| m["role"] == "assistant" && nekko_js::truthy(m.get("interrupted")));
                if last.is_some_and(|m| m["role"] != "user") && !already {
                    list.push(interrupted_reply());
                }
            }
            s.remove("activeRun");
            Ok(true)
        });
        if matches!(changed, Ok(Some(_))) {
            marked += 1;
        }
    }
    marked
}

fn interrupted_reply() -> Value {
    let mut rand = [0u8; 4];
    let _ = getrandom::fill(&mut rand);
    let r = crate::turns::base36(u32::from_le_bytes(rand) as u64);
    let mut m = Map::new();
    m.insert(
        "id".into(),
        json!(format!("msg_{}_{}", crate::turns::base36(nekko_js::now_ms()), &format!("{r:0>6}")[..6])),
    );
    m.insert("role".into(), json!("assistant"));
    m.insert("content".into(), json!(format!("_The app closed while this reply was running._\n\n{INTERRUPTED_NOTE}")));
    m.insert("interrupted".into(), json!(true));
    m.insert("createdAt".into(), json!(nekko_js::now_ms()));
    Value::Object(m)
}

/// `ensureEngineProvider` at launch, then `engine.start()` when `engine.autoStart` is on.
async fn start_engine(ctx: &Ctx, auto_start: bool) {
    let settings = crate::settings::current(ctx).await;
    let engine = crate::library::engine_settings(&settings);
    let base_url = format!("http://127.0.0.1:{}/v1", nekko_js::display(engine.get("port").unwrap_or(&json!(11500))));
    crate::model_server::ensure_engine_provider(&ctx.settings, &base_url).await;
    // Opt-in only, and never fatal: a port taken by something else leaves a
    // line in the engine's log for the Models tab, not a failed launch.
    if auto_start && nekko_js::truthy(engine.get("autoStart")) {
        let _ = crate::routes::route(ctx, "engine:start", vec![]).await;
    }
}
