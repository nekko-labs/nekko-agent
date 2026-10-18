//! The opt-in loopback webhook listener for the desktop app: a port of
//! `apps/desktop/src/main/workflow-listener.ts`.
//!
//! Binds to 127.0.0.1 only and is off by default (Settings > experimental
//! `workflowLoopbackListener`, checked every five seconds). When on, it
//! serves `POST /api/hooks/:slug` with the same per-trigger secret (`?key=`),
//! 10 MB body cap and rate limit as the server edition, and hands validated
//! calls to the workflows (`workflow:webhook`, nekko-automation).

use crate::routes::Ctx;
use axum::Router;
use axum::body::to_bytes;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::watch;

const HOST: &str = "127.0.0.1";
const BODY_LIMIT: usize = 10 * 1024 * 1024;
const RATE_WINDOW: Duration = Duration::from_secs(60);
const RATE_LIMIT: u32 = 60;
const CHECK_EVERY: Duration = Duration::from_secs(5);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// `NEKKO_LOOPBACK_PORT`, else 1441 (`Number(...)`: anything unreadable binds nothing).
fn port() -> Option<u16> {
    match std::env::var("NEKKO_LOOPBACK_PORT") {
        Err(_) => Some(1441),
        Ok(v) => {
            let n = nekko_js::to_number(Some(&Value::String(v)));
            (n.fract() == 0.0 && (0.0..=65535.0).contains(&n)).then_some(n as u16)
        }
    }
}

/// The body as the workflow sees it: the JSON object with its raw text as
/// `__raw`, or `{ __raw }` alone for anything that is not an object.
pub fn parse_payload(raw: &str) -> Value {
    if let Ok(Value::Object(mut o)) = serde_json::from_str::<Value>(raw) {
        o.insert("__raw".into(), json!(raw));
        return Value::Object(o);
    }
    json!({ "__raw": raw })
}

/// Per `slug:ip` request counts in a one-minute window.
#[derive(Default)]
pub struct RateLimit {
    buckets: Mutex<HashMap<String, (u32, Instant)>>,
}

impl RateLimit {
    pub fn check(&self, key: &str, now: Instant) -> bool {
        let mut b = lock(&self.buckets);
        match b.get_mut(key) {
            Some((count, reset)) if now <= *reset => {
                if *count >= RATE_LIMIT {
                    return false;
                }
                *count += 1;
                true
            }
            _ => {
                b.insert(key.to_string(), (1, now + RATE_WINDOW));
                true
            }
        }
    }

    fn prune(&self, now: Instant) {
        lock(&self.buckets).retain(|_, (_, reset)| now <= *reset);
    }
}

#[derive(Clone)]
struct App {
    ctx: Ctx,
    rate: Arc<RateLimit>,
}

#[derive(Default)]
pub struct WebhookListener {
    running: Mutex<Option<watch::Sender<bool>>>,
    rate: Arc<RateLimit>,
    managed: Mutex<bool>,
}

fn enabled(settings: &Value) -> bool {
    nekko_js::truthy(settings.pointer("/experimental/workflowLoopbackListener"))
}

impl WebhookListener {
    /// Watch the experimental flag and start/stop the server as needed.
    pub fn manage(self: &Arc<Self>, ctx: Ctx) {
        if std::mem::replace(&mut *lock(&self.managed), true) {
            return;
        }
        let me = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut check = tokio::time::interval(CHECK_EVERY);
            let mut sweep = tokio::time::interval(RATE_WINDOW);
            sweep.tick().await;
            loop {
                tokio::select! {
                    _ = check.tick() => {
                        let Some(me) = me.upgrade() else { return };
                        if !*lock(&me.managed) { return }
                        let on = enabled(&crate::settings::current(&ctx).await);
                        if on { me.start(&ctx).await } else { me.stop() }
                    }
                    _ = sweep.tick() => {
                        let Some(me) = me.upgrade() else { return };
                        me.rate.prune(Instant::now());
                    }
                }
            }
        });
    }

    async fn start(&self, ctx: &Ctx) {
        if lock(&self.running).is_some() {
            return;
        }
        let Some(port) = port() else { return };
        let listener = match tokio::net::TcpListener::bind((HOST, port)).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[workflow-listener] loopback server error: {e}");
                return;
            }
        };
        let (stop, mut stopped) = watch::channel(false);
        let app = App { ctx: ctx.clone(), rate: self.rate.clone() };
        let router = Router::new().fallback(handle).with_state(app);
        eprintln!("[workflow-listener] listening on http://{HOST}:{port}");
        tokio::spawn(async move {
            let served = axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>())
                .with_graceful_shutdown(async move {
                    let _ = stopped.wait_for(|s| *s).await;
                })
                .await;
            if let Err(e) = served {
                eprintln!("[workflow-listener] loopback server error: {e}");
            }
        });
        *lock(&self.running) = Some(stop);
    }

    fn stop(&self) {
        if let Some(stop) = lock(&self.running).take() {
            let _ = stop.send(true);
            eprintln!("[workflow-listener] stopped");
        }
    }

    pub fn close(&self) {
        *lock(&self.managed) = false;
        self.stop();
    }
}

fn send(status: StatusCode, body: Value) -> Response {
    (status, axum::Json(body)).into_response()
}

async fn handle(State(app): State<App>, ConnectInfo(peer): ConnectInfo<SocketAddr>, req: Request) -> Response {
    if !enabled(&crate::settings::current(&app.ctx).await) {
        return send(StatusCode::SERVICE_UNAVAILABLE, json!({ "error": "workflow loopback listener is disabled" }));
    }
    let Ok(url) = url::Url::parse(&format!("http://{HOST}{}", req.uri())) else {
        return send(StatusCode::NOT_FOUND, json!({ "error": "not found" }));
    };
    let slug = url.path().strip_prefix("/api/hooks/").filter(|s| !s.is_empty() && !s.contains('/'));
    let (Some(slug), true) = (slug.map(str::to_string), req.method() == axum::http::Method::POST) else {
        return send(StatusCode::NOT_FOUND, json!({ "error": "not found" }));
    };
    let secret = url.query_pairs().find(|(k, _)| k == "key").map(|(_, v)| v.into_owned()).unwrap_or_default();
    if secret.is_empty() {
        return send(StatusCode::UNAUTHORIZED, json!({ "error": "missing key" }));
    }
    let ip = match peer.ip() {
        std::net::IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or_else(|| v6.to_string(), |v4| v4.to_string()),
        v4 => v4.to_string(),
    };
    if !app.rate.check(&format!("{slug}:{ip}"), Instant::now()) {
        return send(StatusCode::TOO_MANY_REQUESTS, json!({ "error": "rate limit exceeded" }));
    }
    // An empty body is refused like an oversized one, as the TS listener refused it.
    let body = to_bytes(req.into_body(), BODY_LIMIT).await.unwrap_or_default();
    if body.is_empty() {
        return send(StatusCode::PAYLOAD_TOO_LARGE, json!({ "error": "body too large" }));
    }
    let payload = parse_payload(&String::from_utf8_lossy(&body));
    match crate::routes::route(&app.ctx, "workflow:webhook", vec![json!(slug), json!(secret), payload]).await {
        Ok(runs) => send(StatusCode::OK, json!({ "started": runs.as_array().map_or(0, Vec::len) })),
        Err(e) if e == "unauthorized" || e.ends_with(": unauthorized") => {
            send(StatusCode::FORBIDDEN, json!({ "error": "unauthorized" }))
        }
        Err(e) => send(StatusCode::BAD_REQUEST, json!({ "error": e })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bodies_match_the_ts() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/desktop-features.json");
        let g: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        for case in g["webhookBodies"].as_array().unwrap() {
            let got = parse_payload(case["raw"].as_str().unwrap());
            assert_eq!(nekko_js::stringify(&got), nekko_js::stringify(&case["payload"]), "{}", case["raw"]);
        }
    }

    #[test]
    fn sixty_calls_a_minute_per_hook_and_caller() {
        let rate = RateLimit::default();
        let t = Instant::now();
        for _ in 0..60 {
            assert!(rate.check("a:127.0.0.1", t));
        }
        assert!(!rate.check("a:127.0.0.1", t));
        assert!(rate.check("b:127.0.0.1", t), "another hook has its own window");
        assert!(rate.check("a:127.0.0.1", t + RATE_WINDOW + Duration::from_millis(1)), "a new window");
        rate.prune(t + RATE_WINDOW * 3);
        assert!(lock(&rate.buckets).is_empty());
    }
}
