//! The local API server: the desktop app, served to other programs. A port
//! of `apps/desktop/src/main/api-server.ts`, as a second nekkod listener.
//!
//! `POST /api/:channel` with `{ args: [...] }` and an `/api/events` socket are
//! the surface the CLI and the MCP server already speak, so `nekko-agent chat
//! "…"` and an MCP client drive *this* app's daemon (the same providers,
//! workspaces and chats) instead of a second process on the same files.
//! Calls go through the daemon's router; the socket carries every chat's
//! agent events.
//!
//! Every request is authenticated with `settings.apiServer.token`. There is
//! no anonymous mode, because this endpoint can run shell commands: an open
//! port here is a remote shell. No browser origin is allowed to read it
//! (`Access-Control-Allow-Origin: null`).
//!
//! The address rules (`withApiServerDefaults`, `apiServerBindHost`,
//! `apiServerUrl`, `apiServerClientUrl`, `apiServerRefusal`) are golden-tested
//! against packages/shared.

use crate::routes::Ctx;
use axum::Router;
use axum::body::{Body, to_bytes};
use axum::extract::ws::{Message, WebSocketUpgrade};
use axum::extract::{FromRequestParts, Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Map, Value, json};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::watch;

const BODY_LIMIT: usize = 25 * 1024 * 1024;
pub const PORT_DEFAULT: u16 = 1439;
/// `IpcEvents.agentEvent`: what the socket carries.
const AGENT_EVENT: &str = "agent:event";
/// The channels only the desktop window answers (`desktopChannels`); the TS
/// server's dispatcher did not have them, so neither does this one.
pub const WINDOW_ONLY: &[&str] = &[
    "apiServer:status",
    "apiServer:save",
    "apiServer:newToken",
    "cli:installStatus",
    "cli:install",
    "integrations:target",
    "localRelay:status",
    "localRelay:start",
    "localRelay:stop",
    "localRelay:setLan",
    "networkVisibility:status",
    "networkVisibility:start",
    "networkVisibility:stop",
];

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// JavaScript's `String.prototype.trim`.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(crate::mdns::js_space)
}

fn str_of<'a>(s: &'a Value, key: &str) -> &'a str {
    s.get(key).and_then(Value::as_str).unwrap_or("")
}

// ------------------------------------------------------------------ address rules

/// `withApiServerDefaults`: the settings with anything missing filled in.
pub fn with_defaults(saved: Option<&Value>) -> Value {
    let mut out: Map<String, Value> = [
        ("enabled", json!(true)),
        ("startOnLaunch", json!(true)),
        ("port", json!(PORT_DEFAULT)),
        ("bind", json!("local")),
        ("host", json!("")),
        ("advertisedUrl", json!("")),
        ("token", json!("")),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect();
    if let Some(Value::Object(saved)) = saved {
        for (k, v) in saved {
            out.insert(k.clone(), v.clone());
        }
    }
    Value::Object(out)
}

/// `apiServerBindHost`: the interface these settings bind.
pub fn bind_host(s: &Value) -> String {
    match str_of(s, "bind") {
        "lan" => "0.0.0.0".into(),
        "custom" => Some(js_trim(str_of(s, "host"))).filter(|h| !h.is_empty()).unwrap_or("127.0.0.1").into(),
        _ => "127.0.0.1".into(),
    }
}

/// `apiServerUrl`: the base URL for the interface being bound, `0.0.0.0`
/// quoted as `host` (this machine's LAN address, else loopback).
pub fn url(s: &Value, host: &str) -> String {
    let bound = bind_host(s);
    let dialable = if bound == "0.0.0.0" || bound == "::" { host.to_string() } else { bound };
    let authority = if dialable.contains(':') { format!("[{dialable}]") } else { dialable };
    format!("http://{authority}:{}", nekko_js::display(s.get("port").unwrap_or(&Value::Null)))
}

/// `apiServerClientUrl`: what the user advertised, else what is bound.
pub fn client_url(s: &Value, host: &str) -> String {
    let advertised = js_trim(str_of(s, "advertisedUrl"));
    if advertised.is_empty() { url(s, host) } else { advertised.trim_end_matches('/').to_string() }
}

/// `apiServerRefusal`: why these settings cannot be served.
pub fn refusal(s: &Value) -> Option<&'static str> {
    let port = s.get("port").and_then(Value::as_f64);
    if !port.is_some_and(|p| p.fract() == 0.0 && (1024.0..=65535.0).contains(&p)) {
        return Some("Pick a port between 1024 and 65535.");
    }
    if js_trim(str_of(s, "token")).is_empty() {
        return Some("A token is required. Anything that can reach this port can otherwise run the agent.");
    }
    if str_of(s, "bind") == "custom" && js_trim(str_of(s, "host")).is_empty() {
        return Some("Enter the address to bind, or pick one of the presets.");
    }
    let advertised = js_trim(str_of(s, "advertisedUrl"));
    if !advertised.is_empty() && !full_url(advertised) {
        return Some("The address clients use must be a full URL, e.g. http://nekko.tailnet.ts.net:1439.");
    }
    None
}

/// `/^https?:\/\/[^\s/]+/i`.
fn full_url(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    let rest = lower.strip_prefix("http://").or_else(|| lower.strip_prefix("https://"));
    rest.and_then(|r| r.chars().next()).is_some_and(|c| c != '/' && !crate::mdns::js_space(c))
}

/// A fresh bearer token: 24 random bytes, url-safe (`newApiToken`).
pub fn new_token() -> String {
    use base64::Engine;
    let mut b = [0u8; 24];
    getrandom::fill(&mut b).expect("the OS random source is available");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

/// This machine's first non-internal IPv4 address (`lanAddress`).
pub fn lan_address() -> Option<String> {
    crate::mdns::interfaces().into_iter().find(|n| n.ipv4 && !n.internal).map(|n| n.address)
}

// ------------------------------------------------------------------ the server

#[derive(Default)]
struct Counters {
    requests: AtomicU64,
    last_request_at: AtomicU64,
    clients: AtomicUsize,
}

struct Running {
    /// `true` stops the listener and closes every event socket.
    stop: watch::Sender<bool>,
    /// The serve task, done once the port is free again.
    served: tokio::task::JoinHandle<()>,
}

#[derive(Default)]
struct Live {
    running: Option<Running>,
    /// What the running server was started with: port, bind, host, token.
    applied: Option<[Value; 4]>,
    last_error: Option<String>,
    counters: Arc<Counters>,
}

#[derive(Default)]
pub struct ApiServer {
    live: Mutex<Live>,
}

fn applied_of(s: &Value) -> [Value; 4] {
    [
        s.get("port").cloned().unwrap_or(Value::Null),
        s.get("bind").cloned().unwrap_or(Value::Null),
        s.get("host").cloned().filter(|h| !h.is_null()).unwrap_or(json!("")),
        s.get("token").cloned().unwrap_or(Value::Null),
    ]
}

/// Node's `listen` error text for the common failures.
fn listen_error(e: &std::io::Error, host: &str, port: u16) -> String {
    let at = format!("{host}:{port}");
    match e.kind() {
        std::io::ErrorKind::AddrInUse => format!("listen EADDRINUSE: address already in use {at}"),
        std::io::ErrorKind::PermissionDenied => format!("listen EACCES: permission denied {at}"),
        std::io::ErrorKind::AddrNotAvailable => format!("listen EADDRNOTAVAIL: address not available {at}"),
        _ => format!("listen {e} {at}"),
    }
}

#[derive(Clone)]
struct App {
    ctx: Ctx,
    token: Arc<str>,
    counters: Arc<Counters>,
    stop: watch::Receiver<bool>,
}

impl ApiServer {
    /// Bring the server in line with the saved settings. Safe to call repeatedly.
    pub async fn sync(&self, ctx: &Ctx, settings: &Value) {
        let enabled = nekko_js::truthy(settings.get("enabled")) && nekko_net::allowed("api-server");
        {
            let live = lock(&self.live);
            if enabled && live.running.is_some() && live.applied.as_ref() == Some(&applied_of(settings)) {
                return;
            }
        }
        self.stop().await;
        if enabled {
            self.start(ctx, settings).await;
        } else {
            lock(&self.live).last_error = None;
        }
    }

    async fn start(&self, ctx: &Ctx, settings: &Value) {
        if let Some(r) = refusal(settings) {
            lock(&self.live).last_error = Some(r.into());
            return;
        }
        let host = bind_host(settings);
        let port = settings.get("port").and_then(Value::as_u64).unwrap_or(PORT_DEFAULT as u64) as u16;
        let listener = match tokio::net::TcpListener::bind((host.as_str(), port)).await {
            Ok(l) => l,
            Err(e) => {
                // A port already in use is the common one, and the server card says
                // so rather than showing a server that claims to run and does not.
                let mut live = lock(&self.live);
                live.last_error = Some(listen_error(&e, &host, port));
                live.applied = None;
                return;
            }
        };
        let (stop, stopped) = watch::channel(false);
        let counters = Arc::new(Counters::default());
        let app = App {
            ctx: ctx.clone(),
            token: str_of(settings, "token").into(),
            counters: counters.clone(),
            stop: stopped.clone(),
        };
        let served = serve(listener, app, stopped);
        let mut live = lock(&self.live);
        live.running = Some(Running { stop, served });
        live.applied = Some(applied_of(settings));
        live.last_error = None;
        live.counters = counters;
    }

    /// Stop listening and close every event socket; returns once the port is free.
    pub async fn stop(&self) {
        let running = {
            let mut live = lock(&self.live);
            live.applied = None;
            live.counters.clients.store(0, Ordering::SeqCst);
            live.running.take()
        };
        if let Some(r) = running {
            let _ = r.stop.send(true);
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), r.served).await;
        }
    }

    /// Everything the server card needs (`apiServerStatus`).
    pub fn status(&self, settings: &Value) -> Value {
        let live = lock(&self.live);
        let running = live.running.is_some();
        let lan = lan_address().unwrap_or_else(|| "127.0.0.1".into());
        let mut out = Map::new();
        out.insert("settings".into(), settings.clone());
        out.insert("running".into(), json!(running));
        out.insert("available".into(), json!(true));
        if running {
            out.insert("url".into(), json!(url(settings, &lan)));
        }
        out.insert("clientUrl".into(), json!(client_url(settings, &lan)));
        if nekko_js::truthy(settings.get("enabled")) && !running {
            out.insert("error".into(), json!(live.last_error.clone().unwrap_or_else(|| "Not listening.".into())));
        }
        out.insert("clients".into(), json!(live.counters.clients.load(Ordering::SeqCst)));
        out.insert("requests".into(), json!(live.counters.requests.load(Ordering::SeqCst)));
        let last = live.counters.last_request_at.load(Ordering::SeqCst);
        if last > 0 {
            out.insert("lastRequestAt".into(), json!(last));
        }
        Value::Object(out)
    }
}

/// Serve until `stop` turns true. A plain function, not `async`: the router
/// reaches `apiServer:save`, which starts a server again, and an `async`
/// start would have to name its own future's type.
fn serve(listener: tokio::net::TcpListener, app: App, mut stop: watch::Receiver<bool>) -> tokio::task::JoinHandle<()> {
    let router = Router::new().fallback(handle).with_state(app);
    tokio::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = stop.wait_for(|s| *s).await;
            })
            .await;
    })
}

fn send(status: StatusCode, body: Value) -> Response {
    let mut res = (status, axum::Json(body)).into_response();
    // The endpoint is for programs, not pages: no browser origin may read it.
    res.headers_mut().insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("null"));
    res
}

fn bare(status: StatusCode) -> Response {
    (status, Body::empty()).into_response()
}

/// The token on a request, from the header or (sockets can't set one) the query.
fn bearer_of(req: &Request, url: &url::Url) -> Option<String> {
    let header = req.headers().get(header::AUTHORIZATION).and_then(|v| v.to_str().ok());
    if let Some(h) = header
        && h.len() >= 7
        && h.is_char_boundary(7)
        && h[..7].eq_ignore_ascii_case("bearer ")
    {
        return Some(js_trim(&h[7..]).to_string());
    }
    url.query_pairs().find(|(k, _)| k == "token").map(|(_, v)| v.into_owned())
}

async fn handle(State(app): State<App>, req: Request) -> Response {
    let url = match url::Url::parse(&format!("http://localhost{}", req.uri())) {
        Ok(u) => u,
        Err(_) => return send(StatusCode::NOT_FOUND, json!({ "error": "not found" })),
    };
    let authorized = bearer_of(&req, &url).is_some_and(|t| crate::wire::token_eq(&t, &app.token));
    if req.headers().contains_key(header::UPGRADE) {
        return upgrade(app, req, &url, authorized).await;
    }
    if !authorized {
        return send(StatusCode::UNAUTHORIZED, json!({ "error": "unauthorized" }));
    }
    // A "what is this port" probe, so a misconfigured client gets a name instead of a 404.
    if req.method() == axum::http::Method::GET && url.path() == "/api/health" {
        return send(StatusCode::OK, json!({ "ok": true, "app": "nekko-agent", "edition": "desktop" }));
    }
    let channel = url.path().strip_prefix("/api/").unwrap_or("").to_string();
    if req.method() != axum::http::Method::POST || channel.is_empty() {
        return send(StatusCode::NOT_FOUND, json!({ "error": "not found" }));
    }
    let Ok(body) = to_bytes(req.into_body(), BODY_LIMIT).await else {
        return send(StatusCode::PAYLOAD_TOO_LARGE, json!({ "error": "body too large" }));
    };
    let raw = String::from_utf8_lossy(&body);
    let args = if raw.is_empty() {
        Vec::new()
    } else {
        match serde_json::from_str::<Value>(&raw) {
            Ok(Value::Object(mut o)) => match o.remove("args") {
                Some(Value::Array(a)) => a,
                _ => Vec::new(),
            },
            Ok(_) => Vec::new(),
            Err(_) => return send(StatusCode::BAD_REQUEST, json!({ "error": "body is not JSON" })),
        }
    };
    app.counters.requests.fetch_add(1, Ordering::SeqCst);
    app.counters.last_request_at.store(now_ms(), Ordering::SeqCst);
    let unknown = || format!("Unknown channel: {channel}");
    if WINDOW_ONLY.contains(&channel.as_str()) {
        return send(StatusCode::INTERNAL_SERVER_ERROR, json!({ "error": unknown() }));
    }
    match crate::routes::route(&app.ctx, &channel, args).await {
        Ok(v) => send(StatusCode::OK, v),
        // The TS dispatcher's wording, which the CLI has always shown.
        Err(e) if e == format!("unknown channel {channel}") => {
            send(StatusCode::INTERNAL_SERVER_ERROR, json!({ "error": unknown() }))
        }
        Err(e) => send(StatusCode::INTERNAL_SERVER_ERROR, json!({ "error": e })),
    }
}

async fn stopped(rx: &mut watch::Receiver<bool>) {
    let _ = rx.wait_for(|s| *s).await;
}

/// `/api/events`: every chat's agent events as `{ channel, payload }` frames.
async fn upgrade(app: App, req: Request, url: &url::Url, authorized: bool) -> Response {
    if url.path() != "/api/events" || !req.headers().contains_key(header::SEC_WEBSOCKET_KEY) {
        return bare(StatusCode::NOT_FOUND);
    }
    if !authorized {
        return bare(StatusCode::UNAUTHORIZED);
    }
    let (mut parts, _) = req.into_parts();
    let ws = match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
        Ok(ws) => ws,
        Err(e) => return e.into_response(),
    };
    let prefix = format!("{{\"channel\":\"{AGENT_EVENT}\"");
    ws.on_upgrade(move |socket| async move {
        app.counters.clients.fetch_add(1, Ordering::SeqCst);
        let (mut sink, mut stream) = socket.split();
        let mut rx = app.ctx.hub.subscribe();
        let mut stop = app.stop.clone();
        loop {
            tokio::select! {
                () = stopped(&mut stop) => break,
                ev = rx.recv() => match ev {
                    Ok(ev) => {
                        if !ev.text.starts_with(prefix.as_str()) { continue }
                        if sink.send(Message::Text(ev.text.clone())).await.is_err() { break }
                    }
                    Err(RecvError::Lagged(_)) => {
                        let lagged = json!({ "channel": "daemon:lagged", "payload": null }).to_string();
                        if sink.send(Message::Text(lagged.into())).await.is_err() { break }
                    }
                    Err(RecvError::Closed) => break,
                },
                // Nothing is read from these sockets; a close is still noticed.
                msg = stream.next() => match msg {
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    _ => {}
                },
            }
        }
        // `stop()` zeroes the count when it closes every socket at once.
        if !*app.stop.borrow() {
            app.counters.clients.fetch_sub(1, Ordering::SeqCst);
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_address_rules_match_the_ts() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/desktop-features.json");
        let g: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        for case in g["apiServer"].as_array().unwrap() {
            let s = with_defaults(Some(&case["input"]));
            assert_eq!(s, case["settings"], "{}", case["input"]);
            assert_eq!(bind_host(&s), case["bindHost"].as_str().unwrap(), "{}", case["input"]);
            assert_eq!(url(&s, "127.0.0.1"), case["url"].as_str().unwrap(), "{}", case["input"]);
            assert_eq!(url(&s, "192.168.1.20"), case["urlLan"].as_str().unwrap(), "{}", case["input"]);
            assert_eq!(client_url(&s, "127.0.0.1"), case["clientUrl"].as_str().unwrap(), "{}", case["input"]);
            assert_eq!(client_url(&s, "192.168.1.20"), case["clientUrlLan"].as_str().unwrap(), "{}", case["input"]);
            assert_eq!(json!(refusal(&s)), case["refusal"], "{}", case["input"]);
        }
    }

    #[test]
    fn tokens_are_32_url_safe_characters() {
        let (a, b) = (new_token(), new_token());
        assert_eq!(a.len(), 32);
        assert_ne!(a, b);
        assert!(a.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'));
    }
}
