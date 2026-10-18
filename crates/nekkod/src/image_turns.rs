//! Image-generation turns in the daemon (PF14): `chat:generateImage`, a port
//! of `generateImageTurn` (image-chat.ts) over the daemon's own model server
//! (`engine:generateImage`, model_server.rs).
//!
//! There is no agent loop: the prompt goes to a local image model and the
//! reply is the picture. It still lands in the transcript as a user message
//! and an assistant message (with the image and how it was made), and still
//! sends the turn events every surface listens for: `image_status` while the
//! model loads and generates, then `done` (or `error`), to the UI and through
//! `turn:notify` to the host. The transcript edits, the request and the
//! labels are `nekko_turn::variants`. Stop (`chat:abort`) stops waiting; the
//! model server may finish the image anyway and it is discarded.

use crate::routes::Ctx;
use nekko_js as js;
use nekko_loop::Cancel;
use nekko_turn::variants as v;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub const CHANNELS: &[&str] = &["chat:generateImage"];

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// `randomInt(0, 2 ** 31 - 1)`.
fn random_seed() -> u64 {
    let mut b = [0u8; 4];
    let _ = getrandom::fill(&mut b);
    (u32::from_le_bytes(b) % 0x7fff_ffff) as u64
}

#[derive(Default)]
pub struct ImageTurns {
    running: Mutex<HashMap<String, Cancel>>,
}

/// Leaves the running list when the turn ends, however it ends.
struct Running<'a>(&'a ImageTurns, String);
impl Drop for Running<'_> {
    fn drop(&mut self) {
        lock(&self.0.running).remove(&self.1);
    }
}

impl ImageTurns {
    pub fn new() -> Arc<Self> {
        Arc::default()
    }

    /// `abortImageTurn`: stop waiting on this chat's image; true when there was one.
    pub fn abort(&self, session_id: &str) -> bool {
        match lock(&self.running).get(session_id) {
            Some(c) => {
                c.cancel();
                true
            }
            None => false,
        }
    }

    pub fn running_sessions(&self) -> Vec<String> {
        lock(&self.running).keys().cloned().collect()
    }

    /// `generateImageTurn(opts)`.
    pub async fn generate(&self, ctx: &Ctx, opts: &Value) -> Result<Value, String> {
        let session_id = opts.get("sessionId").and_then(Value::as_str).unwrap_or_default().to_string();
        let say = |event: Value| {
            ctx.hub.publish("agent:event", event.clone(), false);
            let backend = ctx.backend.clone();
            tokio::spawn(async move {
                let _ = backend.call("turn:notify", json!([event])).await;
            });
        };
        let fail = |message: &str| say(json!({ "type": "error", "sessionId": session_id, "message": message }));
        let (Some(store), Some(server)) = (ctx.sessions.clone(), ctx.server.clone()) else {
            return Err("Image generation needs the data directory".into());
        };
        let (st, id) = (store.clone(), session_id.clone());
        let session = tokio::task::spawn_blocking(move || st.get(&id)).await.map_err(|e| e.to_string())?;
        let Some(mut session) = session else {
            fail("That chat no longer exists.");
            return Ok(Value::Null);
        };
        // `assertHostExecution(sessionId, 'Image generation')`.
        if crate::worktrees::execution_mode(&session) == "sandbox" {
            return Err("Image generation is unsupported in sandbox sessions. Use scoped container file and bash tools. No host fallback.".into());
        }
        let cancel = {
            let mut running = lock(&self.running);
            if running.contains_key(&session_id) {
                drop(running);
                fail("This chat is already generating an image.");
                return Ok(Value::Null);
            }
            let c = Cancel::default();
            running.insert(session_id.clone(), c.clone());
            c
        };
        let _running = Running(self, session_id.clone());
        let started = match v::start_image_turn(&mut session, opts, now_ms(), random_seed()) {
            Ok(s) => s,
            Err(e) => {
                fail(&e);
                return Ok(Value::Null);
            }
        };
        let incognito = js::truthy(session.get("incognito"));
        // The chat's settings are the turn's now, which a merging save would undo.
        if !incognito {
            let (st, mut s) = (store.clone(), session.clone());
            let saved = tokio::task::spawn_blocking(move || st.save_whole(&mut s).map(|()| s))
                .await
                .map_err(|e| e.to_string())?;
            session = saved?;
        }
        let params = opts.get("params").cloned().unwrap_or(json!({}));
        let size = v::image_size(&params);
        say(
            json!({ "type": "image_status", "sessionId": session_id, "stage": "generating", "label": v::image_stage_label("generating", &size) }),
        );
        let clock = std::time::Instant::now();
        let generated = {
            let mut on_stage = |stage: &str| {
                say(
                    json!({ "type": "image_status", "sessionId": session_id, "stage": stage, "label": v::image_stage_label(stage, &size) }),
                );
            };
            tokio::select! {
                r = server.generate_image_with(&started.request, &mut on_stage) => Some(r),
                _ = cancel.cancelled() => None,
            }
        };
        let stopped = generated.is_none() || cancel.is_cancelled();
        let (reply, ending) = match generated {
            Some(Ok(result)) if !stopped => {
                let reply =
                    v::image_reply(&result, &params, &started.seed, clock.elapsed().as_millis() as u64, now_ms());
                let id = reply["id"].clone();
                (reply, json!({ "type": "done", "sessionId": session_id, "messageId": id }))
            }
            Some(Err(e)) if !stopped => (
                v::image_failure(false, &e, now_ms()),
                json!({ "type": "error", "sessionId": session_id, "message": e }),
            ),
            _ => {
                let reply = v::image_failure(true, "Stopped.", now_ms());
                let id = reply["id"].clone();
                (reply, json!({ "type": "done", "sessionId": session_id, "messageId": id }))
            }
        };
        if let Some(Value::Array(list)) = session.get_mut("messages") {
            list.push(reply);
        }
        // As sendChat does: prompts queued meanwhile (written straight to disk) survive this save.
        if !incognito {
            let (st, mut s) = (store.clone(), session);
            let saved = tokio::task::spawn_blocking(move || st.save_turn(&mut s, None)).await;
            if let Ok(Err(e)) = saved {
                eprintln!("nekkod: could not save an image turn: {e}");
            }
        }
        say(ending);
        Ok(Value::Null)
    }
}
