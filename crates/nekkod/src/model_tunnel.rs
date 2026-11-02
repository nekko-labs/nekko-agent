//! A connected computer's Model Server, used from here (connected computers).
//!
//! **The host** answers `model:open`, `model:next` and `model:cancel`: it calls
//! its own engine on loopback, holds the reply, and hands it over in pieces when
//! asked. Pulled, not pushed: an event would reach every paired device, and a
//! slow link would have to buffer a whole reply.
//!
//! **The client** listens on loopback and turns each request under
//! `/<computerId>/v1/` into those calls, so a connected Model Server is an
//! ordinary OpenAI-compatible provider: the turn code, capability checks and
//! model pickers need nothing new, and a phone connected here can pick it too.
//!
//! Only the engine's own paths cross. It never reaches a local runtime, a
//! provider or Claude Code, so a subscription can't be routed through it.

use crate::routes::Ctx;
use axum::body::{Body, Bytes};
use axum::extract::{Path, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, mpsc};

pub const CHANNELS: &[&str] = &["model:open", "model:next", "model:cancel"];

/// The engine's own paths, nothing else.
const PATHS: &[&str] = &["/v1/chat/completions", "/v1/embeddings", "/v1/models"];

/// What a request keeps with *Connected devices choose model settings* off:
/// what it asks, not how the model samples. The server's saved preset decides
/// the rest. A token limit stays, since it only ever asks for less.
const CONTENT_KEYS: &[&str] = &[
    "input",
    "max_completion_tokens",
    "max_tokens",
    "messages",
    "model",
    "response_format",
    "stream",
    "stream_options",
    "tool_choice",
    "tools",
];

/// The most one `model:next` carries: it travels in one relay frame.
const PIECE_BYTES: usize = 256 * 1024;
/// How long `model:next` holds a request open with nothing to send.
const WAIT: Duration = Duration::from_secs(15);
/// A reply nobody has read for this long is dropped.
const ABANDONED: Duration = Duration::from_secs(120);
/// Replies held at once: each pins a model's slot.
const MAX_STREAMS: usize = 16;

struct Stream {
    rx: mpsc::Receiver<Result<Bytes, String>>,
    read_at: Instant,
    done: bool,
}

/// The replies the host is holding for other computers.
#[derive(Default)]
pub struct Tunnel {
    streams: Mutex<HashMap<String, Stream>>,
}

fn engine_setting(settings: &Value, key: &str) -> Value {
    settings.get("engine").and_then(|e| e.get(key)).cloned().unwrap_or(Value::Null)
}

/// `shareWithComputers`, on unless the owner turned it off.
pub fn sharing(settings: &Value) -> bool {
    engine_setting(settings, "shareWithComputers") != Value::Bool(false)
}

/// A request's body, without the sampling a server that sets its own keeps for itself.
pub fn clean_body(settings: &Value, mut body: Value) -> Value {
    if engine_setting(settings, "clientModelSettings") == Value::Bool(false)
        && let Some(o) = body.as_object_mut()
    {
        o.retain(|k, _| CONTENT_KEYS.contains(&k.as_str()));
    }
    body
}

impl Tunnel {
    pub async fn route(self: &Arc<Self>, ctx: &Ctx, channel: &str, args: &[Value]) -> Result<Value, String> {
        let arg = |i: usize| args.get(i).unwrap_or(&Value::Null);
        match channel {
            "model:open" => self.open(ctx, arg(0).as_str().unwrap_or_default(), arg(1).clone()).await,
            "model:next" => self.next(arg(0).as_str().unwrap_or_default()).await,
            "model:cancel" => {
                self.streams.lock().await.remove(arg(0).as_str().unwrap_or_default());
                Ok(Value::Null)
            }
            _ => Err(format!("unknown channel {channel}")),
        }
    }

    async fn open(self: &Arc<Self>, ctx: &Ctx, path: &str, body: Value) -> Result<Value, String> {
        if !PATHS.contains(&path) {
            return Err(format!("{path} isn't a Model Server path."));
        }
        let settings = crate::settings::current(ctx).await;
        if !sharing(&settings) {
            return Err("This computer doesn't share its models.".into());
        }
        let engine = crate::library::engine_settings(&settings);
        // Never restart a server its owner stopped: that would bring back a network bind.
        if engine.get("autoStart") == Some(&Value::Bool(true)) {
            let _ = crate::routes::route(ctx, "engine:start", vec![]).await;
        }
        let port = engine.get("port").and_then(Value::as_u64).ok_or("This computer's Model Server has no port.")?;
        let url = format!("http://127.0.0.1:{port}{path}");
        let client = reqwest::Client::new();
        let mut request =
            if body.is_null() { client.get(&url) } else { client.post(&url).json(&clean_body(&settings, body)) };
        if let Some(key) = engine.get("apiKey").and_then(Value::as_str).filter(|k| !k.is_empty()) {
            request = request.bearer_auth(key);
        }
        let mut streams = self.streams.lock().await;
        streams.retain(|_, s| s.read_at.elapsed() < ABANDONED);
        if streams.len() >= MAX_STREAMS {
            return Err("This computer's Model Server is busy with other computers.".into());
        }
        drop(streams);
        let reply = request.send().await.map_err(|_| "This computer's Model Server isn't running.".to_string())?;
        let status = reply.status().as_u16();
        let content_type = reply.headers().get("content-type").and_then(|v| v.to_str().ok()).map(str::to_string);

        let (tx, rx) = mpsc::channel(64);
        tokio::spawn(async move {
            use futures_util::StreamExt;
            let mut bytes = reply.bytes_stream();
            while let Some(chunk) = bytes.next().await {
                let chunk = chunk.map_err(|e| e.to_string());
                let failed = chunk.is_err();
                // Nobody reading: let go of the model's slot.
                let sent = tokio::time::timeout(ABANDONED, tx.send(chunk)).await;
                if !matches!(sent, Ok(Ok(()))) || failed {
                    return;
                }
            }
        });
        let id = nekko_js::host::uuid();
        let mut streams = self.streams.lock().await;
        streams.insert(id.clone(), Stream { rx, read_at: Instant::now(), done: false });
        Ok(json!({ "id": id, "status": status, "contentType": content_type }))
    }

    async fn next(&self, id: &str) -> Result<Value, String> {
        let mut stream = self.streams.lock().await.remove(id).ok_or("That reply is gone.")?;
        let mut piece = Vec::new();
        let first = tokio::time::timeout(WAIT, stream.rx.recv()).await;
        let mut failed = None;
        match first {
            Err(_) => {}
            Ok(None) => stream.done = true,
            Ok(Some(Err(e))) => failed = Some(e),
            Ok(Some(Ok(b))) => {
                piece.extend_from_slice(&b);
                while piece.len() < PIECE_BYTES {
                    match stream.rx.try_recv() {
                        Ok(Ok(b)) => piece.extend_from_slice(&b),
                        Ok(Err(e)) => {
                            failed = Some(e);
                            break;
                        }
                        Err(mpsc::error::TryRecvError::Empty) => break,
                        Err(mpsc::error::TryRecvError::Disconnected) => {
                            stream.done = true;
                            break;
                        }
                    }
                }
            }
        }
        if let Some(e) = failed {
            return Err(e);
        }
        let done = stream.done;
        if !done {
            stream.read_at = Instant::now();
            self.streams.lock().await.insert(id.to_string(), stream);
        }
        Ok(json!({ "data": STANDARD.encode(&piece), "done": done }))
    }
}

/// The sentence a reply ends with when its computer goes away mid-stream, in
/// the shape a turn reads as the provider's own error.
fn stream_error(message: &str) -> Bytes {
    Bytes::from(format!("data: {}\n\n", json!({ "error": { "message": message } })))
}

/// The client's side: what the listener needs.
#[derive(Clone)]
pub struct Listener {
    pub computers: Arc<crate::computers::Computers>,
    /// Fresh each run, held in memory and in the generated provider row.
    pub token: Arc<str>,
}

async fn forward(
    State(app): State<Listener>,
    Path((id, path)): Path<(String, String)>,
    headers: HeaderMap,
    request: Request,
) -> Response {
    let token = headers.get("authorization").and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer "));
    if !token.is_some_and(|t| crate::wire::token_eq(t, &app.token)) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let post = request.method() == axum::http::Method::POST;
    let Ok(raw) = axum::body::to_bytes(request.into_body(), BODY_LIMIT).await else {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    };
    let body: Value = if post { serde_json::from_slice(&raw).unwrap_or(Value::Null) } else { Value::Null };
    let path = format!("/v1/{path}");
    let (name, client) = match app.computers.client_for_models(&id) {
        Ok(found) => found,
        Err(e) => return (StatusCode::BAD_GATEWAY, axum::Json(json!({ "error": { "message": e } }))).into_response(),
    };
    let opened = match client.call("model:open", json!([path, body])).await {
        Ok(v) => v,
        Err(e) => {
            return (StatusCode::BAD_GATEWAY, axum::Json(json!({ "error": { "message": e.to_string() } })))
                .into_response();
        }
    };
    let stream_id = opened["id"].as_str().unwrap_or_default().to_string();
    let status = opened["status"].as_u64().and_then(|s| StatusCode::from_u16(s as u16).ok()).unwrap_or(StatusCode::OK);
    let content_type = opened["contentType"].as_str().unwrap_or("application/json").to_string();
    let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(8);
    tokio::spawn(async move {
        loop {
            let piece = client.call("model:next", json!([stream_id])).await;
            let Ok(piece) = piece else {
                let _ = tx.send(Ok(stream_error(&format!("{name} went offline during this reply.")))).await;
                return;
            };
            let data = piece["data"].as_str().and_then(|d| STANDARD.decode(d).ok()).unwrap_or_default();
            // The turn stopped listening: stop the model over there too.
            if tx.is_closed() || (!data.is_empty() && tx.send(Ok(Bytes::from(data))).await.is_err()) {
                let _ = client.call("model:cancel", json!([stream_id])).await;
                return;
            }
            if piece["done"] == Value::Bool(true) {
                return;
            }
        }
    });
    let body = Body::from_stream(tokio_stream_of(rx));
    (status, [("content-type", content_type)], body).into_response()
}

fn tokio_stream_of(
    rx: mpsc::Receiver<Result<Bytes, std::io::Error>>,
) -> impl futures_util::Stream<Item = Result<Bytes, std::io::Error>> {
    futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|item| (item, rx)) })
}

/// A request body this listener takes.
pub const BODY_LIMIT: usize = 25 * 1024 * 1024;

/// Listen on loopback. Returns the port.
pub async fn listen(app: Listener) -> std::io::Result<u16> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let router = axum::Router::new().route("/{id}/v1/{*path}", axum::routing::any(forward)).with_state(app);
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_server_that_sets_its_own_settings_keeps_them() {
        let off = json!({ "engine": { "clientModelSettings": false } });
        let body = json!({ "model": "qwen", "messages": [], "temperature": 2, "seed": 1, "grammar": "x", "id_slot": 0, "max_tokens": 9, "stream": true });
        assert_eq!(
            clean_body(&off, body.clone()),
            json!({ "model": "qwen", "messages": [], "max_tokens": 9, "stream": true })
        );
        assert_eq!(clean_body(&json!({}), body.clone()), body, "on by default");
    }

    #[test]
    fn sharing_is_on_unless_turned_off() {
        assert!(sharing(&json!({})));
        assert!(sharing(&json!({ "engine": {} })));
        assert!(!sharing(&json!({ "engine": { "shareWithComputers": false } })));
    }
}
