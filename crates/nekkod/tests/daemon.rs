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
    start_with_config(with_backend, data_dir, json!({}))
}

fn start_with_config(with_backend: bool, data_dir: Option<&std::path::Path>, extra: Value) -> Daemon {
    start_with_env(with_backend, data_dir, extra, &[])
}

/// With the daemon's own environment changed: `(name, None)` removes a variable.
fn start_with_env(
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
async fn authenticated_chat_turn_http_body_exceeds_old_limit_without_truncation() {
    let d = start(false);
    // Without a data directory the turn stops before anything runs. That 400
    // proves the complete >2 MiB JSON body reached the turn route.
    let image = format!("data:image/png;base64,{}", "A".repeat(2 * 1024 * 1024));
    let args = json!([{ "turnId": "large-http", "opts": { "sessionId": "s", "text": "image", "images": [image] } }]);
    let (status, body) = post(d.port, "chat:turn", args.clone(), Some(TOKEN)).await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["error"], "chat:turn needs the daemon to know the data directory", "{body}");

    // Authentication rejects before reading the body; keep this request small so
    // the server cannot close the socket while reqwest is still uploading it.
    let (status, body) = post(d.port, "chat:turn", json!([]), None).await;
    assert_eq!(status, 401, "{body}");
    assert_eq!(body["error"], "unauthorized");

    // Send exactly one byte beyond the call limit, then read the actual HTTP
    // response. A larger reqwest upload can race the early 413 and fail with
    // BrokenPipe on Linux before reqwest exposes the response at all.
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};
    // Other calls are capped at 25 MiB, the web edition's public limit (wire.rs).
    let limit = 25 * 1024 * 1024;
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", d.port)).await.unwrap();
    stream
        .write_all(
            format!(
                "POST /api/turn:tool HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {TOKEN}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
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
    let session = json!({
        "id": "s_large", "title": "Named", "mode": "yolo", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1
    });
    let rig = turn_rig("large-image", session);
    let unused = scripted_model(vec![]).await;
    let image = format!("data:image/png;base64,{}", "A".repeat(2 * 1024 * 1024));
    let spec_for = |turn: &str, text: &str, images: Value| {
        let mut spec = turn_spec(&rig, &unused, turn, "s_large", json!({ "text": text, "images": images }));
        let base = format!("http://127.0.0.1:{provider_port}/v1");
        spec["facts"]["provider"]["baseUrl"] = json!(base);
        spec["settings"]["providers"][0]["baseUrl"] = json!(base);
        spec
    };
    let (status, started) =
        post(rig.d.port, "chat:turn", json!([spec_for("t_large", "image", json!([image.clone()]))]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{started}");
    assert_eq!(started["started"], true);
    let (_, end) = turn_record(rig.d.port, "t_large").await;
    assert_eq!(end["stop"], "complete", "{end}");
    let saved = saved_session(&rig, "s_large");
    let messages = saved["messages"].as_array().unwrap();
    assert_eq!(messages[0]["images"][0], image);
    assert_eq!(messages.last().unwrap()["content"], format!("synthetic-image-{}", image.len()));
    assert_ne!(messages.last().unwrap()["interrupted"], true);

    let (status, started) =
        post(rig.d.port, "chat:turn", json!([spec_for("t_next", "followup", json!([]))]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{started}");
    let (_, end) = turn_record(rig.d.port, "t_next").await;
    assert_eq!(end["stop"], "complete", "{end}");
    let saved = saved_session(&rig, "s_large");
    let last = saved["messages"].as_array().unwrap().last().unwrap().clone();
    assert_eq!(last["content"], "synthetic-followup");
    assert_eq!(last["role"], "assistant");
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
async fn forks_chats_and_purges_expired_archives_itself() {
    let data = std::env::temp_dir().join(format!("nekkod-fork-purge-{}", std::process::id()));
    let sessions = data.join("sessions");
    std::fs::create_dir_all(&sessions).unwrap();
    let chat = json!({ "id": "s_src", "title": "Source", "workspaceId": "w1", "providerId": "p1", "updatedAt": 5, "messages": [
        { "id": "u1", "role": "user", "content": "one", "createdAt": 1 },
        { "id": "u2", "role": "user", "content": "two", "createdAt": 2 },
    ] });
    let src_bytes = serde_json::to_vec_pretty(&chat).unwrap();
    std::fs::write(sessions.join("s_src.json"), &src_bytes).unwrap();
    // Archived long ago (gone), archived just now (kept), never archived (kept).
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
    for (id, archived) in [("s_old", json!(1)), ("s_recent", json!(now)), ("s_live", Value::Null)] {
        let s = json!({ "id": id, "title": id, "updatedAt": 1, "messages": [], "archivedAt": archived });
        std::fs::write(sessions.join(format!("{id}.json")), serde_json::to_vec(&s).unwrap()).unwrap();
    }
    let d = start_with(true, Some(&data));

    let (_, info) = post(d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    for channel in ["session:fork", "sessions:purgeArchived"] {
        assert!(info["owned"].as_array().unwrap().contains(&json!(channel)), "{channel} is not owned");
    }
    // Served here, not echoed by the backend.
    let (status, fork) = post(d.port, "session:fork", json!(["s_src", "u2"]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{fork}");
    assert_eq!(fork["title"], "Source (split)");
    assert_eq!((fork["workspaceId"].clone(), fork["providerId"].clone()), (json!("w1"), json!("p1")));
    assert_eq!(fork["messages"].as_array().unwrap().len(), 1);
    let fork_id = fork["id"].as_str().unwrap();
    assert_ne!(fork_id, "s_src");
    let (_, saved) = post(d.port, "session:get", json!([fork_id]), Some(TOKEN)).await;
    assert_eq!(saved, fork);
    assert_eq!(std::fs::read(sessions.join("s_src.json")).unwrap(), src_bytes, "the source is untouched");
    let (_, none) = post(d.port, "session:fork", json!(["s_absent"]), Some(TOKEN)).await;
    assert_eq!(none, Value::Null);

    let (status, purged) = post(d.port, "sessions:purgeArchived", json!([]), Some(TOKEN)).await;
    assert_eq!((status, purged), (200, json!(1)));
    assert!(!sessions.join("s_old.json").exists());
    assert!(sessions.join("s_recent.json").exists() && sessions.join("s_live.json").exists());
    // The host dropped the purged chat's command log first.
    let (_, callbacks) = post(d.port, "test:completions", json!([]), Some(TOKEN)).await;
    assert_eq!(callbacks, json!([["s_old"]]));
    drop(d);
    std::fs::remove_dir_all(data).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn settings_are_the_daemons_to_write_when_it_knows_the_data_dir() {
    let data = std::env::temp_dir().join(format!("nekkod-settings-{}", std::process::id()));
    std::fs::create_dir_all(&data).unwrap();
    std::fs::write(data.join("settings.json"), r#"{"theme":"dark","maxSteps":3}"#).unwrap();
    let d = start_with(true, Some(&data));

    let (_, info) = post(d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    assert!(info["owned"].as_array().unwrap().contains(&json!("settings:update")));
    let (status, got) = post(d.port, "settings:get", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    assert_eq!(got["theme"], "dark");
    assert!(got.get("maxSteps").is_none());
    assert!(got["guardrails"].as_array().is_some_and(|g| !g.is_empty()), "merged over the defaults");
    // The UI's update: written by the daemon and told to the host.
    let patch = json!({ "voice": { "enabled": true }, "workspaces": [{ "id": "a", "path": "/x" }, { "id": "b", "path": "/x/" }] });
    let (_, next) = post(d.port, "settings:update", json!([patch]), Some(TOKEN)).await;
    assert_eq!(next["workspaces"], json!([{ "id": "a", "path": "/x" }]));
    let on_disk: Value = serde_json::from_str(&std::fs::read_to_string(data.join("settings.json")).unwrap()).unwrap();
    assert_eq!(on_disk, next);
    // The host's own write: saved, not echoed back to it.
    let (_, saved) = post(d.port, "settings:save", json!([{ "theme": "light" }]), Some(TOKEN)).await;
    assert_eq!((saved["theme"].clone(), saved["voice"].clone()), (json!("light"), json!({ "enabled": true })));
    let (status, err) = post(d.port, "settings:update", json!([null]), Some(TOKEN)).await;
    assert_ne!(status, 200, "a missing patch is refused as saveSettings refuses it: {err}");
    let (_, reset) = post(d.port, "settings:reset", json!([]), Some(TOKEN)).await;
    assert_eq!(reset["theme"], "system");
    tokio::time::sleep(Duration::from_millis(300)).await;
    let (_, calls) = post(d.port, "test:completions", json!([]), Some(TOKEN)).await;
    let changed: Vec<&Value> = calls.as_array().unwrap().iter().filter(|c| c[0] == "settings:changed").collect();
    assert_eq!(changed.len(), 2, "the UI's update and reset reach the host, the host's own save does not: {calls}");
    assert_eq!(changed[0][1], json!([next, patch]));
    assert_eq!(changed[1][1], json!([reset, null]));
    drop(d);
    std::fs::remove_dir_all(data).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn tokens_are_the_daemons_to_read_renew_and_forget() {
    let data = std::env::temp_dir().join(format!("nekkod-tokens-{}", std::process::id()));
    std::fs::create_dir_all(&data).unwrap();
    std::fs::write(
        data.join("settings.json"),
        r#"{"providers":[{"id":"or","kind":"openrouter","tokenKey":"openrouter:k","auth":"apikey"},{"id":"plain","kind":"openai"}]}"#,
    )
    .unwrap();
    std::fs::write(
        data.join("tokens.json"),
        r#"{"openrouter:k":{"provider":"openrouter","accessToken":"sk-or","obtainedAt":1}}"#,
    )
    .unwrap();
    let d = start_with(true, Some(&data));

    let (_, status) = post(d.port, "oauth:status", json!(["or"]), Some(TOKEN)).await;
    assert_eq!(
        status,
        json!({ "tokenKey": "openrouter:k", "provider": "openrouter", "connected": true, "state": "success" })
    );
    let (_, plain) = post(d.port, "oauth:status", json!(["plain"]), Some(TOKEN)).await;
    assert_eq!(plain["message"], "Provider has no token key.");
    // The host's question: a permanent key needs no renewal.
    let (_, fresh) = post(d.port, "oauth:fresh", json!(["openrouter:k", false]), Some(TOKEN)).await;
    assert_eq!(fresh, json!("sk-or"));
    let (status_code, missing) = post(d.port, "oauth:fresh", json!(["claude:none", false]), Some(TOKEN)).await;
    assert_ne!(status_code, 200, "{missing}");
    post(d.port, "oauth:signout", json!(["or"]), Some(TOKEN)).await;
    let tokens: Value = serde_json::from_str(&std::fs::read_to_string(data.join("tokens.json")).unwrap()).unwrap();
    assert_eq!(tokens, json!({}));
    let (_, calls) = post(d.port, "test:completions", json!([]), Some(TOKEN)).await;
    assert!(!calls.to_string().contains("oauth"), "nothing about sign-in reached the host: {calls}");
    drop(d);
    std::fs::remove_dir_all(data).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn providers_are_listed_saved_tested_and_asked_for_models_by_the_daemon() {
    let data = std::env::temp_dir().join(format!("nekkod-providers-{}", std::process::id()));
    std::fs::create_dir_all(&data).unwrap();
    // An OpenAI-compatible server that wants a key.
    let app = axum::Router::new().route(
        "/v1/models",
        axum::routing::get(|headers: axum::http::HeaderMap| async move {
            if headers.get("authorization").and_then(|v| v.to_str().ok()) == Some("Bearer k1") {
                (axum::http::StatusCode::OK, axum::Json(json!({ "data": [{ "id": "m1" }, { "id": "m2" }] })))
            } else {
                (axum::http::StatusCode::UNAUTHORIZED, axum::Json(json!({ "error": { "message": "bad key" } })))
            }
        }),
    );
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    let d = start_with(true, Some(&data));

    let p = json!({ "id": "p1", "kind": "openai-compat", "label": "Local", "baseUrl": base, "apiKey": "k1", "enabled": true });
    let (_, saved) = post(d.port, "providers:save", json!([p]), Some(TOKEN)).await;
    assert_eq!(saved, json!([p]));
    let (_, listed) = post(d.port, "providers:list", json!([]), Some(TOKEN)).await;
    assert_eq!(listed, json!([p]));
    let (_, ok) = post(d.port, "providers:test", json!(["p1"]), Some(TOKEN)).await;
    assert_eq!(ok, json!({ "ok": true, "message": "Connected" }));
    let mut bad = p.clone();
    bad["apiKey"] = json!("nope");
    let (_, refused) = post(d.port, "providers:testConfig", json!([bad]), Some(TOKEN)).await;
    assert_eq!(refused, json!({ "ok": false, "message": "HTTP 401, check your API key: bad key" }));
    let (_, missing) = post(d.port, "providers:test", json!(["nope"]), Some(TOKEN)).await;
    assert_eq!(missing, json!({ "ok": false, "message": "Not found" }));
    let (_, models) = post(d.port, "models:list", json!(["p1"]), Some(TOKEN)).await;
    let ids: Vec<&str> = models.as_array().unwrap().iter().map(|m| m["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["m1", "m2"]);
    let (_, none) = post(d.port, "lms:probe", json!(["p1"]), Some(TOKEN)).await;
    assert_eq!(none, json!({ "available": false }));
    let (_, removed) = post(d.port, "providers:remove", json!(["p1"]), Some(TOKEN)).await;
    assert_eq!(removed, json!([]));
    let on_disk: Value = serde_json::from_str(&std::fs::read_to_string(data.join("settings.json")).unwrap()).unwrap();
    assert_eq!(on_disk["providers"], json!([]));
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
    scripted_model_with_titles(script, None).await
}

async fn scripted_model_with_titles(
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

fn title_requests(model: &ScriptedModel) -> usize {
    model.requests.lock().unwrap().iter().filter(|r| r["messages"].to_string().contains("short title")).count()
}

async fn wait_for_title_requests(model: &ScriptedModel, count: usize) {
    tokio::time::timeout(Duration::from_secs(20), async {
        while title_requests(model) < count {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("title request never arrived");
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
    turn_rig_with(name, session, json!({}))
}

fn turn_rig_with(name: &str, session: Value, extra: Value) -> TurnRig {
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

fn turn_spec(rig: &TurnRig, model: &ScriptedModel, turn_id: &str, session_id: &str, extra_opts: Value) -> Value {
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
    .unwrap_or_else(|_| panic!("no pending {key} {call_id}"))
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
async fn chat_send_is_admitted_and_driven_by_the_daemon() {
    let session = json!({
        "id": "s_admit", "title": "New chat", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1
    });
    let rig = turn_rig("admit", session);
    let model = scripted_model(vec![say_text("the answer")]).await;
    let provider = json!({
        "id": "p1", "kind": "openai-compat", "label": "Scripted", "enabled": true,
        "baseUrl": format!("http://127.0.0.1:{}/v1", model.port),
    });
    let settings = json!({
        "providers": [provider, { "id": "off", "kind": "openai", "label": "Off", "enabled": false, "baseUrl": "https://api.openai.com/v1" }],
        "workspaces": [{ "id": "w1", "name": "project", "path": rig.workspace.to_string_lossy() }],
        "defaultChatMode": "yolo",
    });
    std::fs::write(rig.data.join("settings.json"), settings.to_string()).unwrap();

    let (_, info) = post(rig.d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    assert!(info["owned"].as_array().unwrap().contains(&json!("chat:send")));
    // A disabled provider is refused here, as admitTurn refuses it.
    let opts = json!({ "sessionId": "s_admit", "providerId": "off", "modelId": "m", "text": "hello" });
    let (status, _) = post(rig.d.port, "chat:send", json!([opts]), Some(TOKEN)).await;
    assert_eq!(status, 200);

    // The workspace index now lives in this daemon, not in the fake host.
    let (status, indexed) = post(rig.d.port, "workspace:index", json!(["w1"]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{indexed}");
    assert_eq!(indexed["state"], "ready");

    // The whole chain runs before chat:send answers, as sendChat resolved.
    let opts =
        json!({ "sessionId": "s_admit", "providerId": "p1", "modelId": "synthetic", "text": "Explain the pineapple" });
    let (status, body) = post(rig.d.port, "chat:send", json!([opts]), Some(TOKEN)).await;
    assert_eq!((status, body), (200, Value::Null));
    let saved = saved_session(&rig, "s_admit");
    let messages = saved["messages"].as_array().unwrap();
    assert_eq!(messages.first().unwrap()["content"], "Explain the pineapple");
    assert_eq!(messages.last().unwrap()["content"], "the answer");

    let (_, calls) = post(rig.d.port, "test:completions", json!([]), Some(TOKEN)).await;
    let calls = calls.as_array().unwrap();
    let adopt = calls.iter().find(|c| c[0] == "turn:adopt").expect("the host was handed the turn");
    let turn_id = adopt[1][0]["turnId"].as_str().unwrap().to_string();
    assert!(turn_id.starts_with("turn_d"), "{turn_id}");
    assert_eq!(adopt[1][0]["workspaces"][0]["id"], "w1");
    assert!(calls.iter().any(|c| c[0] == "turn:end" && c[1][0] == turn_id.as_str()));
    assert!(!calls.iter().any(|c| c[0] == "chat:indexSnippets"), "the daemon gathers its own index snippets");
    assert!(!calls.iter().any(|c| c[0] == "chat:connectorSnippets"), "no connector is connected");
    // The snippets and the guidelines reached the model.
    let requests = model.requests.lock().unwrap().clone();
    let system = requests[0]["messages"][0]["content"].as_str().unwrap().to_string();
    assert!(system.contains("Always run the tests."), "{system}");
    assert!(system.contains("1: export const secret = 'pineapple';"), "{system}");
}

/// A model that streams `n` words of `word`, one chunk every `gap`.
fn slow_text(word: &str, n: usize) -> String {
    let mut chunks: Vec<Value> =
        (0..n).map(|i| json!({ "choices": [{ "delta": { "content": format!("{word}{i} ") }, "finish_reason": null }] })).collect();
    chunks.push(json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }], "usage": { "prompt_tokens": 10, "completion_tokens": n } }));
    sse(&chunks)
}

/// Everything a socket receives until both chats' `done`, as (channel, payload).
async fn collect_until_done(socket: &mut Socket, sessions: &[&str]) -> Vec<(String, Value)> {
    let mut seen = Vec::new();
    let mut done = std::collections::HashSet::new();
    let deadline = Instant::now() + Duration::from_secs(30);
    while done.len() < sessions.len() {
        let Some(frame) = next_json(socket, deadline.saturating_duration_since(Instant::now())).await else {
            panic!("socket went quiet; done for {done:?}, saw {}", seen.len())
        };
        let Some(channel) = frame["channel"].as_str() else { continue };
        let payload = frame["payload"].clone();
        if channel == "agent:event" && payload["type"] == "done" {
            done.insert(payload["sessionId"].as_str().unwrap_or_default().to_string());
        }
        seen.push((channel.to_string(), payload));
    }
    seen
}

fn streamed_text(frames: &[(String, Value)], session: &str) -> String {
    let mut out = String::new();
    for (channel, p) in frames {
        if channel == "agent:replay" && p["sessionId"] == session {
            for e in p["events"].as_array().unwrap() {
                if e["type"] == "text" {
                    out.push_str(e["delta"].as_str().unwrap());
                }
            }
        } else if channel == "agent:event" && p["sessionId"] == session && p["type"] == "text" {
            out.push_str(p["delta"].as_str().unwrap());
        }
    }
    out
}

#[tokio::test(flavor = "multi_thread")]
async fn sockets_take_only_the_chats_they_subscribe_to_and_the_host_only_how_turns_end() {
    let chat = |id: &str| json!({ "id": id, "title": "Named", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1 });
    let rig = turn_rig("subscribe", chat("s_one"));
    std::fs::write(rig.data.join("sessions").join("s_two.json"), chat("s_two").to_string()).unwrap();
    // Each reply is 40 chunks, so 40 text events per chat, interleaved.
    let model = scripted_model(vec![slow_text("one", 40), slow_text("two", 40)]).await;
    let port = rig.d.port;

    // Socket A takes s_one's stream (daemon:subscribe), B s_two's (?sessions=),
    // C every chat (no subscription, as before).
    let mut a = ws(port, &format!("/api/ws?token={TOKEN}"), None).await.unwrap();
    a.send(Message::Text(json!({ "id": 1, "channel": "daemon:subscribe", "args": [["s_one"]] }).to_string().into()))
        .await
        .unwrap();
    let ack = next_json(&mut a, Duration::from_secs(5)).await.unwrap();
    assert_eq!(ack, json!({ "id": 1, "result": true }), "no turn is running yet, so nothing comes before the answer");
    let mut b = ws(port, &format!("/api/ws?sessions=s_two&token={TOKEN}"), None).await.unwrap();
    let mut c = ws(port, &format!("/api/events?token={TOKEN}"), None).await.unwrap();

    let mut one = turn_spec(&rig, &model, "turn_one", "s_one", json!({}));
    let mut two = turn_spec(&rig, &model, "turn_two", "s_two", json!({}));
    // As a host whose relay, messaging and accounting are the daemon's asks.
    one["facts"]["hostEvents"] = json!(["done", "error"]);
    two["facts"]["hostEvents"] = json!(["done", "error"]);
    let (s1, _) = post(port, "chat:turn", json!([one]), Some(TOKEN)).await;
    let (s2, _) = post(port, "chat:turn", json!([two]), Some(TOKEN)).await;
    assert_eq!((s1, s2), (200, 200));

    let (fa, fb, fc) = tokio::join!(
        collect_until_done(&mut a, &["s_one", "s_two"]),
        collect_until_done(&mut b, &["s_one", "s_two"]),
        collect_until_done(&mut c, &["s_one", "s_two"]),
    );
    let words = |w: &str| (0..40).map(|i| format!("{w}{i} ")).collect::<String>();
    // Every socket has its own chat's whole reply, once.
    assert_eq!(streamed_text(&fa, "s_one"), words("one"));
    assert_eq!(streamed_text(&fb, "s_two"), words("two"));
    assert_eq!(streamed_text(&fc, "s_one"), words("one"));
    assert_eq!(streamed_text(&fc, "s_two"), words("two"));
    // Of the other chat a subscribed socket hears the turn start and end,
    // and none of its stream after the first event.
    let of = |frames: &[(String, Value)], s: &str| -> Vec<String> {
        frames
            .iter()
            .filter(|(ch, p)| ch == "agent:event" && p["sessionId"] == s)
            .map(|(_, p)| p["type"].as_str().unwrap().to_string())
            .collect()
    };
    let other_a = of(&fa, "s_two");
    let other_b = of(&fb, "s_one");
    assert!(other_a.first().is_some_and(|t| t != "done") && other_a.last().is_some_and(|t| t == "done"), "{other_a:?}");
    assert!(other_a.len() <= 4, "a's view of s_two is a summary: {other_a:?}");
    assert!(other_b.len() <= 4, "b's view of s_one is a summary: {other_b:?}");
    let frames = |f: &[(String, Value)]| f.iter().filter(|(ch, _)| ch == "agent:event").count();
    assert!(frames(&fa) * 3 < frames(&fc) * 2, "a {} frames vs c {}", frames(&fa), frames(&fc));
    println!("agent frames per socket: subscribed a={} b={}, unsubscribed c={}", frames(&fa), frames(&fb), frames(&fc));

    // The host asked only for how the turns end.
    for turn in ["turn_one", "turn_two"] {
        let (events, _) = turn_record(port, turn).await;
        assert_eq!(event_types(&events), ["done"], "{turn}");
    }

    // A socket that starts showing a chat mid-turn is sent the turn so far.
    let model2 = scripted_model(vec![call_tool("c_wait", "ask_user", json!({ "questions": [{ "question": "Go?", "options": ["yes", "no"] }] })), say_text("went")]).await;
    let mut three = turn_spec(&rig, &model2, "turn_three", "s_one", json!({}));
    three["facts"]["hostEvents"] = json!(["done", "error"]);
    post(port, "chat:turn", json!([three]), Some(TOKEN)).await;
    wait_pending(port, "s_one", "question", "c_wait").await;
    let mut late = ws(port, &format!("/api/ws?sessions=s_two&token={TOKEN}"), None).await.unwrap();
    // Connected narrowed: told that s_one is running (its first event).
    let first = next_json(&mut late, Duration::from_secs(5)).await.unwrap();
    assert_eq!((first["channel"].as_str(), first["payload"]["sessionId"].as_str()), (Some("agent:event"), Some("s_one")), "{first}");
    late.send(Message::Text(json!({ "id": 7, "channel": "daemon:subscribe", "args": [["s_one", "s_two"]] }).to_string().into()))
        .await
        .unwrap();
    let replay = next_json(&mut late, Duration::from_secs(5)).await.unwrap();
    assert_eq!(replay["channel"], "agent:replay", "{replay}");
    let types: Vec<&str> = replay["payload"]["events"].as_array().unwrap().iter().map(|e| e["type"].as_str().unwrap()).collect();
    assert!(types.contains(&"tool_call") && types.contains(&"question"), "{types:?}");
    assert_eq!(next_json(&mut late, Duration::from_secs(5)).await.unwrap(), json!({ "id": 7, "result": true }));
    post(port, "chat:answer", json!(["s_one", "c_wait", [{ "questionId": "q1", "labels": ["yes"] }]]), Some(TOKEN)).await;
    let rest = collect_until_done(&mut late, &["s_one"]).await;
    assert!(rest.iter().all(|(ch, p)| ch != "agent:event" || p["type"] != "question"), "the question is not sent twice");
    assert_eq!(streamed_text(&rest, "s_one"), "went");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_daemon_turn_asks_runs_tools_and_saves_every_step() {
    let session = json!({
        "id": "s_turn_q", "title": "New chat", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1
    });
    let rig = turn_rig("ask", session);
    let model = scripted_model(vec![
        call_tool(
            "c_ask",
            "ask_user",
            json!({ "questions": [{ "question": "Which bug?", "options": ["Login", "Logout"] }] }),
        ),
        call_tool("c_read", "read_file", json!({ "path": "app.ts" })),
        call_tool("c_host", "delegation_targets", json!({})),
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
    // The placeholder, or the generated title once it has landed after the turn.
    let titled = (saved["title"].clone(), saved["titleAuto"].clone());
    assert!(
        titled == (json!("Fix the bug"), json!(true)) || titled == (json!("Login bug fix"), json!(false)),
        "{titled:?}"
    );
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

#[tokio::test(flavor = "multi_thread")]
async fn a_chain_the_daemon_admitted_admits_its_queued_prompts_too() {
    let session = json!({
        "id": "s_chain", "title": "New chat", "workspaceId": "w1", "messages": [], "queue": ["and then this"],
        "createdAt": 1, "updatedAt": 1
    });
    let rig = turn_rig("chain", session);
    let model = scripted_model(vec![say_text("first answer"), say_text("second answer")]).await;
    let provider = json!({
        "id": "p1", "kind": "openai-compat", "label": "Scripted", "enabled": true,
        "baseUrl": format!("http://127.0.0.1:{}/v1", model.port),
    });
    let settings = json!({
        "providers": [provider],
        "workspaces": [{ "id": "w1", "name": "project", "path": rig.workspace.to_string_lossy() }],
        "defaultChatMode": "yolo",
    });
    std::fs::write(rig.data.join("settings.json"), settings.to_string()).unwrap();

    let opts = json!({ "sessionId": "s_chain", "providerId": "p1", "modelId": "synthetic", "text": "first" });
    let (status, body) = post(rig.d.port, "chat:send", json!([opts]), Some(TOKEN)).await;
    assert_eq!((status, body), (200, Value::Null));
    let saved = saved_session(&rig, "s_chain");
    let contents: Vec<&str> =
        saved["messages"].as_array().unwrap().iter().filter_map(|m| m["content"].as_str()).collect();
    assert_eq!(contents, ["first", "first answer", "and then this", "second answer"]);
    assert_eq!(saved["queue"], json!([]));

    let (_, calls) = post(rig.d.port, "test:completions", json!([]), Some(TOKEN)).await;
    let calls = calls.as_array().unwrap();
    assert!(!calls.iter().any(|c| c[0] == "turn:prepare"), "the daemon admitted the follow-up itself");
    let adopts: Vec<&Value> = calls.iter().filter(|c| c[0] == "turn:adopt").collect();
    assert_eq!(adopts.len(), 2, "{adopts:?}");
    assert_eq!(adopts[0][1][0]["chained"], false);
    assert_eq!(adopts[1][1][0]["chained"], true);
    assert_eq!(adopts[1][1][0]["opts"]["text"], "and then this");
    let (first, second) = (adopts[0][1][0]["turnId"].as_str().unwrap(), adopts[1][1][0]["turnId"].as_str().unwrap());
    assert!(second.starts_with("turn_d"), "{second}");
    let ends: Vec<&Value> = calls.iter().filter(|c| c[0] == "turn:end").collect();
    let first_end = ends.iter().find(|c| c[1][0] == first).expect("the first turn ended");
    assert_eq!(first_end[1][1]["next"], second);
}

#[tokio::test(flavor = "multi_thread")]
async fn after_a_daemon_turn_the_title_lands_and_the_queue_drains() {
    let session = json!({
        "id": "s_turn_t", "title": "New chat", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1
    });
    let rig = turn_rig("after", session);
    let (release, responses) = tokio::sync::mpsc::unbounded_channel();
    let model = scripted_model_with_titles(
        vec![say_text("first answer"), say_text("second answer")],
        Some(std::sync::Arc::new(tokio::sync::Mutex::new(responses))),
    )
    .await;
    let spec = turn_spec(&rig, &model, "turn_t", "s_turn_t", json!({}));
    let (status, _) = post(rig.d.port, "test:prepareTemplate", json!([spec.clone()]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    // A follow-up queued while the turn runs: it is the daemon's to run next.
    let (status, _) = post(rig.d.port, "chat:queue", json!(["s_turn_t", "and then this"]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let (status, _) = post(rig.d.port, "chat:turn", json!([spec]), Some(TOKEN)).await;
    assert_eq!(status, 200);

    let (_, first) = turn_record(rig.d.port, "turn_t").await;
    assert_eq!(first["next"], "turn_next_1", "{first}");
    let (_, second) = turn_record(rig.d.port, "turn_next_1").await;
    assert_eq!(second["stop"], "complete", "{second}");
    assert!(second.get("next").is_none(), "the queue is empty after one follow-up");

    wait_for_title_requests(&model, 1).await;
    let pending = saved_session(&rig, "s_turn_t");
    assert_eq!(pending["titleAuto"], true, "title response is still held");
    assert_eq!(pending["queue"], json!([]), "queue drains without waiting for the title");
    assert_eq!(title_requests(&model), 1, "the queued turn must not request another title");
    release.send(say_text("\"Login bug fix.\"")).unwrap();

    // The title lands on its own, after the first turn.
    let saved = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let saved = saved_session(&rig, "s_turn_t");
            if saved["titleAuto"] == false {
                return saved;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("the title never landed");
    assert_eq!(saved["title"], "Login bug fix");
    let messages = saved["messages"].as_array().unwrap();
    let contents: Vec<&str> = messages.iter().filter_map(|m| m["content"].as_str()).collect();
    assert_eq!(contents, ["Fix the bug", "first answer", "and then this", "second answer"]);
    assert_eq!(saved["queue"], json!([]), "the queued prompt was claimed by its turn");

    let (_, all) = post(rig.d.port, "test:completions", json!([]), Some(TOKEN)).await;
    let all = all.as_array().unwrap();
    let prepare = all.iter().find(|e| e[0] == "turn:prepare").expect("the host admitted the follow-up");
    assert_eq!(prepare[1][0], "turn_t");
    assert_eq!(prepare[1][1]["queued"], json!({ "index": 0, "item": "and then this" }));
    assert_eq!(prepare[1][1]["opts"]["text"], "and then this");
    // The title call's usage is in the log, written by the daemon, which keeps it.
    assert!(!all.iter().any(|e| e[0] == "turn:usage"), "no usage callback when the daemon keeps the log");
    let log = std::fs::read_to_string(rig.data.join("usage.jsonl")).unwrap_or_default();
    assert!(
        log.lines().filter(|l| l.contains(r#""sessionId":"s_turn_t""#)).any(|l| l.contains(r#""providerId":"p1""#)),
        "{log}"
    );
    assert!(all.iter().any(|e| e[0] == "turn:notify" && e[1][0]["type"] == "session_meta"));
    let titles =
        model.requests.lock().unwrap().iter().filter(|r| r["messages"].to_string().contains("short title")).count();
    assert_eq!(titles, 1, "one title, for the first turn only");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_daemon_turn_writes_its_own_usage_and_reply_lines() {
    let session = json!({
        "id": "s_turn_u", "title": "Named", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1
    });
    let rig = turn_rig("usage", session);
    std::fs::write(
        rig.data.join("settings.json"),
        json!({ "providers": [{ "id": "p1", "kind": "openai-compat" }, { "id": "c1", "kind": "anthropic", "auth": "subscription", "tokenKey": "claude:t" }] }).to_string(),
    )
    .unwrap();
    let (_, info) = post(rig.d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    for c in ["turn:account", "usage:summary", "limits:get", "limits:headers"] {
        assert!(info["owned"].as_array().unwrap().iter().any(|o| o == c), "{c} not owned: {info}");
    }

    let model = scripted_model(vec![say_text("hello")]).await;
    let mut spec = turn_spec(&rig, &model, "turn_u", "s_turn_u", json!({}));
    spec["facts"]["account"] = json!({ "auth": "apikey", "kind": "openai-compat", "incognito": false });
    let (status, _) = post(rig.d.port, "chat:turn", json!([spec]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let (_, end) = turn_record(rig.d.port, "turn_u").await;
    assert_eq!(end["stop"], "complete", "{end}");

    // The lines the host would have written, written by the daemon.
    let usage = std::fs::read_to_string(rig.data.join("usage.jsonl")).unwrap();
    let lines: Vec<Value> = usage.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    assert_eq!(lines.len(), 1, "{usage}");
    let keys: Vec<&str> = lines[0].as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(keys, ["ts", "providerId", "modelId", "inputTokens", "outputTokens", "sessionId", "auth", "local"]);
    assert_eq!(lines[0]["inputTokens"], 10);
    assert_eq!(lines[0]["outputTokens"], 3);
    assert_eq!(lines[0]["local"], false);
    let replies = std::fs::read_to_string(rig.data.join("replies.jsonl")).unwrap();
    let reply: Value = serde_json::from_str(replies.trim()).unwrap();
    assert_eq!(reply["stop"], "complete");
    assert_eq!(reply["steps"], 0);
    assert_eq!(reply["sessionId"], "s_turn_u");
    assert_eq!(reply["effort"], "normal");
    assert!(reply["startedAt"].as_u64().unwrap() <= reply["ts"].as_u64().unwrap());

    // And the summary is the daemon's.
    let (status, summary) = post(rig.d.port, "usage:summary", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{summary}");
    assert_eq!(summary["totalInput"], 10);
    assert_eq!(summary["bySession"]["s_turn_u"]["output"], 3);
    assert_eq!(summary["replies"]["total"], 1);

    // Limits: headers recorded here, read back here, history written, the host told for the relay.
    let pairs = json!([
        ["anthropic-ratelimit-unified-5h-utilization", "0.25"],
        ["anthropic-ratelimit-unified-5h-reset", "1760003600"]
    ]);
    let (_, recorded) = post(rig.d.port, "limits:headers", json!(["claude:t", "anthropic", pairs]), Some(TOKEN)).await;
    assert_eq!(recorded["windows"][0]["usedPercent"], 25);
    let (_, got) = post(rig.d.port, "limits:get", json!(["claude:t"]), Some(TOKEN)).await;
    assert_eq!(got, recorded, "a fresh header snapshot is served without a poll");
    let history = std::fs::read_to_string(rig.data.join("quota-history.jsonl")).unwrap();
    assert!(history.contains(r#""providerId":"c1","source":"headers""#), "{history}");
    let notified = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let (_, all) = post(rig.d.port, "test:completions", json!([]), Some(TOKEN)).await;
            if let Some(n) = all.as_array().unwrap().iter().find(|e| e[0] == "limits:notify") {
                return n.clone();
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("the host hears limits:notify");
    assert_eq!(notified[1][0]["tokenKey"], "claude:t");
    // No sign-in stored: a poll says so rather than guessing.
    let (_, polled) = post(rig.d.port, "limits:get", json!(["claude:none"]), Some(TOKEN)).await;
    assert_eq!(polled, Value::Null);
    let (_, problem) = post(rig.d.port, "limits:problem", json!(["claude:none"]), Some(TOKEN)).await;
    assert_eq!(problem["kind"], "signed_out");
}

#[tokio::test(flavor = "multi_thread")]
async fn without_a_data_dir_accounting_stays_with_the_host() {
    let d = start(true);
    let (_, info) = post(d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    let owned = info["owned"].as_array().unwrap();
    assert!(!owned.iter().any(|o| o == "limits:get" || o == "turn:account"), "{info}");
    let (status, body) = post(d.port, "limits:get", json!(["k"]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    assert_eq!(body["echo"], "limits:get", "forwarded to the host: {body}");
}

/// A streamable-HTTP MCP server with one tool, `echo`, on a loopback port.
#[tokio::test(flavor = "multi_thread")]
async fn reports_mcp_status_from_its_own_servers() {
    let (mcp_port, mcp_server, _) = http_mcp().await;
    let data = std::env::temp_dir().join(format!("nekkod-mcp-status-{}", std::process::id()));
    std::fs::create_dir_all(&data).unwrap();
    let settings = json!({ "mcpServers": [
        { "id": "srv", "name": "Echo", "enabled": true, "command": "", "args": [], "url": format!("http://127.0.0.1:{mcp_port}/mcp") },
        { "id": "off", "name": "Off", "enabled": false, "command": "nope", "args": [] },
    ] });
    std::fs::write(data.join("settings.json"), settings.to_string()).unwrap();
    let d = start_with(true, Some(&data));
    let (_, info) = post(d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    assert!(info["owned"].as_array().unwrap().contains(&json!("mcp:status")), "{info}");
    let (status, rows) = post(d.port, "mcp:status", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    assert_eq!(
        rows,
        json!([
            { "id": "srv", "name": "Echo", "connected": true, "tools": [{ "name": "echo", "description": "Echo it" }] },
            { "id": "off", "name": "Off", "connected": false, "tools": [] },
        ])
    );
    // Answered here: the backend never heard of it.
    let (_, all) = post(d.port, "test:completions", json!([]), Some(TOKEN)).await;
    assert!(!all.as_array().unwrap().iter().any(|e| e[0] == "mcp:status"), "{all}");
    mcp_server.abort();
    drop(d);
    std::fs::remove_dir_all(data).ok();
}

async fn http_mcp() -> (u16, tokio::task::JoinHandle<()>, std::sync::Arc<std::sync::Mutex<Vec<Value>>>) {
    use axum::routing::post as route_post;
    let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let seen = calls.clone();
    let app = axum::Router::new().route(
        "/mcp",
        route_post(move |axum::Json(msg): axum::Json<Value>| {
            let seen = seen.clone();
            async move {
                let Some(id) = msg.get("id").cloned() else {
                    return (axum::http::StatusCode::ACCEPTED, axum::Json(Value::Null));
                };
                let result = match msg["method"].as_str().unwrap_or_default() {
                    "initialize" => json!({ "protocolVersion": "2024-11-05" }),
                    "tools/list" => {
                        json!({ "tools": [{ "name": "echo", "description": "Echo it", "inputSchema": { "type": "object" } }] })
                    }
                    _ => {
                        seen.lock().unwrap().push(msg.clone());
                        let text = msg["params"]["arguments"]["text"].as_str().unwrap_or("").to_string();
                        json!({ "content": [{ "type": "text", "text": format!("echo: {text}") }] })
                    }
                };
                (axum::http::StatusCode::OK, axum::Json(json!({ "jsonrpc": "2.0", "id": id, "result": result })))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    (port, tokio::spawn(async move { axum::serve(listener, app).await.unwrap() }), calls)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_daemon_turn_syncs_and_calls_its_mcp_servers_itself() {
    let session = json!({
        "id": "s_turn_m", "title": "Named", "mode": "ask", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1
    });
    let rig = turn_rig("mcp", session);
    let (_, info) = post(rig.d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    assert!(info["owned"].as_array().unwrap().iter().any(|o| o == "turn:mcp"), "{info}");
    let (mcp_port, mcp_server, mcp_calls) = http_mcp().await;
    let model =
        scripted_model(vec![call_tool("c_mcp", "mcp__srv__echo", json!({ "text": "hi" })), say_text("done")]).await;
    let mut spec = turn_spec(&rig, &model, "turn_m", "s_turn_m", json!({}));
    spec["settings"]["defaultChatMode"] = json!("ask");
    let facts = spec["facts"].as_object_mut().unwrap();
    facts.remove("mcpTools");
    facts.insert(
        "mcpServers".into(),
        json!([{ "id": "srv", "name": "srv", "enabled": true, "command": "", "args": [], "url": format!("http://127.0.0.1:{mcp_port}/mcp") }]),
    );
    let (status, _) = post(rig.d.port, "chat:turn", json!([spec]), Some(TOKEN)).await;
    assert_eq!(status, 200);

    // Ask mode: the MCP call's approval is parked in the daemon and answered there.
    let approval = wait_pending(rig.d.port, "s_turn_m", "approval", "c_mcp").await;
    assert_eq!(approval["reason"], "Call mcp__srv__echo");
    assert_eq!(approval["severity"], "medium");
    let (status, body) = post(rig.d.port, "tool:approve", json!(["s_turn_m", "c_mcp", true]), Some(TOKEN)).await;
    assert_eq!((status, body), (200, Value::Null));
    let (_, end) = turn_record(rig.d.port, "turn_m").await;
    assert_eq!(end["stop"], "complete", "{end}");

    // The daemon synced the server, offered its tool and ran the call; the host never saw it.
    let tools: Vec<String> = model.requests.lock().unwrap()[0]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["function"]["name"].as_str().unwrap().to_string())
        .collect();
    assert!(tools.contains(&"mcp__srv__echo".to_string()), "{tools:?}");
    assert_eq!(mcp_calls.lock().unwrap().len(), 1);
    let (_, all) = post(rig.d.port, "test:completions", json!([]), Some(TOKEN)).await;
    assert!(!all.as_array().unwrap().iter().any(|e| e[0] == "turn:tool"), "no host round trip for MCP");
    let saved = saved_session(&rig, "s_turn_m");
    let result = saved["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["role"] == "tool" && m["toolResult"]["toolCallId"] == "c_mcp")
        .unwrap()
        .clone();
    assert_eq!(result["toolResult"]["output"], "echo: hi");
    mcp_server.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn hypergate_is_found_and_connected_by_the_daemon() {
    use axum::routing::{get, post as route_post};
    let gate = axum::Router::new()
        .route(
            "/health",
            get(|| async { axum::Json(json!({ "service": "hypergated", "version": "9.9", "servers": 2 })) }),
        )
        .route("/api/gateway", get(|| async { axum::Json(json!({ "url": "http://127.0.0.1:1/mcp", "token": "gw" })) }))
        .route(
            "/api/clients/resolve",
            route_post(|| async { axum::Json(json!({ "token": "agent", "name": "Nekko Agent" })) }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move { axum::serve(listener, gate).await.unwrap() });
    let d = start(true);
    let (_, found) = post(d.port, "mcp:hypergate", json!([port]), Some(TOKEN)).await;
    assert_eq!(found["version"], "9.9");
    assert_eq!(found["port"], port);
    assert!(found.get("token").is_none(), "detecting mints nothing");
    let (_, connected) = post(d.port, "mcp:hypergate:connect", json!([port]), Some(TOKEN)).await;
    assert_eq!(connected["token"], "agent");
    assert_eq!(connected["agent"], "Nekko Agent");
    let (_, all) = post(d.port, "test:completions", json!([]), Some(TOKEN)).await;
    let save = all.as_array().unwrap().iter().find(|e| e[0] == "mcp:hypergate:save").expect("the host saved the entry");
    assert_eq!(save[1][0]["token"], "agent");
    // Nothing listening: null, not an error.
    server.abort();
    let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let (status, none) = post(d.port, "mcp:hypergate", json!([free]), Some(TOKEN)).await;
    assert_eq!((status, none), (200, Value::Null));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_daemon_turn_drives_its_sub_agent_and_answers_with_it() {
    let session = json!({
        "id": "s_turn_p", "title": "Named", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1
    });
    let rig = turn_rig("spawn", session);
    let (_, info) = post(rig.d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    assert!(info["owned"].as_array().unwrap().iter().any(|o| o == "turn:spawn"), "{info}");
    let model = scripted_model(vec![
        call_tool("c_spawn", "spawn_agent", json!({ "task": "count the files" })),
        say_text("there are 2 files"),
        say_text("parent done"),
    ])
    .await;
    let spec = turn_spec(&rig, &model, "turn_p", "s_turn_p", json!({}));
    // The child's turn is admitted by the host from this template.
    let (status, _) = post(rig.d.port, "test:prepareTemplate", json!([spec.clone()]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let mut spec = spec;
    spec["facts"]["spawn"] = json!(true);
    let (status, _) = post(rig.d.port, "chat:turn", json!([spec]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let (_, end) = turn_record(rig.d.port, "turn_p").await;
    assert_eq!(end["stop"], "complete", "{end}");

    let (_, all) = post(rig.d.port, "test:completions", json!([]), Some(TOKEN)).await;
    let all = all.as_array().unwrap().clone();
    let prepare = all.iter().find(|e| e[0] == "spawn:prepare").expect("the host was asked to make the child");
    assert_eq!(prepare[1][0], "turn_p");
    assert_eq!(prepare[1][2], 0, "first attempt");
    assert!(!all.iter().any(|e| e[0] == "turn:tool"), "spawn_agent never ran in the host");
    assert!(all.iter().any(|e| e[0] == "turn:end" && e[1][0] == "turn_child"), "the child ran as its own daemon turn");

    let child = saved_session(&rig, "s_child");
    assert_eq!(child["messages"][0]["content"], "count the files");
    assert_eq!(child["messages"].as_array().unwrap().last().unwrap()["content"], "there are 2 files");
    let parent = saved_session(&rig, "s_turn_p");
    let result = parent["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["role"] == "tool" && m["toolResult"]["toolCallId"] == "c_spawn")
        .unwrap()
        .clone();
    assert_eq!(result["toolResult"]["output"], "there are 2 files");
    assert_eq!(parent["messages"].as_array().unwrap().last().unwrap()["content"], "parent done");
}

#[tokio::test(flavor = "multi_thread")]
async fn stopping_the_parent_stops_its_sub_agent() {
    let session = json!({
        "id": "s_turn_ps", "title": "Named", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1
    });
    let rig = turn_rig("spawn-stop", session);
    let model =
        scripted_model(vec![call_tool("c_spawn", "spawn_agent", json!({ "task": "wait forever" })), HANG.to_string()])
            .await;
    let spec = turn_spec(&rig, &model, "turn_ps", "s_turn_ps", json!({}));
    post(rig.d.port, "test:prepareTemplate", json!([spec.clone()]), Some(TOKEN)).await;
    let mut spec = spec;
    spec["facts"]["spawn"] = json!(true);
    post(rig.d.port, "chat:turn", json!([spec]), Some(TOKEN)).await;
    // Wait for the child to be running, then stop the parent.
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let (_, alive) = post(rig.d.port, "turn:alive", json!(["turn_child"]), Some(TOKEN)).await;
            if alive == json!(true) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("the child started");
    let (_, stopped) = post(rig.d.port, "turn:abort", json!(["turn_ps"]), Some(TOKEN)).await;
    assert_eq!(stopped, json!(true));
    let (_, end) = turn_record(rig.d.port, "turn_ps").await;
    assert_eq!(end["aborted"], true, "{end}");
    let (_, child_alive) = post(rig.d.port, "turn:alive", json!(["turn_child"]), Some(TOKEN)).await;
    assert_eq!(child_alive, json!(false), "the child stopped with its parent");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_daemon_turn_runs_the_local_decide_tool_itself() {
    let session = json!({
        "id": "s_turn_d", "title": "Named", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1
    });
    let rig = turn_rig("decide", session);
    let model = scripted_model(vec![
        call_tool("c_empty", "decide", json!({ "state": "  ", "questions": [{ "id": "q", "type": "noul", "instructions": "x" }] })),
        call_tool("c_run", "decide", json!({ "state": "a refund after 40 days", "questions": [{ "id": "refund", "type": "choice", "instructions": "Grant it?", "options": ["yes", "no"] }] })),
        say_text("decided"),
    ])
    .await;
    let mut spec = turn_spec(&rig, &model, "turn_d", "s_turn_d", json!({}));
    spec["facts"]["decide"] = json!(true);
    spec["facts"]["decideWith"] = json!("local");
    let (status, _) = post(rig.d.port, "chat:turn", json!([spec]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let (_, end) = turn_record(rig.d.port, "turn_d").await;
    assert_eq!(end["stop"], "complete", "{end}");
    let saved = saved_session(&rig, "s_turn_d");
    let out = |id: &str| -> Value {
        saved["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["role"] == "tool" && m["toolResult"]["toolCallId"] == id)
            .unwrap()["toolResult"]
            .clone()
    };
    assert_eq!(out("c_empty")["output"], "decide failed: The state is empty.");
    // No model is loaded in this daemon: the daemon's own answer, not the host's.
    assert_eq!(out("c_run")["output"], "decide failed: No decision model is loaded. Load one with decide:load.");
    assert_eq!(out("c_run")["isError"], true);
    let (_, all) = post(rig.d.port, "test:completions", json!([]), Some(TOKEN)).await;
    assert!(!all.as_array().unwrap().iter().any(|e| e[0] == "turn:tool"), "decide never ran in the host");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_daemon_turn_fetches_pages_and_runs_background_processes_itself() {
    use axum::routing::get;
    let app = axum::Router::new().route(
        "/page",
        get(|| async {
            (
                [(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")],
                "<html><head><title>Cats</title></head><body><p>Cats sleep &amp; purr.</p></body></html>",
            )
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let page_port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let session = json!({
        "id": "s_turn_f", "title": "Named", "mode": "ask", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1
    });
    let rig = turn_rig("fetch", session);
    let url = format!("http://127.0.0.1:{page_port}/page");
    let echo = if cfg!(windows) { "echo from-the-daemon" } else { "printf 'from-the-daemon\n'" };
    let model = scripted_model(vec![
        call_tool("c_fetch", "fetch_url", json!({ "url": url })),
        call_tool("c_start", "start_process", json!({ "command": echo, "name": "echoer" })),
        say_text("started"),
    ])
    .await;
    let spec = turn_spec(&rig, &model, "turn_f", "s_turn_f", json!({}));
    let (status, _) = post(rig.d.port, "chat:turn", json!([spec]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let approval = wait_pending(rig.d.port, "s_turn_f", "approval", "c_fetch").await;
    assert_eq!(approval["reason"], format!("Fetch {url}"));
    post(rig.d.port, "tool:approve", json!(["s_turn_f", "c_fetch", true]), Some(TOKEN)).await;
    let approval = wait_pending(rig.d.port, "s_turn_f", "approval", "c_start").await;
    assert_eq!(approval["reason"], "Start a background process");
    post(rig.d.port, "tool:approve", json!(["s_turn_f", "c_start", true]), Some(TOKEN)).await;
    let (_, end) = turn_record(rig.d.port, "turn_f").await;
    assert_eq!(end["stop"], "complete", "{end}");

    let saved = saved_session(&rig, "s_turn_f");
    let messages = saved["messages"].as_array().unwrap();
    let tool_out = |id: &str| -> String {
        let m = messages.iter().find(|m| m["role"] == "tool" && m["toolResult"]["toolCallId"] == id).unwrap();
        m["toolResult"]["output"].as_str().unwrap().to_string()
    };
    assert_eq!(tool_out("c_fetch"), format!("{url} (HTTP 200, text/html, 26 chars)\n\n# Cats\n\nCats sleep & purr."));
    let started = tool_out("c_start");
    assert!(started.starts_with("Started p_"), "{started}");
    assert!(started.contains("(echoer)"), "{started}");
    let (_, all) = post(rig.d.port, "test:completions", json!([]), Some(TOKEN)).await;
    let calls = all.as_array().unwrap();
    assert!(!calls.iter().any(|e| e[0] == "turn:tool"), "neither tool went through the host: {all}");
    // The output reached the agent terminal through the host's log.
    let logged = || {
        calls
            .iter()
            .filter(|e| e[0] == "loop:log")
            .map(|e| e[1][2].as_str().unwrap_or("").to_string())
            .collect::<String>()
    };
    assert!(logged().contains("[echoer, background]"), "{}", logged());
    server.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_daemon_turn_runs_its_tool_hooks_itself() {
    let session = json!({
        "id": "s_turn_h", "title": "Named", "mode": "yolo", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1
    });
    let rig = turn_rig("hooks", session);
    let model = scripted_model(vec![
        call_tool("c_bash", "bash", json!({ "command": "echo should-not-run > ran.txt" })),
        call_tool("c_read", "read_file", json!({ "path": "app.ts" })),
        say_text("done"),
    ])
    .await;
    let (pre_cmd, post_cmd) = if cfg!(windows) {
        ("echo no shell today 1>&2 & exit /b 2", "echo saw %NEKKO_TOOL_NAME% in %CD%")
    } else {
        ("echo no shell today 1>&2; exit 2", "echo saw $NEKKO_TOOL_NAME in $(pwd)")
    };
    let rules = json!([
        { "id": "h1", "event": "PreToolUse", "name": "guard", "matcher": "bash", "command": pre_cmd },
        { "id": "h2", "event": "PostToolUse", "name": "note", "matcher": "read_file", "command": post_cmd },
    ]);
    // The daemon writes settings.json and re-reads the hooks from it per call;
    // the spec's copy is only for a daemon without a data directory.
    let (status, _) = post(rig.d.port, "settings:update", json!([{ "hooks": rules }]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let mut spec = turn_spec(&rig, &model, "turn_h", "s_turn_h", json!({}));
    spec["facts"]["hookRules"] = json!([]);
    let (status, _) = post(rig.d.port, "chat:turn", json!([spec]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let (_, end) = turn_record(rig.d.port, "turn_h").await;
    assert_eq!(end["stop"], "complete", "{end}");
    let saved = saved_session(&rig, "s_turn_h");
    let messages = saved["messages"].as_array().unwrap();
    let tool = |id: &str| -> Value {
        messages.iter().find(|m| m["role"] == "tool" && m["toolResult"]["toolCallId"] == id).unwrap()["toolResult"]
            .clone()
    };
    assert_eq!(tool("c_bash")["output"], "Blocked by hook guard: no shell today");
    assert_eq!(tool("c_bash")["isError"], true);
    assert!(!rig.workspace.join("ran.txt").exists(), "the blocked command never ran");
    let read = tool("c_read")["output"].as_str().unwrap().to_string();
    assert!(read.contains("pineapple"), "{read}");
    assert!(read.contains("\n\n[hook note]: saw read_file in "), "{read}");
    let (_, all) = post(rig.d.port, "test:completions", json!([]), Some(TOKEN)).await;
    let calls = all.as_array().unwrap();
    assert!(!calls.iter().any(|e| e[0] == "turn:hook" || e[0] == "turn:tool"), "the host ran nothing: {all}");
}

#[tokio::test(flavor = "multi_thread")]
async fn classifies_commands_and_lists_tools_without_the_host() {
    let data = std::env::temp_dir().join(format!("nekkod-tooling-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(&data).unwrap();
    let d = start_with(false, Some(&data));
    let (status, decision) = post(d.port, "guardrails:classify", json!(["rm -rf /"]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{decision}");
    assert_eq!(decision["action"], "ask", "{decision}");
    assert_eq!(decision["matches"][0]["ruleId"], "rm-rf", "{decision}");
    let (_, safe) = post(d.port, "guardrails:classify", json!(["ls"]), Some(TOKEN)).await;
    assert_eq!(safe["action"], "allow", "{safe}");
    let (_, tools) = post(d.port, "tools:list", json!([]), Some(TOKEN)).await;
    let names: Vec<&str> = tools.as_array().unwrap().iter().filter_map(|t| t["name"].as_str()).collect();
    assert!(names.contains(&"read_file") && names.contains(&"bash"), "{names:?}");
    assert!(tools[0]["description"].as_str().is_some_and(|d| !d.is_empty()));
    drop(d);
    let _ = std::fs::remove_dir_all(&data);
}

/// The task list as the daemon wrote it.
fn read_tasks(data: &std::path::Path) -> Value {
    std::fs::read_to_string(data.join("tasks.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(json!([]))
}

async fn wait_for<F: Fn() -> bool>(what: &str, f: F) {
    tokio::time::timeout(Duration::from_secs(30), async {
        while !f() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for {what}"));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_daemon_runs_tasks_and_fires_them_on_time() {
    let data = std::env::temp_dir().join(format!("nekkod-tasks-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(data.join("sessions")).unwrap();
    let d = start_with(true, Some(&data));
    let (_, info) = post(d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    assert!(info["owned"].as_array().unwrap().contains(&json!("tasks:list")), "{info}");

    let input = json!({ "title": " Nightly ", "kind": "recurring", "prompt": "Summarize", "intervalMs": 3_600_000, "providerId": "p1", "modelId": "m1" });
    let (status, list) = post(d.port, "task:create", json!([input]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{list}");
    assert_eq!(list[0]["title"], "Nightly");
    assert_eq!(list[0]["lastSessionId"], "s_created");
    // The host made the chat; the daemon named it after the task.
    let chat: Value =
        serde_json::from_str(&std::fs::read_to_string(data.join("sessions/s_created.json")).unwrap()).unwrap();
    assert_eq!(chat["title"], "Nightly");
    assert_eq!(chat["taskId"], list[0]["id"]);
    // Due at once: fired without waiting for a tick, through the host's chat:send.
    wait_for("the fire", || {
        read_tasks(&data)[0]["runCount"] == json!(1) && read_tasks(&data)[0]["nextRunAt"].is_number()
    })
    .await;
    let task = read_tasks(&data)[0].clone();
    let (_, calls) = post(d.port, "test:completions", json!([]), Some(TOKEN)).await;
    let sent: Vec<&Value> = calls.as_array().unwrap().iter().filter(|c| c[0] == "chat:send").collect();
    assert_eq!(sent.len(), 1, "{calls}");
    assert_eq!(
        sent[0][1][0],
        json!({ "sessionId": "s_created", "providerId": "p1", "modelId": "m1", "text": "Summarize" })
    );
    let next = task["nextRunAt"].as_f64().unwrap() - task["lastRunAt"].as_f64().unwrap();
    assert!((3_600_000.0..3_601_000.0).contains(&next), "{task}");

    // Paused tasks never fire; deleting removes it.
    let id = task["id"].as_str().unwrap().to_string();
    let (_, list) = post(d.port, "task:update", json!([id, { "status": "paused" }]), Some(TOKEN)).await;
    assert_eq!(list[0]["status"], "paused");
    let (_, list) = post(d.port, "task:delete", json!([id]), Some(TOKEN)).await;
    assert_eq!(list, json!([]));
    drop(d);
    let _ = std::fs::remove_dir_all(&data);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_task_cut_short_by_a_restart_fires_again() {
    let data = std::env::temp_dir().join(format!("nekkod-tasks-restart-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(data.join("sessions")).unwrap();
    std::fs::write(data.join("sessions/s_old.json"), r#"{"id":"s_old","title":"Old","messages":[]}"#).unwrap();
    // Mid-fire when the last process stopped: active, no next run.
    std::fs::write(
        data.join("tasks.json"),
        r#"[{"id":"t1","title":"Cut short","kind":"recurring","prompt":"Again","providerId":"p1","modelId":"m1","status":"active","createdAt":5,"runCount":2,"lastRunAt":9,"lastSessionId":"s_old"}]"#,
    )
    .unwrap();
    let d = start_with(true, Some(&data));
    wait_for("the fire after restart", || read_tasks(&data)[0]["runCount"] == json!(3)).await;
    // runCount is saved before the asynchronous send reaches the backend.
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let (_, calls) = post(d.port, "test:completions", json!([]), Some(TOKEN)).await;
            if calls.as_array().unwrap().iter().any(|c| c[0] == "chat:send" && c[1][0]["sessionId"] == "s_old") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("restarted task reaches the backend");
    drop(d);
    let _ = std::fs::remove_dir_all(&data);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_scheduled_task_fires_when_it_is_due_not_a_tick_later() {
    let data = std::env::temp_dir().join(format!("nekkod-tasks-due-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(data.join("sessions")).unwrap();
    let d = start_with(true, Some(&data));
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as f64;
    let run_at = now + 2_000.0;
    let input = json!({ "title": "Soon", "kind": "scheduled", "prompt": "p", "runAt": run_at, "providerId": "p1", "modelId": "m1" });
    post(d.port, "task:create", json!([input]), Some(TOKEN)).await;
    wait_for("the scheduled fire", || read_tasks(&data)[0]["status"] == json!("done")).await;
    let late = read_tasks(&data)[0]["lastRunAt"].as_f64().unwrap() - run_at;
    // The TS scheduler looked every 15 s, so a task fired up to 15 s late.
    assert!((0.0..1_000.0).contains(&late), "fired {late} ms after it was due");
    eprintln!("scheduled task fired {late} ms after its runAt");
    drop(d);
    let _ = std::fs::remove_dir_all(&data);
}

/// The runs as the daemon wrote them.
fn read_runs(data: &std::path::Path) -> Value {
    std::fs::read_to_string(data.join("training.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(json!([]))
}

/// A goal run end to end in the daemon: created (its chat made by the host and
/// named here), started, its turns admitted and driven by the daemon, its plan,
/// experiment and artifact recorded by the daemon's own tools with no
/// `turn:tool`, finished on the done token, and `training:updated` published.
#[tokio::test(flavor = "multi_thread")]
async fn the_daemon_runs_training_and_goal_runs_and_their_tools_itself() {
    let rig = turn_rig("training", json!({ "id": "s_unused", "messages": [] }));
    let model = scripted_model(vec![
        call_tool(
            "c_plan",
            "update_plan",
            json!({ "replace": true, "steps": [{ "title": "Write the parser", "status": "active" }, { "title": "Add tests" }] }),
        ),
        call_tool("c_exp", "report_experiment", json!({ "title": "Fast path", "status": "succeeded", "score": 0.9 })),
        call_tool("c_art", "report_artifact", json!({ "path": "nekko-goal/csv/parser.ts", "kind": "code" })),
        say_text("Planned and started."),
        call_tool("c_done", "update_plan", json!({ "steps": [{ "id": "step_1", "status": "done", "note": "Parses" }, { "id": "step_2", "status": "done" }] })),
        say_text("Everything is verified. \u{27e6}RUN_DONE\u{27e7}"),
    ])
    .await;
    let provider = json!({
        "id": "p1", "kind": "openai-compat", "label": "Scripted", "enabled": true,
        "baseUrl": format!("http://127.0.0.1:{}/v1", model.port),
    });
    let settings = json!({
        "providers": [provider],
        "workspaces": [{ "id": "w1", "name": "project", "path": rig.workspace.to_string_lossy() }],
        "defaultChatMode": "yolo", "defaultProviderId": "p1", "defaultModelId": "synthetic",
    });
    std::fs::write(rig.data.join("settings.json"), settings.to_string()).unwrap();
    let mut events = ws(rig.d.port, &format!("/api/events?token={TOKEN}"), None).await.unwrap();

    let (_, info) = post(rig.d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    for c in ["training:list", "training:create", "training:start", "training:hint", "training:tool"] {
        assert!(info["owned"].as_array().unwrap().contains(&json!(c)), "{c} is not owned: {info}");
    }
    let input =
        json!({ "kind": "goal", "name": "  CSV importer  ", "goal": "Ship the CSV importer", "workspaceId": "w1" });
    let (status, run) = post(rig.d.port, "training:create", json!([input]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{run}");
    assert_eq!(run["name"], "CSV importer");
    assert_eq!(run["status"], "draft");
    assert_eq!(run["sessionId"], "s_created");
    let id = run["id"].as_str().unwrap().to_string();
    let chat = saved_session(&rig, "s_created");
    assert_eq!(chat["title"], "CSV importer");
    assert_eq!(chat["trainingRunId"], id.as_str());
    assert_eq!(chat["providerId"], "p1");

    let (_, list) = post(rig.d.port, "training:hint", json!([id, "  Keep it small  "]), Some(TOKEN)).await;
    assert_eq!(list[0]["hints"][0]["text"], "Keep it small");
    let (_, list) = post(rig.d.port, "training:start", json!([id]), Some(TOKEN)).await;
    assert_eq!(list[0]["status"], "running");
    // Two turns (the second after the 4 s pause), then finished on the token.
    wait_for("the run to complete", || read_runs(&rig.data)[0]["status"] == json!("completed")).await;
    let run = read_runs(&rig.data)[0].clone();
    assert_eq!(run["turns"], json!(2), "{run}");
    assert_eq!(run["plan"][0]["status"], "done", "{run}");
    assert_eq!(run["plan"][0]["note"], "Parses");
    assert_eq!(run["experiments"][0]["id"], "exp_1");
    assert_eq!(run["bestExperimentId"], "exp_1");
    assert_eq!(run["artifacts"][0]["title"], "parser.ts");
    assert!(run["hints"][0]["consumedAt"].is_number(), "{run}");
    let log: Vec<String> = run["log"].as_array().unwrap().iter().map(|l| l["text"].as_str().unwrap().into()).collect();
    assert!(log.contains(&"Plan created: 2 steps.".to_string()), "{log:?}");
    assert!(log.contains(&"Run completed: Everything is verified.".to_string()), "{log:?}");

    // The chat: the turns' transcript and the run's plan mirrored onto it.
    let chat = saved_session(&rig, "s_created");
    assert_eq!(chat["agentPlan"], run["plan"]);
    let messages = chat["messages"].as_array().unwrap();
    let tool_out = |id: &str| -> String {
        let m = messages.iter().find(|m| m["role"] == "tool" && m["toolResult"]["toolCallId"] == id).unwrap();
        m["toolResult"]["output"].as_str().unwrap().to_string()
    };
    assert!(tool_out("c_plan").starts_with("Plan saved (0/2 done):"), "{}", tool_out("c_plan"));
    assert_eq!(tool_out("c_exp"), "Recorded exp_1. It is the new leader at 0.9.");
    assert_eq!(
        tool_out("c_art"),
        "Recorded artifact \"parser.ts\" at nekko-goal/csv/parser.ts. It now shows on the run's Artifacts card."
    );
    // The first turn's brief, with the hint folded in.
    let first = messages.iter().find(|m| m["role"] == "user").unwrap()["content"].as_str().unwrap().to_string();
    assert!(first.starts_with("You are Nekko Agent's goal agent."), "{first}");
    assert!(
        first.ends_with("USER GUIDANCE (fold these into your next experiments; acknowledge each):\n- Keep it small")
    );
    let (_, calls) = post(rig.d.port, "test:completions", json!([]), Some(TOKEN)).await;
    let calls = calls.as_array().unwrap();
    assert!(!calls.iter().any(|c| c[0] == "turn:tool" || c[0] == "chat:send"), "the host ran nothing: {calls:?}");
    // Its history window went with the turn.
    let requests = model.requests.lock().unwrap().clone();
    assert!(requests.len() >= 6, "{}", requests.len());

    let mut heard = false;
    while let Some(frame) = next_json(&mut events, Duration::from_secs(2)).await {
        if frame["channel"] == "training:updated" {
            heard = true;
            break;
        }
    }
    assert!(heard, "training:updated was published");

    // A turn the host runs sends its run tools here.
    let (_, out) = post(
        rig.d.port,
        "training:tool",
        json!(["s_created", "report_experiment", { "id": "exp_2", "status": "failed" }]),
        Some(TOKEN),
    )
    .await;
    assert_eq!(out["output"], "Recorded exp_2 (failed). Leader is exp_1 (Fast path) at 0.9.");
    let (_, out) =
        post(rig.d.port, "training:tool", json!(["s_created", "update_plan", { "steps": [null] }]), Some(TOKEN)).await;
    assert_eq!(out["error"], "Cannot read properties of null (reading 'title')");

    let (_, list) = post(rig.d.port, "training:stop", json!([id]), Some(TOKEN)).await;
    assert_eq!(list[0]["status"], "completed", "a completed run stays completed");
    let (_, list) = post(rig.d.port, "training:delete", json!([id]), Some(TOKEN)).await;
    assert_eq!(list, json!([]));
    assert_eq!(read_runs(&rig.data), json!([]));
}

/// A run that was mid-flight when the daemon stopped resumes when it starts.
#[tokio::test(flavor = "multi_thread")]
async fn a_running_training_run_resumes_when_the_daemon_starts() {
    let data = std::env::temp_dir().join(format!("nekkod-training-resume-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(data.join("sessions")).unwrap();
    // No model anywhere: its resumed turn fails the run at once.
    std::fs::write(data.join("sessions/s_run.json"), r#"{"id":"s_run","title":"Run","messages":[]}"#).unwrap();
    std::fs::write(
        data.join("training.json"),
        r#"[{"id":"r1","kind":"training","name":"Old","goal":"g","status":"running","config":{},"sessionId":"s_run","experiments":[],"hints":[],"log":[],"createdAt":1,"updatedAt":1,"startedAt":1,"turns":3}]"#,
    )
    .unwrap();
    let d = start_with(true, Some(&data));
    wait_for("the resumed run", || read_runs(&data)[0]["status"] == json!("failed")).await;
    let run = read_runs(&data)[0].clone();
    let log: Vec<&str> = run["log"].as_array().unwrap().iter().map(|l| l["text"].as_str().unwrap()).collect();
    assert_eq!(
        log,
        [
            "Host restarted; run resumed automatically.",
            "No model configured. Set a default provider/model in Models, then start the run again."
        ]
    );
    drop(d);
    let _ = std::fs::remove_dir_all(&data);
}

#[tokio::test(flavor = "multi_thread")]
async fn serves_files_memory_and_comments_itself() {
    let data = std::env::temp_dir().join(format!("nekkod-workspace-{}", std::process::id()));
    let project = data.join("project");
    std::fs::create_dir_all(project.join("src")).unwrap();
    std::fs::write(project.join("src").join("a.ts"), "export function a() {}\n").unwrap();
    let d = start_with(true, Some(&data));

    let (_, info) = post(d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    for c in ["file:read", "dir:list", "workspace:search", "memory:save", "comment:add"] {
        assert!(info["owned"].as_array().unwrap().contains(&json!(c)), "{c} is not owned");
    }
    let file = project.join("src").join("a.ts").to_string_lossy().into_owned();
    let (status, read) = post(d.port, "file:read", json!([file]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    assert_eq!(read, json!({ "content": "export function a() {}\n", "truncated": false, "binary": false }));
    let written = project.join("new").join("b.txt").to_string_lossy().into_owned();
    post(d.port, "file:write", json!([written, "hi"]), Some(TOKEN)).await;
    assert_eq!(std::fs::read_to_string(&written).unwrap(), "hi");
    let (_, listed) = post(d.port, "dir:list", json!([project.to_string_lossy()]), Some(TOKEN)).await;
    assert_eq!(
        listed.as_array().unwrap().iter().map(|e| e["name"].clone()).collect::<Vec<_>>(),
        [json!("new"), json!("src")]
    );

    let (_, saved) = post(
        d.port,
        "memory:save",
        json!([{ "id": "m_1", "scope": "global", "title": "T", "body": "B", "tags": [], "createdAt": 1, "updatedAt": 1 }]),
        Some(TOKEN),
    )
    .await;
    assert_eq!(saved[0]["id"], "m_1");
    assert!(data.join("memory").join("m_1.md").exists());
    let (status, refused) = post(d.port, "memory:delete", json!(["../x"]), Some(TOKEN)).await;
    assert_ne!(status, 200, "{refused}");
    post(d.port, "memory:delete", json!(["m_1"]), Some(TOKEN)).await;
    assert!(!data.join("memory").join("m_1.md").exists());

    let (_, added) = post(d.port, "comment:add", json!(["/p.ts", 3, "x", "look"]), Some(TOKEN)).await;
    let id = added[0]["id"].clone();
    let (_, listed) = post(d.port, "comments:list", json!(["/p.ts"]), Some(TOKEN)).await;
    assert_eq!(listed, added);
    let (_, resolved) = post(d.port, "comment:resolve", json!(["/p.ts", id]), Some(TOKEN)).await;
    assert_eq!(resolved, json!([]));
    // A folder the settings do not list is not searched.
    let (_, hits) = post(d.port, "workspace:search", json!(["w_missing", "a"]), Some(TOKEN)).await;
    assert_eq!(hits, json!([]));
    // The folder list is the daemon's own settings.
    let folder =
        json!([{ "workspaces": [{ "id": "w1", "name": "project", "path": project.to_string_lossy(), "addedAt": 1 }] }]);
    post(d.port, "settings:update", folder, Some(TOKEN)).await;
    let (_, done) = post(d.port, "workspace:index", json!(["w1"]), Some(TOKEN)).await;
    assert_eq!(
        (done["state"].clone(), done["fileCount"].clone(), done["symbolCount"].clone()),
        (json!("ready"), json!(2), json!(1))
    );
    let (_, hits) = post(d.port, "workspace:search", json!(["w1", "FUNCTION A"]), Some(TOKEN)).await;
    assert_eq!(hits[0]["relPath"], json!("src/a.ts"));
    assert_eq!(hits[0]["line"], json!(1));
    let (_, listed) = post(d.port, "workspace:files", json!(["w1"]), Some(TOKEN)).await;
    assert_eq!(listed.as_array().unwrap().len(), 2);
    let (_, snippets) =
        post(d.port, "workspace:snippets", json!([["w1"], "where is function defined"]), Some(TOKEN)).await;
    assert_eq!(snippets[0]["body"], json!("1: export function a() {}"));
    let (_, status) = post(d.port, "workspace:indexStatus", json!(["w1"]), Some(TOKEN)).await;
    assert_eq!(status["state"], json!("ready"));
    // Skills (the nekko-agent target only: nothing is written outside the data dir).
    let (_, installed) =
        post(d.port, "skill:install", json!(["nekko-agent-review-council", "nekko-agent"]), Some(TOKEN)).await;
    assert_eq!(installed["ok"], json!(true));
    assert!(data.join("skills.json").exists());
    let (_, listed) = post(d.port, "skills:installed", json!([]), Some(TOKEN)).await;
    assert_eq!(listed[0]["skillId"], json!("nekko-agent-review-council"));
    let (_, left) =
        post(d.port, "skill:uninstall", json!(["nekko-agent-review-council", "nekko-agent"]), Some(TOKEN)).await;
    assert_eq!(left, json!([]));
    let (_, catalog) = post(d.port, "vaizer:catalog", json!([]), Some(TOKEN)).await;
    assert_eq!(catalog["source"], json!("bundled"));
    drop(d);
    std::fs::remove_dir_all(data).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn generates_a_design_on_the_default_provider() {
    let data = std::env::temp_dir().join(format!("nekkod-design-{}", std::process::id()));
    std::fs::create_dir_all(&data).unwrap();
    let model = scripted_model(vec![say_text("```html\n<!DOCTYPE html><p>Pricing</p>\n```")]).await;
    let d = start_with(true, Some(&data));
    // No default provider yet: the host's answer is the error.
    let (status, refused) =
        post(d.port, "design:generate", json!(["w1", { "prompt": "A pricing page" }]), Some(TOKEN)).await;
    assert_ne!(status, 200);
    assert!(refused.to_string().contains("default provider"), "{refused}");
    let (status, _) = post(d.port, "design:generate", json!(["w1", { "prompt": "  " }]), Some(TOKEN)).await;
    assert_ne!(status, 200);
    let provider = json!({ "id": "p1", "kind": "openai-compat", "label": "Scripted", "enabled": true, "baseUrl": format!("http://127.0.0.1:{}/v1", model.port) });
    post(
        d.port,
        "test:designProvider",
        json!([{ "provider": provider, "model": "synthetic", "promptCaching": true }]),
        Some(TOKEN),
    )
    .await;
    let (status, board) =
        post(d.port, "design:generate", json!(["w1", { "prompt": "  A pricing page  " }]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{board}");
    let page = &board["pages"][0];
    assert_eq!(
        (page["kind"].clone(), page["label"].clone(), page["html"].clone()),
        (json!("concept"), json!("A pricing page"), json!("<!DOCTYPE html><p>Pricing</p>"))
    );
    let sent = model.requests.lock().unwrap().clone();
    let user = sent[0]["messages"].as_array().unwrap().iter().find(|m| m["role"] == "user").unwrap().clone();
    assert_eq!(user["content"], json!("Design this: A pricing page"));
    let (_, again) = post(d.port, "design:get", json!(["w1"]), Some(TOKEN)).await;
    assert_eq!(again, board);
    let (_, noted) = post(d.port, "design:addNote", json!(["w1", page["id"], " tighter "]), Some(TOKEN)).await;
    assert_eq!(noted["pages"][0]["notes"][0]["text"], json!("tighter"));
    drop(d);
    std::fs::remove_dir_all(data).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn suggests_replies_and_fills_prompt_parts_on_the_chats_model() {
    let data = std::env::temp_dir().join(format!("nekkod-side-{}", std::process::id()));
    let sessions = data.join("sessions");
    std::fs::create_dir_all(&sessions).unwrap();
    let model = scripted_model(vec![
        say_text("Sure: {\"options\":[\"Commit it\",\"commit IT\",\"Run the tests\"],\"next\":\"Commit it and push\"}"),
        say_text("  \"You are a careful code reviewer.\"  "),
    ])
    .await;
    let settings = json!({
        "providers": [
            { "id": "p1", "kind": "openai-compat", "label": "Scripted", "enabled": true, "baseUrl": format!("http://127.0.0.1:{}/v1", model.port) },
            { "id": "off", "kind": "openai", "label": "Off", "enabled": false, "baseUrl": "https://api.openai.com/v1" },
        ],
        "defaultProviderId": "p1",
        "defaultModelId": "synthetic",
    });
    std::fs::write(data.join("settings.json"), settings.to_string()).unwrap();
    let messages = json!([
        { "id": "u1", "role": "user", "content": "Fix the bug", "createdAt": 1 },
        { "id": "a1", "role": "assistant", "content": "Fixed. Want me to commit?", "createdAt": 2 },
    ]);
    let chats = [
        ("s_side", json!({})),
        ("s_task", json!({ "taskId": "t1" })),
        ("s_offline", json!({ "offline": true, "providerId": "remote" })),
        ("s_disabled", json!({ "providerId": "off" })),
    ];
    for (id, extra) in &chats {
        let mut s = json!({ "id": id, "title": "Side", "messages": messages, "createdAt": 1, "updatedAt": 2 });
        for (k, v) in extra.as_object().unwrap() {
            s[k] = v.clone();
        }
        std::fs::write(sessions.join(format!("{id}.json")), serde_json::to_vec_pretty(&s).unwrap()).unwrap();
    }
    let d = start_with(true, Some(&data));
    let (_, info) = post(d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    for channel in ["chat:suggest", "chat:fillPrompt"] {
        assert!(info["owned"].as_array().unwrap().contains(&json!(channel)), "{channel} is not owned");
    }

    let (status, suggested) = post(d.port, "chat:suggest", json!(["s_side"]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{suggested}");
    assert_eq!(suggested, json!({ "options": ["Commit it", "Run the tests"], "next": "Commit it and push" }));
    let (_, filled) = post(d.port, "chat:fillPrompt", json!(["s_side", "Role", "Review this PR"]), Some(TOKEN)).await;
    assert_eq!(filled, json!("You are a careful code reviewer."));
    // Both ran on the chat's provider and default model, with the ported prompts.
    let sent = model.requests.lock().unwrap().clone();
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[0]["model"], "synthetic");
    let content =
        |i: usize| sent[i]["messages"].as_array().unwrap().last().unwrap()["content"].as_str().unwrap().to_string();
    assert_eq!(content(0), nekko_turn::suggest_prompt(&json!({ "messages": messages })).unwrap());
    assert_eq!(content(1), nekko_turn::fill_prompt("Role", "Review this PR"));
    assert_eq!(sent[0]["max_tokens"].as_u64().or(sent[0]["max_completion_tokens"].as_u64()), Some(220), "{}", sent[0]);
    // Usage written by the daemon, as the host's sideband wrote it.
    let usage = std::fs::read_to_string(data.join("usage.jsonl")).unwrap();
    let lines: Vec<Value> = usage.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    assert_eq!(lines.len(), 2, "{usage}");
    assert!(lines.iter().all(|l| l["sessionId"] == "s_side" && l["providerId"] == "p1" && l["modelId"] == "synthetic"));

    // Nobody to suggest to, an offline chat without a local provider, a disabled
    // provider, a chat that does not exist: null, and no model call.
    for id in ["s_task", "s_offline", "s_disabled", "s_absent"] {
        let (status, none) = post(d.port, "chat:suggest", json!([id]), Some(TOKEN)).await;
        assert_eq!((status, none), (200, Value::Null), "{id}");
    }
    let (_, none) = post(d.port, "chat:fillPrompt", json!(["s_disabled", "Role", "x"]), Some(TOKEN)).await;
    assert_eq!(none, Value::Null);
    assert_eq!(model.requests.lock().unwrap().len(), 2);
    // A failed call is null too: the model is gone.
    drop(model);
    let (status, none) = post(d.port, "chat:suggest", json!(["s_side"]), Some(TOKEN)).await;
    assert_eq!((status, none), (200, Value::Null));
    drop(d);
    std::fs::remove_dir_all(data).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn adds_and_revokes_folders_through_the_daemons_settings() {
    let data = std::env::temp_dir().join(format!("nekkod-folders-{}", std::process::id()));
    let project = data.join("My Project");
    std::fs::create_dir_all(project.join("src")).unwrap();
    std::fs::write(project.join("src").join("x.rs"), "pub fn x() {}\n").unwrap();
    let path = project.to_string_lossy().into_owned();
    let d = start_with(true, Some(&data));
    let (_, added) = post(d.port, "workspace:addByPath", json!([path]), Some(TOKEN)).await;
    let folder = added[0].clone();
    assert_eq!((folder["name"].clone(), folder["path"].clone()), (json!("My Project"), json!(path)));
    let id = folder["id"].as_str().unwrap().to_string();
    assert!(id.starts_with("ws_"));
    // The same folder spelled differently is not added twice.
    let respelled = format!("{path}{}", std::path::MAIN_SEPARATOR);
    let (_, again) = post(d.port, "workspace:addByPath", json!([respelled]), Some(TOKEN)).await;
    assert_eq!(again.as_array().unwrap().len(), 1);
    let (_, listed) = post(d.port, "workspace:list", json!([]), Some(TOKEN)).await;
    assert_eq!(listed, added);
    // Indexed shortly after it was added.
    let mut status = Value::Null;
    for _ in 0..50 {
        status = post(d.port, "workspace:indexStatus", json!([id]), Some(TOKEN)).await.1;
        if status["state"] == "ready" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!((status["state"].clone(), status["symbolCount"].clone()), (json!("ready"), json!(1)));
    // A chat using it loses it when access is revoked; a running one blocks that.
    let sessions = data.join("sessions");
    std::fs::create_dir_all(&sessions).unwrap();
    let chat = |sid: &str| json!({ "id": sid, "title": sid, "workspaceId": id, "supportingWorkspaceIds": [id], "messages": [], "createdAt": 1, "updatedAt": 1 });
    std::fs::write(sessions.join("s_busy.json"), chat("s_busy").to_string()).unwrap();
    let (status, refused) = post(d.port, "workspace:remove", json!([id]), Some(TOKEN)).await;
    assert_ne!(status, 200);
    assert!(refused.to_string().contains("Wait for chats"), "{refused}");
    std::fs::remove_file(sessions.join("s_busy.json")).unwrap();
    std::fs::write(sessions.join("s_idle.json"), chat("s_idle").to_string()).unwrap();
    let (status, left) = post(d.port, "workspace:remove", json!([id]), Some(TOKEN)).await;
    assert_eq!((status, left), (200, json!([])));
    let (_, saved) = post(d.port, "session:get", json!(["s_idle"]), Some(TOKEN)).await;
    assert!(saved.get("workspaceId").is_none());
    assert_eq!(saved["supportingWorkspaceIds"], json!([]));
    assert!(project.join("src").join("x.rs").exists(), "the folder itself is never touched");
    drop(d);
    std::fs::remove_dir_all(data).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn builds_a_linked_spec_on_the_chats_provider() {
    let data = std::env::temp_dir().join(format!("nekkod-spec-{}", std::process::id()));
    let project = data.join("project");
    std::fs::create_dir_all(project.join("x")).unwrap();
    std::fs::create_dir_all(data.join("sessions")).unwrap();
    std::fs::write(
        project.join("tasks.md"),
        "- [ ] a
",
    )
    .unwrap();
    let chat = json!({ "id": "s_spec", "title": "t", "workspaceId": "w1", "providerId": "p1", "modelId": "synthetic", "messages": [
        { "id": "u", "role": "user", "content": "Make a todo app", "createdAt": 1 }
    ], "createdAt": 1, "updatedAt": 1 });
    std::fs::write(data.join("sessions").join("s_spec.json"), chat.to_string()).unwrap();
    let model = scripted_model(vec![say_text(
        "```markdown
# Todo spec
```",
    )])
    .await;
    let d = start_with(true, Some(&data));
    let provider = json!({ "id": "p1", "kind": "openai-compat", "label": "Scripted", "enabled": true, "baseUrl": format!("http://127.0.0.1:{}/v1", model.port) });
    let folder = json!([{ "workspaces": [{ "id": "w1", "name": "project", "path": project.to_string_lossy(), "addedAt": 1 }], "providers": [provider] }]);
    post(d.port, "settings:update", folder, Some(TOKEN)).await;
    post(d.port, "test:designProvider", json!([{ "provider": provider, "promptCaching": true }]), Some(TOKEN)).await;
    let (status, built) = post(d.port, "spec:build", json!(["s_spec"]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{built}");
    assert_eq!(built["ok"], json!(true), "{built}");
    assert_eq!(
        std::fs::read_to_string(project.join("spec.md")).unwrap(),
        "# Todo spec
"
    );
    let (_, toggled) = post(d.port, "spec:toggleTask", json!(["s_spec", 0]), Some(TOKEN)).await;
    assert_eq!(toggled, json!({ "ok": true }));
    assert_eq!(
        std::fs::read_to_string(project.join("tasks.md")).unwrap(),
        "- [x] a
"
    );
    let (_, docs) = post(d.port, "spec:readDocs", json!(["s_spec"]), Some(TOKEN)).await;
    assert_eq!(
        docs["docs"][0]["content"],
        json!(
            "# Todo spec
"
        )
    );
    post(d.port, "spec:setMethodology", json!(["s_spec", "kiro"]), Some(TOKEN)).await;
    let (_, saved) = post(d.port, "session:get", json!(["s_spec"]), Some(TOKEN)).await;
    assert_eq!(saved["specMethodology"], json!("kiro"));
    drop(d);
    std::fs::remove_dir_all(data).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn the_daemon_keeps_and_reads_connectors() {
    let data = std::env::temp_dir().join(format!("nekkod-connectors-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(&data).unwrap();
    let d = start_with(true, Some(&data));
    let (_, info) = post(d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    assert!(info["owned"].as_array().unwrap().contains(&json!("connector:fetch")), "{info}");
    let (_, missing) = post(d.port, "connector:fetch", json!(["teams"]), Some(TOKEN)).await;
    assert_eq!(missing["error"], "Connector not connected", "{missing}");
    let hook = json!({ "webhookUrl": "https://acme.webhook.office.com/x" });
    let (_, list) = post(d.port, "connector:connect", json!(["teams", null, hook]), Some(TOKEN)).await;
    assert_eq!(list[0]["kind"], "teams", "{list}");
    assert_eq!(list[0]["connected"], true);
    assert!(list[0]["connectedAt"].is_number());
    // The daemon wrote settings.json itself.
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(data.join("settings.json")).unwrap()).unwrap();
    assert_eq!(saved["connectors"][0]["settings"], hook);
    let (_, found) = post(d.port, "connector:fetch", json!(["teams"]), Some(TOKEN)).await;
    assert_eq!(found[0]["subtitle"], "acme.webhook.office.com", "{found}");
    let (_, list) = post(d.port, "connector:disconnect", json!(["teams"]), Some(TOKEN)).await;
    assert_eq!(list, json!([]));
    let (_, list) = post(d.port, "connectors:list", json!([]), Some(TOKEN)).await;
    assert_eq!(list, json!([]));
    drop(d);
    let _ = std::fs::remove_dir_all(&data);
}

/// A relay socket as the test sees it (it plays apps/relay).
type RelaySide = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

/// The agent's next frame other than the backend's repeating test event.
async fn next_agent_frame(agent: &mut RelaySide, key: &nekko_remote::e2e::Key) -> (Value, Option<Value>) {
    loop {
        let f = next_json(agent, Duration::from_secs(20)).await.expect("an agent frame");
        let sealed = (f["type"] == "d")
            .then(|| serde_json::from_str::<Value>(f["data"].as_str().unwrap()).unwrap())
            .and_then(|d| nekko_remote::e2e::open(key, d["enc"].as_str().unwrap()));
        if sealed.as_ref().is_some_and(|s| s["type"] == "event" && s["payload"]["type"] == "hello-from-backend") {
            continue;
        }
        return (f, sealed);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_daemon_runs_the_phone_relay_agent() {
    let data = std::env::temp_dir().join(format!("nekkod-remote-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(&data).unwrap();
    let d = start_with(true, Some(&data));
    let relay = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let relay_port = relay.local_addr().unwrap().port();

    let (_, info) = post(d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    assert!(info["owned"].as_array().unwrap().contains(&json!("remote:status")), "{info}");
    let (_, status) =
        post(d.port, "remote:enable", json!([format!("ws://127.0.0.1:{relay_port}/")]), Some(TOKEN)).await;
    assert_eq!(status["enabled"], true, "{status}");
    let (_, pairing) = post(d.port, "remote:pairing", json!([]), Some(TOKEN)).await;
    let (room, secret) = (pairing["room"].as_str().unwrap().to_string(), pairing["key"].as_str().unwrap().to_string());
    let (_, grant) = post(d.port, "remote:pair", json!([]), Some(TOKEN)).await;
    let code = grant["code"].as_str().unwrap().to_string();

    // The agent dials out to the relay with the room and key, as relay.ts did.
    let (tcp, _) =
        tokio::time::timeout(Duration::from_secs(20), relay.accept()).await.expect("the agent dials").unwrap();
    let mut path = String::new();
    #[allow(clippy::result_large_err)] // tungstenite's callback signature
    let mut agent = tokio_tungstenite::accept_hdr_async(
        tcp,
        |req: &tokio_tungstenite::tungstenite::handshake::server::Request,
         res: tokio_tungstenite::tungstenite::handshake::server::Response| {
            path = req.uri().to_string();
            Ok(res)
        },
    )
    .await
    .unwrap();
    assert_eq!(path, format!("/relay?role=agent&room={room}&key={secret}"));
    let key = nekko_remote::e2e::derive_key(&secret, &room);
    let seal = |v: Value| {
        json!({ "enc": nekko_remote::e2e::seal_with_iv(&key, &v, nekko_remote::e2e::random_iv()) }).to_string()
    };
    let client = |cid: &str, v: Value| Message::text(json!({ "type": "c", "cid": cid, "data": seal(v) }).to_string());

    agent.send(Message::text(json!({ "type": "client-open", "cid": "c1" }).to_string())).await.unwrap();
    // Nothing is served before the handshake.
    agent.send(client("c1", json!({ "type": "req", "id": 1, "channel": "tasks:list", "args": [] }))).await.unwrap();
    let (_, res) = next_agent_frame(&mut agent, &key).await;
    assert_eq!(res.unwrap(), json!({ "type": "res", "id": 1, "error": "not paired (send hello first)" }));
    // Enroll with the one-time code.
    let hello = json!({ "type": "hello", "deviceId": "phone-1", "name": "Pixel", "platform": "android", "pair": code });
    agent.send(client("c1", hello)).await.unwrap();
    let (f, welcome) = next_agent_frame(&mut agent, &key).await;
    assert_eq!(f["cid"], "c1");
    let welcome = welcome.unwrap();
    assert_eq!(welcome["type"], "welcome", "{welcome}");
    assert_eq!(welcome["device"]["name"], "Pixel");
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(data.join("remote.json")).unwrap()).unwrap();
    assert_eq!(saved["devices"][0]["id"], "phone-1");

    // What a phone may call is the computer's decision (nekko_remote::phone):
    // a daemon channel it may not call, a channel the host serves that it may,
    // a public channel off its list, and an internal callback.
    let mut ask = async |id: u32, channel: &str, args: Value| {
        agent.send(client("c1", json!({ "type": "req", "id": id, "channel": channel, "args": args }))).await.unwrap();
        next_agent_frame(&mut agent, &key).await.1.unwrap()
    };
    let res = ask(2, "remote:devices", json!([])).await;
    assert_eq!(res["error"], "Not allowed from a paired phone (channel-denied): remote:devices");
    // `app:info` is the daemon's own now (small_services.rs), not the host's echo.
    let res = ask(3, "app:info", json!([])).await;
    assert_eq!(res["result"]["edition"], "web", "{res}");
    assert!(res["result"]["platform"].is_string(), "{res}");
    // A channel the host serves.
    let res = ask(31, "skills:runnable", json!([])).await;
    assert_eq!(res["result"], json!([]), "{res}");
    let res = ask(4, "training:list", json!([])).await;
    assert_eq!(res["error"], "Not allowed from a paired phone (channel-denied): training:list");
    let res = ask(5, "turn:pending", json!([])).await;
    assert_eq!(res["error"], "Not allowed from a paired phone (channel-denied): turn:pending");
    // Settings: the daemon's own, redacted for the phone, and only the phone's keys.
    post(d.port, "settings:update", json!([{ "hfToken": "hf_secret", "defaultChatMode": "ask" }]), Some(TOKEN)).await;
    let res = ask(6, "settings:get", json!([])).await;
    assert_eq!(res["result"]["defaultChatMode"], "ask", "{res}");
    assert!(!res.to_string().contains("hf_secret"), "{res}");
    assert!(res["result"].get("providers").is_none(), "{res}");
    let res = ask(7, "settings:update", json!([{ "defaultChatMode": "turbo" }])).await;
    assert_eq!(res["error"], "Not allowed from a paired phone (value-invalid): defaultChatMode");
    let res = ask(8, "settings:update", json!([{ "chatPaneAction": "delete", "sandboxMode": "off" }])).await;
    assert_eq!(res["error"], "Not allowed from a paired phone (setting-denied): sandboxMode");
    let res = ask(9, "settings:update", json!([{ "chatPaneAction": "delete" }])).await;
    assert_eq!(res["result"]["chatPaneAction"], "delete", "{res}");
    let (_, saved) = post(d.port, "settings:get", json!([]), Some(TOKEN)).await;
    assert_eq!(saved["defaultChatMode"], "ask", "the refused updates applied nothing");
    assert_ne!(saved["sandboxMode"], "off");
    assert_eq!(saved["hfToken"], "hf_secret");

    // The host's events reach the welcomed phone.
    let f = next_json(&mut agent, Duration::from_secs(20)).await.expect("a relayed event");
    let frame_data: Value = serde_json::from_str(f["data"].as_str().unwrap()).unwrap();
    let event = nekko_remote::e2e::open(&key, frame_data["enc"].as_str().unwrap()).unwrap();
    assert_eq!(
        event,
        json!({ "type": "event", "channel": "agent:event", "payload": { "type": "hello-from-backend" } })
    );
    let (_, status) = post(d.port, "remote:status", json!([]), Some(TOKEN)).await;
    assert_eq!(status["connected"], json!(["phone-1"]), "{status}");
    assert_eq!(status["online"], true);

    // Revoking kicks the phone live and drops its push token.
    post(d.port, "remote:revoke", json!(["phone-1"]), Some(TOKEN)).await;
    let (kick, _) = next_agent_frame(&mut agent, &key).await;
    assert_eq!(kick, json!({ "type": "kick", "cid": "c1" }));
    let (remove, _) = next_agent_frame(&mut agent, &key).await;
    assert_eq!(remove, json!({ "type": "push-remove", "deviceId": "phone-1" }));

    // Disabling closes the agent's socket.
    post(d.port, "remote:disable", json!([]), Some(TOKEN)).await;
    let closed = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match agent.next().await {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            }
        }
    })
    .await;
    assert!(closed.is_ok(), "the agent hung up");
    drop(d);
    let _ = std::fs::remove_dir_all(&data);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_daemon_turn_drives_the_in_app_browser_and_capture_through_the_bridge() {
    use axum::routing::post as route_post;
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let s2 = seen.clone();
    let app = axum::Router::new().route(
        "/bridge",
        route_post(move |headers: axum::http::HeaderMap, axum::Json(body): axum::Json<Value>| {
            let s2 = s2.clone();
            async move {
                let authorized =
                    headers.get("authorization").and_then(|v| v.to_str().ok()) == Some("Bearer bridge-token");
                s2.lock().unwrap().push(json!({ "authorized": authorized, "body": body }));
                let reply = if body["tool"] == "capture" {
                    json!({ "windows": [{ "window_id": "window:1", "title": "Editor" }] })
                } else {
                    json!({ "output": "Example page" })
                };
                axum::Json(reply)
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let bridge_port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let session = json!({
        "id": "s_turn_b", "title": "Named", "mode": "yolo", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1
    });
    let bridge = json!({ "browserBridge": { "url": format!("http://127.0.0.1:{bridge_port}/bridge"), "token": "bridge-token" } });
    let rig = turn_rig_with("browser", session, bridge);
    let model = scripted_model(vec![
        call_tool(
            "c_nav",
            "browser",
            json!({ "mode": "dedicated", "action": "navigate", "url": "https://example.com" }),
        ),
        call_tool("c_list", "capture", json!({ "action": "list" })),
        say_text("looked"),
    ])
    .await;
    let mut spec = turn_spec(&rig, &model, "turn_b", "s_turn_b", json!({}));
    spec["allowBrowserControl"] = json!(true);
    let (status, _) = post(rig.d.port, "chat:turn", json!([spec]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let (_, end) = turn_record(rig.d.port, "turn_b").await;
    assert_eq!(end["stop"], "complete", "{end}");
    let saved = saved_session(&rig, "s_turn_b");
    let messages = saved["messages"].as_array().unwrap();
    let tool_out = |id: &str| -> String {
        let m = messages.iter().find(|m| m["role"] == "tool" && m["toolResult"]["toolCallId"] == id).unwrap();
        m["toolResult"]["output"].as_str().unwrap().to_string()
    };
    assert_eq!(tool_out("c_nav"), "Example page");
    assert!(tool_out("c_list").contains("\"window_id\": \"window:1\""), "{}", tool_out("c_list"));
    let seen = seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 2, "{seen:?}");
    assert!(seen.iter().all(|r| r["authorized"] == true));
    assert_eq!(seen[0]["body"]["sessionId"], "s_turn_b");
    assert_eq!(seen[1]["body"], json!({ "tool": "capture", "sessionId": "s_turn_b", "action": "list" }));
    let (_, all) = post(rig.d.port, "test:completions", json!([]), Some(TOKEN)).await;
    assert!(!all.as_array().unwrap().iter().any(|e| e[0] == "turn:tool"), "the host ran nothing: {all}");
    server.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn the_daemon_runs_workflows_with_shell_prompt_and_webhook() {
    let data = std::env::temp_dir().join(format!("nekkod-workflows-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(data.join("sessions")).unwrap();
    let work = data.join("work");
    std::fs::create_dir_all(&work).unwrap();
    std::fs::write(
        data.join("settings.json"),
        json!({ "workspaces": [{ "id": "w1", "path": work }], "defaultProviderId": "p1", "defaultModelId": "m1" })
            .to_string(),
    )
    .unwrap();
    // A run interrupted by the last shutdown is written off at startup.
    std::fs::write(
        data.join("workflow-runs.json"),
        r#"[{"id":"old","workflowId":"gone","status":"running","triggerKind":"manual","startedAt":1,"steps":[]}]"#,
    )
    .unwrap();
    let d = start_with(true, Some(&data));
    let (_, info) = post(d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    assert!(info["owned"].as_array().unwrap().contains(&json!("workflow:run")), "{info}");
    wait_for("the reconcile", || {
        std::fs::read_to_string(data.join("workflow-runs.json")).unwrap_or_default().contains("Interrupted")
    })
    .await;

    let input = json!({
        "name": "Echo Flow",
        "steps": [
            { "id": "a", "name": "Say", "kind": "shell", "run": "echo hello-{{run.workflowName}}" },
            { "id": "b", "name": "Ask", "kind": "prompt", "run": "Summarize {{steps.a.output}}" },
        ],
        "triggers": [{ "id": "t", "kind": "webhook", "webhookSecret": "sekret" }],
    });
    let (_, wf) = post(d.port, "workflow:create", json!([input]), Some(TOKEN)).await;
    assert_eq!(wf["workspaceId"], "w1", "{wf}");
    let (_, run) = post(d.port, "workflow:run", json!([wf["id"]]), Some(TOKEN)).await;
    // The shell step ran for real; the fake host's turn left no answer.
    assert_eq!(run["steps"][0]["status"], "success", "{run}");
    assert!(run["steps"][0]["output"].as_str().unwrap().contains("hello-Echo Flow"), "{run}");
    assert_eq!(run["status"], "failure");
    assert_eq!(run["message"], "\"Ask\" failed: The model produced no answer for this step.");
    let (_, calls) = post(d.port, "test:completions", json!([]), Some(TOKEN)).await;
    let sent: Vec<&Value> = calls.as_array().unwrap().iter().filter(|c| c[0] == "chat:send").collect();
    assert!(sent[0][1][0]["text"].as_str().unwrap().contains("Summarize hello-Echo Flow"), "{calls}");

    // Webhooks: the right secret starts a run, a wrong one is refused.
    let (status, bad) = post(d.port, "workflow:webhook", json!(["echo-flow", "nope", {}]), Some(TOKEN)).await;
    assert_ne!(status, 200, "{bad}");
    let (_, runs) =
        post(d.port, "workflow:webhook", json!(["echo-flow", "sekret", { "ref": "main" }]), Some(TOKEN)).await;
    assert_eq!(runs[0]["triggerKind"], "webhook", "{runs}");
    let (_, history) = post(d.port, "workflow:runs", json!([wf["id"]]), Some(TOKEN)).await;
    assert_eq!(history.as_array().unwrap().len(), 2);
    drop(d);
    let _ = std::fs::remove_dir_all(&data);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_daemon_turn_arms_agent_watches_itself_and_owns_their_file() {
    let session = json!({
        "id": "s_turn_w", "title": "Named", "mode": "yolo", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1
    });
    let rig = turn_rig("watch", session);
    let model = scripted_model(vec![
        call_tool(
            "c_arm",
            "agent_watch",
            json!({ "action": "create", "kind": "timer", "prompt": "Check the build", "delay_seconds": 120 }),
        ),
        call_tool("c_bad", "agent_watch", json!({ "action": "create", "kind": "pr", "prompt": "x", "url": "nope" })),
        say_text("armed"),
    ])
    .await;
    let spec = turn_spec(&rig, &model, "turn_w", "s_turn_w", json!({}));
    let (status, _) = post(rig.d.port, "chat:turn", json!([spec]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let (_, end) = turn_record(rig.d.port, "turn_w").await;
    assert_eq!(end["stop"], "complete", "{end}");
    let saved = saved_session(&rig, "s_turn_w");
    let messages = saved["messages"].as_array().unwrap();
    let tool_out = |id: &str| -> String {
        let m = messages.iter().find(|m| m["role"] == "tool" && m["toolResult"]["toolCallId"] == id).unwrap();
        m["toolResult"]["output"].as_str().unwrap().to_string()
    };
    assert!(tool_out("c_arm").starts_with("Watch armed: "), "{}", tool_out("c_arm"));
    assert_eq!(tool_out("c_bad"), "Agent watch failed: A valid GitHub PR URL is required");
    let file: Value =
        serde_json::from_str(&std::fs::read_to_string(rig.data.join("agent-watches.json")).unwrap()).unwrap();
    assert_eq!(file[0]["prompt"], "Check the build");
    assert_eq!(file[0]["status"], "active");
    let (_, wake) = post(rig.d.port, "session:nextWatch", json!(["s_turn_w"]), Some(TOKEN)).await;
    assert_eq!(wake, file[0]["deadlineAt"]);
    let (_, listed) = post(rig.d.port, "watch:tool", json!(["s_turn_w", { "action": "list" }]), Some(TOKEN)).await;
    assert!(listed.as_str().unwrap().contains("\"Check the build\""), "{listed}");
    let (_, info) = post(rig.d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    assert!(info["owned"].as_array().unwrap().contains(&json!("session:nextWatch")));
    let (_, all) = post(rig.d.port, "test:completions", json!([]), Some(TOKEN)).await;
    assert!(!all.as_array().unwrap().iter().any(|e| e[0] == "turn:tool"), "the host ran nothing: {all}");
}
/// A sandbox chat's whole container life through the daemon against a real
/// Docker engine (opt-in: `NEKKO_SANDBOX_TEST_IMAGE` names a locally
/// installed, digest-pinned Linux image with python3).
#[tokio::test(flavor = "multi_thread")]
async fn a_sandbox_chat_runs_its_tools_in_a_container_the_daemon_owns() {
    let Ok(image) = std::env::var("NEKKO_SANDBOX_TEST_IMAGE") else { return };
    let session =
        json!({ "id": "s_box", "title": "Box", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1 });
    let rig = turn_rig("sandbox", session);
    let ws = rig.workspace.to_string_lossy().to_string();
    let (status, _) = post(
        rig.d.port,
        "settings:update",
        json!([{ "workspaces": [{ "id": "w1", "name": "project", "path": ws, "addedAt": 1 }] }]),
        Some(TOKEN),
    )
    .await;
    assert_eq!(status, 200);
    let (status, configured) = post(rig.d.port, "sandbox:configure", json!(["s_box", image]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{configured}");
    assert_eq!(configured["phase"], "ready", "{configured}");
    assert_eq!(saved_session(&rig, "s_box")["executionMode"], "sandbox");
    let identity = configured["identity"].clone();
    // Always clean the container up, even when an assertion fails.
    let checks = std::panic::AssertUnwindSafe(async {
        let call = |id: &str, name: &str, input: Value| json!({ "id": id, "name": name, "input": input });
        let (_, read) = post(
            rig.d.port,
            "sandbox:tool",
            json!(["s_box", call("c1", "read_file", json!({ "path": "folder-0/app.ts" }))]),
            Some(TOKEN),
        )
        .await;
        assert!(read["output"].as_str().unwrap().contains("pineapple"), "{read}");
        let (_, wrote) = post(
            rig.d.port,
            "sandbox:tool",
            json!(["s_box", call("c2", "bash", json!({ "command": "printf hi > folder-0/new.txt; id -u" }))]),
            Some(TOKEN),
        )
        .await;
        let shell: Value = serde_json::from_str(wrote["output"].as_str().unwrap()).unwrap();
        assert_eq!(shell["stdout"].as_str().unwrap().trim(), "1000", "{wrote}");
        let (_, denied) =
            post(rig.d.port, "sandbox:tool", json!(["s_box", call("c3", "fetch_url", json!({}))]), Some(TOKEN)).await;
        assert_eq!(denied["isError"], true);
        let (_, diff) = post(rig.d.port, "sandbox:diff", json!(["s_box"]), Some(TOKEN)).await;
        assert_eq!(diff["changes"][0]["path"], "folder-0/new.txt", "{diff}");
        assert!(!rig.workspace.join("new.txt").exists(), "the host folder is untouched");
        // A Stop during a command stops the container itself, at once.
        let port = rig.d.port;
        let long = tokio::spawn(async move {
            post(
                port,
                "sandbox:tool",
                json!(["s_box", { "id": "c4", "name": "bash", "input": { "command": "sleep 30" } }]),
                Some(TOKEN),
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let started = Instant::now();
        let (_, aborted) = post(rig.d.port, "sandbox:abort", json!(["s_box"]), Some(TOKEN)).await;
        assert_eq!(aborted, json!(true));
        let (_, stopped) = long.await.unwrap();
        assert_eq!(stopped["output"], "Sandbox execution cancelled", "{stopped}");
        assert!(started.elapsed() < Duration::from_secs(10));
        let (_, status) = post(rig.d.port, "sandbox:status", json!(["s_box"]), Some(TOKEN)).await;
        assert_eq!(
            status["error"], "Sandbox stopped by cancellation. Create a new sandbox chat to resume.",
            "{status}"
        );
    });
    let outcome = futures_util::FutureExt::catch_unwind(checks).await;
    let (status, _) = post(rig.d.port, "sandbox:cleanup", json!(["s_box", identity]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let (_, after) = post(rig.d.port, "sandbox:status", json!(["s_box"]), Some(TOKEN)).await;
    assert_eq!(after["phase"], "error", "{after}");
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn stop_during_admission_cancels_setup_and_refuses_duplicate_send() {
    let session = json!({ "id": "s_prepare_stop", "title": "Prepared", "titleAuto": false, "workspaceId": "w1", "gitIsolation": true, "executionMode": "worktree", "messages": [], "createdAt": 1, "updatedAt": 1 });
    let rig = turn_rig("prepare-stop", session);
    for args in [
        vec!["init", "-q"],
        vec!["add", "."],
        vec!["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "Fixture"],
    ] {
        let mut cmd = Command::new("git");
        cmd.args(args).current_dir(&rig.workspace);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let out = cmd.output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    }
    let model = scripted_model(vec![say_text("after stop")]).await;
    let setup =
        if cfg!(windows) { "echo setup-begun & ping -n 30 127.0.0.1 >nul" } else { "echo setup-begun; sleep 30" };
    let settings = json!({ "providers": [{ "id": "p1", "kind": "openai-compat", "enabled": true, "baseUrl": format!("http://127.0.0.1:{}/v1", model.port) }], "workspaces": [{ "id": "w1", "name": "project", "path": rig.workspace.to_string_lossy(), "worktreeSetup": setup }], "defaultChatMode": "yolo" });
    std::fs::write(rig.data.join("settings.json"), settings.to_string()).unwrap();
    let opts =
        json!({ "sessionId": "s_prepare_stop", "providerId": "p1", "modelId": "synthetic", "text": "prepare this" });
    let send_opts = opts.clone();
    let port = rig.d.port;
    let sender = tokio::spawn(async move { post(port, "chat:send", json!([send_opts]), Some(TOKEN)).await });
    let mut last_calls = Value::Null;
    let setup_wait =
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let (_, calls) = post(port, "test:completions", json!([]), Some(TOKEN)).await;
                last_calls = calls.clone();
                if calls.as_array().unwrap().iter().any(|c| {
                    c[0] == "loop:log" && c[1][2].as_str().is_some_and(|s| s.trim().starts_with("setup-begun"))
                }) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await;
    assert!(setup_wait.is_ok(), "setup command started: {last_calls}");
    let (status, refused) = post(port, "chat:send", json!([opts.clone()]), Some(TOKEN)).await;
    assert_eq!(status, 400, "{refused}");
    assert!(refused.to_string().contains("already being prepared"));
    post(port, "chat:abort", json!(["s_prepare_stop"]), Some(TOKEN)).await;
    let (status, reply) =
        tokio::time::timeout(Duration::from_secs(5), sender).await.expect("Stop ends admission promptly").unwrap();
    assert_eq!((status, reply), (200, Value::Null));
    assert!(model.requests.lock().unwrap().is_empty(), "a stopped preparation must never reach a model");
    assert!(saved_session(&rig, "s_prepare_stop")["messages"].as_array().unwrap().is_empty());
    // The admission guard releases; a fresh send on the prepared checkout can run.
    let (status, reply) = post(port, "chat:send", json!([opts]), Some(TOKEN)).await;
    assert_eq!((status, reply), (200, Value::Null));
    assert_eq!(
        saved_session(&rig, "s_prepare_stop")["messages"].as_array().unwrap().last().unwrap()["content"],
        "after stop"
    );
}

/// A GGUF header with enough geometry for the planner (`gguf-fixture.ts`).
fn tiny_gguf(arch: &str, name: &str) -> Vec<u8> {
    let s = |v: &str| {
        let mut b = (v.len() as u64).to_le_bytes().to_vec();
        b.extend_from_slice(v.as_bytes());
        b
    };
    let text = |v: &str| [8u32.to_le_bytes().to_vec(), s(v)].concat();
    let int = |n: u32| [4u32.to_le_bytes(), n.to_le_bytes()].concat();
    let pairs: Vec<(String, Vec<u8>)> = vec![
        ("general.architecture".into(), text(arch)),
        ("general.name".into(), text(name)),
        ("general.file_type".into(), int(15)),
        (format!("{arch}.block_count"), int(16)),
        (format!("{arch}.attention.head_count"), int(16)),
        (format!("{arch}.attention.head_count_kv"), int(4)),
        (format!("{arch}.embedding_length"), int(1024)),
        (format!("{arch}.context_length"), int(8192)),
    ];
    let mut out = [0x4655_4747u32.to_le_bytes(), 3u32.to_le_bytes()].concat();
    out.extend(0u64.to_le_bytes());
    out.extend((pairs.len() as u64).to_le_bytes());
    for (k, v) in pairs {
        out.extend(s(&k));
        out.extend(v);
    }
    out.extend([0u8; 64]);
    out
}

#[tokio::test(flavor = "multi_thread")]
async fn serves_the_model_library_and_its_folders_itself() {
    let root = std::env::temp_dir().join(format!("nekkod-library-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let data = root.join("data");
    let home = root.join("home");
    // Our own download, and a model Ollama pulled in the (scratch) home.
    let model = data.join("models/chat/acme_tiny-gguf/tiny-q4_k_m.gguf");
    std::fs::create_dir_all(model.parent().unwrap()).unwrap();
    std::fs::write(&model, tiny_gguf("llama", "Tiny")).unwrap();
    let ollama = home.join(".ollama/models");
    std::fs::create_dir_all(ollama.join("manifests/registry.ollama.ai/library/tiny")).unwrap();
    std::fs::create_dir_all(ollama.join("blobs")).unwrap();
    std::fs::write(
        ollama.join("manifests/registry.ollama.ai/library/tiny/latest"),
        json!({ "layers": [{ "mediaType": "application/vnd.ollama.image.model", "digest": "sha256:abc" }] })
            .to_string(),
    )
    .unwrap();
    std::fs::write(ollama.join("blobs/sha256-abc"), tiny_gguf("qwen2", "Ollama Tiny")).unwrap();
    let outside = root.join("outside/loose.gguf");
    std::fs::create_dir_all(outside.parent().unwrap()).unwrap();
    std::fs::write(&outside, tiny_gguf("llama", "Loose")).unwrap();
    let h = home.to_string_lossy().to_string();
    let local = home.join("local").to_string_lossy().to_string();
    let roaming = home.join("roaming").to_string_lossy().to_string();
    let d = start_with_env(
        true,
        Some(&data),
        json!({}),
        &[
            ("HOME", Some(&h)),
            ("USERPROFILE", Some(&h)),
            ("LOCALAPPDATA", Some(&local)),
            ("APPDATA", Some(&roaming)),
            ("OLLAMA_MODELS", None),
            ("HF_HOME", None),
            ("HUGGINGFACE_HUB_CACHE", None),
        ],
    );

    let (_, info) = post(d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    for channel in [
        "engine:models",
        "engine:importModel",
        "engine:deleteModel",
        "engine:saveModelPreset",
        "engine:folders",
        "engine:foldersSave",
        "engine:autoload",
        "engine:library",
    ] {
        assert!(info["owned"].as_array().unwrap().contains(&json!(channel)), "{channel} is not owned");
    }

    // The first read seeds the folder list with Ollama's store, saved as a setting.
    let (status, models) = post(d.port, "engine:models", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{models}");
    let settings: Value = serde_json::from_str(&std::fs::read_to_string(data.join("settings.json")).unwrap()).unwrap();
    let folders = settings["engine"]["modelFolders"].as_array().unwrap().clone();
    assert_eq!(folders.len(), 1, "{folders:?}");
    assert_eq!((folders[0]["id"].clone(), folders[0]["provider"].clone()), (json!("ollama"), json!("ollama")));
    let rows = models.as_array().unwrap();
    let ids: Vec<&str> = rows.iter().map(|m| m["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["chat/acme_tiny-gguf/tiny-q4_k_m", "ollama/tiny:latest"], "sorted by name: {rows:?}");
    let ours = &rows[0];
    assert_eq!(ours["name"], "Tiny");
    assert_eq!(ours["sourceRepo"], "acme/tiny-gguf");
    assert_eq!(
        (ours["layers"].clone(), ours["kvHeads"].clone(), ours["headDim"].clone()),
        (json!(16), json!(4), json!(64))
    );
    // Load state from the daemon's own model server (nothing loaded), the fit from this machine.
    assert_eq!(ours["loaded"], false);
    assert!(ours.get("lastLoadError").is_none());
    assert!(["full", "partial", "cpu", "wont"].contains(&ours["gpuFit"].as_str().unwrap()), "{ours}");
    assert_eq!(rows[1]["name"], "tiny:latest", "named as `ollama run` names it");
    assert_eq!(rows[1]["loaded"], false);
    assert!(rows[1].get("lastLoadError").is_none());
    assert_eq!(rows[1]["managed"], false);
    // The bare rows the TS model server reads.
    let (_, bare) = post(d.port, "engine:library", json!([]), Some(TOKEN)).await;
    assert_eq!(bare.as_array().unwrap().len(), 2);
    assert!(bare[0].get("loaded").is_none());

    let (_, report) = post(d.port, "engine:folders", json!([]), Some(TOKEN)).await;
    let counts: Vec<(Value, Value)> =
        report["folders"].as_array().unwrap().iter().map(|f| (f["id"].clone(), f["modelCount"].clone())).collect();
    assert_eq!(counts, [(json!("primary"), json!(1)), (json!("ollama"), json!(1))]);
    assert_eq!(report["suggestions"], json!([]), "the seeded folder is not suggested again");

    // Presets live in library.json, which only the daemon writes.
    let id = "chat/acme_tiny-gguf/tiny-q4_k_m";
    let (_, none) = post(d.port, "engine:saveModelPreset", json!([id, { "contextTokens": 4096 }]), Some(TOKEN)).await;
    assert_eq!(none, Value::Null);
    let index: Value =
        serde_json::from_str(&std::fs::read_to_string(data.join("models/library.json")).unwrap()).unwrap();
    assert_eq!(index["models"][id]["preset"], json!({ "contextTokens": 4096 }));

    let (_, imported) = post(d.port, "engine:importModel", json!([outside]), Some(TOKEN)).await;
    assert_eq!((imported["ok"].clone(), imported["message"].clone()), (json!(true), json!("Added Loose.")));
    let (_, refused) = post(d.port, "engine:deleteModel", json!(["ollama/tiny:latest"]), Some(TOKEN)).await;
    assert_eq!(refused["ok"], false);
    assert!(ollama.join("blobs/sha256-abc").exists(), "a borrowed folder is never written");
    let (_, deleted) = post(d.port, "engine:deleteModel", json!([id]), Some(TOKEN)).await;
    assert_eq!(deleted, json!({ "ok": true, "message": "Deleted Tiny." }));
    assert!(!model.exists());

    // The autoload list and the folder list are engine settings.
    let (_, engine) = post(d.port, "engine:autoload", json!(["ollama/tiny:latest", true]), Some(TOKEN)).await;
    assert_eq!(engine["autoload"], json!(["ollama/tiny:latest"]));
    assert_eq!(engine["port"], 11500, "merged over the engine defaults");
    let (_, engine) = post(d.port, "engine:autoload", json!(["ollama/tiny:latest", true]), Some(TOKEN)).await;
    assert_eq!(engine["autoload"], json!(["ollama/tiny:latest"]), "no duplicates");
    let (_, engine) = post(d.port, "engine:autoload", json!(["ollama/tiny:latest", false]), Some(TOKEN)).await;
    assert_eq!(engine["autoload"], json!([]));
    let (_, report) =
        post(d.port, "engine:foldersSave", json!([[{ "id": "primary", "path": "/x", "enabled": true }]]), Some(TOKEN))
            .await;
    assert_eq!(report["folders"].as_array().unwrap().len(), 1, "{report}");
    assert_eq!(report["suggestions"][0]["provider"], "ollama", "removed, so suggested");
    let settings: Value = serde_json::from_str(&std::fs::read_to_string(data.join("settings.json")).unwrap()).unwrap();
    assert_eq!(settings["engine"]["modelFolders"], json!([]));

    tokio::time::sleep(Duration::from_millis(300)).await;
    let (_, calls) = post(d.port, "test:completions", json!([]), Some(TOKEN)).await;
    let changed = calls.as_array().unwrap().iter().filter(|c| c[0] == "settings:changed").count();
    assert_eq!(changed, 5, "the seed, three autoload saves and the folder save reach the host: {calls}");
    assert!(!calls.as_array().unwrap().iter().any(|c| c[0] == "engine:runtime"), "the daemon runs the server: {calls}");
    drop(d);
    std::fs::remove_dir_all(root).ok();
}

/// A loopback Hugging Face: one GGUF repo with a projector and a tokenizer,
/// and one whose weights never finish arriving.
async fn fake_hugging_face(gguf: Vec<u8>) -> u16 {
    use axum::extract::Path;
    use axum::routing::get;
    let tree = |files: Vec<(&str, usize)>| {
        json!(
            files
                .into_iter()
                .map(|(p, s)| json!({ "type": "file", "oid": "x", "size": s, "path": p }))
                .collect::<Vec<_>>()
        )
    };
    let tiny = tree(vec![("tiny-Q4_K_M.gguf", gguf.len()), ("mmproj-F16.gguf", gguf.len()), ("tokenizer.json", 2)]);
    let slow = tree(vec![("slow-Q4_K_M.gguf", 1_000_000)]);
    let app = axum::Router::new()
        .route("/api/models/acme/tiny-GGUF", get(|| async { axum::Json(json!({ "tags": ["gguf"], "downloads": 3 })) }))
        .route("/api/models/acme/slow-GGUF", get(|| async { axum::Json(json!({ "tags": ["gguf"] })) }))
        .route("/api/models/acme/tiny-GGUF/tree/main", get(move || async move { axum::Json(tiny) }))
        .route("/api/models/acme/slow-GGUF/tree/main", get(move || async move { axum::Json(slow) }))
        .route(
            "/acme/{repo}/resolve/main/{file}",
            get(move |Path((repo, file)): Path<(String, String)>| {
                let gguf = gguf.clone();
                async move {
                    use axum::response::IntoResponse;
                    if repo == "slow-GGUF" {
                        // The first bytes, then nothing: a download to cancel.
                        let first = futures_util::stream::iter(vec![Ok::<_, std::io::Error>(vec![7u8; 4096])]);
                        let body = axum::body::Body::from_stream(first.chain(futures_util::stream::pending()));
                        return ([("content-length", "1000000")], body).into_response();
                    }
                    match file.as_str() {
                        "tokenizer.json" => b"{}".to_vec().into_response(),
                        _ => gguf.into_response(),
                    }
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    port
}

async fn job_until(port: u16, id: &str, done: impl Fn(&Value) -> bool) -> Value {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let (_, jobs) = post(port, "engine:downloads", json!([]), Some(TOKEN)).await;
        if let Some(j) = jobs.as_array().and_then(|a| a.iter().find(|j| j["id"] == id)).filter(|j| done(j)) {
            return j.clone();
        }
        assert!(Instant::now() < deadline, "{id} never got there: {jobs}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn downloads_models_itself_and_merges_the_hosts_jobs() {
    let root = std::env::temp_dir().join(format!("nekkod-downloads-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let data = root.join("data");
    let home = root.join("home");
    std::fs::create_dir_all(&data).unwrap();
    // No other apps' folders to seed in this home.
    std::fs::write(data.join("settings.json"), r#"{"engine":{"modelFolders":[]}}"#).unwrap();
    let hf = fake_hugging_face(tiny_gguf("llama", "Tiny")).await;
    let h = home.to_string_lossy().to_string();
    let d = start_with_env(
        true,
        Some(&data),
        json!({ "huggingFaceUrl": format!("http://127.0.0.1:{hf}") }),
        &[("HOME", Some(&h)), ("USERPROFILE", Some(&h)), ("OLLAMA_MODELS", None), ("HF_HOME", None)],
    );
    let (_, info) = post(d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    for channel in [
        "engine:downloadModel",
        "engine:downloadCompanions",
        "engine:imageCompanions",
        "engine:downloadImageCompanions",
        "engine:downloads",
        "engine:cancelDownload",
        "engine:dismissDownload",
    ] {
        assert!(info["owned"].as_array().unwrap().contains(&json!(channel)), "{channel} is not owned");
    }
    let mut events = ws(d.port, &format!("/api/events?token={TOKEN}"), Some("null")).await.unwrap();

    // One quantization, with its projector and tokenizer, from the catalog.
    let (status, started) =
        post(d.port, "engine:downloadModel", json!(["acme/tiny-GGUF", "Q4_K_M"]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{started}");
    assert_eq!(started["ok"], true, "{started}");
    let id = started["jobId"].as_str().unwrap().to_string();
    assert_eq!(id, "model:acme/tiny-GGUF:Q4_K_M");
    let done =
        job_until(d.port, &id, |j| j["state"] != "queued" && j["state"] != "downloading" && j["state"] != "verifying")
            .await;
    assert_eq!(done["state"], "done", "{done}");
    let weights = data.join("models/chat/acme_tiny-GGUF/tiny-Q4_K_M.gguf");
    assert!(weights.exists(), "{done}");
    assert!(!data.join("models/chat/acme_tiny-GGUF/tiny-Q4_K_M.gguf.part").exists());
    for extra in ["mmproj-F16.gguf", "tokenizer.json"] {
        job_until(d.port, &format!("{id}:{extra}"), |j| j["state"] == "done").await;
        assert!(data.join("models/chat/acme_tiny-GGUF").join(extra).exists(), "{extra}");
    }
    // The UI heard about it.
    let mut heard = false;
    while let Some(ev) = next_json(&mut events, Duration::from_secs(2)).await {
        if ev["channel"] == "downloads:updated"
            && ev["payload"].as_array().is_some_and(|a| a.iter().any(|j| j["id"] == id.as_str()))
        {
            heard = true;
            break;
        }
    }
    assert!(heard, "no downloads:updated event");
    // A finished model turns on autoStart, and the library lists it as a vision model.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let settings: Value =
            serde_json::from_str(&std::fs::read_to_string(data.join("settings.json")).unwrap()).unwrap();
        if settings["engine"]["autoStart"] == true {
            break;
        }
        assert!(Instant::now() < deadline, "autoStart was never turned on: {settings}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let (_, models) = post(d.port, "engine:models", json!([]), Some(TOKEN)).await;
    let row =
        models.as_array().unwrap().iter().find(|m| m["id"] == "chat/acme_tiny-GGUF/tiny-Q4_K_M").cloned().unwrap();
    assert_eq!((row["sourceRepo"].clone(), row["modality"].clone()), (json!("acme/tiny-GGUF"), json!("vision")));

    // Its companions are already there; an image-only call answers null.
    let (_, companions) =
        post(d.port, "engine:downloadCompanions", json!(["chat/acme_tiny-GGUF/tiny-Q4_K_M"]), Some(TOKEN)).await;
    assert_eq!(companions["message"], "Tiny already has every companion file acme/tiny-GGUF ships.", "{companions}");
    let (_, image) =
        post(d.port, "engine:imageCompanions", json!(["chat/acme_tiny-GGUF/tiny-Q4_K_M"]), Some(TOKEN)).await;
    assert_eq!(image, Value::Null);
    let (_, missing) = post(d.port, "engine:downloadImageCompanions", json!(["nope"]), Some(TOKEN)).await;
    assert_eq!(missing, json!({ "ok": false, "message": "That model is not in the library." }));
    let (_, gone) = post(d.port, "engine:downloadModel", json!(["acme/missing-GGUF", "Q4_K_M"]), Some(TOKEN)).await;
    assert_eq!(gone, json!({ "ok": false, "message": "That model is no longer published." }));

    // A download cancelled midway keeps its partial file for a resume.
    let (_, slow) = post(d.port, "engine:downloadModel", json!(["acme/slow-GGUF", "Q4_K_M"]), Some(TOKEN)).await;
    let slow_id = slow["jobId"].as_str().unwrap().to_string();
    let receiving = job_until(d.port, &slow_id, |j| j["receivedBytes"].as_f64().unwrap_or(0.0) >= 4096.0).await;
    assert_eq!((receiving["state"].clone(), receiving["totalBytes"].clone()), (json!("downloading"), json!(1_000_000)));
    let (_, none) = post(d.port, "engine:cancelDownload", json!([slow_id]), Some(TOKEN)).await;
    assert_eq!(none, Value::Null);
    let cancelled = job_until(d.port, &slow_id, |j| j["state"] == "cancelled").await;
    assert_eq!(cancelled["message"], "Cancelled.");
    assert_eq!(std::fs::metadata(data.join("models/chat/acme_slow-GGUF/slow-Q4_K_M.gguf.part")).unwrap().len(), 4096);
    post(d.port, "engine:dismissDownload", json!([slow_id]), Some(TOKEN)).await;

    // The host's runtime installs join the list; their controls go back to it.
    let host_job = json!({ "id": "engine:llama:b9999-cuda", "kind": "engine", "label": "llama.cpp", "target": "b9999-cuda", "state": "downloading", "receivedBytes": 1, "startedAt": 9_999_999_999_999u64 });
    let (_, none) = post(d.port, "engine:hostDownloads", json!([[host_job]]), Some(TOKEN)).await;
    assert_eq!(none, Value::Null);
    let (_, jobs) = post(d.port, "engine:downloads", json!([]), Some(TOKEN)).await;
    let ids: Vec<&str> = jobs.as_array().unwrap().iter().map(|j| j["id"].as_str().unwrap()).collect();
    assert_eq!(ids[0], "engine:llama:b9999-cuda", "newest first: {ids:?}");
    assert!(!ids.contains(&slow_id.as_str()), "dismissed: {ids:?}");
    assert!(ids.contains(&id.as_str()));
    post(d.port, "engine:cancelDownload", json!(["engine:llama:b9999-cuda"]), Some(TOKEN)).await;
    post(d.port, "engine:dismissDownload", json!(["engine:llama:b9999-cuda"]), Some(TOKEN)).await;
    let (_, calls) = post(d.port, "test:completions", json!([]), Some(TOKEN)).await;
    let runtime: Vec<&Value> = calls
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c[0] == "engine:runtime" && c[1][0] != "loadState" && c[1][0] != "downloads")
        .collect();
    assert_eq!(
        runtime,
        [
            &json!(["engine:runtime", ["cancelDownload", "engine:llama:b9999-cuda"]]),
            &json!(["engine:runtime", ["dismissDownload", "engine:llama:b9999-cuda"]])
        ],
        "{calls}"
    );
    drop(events);
    drop(d);
    std::fs::remove_dir_all(root).ok();
}

/// A llama.cpp release archive for this machine's CPU build, made with the
/// system's own tar (bsdtar on Windows and macOS writes zip from the name).
fn engine_archive(dir: &std::path::Path) -> (String, &'static str, Vec<u8>) {
    let (build, name, exe) = if cfg!(windows) {
        ("win-x64-cpu", "llama-b11224-bin-win-cpu-x64.zip", "llama-server.exe")
    } else if cfg!(target_os = "macos") {
        ("macos-arm64-metal", "llama-b11224-bin-macos-arm64.tar.gz", "llama-server")
    } else if cfg!(target_arch = "aarch64") {
        ("linux-arm64-cpu", "llama-b11224-bin-ubuntu-arm64.tar.gz", "llama-server")
    } else {
        ("linux-x64-cpu", "llama-b11224-bin-ubuntu-x64.tar.gz", "llama-server")
    };
    let src = dir.join("archive-src/build/bin");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(src.join(exe), "not really llama-server").unwrap();
    let out = dir.join(name);
    let args: Vec<String> = if name.ends_with(".zip") {
        vec![
            "-a".into(),
            "-cf".into(),
            out.to_string_lossy().into(),
            "-C".into(),
            dir.join("archive-src").to_string_lossy().into(),
            "build".into(),
        ]
    } else {
        vec![
            "-czf".into(),
            out.to_string_lossy().into(),
            "-C".into(),
            dir.join("archive-src").to_string_lossy().into(),
            "build".into(),
        ]
    };
    let status = Command::new("tar").args(&args).stdin(Stdio::null()).status().expect("tar runs");
    assert!(status.success(), "tar {args:?}");
    (build.to_string(), name, std::fs::read(out).unwrap())
}

/// A loopback GitHub: the pinned llama.cpp release with one archive.
async fn fake_github(name: &'static str, archive: Vec<u8>) -> u16 {
    use axum::routing::get;
    use sha2::Digest;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let digest: String = sha2::Sha256::digest(&archive).iter().map(|b| format!("{b:02x}")).collect();
    let release = json!({
        "tag_name": "b11224",
        "assets": [{ "name": name, "browser_download_url": format!("http://127.0.0.1:{port}/dl/{name}"), "size": archive.len(), "digest": format!("sha256:{digest}") }],
    });
    let app = axum::Router::new()
        .route("/repos/ggml-org/llama.cpp/releases/tags/b11224", get(move || async move { axum::Json(release) }))
        .route(&format!("/dl/{name}"), get(move || async move { archive }));
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    port
}

#[tokio::test(flavor = "multi_thread")]
async fn installs_and_removes_the_engine_itself() {
    let root = std::env::temp_dir().join(format!("nekkod-installs-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let data = root.join("data");
    std::fs::create_dir_all(&data).unwrap();
    std::fs::write(data.join("settings.json"), r#"{"engine":{"modelFolders":[]}}"#).unwrap();
    let (build, name, archive) = engine_archive(&root);
    let gh = fake_github(name, archive).await;
    let d = start_with_env(true, Some(&data), json!({ "githubApiUrl": format!("http://127.0.0.1:{gh}") }), &[]);
    let (_, info) = post(d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    for channel in
        ["engine:install", "engine:uninstall", "engine:installPreview", "engine:detect", "engine:installedBin"]
    {
        assert!(info["owned"].as_array().unwrap().contains(&json!(channel)), "{channel} is not owned");
    }

    let (_, preview) = post(d.port, "engine:installPreview", json!(["llama", build]), Some(TOKEN)).await;
    assert_eq!(
        (preview["version"].clone(), preview["files"][0]["name"].clone()),
        (json!("b11224"), json!(name)),
        "{preview}"
    );
    let (status, started) = post(d.port, "engine:install", json!([build, "llama"]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{started}");
    assert_eq!(started["message"], "Downloading llama.cpp b11224.", "{started}");
    let job =
        job_until(d.port, started["jobId"].as_str().unwrap(), |j| j["state"] == "done" || j["state"] == "failed").await;
    assert_eq!(job["state"], "done", "{job}");
    let exe = if cfg!(windows) { "llama-server.exe" } else { "llama-server" };
    let bin = data.join("engine").join(&build).join("build/bin").join(exe);
    assert!(bin.exists(), "unpacked: {job}");
    assert!(!data.join("engine").join(&build).join(name).exists(), "the archive is gone once unpacked");
    let record: Value =
        serde_json::from_str(&std::fs::read_to_string(data.join("engine/engine.json")).unwrap()).unwrap();
    assert_eq!((record["buildId"].clone(), record["version"].clone()), (json!(build), json!("b11224")));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&bin).unwrap().permissions().mode() & 0o777, 0o755);
    }

    let (_, detected) = post(d.port, "engine:detect", json!(["llama"]), Some(TOKEN)).await;
    assert_eq!(
        (detected["source"].clone(), detected["version"].clone()),
        (json!("managed"), json!("b11224")),
        "{detected}"
    );
    assert!(
        std::path::Path::new(detected["binPath"].as_str().unwrap())
            .ends_with(std::path::Path::new("build/bin").join(exe))
    );
    let (_, installed) = post(d.port, "engine:installedBin", json!([]), Some(TOKEN)).await;
    assert_eq!(installed, detected["binPath"]);
    let (_, sd) = post(d.port, "engine:detect", json!(["diffusion"]), Some(TOKEN)).await;
    assert!(sd["available"].is_array(), "{sd}");
    let (_, mlx) = post(d.port, "engine:detect", json!(["mlx"]), Some(TOKEN)).await;
    if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        assert_eq!(mlx["reason"], "MLX runs on Apple Silicon Macs only.");
    }

    // The server is the host's: it is asked whether one runs before files go.
    let (_, removed) = post(d.port, "engine:uninstall", json!(["llama"]), Some(TOKEN)).await;
    assert_eq!(removed, json!({ "ok": true, "message": "Removed the engine." }));
    assert!(!data.join("engine").join(&build).exists() && !data.join("engine/engine.json").exists());
    let (_, again) = post(d.port, "engine:uninstall", json!(["llama"]), Some(TOKEN)).await;
    assert_eq!(again["message"], "No managed engine is installed.");
    let (_, calls) = post(d.port, "test:completions", json!([]), Some(TOKEN)).await;
    let asked = calls.as_array().unwrap().iter().filter(|c| c[0] == "engine:runtime" && c[1][0] == "isRunning").count();
    assert_eq!(asked, 0, "the daemon's own model server answers whether one runs: {calls}");
    drop(d);
    std::fs::remove_dir_all(root).ok();
}

/// The stand-in `llama-server`, built beside this test if `cargo test` did not build examples.
fn fake_llama() -> std::path::PathBuf {
    let exe = format!("fake_llama_server{}", std::env::consts::EXE_SUFFIX);
    let deps = std::env::current_exe().unwrap().parent().unwrap().to_path_buf();
    let path = deps.parent().unwrap().join("examples").join(exe);
    if !path.is_file() {
        let target = deps.parent().unwrap().parent().unwrap();
        let ok = Command::new(env!("CARGO"))
            .args(["build", "-p", "nekkod", "--example", "fake_llama_server"])
            .env("CARGO_TARGET_DIR", target)
            .status()
            .unwrap()
            .success();
        assert!(ok, "the fake llama-server builds");
    }
    path
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

#[tokio::test(flavor = "multi_thread")]
async fn runs_the_model_server_itself() {
    let root = std::env::temp_dir().join(format!("nekkod-server-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let data = root.join("data");
    let model = data.join("models/chat/acme_tiny-gguf/tiny-q4_k_m.gguf");
    std::fs::create_dir_all(model.parent().unwrap()).unwrap();
    std::fs::write(&model, tiny_gguf("llama", "Tiny")).unwrap();
    let other = data.join("models/chat/acme_other-gguf/other-q4_k_m.gguf");
    std::fs::create_dir_all(other.parent().unwrap()).unwrap();
    std::fs::write(&other, tiny_gguf("qwen2", "Other")).unwrap();
    let port = free_port();
    let settings = json!({
        "engineBinPath": fake_llama(),
        "engine": { "port": port, "modelFolders": [], "maxLoaded": 1 },
    });
    std::fs::write(data.join("settings.json"), settings.to_string()).unwrap();
    let d = start_with_env(true, Some(&data), json!({}), &[]);
    let (_, info) = post(d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    for channel in [
        "engine:status",
        "engine:settings",
        "engine:residentTtl",
        "engine:generateImage",
        "engine:start",
        "engine:load",
    ] {
        assert!(info["owned"].as_array().unwrap().contains(&json!(channel)), "{channel} is not owned");
    }

    let (status, s) = post(d.port, "engine:status", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{s}");
    assert_eq!(
        (s["running"].clone(), s["install"]["source"].clone(), s["install"]["version"].clone()),
        (json!(false), json!("external"), json!("b4242"))
    );
    assert_eq!(s["port"], port);

    // Start: the daemon listens, and a provider entry points at the engine.
    let (_, started) = post(d.port, "engine:start", json!([]), Some(TOKEN)).await;
    assert_eq!(started, json!({ "ok": true, "message": format!("The engine is serving on port {port}.") }));
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(data.join("settings.json")).unwrap()).unwrap();
    let provider = saved["providers"].as_array().unwrap().iter().find(|p| p["kind"] == "llamacpp").cloned().unwrap();
    assert_eq!(
        (provider["id"].clone(), provider["baseUrl"].clone()),
        (json!("nekko-engine"), json!(format!("http://127.0.0.1:{port}/v1")))
    );

    // A load through the daemon's own policy, with the flags the binary knows.
    let id = "chat/acme_tiny-gguf/tiny-q4_k_m";
    let (_, loaded) = post(d.port, "engine:load", json!([id, { "contextTokens": 4096 }]), Some(TOKEN)).await;
    assert_eq!(loaded, json!({ "ok": true, "message": format!("Loaded {id}.") }), "{loaded}");
    let (_, s) = post(d.port, "engine:status", json!([]), Some(TOKEN)).await;
    assert_eq!(s["running"], true);
    assert_eq!(s["resident"][0]["id"], id);
    assert_eq!(s["resident"][0]["contextLength"], 4096);
    assert!(
        s["log"].as_array().unwrap().iter().any(|l| l
            .as_str()
            .unwrap()
            .ends_with(&format!("Loaded {id} on port {}.", ""))
            || l.as_str().unwrap().contains(&format!("Loaded {id} on port"))),
        "{s}"
    );
    let (_, models) = post(d.port, "engine:models", json!([]), Some(TOKEN)).await;
    let row = models.as_array().unwrap().iter().find(|m| m["id"] == id).cloned().unwrap();
    assert_eq!(row["loaded"], true);

    // The router serves it, and loads another on demand (evicting the first: one resident).
    let http = reqwest::Client::new();
    let list: Value =
        http.get(format!("http://127.0.0.1:{port}/v1/models")).send().await.unwrap().json().await.unwrap();
    let states: Vec<(Value, Value)> =
        list["data"].as_array().unwrap().iter().map(|m| (m["id"].clone(), m["state"].clone())).collect();
    assert!(states.contains(&(json!(id), json!("loaded"))), "{list}");
    let reply: Value = http
        .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
        .json(&json!({ "model": id, "messages": [{ "role": "user", "content": "hi" }] }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let said = reply["choices"][0]["message"]["content"].as_str().unwrap().to_string();
    assert!(
        said.contains("--ctx-size 4096") && said.contains("--cache-reuse 256") && said.contains("--spec-default"),
        "{said}"
    );
    assert!(!said.contains("--cache-ram"), "a flag the binary does not list is left out: {said}");
    let other_id = "chat/acme_other-gguf/other-q4_k_m";
    let reply: Value = http
        .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
        .json(&json!({ "model": other_id, "messages": [] }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(reply["model"], other_id, "{reply}");
    let (_, s) = post(d.port, "engine:status", json!([]), Some(TOKEN)).await;
    let resident: Vec<Value> = s["resident"].as_array().unwrap().iter().map(|r| r["id"].clone()).collect();
    assert_eq!(resident, [json!(other_id)], "{s}");

    // Residency and endpoint settings.
    let (_, ttl) = post(d.port, "engine:residentTtl", json!([other_id, 120]), Some(TOKEN)).await;
    assert_eq!(ttl, json!({ "ok": true, "message": format!("{other_id} now unloads after 120s idle.") }));
    let (_, next) = post(d.port, "engine:settings", json!([{ "apiKey": "sekret" }]), Some(TOKEN)).await;
    assert_eq!((next["apiKey"].clone(), next["port"].clone()), (json!("sekret"), json!(port)));
    let refused = http.get(format!("http://127.0.0.1:{port}/v1/models")).send().await.unwrap().status().as_u16();
    assert_eq!(refused, 401, "the listener was re-served with the key");
    let allowed = http
        .get(format!("http://127.0.0.1:{port}/v1/models"))
        .bearer_auth("sekret")
        .send()
        .await
        .unwrap()
        .status()
        .as_u16();
    assert_eq!(allowed, 200);
    let (_, image) = post(
        d.port,
        "engine:generateImage",
        json!([{ "modelId": other_id, "prompt": "x", "width": 100, "height": 512 }]),
        Some(TOKEN),
    )
    .await;
    assert_eq!(
        image["error"],
        "Use a prompt, dimensions from 256 to 2048 in multiples of 64, 1 to 100 steps and CFG from 0 to 30.",
        "{image}"
    );
    let (_, image) = post(
        d.port,
        "engine:generateImage",
        json!([{ "modelId": other_id, "prompt": "x", "width": 512, "height": 512 }]),
        Some(TOKEN),
    )
    .await;
    assert_eq!(image["error"], "Choose an image-generation model.", "{image}");

    let (_, unloaded) = post(d.port, "engine:unload", json!([other_id]), Some(TOKEN)).await;
    assert_eq!(unloaded["ok"], true);
    let (_, stopped) = post(d.port, "engine:stop", json!([]), Some(TOKEN)).await;
    assert_eq!(stopped, json!({ "ok": true, "message": "Stopped the engine." }));
    let (_, s) = post(d.port, "engine:status", json!([]), Some(TOKEN)).await;
    assert_eq!((s["running"].clone(), s["resident"].clone()), (json!(false), json!([])));
    assert!(http.get(format!("http://127.0.0.1:{port}/v1/models")).send().await.is_err(), "the listener is closed");
    drop(d);
    std::fs::remove_dir_all(root).ok();
}

/* ------------------------------------------------- turn variants (PF14 A2) */

/// A chat with three turns on the scripted provider, for compaction.
fn compaction_chat(id: &str) -> Value {
    let long = |s: &str| format!("{s} {}", "background detail ".repeat(30));
    json!({
        "id": id, "title": "Long chat", "workspaceId": "w1", "providerId": "p1", "modelId": "synthetic",
        "messages": [
            { "id": "u1", "role": "user", "content": long("First request:"), "createdAt": 1 },
            { "id": "a1", "role": "assistant", "content": long("First answer:"), "createdAt": 2 },
            { "id": "u2", "role": "user", "content": "Second request", "createdAt": 3 },
            { "id": "a2", "role": "assistant", "content": "Second answer", "createdAt": 4 },
            { "id": "u3", "role": "user", "content": "Third request", "createdAt": 5 },
            { "id": "a3", "role": "assistant", "content": "Third answer", "createdAt": 6 },
        ],
        "createdAt": 1, "updatedAt": 1,
    })
}

fn scripted_settings(rig: &TurnRig, model: &ScriptedModel) -> Value {
    json!({
        "providers": [{
            "id": "p1", "kind": "openai-compat", "label": "Scripted", "enabled": true,
            "baseUrl": format!("http://127.0.0.1:{}/v1", model.port),
        }],
        "workspaces": [{ "id": "w1", "name": "project", "path": rig.workspace.to_string_lossy() }],
        "defaultChatMode": "yolo",
    })
}

/// The `compaction` progress the host heard (`turn:notify`), in order.
async fn compaction_progress(port: u16, session_id: &str) -> Vec<Value> {
    let (_, calls) = post(port, "test:completions", json!([]), Some(TOKEN)).await;
    calls
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c[0] == "turn:notify" && c[1][0]["type"] == "compaction" && c[1][0]["sessionId"] == session_id)
        .map(|c| c[1][0]["progress"].clone())
        .collect()
}

async fn wait_progress(port: u16, session_id: &str, state: &str) -> Vec<Value> {
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let all = compaction_progress(port, session_id).await;
            if all.last().is_some_and(|p| p["state"] == state) {
                return all;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("compaction never reached {state}"))
}

#[tokio::test(flavor = "multi_thread")]
async fn the_daemon_compacts_a_chat_and_owns_its_state() {
    let rig = turn_rig("compact", compaction_chat("s_compact"));
    let model = scripted_model(vec![sse(&[json!({
        "choices": [{ "delta": { "content": "  Summary of decisions and next steps.  " }, "finish_reason": "stop" }],
        "usage": { "prompt_tokens": 200, "completion_tokens": 20 }
    })])])
    .await;
    // A second provider for the new-chat case, so settings are written once.
    let model2 = scripted_model(vec![say_text("A fresh summary.")]).await;
    let mut settings = scripted_settings(&rig, &model);
    settings["providers"].as_array_mut().unwrap().push(json!({
        "id": "p2", "kind": "openai-compat", "label": "Second", "enabled": true,
        "baseUrl": format!("http://127.0.0.1:{}/v1", model2.port),
    }));
    std::fs::write(rig.data.join("settings.json"), settings.to_string()).unwrap();
    let (_, info) = post(rig.d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    for c in ["chat:compact", "chat:cancelCompaction", "chat:interruptQueued"] {
        assert!(info["owned"].as_array().unwrap().contains(&json!(c)), "{c} is not owned");
    }
    let original = saved_session(&rig, "s_compact")["messages"].clone();

    // An omitted options argument can cross IPC as null.
    let (status, landed) = post(rig.d.port, "chat:compact", json!(["s_compact", null]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{landed}");
    assert_eq!(landed["id"], "s_compact");
    let messages = saved_session(&rig, "s_compact")["messages"].as_array().unwrap().clone();
    assert_eq!(messages.len(), 7, "nothing is deleted: the summary goes in after what it replaces");
    assert_eq!(json!(messages[..2]), json!(original.as_array().unwrap()[..2]));
    assert_eq!(messages[2]["role"], "assistant");
    assert_eq!(messages[2]["content"], "Summary of decisions and next steps.");
    assert_eq!(messages[2]["compaction"], json!({ "summarized": 2 }));
    assert_eq!(messages[2]["createdAt"], 2);
    assert!(messages[2]["id"].as_str().unwrap().starts_with("compact_"));
    assert_eq!(json!(messages[3..]), json!(original.as_array().unwrap()[2..]));

    // The summary call carried the ported prompt, and only what was summarized.
    let requests = model.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 1);
    let sent = requests[0]["messages"].to_string();
    assert!(sent.contains("Summarize conversation history for the same assistant"), "{sent}");
    assert!(sent.contains("Summarize this transcript segment:\\n\\nUSER: First request:"), "{sent}");
    assert!(!sent.contains("Third request"), "the recent turns stay verbatim: {sent}");

    // Progress from start to done, told to the host, and its usage in the log.
    let progress = wait_progress(rig.d.port, "s_compact", "done").await;
    assert_eq!(progress[0], json!({ "state": "running", "done": 0, "total": 0, "target": "here" }));
    assert_eq!(progress.last().unwrap(), &json!({ "state": "done", "done": 1, "total": 1, "target": "here" }));
    let usage = std::fs::read_to_string(rig.data.join("usage.jsonl")).unwrap();
    let line: Value = serde_json::from_str(usage.lines().next().unwrap()).unwrap();
    assert_eq!((line["providerId"].clone(), line["inputTokens"].clone()), (json!("p1"), json!(200)));
    assert_eq!(line["sessionId"], "s_compact");

    // Nothing new since that summary: refused, the history kept.
    let (status, again) = post(rig.d.port, "chat:compact", json!(["s_compact"]), Some(TOKEN)).await;
    assert_eq!(status, 400, "{again}");
    assert_eq!(again["error"], "Nothing new to compact since the last summary.");

    // To a new chat: this one is left as it was.
    let mut fresh = compaction_chat("s_fresh");
    fresh["providerId"] = json!("p2");
    std::fs::write(rig.data.join("sessions/s_fresh.json"), fresh.to_string()).unwrap();
    let before = saved_session(&rig, "s_fresh")["messages"].clone();
    let (status, next) = post(rig.d.port, "chat:compact", json!(["s_fresh", { "newChat": true }]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{next}");
    let new_id = next["id"].as_str().unwrap().to_string();
    assert_ne!(new_id, "s_fresh");
    assert_eq!(next["title"], "Long chat (continued)");
    assert_eq!(next["workspaceId"], "w1");
    assert_eq!(next["messages"][0]["compaction"], json!({ "summarized": 2 }));
    assert_eq!(saved_session(&rig, &new_id)["messages"], next["messages"]);
    assert_eq!(saved_session(&rig, "s_fresh")["messages"], before);
    let progress = wait_progress(rig.d.port, "s_fresh", "done").await;
    assert_eq!(progress.last().unwrap()["newSessionId"], json!(new_id));
    assert_eq!(progress.last().unwrap()["target"], "new");

    // Refusals, with the host's words.
    std::fs::write(
        rig.data.join("sessions/s_secret.json"),
        json!({ "id": "s_secret", "title": "x", "incognito": true, "providerId": "p1", "modelId": "m", "messages": [{ "id": "u", "role": "user", "content": "hi", "createdAt": 1 }], "createdAt": 1, "updatedAt": 1 }).to_string(),
    )
    .unwrap();
    let (_, refused) = post(rig.d.port, "chat:compact", json!(["s_secret"]), Some(TOKEN)).await;
    assert_eq!(refused["error"], "Incognito conversations cannot be compacted.");
    let (_, calls) = post(rig.d.port, "test:completions", json!([]), Some(TOKEN)).await;
    assert!(!calls.as_array().unwrap().iter().any(|c| c[0] == "chat:compact"), "the host compacted nothing");
}

#[tokio::test(flavor = "multi_thread")]
async fn cancelling_a_compaction_keeps_the_history_and_refuses_turns_meanwhile() {
    let rig = turn_rig("compact-cancel", compaction_chat("s_cancel"));
    let model = scripted_model(vec![HANG.into()]).await;
    std::fs::write(rig.data.join("settings.json"), scripted_settings(&rig, &model).to_string()).unwrap();
    let original = saved_session(&rig, "s_cancel")["messages"].clone();
    let port = rig.d.port;
    let compacting = tokio::spawn(async move { post(port, "chat:compact", json!(["s_cancel"]), Some(TOKEN)).await });
    tokio::time::timeout(Duration::from_secs(10), async {
        while model.requests.lock().unwrap().is_empty() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the summary call started");

    // Admission reads the daemon's own compaction state.
    let opts = json!({ "sessionId": "s_cancel", "providerId": "p1", "modelId": "synthetic", "text": "hello" });
    let (status, _) = post(rig.d.port, "chat:send", json!([opts]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let (_, calls) = post(rig.d.port, "test:completions", json!([]), Some(TOKEN)).await;
    assert!(
        calls.as_array().unwrap().iter().any(|c| c[0] == "turn:notify"
            && c[1][0]["type"] == "error"
            && c[1][0]["message"] == "This chat is being compacted. Wait or move to a new chat."),
        "{calls}"
    );
    let progress = compaction_progress(rig.d.port, "s_cancel").await;
    assert_eq!(progress.last().unwrap()["state"], "running", "{progress:?}");

    let started = Instant::now();
    let (status, _) = post(rig.d.port, "chat:cancelCompaction", json!(["s_cancel"]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let (status, body) = compacting.await.unwrap();
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["error"], "Compaction cancelled.");
    assert!(started.elapsed() < Duration::from_secs(5), "the held call was cut, not waited out");
    let progress = wait_progress(rig.d.port, "s_cancel", "cancelled").await;
    assert_eq!(progress.last().unwrap()["state"], "cancelled");
    assert_eq!(saved_session(&rig, "s_cancel")["messages"], original);
}

#[tokio::test(flavor = "multi_thread")]
async fn interrupting_starts_the_chosen_queued_prompt_and_keeps_the_others() {
    let session = json!({
        "id": "s_jump", "title": "Jump", "workspaceId": "w1", "providerId": "p1", "modelId": "synthetic",
        "messages": [], "createdAt": 1, "updatedAt": 1
    });
    let rig = turn_rig("interrupt", session);
    // The first reply hangs until stopped; the rest answer at once.
    let model = scripted_model(vec![
        HANG.into(),
        say_text("selected answer"),
        say_text("first answer"),
        say_text("last answer"),
    ])
    .await;
    std::fs::write(rig.data.join("settings.json"), scripted_settings(&rig, &model).to_string()).unwrap();

    // Validation, before anything is stopped.
    for bad in [json!(-1), json!(0), json!(1.5), json!("0")] {
        let (status, body) = post(rig.d.port, "chat:interruptQueued", json!(["s_jump", bad]), Some(TOKEN)).await;
        assert_eq!((status, body["error"].clone()), (400, json!("Queued prompt not found.")), "{bad}");
    }

    let port = rig.d.port;
    let opts = json!({ "sessionId": "s_jump", "providerId": "p1", "modelId": "synthetic", "text": "old" });
    let old = tokio::spawn(async move { post(port, "chat:send", json!([opts]), Some(TOKEN)).await });
    tokio::time::timeout(Duration::from_secs(10), async {
        while model.requests.lock().unwrap().is_empty() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the first reply started");
    for text in ["first", "selected", "last"] {
        post(rig.d.port, "chat:queue", json!(["s_jump", text]), Some(TOKEN)).await;
    }
    let (_, refused) = post(
        rig.d.port,
        "chat:interruptQueued",
        json!(["s_jump", 1, { "providerId": "p1", "modelId": "__auto__" }]),
        Some(TOKEN),
    )
    .await;
    assert_eq!(refused["error"], "Choose a provider and model before starting the queued prompt.");

    let (status, body) = post(rig.d.port, "chat:interruptQueued", json!(["s_jump", 1]), Some(TOKEN)).await;
    assert_eq!((status, body.clone()), (200, Value::Null), "{body}");
    let (status, _) = old.await.unwrap();
    assert_eq!(status, 200);
    let saved = saved_session(&rig, "s_jump");
    let users: Vec<&str> = saved["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["role"] == "user")
        .filter_map(|m| m["content"].as_str())
        .collect();
    // The stopped reply, then the selected prompt, then the rest of the queue in order.
    assert_eq!(users, ["old", "selected", "first", "last"], "{saved}");
    assert_eq!(saved["queue"], json!([]));
    let (_, calls) = post(rig.d.port, "test:completions", json!([]), Some(TOKEN)).await;
    let calls = calls.as_array().unwrap();
    assert!(!calls.iter().any(|c| c[0] == "chat:interruptQueued"), "the host started nothing");
    let adopts: Vec<&Value> = calls.iter().filter(|c| c[0] == "turn:adopt").collect();
    assert_eq!(adopts.len(), 4, "{adopts:?}");
    assert_eq!(adopts[1][1][0]["opts"]["text"], "selected");
    assert_eq!(adopts[1][1][0]["chained"], false, "a new chain, which the host adopts as its own");
}

/// The stand-in `sd-server`, built beside this test if `cargo test` did not build examples.
fn fake_sd() -> std::path::PathBuf {
    let exe = format!("fake_sd_server{}", std::env::consts::EXE_SUFFIX);
    let deps = std::env::current_exe().unwrap().parent().unwrap().to_path_buf();
    let path = deps.parent().unwrap().join("examples").join(exe);
    if !path.is_file() {
        let target = deps.parent().unwrap().parent().unwrap();
        let ok = Command::new(env!("CARGO"))
            .args(["build", "-p", "nekkod", "--example", "fake_sd_server"])
            .env("CARGO_TARGET_DIR", target)
            .status()
            .unwrap()
            .success();
        assert!(ok, "the fake sd-server builds");
    }
    path
}

#[tokio::test(flavor = "multi_thread")]
async fn the_daemon_runs_an_image_turn_on_its_model_server() {
    let root = std::env::temp_dir().join(format!("nekkod-image-turn-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let data = root.join("data");
    std::fs::create_dir_all(data.join("sessions")).unwrap();
    // An image model the library reads as one (its architecture), and the stand-in runtime.
    let model = data.join("models/image/acme_sd/tiny-sd.gguf");
    std::fs::create_dir_all(model.parent().unwrap()).unwrap();
    std::fs::write(&model, tiny_gguf("sd1", "Tiny SD")).unwrap();
    let sd_dir = data.join("engine/diffusion");
    std::fs::create_dir_all(&sd_dir).unwrap();
    std::fs::write(
        sd_dir.join("engine.json"),
        json!({ "buildId": "fake", "binPath": fake_sd(), "version": "fake" }).to_string(),
    )
    .unwrap();
    let port = free_port();
    std::fs::write(
        data.join("settings.json"),
        json!({ "engineBinPath": fake_llama(), "engine": { "port": port, "modelFolders": [] } }).to_string(),
    )
    .unwrap();
    let session = json!({ "id": "s_img", "title": "New chat", "messages": [], "createdAt": 1, "updatedAt": 1 });
    std::fs::write(data.join("sessions/s_img.json"), session.to_string()).unwrap();
    let d = start_with_env(true, Some(&data), json!({}), &[]);
    let (_, info) = post(d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    assert!(info["owned"].as_array().unwrap().contains(&json!("chat:generateImage")), "{info}");
    let (_, models) = post(d.port, "engine:models", json!([]), Some(TOKEN)).await;
    let row = models.as_array().unwrap().iter().find(|m| m["modality"] == "image").cloned().expect("an image row");
    let id = row["id"].as_str().unwrap().to_string();
    let mut events = ws(d.port, &format!("/api/events?token={TOKEN}"), Some("null")).await.unwrap();

    let params = json!({ "modelId": id, "width": 512, "height": 768, "steps": 20, "cfgScale": 4.5, "seed": 42 });
    let opts = json!({ "sessionId": "s_img", "prompt": "  a calico cat  ", "params": params });
    let (status, body) = post(d.port, "chat:generateImage", json!([opts]), Some(TOKEN)).await;
    assert_eq!((status, body.clone()), (200, Value::Null), "{body}");
    let saved: Value =
        serde_json::from_str(&std::fs::read_to_string(data.join("sessions/s_img.json")).unwrap()).unwrap();
    assert_eq!(saved["title"], "a calico cat");
    assert_eq!((saved["chatType"].clone(), saved["modelId"].clone()), (json!("image"), json!(id)));
    assert_eq!(saved["imageParams"], params);
    let messages = saved["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0]["content"], "a calico cat");
    let reply = &messages[1];
    let image = reply["images"][0].as_str().unwrap();
    // The stand-in drew the request it was sent: the trimmed prompt with the
    // steps, guidance and seed, and the size (`imageGenerationBody`).
    let drawn = image.strip_prefix("data:image/png;base64,").unwrap();
    let expected = "a calico cat\n<sd_cpp_extra_args>{\"sample_params\":{\"sample_steps\":20,\"guidance\":{\"txt_cfg\":4.5}},\"seed\":42}</sd_cpp_extra_args>|512x768";
    assert_eq!(drawn, fake_base64(expected.as_bytes()), "{reply}");
    assert_eq!(reply["generated"]["seed"], 42);
    assert_eq!(reply["generated"]["modelId"], json!(id));

    // The stages, then done: loading (the model was cold), generating.
    let mut stages = Vec::new();
    while let Some(ev) = next_json(&mut events, Duration::from_secs(2)).await {
        let p = &ev["payload"];
        if ev["channel"] == "agent:event" && p["sessionId"] == "s_img" {
            stages.push(format!("{}:{}", p["type"].as_str().unwrap(), p["label"].as_str().unwrap_or("")));
            if p["type"] == "done" {
                break;
            }
        }
    }
    assert_eq!(
        stages,
        [
            "image_status:Generating a 512×768 image",
            "image_status:Loading the image model",
            "image_status:Generating a 512×768 image",
            "done:",
        ],
        "{stages:?}"
    );

    // A seed of -1 records the one used; a stop while it draws ends the turn as stopped.
    let port2 = d.port;
    let slow = json!({ "sessionId": "s_img", "prompt": "slow fox", "params": { "modelId": id, "width": 256, "height": 256, "steps": 1, "cfgScale": 1, "seed": -1 } });
    let running = tokio::spawn(async move { post(port2, "chat:generateImage", json!([slow]), Some(TOKEN)).await });
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let (_, running) = post(port2, "chat:running", json!([]), Some(TOKEN)).await;
            if running.as_array().is_some_and(|r| r.contains(&json!("s_img"))) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the image turn is listed as running");
    let started = Instant::now();
    post(d.port, "chat:abort", json!(["s_img"]), Some(TOKEN)).await;
    let (status, _) = running.await.unwrap();
    assert_eq!(status, 200);
    assert!(started.elapsed() < Duration::from_secs(5));
    let saved: Value =
        serde_json::from_str(&std::fs::read_to_string(data.join("sessions/s_img.json")).unwrap()).unwrap();
    let last = saved["messages"].as_array().unwrap().last().unwrap().clone();
    assert_eq!(
        (last["content"].clone(), last["interrupted"].clone()),
        (json!("Stopped before the image finished."), json!(true))
    );
    let seed = saved["imageParams"]["seed"].clone();
    assert_eq!(seed, -1, "the chat keeps asking for a fresh seed");

    // A missing prompt is refused with the host's words; the host ran none of it.
    let (_, _) = post(
        d.port,
        "chat:generateImage",
        json!([{ "sessionId": "s_img", "prompt": " ", "params": params }]),
        Some(TOKEN),
    )
    .await;
    let (_, calls) = post(d.port, "test:completions", json!([]), Some(TOKEN)).await;
    let calls = calls.as_array().unwrap();
    assert!(
        calls.iter().any(|c| c[0] == "turn:notify" && c[1][0]["message"] == "Describe the image you want first."),
        "{calls:?}"
    );
    assert!(!calls.iter().any(|c| c[0] == "chat:generateImage"), "the host generated nothing");
    post(d.port, "engine:stop", json!([]), Some(TOKEN)).await;
    drop(d);
    std::fs::remove_dir_all(root).ok();
}

fn fake_base64(bytes: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        for i in 0..4 {
            out.push(if i <= chunk.len() { T[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    out
}

/* --------------------------------------------- sandbox turns (PF14 A2, 2/2) */

/// The sandbox chat's turn is admitted and refused by the daemon itself; no
/// Docker needed for these.
#[tokio::test(flavor = "multi_thread")]
async fn the_daemon_admits_sandbox_chats_and_refuses_what_they_cannot_do() {
    let session = json!({
        "id": "s_boxed", "title": "Box", "workspaceId": "w1", "executionMode": "sandbox", "gitIsolation": false,
        "mode": "ask", "messages": [], "createdAt": 1, "updatedAt": 1
    });
    let rig = turn_rig("sandbox-admit", session);
    let model = scripted_model(vec![say_text("unused")]).await;
    std::fs::write(rig.data.join("settings.json"), scripted_settings(&rig, &model).to_string()).unwrap();
    // Not set up yet: refused with the host's words, nothing handed to the host.
    let opts = json!({ "sessionId": "s_boxed", "providerId": "p1", "modelId": "synthetic", "text": "hello" });
    let (status, _) = post(rig.d.port, "chat:send", json!([opts]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let refused = |c: &Value| {
        c[0] == "turn:notify"
            && c[1][0]["message"] == "Sandbox requires explicit setup and supports text chat without host skills only."
    };
    let port = rig.d.port;
    let calls = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let (_, calls) = post(port, "test:completions", json!([]), Some(TOKEN)).await;
            if calls.as_array().unwrap().iter().any(refused) {
                return calls;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("the refusal reached the host's listeners");
    let calls = calls.as_array().unwrap();
    assert!(!calls.iter().any(|c| c[0] == "chat:send"), "the daemon kept it");
    assert!(model.requests.lock().unwrap().is_empty(), "no model call");
}

/// A sandbox chat's whole turn in the daemon against a real Docker engine
/// (opt-in: `NEKKO_SANDBOX_TEST_IMAGE` names a locally installed,
/// digest-pinned Linux image with python3): admitted here, its tools asked
/// for and run in the container the daemon owns, a host tool refused without
/// asking, the host folder untouched, and Stop during a command.
#[tokio::test(flavor = "multi_thread")]
async fn a_sandbox_chat_turn_runs_in_the_daemon_and_its_container() {
    let Ok(image) = std::env::var("NEKKO_SANDBOX_TEST_IMAGE") else { return };
    let session = json!({ "id": "s_boxturn", "title": "Box", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1 });
    let rig = turn_rig("sandbox-turn", session);
    let model = scripted_model(vec![
        call_tool("c1", "read_file", json!({ "path": "folder-0/app.ts" })),
        call_tool("c2", "bash", json!({ "command": "printf hi > folder-0/new.txt; id -u" })),
        call_tool("c3", "fetch_url", json!({ "url": "https://example.com" })),
        say_text("done in the box"),
        call_tool("c4", "bash", json!({ "command": "sleep 30" })),
        say_text("(after stop)"),
    ])
    .await;
    std::fs::write(rig.data.join("settings.json"), scripted_settings(&rig, &model).to_string()).unwrap();
    let (status, configured) = post(rig.d.port, "sandbox:configure", json!(["s_boxturn", image]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{configured}");
    assert_eq!(configured["phase"], "ready", "{configured}");
    let identity = configured["identity"].clone();

    let checks = std::panic::AssertUnwindSafe(async {
        let port = rig.d.port;
        let opts =
            json!({ "sessionId": "s_boxturn", "providerId": "p1", "modelId": "synthetic", "text": "look in the box" });
        let send = tokio::spawn(async move { post(port, "chat:send", json!([opts]), Some(TOKEN)).await });
        // Every container call asks first (a sandbox chat is in ask mode), here in the daemon.
        for (call, reason, severity) in [
            ("c1", "Sandbox read_file: access only the copied workspace", "low"),
            ("c2", "Sandbox bash: access only the copied workspace", "high"),
        ] {
            let pending = wait_pending(port, "s_boxturn", "approval", call).await;
            assert_eq!((pending["reason"].clone(), pending["severity"].clone()), (json!(reason), json!(severity)));
            post(port, "tool:approve", json!(["s_boxturn", call, true]), Some(TOKEN)).await;
        }
        let (status, _) = send.await.unwrap();
        assert_eq!(status, 200);
        let saved = saved_session(&rig, "s_boxturn");
        let results: Vec<Value> =
            saved["messages"].as_array().unwrap().iter().filter_map(|m| m.get("toolResult").cloned()).collect();
        assert!(results[0]["output"].as_str().unwrap().contains("pineapple"), "{results:?}");
        let shell: Value = serde_json::from_str(results[1]["output"].as_str().unwrap()).unwrap();
        assert_eq!(shell["stdout"].as_str().unwrap().trim(), "1000", "{results:?}");
        assert_eq!(results[2]["isError"], true);
        assert!(results[2]["output"].as_str().unwrap().contains("No host fallback"), "{results:?}");
        assert_eq!(saved["messages"].as_array().unwrap().last().unwrap()["content"], "done in the box");
        assert!(!rig.workspace.join("new.txt").exists(), "the host folder is untouched");
        let (_, diff) = post(port, "sandbox:diff", json!(["s_boxturn"]), Some(TOKEN)).await;
        assert_eq!(diff["changes"][0]["path"], "folder-0/new.txt", "{diff}");

        // The model saw only the container's tools and folders, and no host context.
        let requests = model.requests.lock().unwrap().clone();
        let tools: Vec<String> = requests[0]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["function"]["name"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(tools, ["read_file", "write_file", "edit_file", "glob", "grep", "list_dir", "bash"]);
        let system = requests[0]["messages"][0]["content"].as_str().unwrap().to_string();
        assert!(system.contains("folder-0"), "{system}");
        assert!(!system.contains(&*rig.workspace.to_string_lossy()), "no host path: {system}");
        assert!(!system.contains("Always run the tests."), "no host guidelines: {system}");
        assert!(system.contains("isolated container on copied folders"), "{system}");

        // Stop during a command stops the container, at once.
        let opts = json!({ "sessionId": "s_boxturn", "providerId": "p1", "modelId": "synthetic", "text": "wait" });
        let send = tokio::spawn(async move { post(port, "chat:send", json!([opts]), Some(TOKEN)).await });
        wait_pending(port, "s_boxturn", "approval", "c4").await;
        post(port, "tool:approve", json!(["s_boxturn", "c4", true]), Some(TOKEN)).await;
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let started = Instant::now();
        post(port, "chat:abort", json!(["s_boxturn"]), Some(TOKEN)).await;
        let (status, _) = send.await.unwrap();
        assert_eq!(status, 200);
        assert!(started.elapsed() < Duration::from_secs(10), "stopped in {:?}", started.elapsed());
        let (_, status) = post(port, "sandbox:status", json!(["s_boxturn"]), Some(TOKEN)).await;
        assert_eq!(
            status["error"], "Sandbox stopped by cancellation. Create a new sandbox chat to resume.",
            "{status}"
        );

        // Nothing went through the host's container route or its own turn.
        let (_, calls) = post(port, "test:completions", json!([]), Some(TOKEN)).await;
        let calls = calls.as_array().unwrap();
        assert!(!calls.iter().any(|c| c[0] == "chat:send" || c[0] == "turn:tool"), "{calls:?}");
        let adopt = calls.iter().find(|c| c[0] == "turn:adopt").expect("the host was handed the turn");
        assert_eq!(adopt[1][0]["mode"], "ask");
        assert_eq!(adopt[1][0]["workspaces"][0]["path"], "folder-0");
    });
    let outcome = futures_util::FutureExt::catch_unwind(checks).await;
    let (status, _) = post(rig.d.port, "sandbox:cleanup", json!(["s_boxturn", identity]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}

fn git_in(dir: &std::path::Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@example.com",
            "-c",
            "init.defaultBranch=main",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .current_dir(dir)
        .output()
        .expect("git runs");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// A loopback GitHub REST API with the pull and stack endpoints, recording what it was sent.
async fn fake_github_stacks(pulls: Value) -> (u16, std::sync::Arc<std::sync::Mutex<Vec<Value>>>) {
    use axum::extract::{Path as AxPath, RawQuery};
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let (log_get, log_post) = (seen.clone(), seen.clone());
    let app = axum::Router::new().route(
        "/repos/{owner}/{repo}/{*rest}",
        axum::routing::get(move |AxPath((o, r, rest)): AxPath<(String, String, String)>, RawQuery(q): RawQuery| {
            let (log, pulls) = (log_get.clone(), pulls.clone());
            async move {
                let path = format!("repos/{o}/{r}/{rest}{}", q.map(|q| format!("?{q}")).unwrap_or_default());
                log.lock().unwrap().push(json!(["GET", path]));
                match pulls.get(&path) {
                    Some(v) => (axum::http::StatusCode::OK, axum::Json(v.clone())),
                    None => (axum::http::StatusCode::NOT_FOUND, axum::Json(json!({ "message": "Not Found" }))),
                }
            }
        })
        .post(move |AxPath((o, r, rest)): AxPath<(String, String, String)>, body: axum::Json<Value>| {
            let log = log_post.clone();
            async move {
                log.lock().unwrap().push(json!(["POST", format!("repos/{o}/{r}/{rest}"), body.0]));
                (axum::http::StatusCode::CREATED, axum::Json(json!({ "number": 3 })))
            }
        }),
    );
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    (port, seen)
}

#[tokio::test(flavor = "multi_thread")]
async fn continues_and_links_pr_stacks_itself() {
    let data = std::env::temp_dir().join(format!("nekkod-stacks-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    // The parent PR's repository on GitHub, and the user's clone of it.
    let origin = data.join("origin.git");
    let clone = data.join("clone");
    std::fs::create_dir_all(&clone).unwrap();
    git_in(&data, &["init", "-q", "--bare", origin.to_str().unwrap()]);
    git_in(&clone, &["init", "-q"]);
    std::fs::write(clone.join("a.txt"), "a").unwrap();
    git_in(&clone, &["add", "."]);
    git_in(&clone, &["commit", "-q", "-m", "one"]);
    git_in(&clone, &["checkout", "-q", "-b", "parent"]);
    std::fs::write(clone.join("b.txt"), "b").unwrap();
    git_in(&clone, &["add", "."]);
    git_in(&clone, &["commit", "-q", "-m", "parent work"]);
    let sha = git_in(&clone, &["rev-parse", "HEAD"]);
    git_in(&clone, &["push", "-q", origin.to_str().unwrap(), "parent"]);
    git_in(&clone, &["checkout", "-q", "main"]);
    // A GitHub remote. Its fetch cannot be pointed at the bare repository
    // without changing what `remote get-url` prints (an `insteadOf` rewrite
    // applies to both), so the daemon's git may only use local transports:
    // the fetch fails at once, never touching the network, and the follow-up
    // half runs from a chat set up as continuing would have left it. The
    // successful fetch is covered by the golden replay (tests/stacks.rs).
    git_in(&clone, &["remote", "add", "origin", "https://github.com/owner/repo.git"]);

    let pr = |n: u64, head: &str, base: &str, sha: &str| {
        json!({
            "number": n, "state": "open", "title": format!("PR {n}"),
            "head": { "ref": head, "sha": sha, "repo": { "full_name": "owner/repo" } },
            "base": { "ref": base, "repo": { "full_name": "owner/repo" } },
        })
    };
    let (gh, seen) = fake_github_stacks(json!({
        "repos/owner/repo/pulls/12": pr(12, "parent", "main", &sha),
        "repos/owner/repo/pulls/13": pr(13, "nekko/child", "parent", &"b".repeat(40)),
        "repos/owner/repo/stacks?pull_request=12": [],
    }))
    .await;
    std::fs::create_dir_all(data.join("sessions")).unwrap();
    let source = json!({ "id": "s_src", "title": "Source", "workspaceId": "w1", "executionMode": "worktree", "gitIsolation": true,
        "providerId": "p", "modelId": "m", "mode": "ask", "disabledTools": ["browser"], "messages": [], "createdAt": 1, "updatedAt": 1 });
    std::fs::write(data.join("sessions/s_src.json"), source.to_string()).unwrap();
    let d = start_with_env(
        true,
        Some(&data),
        json!({ "githubApiUrl": format!("http://127.0.0.1:{gh}") }),
        &[
            ("NEKKO_GH_PATH", Some("nekko-no-such-gh")),
            ("GIT_ALLOW_PROTOCOL", Some("file")),
            ("GIT_TERMINAL_PROMPT", Some("0")),
        ],
    );
    let ws = json!([{ "id": "w1", "name": "clone", "path": clone, "addedAt": 1 }]);
    post(d.port, "settings:update", json!([{ "workspaces": ws }]), Some(TOKEN)).await;

    // Refusals come before any network or git work.
    let (status, bad) =
        post(d.port, "pr:continueStack", json!(["s_src", "https://gitlab.com/o/r/pull/1"]), Some(TOKEN)).await;
    assert_eq!((status, bad), (400, json!({ "error": "Use a GitHub PR URL." })));

    let url = "https://github.com/owner/repo/pull/12";
    // The PR read, the remote matched in the real clone and the branch name
    // checked; then the fetch, refused (local transports only): no chat made.
    let (status, made) = post(d.port, "pr:continueStack", json!(["s_src", url]), Some(TOKEN)).await;
    assert_eq!(
        (status, made),
        (
            400,
            json!({ "error": "Could not fetch the parent PR. Check Git authentication and repository access, then retry." })
        )
    );
    assert!(seen.lock().unwrap().contains(&json!(["GET", "repos/owner/repo/pulls/12"])));
    assert_eq!(std::fs::read_dir(data.join("sessions")).unwrap().count(), 1, "no follow-up chat");
    let _ = (&origin, &sha);

    // The dependent chat as continuing leaves it, once its worktree exists,
    // links its PR as a new stack.
    git_in(&clone, &["checkout", "-q", "-b", "nekko/child"]);
    let id = "s_dep";
    let dependent = json!({ "id": id, "title": "Follow-up to PR #12", "titleAuto": false, "workspaceId": "w1", "executionMode": "worktree",
        "gitIsolation": true, "gitStackParent": { "workspaceId": "w1", "url": url, "branch": "parent", "sha": sha },
        "gitWorktrees": { "w1": { "path": clone, "branch": "nekko/child" } }, "messages": [], "createdAt": 1, "updatedAt": 1 });
    std::fs::write(data.join(format!("sessions/{id}.json")), dependent.to_string()).unwrap();
    let (status, linked) =
        post(d.port, "pr:linkStack", json!([id, "https://github.com/owner/repo/pull/13"]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    assert_eq!(linked["ok"], json!(true), "{linked}");
    assert_eq!(linked["message"], "Linked as a GitHub PR stack.");
    assert!(
        seen.lock()
            .unwrap()
            .iter()
            .any(|c| c == &json!(["POST", "repos/owner/repo/stacks", { "pull_requests": [12, 13] }])),
        "{:?}",
        seen.lock().unwrap()
    );
    // A failure is an answer, not an error.
    let (status, refused) =
        post(d.port, "pr:linkStack", json!(["s_src", "https://github.com/owner/repo/pull/13"]), Some(TOKEN)).await;
    assert_eq!(
        (status, refused),
        (200, json!({ "ok": false, "message": "This chat was not started from a parent PR." }))
    );

    let (_, info) = post(d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    for c in [
        "pr:continueStack",
        "pr:linkStack",
        "data:wipe",
        "app:info",
        "updates:check",
        "workspace:add",
        "session:watches",
    ] {
        assert!(info["owned"].as_array().unwrap().contains(&json!(c)), "{c} not owned");
    }
    let (_, calls) = post(d.port, "test:completions", json!([]), Some(TOKEN)).await;
    assert!(!calls.to_string().contains("continueStack"), "the host ran nothing: {calls}");
    drop(d);
    let _ = std::fs::remove_dir_all(&data);
}

#[tokio::test(flavor = "multi_thread")]
async fn wipes_the_data_it_owns_and_answers_the_small_services() {
    let data = std::env::temp_dir().join(format!("nekkod-wipe-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    for (p, text) in [
        ("sessions/s_a.json", json!({ "id": "s_a", "title": "A", "messages": [], "createdAt": 1, "updatedAt": 1 }).to_string()),
        ("memory/m.md", "note".into()),
        ("usage.jsonl", "{}\n".into()),
        ("replies.jsonl", "{}\n".into()),
        ("tokens.json", "{}".into()),
        (
            "agent-watches.json",
            json!([{ "id": "w1", "sessionId": "s_a", "kind": "timer", "prompt": "secret", "nextPollAt": 4102444800000_u64, "intervalMs": 60000,
                     "deadlineAt": 4102444800000_u64, "status": "active", "failures": 0 }])
            .to_string(),
        ),
    ] {
        std::fs::create_dir_all(data.join(p).parent().unwrap()).unwrap();
        std::fs::write(data.join(p), text).unwrap();
    }
    let d = start_with_config(true, Some(&data), json!({ "appVersion": "9.8.7", "edition": "desktop" }));
    post(d.port, "settings:update", json!([{ "theme": "light" }]), Some(TOKEN)).await;

    // session:watches: what the transcript shows, never the prompt.
    let (_, views) = post(d.port, "session:watches", json!(["s_a"]), Some(TOKEN)).await;
    assert_eq!(
        views,
        json!([{ "id": "w1", "kind": "timer", "status": "active", "deadlineAt": 4102444800000_u64, "nextPollAt": 4102444800000_u64, "pending": false, "failures": 0 }])
    );

    let (_, info) = post(d.port, "app:info", json!([]), Some(TOKEN)).await;
    assert_eq!(info["version"], "9.8.7");
    assert_eq!(info["edition"], "desktop");
    // No bridge here: headless, `workspace:add` lists the saved folders.
    let (_, listed) = post(d.port, "workspace:add", json!([]), Some(TOKEN)).await;
    assert_eq!(listed, json!([]));
    let (status, _) = post(d.port, "updates:check", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 200);

    let (status, next) = post(d.port, "data:wipe", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{next}");
    assert_eq!(next["theme"], json!("system"), "the defaults come back");
    assert!(!data.join("sessions/s_a.json").exists());
    assert!(!data.join("memory/m.md").exists() && data.join("memory").is_dir());
    assert!(!data.join("usage.jsonl").exists() && !data.join("replies.jsonl").exists());
    assert!(data.join("tokens.json").exists(), "sign-ins are not part of a wipe");
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(data.join("settings.json")).unwrap()).unwrap();
    assert_eq!(saved["theme"], json!("system"));
    let (_, calls) = post(d.port, "test:completions", json!([]), Some(TOKEN)).await;
    let calls = calls.as_array().unwrap();
    assert!(calls.iter().any(|c| c == &json!(["s_a"])), "the chat's command log went first: {calls:?}");
    assert!(
        calls.iter().any(|c| c[0] == "settings:changed" && c[1][1].is_null()),
        "the host heard the reset: {calls:?}"
    );
    drop(d);
    let _ = std::fs::remove_dir_all(&data);
}

#[tokio::test(flavor = "multi_thread")]
async fn adds_a_folder_from_the_desktop_picker_through_the_bridge() {
    let data = std::env::temp_dir().join(format!("nekkod-picker-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    let picked = data.join("picked");
    std::fs::create_dir_all(&picked).unwrap();
    let answer = std::sync::Arc::new(std::sync::Mutex::new(json!({ "path": picked })));
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<(Option<String>, Value)>::new()));
    let (a, s) = (answer.clone(), seen.clone());
    let app = axum::Router::new().route(
        "/",
        axum::routing::post(move |headers: axum::http::HeaderMap, body: axum::Json<Value>| {
            let (a, s) = (a.clone(), s.clone());
            async move {
                let auth = headers.get("authorization").and_then(|v| v.to_str().ok()).map(str::to_string);
                s.lock().unwrap().push((auth, body.0));
                axum::Json(a.lock().unwrap().clone())
            }
        }),
    );
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let bridge = format!("http://127.0.0.1:{}/", l.local_addr().unwrap().port());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    let d =
        start_with_config(true, Some(&data), json!({ "browserBridge": { "url": bridge, "token": "bridge-token" } }));

    let (status, added) = post(d.port, "workspace:add", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{added}");
    assert_eq!(added[0]["path"], json!(picked));
    assert_eq!(added[0]["name"], "picked");
    assert_eq!(seen.lock().unwrap()[0], (Some("Bearer bridge-token".into()), json!({ "tool": "pickFolder" })));
    // Cancelled: the saved folders, unchanged.
    *answer.lock().unwrap() = json!({ "path": null });
    let (_, again) = post(d.port, "workspace:add", json!([]), Some(TOKEN)).await;
    assert_eq!(again, added);
    drop(d);
    let _ = std::fs::remove_dir_all(&data);
}

/// A loopback stand-in for Telegram's Bot API: records every call (method
/// and body; the token is in the path), answers `getMe` and `sendMessage`,
/// and holds `getUpdates` until the test queues updates (or 25 s pass, as
/// Telegram's long poll does). Never a real bot or token.
struct FakeTelegram {
    port: u16,
    calls: std::sync::Arc<std::sync::Mutex<Vec<(String, String, Value)>>>,
    updates: tokio::sync::mpsc::UnboundedSender<Value>,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for FakeTelegram {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl FakeTelegram {
    fn calls(&self, method: &str) -> Vec<Value> {
        self.calls.lock().unwrap().iter().filter(|c| c.1 == method).map(|c| c.2.clone()).collect()
    }

    fn polls_since(&self, n: usize) -> usize {
        self.calls.lock().unwrap().iter().filter(|c| c.1 == "getUpdates").count().saturating_sub(n)
    }
}

async fn fake_telegram() -> FakeTelegram {
    use axum::extract::Path;
    use axum::routing::post as route_post;
    let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let (updates, rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
    let rx = std::sync::Arc::new(tokio::sync::Mutex::new(rx));
    let next_id = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(500));
    let seen = calls.clone();
    let app = axum::Router::new().route(
        "/{bot}/{method}",
        route_post(move |Path((bot, method)): Path<(String, String)>, body: String| {
            let (seen, rx, next_id) = (seen.clone(), rx.clone(), next_id.clone());
            async move {
                let body: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
                seen.lock().unwrap().push((bot.clone(), method.clone(), body.clone()));
                let result = match method.as_str() {
                    "getMe" => json!({ "id": 7, "is_bot": true, "username": "nekko_test_bot" }),
                    "sendMessage" => {
                        let id = next_id.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        json!({ "message_id": id, "chat": { "id": body["chat_id"], "type": "private" } })
                    }
                    "getUpdates" => {
                        let mut rx = rx.lock().await;
                        match tokio::time::timeout(Duration::from_secs(25), rx.recv()).await {
                            Ok(Some(batch)) => batch,
                            _ => json!([]),
                        }
                    }
                    _ => json!(true),
                };
                axum::Json(json!({ "ok": true, "result": result }))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    FakeTelegram { port, calls, updates, server }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_daemon_runs_the_telegram_bridge() {
    let tg = fake_telegram().await;
    let model = scripted_model(vec![say_text("Hello from the daemon")]).await;
    let data = std::env::temp_dir().join(format!("nekkod-messaging-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(data.join("sessions")).unwrap();
    // The chat this Telegram chat is already bound to: no worktree, so no git.
    let session = json!({
        "id": "s_tg", "title": "From Telegram", "executionMode": "local", "messages": [], "createdAt": 1, "updatedAt": 1
    });
    std::fs::write(data.join("sessions/s_tg.json"), session.to_string()).unwrap();
    std::fs::write(data.join("messaging-state.json"), r#"{"offset":40,"bindings":{"42":"s_tg"}}"#).unwrap();
    let provider = json!({
        "id": "p1", "kind": "openai-compat", "label": "Scripted", "enabled": true,
        "baseUrl": format!("http://127.0.0.1:{}/v1", model.port),
    });
    let settings = json!({
        "providers": [provider], "defaultProviderId": "p1", "defaultModelId": "synthetic", "defaultChatMode": "yolo",
        "messaging": { "telegram": { "enabled": true, "botToken": "123:TEST", "allowedChatIds": ["42"] } },
    });
    std::fs::write(data.join("settings.json"), settings.to_string()).unwrap();
    let d = start_with_config(true, Some(&data), json!({ "telegramApiUrl": format!("http://127.0.0.1:{}", tg.port) }));

    let (_, info) = post(d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    assert!(info["owned"].as_array().unwrap().contains(&json!("messaging:status")), "{info}");
    wait_for("the first long poll", || tg.polls_since(0) >= 1).await;
    let first = &tg.calls("getUpdates")[0];
    assert_eq!(first["offset"], 40, "the poll resumes from the saved offset");
    assert_eq!(first["timeout"], 25);
    assert!(tg.calls.lock().unwrap().iter().all(|c| c.0 == "bot123:TEST"), "every call uses the bot token");
    let status = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let (_, s) = post(d.port, "messaging:status", json!([]), Some(TOKEN)).await;
            if s["telegram"]["botUsername"].is_string() {
                return s;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("getMe answered");
    assert_eq!(status, json!({ "telegram": { "running": true, "botUsername": "nekko_test_bot", "boundChats": 1 } }));

    // An unlisted chat is refused and starts nothing; the allowed one starts a turn.
    tg.updates
        .send(json!([
            { "update_id": 41, "message": { "message_id": 1, "chat": { "id": 99, "type": "private" }, "text": "let me in" } },
            { "update_id": 42, "message": { "message_id": 2, "chat": { "id": 42, "type": "private" }, "text": "  say hello  " } },
        ]))
        .unwrap();
    wait_for("the refusal", || {
        tg.calls("sendMessage")
            .iter()
            .any(|b| b["chat_id"] == "99" && b["text"].as_str().unwrap().contains("allowlist"))
    })
    .await;
    // The streamed reply lands in one message: sent, then edited to the final text.
    wait_for("the reply", || {
        tg.calls("editMessageText").iter().any(|b| b["chat_id"] == "42" && b["text"] == "Hello from the daemon")
            || tg.calls("sendMessage").iter().any(|b| b["chat_id"] == "42" && b["text"] == "Hello from the daemon")
    })
    .await;
    let to_42: Vec<Value> = tg.calls("sendMessage").into_iter().filter(|b| b["chat_id"] == "42").collect();
    assert_eq!(to_42.len(), 1, "one message for the whole reply: {to_42:?}");
    let saved: Value =
        serde_json::from_str(&std::fs::read_to_string(data.join("sessions/s_tg.json")).unwrap()).unwrap();
    let messages = saved["messages"].as_array().unwrap();
    assert_eq!(messages.first().unwrap()["content"], "say hello");
    assert_eq!(messages.last().unwrap()["content"], "Hello from the daemon");
    // Admitted and driven by the daemon: the host was handed the turn, never asked to send it.
    let (_, calls) = post(d.port, "test:completions", json!([]), Some(TOKEN)).await;
    let calls = calls.as_array().unwrap();
    assert!(calls.iter().any(|c| c[0] == "turn:adopt"), "{calls:?}");
    assert!(!calls.iter().any(|c| c[0] == "chat:send"), "{calls:?}");
    assert_eq!(model.requests.lock().unwrap()[0]["model"], "synthetic");
    // The offset moved past both updates, and no session was made for chat 99.
    wait_for("the offset saved", || {
        std::fs::read_to_string(data.join("messaging-state.json")).is_ok_and(|t| t.contains("\"offset\": 43"))
    })
    .await;
    let state: Value =
        serde_json::from_str(&std::fs::read_to_string(data.join("messaging-state.json")).unwrap()).unwrap();
    assert_eq!(state["bindings"], json!({ "42": "s_tg" }));

    // Disabling stops the poll at once and the status goes empty.
    let polls = tg.polls_since(0);
    let off =
        json!({ "messaging": { "telegram": { "enabled": false, "botToken": "123:TEST", "allowedChatIds": ["42"] } } });
    let (status, _) = post(d.port, "settings:update", json!([off]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let (_, s) = post(d.port, "messaging:status", json!([]), Some(TOKEN)).await;
            if s == json!({}) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("the bridge stopped");
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(tg.polls_since(polls), 0, "no poll after disabling");
    // A message sent meanwhile is not read.
    tg.updates
        .send(json!([{ "update_id": 43, "message": { "message_id": 3, "chat": { "id": 42, "type": "private" }, "text": "anyone?" } }]))
        .unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(model.requests.lock().unwrap().len(), 1, "no turn while off");
    // The backend never ran a bridge of its own.
    assert!(!calls.iter().any(|c| c[0] == "messaging:status"));
    drop(d);
    std::fs::remove_dir_all(&data).ok();
}
