//! Settings > Connections (#1034): one switch for every connection the engine
//! makes or accepts, and a small activity log per connection.
//!
//! Every outbound request goes through [`send`] (or checks [`allowed`] and
//! calls [`record`] itself, for websockets, listeners and `git`). The daemon
//! calls [`configure`] whenever settings change and [`set_sink`] once, so each
//! event is also appended to `logs/connections.log`.
//!
//! Two rules:
//! - **All connections off** blocks every connection except to this computer
//!   (loopback), so local models and the UI keep working.
//! - A **blocked** connection is off everywhere, loopback included.
//!
//! An event records the time, method, host, path (never the query string),
//! status, bytes, duration and error. Never a body, header or token.

use serde_json::{Value, json};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Every connection id. The Settings list (`packages/shared/src/connections.ts`)
/// names each one; a test checks the two lists match.
pub const IDS: &[&str] = &[
    "updates",
    "model-lists",
    "skills-catalog",
    "skill-sources",
    "cloud-sync",
    "feedback",
    "phone-relay",
    "connected-computers",
    "local-relay",
    "network-visibility",
    "api-server",
    "model-server-lan",
    "webhook-listener",
    "models",
    "decide",
    "limits",
    "sign-in",
    "model-providers",
    "connectors",
    "github",
    "telegram",
    "web-tools",
    "mcp",
    "resource-queue",
    "browser-pane",
    "telemetry",
];

/// Events kept in memory per connection; the file keeps more.
pub const RECENT: usize = 200;
/// Hourly buckets kept for the "last 24 hours" counts.
const HOURS: usize = 24;
/// An error message is cut to this many characters.
const ERROR_CHARS: usize = 300;

/// `(hour since the epoch, contacts, errors, blocked)`.
type Hour = (u64, u32, u32, u32);

/// Where each event line is also written.
type Sink = Box<dyn Fn(&str) + Send + Sync>;

#[derive(Default)]
struct State {
    all_off: bool,
    blocked: HashSet<String>,
    recent: HashMap<String, VecDeque<Value>>,
    /// Oldest first.
    hours: HashMap<String, VecDeque<Hour>>,
    sink: Option<Sink>,
}

fn state() -> std::sync::MutexGuard<'static, State> {
    static S: OnceLock<Mutex<State>> = OnceLock::new();
    S.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Apply `settings.connections` (`{ allOff, blocked }`).
pub fn configure(connections: &Value) {
    let mut s = state();
    s.all_off = connections["allOff"].as_bool().unwrap_or(false);
    s.blocked = connections["blocked"]
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect())
        .unwrap_or_default();
}

/// Whether All connections off is on.
pub fn all_off() -> bool {
    state().all_off
}

/// May `id` reach `host` now? `None` for a listener or anything off this
/// computer; a loopback host stays allowed under All connections off.
pub fn allowed_to(id: &str, host: Option<&str>) -> bool {
    let s = state();
    if s.blocked.contains(id) {
        return false;
    }
    !s.all_off || host.is_some_and(is_loopback)
}

/// May `id` connect off this computer (or listen beyond it) now?
pub fn allowed(id: &str) -> bool {
    allowed_to(id, None)
}

/// The error a blocked connection reports.
pub fn blocked_message(id: &str) -> String {
    if state().blocked.contains(id) {
        format!("{id} is switched off in Settings > Connections")
    } else {
        "All connections are off in Settings > Connections".into()
    }
}

pub fn is_loopback(host: &str) -> bool {
    let h = host.trim_start_matches('[').trim_end_matches(']');
    h.eq_ignore_ascii_case("localhost") || h.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

/// Where each event line goes as well (the daemon's `logs/connections.log`).
pub fn set_sink(sink: impl Fn(&str) + Send + Sync + 'static) {
    state().sink = Some(Box::new(sink));
}

/// What happened, for [`record`]. `kind` is `request`, `connect`, `listen`,
/// `close` or `blocked`.
#[derive(Default, Clone)]
pub struct Event {
    pub kind: &'static str,
    pub method: Option<String>,
    pub host: Option<String>,
    pub path: Option<String>,
    pub status: Option<u16>,
    pub bytes: Option<u64>,
    pub ms: Option<u64>,
    pub error: Option<String>,
}

impl Event {
    pub fn new(kind: &'static str) -> Event {
        Event { kind, ..Default::default() }
    }
    pub fn host(mut self, host: impl Into<String>) -> Event {
        self.host = Some(host.into());
        self
    }
    pub fn error(mut self, error: impl std::fmt::Display) -> Event {
        self.error = Some(error.to_string().chars().take(ERROR_CHARS).collect());
        self
    }
}

/// Add an event to `id`'s log.
pub fn record(id: &str, ev: Event) {
    let mut line = json!({ "at": now_ms(), "id": id, "kind": ev.kind });
    for (k, v) in [("method", ev.method), ("host", ev.host), ("path", ev.path), ("error", ev.error)] {
        if let Some(v) = v {
            line[k] = json!(v);
        }
    }
    for (k, v) in [("status", ev.status.map(u64::from)), ("bytes", ev.bytes), ("ms", ev.ms)] {
        if let Some(v) = v {
            line[k] = json!(v);
        }
    }
    let mut s = state();
    if let Some(sink) = &s.sink {
        sink(&line.to_string());
    }
    push(&mut s, line);
}

/// Put an event (live, or a line read back from the file at startup) in memory.
fn push(s: &mut State, line: Value) {
    let Some(id) = line["id"].as_str().map(String::from) else { return };
    let hour = line["at"].as_u64().unwrap_or(0) / 3_600_000;
    let failed = line["error"].is_string() || line["status"].as_u64().is_some_and(|c| c >= 400);
    let blocked = line["kind"] == "blocked";
    let hours = s.hours.entry(id.clone()).or_default();
    match hours.back_mut() {
        Some(b) if b.0 == hour => {}
        _ => hours.push_back((hour, 0, 0, 0)),
    }
    let b = hours.back_mut().expect("pushed above");
    b.1 += 1;
    b.2 += u32::from(failed && !blocked);
    b.3 += u32::from(blocked);
    while hours.len() > HOURS {
        hours.pop_front();
    }
    let recent = s.recent.entry(id).or_default();
    recent.push_back(line);
    while recent.len() > RECENT {
        recent.pop_front();
    }
}

/// Load events written by an earlier run (`connections.log` lines, oldest first).
pub fn restore(lines: &str) {
    let mut s = state();
    for line in lines.lines() {
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            push(&mut s, v);
        }
    }
}

/// Per connection: `{ id, lastAt, count24h, errors24h, blocked24h, allowed }`.
pub fn summary() -> Value {
    let hour = now_ms() / 3_600_000;
    let s = state();
    let rows: Vec<Value> = IDS
        .iter()
        .map(|id| {
            let (mut count, mut errors, mut blocked) = (0, 0, 0);
            for b in s.hours.get(*id).into_iter().flatten().filter(|b| b.0 + HOURS as u64 > hour) {
                count += b.1;
                errors += b.2;
                blocked += b.3;
            }
            let last = s.recent.get(*id).and_then(|r| r.back()).map(|e| e["at"].clone());
            json!({
                "id": id,
                "lastAt": last,
                "count24h": count,
                "errors24h": errors,
                "blocked24h": blocked,
                "allowed": !s.blocked.contains(*id) && !s.all_off,
            })
        })
        .collect();
    json!({ "allOff": s.all_off, "connections": rows })
}

/// `id`'s events in memory, newest first.
pub fn recent(id: &str, limit: usize) -> Vec<Value> {
    state().recent.get(id).map(|r| r.iter().rev().take(limit).cloned().collect()).unwrap_or_default()
}

/// Forget every event in memory (the daemon also empties the file).
pub fn clear() {
    let mut s = state();
    s.recent.clear();
    s.hours.clear();
}

/// The error [`send`] returns.
#[derive(Debug)]
pub enum Error {
    /// The connection is switched off; nothing was sent.
    Blocked(String),
    Http(reqwest::Error),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Blocked(m) => f.write_str(m),
            Error::Http(e) => e.fmt(f),
        }
    }
}

impl std::error::Error for Error {}

impl Error {
    pub fn is_blocked(&self) -> bool {
        matches!(self, Error::Blocked(_))
    }
    pub fn is_timeout(&self) -> bool {
        matches!(self, Error::Http(e) if e.is_timeout())
    }
}

/// Check the switch, send, and log the request as `id`.
pub async fn send(id: &str, rb: reqwest::RequestBuilder) -> Result<reqwest::Response, Error> {
    let (client, req) = rb.build_split();
    let req = req.map_err(Error::Http)?;
    let url = req.url();
    let mut ev = Event::new("request").host(url.host_str().unwrap_or_default());
    ev.method = Some(req.method().to_string());
    ev.path = Some(scrub_path(url.path()));
    if !allowed_to(id, url.host_str()) {
        let msg = blocked_message(id);
        ev.kind = "blocked";
        record(id, ev);
        return Err(Error::Blocked(msg));
    }
    let start = Instant::now();
    let res = client.execute(req).await;
    ev.ms = Some(elapsed_ms(start.elapsed()));
    match res {
        Ok(r) => {
            ev.status = Some(r.status().as_u16());
            ev.bytes = r.content_length();
            record(id, ev);
            Ok(r)
        }
        Err(e) => {
            record(id, ev.error(&e));
            Err(Error::Http(e))
        }
    }
}

/// A path with secret-looking segments hidden: Telegram's `bot<id>:<token>`,
/// and any long run of letters and digits (a key or token in the path).
pub fn scrub_path(path: &str) -> String {
    path.split('/')
        .map(|seg| {
            let tokenish = seg.len() >= 24 && seg.chars().all(|c| c.is_ascii_alphanumeric() || "-_:".contains(c));
            if tokenish || (seg.starts_with("bot") && seg.contains(':')) { "…" } else { seg }
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn elapsed_ms(d: Duration) -> u64 {
    d.as_millis().min(u64::MAX as u128) as u64
}

/// Check the switch for a connection made without [`send`] (a websocket,
/// `git`, a child process), logging a blocked attempt. `host` is where it goes.
pub fn check(id: &str, host: &str) -> Result<(), String> {
    if allowed_to(id, Some(host)) {
        return Ok(());
    }
    record(id, Event::new("blocked").host(host));
    Err(blocked_message(id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_id_is_named_in_settings() {
        let ts = include_str!("../../../packages/shared/src/connections.ts");
        let named: Vec<&str> = ts.split("{ id: '").skip(1).filter_map(|s| s.split('\'').next()).collect();
        let groups = ["background", "listener", "onDemand"];
        let named: Vec<&str> = named.into_iter().filter(|n| !groups.contains(n)).collect();
        assert_eq!(named.len(), IDS.len(), "{named:?}");
        for id in IDS {
            assert!(named.contains(id), "{id} is missing from connections.ts");
        }
    }

    // One test: the state is process-wide.
    #[tokio::test]
    async fn the_switch_blocks_logs_and_spares_loopback() {
        configure(&json!({ "allOff": true }));
        assert!(!allowed("updates"));
        assert!(allowed_to("model-providers", Some("127.0.0.1")));
        assert!(allowed_to("model-providers", Some("[::1]")));
        assert!(!allowed_to("model-providers", Some("api.openai.com")));

        let rb = reqwest::Client::new().get("https://example.com/a?token=secret");
        let err = send("updates", rb).await.unwrap_err();
        assert!(err.is_blocked());
        let ev = &recent("updates", 1)[0];
        assert_eq!(ev["kind"], "blocked");
        assert_eq!(ev["path"], "/a");
        assert!(!ev.to_string().contains("secret"), "the query string is never logged");

        configure(&json!({ "allOff": false, "blocked": ["mcp"] }));
        assert!(allowed("updates"));
        assert!(!allowed_to("mcp", Some("localhost")), "a blocked connection is blocked on loopback too");
        assert!(check("mcp", "localhost").unwrap_err().contains("mcp is switched off"));

        let sum = summary();
        let row = sum["connections"].as_array().unwrap().iter().find(|r| r["id"] == "updates").unwrap();
        assert_eq!(row["count24h"], 1);
        assert_eq!(row["blocked24h"], 1);

        for _ in 0..RECENT + 5 {
            record("github", Event::new("request").host("api.github.com"));
        }
        assert_eq!(recent("github", 1000).len(), RECENT);

        assert_eq!(scrub_path("/bot123456:AAH-secret/getUpdates"), "/…/getUpdates");
        assert_eq!(scrub_path("/v1/keys/k0123456789abcdefghijklmnop"), "/v1/keys/…");
        assert_eq!(scrub_path("/api/models/Qwen/Qwen3-8B-GGUF"), "/api/models/Qwen/Qwen3-8B-GGUF");

        clear();
        restore(&format!(
            "{}\nnot json\n",
            json!({ "at": now_ms(), "id": "telegram", "kind": "request", "status": 500 })
        ));
        let sum = summary();
        let row = sum["connections"].as_array().unwrap().iter().find(|r| r["id"] == "telegram").unwrap();
        assert_eq!(row["errors24h"], 1);
    }
}
