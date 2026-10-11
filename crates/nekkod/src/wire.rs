//! The loopback wire.
//!
//! - `POST /api/{channel}` with `{ "args": [...] }`: the web edition's request
//!   shape, for the CLI, the TS backend and anything else that speaks it.
//! - `GET /api/events`: every event as a `{ channel, payload }` text frame.
//! - `GET /api/ws`: the desktop UI's socket. Requests are
//!   `{ id, channel, args }`, replies `{ id, result }` or `{ id, error }`, and
//!   events arrive on the same socket without an `id`. One socket, no per-call
//!   HTTP, and no CORS: the renderer's CSP already allows `ws:`.
//! - `GET /api/term/{id}`: one terminal's raw byte stream (see `term_socket`).
//!
//! Every route but `/health` needs the bearer token, from the `Authorization`
//! header or (sockets cannot set headers from a page) a `token` query
//! parameter. A request carrying an `Origin` must come from an allowed one.

use crate::routes::{Ctx, route};
use axum::Router;
use axum::body::to_bytes;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use futures_util::{SinkExt, StreamExt};
use nekko_term::StreamMsg;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::mpsc;

#[derive(Clone)]
pub struct App {
    pub ctx: Ctx,
    pub token: Arc<str>,
    pub origins: Arc<Vec<String>>,
}

pub fn router(app: App) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/api/events", get(events))
        .route("/api/ws", get(rpc))
        .route("/api/term/{id}", get(term))
        .route("/api/{channel}", post(call))
        .with_state(app)
}

/// Constant-time comparison, so a wrong token leaks nothing by timing.
pub fn token_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn check(app: &App, headers: &HeaderMap, query: &HashMap<String, String>) -> Result<(), StatusCode> {
    if let Some(origin) = headers.get(header::ORIGIN) {
        let origin = origin.to_str().unwrap_or("");
        if !app.origins.iter().any(|o| o == origin) {
            return Err(StatusCode::FORBIDDEN);
        }
    }
    // A DNS-rebound page reaches us under its own host name; refuse it.
    if let Some(host) = headers.get(header::HOST).and_then(|h| h.to_str().ok()) {
        let name = host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host);
        if !matches!(name, "127.0.0.1" | "localhost" | "[::1]") {
            return Err(StatusCode::FORBIDDEN);
        }
    }
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .or(query.get("token").map(String::as_str));
    match bearer {
        Some(t) if token_eq(t.trim(), &app.token) => Ok(()),
        _ => Err(StatusCode::UNAUTHORIZED),
    }
}

async fn health() -> impl IntoResponse {
    axum::Json(json!({ "ok": true, "app": "nekkod", "version": env!("CARGO_PKG_VERSION") }))
}

// An inline image expands to base64 in a transcript. The full transcript is
// needed to save checkpoints, even if the model later uses a smaller window.
// Other calls match the web edition's public limit (apps/server, 25 MB): it
// forwards every channel here, image attachments included.
const CALL_BODY_LIMIT: usize = 25 * 1024 * 1024;
const LOOP_RUN_BODY_LIMIT: usize = 64 * 1024 * 1024;

fn body_limit(channel: &str) -> usize {
    if channel == "loop:run" { LOOP_RUN_BODY_LIMIT } else { CALL_BODY_LIMIT }
}

#[derive(Deserialize)]
struct CallBody {
    #[serde(default)]
    args: Vec<Value>,
}

async fn call(
    State(app): State<App>,
    Path(channel): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    request: Request,
) -> Response {
    if let Err(code) = check(&app, &headers, &query) {
        return (code, axum::Json(json!({ "error": "unauthorized" }))).into_response();
    }
    let body = match to_bytes(request.into_body(), body_limit(&channel)).await {
        Ok(body) => body,
        Err(_) => {
            return (StatusCode::PAYLOAD_TOO_LARGE, axum::Json(json!({ "error": "body too large" }))).into_response();
        }
    };
    let args = if body.is_empty() {
        Vec::new()
    } else {
        match serde_json::from_slice::<CallBody>(&body) {
            Ok(b) => b.args,
            Err(_) => {
                return (StatusCode::BAD_REQUEST, axum::Json(json!({ "error": "body is not JSON" }))).into_response();
            }
        }
    };
    match route(&app.ctx, &channel, args).await {
        Ok(v) => axum::Json(v).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, axum::Json(json!({ "error": e }))).into_response(),
    }
}

async fn events(
    State(app): State<App>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if let Err(code) = check(&app, &headers, &query) {
        return code.into_response();
    }
    // `?only=<channel>` narrows the stream to one channel. The TS backend uses
    // it to take the daemon's terminal events without receiving its own
    // events back. Frames always start with the channel key (see `Hub`).
    let only = query.get("only").map(|c| format!("{{\"channel\":\"{c}\""));
    ws.on_upgrade(move |socket| async move {
        let (mut sink, mut stream) = socket.split();
        let mut rx = app.ctx.hub.subscribe();
        loop {
            tokio::select! {
                ev = rx.recv() => match ev {
                    Ok(ev) => {
                        if only.as_ref().is_some_and(|p| !ev.text.starts_with(p.as_str())) { continue }
                        if sink.send(Message::Text(ev.text.as_ref().into())).await.is_err() { break }
                    }
                    Err(RecvError::Lagged(_)) => {
                        let lagged = json!({ "channel": "daemon:lagged", "payload": null }).to_string();
                        if sink.send(Message::Text(lagged.into())).await.is_err() { break }
                    }
                    Err(RecvError::Closed) => break,
                },
                msg = stream.next() => match msg {
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    _ => {}
                },
            }
        }
    })
}

async fn rpc(
    State(app): State<App>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if let Err(code) = check(&app, &headers, &query) {
        return code.into_response();
    }
    let term_data = query.get("termData").is_some_and(|v| v == "1");
    ws.on_upgrade(move |socket| rpc_socket(socket, app, term_data))
}

async fn rpc_socket(socket: WebSocket, app: App, term_data: bool) {
    let (mut sink, mut stream) = socket.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    let mut events = app.ctx.hub.subscribe();
    let writer = tokio::spawn(async move {
        loop {
            tokio::select! {
                // Replies first: a caller waiting on a result beats a busy event stream.
                biased;
                reply = out_rx.recv() => match reply {
                    Some(text) => if sink.send(Message::Text(text.into())).await.is_err() { break },
                    None => break,
                },
                ev = events.recv() => match ev {
                    Ok(ev) => {
                        if ev.term_data && !term_data { continue }
                        if sink.send(Message::Text(ev.text.as_ref().into())).await.is_err() { break }
                    }
                    Err(RecvError::Lagged(_)) => {
                        let lagged = json!({ "channel": "daemon:lagged", "payload": null }).to_string();
                        if sink.send(Message::Text(lagged.into())).await.is_err() { break }
                    }
                    Err(RecvError::Closed) => break,
                },
            }
        }
    });

    while let Some(Ok(msg)) = stream.next().await {
        let text = match msg {
            Message::Text(t) => t,
            Message::Close(_) => break,
            _ => continue,
        };
        let Ok(req) = serde_json::from_str::<Value>(text.as_str()) else {
            continue;
        };
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        let channel = req.get("channel").and_then(Value::as_str).unwrap_or_default().to_string();
        let args = match req.get("args") {
            Some(Value::Array(a)) => a.clone(),
            _ => Vec::new(),
        };
        let ctx = app.ctx.clone();
        let tx = out_tx.clone();
        // Each call runs on its own task, so one slow channel never holds up
        // the rest of the socket.
        tokio::spawn(async move {
            let reply = match route(&ctx, &channel, args).await {
                Ok(result) => json!({ "id": id, "result": result }),
                Err(error) => json!({ "id": id, "error": error }),
            };
            let _ = tx.send(reply.to_string());
        });
    }
    drop(out_tx);
    writer.abort();
}

async fn term(
    State(app): State<App>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if let Err(code) = check(&app, &headers, &query) {
        return code.into_response();
    }
    ws.on_upgrade(move |socket| term_socket(socket, app, id))
}

/// Client frames on a terminal stream: one opcode byte, then its payload.
const OP_INPUT: u8 = 0;
const OP_RESIZE: u8 = 1;
const OP_ACK: u8 = 2;
/// The scrollback is replayed in frames of this size.
const REPLAY_FRAME: usize = 64 * 1024;

/// One terminal, both directions.
///
/// Server to client: binary frames are output bytes; text frames are JSON
/// control messages (`hello` first, `exit` last). Client to server: binary
/// frames with an opcode (`0` input, `1` resize as two big-endian u16s, `2`
/// ack as a big-endian u32 byte count). The client acks output once it has
/// parsed it, which is what lets the daemon hold back a flood (see
/// `nekko_term::session`).
async fn term_socket(socket: WebSocket, app: App, id: String) {
    let (mut sink, mut stream) = socket.split();
    let Some(sub) = app.ctx.terminals.subscribe(&id) else {
        let _ = sink.send(Message::Close(Some(CloseFrame { code: 4404, reason: "no such terminal".into() }))).await;
        return;
    };
    let nekko_term::Subscription { mut rx, handle, snapshot, exit, cols, rows, info } = sub;

    let hello = json!({
        "type": "hello",
        "cols": cols,
        "rows": rows,
        "running": exit.is_none(),
        "replay": snapshot.len(),
        "info": info,
    });
    if sink.send(Message::Text(hello.to_string().into())).await.is_err() {
        return;
    }
    for chunk in snapshot.chunks(REPLAY_FRAME) {
        if sink.send(Message::Binary(chunk.to_vec().into())).await.is_err() {
            return;
        }
    }
    if let Some(code) = exit {
        let _ = sink.send(Message::Text(json!({ "type": "exit", "code": code }).to_string().into())).await;
        return;
    }

    let input = tokio::spawn(async move {
        while let Some(Ok(msg)) = stream.next().await {
            match msg {
                Message::Binary(b) if !b.is_empty() => match b[0] {
                    OP_INPUT => handle.write(&b[1..]),
                    OP_RESIZE if b.len() >= 5 => {
                        let cols = u16::from_be_bytes([b[1], b[2]]);
                        let rows = u16::from_be_bytes([b[3], b[4]]);
                        handle.resize(cols, rows);
                    }
                    OP_ACK if b.len() >= 5 => handle.ack(u32::from_be_bytes([b[1], b[2], b[3], b[4]]) as usize),
                    _ => {}
                },
                Message::Text(t) => handle.write(t.as_bytes()),
                Message::Close(_) => break,
                _ => {}
            }
        }
        // Dropping the handle here detaches the viewer.
    });

    while let Some(msg) = rx.recv().await {
        let sent = match msg {
            StreamMsg::Data(bytes) => sink.send(Message::Binary(bytes)).await,
            StreamMsg::Exit(code) => {
                let _ = sink.send(Message::Text(json!({ "type": "exit", "code": code }).to_string().into())).await;
                break;
            }
        };
        if sent.is_err() {
            break;
        }
    }
    input.abort();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_comparison_is_exact() {
        assert!(token_eq("abcdef0123456789", "abcdef0123456789"));
        assert!(!token_eq("abcdef0123456789", "abcdef012345678"));
        assert!(!token_eq("abcdef0123456789", "abcdef012345678x"));
    }

    #[tokio::test]
    async fn loop_run_accepts_image_bodies_above_axum_default_but_other_calls_do_not() {
        assert_eq!(body_limit("loop:run"), 64 * 1024 * 1024);
        assert_eq!(body_limit("loop:tool"), CALL_BODY_LIMIT);
        let image = axum::body::Body::from(vec![b'x'; CALL_BODY_LIMIT + 1]);
        assert!(to_bytes(image, body_limit("loop:run")).await.is_ok());
        let image = axum::body::Body::from(vec![b'x'; CALL_BODY_LIMIT + 1]);
        assert!(to_bytes(image, body_limit("loop:tool")).await.is_err());
    }

    #[tokio::test]
    async fn loop_run_still_rejects_oversized_bodies() {
        let body = axum::body::Body::from(vec![b'x'; LOOP_RUN_BODY_LIMIT + 1]);
        assert!(to_bytes(body, body_limit("loop:run")).await.is_err());
    }
}
