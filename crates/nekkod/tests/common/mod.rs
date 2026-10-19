//! Shared rig for the nekkod end-to-end tests: the real `nekkod` binary, a
//! scripted OpenAI-compatible model, an event recorder, socket helpers, port
//! allocation, and the waits (`until` and friends) that poll for a condition
//! with a deadline.
//!
//! Included by `daemon/main.rs` (`#[path]`), so a new domain module there gets
//! all of it with `use crate::common::*;`.

pub use futures_util::{SinkExt, StreamExt};
pub use serde_json::{Value, json};
pub use std::io::{BufRead, BufReader};
pub use std::process::{Child, Command, Stdio};
pub use std::time::{Duration, Instant};
pub use tokio_tungstenite::tungstenite::Message;
pub use tokio_tungstenite::tungstenite::client::IntoClientRequest;

pub const TOKEN: &str = "test-token-0123456789abcdef";

pub struct Daemon {
    pub child: Child,
    pub port: u16,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

pub fn start() -> Daemon {
    start_with(None)
}

pub fn start_with(data_dir: Option<&std::path::Path>) -> Daemon {
    start_with_config(data_dir, json!({}))
}

pub fn start_with_config(data_dir: Option<&std::path::Path>, extra: Value) -> Daemon {
    start_with_env(data_dir, extra, &[])
}

/// With the daemon's own environment changed: `(name, None)` removes a variable.
pub fn start_with_env(data_dir: Option<&std::path::Path>, extra: Value, env: &[(&str, Option<&str>)]) -> Daemon {
    let mut config = json!({ "token": TOKEN, "allowedOrigins": ["null"], "dataDir": data_dir });
    for (k, v) in extra.as_object().cloned().unwrap_or_default() {
        config[k] = v;
    }
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_nekkod"));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    for (k, v) in env {
        match v {
            Some(v) => cmd.env(k, v),
            None => cmd.env_remove(k),
        };
    }
    let mut child = cmd
        .env("NEKKOD_CONFIG", config.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("nekkod starts");
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let line = lines.next().expect("a ready line").unwrap();
    let ready: Value = serde_json::from_str(line.strip_prefix("NEKKOD_READY ").expect("ready prefix")).unwrap();
    std::thread::spawn(move || for _ in lines {});
    Daemon { child, port: ready["port"].as_u64().unwrap() as u16 }
}

pub async fn post(port: u16, channel: &str, args: Value, token: Option<&str>) -> (u16, Value) {
    let mut req =
        reqwest::Client::new().post(format!("http://127.0.0.1:{port}/api/{channel}")).json(&json!({ "args": args }));
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    let res = req.send().await.unwrap();
    let status = res.status().as_u16();
    (status, res.json().await.unwrap_or(Value::Null))
}

pub type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Connect, or say why not (as a string: tungstenite's error type is large).
pub async fn ws(port: u16, path: &str, origin: Option<&str>) -> Result<Socket, String> {
    let mut req = format!("ws://127.0.0.1:{port}{path}").into_client_request().unwrap();
    if let Some(o) = origin {
        req.headers_mut().insert("origin", o.parse().unwrap());
    }
    tokio_tungstenite::connect_async(req).await.map(|(s, _)| s).map_err(|e| e.to_string())
}

pub async fn next_json<S>(socket: &mut S, limit: Duration) -> Option<Value>
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    let deadline = Instant::now() + limit;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match tokio::time::timeout(left, socket.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => return serde_json::from_str(t.as_str()).ok(),
            Ok(Some(Ok(_))) => continue,
            _ => return None,
        }
    }
}

/// A scripted OpenAI-compatible model on an ephemeral loopback port: each
/// request takes the next reply (server-sent events), or hangs when the
/// script says so. No credentials, user files or paid model are involved.
pub struct ScriptedModel {
    pub port: u16,
    pub requests: std::sync::Arc<std::sync::Mutex<Vec<Value>>>,
    pub server: tokio::task::JoinHandle<()>,
}

impl Drop for ScriptedModel {
    fn drop(&mut self) {
        self.server.abort();
    }
}

pub fn sse(chunks: &[Value]) -> String {
    let mut out: String = chunks.iter().map(|c| format!("data: {c}\n\n")).collect();
    out.push_str("data: [DONE]\n\n");
    out
}

pub fn say_text(text: &str) -> String {
    sse(&[json!({
        "choices": [{ "delta": { "content": text }, "finish_reason": "stop" }],
        "usage": { "prompt_tokens": 10, "completion_tokens": 3 }
    })])
}

pub fn call_tool(id: &str, name: &str, args: Value) -> String {
    sse(&[json!({ "choices": [{
        "delta": { "tool_calls": [{ "index": 0, "id": id, "type": "function", "function": { "name": name, "arguments": args.to_string() } }] },
        "finish_reason": "tool_calls"
    }] })])
}

pub const HANG: &str = "hang";

/// A step that fails the request with this status and an OpenAI-style error body.
pub fn http_error(status: u16, message: &str) -> String {
    format!("status:{status}\n{}", json!({ "error": { "message": message } }))
}

pub async fn scripted_model(script: Vec<String>) -> ScriptedModel {
    scripted_model_with_titles(script, None).await
}

pub async fn scripted_model_with_titles(
    script: Vec<String>,
    titles: Option<std::sync::Arc<tokio::sync::Mutex<tokio::sync::mpsc::UnboundedReceiver<String>>>>,
) -> ScriptedModel {
    use axum::routing::post as route_post;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let script = std::sync::Arc::new(std::sync::Mutex::new(std::collections::VecDeque::from(script)));
    let seen = requests.clone();
    let app = axum::Router::new().route(
        "/v1/chat/completions",
        route_post(move |axum::Json(request): axum::Json<Value>| {
            let (seen, script, titles) = (seen.clone(), script.clone(), titles.clone());
            async move {
                // Title calls are answered by content, so their timing never shifts the script.
                let titling = request["messages"].as_array().is_some_and(|m| {
                    m.iter()
                        .any(|m| m["content"].as_str().is_some_and(|c| c.starts_with("Give this task a short title")))
                });
                seen.lock().unwrap().push(request);
                let next = if titling {
                    match titles {
                        Some(titles) => titles.lock().await.recv().await.expect("release the held title response"),
                        None => say_text("\"Login bug fix.\""),
                    }
                } else {
                    script.lock().unwrap().pop_front().unwrap_or_else(|| say_text("(script ended)"))
                };
                if let Some(rest) = next.strip_prefix("status:") {
                    let (code, body) = rest.split_once('\n').unwrap_or((rest, ""));
                    return axum::response::Response::builder()
                        .status(code.parse::<u16>().unwrap())
                        .header("content-type", "application/json")
                        .body(axum::body::Body::from(body.to_string()))
                        .unwrap();
                }
                let body = if next == HANG {
                    let first = futures_util::stream::once(async {
                        Ok::<_, std::io::Error>(bytes::Bytes::from_static(b": waiting\n\n"))
                    });
                    axum::body::Body::from_stream(first.chain(futures_util::stream::pending()))
                } else {
                    axum::body::Body::from(next)
                };
                axum::response::Response::builder().header("content-type", "text/event-stream").body(body).unwrap()
            }
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    ScriptedModel { port, requests, server }
}

pub struct TurnRig {
    pub data: std::path::PathBuf,
    pub workspace: std::path::PathBuf,
    pub d: Daemon,
    /// Every agent event the daemon published since the rig started.
    pub events: Events,
}

impl Drop for TurnRig {
    fn drop(&mut self) {
        let _ = self.d.child.kill();
        let _ = self.d.child.wait();
        let _ = std::fs::remove_dir_all(&self.data);
    }
}

pub fn turn_rig(name: &str, session: Value) -> TurnRig {
    turn_rig_with(name, session, json!({}))
}

pub fn turn_rig_with(name: &str, session: Value, extra: Value) -> TurnRig {
    let data = std::env::temp_dir().join(format!("nekkod-turn-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    let workspace = data.join("project");
    std::fs::create_dir_all(data.join("sessions")).unwrap();
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("app.ts"), "export const secret = 'pineapple';\n").unwrap();
    std::fs::write(workspace.join("AGENTS.md"), "Always run the tests.\n").unwrap();
    let id = session["id"].as_str().unwrap().to_string();
    std::fs::write(data.join("sessions").join(format!("{id}.json")), serde_json::to_string_pretty(&session).unwrap())
        .unwrap();
    let d = start_with_config(Some(&data), extra);
    let events = record_events(d.port);
    boot_settled(&data);
    TurnRig { data, workspace, d, events }
}

/// Replace the rig's settings, as writing settings.json before launch would:
/// through the daemon, which caches the file from its first read.
pub async fn write_settings(rig: &TurnRig, settings: Value) {
    let (status, body) = post(rig.d.port, "settings:reset", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{body}");
    let (status, body) = post(rig.d.port, "settings:update", json!([settings]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{body}");
}

/// Wait out the daemon's launch work on settings.json (boot.rs adds the
/// model server's provider entry), so a test that writes the file itself is
/// not overwritten by it.
pub fn boot_settled(data: &std::path::Path) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !std::fs::read_to_string(data.join("settings.json")).is_ok_and(|s| s.contains("\"llamacpp\"")) {
        assert!(Instant::now() < deadline, "the daemon never added its engine provider");
        std::thread::sleep(POLL);
    }
}

pub fn turn_spec(rig: &TurnRig, model: &ScriptedModel, turn_id: &str, session_id: &str, extra_opts: Value) -> Value {
    let provider = json!({
        "id": "p1", "kind": "openai-compat", "label": "Scripted", "enabled": true,
        "baseUrl": format!("http://127.0.0.1:{}/v1", model.port),
    });
    let mut opts =
        json!({ "sessionId": session_id, "providerId": "p1", "modelId": "synthetic", "text": "Fix the bug" });
    for (k, v) in extra_opts.as_object().unwrap() {
        opts[k] = v.clone();
    }
    json!({
        "turnId": turn_id,
        "opts": opts,
        "allowBrowserControl": false,
        "settings": { "providers": [provider], "defaultChatMode": "yolo", "unattendedQuestionMinutes": 0 },
        "facts": {
            "workspaces": [{ "id": "w1", "name": "project", "path": rig.workspace.to_string_lossy() }],
            "mcpTools": [], "decide": false,
            "connectorSnippets": [], "indexSnippets": [],
            "platform": "win32", "temperature": 0.7, "effort": "normal", "statsEffort": "normal",
            "promptCaching": true, "provider": provider, "headers": false,
        },
    })
}

/// How often a wait below looks again. Short, so a test moves on as soon as
/// its condition holds; every wait has its own deadline.
pub const POLL: Duration = Duration::from_millis(10);

/// Poll an async check until it yields a value, or panic with `what` (and the
/// last thing `show` was given) once `limit` passes. The one way these tests
/// wait for something the daemon does on its own time: never a fixed sleep.
pub async fn until<T, F, Fut>(what: &str, limit: Duration, mut check: F) -> T
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Option<T>>,
{
    let deadline = Instant::now() + limit;
    loop {
        if let Some(v) = check().await {
            return v;
        }
        assert!(Instant::now() < deadline, "timed out after {limit:?} waiting for {what}");
        tokio::time::sleep(POLL).await;
    }
}

/// A chat's agent command log (its `agent_<id>` terminal), once it shows `needle`.
pub async fn until_agent_log(port: u16, session_id: &str, needle: &str, limit: Duration) -> String {
    let id = format!("agent_{session_id}");
    until(&format!("{needle:?} in the agent log"), limit, || {
        let id = id.clone();
        async move {
            let (_, snap) = post(port, "terminal:snapshot", json!([id]), Some(TOKEN)).await;
            snap["buffer"].as_str().filter(|b| b.contains(needle)).map(str::to_string)
        }
    })
    .await
}

/// The agent events a daemon publishes, as its UI hears them.
pub type Events = std::sync::Arc<std::sync::Mutex<Vec<Value>>>;

/// Record every `agent:event` payload from a socket opened now, on a thread
/// of its own, until the daemon goes away. Connected before this returns, so
/// a turn started after it is heard from its first event.
pub fn record_events(port: u16) -> Events {
    let url = format!("ws://127.0.0.1:{port}/api/events?token={TOKEN}");
    let (mut socket, _) = tokio_tungstenite::tungstenite::connect(url).expect("the events socket opens");
    let events = Events::default();
    let into = events.clone();
    std::thread::spawn(move || {
        while let Ok(msg) = socket.read() {
            if let Message::Text(text) = msg
                && let Ok(frame) = serde_json::from_str::<Value>(text.as_str())
                && frame["channel"] == "agent:event"
            {
                into.lock().unwrap().push(frame["payload"].clone());
            }
        }
    });
    events
}

/// One turn, once it has ended: its chat's events (from the rig's recorder)
/// and how it ended, `{ stop, aborted }`, read from them (`done.stop`, and the
/// loop's `Aborted` or `Stopped` error).
pub async fn turn_record(rig: &TurnRig, turn_id: &str, session_id: &str) -> (Vec<Value>, Value) {
    until("the daemon to end the turn", Duration::from_secs(30), || async {
        let (_, alive) = post(rig.d.port, "turn:alive", json!([turn_id]), Some(TOKEN)).await;
        (alive == json!(false)).then_some(())
    })
    .await;
    let events: Vec<Value> =
        rig.events.lock().unwrap().iter().filter(|e| e["sessionId"] == session_id).cloned().collect();
    let stop = events.iter().rev().find(|e| e["type"] == "done").map_or(Value::Null, |e| e["stop"].clone());
    let aborted =
        events.iter().any(|e| e["type"] == "error" && (e["message"] == "Aborted" || e["message"] == "Stopped"));
    (events, json!({ "stop": stop, "aborted": aborted }))
}

pub async fn wait_pending(port: u16, session_id: &str, key: &str, call_id: &str) -> Value {
    until(&format!("pending {key} {call_id}"), Duration::from_secs(30), || async {
        let (_, pending) = post(port, "chat:pending", json!([]), Some(TOKEN)).await;
        let v = pending.get(session_id).and_then(|p| p.get(key))?;
        let id = if key == "approval" { &v["call"]["id"] } else { &v["callId"] };
        (id == call_id).then(|| v.clone())
    })
    .await
}

/// Wait until the scripted model has been asked at least `count` times.
pub async fn until_model_asked(model: &ScriptedModel, count: usize, what: &str, limit: Duration) {
    until(what, limit, || async { (model.requests.lock().unwrap().len() >= count).then_some(()) }).await
}

pub fn saved_session(rig: &TurnRig, id: &str) -> Value {
    let path = rig.data.join("sessions").join(format!("{id}.json"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

pub async fn wait_for<F: Fn() -> bool>(what: &str, f: F) {
    until(what, Duration::from_secs(30), || async { f().then_some(()) }).await
}

/// A port for a server the daemon binds later (the engine binds its port at
/// the first load, seconds on). A port 0 picked would be free only until then:
/// any `bind(0)` in the run (a daemon, a fake server, a model process) may be
/// handed it meanwhile. So pick below every OS's ephemeral range (Linux starts
/// at 32768, macOS and Windows at 49152), apart per test process, never twice.
pub fn free_port() -> u16 {
    use std::sync::atomic::{AtomicU16, Ordering};
    static NEXT: AtomicU16 = AtomicU16::new(0);
    let base = 20_000 + (std::process::id() % 400) as u16 * 25;
    (0..100)
        .map(|_| base + NEXT.fetch_add(1, Ordering::Relaxed) % 25)
        .find(|&port| std::net::TcpListener::bind(("127.0.0.1", port)).is_ok())
        .expect("a free port below the ephemeral range")
}

/// The chat whose parent is `parent_id` (a `spawn_agent` child), once it exists.
pub fn child_of(rig: &TurnRig, parent_id: &str) -> Option<Value> {
    std::fs::read_dir(rig.data.join("sessions")).ok()?.flatten().find_map(|e| {
        let text = std::fs::read_to_string(e.path()).ok()?;
        let s: Value = serde_json::from_str(&text).ok()?;
        (s["parentSessionId"] == parent_id).then_some(s)
    })
}

pub fn scripted_settings(rig: &TurnRig, model: &ScriptedModel) -> Value {
    json!({
        "providers": [{
            "id": "p1", "kind": "openai-compat", "label": "Scripted", "enabled": true,
            "baseUrl": format!("http://127.0.0.1:{}/v1", model.port),
        }],
        "workspaces": [{ "id": "w1", "name": "project", "path": rig.workspace.to_string_lossy() }],
        "defaultChatMode": "yolo",
    })
}
