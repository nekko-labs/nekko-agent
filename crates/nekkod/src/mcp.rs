//! MCP servers, run by the daemon (PF14): `mcp:sync`, `mcp:call` and,
//! with the settings store, `mcp:status`.
//!
//! A port of `packages/host/src/mcp.ts`'s client: JSON-RPC 2.0 over the
//! newline-delimited stdio of a spawned process, or streamable HTTP when the
//! config has a `url` (JSON or SSE-framed replies, the server's
//! `mcp-session-id` echoed back). The servers live here, not in the TS host,
//! so they survive a host restart and their output is parsed off its event
//! loop. The host still decides when to sync and still asks for approval
//! before a call; Hypergate discovery stays there too.
//!
//! Two things differ from the TS client on purpose: stopping a stdio server
//! stops its whole process tree (on Windows `npx` runs under `cmd.exe`, and
//! killing only the shell relies on the server quitting when its stdin
//! closes), and a server that exits fails its waiting requests at once
//! instead of after the 20 s timeout.

use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::oneshot;

/// How long a stdio request waits for its reply.
const STDIO_TIMEOUT: Duration = Duration::from_secs(20);

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn rpc_error(msg: &Value) -> String {
    msg["error"]["message"].as_str().unwrap_or("MCP error").to_string()
}

struct Stdio {
    writer: tokio::sync::Mutex<Box<dyn AsyncWrite + Send + Unpin>>,
    pending: Pending,
    pid: Option<u32>,
}

struct Http {
    client: reqwest::Client,
    url: String,
    token: Option<String>,
    session: Mutex<Option<String>>,
}

enum Wire {
    Stdio(Stdio),
    Http(Http),
}

struct Server {
    wire: Option<Wire>,
    next_id: AtomicU64,
    tools: Mutex<Vec<Value>>,
    connected: Arc<AtomicBool>,
    error: Arc<Mutex<Option<String>>>,
}

impl Server {
    fn failed(message: String) -> Self {
        Self {
            wire: None,
            next_id: AtomicU64::new(1),
            tools: Mutex::default(),
            connected: Arc::default(),
            error: Arc::new(Mutex::new(Some(message))),
        }
    }

    fn with_wire(wire: Wire, connected: Arc<AtomicBool>, error: Arc<Mutex<Option<String>>>) -> Self {
        Self { wire: Some(wire), next_id: AtomicU64::new(1), tools: Mutex::default(), connected, error }
    }

    /// A server over a byte pipe: `read` is its stdout, `write` its stdin.
    fn over_pipe(
        read: impl AsyncRead + Send + Unpin + 'static,
        write: impl AsyncWrite + Send + Unpin + 'static,
        pid: Option<u32>,
    ) -> Self {
        let pending: Pending = Arc::default();
        let connected = Arc::new(AtomicBool::new(false));
        let error = Arc::new(Mutex::new(None));
        let (p, c) = (pending.clone(), connected.clone());
        tokio::spawn(async move {
            let mut lines = BufReader::new(read).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                // Partial or non-JSON lines (server logs on stdout) are skipped.
                let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
                let Some(id) = msg.get("id").and_then(Value::as_u64) else { continue };
                if let Some(tx) = lock(&p).remove(&id) {
                    let _ = tx.send(if msg.get("error").is_some_and(|e| !e.is_null()) {
                        Err(rpc_error(&msg))
                    } else {
                        Ok(msg.get("result").cloned().unwrap_or(Value::Null))
                    });
                }
            }
            c.store(false, Ordering::SeqCst);
            for (_, tx) in lock(&p).drain() {
                let _ = tx.send(Err("MCP server exited".into()));
            }
        });
        let wire = Wire::Stdio(Stdio { writer: tokio::sync::Mutex::new(Box::new(write)), pending, pid });
        Self::with_wire(wire, connected, error)
    }

    fn spawn(config: &Value) -> Result<Self, String> {
        let command = config["command"].as_str().unwrap_or_default();
        let args: Vec<&str> =
            config["args"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
        let mut cmd = shell_command(command, &args);
        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        crate::procgroup::on_child_spawn(&mut cmd);
        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let pid = child.id();
        let server = Self::over_pipe(stdout, stdin, pid);
        // Reap it, and keep it alive until it exits or is stopped.
        tokio::spawn(async move {
            let _ = child.wait().await;
        });
        Ok(server)
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let body = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        match self.wire.as_ref().ok_or("not started")? {
            Wire::Http(h) => h.send(&body, true).await,
            Wire::Stdio(s) => {
                let (tx, rx) = oneshot::channel();
                lock(&s.pending).insert(id, tx);
                s.write(&body).await;
                match tokio::time::timeout(STDIO_TIMEOUT, rx).await {
                    Ok(Ok(r)) => r,
                    Ok(Err(_)) => Err("MCP server exited".into()),
                    Err(_) => {
                        lock(&s.pending).remove(&id);
                        Err(format!("MCP {method} timed out"))
                    }
                }
            }
        }
    }

    async fn notify(&self, method: &str) {
        let body = json!({ "jsonrpc": "2.0", "method": method });
        match &self.wire {
            Some(Wire::Http(h)) => {
                let _ = h.send(&body, false).await;
            }
            Some(Wire::Stdio(s)) => s.write(&body).await,
            None => {}
        }
    }

    async fn start(&self) -> Result<(), String> {
        self.request(
            "initialize",
            json!({ "protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": { "name": "nekko-agent", "version": "1" } }),
        )
        .await?;
        self.notify("notifications/initialized").await;
        let res = self.request("tools/list", json!({})).await?;
        *lock(&self.tools) = res.get("tools").and_then(Value::as_array).cloned().unwrap_or_default();
        self.connected.store(true, Ordering::SeqCst);
        Ok(())
    }

    fn stop(&self) {
        self.connected.store(false, Ordering::SeqCst);
        if let Some(Wire::Stdio(Stdio { pid: Some(pid), .. })) = &self.wire {
            kill_tree(*pid);
        }
    }
}

impl Stdio {
    async fn write(&self, body: &Value) {
        let mut line = serde_json::to_string(body).unwrap_or_default();
        line.push('\n');
        let mut w = self.writer.lock().await;
        let _ = w.write_all(line.as_bytes()).await;
        let _ = w.flush().await;
    }
}

impl Http {
    /// POST one JSON-RPC message and read the reply (none for a notification).
    async fn send(&self, body: &Value, expect_reply: bool) -> Result<Value, String> {
        let mut req = self
            .client
            .post(&self.url)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .body(serde_json::to_string(body).unwrap_or_default());
        if let Some(t) = &self.token {
            req = req.header("authorization", format!("Bearer {t}"));
        }
        if let Some(s) = lock(&self.session).clone() {
            req = req.header("mcp-session-id", s);
        }
        let res = req.send().await.map_err(|e| e.to_string())?;
        if let Some(sid) = res.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()) {
            *lock(&self.session) = Some(sid.to_string());
        }
        if !expect_reply {
            return Ok(Value::Null);
        }
        let status = res.status().as_u16();
        if !res.status().is_success() {
            return Err(format!("MCP HTTP {status}{}", if status == 401 { " (check the bearer token)" } else { "" }));
        }
        let sse = res
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|c| c.contains("text/event-stream"));
        let text = res.text().await.map_err(|e| e.to_string())?;
        let msg = if sse {
            // SSE-framed: the event whose data carries this request's id.
            text.split('\n')
                .filter_map(|l| l.strip_prefix("data:"))
                .filter_map(|d| serde_json::from_str::<Value>(d.trim()).ok())
                .find(|m| m.get("id") == body.get("id"))
                .ok_or("MCP HTTP: no response in event stream")?
        } else {
            serde_json::from_str::<Value>(&text).map_err(|e| e.to_string())?
        };
        if msg.get("error").is_some_and(|e| !e.is_null()) {
            return Err(rpc_error(&msg));
        }
        Ok(msg.get("result").cloned().unwrap_or(Value::Null))
    }
}

/// How Node's `spawn(command, args, { shell: win32 })` runs it: through
/// `cmd.exe /d /s /c "<command> <args>"` on Windows (so `npx` and other
/// `.cmd` shims resolve), directly elsewhere.
fn shell_command(command: &str, args: &[&str]) -> tokio::process::Command {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let line = std::iter::once(command).chain(args.iter().copied()).collect::<Vec<_>>().join(" ");
        let mut cmd = tokio::process::Command::new(std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into()));
        cmd.raw_arg(format!("/d /s /c \"{line}\"")).creation_flags(CREATE_NO_WINDOW);
        cmd
    }
    #[cfg(not(windows))]
    {
        let mut cmd = tokio::process::Command::new(command);
        cmd.args(args).process_group(0);
        cmd
    }
}

/// Stop a server and everything it started.
fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }
    #[cfg(unix)]
    {
        // SAFETY: kill takes a process group id and a signal number, no pointers.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGTERM);
        }
    }
}

#[derive(Default)]
pub struct Mcp {
    servers: Mutex<HashMap<String, Arc<Server>>>,
}

impl Mcp {
    /// `mcp:sync`: run exactly the enabled servers in `configs`. A server
    /// already running keeps running as it is, as in the TS client; one that
    /// failed stays failed until it is disabled and enabled again.
    pub async fn sync(&self, configs: &Value) -> Value {
        let wanted: Vec<&Value> =
            configs.as_array().map(|a| a.iter().filter(|c| c["enabled"] == json!(true)).collect()).unwrap_or_default();
        let ids: Vec<String> = wanted.iter().filter_map(|c| c["id"].as_str().map(str::to_string)).collect();
        let mut starting = Vec::new();
        {
            let mut servers = lock(&self.servers);
            servers.retain(|id, srv| {
                let keep = ids.contains(id);
                if !keep {
                    srv.stop();
                }
                keep
            });
            for config in wanted {
                let Some(id) = config["id"].as_str() else { continue };
                if servers.contains_key(id) {
                    continue;
                }
                let server = Arc::new(match config["url"].as_str().filter(|u| !u.is_empty()) {
                    Some(url) => Server::with_wire(
                        Wire::Http(Http {
                            client: reqwest::Client::new(),
                            url: url.to_string(),
                            token: config["token"].as_str().filter(|t| !t.is_empty()).map(str::to_string),
                            session: Mutex::default(),
                        }),
                        Arc::default(),
                        Arc::default(),
                    ),
                    None => Server::spawn(config).unwrap_or_else(Server::failed),
                });
                servers.insert(id.to_string(), server.clone());
                starting.push(server);
            }
        }
        futures_util::future::join_all(starting.into_iter().filter(|s| s.wire.is_some()).map(|s| async move {
            if let Err(e) = s.start().await {
                *lock(&s.error) = Some(e);
            }
        }))
        .await;
        self.snapshot()
    }

    /// Every server's state and the agent tool specs of the connected ones.
    pub fn snapshot(&self) -> Value {
        let servers = lock(&self.servers);
        let mut ids: Vec<&String> = servers.keys().collect();
        ids.sort();
        let mut specs = Vec::new();
        let mut state = serde_json::Map::new();
        for id in ids {
            let srv = &servers[id];
            let tools = lock(&srv.tools).clone();
            for t in &tools {
                let name = t["name"].as_str().unwrap_or_default();
                let description = match t["description"].as_str().filter(|d| !d.is_empty()) {
                    Some(d) => format!("(MCP) {d}"),
                    None => format!("(MCP) {name}"),
                };
                let parameters = if t["inputSchema"].is_object() {
                    t["inputSchema"].clone()
                } else {
                    json!({ "type": "object", "properties": {} })
                };
                specs.push(json!({ "name": format!("mcp__{id}__{name}"), "description": description, "parameters": parameters }));
            }
            let listed: Vec<Value> = tools
                .iter()
                .map(|t| {
                    let mut o = json!({ "name": t["name"] });
                    if let Some(d) = t.get("description").filter(|d| !d.is_null()) {
                        o["description"] = d.clone();
                    }
                    o
                })
                .collect();
            let mut s = json!({ "connected": srv.connected.load(Ordering::SeqCst), "tools": listed });
            if let Some(e) = lock(&srv.error).clone() {
                s["error"] = json!(e);
            }
            state.insert(id.clone(), s);
        }
        json!({ "specs": specs, "servers": state })
    }

    /// `mcp:call`: run an `mcp__<id>__<tool>` call on its server.
    pub async fn call(&self, call: &Value) -> Value {
        let call_id = call["id"].clone();
        let name = call["name"].as_str().unwrap_or_default();
        let mut parts = name.split("__").skip(1);
        let id = parts.next().unwrap_or_default().to_string();
        let tool = parts.collect::<Vec<_>>().join("__");
        let server = lock(&self.servers).get(&id).cloned();
        let Some(srv) = server.filter(|s| s.connected.load(Ordering::SeqCst)) else {
            return json!({ "toolCallId": call_id, "output": format!("MCP server \"{id}\" is not connected."), "isError": true });
        };
        let args = if call["input"].is_object() { call["input"].clone() } else { json!({}) };
        match srv.request("tools/call", json!({ "name": tool, "arguments": args })).await {
            Ok(res) => {
                let text = match res.get("content").and_then(Value::as_array) {
                    Some(items) => items
                        .iter()
                        .map(|c| match c.get("text") {
                            Some(Value::String(s)) => s.clone(),
                            Some(t) if !t.is_null() => nekko_js::display(t),
                            _ => nekko_js::stringify(c),
                        })
                        .collect::<Vec<_>>()
                        .join("\n"),
                    None => nekko_js::stringify(&res),
                };
                let is_error = nekko_js::truthy(res.get("isError"));
                json!({ "toolCallId": call_id, "output": if text.is_empty() { "(no output)".to_string() } else { text }, "isError": is_error })
            }
            Err(e) => json!({ "toolCallId": call_id, "output": format!("MCP call failed: {e}"), "isError": true }),
        }
    }

    /// Stop every server (the daemon is shutting down).
    pub fn stop_all(&self) {
        for (_, srv) in lock(&self.servers).drain() {
            srv.stop();
        }
    }
}

/// `mcpStatus(configs)` over a [`Mcp::snapshot`], as the TS host reports it
/// once the daemon runs the servers: one row per configured server, enabled
/// or not, in the settings' order. Keys the TS leaves `undefined` are left
/// out; a `null` it copies stays.
pub fn status(configs: &Value, snapshot: &Value) -> Value {
    let rows = configs.as_array().map(Vec::as_slice).unwrap_or_default().iter().map(|c| {
        let srv = c.get("id").and_then(Value::as_str).and_then(|id| snapshot["servers"].get(id));
        let mut row = serde_json::Map::new();
        for key in ["id", "name"] {
            if let Some(v) = c.get(key) {
                row.insert(key.into(), v.clone());
            }
        }
        row.insert("connected".into(), json!(nekko_js::truthy(srv.and_then(|s| s.get("connected")))));
        let tools: Vec<Value> = srv
            .and_then(|s| s.get("tools"))
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .map(|t| {
                let mut tool = serde_json::Map::new();
                for key in ["name", "description"] {
                    if let Some(v) = t.get(key) {
                        tool.insert(key.into(), v.clone());
                    }
                }
                Value::Object(tool)
            })
            .collect();
        row.insert("tools".into(), Value::Array(tools));
        if let Some(e) = srv.and_then(|s| s.get("error")) {
            row.insert("error".into(), e.clone());
        }
        Value::Object(row)
    });
    Value::Array(rows.collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The rows the TS host reports for the same configs and daemon snapshot
    /// (packages/host/src/mcp-status.golden.test.ts), compared as text so
    /// key order and left-out keys count.
    #[test]
    fn status_matches_the_ts_host() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/mcp-status.json");
        let cases: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert!(cases.len() >= 4);
        for c in cases {
            let got = status(&c["configs"], &c["snapshot"]);
            assert_eq!(nekko_js::stringify(&got), nekko_js::stringify(&c["status"]), "{}", c["name"]);
        }
        assert_eq!(status(&json!({ "not": "a list" }), &json!({})), json!([]));
    }

    /// A scripted stdio MCP server on an in-memory pipe.
    fn fake_stdio() -> Server {
        let (client_side, server_side) = tokio::io::duplex(1 << 16);
        let (client_read, client_write) = tokio::io::split(client_side);
        let (server_read, mut server_write) = tokio::io::split(server_side);
        tokio::spawn(async move {
            let mut lines = BufReader::new(server_read).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let msg: Value = serde_json::from_str(&line).unwrap();
                let Some(id) = msg.get("id").cloned() else { continue };
                let reply = match msg["method"].as_str().unwrap() {
                    "initialize" => {
                        json!({ "jsonrpc": "2.0", "id": id, "result": { "protocolVersion": "2024-11-05" } })
                    }
                    "tools/list" => json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": [
                        { "name": "echo", "description": "Echo it", "inputSchema": { "type": "object", "properties": { "text": { "type": "string" } } } },
                        { "name": "bare" }
                    ] } }),
                    _ => match msg["params"]["name"].as_str().unwrap() {
                        "echo" => json!({ "jsonrpc": "2.0", "id": id, "result": { "content": [
                            { "type": "text", "text": msg["params"]["arguments"]["text"] },
                            { "type": "image", "data": "AA==", "n": 1.0 }
                        ] } }),
                        "boom" => {
                            json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -1, "message": "no such tool" } })
                        }
                        _ => json!({ "jsonrpc": "2.0", "id": id, "result": { "content": [], "isError": true } }),
                    },
                };
                // A log line first, as some servers print to stdout.
                server_write.write_all(b"starting up...\n").await.unwrap();
                server_write.write_all(format!("{reply}\n").as_bytes()).await.unwrap();
            }
        });
        Server::over_pipe(client_read, client_write, None)
    }

    #[tokio::test]
    async fn stdio_handshake_tools_and_calls_match_the_ts_client() {
        let mcp = Mcp::default();
        let srv = Arc::new(fake_stdio());
        srv.start().await.unwrap();
        lock(&mcp.servers).insert("fs".into(), srv);
        let snap = mcp.snapshot();
        assert_eq!(
            snap["specs"],
            json!([
                { "name": "mcp__fs__echo", "description": "(MCP) Echo it", "parameters": { "type": "object", "properties": { "text": { "type": "string" } } } },
                { "name": "mcp__fs__bare", "description": "(MCP) bare", "parameters": { "type": "object", "properties": {} } }
            ])
        );
        assert_eq!(
            snap["servers"]["fs"],
            json!({ "connected": true, "tools": [{ "name": "echo", "description": "Echo it" }, { "name": "bare" }] })
        );

        let ok = mcp.call(&json!({ "id": "c1", "name": "mcp__fs__echo", "input": { "text": "hi" } })).await;
        assert_eq!(
            ok,
            json!({ "toolCallId": "c1", "output": "hi\n{\"type\":\"image\",\"data\":\"AA==\",\"n\":1}", "isError": false })
        );
        let empty = mcp.call(&json!({ "id": "c2", "name": "mcp__fs__bare", "input": {} })).await;
        assert_eq!(empty, json!({ "toolCallId": "c2", "output": "(no output)", "isError": true }));
        let failed = mcp.call(&json!({ "id": "c3", "name": "mcp__fs__boom", "input": {} })).await;
        assert_eq!(failed, json!({ "toolCallId": "c3", "output": "MCP call failed: no such tool", "isError": true }));
        let missing = mcp.call(&json!({ "id": "c4", "name": "mcp__gone__x", "input": {} })).await;
        assert_eq!(
            missing,
            json!({ "toolCallId": "c4", "output": "MCP server \"gone\" is not connected.", "isError": true })
        );
    }

    #[tokio::test]
    async fn a_server_that_exits_fails_its_requests_and_disconnects() {
        let (client_side, server_side) = tokio::io::duplex(1024);
        let (r, w) = tokio::io::split(client_side);
        let srv = Server::over_pipe(r, w, None);
        drop(server_side);
        assert_eq!(srv.request("initialize", json!({})).await, Err("MCP server exited".into()));
        assert!(!srv.connected.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn http_handles_json_and_sse_replies_and_echoes_the_session() {
        use axum::http::{HeaderMap, StatusCode};
        use axum::response::IntoResponse;
        type Seen = Vec<(Option<String>, Option<String>)>;
        let seen: Arc<Mutex<Seen>> = Arc::default();
        let log = seen.clone();
        let app = axum::Router::new().route(
            "/mcp",
            axum::routing::post(move |headers: HeaderMap, body: String| {
                let log = log.clone();
                async move {
                    let h = |k: &str| headers.get(k).and_then(|v| v.to_str().ok()).map(str::to_string);
                    log.lock().unwrap().push((h("authorization"), h("mcp-session-id")));
                    let msg: Value = serde_json::from_str(&body).unwrap();
                    let Some(id) = msg.get("id").cloned() else { return StatusCode::ACCEPTED.into_response() };
                    match msg["method"].as_str().unwrap() {
                        "initialize" => (
                            [("mcp-session-id", "sess-1"), ("content-type", "application/json")],
                            json!({ "jsonrpc": "2.0", "id": id, "result": {} }).to_string(),
                        )
                            .into_response(),
                        "tools/list" => (
                            [("content-type", "text/event-stream")],
                            format!(
                                "event: message\ndata: {}\n\ndata: {}\n\n",
                                json!({ "jsonrpc": "2.0", "method": "notifications/progress" }),
                                json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": [{ "name": "search" }] } })
                            ),
                        )
                            .into_response(),
                        _ => (StatusCode::UNAUTHORIZED, "no").into_response(),
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let mcp = Mcp::default();
        let snap = mcp
            .sync(&json!([
                { "id": "gw", "name": "Gateway", "command": "", "args": [], "url": format!("http://{addr}/mcp"), "token": "tok", "enabled": true },
                { "id": "off", "name": "Off", "command": "nope", "args": [], "enabled": false }
            ]))
            .await;
        assert_eq!(snap["servers"], json!({ "gw": { "connected": true, "tools": [{ "name": "search" }] } }));
        let call = mcp.call(&json!({ "id": "c1", "name": "mcp__gw__search", "input": {} })).await;
        assert_eq!(call["output"], "MCP call failed: MCP HTTP 401 (check the bearer token)");
        {
            let seen = seen.lock().unwrap();
            assert_eq!(seen[0], (Some("Bearer tok".into()), None));
            assert!(seen[1..].iter().all(|s| s.1.as_deref() == Some("sess-1")));
        }

        // Disabling it removes it.
        let after = mcp.sync(&json!([])).await;
        assert_eq!(after, json!({ "specs": [], "servers": {} }));
    }

    #[tokio::test]
    async fn a_command_that_cannot_start_reports_why() {
        let mcp = Mcp::default();
        let snap = mcp
            .sync(&json!([{ "id": "x", "name": "X", "command": "definitely-not-a-real-mcp-server-binary", "args": [], "enabled": true }]))
            .await;
        // On Windows the shell starts and then the command fails, so the
        // server exits; elsewhere the spawn itself fails. Either way it is
        // not connected and says why.
        assert_eq!(snap["servers"]["x"]["connected"], false);
        assert!(snap["servers"]["x"]["error"].is_string());
    }
}
