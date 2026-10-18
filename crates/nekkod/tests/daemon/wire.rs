//! The real `nekkod` binary end to end: the wire itself: forwarding to the TS backend, auth and origins, the RPC and terminal sockets, body limits, and exiting with stdin.

use crate::common::*;

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
    // Other calls are capped at 25 MiB, the Local Web UI's public limit (wire.rs).
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
    let child = std::sync::Mutex::new(&mut d.child);
    let status = until("nekkod to exit after its stdin closed", Duration::from_secs(15), || async {
        child.lock().unwrap().try_wait().unwrap()
    })
    .await;
    assert!(status.success(), "nekkod exited with {status}");
}
