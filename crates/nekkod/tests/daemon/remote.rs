//! The real `nekkod` binary end to end: reaching the daemon from elsewhere: the phone relay agent and the Telegram bridge.

use crate::common::*;

/// A relay socket as the test sees it (it plays apps/relay-server).
type RelaySide = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

/// The agent's next frame, and what it seals when it is a data frame.
async fn next_agent_frame(agent: &mut RelaySide, key: &nekko_remote::e2e::Key) -> (Value, Option<Value>) {
    let f = next_json(agent, Duration::from_secs(20)).await.expect("an agent frame");
    let sealed = (f["type"] == "d")
        .then(|| serde_json::from_str::<Value>(f["data"].as_str().unwrap()).unwrap())
        .and_then(|d| nekko_remote::e2e::open(key, d["enc"].as_str().unwrap()));
    (f, sealed)
}

#[tokio::test(flavor = "multi_thread")]
async fn the_daemon_runs_the_phone_relay_agent() {
    let data = std::env::temp_dir().join(format!("nekkod-remote-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(&data).unwrap();
    let d = start_with(Some(&data));
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
    // The phone compares this with its own and says which side to update (IO-32).
    assert_eq!(welcome["protocol"], nekko_remote::hello::PROTOCOL_VERSION, "{welcome}");
    // *Send a test notification* (IO-30): the agent asks the relay to push to
    // this phone only, then answers the phone.
    agent.send(client("c1", json!({ "type": "req", "id": 32, "channel": "push:test", "args": [] }))).await.unwrap();
    let (notify, _) = next_agent_frame(&mut agent, &key).await;
    assert_eq!(notify["type"], "notify", "{notify}");
    assert_eq!(notify["kind"], "test");
    assert_eq!(notify["deviceId"], "phone-1");
    let (_, res) = next_agent_frame(&mut agent, &key).await;
    assert_eq!(res.unwrap(), json!({ "type": "res", "id": 32, "result": { "ok": true } }));
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
    // A channel a phone may call, the daemon's own now (built-ins first).
    let res = ask(31, "skills:runnable", json!([])).await;
    assert_eq!(res["result"][0]["source"], "builtin", "{res}");
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

    // The daemon's events reach the welcomed phone: the UI's theme change, which the phone mirrors.
    post(d.port, "settings:update", json!([{ "theme": "dark" }]), Some(TOKEN)).await;
    let event = loop {
        let (_, sealed) = next_agent_frame(&mut agent, &key).await;
        if let Some(s) = sealed.filter(|s| s["type"] == "event" && s["channel"] == "appearance:updated") {
            break s;
        }
    };
    assert_eq!(event["payload"]["theme"], "dark", "{event}");
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
    let d = start_with_config(Some(&data), json!({ "telegramApiUrl": format!("http://127.0.0.1:{}", tg.port) }));

    let (_, info) = post(d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    assert!(info["owned"].as_array().unwrap().contains(&json!("messaging:status")), "{info}");
    wait_for("the first long poll", || tg.polls_since(0) >= 1).await;
    let first = &tg.calls("getUpdates")[0];
    assert_eq!(first["offset"], 40, "the poll resumes from the saved offset");
    assert_eq!(first["timeout"], 25);
    assert!(tg.calls.lock().unwrap().iter().all(|c| c.0 == "bot123:TEST"), "every call uses the bot token");
    let status = until("getMe to be answered", Duration::from_secs(10), || async {
        let (_, s) = post(d.port, "messaging:status", json!([]), Some(TOKEN)).await;
        s["telegram"]["botUsername"].is_string().then_some(s)
    })
    .await;
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
    // Admitted and driven by the daemon.
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
    until("the bridge to stop", Duration::from_secs(5), || async {
        let (_, s) = post(d.port, "messaging:status", json!([]), Some(TOKEN)).await;
        (s == json!({})).then_some(())
    })
    .await;
    // Proving a negative: no poll in this window. Kept as elapsed time on purpose.
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(tg.polls_since(polls), 0, "no poll after disabling");
    // A message sent meanwhile is not read.
    tg.updates
        .send(json!([{ "update_id": 43, "message": { "message_id": 3, "chat": { "id": 42, "type": "private" }, "text": "anyone?" } }]))
        .unwrap();
    // Proving a negative again: nothing reads the update in this window.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(model.requests.lock().unwrap().len(), 1, "no turn while off");
    drop(d);
    std::fs::remove_dir_all(&data).ok();
}
