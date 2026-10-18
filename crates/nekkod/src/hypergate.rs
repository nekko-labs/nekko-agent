//! Hypergate discovery in the daemon (`mcp:hypergate`, `mcp:hypergate:connect`),
//! a port of `detectHypergate` / `resolveHypergate` in packages/host/src/mcp.ts.
//!
//! Hypergate (`hypergated`) runs and supervises local MCP servers behind one
//! gateway endpoint. Probing it and claiming this install's token are plain
//! loopback HTTP, so they run here, and so does saving the gateway as an MCP
//! entry (`with_hypergate`, a port of `withHypergate`); the daemon then brings
//! its tools online itself (`mcp:sync`).

use serde_json::{Map, Value, json};
use std::time::{Duration, Instant};

/// The port `hypergated` listens on unless it was told otherwise.
pub const DEFAULT_PORT: u16 = 7777;
/// `service` values a Hypergate daemon answers `/health` with.
const SERVICES: &[&str] = &["hypergated"];
const PROBE_BUDGET: Duration = Duration::from_millis(1500);
const TOKEN_BUDGET: Duration = Duration::from_millis(2500);

/// `hypergateBase(port)`: an explicit port wins; otherwise `HYPERGATE_URL`,
/// then `NEKKO_MCP_URL`, then the default port.
pub fn base(port: Option<u16>, env: impl Fn(&str) -> Option<String>) -> String {
    match port.filter(|p| *p != 0) {
        Some(p) => format!("http://localhost:{p}"),
        None => env("HYPERGATE_URL")
            .or_else(|| env("NEKKO_MCP_URL"))
            .unwrap_or_else(|| format!("http://localhost:{DEFAULT_PORT}")),
    }
}

/// `portOf(base)`.
fn port_of(base: &str) -> u16 {
    match reqwest::Url::parse(base) {
        Ok(u) => u.port().filter(|p| *p != 0).unwrap_or(if u.scheme() == "https" { 443 } else { 80 }),
        Err(_) => DEFAULT_PORT,
    }
}

/// A port as the UI passes it (a number, or nothing).
pub fn port_arg(v: &Value) -> Option<u16> {
    v.as_f64().filter(|p| p.fract() == 0.0 && *p > 0.0 && *p <= f64::from(u16::MAX)).map(|p| p as u16)
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().build().unwrap_or_default()
}

/// One request's body as JSON within what is left of `deadline`; `None` for
/// a timeout, a failed request or a body that does not parse (`res.json()`
/// throwing, which every caller catches).
async fn json_within(req: reqwest::RequestBuilder, deadline: Instant) -> Option<(bool, Value)> {
    let left = deadline.checked_duration_since(Instant::now())?;
    let run = async {
        let res = req.send().await.ok()?;
        let ok = res.status().is_success();
        let bytes = res.bytes().await.ok()?;
        serde_json::from_str::<Value>(&nekko_js::decode_text(&bytes)).ok().map(|v| (ok, v))
    };
    tokio::time::timeout(left, run).await.ok().flatten()
}

/// `detectHypergate(port)`: the gateway info of a running Hypergate, or
/// `None`. Reads only; never mints anything.
pub async fn detect(base: &str) -> Option<Map<String, Value>> {
    let http = client();
    let deadline = Instant::now() + PROBE_BUDGET;
    let (_, health) = json_within(http.get(format!("{base}/health")), deadline).await?;
    let service = health.get("service").and_then(Value::as_str).unwrap_or("");
    if !SERVICES.contains(&service) {
        return None;
    }
    let (_, gw) = json_within(http.get(format!("{base}/api/gateway")), deadline).await?;
    if gw.is_null() {
        return None;
    }
    let field = |v: &Value, k: &str| v.get(k).filter(|x| !x.is_null()).cloned();
    let mut info = Map::new();
    if let Some(url) = gw.get("url") {
        info.insert("url".into(), url.clone());
    }
    info.insert("uiUrl".into(), field(&gw, "uiUrl").unwrap_or_else(|| json!(format!("{base}/"))));
    info.insert("servers".into(), field(&health, "servers").unwrap_or(json!(0)));
    info.insert("version".into(), field(&health, "version").unwrap_or(json!("?")));
    info.insert("port".into(), json!(port_of(base)));
    Some(info)
}

/// `hypergateToken(base)`: this install's own agent token, or the gateway
/// token from a Hypergate that predates agents.
async fn token(base: &str) -> (Option<Value>, Option<Value>) {
    let http = client();
    let deadline = Instant::now() + TOKEN_BUDGET;
    let resolve =
        http.post(format!("{base}/api/clients/resolve")).json(&json!({ "key": "nekko-agent", "create": true }));
    if let Some((true, agent)) = json_within(resolve, deadline).await
        && nekko_js::truthy(agent.get("token"))
    {
        return (agent.get("token").cloned(), agent.get("name").cloned());
    }
    match json_within(http.get(format!("{base}/api/gateway")), deadline).await {
        Some((_, gw)) => (gw.get("token").cloned(), None),
        None => (None, None),
    }
}

/// `resolveHypergate(port)`: probe, then claim a token on it.
pub async fn resolve(base: &str) -> Option<Map<String, Value>> {
    let mut info = detect(base).await?;
    let (token, agent) = token(base).await;
    if let Some(t) = token {
        info.insert("token".into(), t);
    }
    if let Some(a) = agent {
        info.insert("agent".into(), a);
    }
    Some(info)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_explicit_port_wins_over_the_environment() {
        let env = |k: &str| (k == "HYPERGATE_URL").then(|| "http://127.0.0.1:9".to_string());
        assert_eq!(base(Some(1234), env), "http://localhost:1234");
        assert_eq!(base(None, env), "http://127.0.0.1:9");
        assert_eq!(base(None, |k: &str| (k == "NEKKO_MCP_URL").then(|| "http://x:1".to_string())), "http://x:1");
        assert_eq!(base(None, |_: &str| None), "http://localhost:7777");
        assert_eq!(port_of("http://localhost:1234"), 1234);
        assert_eq!(port_of("https://gate.example"), 443);
        assert_eq!(port_of("not a url"), 7777);
    }

    /// A Hypergate answering as a golden scenario says (null: a 404 without JSON).
    async fn scripted(s: Value) -> (u16, tokio::task::JoinHandle<()>) {
        use axum::http::StatusCode;
        use axum::routing::{get, post};
        let reply = |r: Value| {
            move || async move {
                match r.as_object() {
                    Some(o) => (
                        StatusCode::from_u16(o["status"].as_u64().unwrap() as u16).unwrap(),
                        [("content-type", "application/json")],
                        o["body"].as_str().unwrap().to_string(),
                    ),
                    None => (StatusCode::NOT_FOUND, [("content-type", "text/plain")], "not found".to_string()),
                }
            }
        };
        let app = axum::Router::new()
            .route("/health", get(reply(s["health"].clone())))
            .route("/api/gateway", get(reply(s["gateway"].clone())))
            .route("/api/clients/resolve", post(reply(s["resolve"].clone())));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        (port, tokio::spawn(async move { axum::serve(listener, app).await.unwrap() }))
    }

    fn normalize(v: Option<Map<String, Value>>, port: u16) -> Value {
        let text = nekko_js::stringify(&v.map_or(Value::Null, Value::Object))
            .replace(&format!("\"port\":{port}"), "\"port\":\"PORT\"")
            .replace(&port.to_string(), "PORT");
        serde_json::from_str(&text).unwrap()
    }

    /// The same answers give what the TS host's detect and resolve gave
    /// (`packages/host/src/hypergate.golden.test.ts`), key order included.
    #[tokio::test]
    async fn discovery_matches_the_ts_host() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/hypergate.json");
        let all: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert!(!all.is_empty());
        for s in all {
            let (port, server) = scripted(s.clone()).await;
            let b = base(Some(port), |_: &str| None);
            let detect = normalize(detect(&b).await, port);
            let resolved = normalize(resolve(&b).await, port);
            server.abort();
            assert_eq!(nekko_js::stringify(&detect), nekko_js::stringify(&s["detected"]), "detect: {}", s["name"]);
            assert_eq!(nekko_js::stringify(&resolved), nekko_js::stringify(&s["resolved"]), "resolve: {}", s["name"]);
        }
    }
}

/// `withHypergate(servers, info)`: the gateway's MCP entry put into a server
/// list, replacing an existing one (keeping the user's name for it) or
/// appended. Key order as JavaScript's spreads leave it; a field `info` lacks
/// is left out, as `undefined` is by `JSON.stringify`.
pub fn with_hypergate(servers: &[Value], info: &Value) -> Vec<Value> {
    let mut entry = Map::new();
    entry.insert("id".into(), json!(ENTRY_ID));
    entry.insert("name".into(), json!("Hypergate"));
    entry.insert("command".into(), json!(""));
    entry.insert("args".into(), json!([]));
    entry.insert("url".into(), info.get("url").cloned().unwrap_or(Value::Null));
    entry.insert("token".into(), info.get("token").cloned().unwrap_or(Value::Null));
    entry.insert("enabled".into(), json!(true));
    let undefined = |k: &str| info.get(k).is_none();
    let is_ours = |s: &Value| s.get("id").and_then(Value::as_str) == Some(ENTRY_ID);
    if !servers.iter().any(is_ours) {
        let mut entry = entry;
        entry.retain(|k, _| !(matches!(k.as_str(), "url" | "token") && undefined(k)));
        return servers.iter().cloned().chain(std::iter::once(Value::Object(entry))).collect();
    }
    servers
        .iter()
        .map(|s| {
            if !is_ours(s) {
                return s.clone();
            }
            let mut out = s.as_object().cloned().unwrap_or_default();
            for (k, v) in &entry {
                out.insert(k.clone(), v.clone());
            }
            let name = s.get("name").filter(|n| nekko_js::truthy(Some(n))).cloned().unwrap_or(json!("Hypergate"));
            out.insert("name".into(), name);
            out.retain(|k, _| !(matches!(k.as_str(), "url" | "token") && undefined(k)));
            Value::Object(out)
        })
        .collect()
}

/// The id of the MCP entry the gateway is saved as (`HYPERGATE_ENTRY_ID`).
pub const ENTRY_ID: &str = "hypergate";

#[cfg(test)]
mod with_hypergate_tests {
    use super::*;

    #[test]
    fn appends_or_replaces_the_gateway_entry_keeping_its_name() {
        let info = json!({ "url": "http://localhost:7777/mcp", "token": "t1" });
        let other = json!({ "id": "fs", "name": "Files", "command": "npx", "args": [], "enabled": true });
        let added = with_hypergate(std::slice::from_ref(&other), &info);
        assert_eq!(
            serde_json::to_string(&added[1]).unwrap(),
            r#"{"id":"hypergate","name":"Hypergate","command":"","args":[],"url":"http://localhost:7777/mcp","token":"t1","enabled":true}"#
        );
        let mine = json!({ "id": "hypergate", "name": "My gateway", "url": "old", "token": "t0", "enabled": false, "extra": 1 });
        let replaced = with_hypergate(&[other.clone(), mine], &info);
        assert_eq!(replaced[0], other);
        assert_eq!(
            serde_json::to_string(&replaced[1]).unwrap(),
            r#"{"id":"hypergate","name":"My gateway","url":"http://localhost:7777/mcp","token":"t1","enabled":true,"extra":1,"command":"","args":[]}"#
        );
    }
}
