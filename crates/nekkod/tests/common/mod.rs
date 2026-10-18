//! Shared rig for the nekkod end-to-end tests: the real `nekkod` binary, with
//! the test binary itself re-run as a fake TS backend (`fake_backend`), a
//! scripted OpenAI-compatible model, socket helpers, port allocation, and the
//! waits (`until` and friends) that poll for a condition with a deadline.
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

pub const FAKE_ENV: &str = "NEKKOD_TEST_FAKE_BACKEND";

/// The fake TS backend, run by the `fake_backend` test in `daemon/main.rs`:
/// `start_with_env` re-runs the current test binary filtered to that test with
/// `FAKE_ENV` set, and then this process is the backend. It answers every channel with an echo, serves
/// `settings:get`, and pushes one event (plus a terminal echo the daemon must
/// drop) to each events socket. Without the env var it returns at once.
pub fn fake_backend() {
    if std::env::var(FAKE_ENV).is_err() {
        return;
    }
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        use axum::extract::ws::{Message as AMessage, WebSocketUpgrade};
        use axum::extract::{Path, Query};
        use axum::routing::{get, post};
        use std::collections::HashMap;
        let token = std::env::var("NEKKO_BACKEND_TOKEN").unwrap();
        assert!(std::env::var("NEKKOD_URL").unwrap().starts_with("http://127.0.0.1:"));
        let t1 = token.clone();
        let completions = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
        let recorded = completions.clone();
        // What `turn:prepare` admits a queued prompt as: a test sets the spec's template.
        let template = std::sync::Arc::new(std::sync::Mutex::new(None::<Value>));
        let prepared = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
        // What `design:provider` answers: a test points it at its scripted model.
        let design_provider = std::sync::Arc::new(std::sync::Mutex::new(None::<Value>));
        // Checkpoint events and loop:end carry the same image-bearing transcript.
        // The fake host must accept it rather than silently rejecting >2 MiB JSON.
        let app = axum::Router::new()
            .route(
                "/api/{channel}",
                post(move |Path(channel): Path<String>, headers: axum::http::HeaderMap, body: axum::Json<Value>| {
                    let ok = headers.get("authorization").and_then(|v| v.to_str().ok()) == Some(&format!("Bearer {t1}"));
                    async move {
                        if !ok {
                            return (axum::http::StatusCode::UNAUTHORIZED, axum::Json(json!({"error":"bad token"})));
                        }
                        match channel.as_str() {
                            "session:get" => (axum::http::StatusCode::OK, axum::Json(json!({ "id": body.0["args"][0], "messages": [], "executionMode": if body.0["args"][0] == "sandbox" { "sandbox" } else { "worktree" } }))),
                            "session:create" => {
                                let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
                                let session = json!({ "id": "s_created", "workspaceId": body.0["args"][0], "messages": [], "executionMode": "worktree", "gitIsolation": true, "createdAt": now, "updatedAt": now });
                                if let Ok(dir) = std::env::var("FAKE_DATA_DIR")
                                    && !dir.is_empty()
                                {
                                    std::fs::create_dir_all(std::path::Path::new(&dir).join("sessions")).unwrap();
                                    std::fs::write(std::path::Path::new(&dir).join("sessions/s_created.json"), session.to_string()).unwrap();
                                }
                                (axum::http::StatusCode::OK, axum::Json(session))
                            },
                            "settings:get" => (axum::http::StatusCode::OK, axum::Json(json!({ "workspaces": [] }))),
                            "sessions:deleteAgentLog" if body.0["args"][0] == "callback_fail" => {
                                (axum::http::StatusCode::BAD_REQUEST, axum::Json(json!({ "error": "command log unlink failed" })))
                            }
                            "chat:pending:host" => (axum::http::StatusCode::OK, axum::Json(json!({}))),
                            "chat:indexSnippets" | "chat:connectorSnippets" => {
                                recorded.lock().unwrap().push(json!([channel, body.0["args"].clone()]));
                                (axum::http::StatusCode::OK, axum::Json(json!([{ "relPath": "app.ts", "path": "app.ts", "body": "1: pineapple" }])))
                            }
                            "chat:running" => (axum::http::StatusCode::OK, axum::Json(json!([]))),
                            // A daemon-driven turn's host-run tool (MCP, sub-agents, the browser...).
                            "turn:tool" => (
                                {
                                    recorded.lock().unwrap().push(json!([channel, body.0["args"].clone()]));
                                    axum::http::StatusCode::OK
                                },
                                axum::Json(json!({ "result": { "toolCallId": body.0["args"][1]["id"], "output": "host tool ran" } })),
                            ),
                            "chats:busy" => (axum::http::StatusCode::OK, axum::Json(json!(["s_busy"]))),
                            // The desktop's local server, for MCP entries written with no target.
                            "integrations:target" => (
                                axum::http::StatusCode::OK,
                                axum::Json(json!({ "url": "http://127.0.0.1:1439", "token": "tok-desk", "command": "/opt/nekko/nekko-agent" })),
                            ),
                            // The engine's model server, for the daemon's `engine:models`.
                            "engine:runtime" => {
                                recorded.lock().unwrap().push(json!([channel, body.0["args"].clone()]));
                                let answer = match body.0["args"][0].as_str() {
                                    Some("loadState") => json!({
                                        "loaded": ["chat/acme_tiny-gguf/tiny-q4_k_m"],
                                        "errors": { "ollama/tiny:latest": "Not enough memory to load it." },
                                        "version": "b9999",
                                    }),
                                    // The host's own queue (runtime installs) is pushed, not asked for here.
                                    _ => Value::Null,
                                };
                                (axum::http::StatusCode::OK, axum::Json(answer))
                            }
                            "test:designProvider" => {
                                *design_provider.lock().unwrap() = Some(body.0["args"][0].clone());
                                (axum::http::StatusCode::OK, axum::Json(Value::Null))
                            }
                            "provider:resolved" => match design_provider.lock().unwrap().clone() {
                                Some(v) => (axum::http::StatusCode::OK, axum::Json(v)),
                                None => (axum::http::StatusCode::BAD_REQUEST, axum::Json(json!({ "error": "no provider" }))),
                            },
                            "design:provider" => match design_provider.lock().unwrap().clone() {
                                Some(v) => (axum::http::StatusCode::OK, axum::Json(v)),
                                None => (
                                    axum::http::StatusCode::BAD_REQUEST,
                                    axum::Json(json!({ "error": "Set a default provider and model in Models first." })),
                                ),
                            },
                            "test:prepareTemplate" => {
                                *template.lock().unwrap() = Some(body.0["args"][0].clone());
                                (axum::http::StatusCode::OK, axum::Json(Value::Null))
                            }
                            // A spawn_agent child: made on disk, its first turn from the template.
                            "spawn:prepare" => {
                                recorded.lock().unwrap().push(json!([channel, body.0["args"].clone()]));
                                let Some(mut spec) = template.lock().unwrap().clone() else {
                                    return (axum::http::StatusCode::OK, axum::Json(json!({ "error": "no template" })));
                                };
                                let parent = spec["opts"]["sessionId"].clone();
                                let task = body.0["args"][1]["input"]["task"].clone();
                                let child = json!({ "id": "s_child", "title": "Sub-agent", "workspaceId": "w1", "parentSessionId": parent, "messages": [], "createdAt": 1, "updatedAt": 1 });
                                if let Ok(dir) = std::env::var("FAKE_DATA_DIR") {
                                    std::fs::write(std::path::Path::new(&dir).join("sessions/s_child.json"), child.to_string()).unwrap();
                                }
                                spec["turnId"] = json!("turn_child");
                                spec["opts"] = json!({ "sessionId": "s_child", "providerId": "p1", "modelId": "synthetic", "text": task });
                                spec["facts"]["spawn"] = json!(false);
                                (axum::http::StatusCode::OK, axum::Json(json!({ "childId": "s_child", "spec": spec })))
                            }
                            "turn:prepare" => {
                                recorded.lock().unwrap().push(json!([channel, body.0["args"].clone()]));
                                let Some(mut spec) = template.lock().unwrap().clone() else {
                                    return (axum::http::StatusCode::OK, axum::Json(json!({ "ended": true })));
                                };
                                let n = prepared.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                                spec["turnId"] = json!(format!("turn_next_{n}"));
                                spec["opts"] = body.0["args"][1]["opts"].clone();
                                spec["queued"] = body.0["args"][1]["queued"].clone();
                                (axum::http::StatusCode::OK, axum::Json(json!({ "spec": spec })))
                            }
                            "turn:event" | "turn:end" | "turn:approved" | "turn:usage" | "turn:notify" | "loop:log" | "limits:notify"
                            | "settings:changed" | "turn:adopt" | "chat:send" => {
                                recorded.lock().unwrap().push(json!([channel, body.0["args"].clone()]));
                                (axum::http::StatusCode::OK, axum::Json(Value::Null))
                            }
                            "sessions:deleteAgentLog" | "loop:end" => {
                                recorded.lock().unwrap().push(body.0["args"].clone());
                                (axum::http::StatusCode::OK, axum::Json(Value::Null))
                            }
                            "test:completions" => (
                                axum::http::StatusCode::OK,
                                axum::Json(json!(recorded.lock().unwrap().clone())),
                            ),
                            "terminals:list:agent" => (
                                axum::http::StatusCode::OK,
                                axum::Json(json!([{ "id": "agent_s1", "title": "Agent commands" }])),
                            ),
                            // A saved Hypergate entry: the server list the daemon then runs.
                            "mcp:hypergate:save" => {
                                recorded.lock().unwrap().push(json!([channel, body.0["args"].clone()]));
                                (axum::http::StatusCode::OK, axum::Json(json!([])))
                            }
                            "fail:please" => {
                                (axum::http::StatusCode::BAD_REQUEST, axum::Json(json!({ "error": "asked to fail" })))
                            }
                            _ => (
                                axum::http::StatusCode::OK,
                                axum::Json(json!({ "echo": channel, "args": body.0.get("args") })),
                            ),
                        }
                    }
                }),
            )
            .route(
                "/api/events",
                get(move |ws: WebSocketUpgrade, Query(q): Query<HashMap<String, String>>| {
                    let ok = q.get("token") == Some(&token);
                    async move {
                        ws.on_upgrade(move |mut socket| async move {
                            if !ok {
                                return;
                            }
                            let echo = json!({"channel":"terminal:event","payload":{"type":"data","terminalId":"term_x","data":"dup"}});
                            let _ = socket.send(AMessage::Text(echo.to_string().into())).await;
                            // Repeated, not sent once: a client that subscribes to the
                            // daemon after this socket opened must still see one.
                            let ev = json!({"channel":"agent:event","payload":{"type":"hello-from-backend"}});
                            let mut tick = tokio::time::interval(std::time::Duration::from_millis(100));
                            loop {
                                tokio::select! {
                                    _ = tick.tick() => {
                                        if socket.send(AMessage::Text(ev.to_string().into())).await.is_err() {
                                            break;
                                        }
                                    }
                                    msg = socket.recv() => {
                                        if !matches!(msg, Some(Ok(_))) {
                                            break;
                                        }
                                    }
                                }
                            }
                        })
                    }
                }),
            )
            .layer(axum::extract::DefaultBodyLimit::max(64 * 1024 * 1024));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        println!("NEKKO_BACKEND_READY {}", json!({ "port": port }));
        // Exit when the daemon closes our stdin, like the real backend.
        let stdin_closed = async {
            let (tx, rx) = tokio::sync::oneshot::channel::<()>();
            std::thread::spawn(move || {
                let mut b = [0u8; 64];
                while matches!(std::io::Read::read(&mut std::io::stdin(), &mut b), Ok(n) if n > 0) {}
                let _ = tx.send(());
            });
            let _ = rx.await;
        };
        axum::serve(listener, app).with_graceful_shutdown(stdin_closed).await.unwrap();
    });
}

pub struct Daemon {
    pub child: Child,
    pub port: u16,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

pub fn start(with_backend: bool) -> Daemon {
    start_with(with_backend, None)
}

pub fn start_with(with_backend: bool, data_dir: Option<&std::path::Path>) -> Daemon {
    start_with_config(with_backend, data_dir, json!({}))
}

pub fn start_with_config(with_backend: bool, data_dir: Option<&std::path::Path>, extra: Value) -> Daemon {
    start_with_env(with_backend, data_dir, extra, &[])
}

/// With the daemon's own environment changed: `(name, None)` removes a variable.
pub fn start_with_env(
    with_backend: bool,
    data_dir: Option<&std::path::Path>,
    extra: Value,
    env: &[(&str, Option<&str>)],
) -> Daemon {
    let backend = with_backend.then(|| {
        json!({
            "exe": std::env::current_exe().unwrap(),
            "args": ["--exact", "fake_backend", "--nocapture", "--test-threads=1"],
            "env": { FAKE_ENV: "1", "FAKE_DATA_DIR": data_dir.map(|p| p.to_string_lossy().to_string()).unwrap_or_default() },
        })
    });
    let mut config = json!({ "token": TOKEN, "backend": backend, "allowedOrigins": ["null"], "dataDir": data_dir });
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
    let d = start_with_config(true, Some(&data), extra);
    TurnRig { data, workspace, d }
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
            "mcpTools": [], "decide": false, "hooks": false,
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

/// The fake backend's record of every callback the daemon made, in order.
pub async fn host_calls(port: u16) -> Vec<Value> {
    let (_, all) = post(port, "test:completions", json!([]), Some(TOKEN)).await;
    all.as_array().cloned().unwrap_or_default()
}

/// Wait until a host callback matches, and return every callback so far. On a
/// timeout the panic shows the calls the host did hear.
pub async fn until_host_call(port: u16, what: &str, limit: Duration, matches: impl Fn(&Value) -> bool) -> Vec<Value> {
    let deadline = Instant::now() + limit;
    loop {
        let calls = host_calls(port).await;
        if calls.iter().any(&matches) {
            return calls;
        }
        assert!(Instant::now() < deadline, "timed out after {limit:?} waiting for {what}; the host heard {calls:?}");
        tokio::time::sleep(POLL).await;
    }
}

/// Every callback so far, once the host has been handed `count` turns.
/// `turn:adopt` is sent without waiting on it (admission.rs), so a turn can
/// end, and `chat:send` answer, before the host hears it.
pub async fn until_adopted(port: u16, count: usize) -> Vec<Value> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let calls = host_calls(port).await;
        if calls.iter().filter(|c| c[0] == "turn:adopt").count() >= count {
            return calls;
        }
        assert!(Instant::now() < deadline, "the host was handed fewer than {count} turns: {calls:?}");
        tokio::time::sleep(POLL).await;
    }
}

/// The backend's record of one turn's callbacks: `turn:event` payloads and the `turn:end` summary.
pub async fn turn_record(port: u16, turn_id: &str) -> (Vec<Value>, Value) {
    until("the daemon to end the turn", Duration::from_secs(30), || async {
        let mut events = Vec::new();
        let mut end = None;
        for entry in host_calls(port).await {
            if entry[1][0] != turn_id {
                continue;
            }
            match entry[0].as_str() {
                Some("turn:event") => events.push(entry[1][1].clone()),
                Some("turn:end") => end = Some(entry[1][1].clone()),
                _ => {}
            }
        }
        end.map(|end| (events, end))
    })
    .await
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
