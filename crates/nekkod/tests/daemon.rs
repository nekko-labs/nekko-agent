//! End-to-end: the real `nekkod` binary, with this test binary re-run as a fake
//! TS backend (see `fake_backend`), exercised over HTTP and both sockets.

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

const TOKEN: &str = "test-token-0123456789abcdef";
const FAKE_ENV: &str = "NEKKOD_TEST_FAKE_BACKEND";

/// Not a test of its own: with the env var set, this process is the backend.
/// It answers every channel with an echo, serves `settings:get`, and pushes
/// one event (plus a terminal echo the daemon must drop) to each events socket.
#[test]
fn fake_backend() {
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
                            "chat:running" => (axum::http::StatusCode::OK, axum::Json(json!([]))),
                            // A daemon-driven turn's host-run tool (MCP, sub-agents, the browser...).
                            "turn:tool" => (
                                axum::http::StatusCode::OK,
                                axum::Json(json!({ "result": { "toolCallId": body.0["args"][1]["id"], "output": "host tool ran" } })),
                            ),
                            "turn:event" | "turn:end" | "turn:approved" | "loop:log" => {
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

struct Daemon {
    child: Child,
    port: u16,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

fn start(with_backend: bool) -> Daemon {
    start_with(with_backend, None)
}

fn start_with(with_backend: bool, data_dir: Option<&std::path::Path>) -> Daemon {
    let backend = with_backend.then(|| {
        json!({
            "exe": std::env::current_exe().unwrap(),
            "args": ["--exact", "fake_backend", "--nocapture", "--test-threads=1"],
            "env": { FAKE_ENV: "1", "FAKE_DATA_DIR": data_dir.map(|p| p.to_string_lossy().to_string()).unwrap_or_default() },
        })
    });
    let config = json!({ "token": TOKEN, "backend": backend, "allowedOrigins": ["null"], "dataDir": data_dir });
    let mut child = Command::new(env!("CARGO_BIN_EXE_nekkod"))
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

async fn post(port: u16, channel: &str, args: Value, token: Option<&str>) -> (u16, Value) {
    let mut req =
        reqwest::Client::new().post(format!("http://127.0.0.1:{port}/api/{channel}")).json(&json!({ "args": args }));
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    let res = req.send().await.unwrap();
    let status = res.status().as_u16();
    (status, res.json().await.unwrap_or(Value::Null))
}

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Connect, or say why not (as a string: tungstenite's error type is large).
async fn ws(port: u16, path: &str, origin: Option<&str>) -> Result<Socket, String> {
    let mut req = format!("ws://127.0.0.1:{port}{path}").into_client_request().unwrap();
    if let Some(o) = origin {
        req.headers_mut().insert("origin", o.parse().unwrap());
    }
    tokio_tungstenite::connect_async(req).await.map(|(s, _)| s).map_err(|e| e.to_string())
}

async fn next_json<S>(socket: &mut S, limit: Duration) -> Option<Value>
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

#[tokio::test(flavor = "multi_thread")]
async fn forwards_unported_channels_and_serves_owned_ones() {
    let d = start(true);
    let (status, body) = post(d.port, "sessions:list", json!([1, "two"]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    assert_eq!(body, json!({ "echo": "sessions:list", "args": [1, "two"] }));
    let (status, body) = post(d.port, "sessions:clear", json!(["month"]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    assert_eq!(body, json!({ "echo": "sessions:clear", "args": ["month"] }));

    let (status, body) = post(d.port, "fail:please", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 400);
    assert_eq!(body["error"], "asked to fail");

    let (status, info) = post(d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    assert_eq!(info["app"], "nekkod");

    // Owned list merges the backend's agent logs.
    let (_, list) = post(d.port, "terminals:list", json!([]), Some(TOKEN)).await;
    assert!(list.as_array().unwrap().iter().any(|t| t["id"] == "agent_s1"));

    // Decision models are the daemon's, never forwarded; with none loaded they say so.
    assert!(info["owned"].as_array().unwrap().iter().any(|c| c == "decide:run"));
    let (status, st) = post(d.port, "decide:status", json!([]), Some(TOKEN)).await;
    assert_eq!((status, st["loaded"].clone()), (200, json!(false)));
    let (status, body) = post(d.port, "decide:run", json!([{ "state": "x", "questions": {} }]), Some(TOKEN)).await;
    assert_eq!(status, 400);
    assert!(body["error"].as_str().unwrap().contains("No decision model"), "{body}");
    let (status, _) = post(d.port, "decide:load", json!(["/no/such/model/dir"]), Some(TOKEN)).await;
    assert_eq!(status, 400);
}

#[tokio::test(flavor = "multi_thread")]
async fn authenticated_loop_run_http_body_exceeds_old_limit_without_truncation() {
    let d = start(false);
    // Invalid provider deliberately stops before a provider call. A 400 provider
    // error proves the complete >2 MiB JSON body reached the loop route.
    let args = json!([{ "runId": "large-http", "provider": null, "history": [{
        "role": "user", "content": "image", "images": [format!("data:image/png;base64,{}", "A".repeat(2 * 1024 * 1024))]
    }] }]);
    let (status, body) = post(d.port, "loop:run", args.clone(), Some(TOKEN)).await;
    assert_eq!(status, 400, "{body}");
    assert!(body["error"].as_str().unwrap().starts_with("provider:"), "{body}");

    // Authentication rejects before reading the body; keep this request small so
    // the server cannot close the socket while reqwest is still uploading it.
    let (status, body) = post(d.port, "loop:run", json!([]), None).await;
    assert_eq!(status, 401, "{body}");
    assert_eq!(body["error"], "unauthorized");

    // Send exactly one byte beyond the 2 MiB limit, then read the actual HTTP
    // response. A larger reqwest upload can race the early 413 and fail with
    // BrokenPipe on Linux before reqwest exposes the response at all.
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};
    let limit = 2 * 1024 * 1024;
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", d.port)).await.unwrap();
    stream
        .write_all(
            format!(
                "POST /api/loop:tool HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {TOKEN}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                d.port,
                limit + 1
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    stream.write_all(&vec![b' '; limit]).await.unwrap();
    stream.write_all(b" ").await.unwrap();
    let mut response = tokio::io::BufReader::new(stream);
    let (status_line, body) = tokio::time::timeout(Duration::from_secs(5), async {
        let mut status_line = String::new();
        response.read_line(&mut status_line).await.unwrap();
        let mut content_length = None;
        loop {
            let mut header = String::new();
            assert!(response.read_line(&mut header).await.unwrap() > 0, "response headers ended early");
            if header == "\r\n" {
                break;
            }
            if let Some(length) = header.to_ascii_lowercase().strip_prefix("content-length: ") {
                content_length = Some(length.trim().parse::<usize>().unwrap());
            }
        }
        let mut body = vec![0; content_length.expect("JSON response has a content length")];
        response.read_exact(&mut body).await.unwrap();
        (status_line, serde_json::from_slice::<Value>(&body).unwrap())
    })
    .await
    .expect("timed out waiting for the 413 JSON response");
    assert_eq!(status_line.split_whitespace().nth(1), Some("413"), "{status_line}: {body}");
    assert_eq!(body["error"], "body too large");
}

#[tokio::test(flavor = "multi_thread")]
async fn large_image_reply_completes_and_followup_starts_with_local_provider() {
    use axum::routing::post as route_post;

    // The only model endpoint is this ephemeral loopback listener. No provider
    // credentials, user files, external service, or paid model are involved.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let provider_port = listener.local_addr().unwrap().port();
    let provider = axum::Router::new()
        .route(
            "/v1/chat/completions",
            route_post(|axum::Json(request): axum::Json<Value>| async move {
                let messages = request["messages"].as_array().unwrap();
                let image = messages
                    .iter()
                    .find_map(|m| m["content"].as_array()?.iter().find_map(|part| part["image_url"]["url"].as_str()));
                let Some(url) = image else {
                    return (axum::http::StatusCode::BAD_REQUEST, "missing synthetic image".to_string());
                };
                if request["model"] != "synthetic"
                    || url != format!("data:image/png;base64,{}", "A".repeat(2 * 1024 * 1024))
                {
                    return (axum::http::StatusCode::BAD_REQUEST, "invalid synthetic image".to_string());
                }
                let answer = if messages.last().is_some_and(|m| m["content"] == "followup") {
                    "synthetic-followup".to_string()
                } else if messages.last().is_some_and(|m| m["role"] == "user") {
                    format!("synthetic-image-{}", url.len())
                } else {
                    return (axum::http::StatusCode::BAD_REQUEST, "unexpected synthetic request".to_string());
                };
                let sse = format!(
                    "data: {}\n\ndata: [DONE]\n\n",
                    json!({ "choices": [{ "delta": { "content": answer }, "finish_reason": "stop" }] })
                );
                (axum::http::StatusCode::OK, sse)
            }),
        )
        .layer(axum::extract::DefaultBodyLimit::max(64 * 1024 * 1024));
    let server = tokio::spawn(async move { axum::serve(listener, provider).await.unwrap() });
    let d = start(true);
    let (backend_status, backend_body) = post(d.port, "test:completions", json!([]), Some(TOKEN)).await;
    assert_eq!(backend_status, 200, "backend not ready: {backend_body}");
    let config = json!({
        "id": "synthetic-local", "kind": "openai-compat", "baseUrl": format!("http://127.0.0.1:{provider_port}/v1"),
        "enabled": true
    });
    let image = format!("data:image/png;base64,{}", "A".repeat(2 * 1024 * 1024));
    let first = json!({
        "runId": "synthetic-large", "sessionId": "synthetic-session", "provider": config,
        "model": "synthetic", "history": [{ "role": "user", "content": "image", "images": [image.clone()] }]
    });
    let (status, started) = post(d.port, "loop:run", json!([first]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{started}");
    assert_eq!(started["started"], true);

    async fn completion(port: u16, run_id: &str) -> Value {
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                let (status, results) = post(port, "test:completions", json!([]), Some(TOKEN)).await;
                assert_eq!(status, 200, "{results}");
                if let Some(entry) = results.as_array().unwrap().iter().find(|entry| entry[0] == run_id) {
                    return entry[1].clone();
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("daemon did not deliver loop:end to backend")
    }

    let ended = completion(d.port, "synthetic-large").await;
    let history = ended["history"].as_array().unwrap();
    assert_eq!(ended["sessionId"], "synthetic-session");
    assert_eq!(history[0]["images"][0], image);
    assert_eq!(history.last().unwrap()["content"], format!("synthetic-image-{}", image.len()));
    assert_eq!(history.last().unwrap()["role"], "assistant");
    assert_ne!(history.last().unwrap()["interrupted"], true);

    let next = json!({
        "runId": "synthetic-next", "sessionId": "synthetic-session", "provider": config,
        "model": "synthetic", "history": [
            { "role": "user", "content": "image", "images": [image] },
            { "role": "assistant", "content": format!("synthetic-image-{}", 2 * 1024 * 1024 + "data:image/png;base64,".len()) },
            { "role": "user", "content": "followup" }
        ]
    });
    let (status, started) = post(d.port, "loop:run", json!([next]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{started}");
    assert_eq!(started["started"], true);
    let ended = completion(d.port, "synthetic-next").await;
    assert_eq!(ended["history"][3]["content"], "synthetic-followup");
    assert_eq!(ended["history"][3]["role"], "assistant");
    assert_ne!(ended["history"][3]["interrupted"], true);
    server.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_missing_tokens_and_foreign_origins() {
    let d = start(false);
    let (status, _) = post(d.port, "daemon:info", json!([]), None).await;
    assert_eq!(status, 401);
    let (status, _) = post(d.port, "daemon:info", json!([]), Some("wrong-token-0123456789")).await;
    assert_eq!(status, 401);
    assert!(ws(d.port, &format!("/api/ws?token={TOKEN}"), Some("https://evil.example")).await.is_err());
    assert!(ws(d.port, "/api/ws?token=nope", Some("null")).await.is_err());
    assert!(ws(d.port, &format!("/api/ws?token={TOKEN}"), Some("null")).await.is_ok());
}

#[tokio::test(flavor = "multi_thread")]
async fn rpc_socket_carries_replies_and_relayed_events() {
    let d = start(true);
    let mut sock = ws(d.port, &format!("/api/ws?token={TOKEN}"), Some("null")).await.unwrap();
    sock.send(Message::Text(json!({ "id": 7, "channel": "models:list", "args": ["p1"] }).to_string().into()))
        .await
        .unwrap();
    let mut got_reply = false;
    let mut got_event = false;
    let deadline = Instant::now() + Duration::from_secs(30);
    while !(got_reply && got_event) && Instant::now() < deadline {
        let Some(v) = next_json(&mut sock, Duration::from_secs(30)).await else { break };
        if v["id"] == 7 {
            assert_eq!(v["result"], json!({ "echo": "models:list", "args": ["p1"] }));
            got_reply = true;
        } else if v["channel"] == "agent:event" {
            got_event = true;
        } else {
            // The daemon must never relay the backend's echo of its own terminals.
            assert_ne!(v["payload"]["data"], "dup", "echoed a daemon terminal back: {v}");
        }
    }
    assert!(got_reply, "no reply");
    assert!(got_event, "backend event was not relayed");
}

fn echo_shell(text: &str) -> Value {
    if cfg!(windows) {
        json!({ "shell": "C:\\Windows\\System32\\cmd.exe" , "title": text })
    } else {
        json!({ "shell": "/bin/sh", "title": text })
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn terminal_stream_echoes_typed_input() {
    let d = start(false);
    let (status, info) = post(d.port, "terminal:create", json!([echo_shell("t")]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{info}");
    let id = info["id"].as_str().unwrap().to_string();
    assert!(info["running"].as_bool().unwrap());

    let mut sock = ws(d.port, &format!("/api/term/{id}?token={TOKEN}"), Some("null")).await.unwrap();
    let hello = next_json(&mut sock, Duration::from_secs(10)).await.unwrap();
    assert_eq!(hello["type"], "hello");

    let mut typed = vec![0u8];
    typed.extend_from_slice(b"echo nekko-stream-ok\r");
    sock.send(Message::Binary(typed.into())).await.unwrap();

    let mut seen = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(5), sock.next()).await {
            Ok(Some(Ok(Message::Binary(b)))) => {
                let mut ack = vec![2u8];
                ack.extend_from_slice(&(b.len() as u32).to_be_bytes());
                sock.send(Message::Binary(ack.into())).await.unwrap();
                seen.extend_from_slice(&b);
                // The command's output, not only the echo of what we typed.
                if String::from_utf8_lossy(&seen).matches("nekko-stream-ok").count() >= 2 {
                    break;
                }
            }
            Ok(Some(Ok(_))) => {}
            _ => break,
        }
    }
    let text = String::from_utf8_lossy(&seen);
    assert!(text.matches("nekko-stream-ok").count() >= 2, "terminal said {text:?}");

    let (_, _) = post(d.port, "terminal:close", json!([id]), Some(TOKEN)).await;
    let (_, list) = post(d.port, "terminals:list:native", json!([]), Some(TOKEN)).await;
    assert!(list.as_array().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn exits_when_stdin_closes_and_takes_the_backend_with_it() {
    let mut d = start(true);
    // Make sure the backend is up before pulling the plug.
    let (status, _) = post(d.port, "anything:here", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    drop(d.child.stdin.take());
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Some(status) = d.child.try_wait().unwrap() {
            assert!(status.success(), "nekkod exited with {status}");
            break;
        }
        assert!(Instant::now() < deadline, "nekkod kept running after its stdin closed");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn serves_session_reads_from_disk_when_it_knows_the_data_dir() {
    let data = std::env::temp_dir().join(format!("nekkod-sessions-{}", std::process::id()));
    let sessions = data.join("sessions");
    std::fs::create_dir_all(&sessions).unwrap();
    let chat = json!({ "id": "s_one", "title": "One", "updatedAt": 5, "messages": [
        { "id": "u", "role": "user", "content": "hello", "createdAt": 1 },
        { "id": "a", "role": "assistant", "content": "", "images": ["data:x"], "generated": { "width": 8, "height": 8, "seed": 3 }, "createdAt": 2 },
    ] });
    std::fs::write(sessions.join("s_one.json"), serde_json::to_vec_pretty(&chat).unwrap()).unwrap();
    let d = start_with(true, Some(&data));

    let (status, list) = post(d.port, "sessions:summaries", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    assert_eq!(list[0]["id"], "s_one");
    assert_eq!(list[0]["imageCount"], 1);
    assert!(list[0].get("messages").is_none(), "a summary carries no transcript");
    let (_, got) = post(d.port, "session:get", json!(["s_one"]), Some(TOKEN)).await;
    assert_eq!(got, chat);
    let (_, missing) = post(d.port, "session:get", json!(["../escape"]), Some(TOKEN)).await;
    assert_eq!(missing, Value::Null);
    let (_, images) = post(d.port, "session:images", json!(["s_one", 4]), Some(TOKEN)).await;
    assert_eq!(images, json!([{ "messageId": "a", "src": "data:x" }]));
    // The UI's own writes are the daemon's too.
    let (_, created) = post(d.port, "session:create", json!(["w1"]), Some(TOKEN)).await;
    let new_id = created["id"].as_str().unwrap().to_string();
    assert_eq!(created["workspaceId"], "w1");
    let (_, patched) =
        post(d.port, "session:setOptions", json!([new_id, { "title": "Named", "messages": [] }]), Some(TOKEN)).await;
    assert_eq!((patched["title"].clone(), patched["titleAuto"].clone()), (json!("Named"), json!(false)));
    let (_, queued) = post(d.port, "chat:queue", json!([new_id, "  later  "]), Some(TOKEN)).await;
    assert_eq!(queued["queue"], json!(["later"]));
    let (_, list) = post(d.port, "sessions:summaries", json!([]), Some(TOKEN)).await;
    assert_eq!(list.as_array().unwrap().len(), 2);
    post(d.port, "session:delete", json!([new_id]), Some(TOKEN)).await;
    let (_, gone) = post(d.port, "session:get", json!([new_id]), Some(TOKEN)).await;
    assert_eq!(gone, Value::Null);
    // Clearing is owned by the daemon, not echoed by the backend.
    let (_, fresh) = post(d.port, "session:create", json!([]), Some(TOKEN)).await;
    let (_, cleared) = post(d.port, "sessions:clear", json!(["today"]), Some(TOKEN)).await;
    assert_eq!(cleared, json!(1));
    assert!(!sessions.join(format!("{}.json", fresh["id"].as_str().unwrap())).exists());
    let (_, cleared) = post(d.port, "sessions:clear", json!(["all"]), Some(TOKEN)).await;
    assert_eq!(cleared, json!(1));
    assert!(!sessions.join("s_one.json").exists());
    let (_, callbacks) = post(d.port, "test:completions", json!([]), Some(TOKEN)).await;
    assert_eq!(callbacks, json!([[new_id], [fresh["id"]], ["s_one"]]));
    drop(d);
    std::fs::remove_dir_all(data).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn failed_log_callback_retains_json_for_delete_and_clear() {
    assert_log_callback_failure_retains_json(true).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn disabled_backend_retains_json_for_delete_and_clear() {
    assert_log_callback_failure_retains_json(false).await;
}

async fn assert_log_callback_failure_retains_json(with_backend: bool) {
    let data = std::env::temp_dir().join(format!("nekkod-retention-{}-{with_backend}", std::process::id()));
    let sessions = data.join("sessions");
    std::fs::create_dir_all(&sessions).unwrap();
    let path = sessions.join("callback_fail.json");
    let bytes = serde_json::to_vec_pretty(&json!({
        "id": "callback_fail", "title": "Keep me", "updatedAt": 5, "messages": []
    }))
    .unwrap();
    std::fs::write(&path, &bytes).unwrap();
    let d = start_with(with_backend, Some(&data));
    for (channel, args) in [("session:delete", json!(["callback_fail"])), ("sessions:clear", json!(["all"]))] {
        let (status, body) = post(d.port, channel, args, Some(TOKEN)).await;
        assert_eq!(status, 400, "{channel}: {body}");
        let expected = if with_backend { "command log unlink failed" } else { "no backend is configured" };
        assert!(body["error"].as_str().unwrap().contains(expected), "{body}");
        assert_eq!(std::fs::read(&path).unwrap(), bytes, "{channel} must retain unchanged JSON");
        let (status, got) = post(d.port, "session:get", json!(["callback_fail"]), Some(TOKEN)).await;
        assert_eq!(status, 200);
        assert_eq!(got["title"], "Keep me");
    }
    drop(d);
    std::fs::remove_dir_all(data).unwrap();
}

/// A scripted OpenAI-compatible model on an ephemeral loopback port: each
/// request takes the next reply (server-sent events), or hangs when the
/// script says so. No credentials, user files or paid model are involved.
struct ScriptedModel {
    port: u16,
    requests: std::sync::Arc<std::sync::Mutex<Vec<Value>>>,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for ScriptedModel {
    fn drop(&mut self) {
        self.server.abort();
    }
}

fn sse(chunks: &[Value]) -> String {
    let mut out: String = chunks.iter().map(|c| format!("data: {c}\n\n")).collect();
    out.push_str("data: [DONE]\n\n");
    out
}

fn say_text(text: &str) -> String {
    sse(&[json!({
        "choices": [{ "delta": { "content": text }, "finish_reason": "stop" }],
        "usage": { "prompt_tokens": 10, "completion_tokens": 3 }
    })])
}

fn call_tool(id: &str, name: &str, args: Value) -> String {
    sse(&[json!({ "choices": [{
        "delta": { "tool_calls": [{ "index": 0, "id": id, "type": "function", "function": { "name": name, "arguments": args.to_string() } }] },
        "finish_reason": "tool_calls"
    }] })])
}

const HANG: &str = "hang";

async fn scripted_model(script: Vec<String>) -> ScriptedModel {
    use axum::routing::post as route_post;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let script = std::sync::Arc::new(std::sync::Mutex::new(std::collections::VecDeque::from(script)));
    let seen = requests.clone();
    let app = axum::Router::new().route(
        "/v1/chat/completions",
        route_post(move |axum::Json(request): axum::Json<Value>| {
            let (seen, script) = (seen.clone(), script.clone());
            async move {
                seen.lock().unwrap().push(request);
                let next = script.lock().unwrap().pop_front().unwrap_or_else(|| say_text("(script ended)"));
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

struct TurnRig {
    data: std::path::PathBuf,
    workspace: std::path::PathBuf,
    d: Daemon,
}

impl Drop for TurnRig {
    fn drop(&mut self) {
        let _ = self.d.child.kill();
        let _ = self.d.child.wait();
        let _ = std::fs::remove_dir_all(&self.data);
    }
}

fn turn_rig(name: &str, session: Value) -> TurnRig {
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
    let d = start_with(true, Some(&data));
    TurnRig { data, workspace, d }
}

fn turn_spec(rig: &TurnRig, model: &ScriptedModel, turn_id: &str, session_id: &str, extra_opts: Value) -> Value {
    let provider = json!({
        "id": "p1", "kind": "openai-compat", "label": "Scripted", "enabled": true,
        "baseUrl": format!("http://127.0.0.1:{}/v1", model.port),
    });
    let mut opts = json!({ "sessionId": session_id, "providerId": "p1", "modelId": "synthetic", "text": "Fix the bug" });
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

/// The backend's record of one turn's callbacks: `turn:event` payloads and the `turn:end` summary.
async fn turn_record(port: u16, turn_id: &str) -> (Vec<Value>, Value) {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let (_, all) = post(port, "test:completions", json!([]), Some(TOKEN)).await;
            let mut events = Vec::new();
            let mut end = None;
            for entry in all.as_array().into_iter().flatten() {
                if entry[1][0] != turn_id {
                    continue;
                }
                match entry[0].as_str() {
                    Some("turn:event") => events.push(entry[1][1].clone()),
                    Some("turn:end") => end = Some(entry[1][1].clone()),
                    _ => {}
                }
            }
            if let Some(end) = end {
                return (events, end);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("the daemon never ended the turn")
}

async fn wait_pending(port: u16, session_id: &str, key: &str, call_id: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let (_, pending) = post(port, "chat:pending", json!([]), Some(TOKEN)).await;
            if let Some(v) = pending.get(session_id).and_then(|p| p.get(key)) {
                let id = if key == "approval" { &v["call"]["id"] } else { &v["callId"] };
                if id == call_id {
                    return v.clone();
                }
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("no pending {key} {call_id} for {session_id}"))
}

fn event_types(events: &[Value]) -> Vec<String> {
    events
        .iter()
        .flat_map(|p| p["events"].as_array().cloned().unwrap_or_default())
        .map(|e| e["type"].as_str().unwrap_or_default().to_string())
        .collect()
}

fn saved_session(rig: &TurnRig, id: &str) -> Value {
    let path = rig.data.join("sessions").join(format!("{id}.json"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_daemon_turn_asks_runs_tools_and_saves_every_step() {
    let session = json!({
        "id": "s_turn_q", "title": "New chat", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1
    });
    let rig = turn_rig("ask", session);
    let model = scripted_model(vec![
        call_tool("c_ask", "ask_user", json!({ "questions": [{ "question": "Which bug?", "options": ["Login", "Logout"] }] })),
        call_tool("c_read", "read_file", json!({ "path": "app.ts" })),
        call_tool("c_host", "fetch_url", json!({ "url": "https://example.invalid" })),
        say_text("all done"),
    ])
    .await;
    let spec = turn_spec(&rig, &model, "turn_q", "s_turn_q", json!({}));
    let (status, started) = post(rig.d.port, "chat:turn", json!([spec]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{started}");
    assert_eq!(started["started"], true);

    // The question is the daemon's: the board sees it, and answering it there resumes the turn.
    let question = wait_pending(rig.d.port, "s_turn_q", "question", "c_ask").await;
    assert_eq!(question["questions"][0]["question"], "Which bug?");
    let (_, alive) = post(rig.d.port, "turn:alive", json!(["turn_q"]), Some(TOKEN)).await;
    assert_eq!(alive, json!(true));
    let answers = json!([{ "questionId": "q1", "labels": ["Login"] }]);
    let (status, body) = post(rig.d.port, "chat:answer", json!(["s_turn_q", "c_ask", answers]), Some(TOKEN)).await;
    assert_eq!((status, body), (200, Value::Null), "answered by the daemon, not forwarded to the host");

    let (events, end) = turn_record(rig.d.port, "turn_q").await;
    assert_eq!(end["aborted"], false, "{end}");
    assert_eq!(end["stop"], "complete", "{end}");
    let types = event_types(&events);
    for t in ["session_meta", "question", "question_resolved", "tool_call", "tool_result", "done"] {
        assert!(types.iter().any(|x| x == t), "no {t} event in {types:?}");
    }
    let done = events.iter().find(|p| p["events"][0]["type"] == "done").unwrap();
    assert_eq!(done["stats"]["calls"], 1, "only the last reply reported usage: {done}");
    assert!(done["startedAt"].is_u64());
    let (_, pending) = post(rig.d.port, "chat:pending", json!([]), Some(TOKEN)).await;
    assert_eq!(pending, json!({}), "nothing may stay pending after the turn");

    let saved = saved_session(&rig, "s_turn_q");
    assert_eq!(saved["title"], "Fix the bug");
    assert_eq!(saved["titleAuto"], true);
    assert_eq!(saved["providerId"], "p1");
    assert!(saved.get("activeRun").is_none(), "the run marker is cleared");
    let messages = saved["messages"].as_array().unwrap();
    assert_eq!(messages[0]["role"], "user");
    assert_eq!(messages[0]["content"], "Fix the bug");
    let tool_out = |id: &str| -> String {
        let m = messages.iter().find(|m| m["role"] == "tool" && m["toolResult"]["toolCallId"] == id).unwrap();
        m["toolResult"]["output"].as_str().unwrap().to_string()
    };
    assert!(tool_out("c_ask").contains("Q: Which bug?\nA: Login"), "{}", tool_out("c_ask"));
    assert!(tool_out("c_read").contains("pineapple"));
    assert_eq!(tool_out("c_host"), "host tool ran");
    let last = messages.last().unwrap();
    assert_eq!(last["content"], "all done");
    assert_eq!(last["turnStats"]["calls"], 1);
    assert_eq!(last["turnStats"]["providerId"], "p1");

    // What the model was sent: the composed prompt and tools.
    let first = model.requests.lock().unwrap()[0].clone();
    let system = first["messages"][0]["content"].as_str().unwrap().to_string();
    assert!(system.contains("Asking first:"), "ask_user is offered, so the prompt says when to ask");
    assert!(system.contains(&rig.workspace.to_string_lossy().to_string()));
    assert!(system.contains("Always run the tests."), "the project's AGENTS.md is in the context block");
    let tools: Vec<String> = first["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["function"]["name"].as_str().unwrap().to_string())
        .collect();
    for t in ["read_file", "ask_user", "update_plan", "set_chat_title", "complete_session"] {
        assert!(tools.contains(&t.to_string()), "{t} missing from {tools:?}");
    }
    assert!(!tools.contains(&"browser".to_string()), "no browser control was allowed");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_daemon_turn_parks_approvals_and_answers_them_itself() {
    let session = json!({
        "id": "s_turn_a", "title": "Named", "mode": "ask", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1
    });
    let rig = turn_rig("approve", session);
    let model = scripted_model(vec![
        call_tool("c_w", "write_file", json!({ "path": "new.txt", "content": "hi" })),
        call_tool("c_slow", "ask_user", json!({ "questions": [{ "question": "Go on?", "options": ["Yes", "No"] }] })),
        say_text("wrote it"),
    ])
    .await;
    let spec = turn_spec(&rig, &model, "turn_a", "s_turn_a", json!({}));
    let (status, _) = post(rig.d.port, "chat:turn", json!([spec]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let approval = wait_pending(rig.d.port, "s_turn_a", "approval", "c_w").await;
    assert_eq!(approval["call"]["name"], "write_file");
    assert!(!rig.workspace.join("new.txt").exists(), "nothing is written before the approval");
    let (status, body) = post(rig.d.port, "tool:approve", json!(["s_turn_a", "c_w", true]), Some(TOKEN)).await;
    assert_eq!((status, body), (200, Value::Null), "answered by the daemon, not forwarded to the host");

    // While the turn waits on its question, a host-run tool's approval parks
    // here too, and the host hears the answer.
    wait_pending(rig.d.port, "s_turn_a", "question", "c_slow").await;
    let (status, ok) = post(
        rig.d.port,
        "turn:approval",
        json!(["turn_a", { "id": "c_host_ok", "name": "start_process", "input": {} }, "Start a background process", "medium"]),
        Some(TOKEN),
    )
    .await;
    assert_eq!((status, ok), (200, json!(true)));
    let parked = wait_pending(rig.d.port, "s_turn_a", "approval", "c_host_ok").await;
    assert_eq!(parked["reason"], "Start a background process");
    let (_, body) = post(rig.d.port, "tool:approve", json!(["s_turn_a", "c_host_ok", false]), Some(TOKEN)).await;
    assert_eq!(body, Value::Null);
    let answers = json!([{ "questionId": "q1", "labels": ["Yes"] }]);
    post(rig.d.port, "chat:answer", json!(["s_turn_a", "c_slow", answers]), Some(TOKEN)).await;

    let (events, end) = turn_record(rig.d.port, "turn_a").await;
    assert_eq!(end["stop"], "complete", "{end}");
    assert_eq!(std::fs::read_to_string(rig.workspace.join("new.txt")).unwrap(), "hi");
    let types = event_types(&events);
    assert_eq!(types.iter().filter(|t| *t == "tool_approval_required").count(), 2, "{types:?}");
    let (_, all) = post(rig.d.port, "test:completions", json!([]), Some(TOKEN)).await;
    let answered =
        all.as_array().unwrap().iter().any(|e| e[0] == "turn:approved" && e[1] == json!(["c_host_ok", false]));
    assert!(answered, "the host heard its approval was refused");
}

#[tokio::test(flavor = "multi_thread")]
async fn stopping_a_daemon_turn_ends_it_and_clears_the_run_marker() {
    let session = json!({
        "id": "s_turn_s", "title": "Named", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1
    });
    let rig = turn_rig("stop", session);
    let model = scripted_model(vec![HANG.to_string()]).await;
    let spec = turn_spec(&rig, &model, "turn_s", "s_turn_s", json!({}));
    let (status, _) = post(rig.d.port, "chat:turn", json!([spec]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    tokio::time::timeout(Duration::from_secs(20), async {
        while model.requests.lock().unwrap().is_empty() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the model was never asked");
    let saved = saved_session(&rig, "s_turn_s");
    assert!(saved["activeRun"]["startedAt"].is_u64(), "the run marker is on disk while the turn runs");
    let (_, running) = post(rig.d.port, "chat:running", json!([]), Some(TOKEN)).await;
    assert!(running.as_array().unwrap().contains(&json!("s_turn_s")), "{running}");

    let (status, _) = post(rig.d.port, "chat:abort", json!(["s_turn_s"]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let (events, end) = turn_record(rig.d.port, "turn_s").await;
    assert_eq!(end["aborted"], true);
    assert!(event_types(&events).contains(&"error".to_string()));
    assert!(saved_session(&rig, "s_turn_s").get("activeRun").is_none());
    let (_, alive) = post(rig.d.port, "turn:alive", json!(["turn_s"]), Some(TOKEN)).await;
    assert_eq!(alive, json!(false));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_queued_turn_whose_prompt_changed_ends_before_it_starts() {
    let session = json!({
        "id": "s_turn_e", "title": "Named", "workspaceId": "w1", "messages": [], "queue": ["other"],
        "createdAt": 1, "updatedAt": 1
    });
    let rig = turn_rig("early", session);
    let model = scripted_model(vec![]).await;
    let mut spec = turn_spec(&rig, &model, "turn_e", "s_turn_e", json!({ "text": "mine" }));
    spec["queued"] = json!({ "index": 0, "item": "mine" });
    let (status, _) = post(rig.d.port, "chat:turn", json!([spec]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let (events, end) = turn_record(rig.d.port, "turn_e").await;
    assert_eq!(end["early"], true);
    assert_eq!(events[0]["events"][0]["message"], "Queued prompt changed before it could start.");
    assert!(model.requests.lock().unwrap().is_empty(), "no model call for a turn that never started");
}
