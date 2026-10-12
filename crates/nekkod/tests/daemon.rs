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
                // Title calls are answered by content, so their timing never shifts the script.
                let titling = request["messages"].as_array().is_some_and(|m| {
                    m.iter()
                        .any(|m| m["content"].as_str().is_some_and(|c| c.starts_with("Give this task a short title")))
                });
                seen.lock().unwrap().push(request);
                let next = if titling {
                    say_text("\"Login bug fix.\"")
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
    let model = scripted_model(vec![say_text("first answer"), say_text("second answer")]).await;
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

    // A daemon channel, a channel the host serves, and an internal callback a phone may not call.
    agent.send(client("c1", json!({ "type": "req", "id": 2, "channel": "remote:devices", "args": [] }))).await.unwrap();
    let (_, res) = next_agent_frame(&mut agent, &key).await;
    assert_eq!(res.unwrap()["result"][0]["id"], "phone-1");
    agent.send(client("c1", json!({ "type": "req", "id": 3, "channel": "training:list", "args": [] }))).await.unwrap();
    let (_, res) = next_agent_frame(&mut agent, &key).await;
    assert_eq!(res.unwrap()["result"], json!({ "echo": "training:list", "args": [] }));
    agent.send(client("c1", json!({ "type": "req", "id": 4, "channel": "turn:pending", "args": [] }))).await.unwrap();
    let (_, res) = next_agent_frame(&mut agent, &key).await;
    assert_eq!(res.unwrap()["error"], "Unknown channel: turn:pending");

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
