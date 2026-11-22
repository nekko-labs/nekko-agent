//! Hypergate discovery in the daemon (`mcp:hypergate`, `mcp:hypergate:connect`),
//! a port of `detectHypergate` / `resolveHypergate` in packages/host/src/mcp.ts.
//!
//! Hypergate (`hypergated`) runs and supervises local MCP servers behind one
//! gateway endpoint. Probing it and claiming this install's token are plain
//! loopback HTTP, so they run here, and so does saving the gateway as an MCP
//! entry (`with_hypergate`, a port of `withHypergate`); the daemon then brings
//! its tools online itself (`mcp:sync`).

use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};
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
    /// (`tests/golden/hypergate.json`, a frozen record), key order included.
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

/// Where Hypergate's CLI could be: every PATH folder, then the folders its
/// installers use (the Windows setup, the macOS app, the Linux packages, npm).
/// A GUI app on macOS starts with a bare PATH, hence the fixed folders.
fn cli_candidates(env: &impl Fn(&str) -> Option<String>) -> Vec<PathBuf> {
    let names: &[&str] = if cfg!(windows) { &["hypergate.exe", "hypergate.cmd"] } else { &["hypergate"] };
    let mut dirs: Vec<PathBuf> = env("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    if cfg!(windows) {
        if let Some(local) = env("LOCALAPPDATA") {
            dirs.push(Path::new(&local).join("Programs").join("Hypergate"));
        }
        if let Some(roaming) = env("APPDATA") {
            dirs.push(Path::new(&roaming).join("npm"));
        }
    } else {
        dirs.push("/Applications/Hypergate.app/Contents/MacOS".into());
        if let Some(home) = env("HOME") {
            dirs.push(Path::new(&home).join("Applications/Hypergate.app/Contents/MacOS"));
            dirs.push(Path::new(&home).join(".npm-global/bin"));
            dirs.push(Path::new(&home).join(".local/bin"));
        }
        dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(PathBuf::from));
    }
    dirs.iter().flat_map(|d| names.iter().map(move |n| d.join(n))).collect()
}

/// The installed `hypergate` CLI, or `None` when it is not on this computer.
pub fn find_cli(env: impl Fn(&str) -> Option<String>, is_file: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    cli_candidates(&env).into_iter().find(|p| is_file(p))
}

/// `hypergate start --no-open`: brings the daemon up (a running one is left
/// alone) without opening a browser, since connecting opens the manager as a
/// tab here. Detached, so Hypergate outlives this daemon: it is the user's
/// own app, not something we started for a turn.
pub fn start(cli: &Path) -> Result<(), String> {
    use std::process::{Command, Stdio};
    let is_cmd = cli.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd"));
    let mut cmd = if is_cmd {
        // An npm shim only runs through cmd.exe.
        #[cfg_attr(not(windows), allow(unused_mut))]
        let mut c = Command::new(std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into()));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.raw_arg(format!("/d /s /c \"\"{}\" start --no-open\"", cli.display()));
        }
        c
    } else {
        let mut c = Command::new(cli);
        c.args(["start", "--no-open"]);
        c
    };
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        // Out of the daemon's kill-on-close job (procgroup.rs); a job above
        // ours that forbids breaking away refuses the flag, so retry inside.
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB);
        if cmd.spawn().is_ok() {
            return Ok(());
        }
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // A new session: out of the daemon's process group, so the sweep at
        // shutdown and the leftover reaper both leave it alone.
        // SAFETY: setsid is async-signal-safe and takes no arguments.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    cmd.spawn().map(|_| ()).map_err(|e| format!("Could not start Hypergate: {e}"))
}

/// After `start`, wait for the daemon to answer, up to `budget`.
pub async fn wait_until_up(base: &str, budget: Duration) -> Option<Map<String, Value>> {
    let deadline = Instant::now() + budget;
    loop {
        if let Some(info) = detect(base).await {
            return Some(info);
        }
        if Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

#[cfg(test)]
mod install_tests {
    use super::*;

    #[test]
    fn finds_the_cli_on_path_before_the_install_folders() {
        let sep = if cfg!(windows) { ";" } else { ":" };
        let path = format!("{}{sep}{}", Path::new("/a").display(), Path::new("/b").display());
        let env = |k: &str| match k {
            "PATH" => Some(path.clone()),
            "LOCALAPPDATA" => Some("/local".into()),
            "HOME" => Some("/home/me".into()),
            _ => None,
        };
        let exe = if cfg!(windows) { "hypergate.exe" } else { "hypergate" };
        let on_b = Path::new("/b").join(exe);
        assert_eq!(find_cli(env, |p| p == on_b), Some(on_b.clone()));
        let installed = if cfg!(windows) {
            Path::new("/local").join("Programs").join("Hypergate").join(exe)
        } else {
            PathBuf::from("/Applications/Hypergate.app/Contents/MacOS/hypergate")
        };
        assert_eq!(find_cli(env, |p| p == installed), Some(installed.clone()));
        assert_eq!(find_cli(env, |p| p == installed || p == on_b), Some(on_b));
        assert_eq!(find_cli(env, |_| false), None);
    }
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
