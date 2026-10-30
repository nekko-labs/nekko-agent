//! The real `nekkod` binary end to end: the wire itself: routing, auth and origins, the RPC and terminal sockets, body limits, and exiting with stdin.

use crate::common::*;

#[tokio::test(flavor = "multi_thread")]
async fn refuses_unknown_channels_and_serves_owned_ones() {
    let d = start();
    let (status, body) = post(d.port, "sessions:list", json!([]), Some(TOKEN)).await;
    assert_eq!((status, body), (200, json!([])));
    let (status, body) = post(d.port, "fail:please", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 400);
    assert_eq!(body["error"], "unknown channel fail:please");

    let (status, info) = post(d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    assert_eq!(info["app"], "nekkod");
    assert!(info.get("backend").is_none(), "{info}");

    // No chats, so no agent command logs, and no terminals yet.
    let (_, list) = post(d.port, "terminals:list", json!([]), Some(TOKEN)).await;
    assert_eq!(list, json!([]));

    // Decision models are the daemon's, never forwarded; with none loaded they say so.
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
    let d = start();
    // A chat id no chat can have stops the turn before anything runs. That
    // 400 proves the complete >2 MiB JSON body reached the turn route.
    let image = format!("data:image/png;base64,{}", "A".repeat(2 * 1024 * 1024));
    let args = json!([{ "turnId": "large-http", "opts": { "sessionId": "no such chat", "text": "image", "images": [image] } }]);
    let (status, body) = post(d.port, "chat:turn", args.clone(), Some(TOKEN)).await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["error"], "Session not found.", "{body}");

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
    let d = start();
    let (status, _) = post(d.port, "daemon:info", json!([]), None).await;
    assert_eq!(status, 401);
    let (status, _) = post(d.port, "daemon:info", json!([]), Some("wrong-token-0123456789")).await;
    assert_eq!(status, 401);
    assert!(ws(d.port, &format!("/api/ws?token={TOKEN}"), Some("https://evil.example")).await.is_err());
    assert!(ws(d.port, "/api/ws?token=nope", Some("null")).await.is_err());
    assert!(ws(d.port, &format!("/api/ws?token={TOKEN}"), Some("null")).await.is_ok());
}

#[tokio::test(flavor = "multi_thread")]
async fn rpc_socket_carries_replies_and_events() {
    let d = start();
    let mut sock = ws(d.port, &format!("/api/ws?token={TOKEN}"), Some("null")).await.unwrap();
    sock.send(Message::Text(
        json!({ "id": 7, "channel": "terminal:create", "args": [echo_shell("rpc")] }).to_string().into(),
    ))
    .await
    .unwrap();
    let mut terminal = None;
    let mut got_event = false;
    let deadline = Instant::now() + Duration::from_secs(30);
    while !got_event && Instant::now() < deadline {
        let Some(v) = next_json(&mut sock, Duration::from_secs(30)).await else { break };
        if v["id"] == 7 {
            let id = v["result"]["id"].as_str().expect("a terminal id").to_string();
            // Closing it publishes its exit, which the socket hears.
            post(d.port, "terminal:close", json!([id]), Some(TOKEN)).await;
            terminal = Some(id);
        } else if v["channel"] == "terminal:event" && v["payload"]["type"] == "exit" {
            assert_eq!(v["payload"]["terminalId"].as_str(), terminal.as_deref(), "{v}");
            got_event = true;
        }
    }
    assert!(terminal.is_some(), "no reply");
    assert!(got_event, "the terminal's exit was not relayed");
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
    let d = start();
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
async fn exits_when_stdin_closes() {
    let mut d = start();
    // Make sure it is serving before pulling the plug.
    let (status, _) = post(d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    drop(d.child.stdin.take());
    let child = std::sync::Mutex::new(&mut d.child);
    let status = until("nekkod to exit after its stdin closed", Duration::from_secs(15), || async {
        child.lock().unwrap().try_wait().unwrap()
    })
    .await;
    assert!(status.success(), "nekkod exited with {status}");
}

/// IO-33 FA-3 / FA-6: a chat's terminals, a capped tail, remote viewers and
/// SSH hosts from `~/.ssh/config`, opened through a stand-in `ssh` that prints
/// its argv (no real connection).
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn chat_terminals_tails_viewers_and_ssh() {
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::temp_dir().join(format!("nekkod-ssh-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let (home, bin, data) = (root.join("home"), root.join("bin"), root.join("data"));
    std::fs::create_dir_all(home.join(".ssh")).unwrap();
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::create_dir_all(data.join("sessions")).unwrap();
    std::fs::write(
        home.join(".ssh/config"),
        "Host devbox\n  HostName 10.0.0.5\n  User philip\n  IdentityFile ~/.ssh/secret_key_file\nHost *\n  ForwardAgent no\n",
    )
    .unwrap();
    let ssh = bin.join("ssh");
    std::fs::write(&ssh, "#!/bin/sh\nprintf 'fake-ssh'\nfor a in \"$@\"; do printf ' [%s]' \"$a\"; done\necho\n")
        .unwrap();
    std::fs::set_permissions(&ssh, std::fs::Permissions::from_mode(0o755)).unwrap();
    let path = format!("{}:/usr/bin:/bin", bin.display());
    let home_s = home.to_string_lossy().into_owned();
    let d = start_with_env(&data, json!({}), &[("HOME", Some(&home_s)), ("PATH", Some(&path))]);

    // Hosts: the alias and display fields, never the key path.
    let (status, hosts) = post(d.port, "ssh:hosts", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{hosts}");
    assert_eq!(hosts, json!([{ "alias": "devbox", "hostName": "10.0.0.5", "user": "philip" }]));
    assert!(!hosts.to_string().contains("secret_key"));
    let (status, refused) = post(d.port, "ssh:open", json!(["devbox; touch /tmp/x", {}]), Some(TOKEN)).await;
    assert_eq!(status, 400);
    assert!(refused["error"].as_str().unwrap().contains("not a host"), "{refused}");

    // A chat to link terminals to.
    let (_, chat) = post(d.port, "session:create", json!([]), Some(TOKEN)).await;
    let sid = chat["id"].as_str().expect("a chat id").to_string();
    let (status, term) =
        post(d.port, "ssh:open", json!(["devbox", { "cols": 100, "rows": 30, "sessionId": sid }]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{term}");
    assert_eq!(term["title"], "ssh devbox");
    assert_eq!(term["sessionId"], sid.as_str());
    let id = term["id"].as_str().unwrap().to_string();
    let (_, other) = post(d.port, "terminal:create", json!([echo_shell("unlinked")]), Some(TOKEN)).await;

    // The alias reached ssh as its own argument, after the options.
    let port = d.port;
    let tail = until("ssh output", Duration::from_secs(20), || {
        let id = id.clone();
        async move {
            let (_, snap) = post(port, "terminal:tail", json!([id, 4096]), Some(TOKEN)).await;
            snap["buffer"].as_str().is_some_and(|b| b.contains("[devbox]")).then_some(snap)
        }
    })
    .await;
    assert!(tail["buffer"].as_str().unwrap().contains("fake-ssh [-o] [BatchMode=no] [--] [devbox]"), "{tail}");
    assert_eq!(tail["truncated"], false);
    let (_, capped) = post(d.port, "terminal:snapshot", json!([id, { "maxBytes": 8 }]), Some(TOKEN)).await;
    assert!(capped["buffer"].as_str().unwrap().len() <= 8, "{capped}");
    assert_eq!(capped["truncated"], true);

    // This chat's terminals only.
    let (_, mine) = post(d.port, "terminals:list", json!([{ "sessionId": sid }]), Some(TOKEN)).await;
    let ids: Vec<&str> = mine.as_array().unwrap().iter().filter_map(|t| t["id"].as_str()).collect();
    assert_eq!(ids, [id.as_str()], "{mine}");
    let (_, all) = post(d.port, "terminals:list", json!([]), Some(TOKEN)).await;
    assert!(all.as_array().unwrap().iter().any(|t| t["id"] == other["id"]));

    // Viewers: attach publishes `terminal:viewers`, detach-everywhere clears it.
    let mut sock = ws(d.port, &format!("/api/ws?token={TOKEN}"), Some("null")).await.unwrap();
    let (status, viewers) =
        post(d.port, "terminal:attach", json!([id, { "id": "dev_1", "name": "Philip's iPhone" }]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{viewers}");
    assert_eq!(viewers[0]["kind"], "phone");
    let mut event = None;
    let deadline = Instant::now() + Duration::from_secs(10);
    while event.is_none() && Instant::now() < deadline {
        let Some(v) = next_json(&mut sock, Duration::from_secs(10)).await else { break };
        if v["channel"] == "terminal:viewers" {
            event = Some(v["payload"].clone());
        }
    }
    let event = event.expect("a terminal:viewers event");
    assert_eq!(event["terminalId"], id.as_str());
    assert_eq!(event["viewers"][0]["name"], "Philip's iPhone");
    let (_, listed) = post(d.port, "terminals:list", json!([{ "sessionId": sid }]), Some(TOKEN)).await;
    assert_eq!(listed[0]["viewers"][0]["id"], "dev_1");
    let (_, left) = post(d.port, "terminal:detach", json!([null, "dev_1"]), Some(TOKEN)).await;
    assert_eq!(left, json!([id]));
    let (_, listed) = post(d.port, "terminals:list", json!([{ "sessionId": sid }]), Some(TOKEN)).await;
    assert!(listed[0].get("viewers").is_none(), "{listed}");
    let (status, _) = post(d.port, "terminal:attach", json!(["term_missing", { "id": "dev_1" }]), Some(TOKEN)).await;
    assert_eq!(status, 400);

    post(d.port, "terminal:close", json!([id]), Some(TOKEN)).await;
    post(d.port, "terminal:close", json!([other["id"]]), Some(TOKEN)).await;
    drop(d);
    let _ = std::fs::remove_dir_all(root);
}
