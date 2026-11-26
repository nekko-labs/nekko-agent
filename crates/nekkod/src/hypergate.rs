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

/// A paired gateway stays the credential route even if its daemon is temporarily offline.
pub fn enabled(settings: &Value) -> bool {
    settings["mcpServers"].as_array().is_some_and(|servers| {
        servers
            .iter()
            .any(|server| server["id"].as_str() == Some(ENTRY_ID) && server["enabled"].as_bool() == Some(true))
    })
}

#[cfg(test)]
mod with_hypergate_tests {
    use super::*;

    #[test]
    fn github_routing_uses_the_enabled_pairing_not_its_display_name() {
        assert!(enabled(&json!({"mcpServers": [{"id":"hypergate", "name":"My gateway", "enabled":true}]})));
        assert!(!enabled(
            &json!({"mcpServers": [{"id":"hypergate", "enabled":false}, {"id":"other", "name":"Hypergate", "enabled":true}]})
        ));
        assert!(!enabled(&json!({})));
    }

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

// ── Update migration: bring a saved gateway entry forward ─────────────────────
//
// An install that paired with Hypergate before the renames can hold an entry
// named after the old product ("NekkoMCP gateway") with no token (from before
// scoped agent tokens), and Hypergate may know this app as "Kotrain". Such an
// entry reaches nothing: the gateway refuses it. At start the daemon renames
// the entry and re-claims this install's own agent token, without asking and
// without minting: a user who removed the agent in Hypergate stays removed.

/// Names the gateway entry was saved under before it was "Hypergate".
const LEGACY_ENTRY_NAMES: &[&str] = &["NekkoMCP gateway", "NekkoMCP", "Nekko MCP gateway", "Nekko MCP"];

/// The keys Hypergate may know this app by: today's first, then its earlier names.
const AGENT_KEYS: &[&str] = &["nekko-agent", "kotrain", "agent-nekko", "nekkos", "open-paw"];

/// This install's existing agent token, found under any name it has had, or
/// `None`. Never creates an agent and never falls back to the master gateway
/// token. Stops at an ambiguous key rather than pick between two agents.
async fn reclaim(base: &str) -> Option<Value> {
    let http = client();
    let deadline = Instant::now() + TOKEN_BUDGET;
    for key in AGENT_KEYS {
        let req = http.post(format!("{base}/api/clients/resolve")).json(&json!({ "key": key, "create": false }));
        match json_within(req, deadline).await {
            Some((true, agent)) if nekko_js::truthy(agent.get("token")) => return agent.get("token").cloned(),
            Some((_, answer)) if answer.get("error").and_then(Value::as_str) == Some("ambiguous") => return None,
            Some(_) => continue,
            None => return None,
        }
    }
    None
}

/// The saved entry brought forward, or `None` when nothing changes: a legacy
/// name becomes "Hypergate" (a name the user chose is kept), and the gateway's
/// current URL and this install's token replace stale ones. `enabled` and any
/// other field are left as the user had them.
pub fn heal_entry(entry: &Value, gateway_url: Option<&Value>, token: Option<&Value>) -> Option<Value> {
    let mut out = entry.as_object()?.clone();
    let mut changed = false;
    if out.get("name").and_then(Value::as_str).is_some_and(|n| LEGACY_ENTRY_NAMES.contains(&n)) {
        out.insert("name".into(), json!("Hypergate"));
        changed = true;
    }
    for (key, value) in [("url", gateway_url), ("token", token)] {
        if let Some(v) = value.filter(|v| nekko_js::truthy(Some(v)))
            && out.get(key) != Some(v)
        {
            out.insert(key.into(), v.clone());
            changed = true;
        }
    }
    changed.then_some(Value::Object(out))
}

/// What one pass of [`heal_saved`] found.
#[derive(Debug, PartialEq)]
pub enum Healed {
    /// No gateway entry saved: nothing to do, now or later.
    NoEntry,
    /// The entry is current (or was just brought forward).
    Done,
    /// Hypergate did not answer; worth trying again once it is up.
    NotAnswering,
}

/// One pass of the update migration over the saved gateway entry.
pub async fn heal_saved(ctx: &crate::routes::Ctx) -> Healed {
    let settings = crate::settings::current(ctx).await;
    let Some(list) = settings.get("mcpServers").and_then(Value::as_array).cloned() else { return Healed::NoEntry };
    let Some(idx) = list.iter().position(|s| s.get("id").and_then(Value::as_str) == Some(ENTRY_ID)) else {
        return Healed::NoEntry;
    };
    let port =
        list[idx].get("url").and_then(Value::as_str).and_then(|u| reqwest::Url::parse(u).ok()).and_then(|u| u.port());
    let base = base(port, |k| std::env::var(k).ok());
    let info = detect(&base).await;
    let (url, token) = match &info {
        Some(info) => (info.get("url").cloned(), reclaim(&base).await),
        None => (None, None),
    };
    let had_token = nekko_js::truthy(list[idx].get("token"));
    if let Some(healed) = heal_entry(&list[idx], url.as_ref(), token.as_ref()) {
        let mut next = list.clone();
        next[idx] = healed;
        match crate::settings::update(ctx, json!({ "mcpServers": next })).await {
            Ok(saved) => {
                eprintln!("[migrate] brought the saved Hypergate gateway entry forward");
                ctx.mcp.sync(saved.get("mcpServers").unwrap_or(&json!([]))).await;
            }
            Err(e) => eprintln!("[migrate] could not update the Hypergate entry: {e}"),
        }
    }
    // A tokenless entry is only finished once Hypergate has answered.
    if info.is_none() && !had_token { Healed::NotAnswering } else { Healed::Done }
}

/// How often, and how many times, start-up retries while Hypergate is not up
/// yet (both start at login, in no particular order).
const HEAL_EVERY: Duration = Duration::from_secs(30);
const HEAL_TRIES: u32 = 20;

/// The update migration, run once at daemon start (boot.rs).
pub fn start_migration(ctx: &crate::routes::Ctx) {
    let ctx = ctx.clone();
    tokio::spawn(async move {
        for _ in 0..HEAL_TRIES {
            if heal_saved(&ctx).await != Healed::NotAnswering {
                return;
            }
            tokio::time::sleep(HEAL_EVERY).await;
        }
    });
}

#[cfg(test)]
mod heal_tests {
    use super::*;

    #[test]
    fn renames_a_legacy_entry_and_fills_in_the_token_keeping_the_rest() {
        let old = json!({ "id": "hypergate", "name": "NekkoMCP gateway", "url": "http://localhost:7777/mcp", "enabled": false, "command": "", "args": [] });
        let healed = heal_entry(&old, Some(&json!("http://localhost:7777/mcp")), Some(&json!("t-agent"))).unwrap();
        assert_eq!(healed["name"], "Hypergate");
        assert_eq!(healed["token"], "t-agent");
        assert_eq!(healed["enabled"], false, "the user's switch is theirs");
        assert_eq!(healed["url"], "http://localhost:7777/mcp");
    }

    #[test]
    fn keeps_a_name_the_user_chose_and_changes_nothing_when_current() {
        let mine = json!({ "id": "hypergate", "name": "My gateway", "url": "http://localhost:7777/mcp", "token": "t1", "enabled": true });
        assert_eq!(heal_entry(&mine, Some(&json!("http://localhost:7777/mcp")), Some(&json!("t1"))), None);
        // Hypergate not answering: no URL or token to offer, nothing to change.
        assert_eq!(heal_entry(&mine, None, None), None);
        // Only the name can be brought forward without Hypergate.
        let old = json!({ "id": "hypergate", "name": "NekkoMCP", "url": "http://localhost:7777/mcp" });
        assert_eq!(heal_entry(&old, None, None).unwrap()["name"], "Hypergate");
    }

    #[test]
    fn follows_a_moved_gateway_and_a_rotated_token() {
        let saved =
            json!({ "id": "hypergate", "name": "Hypergate", "url": "http://localhost:7777/mcp", "token": "old" });
        let healed = heal_entry(&saved, Some(&json!("http://localhost:7799/mcp")), Some(&json!("new"))).unwrap();
        assert_eq!(
            (healed["url"].as_str(), healed["token"].as_str()),
            (Some("http://localhost:7799/mcp"), Some("new"))
        );
    }

    /// A Hypergate that knows this app only as "Kotrain" (one that predates
    /// its own rename migration) still hands back the existing token, and
    /// nothing is created along the way.
    #[tokio::test]
    async fn reclaims_the_token_under_an_earlier_name_without_creating_one() {
        use axum::{Json, Router, routing::post};
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
        let log = seen.clone();
        let app = Router::new().route(
            "/api/clients/resolve",
            post(move |Json(body): Json<Value>| {
                let log = log.clone();
                async move {
                    log.lock().unwrap().push(body.clone());
                    if body["key"] == "kotrain" {
                        (
                            axum::http::StatusCode::OK,
                            Json(json!({ "id": "kotrain-0fd8", "name": "Kotrain", "token": "t-old-agent" })),
                        )
                    } else {
                        (axum::http::StatusCode::NOT_FOUND, Json(json!({ "error": "not_found" })))
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let token = reclaim(&format!("http://127.0.0.1:{port}")).await;
        server.abort();
        assert_eq!(token, Some(json!("t-old-agent")));
        let asked = seen.lock().unwrap().clone();
        assert_eq!(asked.iter().map(|b| b["key"].as_str().unwrap()).collect::<Vec<_>>(), ["nekko-agent", "kotrain"]);
        assert!(asked.iter().all(|b| b["create"] == false), "a migration never mints an agent");
    }

    #[tokio::test]
    async fn stops_at_an_ambiguous_key() {
        use axum::{Json, Router, routing::post};
        let app = Router::new().route(
            "/api/clients/resolve",
            post(|| async {
                (axum::http::StatusCode::CONFLICT, Json(json!({ "error": "ambiguous", "ids": ["a", "b"] })))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let token = reclaim(&format!("http://127.0.0.1:{port}")).await;
        server.abort();
        assert_eq!(token, None);
    }
}
