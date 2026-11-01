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

/// A test phone's device key: one fixed P-256 key per device id.
fn device_key(device: &str) -> p256::ecdsa::SigningKey {
    use sha2::Digest;
    p256::ecdsa::SigningKey::from_slice(&sha2::Sha256::digest(format!("device-key:{device}").as_bytes())).unwrap()
}

/// A current phone app's frames on each connection: its HELLO answers the
/// connection's challenge and is signed with the device key (protocol 5), and
/// each request after it carries that challenge and the next seq.
#[derive(Default)]
struct Phones {
    room: String,
    /// cid to (challenge, last seq).
    conns: std::sync::Mutex<std::collections::HashMap<String, (String, u64)>>,
}

impl Phones {
    fn new(room: &str) -> Self {
        Phones { room: room.to_string(), conns: Default::default() }
    }

    fn challenged(&self, cid: &str, challenge: &Value) {
        let c = challenge["challenge"].as_str().expect("a challenge").to_string();
        self.conns.lock().unwrap().insert(cid.to_string(), (c, 0));
    }

    fn frame(&self, cid: &str, mut v: Value) -> Value {
        use base64::Engine;
        use p256::ecdsa::signature::Signer;
        let mut conns = self.conns.lock().unwrap();
        let p = conns.entry(cid.to_string()).or_default();
        match v["type"].as_str() {
            Some("hello") => {
                let device = v["deviceId"].as_str().unwrap_or_default().to_string();
                let k = device_key(&device);
                let text = nekko_remote::hello::hello_text(&device, &self.room, &p.0);
                let sig: p256::ecdsa::Signature = k.sign(text.as_bytes());
                let b64 = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
                v["protocol"] = json!(nekko_remote::hello::PROTOCOL_VERSION);
                v["challenge"] = json!(p.0);
                v["helloKey"] = json!(b64(k.verifying_key().to_encoded_point(false).as_bytes()));
                v["sig"] = json!(b64(&sig.to_bytes()));
                p.1 = 0;
            }
            Some("req") => {
                p.1 += 1;
                v["seq"] = json!(p.1);
                v["challenge"] = json!(p.0);
            }
            _ => {}
        }
        v
    }
}

/// Announce a connection and read the challenge the agent seals to it first.
async fn open_conn(agent: &mut RelaySide, key: &nekko_remote::e2e::Key, phones: &Phones, cid: &str) {
    agent.send(Message::text(json!({ "type": "client-open", "cid": cid }).to_string())).await.unwrap();
    loop {
        let (f, sealed) = next_agent_frame(agent, key).await;
        if let Some(s) = sealed.filter(|s| f["cid"] == cid && s["type"] == "challenge") {
            phones.challenged(cid, &s);
            return;
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_daemon_runs_the_phone_relay_agent() {
    let data = std::env::temp_dir().join(format!("nekkod-remote-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(&data).unwrap();
    let d = start_with(&data);
    let relay = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let relay_port = relay.local_addr().unwrap().port();

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
    // The relay gets a credential derived from the secret, never the secret.
    let auth = nekko_remote::e2e::relay_auth(&secret, &room);
    assert_eq!(path, format!("/relay?role=agent&room={room}&key={auth}"));
    assert!(!path.contains(&secret));
    let key = nekko_remote::e2e::derive_key(&secret, &room);
    let seal = |v: Value| {
        json!({ "enc": nekko_remote::e2e::seal_with_iv(&key, &v, nekko_remote::e2e::random_iv()) }).to_string()
    };
    // A current phone: its HELLO answers the connection's challenge and is
    // signed with its device key; each request carries the challenge and the next seq.
    let phones = Phones::new(&room);
    let client = |cid: &str, v: Value| {
        Message::text(json!({ "type": "c", "cid": cid, "data": seal(phones.frame(cid, v)) }).to_string())
    };

    agent.send(Message::text(json!({ "type": "client-open", "cid": "c1" }).to_string())).await.unwrap();
    // The agent challenges each new connection before anything else.
    let (f, challenge) = next_agent_frame(&mut agent, &key).await;
    assert_eq!(f["cid"], "c1");
    let challenge = challenge.unwrap();
    assert_eq!(challenge["type"], "challenge", "{challenge}");
    phones.challenged("c1", &challenge);
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
    // The iPhone's Live Activity card level: the agent keeps it itself (no chats yet, so no card frame).
    let card = json!({ "type": "req", "id": 34, "channel": "card:set", "args": [{ "level": "standard" }] });
    agent.send(client("c1", card)).await.unwrap();
    let (_, res) = next_agent_frame(&mut agent, &key).await;
    assert_eq!(res.unwrap(), json!({ "type": "res", "id": 34, "result": { "ok": true } }));
    // A request replayed byte for byte is dropped, and the connection goes
    // back to the handshake: the phone says hello to the new challenge.
    let once = client("c1", json!({ "type": "req", "id": 33, "channel": "app:info", "args": [] }));
    agent.send(once.clone()).await.unwrap();
    let (_, res) = next_agent_frame(&mut agent, &key).await;
    assert_eq!(res.unwrap()["id"], 33);
    agent.send(once).await.unwrap();
    let (_, again) = next_agent_frame(&mut agent, &key).await;
    let again = again.unwrap();
    assert_eq!(again["type"], "challenge", "{again}");
    phones.challenged("c1", &again);
    agent
        .send(client("c1", json!({ "type": "hello", "deviceId": "phone-1", "name": "Pixel", "platform": "android" })))
        .await
        .unwrap();
    let (_, welcome) = next_agent_frame(&mut agent, &key).await;
    assert_eq!(welcome.unwrap()["type"], "welcome");
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

    // IO-33: the gate knows which phone calls. A Change key registered
    // without the proof is refused, and the refusal lands in that phone's
    // activity, which only the desktop reads; the phone may not set its own
    // switches or read its activity.
    let mut ask_res = async |id: u32, channel: &str, args: Value| {
        agent.send(client("c1", json!({ "type": "req", "id": id, "channel": channel, "args": args }))).await.unwrap();
        loop {
            let (_, sealed) = next_agent_frame(&mut agent, &key).await;
            if let Some(s) = sealed.filter(|s| s["type"] == "res" && s["id"] == id) {
                break s;
            }
        }
    };
    let res = ask_res(
        40,
        "device:registerKey",
        json!(["BAR/v8sCAzk1hHTpnnCLIlF1ruz+rF+jQdEeUu/OcjwnZmPysLs7FJ2/VAL5o51uKkNxeTc8jKMMcQno/2Tp6WI="]),
    )
    .await;
    assert_eq!(res["error"], "Not allowed from a paired phone (proof-required): device:registerKey", "{res}");
    let res = ask_res(41, "remote:setAccess", json!(["phone-1", { "change": true }])).await;
    assert_eq!(res["error"], "Not allowed from a paired phone (channel-denied): remote:setAccess");
    let res = ask_res(42, "remote:activity", json!(["phone-1"])).await;
    assert_eq!(res["error"], "Not allowed from a paired phone (channel-denied): remote:activity");
    let (_, activity) = post(d.port, "remote:activity", json!(["phone-1"]), Some(TOKEN)).await;
    // The three settings updates above are agent-class: logged, allowed or not.
    assert_eq!(activity.as_array().map(Vec::len), Some(4), "{activity}");
    let channels: Vec<&str> = activity.as_array().unwrap().iter().map(|a| a["channel"].as_str().unwrap()).collect();
    assert_eq!(channels, ["settings:update", "settings:update", "settings:update", "device:registerKey"]);
    assert_eq!(activity[3]["ok"], false);
    assert_eq!(activity[3]["reason"], "proof-required");
    let (_, devices) = post(d.port, "remote:setAccess", json!(["phone-1", { "change": false }]), Some(TOKEN)).await;
    assert_eq!(devices[0]["access"], json!({ "read": true, "change": false }), "{devices}");
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(data.join("remote.json")).unwrap()).unwrap();
    assert_eq!(saved["devices"][0]["access"]["change"], false);

    // IO-33 FA-2: git from a phone. A read names a chat, never a saved folder;
    // a chat with no folder gets the engine's own answer; a change is refused
    // while Change is off and lands in the activity; Read off refuses reads.
    let res = ask_res(43, "git:diff", json!(["w1", { "staged": true }])).await;
    assert_eq!(res["error"], "Not allowed from a paired phone (value-invalid): chat folder", "{res}");
    let res = ask_res(44, "git:log", json!(["session:nope"])).await;
    assert_eq!(res["error"], "This workspace has no folder to run git in.", "{res}");
    let res = ask_res(45, "git:push", json!(["session:nope", { "setUpstream": true }])).await;
    assert_eq!(res["error"], "Not allowed from a paired phone (change-off): git:push", "{res}");
    let (_, activity) = post(d.port, "remote:activity", json!(["phone-1"]), Some(TOKEN)).await;
    assert_eq!(activity.as_array().map(Vec::len), Some(5), "reads are not logged: {activity}");
    assert_eq!(activity[4]["channel"], "git:push", "oldest first: {activity}");
    assert_eq!(activity[4]["reason"], "change-off");
    post(d.port, "remote:setAccess", json!(["phone-1", { "read": false }]), Some(TOKEN)).await;
    let res = ask_res(46, "workspace:gitStatus", json!(["session:nope"])).await;
    assert_eq!(res["error"], "Not allowed from a paired phone (read-off): workspace:gitStatus", "{res}");
    // IO-33 FA-1 and FA-5: files and logs from a phone. A saved folder by its
    // id; secret files left out and refused; a save is a Change (off here, so
    // refused and logged); logs are read only; Read off refuses both.
    post(d.port, "remote:setAccess", json!(["phone-1", { "read": true }]), Some(TOKEN)).await;
    let project = data.join("phone-project");
    std::fs::create_dir_all(project.join("src")).unwrap();
    std::fs::write(project.join("src").join("lib.rs"), "pub fn hi() {}\n").unwrap();
    std::fs::write(project.join(".env"), "TOKEN=abc").unwrap();
    let folder = json!([{ "workspaces": [{ "id": "w1", "name": "phone-project", "path": project.to_string_lossy(), "addedAt": 1 }] }]);
    post(d.port, "settings:update", folder, Some(TOKEN)).await;
    let w1 = json!({ "workspaceId": "w1" });
    let res = ask_res(50, "files:list", json!([w1, ""])).await;
    assert_eq!(
        res["result"]["entries"],
        json!([{ "name": "src", "path": "src", "dir": true, "mtime": res["result"]["entries"][0]["mtime"] }]),
        "{res}"
    );
    assert_eq!(res["result"]["hiddenSecrets"], 1, "{res}");
    let res = ask_res(51, "files:read", json!([w1, "src/lib.rs", { "maxBytes": 999_999_999 }])).await;
    assert_eq!(res["result"]["content"], "pub fn hi() {}\n", "{res}");
    let hash = res["result"]["hash"].as_str().expect("a hash to save against").to_string();
    let res = ask_res(52, "files:read", json!([w1, ".env"])).await;
    assert_eq!(res["error"], "Not allowed from a paired phone (value-invalid): secret file", "{res}");
    let res = ask_res(53, "files:search", json!([w1, "lib"])).await;
    assert_eq!(res["result"]["hits"][0]["path"], "src/lib.rs", "{res}");
    let res = ask_res(54, "files:write", json!([w1, "src/lib.rs", "pub fn bye() {}\n", { "expectHash": hash }])).await;
    assert_eq!(res["error"], "Not allowed from a paired phone (change-off): files:write", "{res}");
    assert_eq!(std::fs::read_to_string(project.join("src").join("lib.rs")).unwrap(), "pub fn hi() {}\n");
    let res = ask_res(55, "logs:list", json!([])).await;
    let ids: Vec<&str> = res["result"].as_array().unwrap().iter().filter_map(|l| l["id"].as_str()).collect();
    assert!(ids.contains(&"daemon") && ids.contains(&"app"), "{res}");
    let res = ask_res(56, "logs:read", json!(["daemon", { "tailBytes": 999_999_999 }])).await;
    assert!(res["result"]["text"].is_string(), "{res}");
    let (_, activity) = post(d.port, "remote:activity", json!(["phone-1"]), Some(TOKEN)).await;
    let last = activity.as_array().and_then(|a| a.iter().find(|e| e["channel"] == "files:write")).cloned();
    assert_eq!(last.map(|e| e["reason"].clone()), Some(json!("change-off")), "{activity}");
    post(d.port, "remote:setAccess", json!(["phone-1", { "read": false }]), Some(TOKEN)).await;
    let res = ask_res(57, "files:list", json!([w1, ""])).await;
    assert_eq!(res["error"], "Not allowed from a paired phone (read-off): files:list", "{res}");
    let res = ask_res(58, "logs:read", json!(["daemon"])).await;
    assert_eq!(res["error"], "Not allowed from a paired phone (read-off): logs:read", "{res}");

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

/// Reads the agent's frames until `cid`'s reply to request `id`, keeping
/// every `terminal:event` it passes as `(cid, payload)`.
async fn reply_to(
    agent: &mut RelaySide,
    key: &nekko_remote::e2e::Key,
    cid: &str,
    id: u32,
    events: &mut Vec<(String, Value)>,
) -> Value {
    loop {
        let (f, sealed) = next_agent_frame(agent, key).await;
        let Some(s) = sealed else { continue };
        if s["type"] == "event" && s["channel"] == "terminal:event" {
            events.push((f["cid"].as_str().unwrap_or("").to_string(), s["payload"].clone()));
        } else if s["type"] == "res" && s["id"] == id && f["cid"] == cid {
            return s;
        }
    }
}

/// A Change proof signed by `k`, as the iPhone's Secure Enclave key signs it.
fn change_proof(k: &p256::ecdsa::SigningKey, device: &str, channel: &str, args: &Value, ts: i64) -> Value {
    use base64::Engine;
    use p256::ecdsa::signature::Signer;
    let text = nekko_remote::proof::payload(device, channel, args, ts).unwrap();
    let sig: p256::ecdsa::Signature = k.sign(text.as_bytes());
    json!({ "ts": ts, "sig": base64::engine::general_purpose::STANDARD.encode(sig.to_bytes()) })
}

/// IO-33 FA-3 over the real relay agent: a phone opens a chat's terminal
/// (one signed proof), types with the token it got, and only that phone
/// receives the output; its disconnect takes it off the desktop's badge.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_phone_attaches_to_a_chat_terminal_over_the_relay() {
    let data = std::env::temp_dir().join(format!("nekkod-remote-term-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(data.join("sessions")).unwrap();
    let d = start_with(&data);
    let relay = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let relay_port = relay.local_addr().unwrap().port();
    post(d.port, "remote:enable", json!([format!("ws://127.0.0.1:{relay_port}/")]), Some(TOKEN)).await;
    let (_, pairing) = post(d.port, "remote:pairing", json!([]), Some(TOKEN)).await;
    let (room, secret) = (pairing["room"].as_str().unwrap().to_string(), pairing["key"].as_str().unwrap().to_string());
    let (tcp, _) =
        tokio::time::timeout(Duration::from_secs(20), relay.accept()).await.expect("the agent dials").unwrap();
    let mut agent = tokio_tungstenite::accept_async(tcp).await.unwrap();
    let key = nekko_remote::e2e::derive_key(&secret, &room);
    let seal = |v: Value| {
        json!({ "enc": nekko_remote::e2e::seal_with_iv(&key, &v, nekko_remote::e2e::random_iv()) }).to_string()
    };
    let phones = Phones::new(&room);
    let client = |cid: &str, v: Value| {
        Message::text(json!({ "type": "c", "cid": cid, "data": seal(phones.frame(cid, v)) }).to_string())
    };
    let mut events = Vec::new();
    // Two phones, each enrolled with its own one-time code.
    for (cid, device, name) in [("c1", "phone-1", "Pixel"), ("c2", "phone-2", "Other phone")] {
        let (_, grant) = post(d.port, "remote:pair", json!([]), Some(TOKEN)).await;
        open_conn(&mut agent, &key, &phones, cid).await;
        let hello =
            json!({ "type": "hello", "deviceId": device, "name": name, "platform": "ios", "pair": grant["code"] });
        agent.send(client(cid, hello)).await.unwrap();
        loop {
            let (f, sealed) = next_agent_frame(&mut agent, &key).await;
            if f["cid"] == cid && sealed.is_some_and(|s| s["type"] == "welcome") {
                break;
            }
        }
    }
    // The desktop opens a terminal for a chat.
    let (_, chat) = post(d.port, "session:create", json!([]), Some(TOKEN)).await;
    let sid = chat["id"].as_str().expect("a chat id").to_string();
    let (_, term) =
        post(d.port, "terminal:create", json!([{ "shell": "/bin/sh", "title": "t", "sessionId": sid }]), Some(TOKEN))
            .await;
    let id = term["id"].as_str().unwrap().to_string();

    // phone-1 registers its key, then opens the terminal with one proof.
    let k = p256::ecdsa::SigningKey::from_slice(&[7; 32]).unwrap();
    use base64::Engine;
    let public = base64::engine::general_purpose::STANDARD.encode(k.verifying_key().to_encoded_point(false).as_bytes());
    let now = || std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    let args = json!([public]);
    let proof = change_proof(&k, "phone-1", "device:registerKey", &args, now());
    let req = json!({ "type": "req", "id": 1, "channel": "device:registerKey", "args": args, "proof": proof });
    agent.send(client("c1", req)).await.unwrap();
    let res = reply_to(&mut agent, &key, "c1", 1, &mut events).await;
    assert_eq!(res["result"], json!({ "registered": true }), "{res}");
    let args = json!([id]);
    let proof = change_proof(&k, "phone-1", "terminal:open", &args, now() + 1);
    agent
        .send(client("c1", json!({ "type": "req", "id": 2, "channel": "terminal:open", "args": args, "proof": proof })))
        .await
        .unwrap();
    let res = reply_to(&mut agent, &key, "c1", 2, &mut events).await;
    let token = res["result"]["token"].as_str().unwrap_or_else(|| panic!("a token: {res}")).to_string();
    assert_eq!(res["result"]["terminal"]["id"], id.as_str());
    assert!(!res.to_string().contains(&data.to_string_lossy().to_string()), "no absolute path: {res}");
    // The desktop's badge names the phone.
    let (_, listed) = post(d.port, "terminals:list", json!([{ "sessionId": sid }]), Some(TOKEN)).await;
    assert_eq!(listed[0]["viewers"][0]["id"], "phone-1", "{listed}");
    assert_eq!(listed[0]["viewers"][0]["name"], "Pixel");

    // Typing needs only the token; the output reaches phone-1, never phone-2.
    let req =
        json!({ "type": "req", "id": 3, "channel": "terminal:write", "args": [id, "echo phone-typed-ok\r", token] });
    agent.send(client("c1", req)).await.unwrap();
    let res = reply_to(&mut agent, &key, "c1", 3, &mut events).await;
    assert_eq!(res["result"], Value::Null, "{res}");
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut typed = String::new();
    while !typed.contains("phone-typed-ok\r\n") && Instant::now() < deadline {
        for (cid, p) in events.drain(..) {
            assert_eq!(cid, "c1", "terminal output went to a phone that isn't attached: {p}");
            typed.push_str(p["data"].as_str().unwrap_or(""));
        }
        if let Ok((f, Some(s))) = tokio::time::timeout(Duration::from_secs(2), next_agent_frame(&mut agent, &key)).await
            && s["channel"] == "terminal:event"
        {
            events.push((f["cid"].as_str().unwrap_or("").to_string(), s["payload"].clone()));
        }
    }
    assert!(typed.contains("phone-typed-ok\r\n"), "{typed:?}");
    // phone-2 can't use phone-1's token.
    let req = json!({ "type": "req", "id": 4, "channel": "terminal:write", "args": [id, "rm -rf ~\r", token] });
    agent.send(client("c2", req)).await.unwrap();
    let res = reply_to(&mut agent, &key, "c2", 4, &mut events).await;
    assert_eq!(res["error"], "Not allowed from a paired phone (token-invalid): terminal:write");
    assert!(events.iter().all(|(cid, _)| cid == "c1"));

    // phone-1 disconnects: it is no longer a viewer on the desktop.
    agent.send(Message::text(json!({ "type": "client-close", "cid": "c1" }).to_string())).await.unwrap();
    let port = d.port;
    until("the phone detached", Duration::from_secs(10), || {
        let sid = sid.clone();
        async move {
            let (_, listed) = post(port, "terminals:list", json!([{ "sessionId": sid }]), Some(TOKEN)).await;
            listed[0].get("viewers").is_none().then_some(())
        }
    })
    .await;
    let (_, activity) = post(d.port, "remote:activity", json!(["phone-1"]), Some(TOKEN)).await;
    let channels: Vec<&str> = activity.as_array().unwrap().iter().filter_map(|a| a["channel"].as_str()).collect();
    assert!(channels.contains(&"terminal:open") && !channels.contains(&"terminal:write"), "{activity}");
    post(d.port, "terminal:close", json!([id]), Some(TOKEN)).await;
    drop(d);
    let _ = std::fs::remove_dir_all(&data);
}

/// The relying-party id and app origin the test's `security.json` holds,
/// as the desktop's Settings → Security writes them (SK-4).
const RP_ID: &str = "nekko-computer:itest";
const ORIGIN: &str = "nekko-app://desktop";

/// An ES256 signature in the DER form a FIDO2 authenticator sends.
fn der(sig: &p256::ecdsa::Signature) -> Vec<u8> {
    let raw = sig.to_bytes();
    let int = |b: &[u8]| {
        let b = &b[b.iter().position(|x| *x != 0).unwrap_or(31)..];
        let mut v = vec![0x02];
        if b[0] & 0x80 != 0 {
            v.extend([b.len() as u8 + 1, 0]);
        } else {
            v.push(b.len() as u8);
        }
        v.extend_from_slice(b);
        v
    };
    let body = [int(&raw[..32]), int(&raw[32..])].concat();
    [vec![0x30, body.len() as u8], body].concat()
}

/// `security.json` with step-up on, as Settings → Security leaves it: one
/// security key (`k`, named `name`) and a one-time code, for `rp_id`.
fn security_json(rp_id: &str, k: &p256::ecdsa::SigningKey, credential: &[u8], name: &str) -> Value {
    let public = nekko_remote::step_up::to_b64url(k.verifying_key().to_encoded_point(false).as_bytes());
    json!({
        "version": 1, "enabled": true, "rpId": rp_id, "origins": [ORIGIN],
        "credentials": [{
            "id": nekko_remote::step_up::to_b64url(credential), "publicKey": public, "counter": 0,
            "name": name, "kind": "security-key", "addedAt": 1,
        }],
        "totp": { "secret": "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "addedAt": 1 },
        "recoveryHashes": [nekko_remote::step_up::hash_recovery_code("abcde-fghij")],
    })
}

/// Turns step-up on or off in `security.json`, keeping everything the daemon
/// wrote (counters, rate limit). The desktop's own guarded calls (remote:enable,
/// remote:attach, remote:pair, remote:setAccess) ask for a step-up too (SK-4),
/// so these tests set the computer up with it off, as an owner does before
/// turning it on, and test the phone gate with it on.
fn set_step_up(data: &std::path::Path, on: bool) {
    let path = data.join("security.json");
    let mut v: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    v["enabled"] = json!(on);
    std::fs::write(&path, v.to_string()).unwrap();
}

/// A software FIDO2 authenticator's assertion for `challenge` on `rp_id`:
/// the authenticator data (rpIdHash, flags UP and UV, `counter`), the client
/// data a WebAuthn caller writes, and the signature over both (SK-11).
fn fido2_assertion(
    k: &p256::ecdsa::SigningKey,
    rp_id: &str,
    credential: &[u8],
    challenge: &str,
    counter: u32,
) -> Value {
    use p256::ecdsa::signature::Signer;
    use sha2::{Digest, Sha256};
    let mut auth = Sha256::digest(rp_id.as_bytes()).to_vec();
    auth.push(0x05);
    auth.extend(counter.to_be_bytes());
    let cdj = json!({ "type": "webauthn.get", "challenge": challenge, "origin": ORIGIN }).to_string();
    let mut signed = auth.clone();
    signed.extend(Sha256::digest(cdj.as_bytes()));
    let sig: p256::ecdsa::Signature = k.sign(&signed);
    let u = nekko_remote::step_up::to_b64url;
    json!({
        "credentialId": u(credential),
        "authenticatorData": u(&auth),
        "clientDataJSON": u(cdj.as_bytes()),
        "signature": u(&der(&sig)),
    })
}

/// SK-11 over the real relay agent: with step-up on in `security.json`, a
/// phone's mode raise is refused `step-up-required` after its Change proof,
/// runs with a software FIDO2 authenticator's answer to a `security:challenge`,
/// and the same answer again is `step-up-replayed`. Then `remote:stop` from a
/// phone kicks every phone (the relay closes each with 4001) and the agent
/// hangs up within a second.
#[tokio::test(flavor = "multi_thread")]
async fn a_phone_raises_a_mode_with_a_security_key_and_stops_remote_access() {
    use base64::Engine;
    let data = std::env::temp_dir().join(format!("nekkod-remote-stepup-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(data.join("sessions")).unwrap();
    // Step-up on, as Settings → Security leaves it: a security key and a one-time code.
    let fido = p256::ecdsa::SigningKey::from_slice(&[9; 32]).unwrap();
    let credential = [3u8; 16];
    let security = security_json(RP_ID, &fido, &credential, "YubiKey 5 NFC");
    std::fs::write(data.join("security.json"), security.to_string()).unwrap();
    let d = start_with(&data);
    set_step_up(&data, false);
    let relay = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let relay_port = relay.local_addr().unwrap().port();
    post(d.port, "remote:enable", json!([format!("ws://127.0.0.1:{relay_port}/")]), Some(TOKEN)).await;
    let (_, pairing) = post(d.port, "remote:pairing", json!([]), Some(TOKEN)).await;
    let (room, secret) = (pairing["room"].as_str().unwrap().to_string(), pairing["key"].as_str().unwrap().to_string());
    let (tcp, _) =
        tokio::time::timeout(Duration::from_secs(20), relay.accept()).await.expect("the agent dials").unwrap();
    let mut agent = tokio_tungstenite::accept_async(tcp).await.unwrap();
    let key = nekko_remote::e2e::derive_key(&secret, &room);
    let seal = |v: Value| {
        json!({ "enc": nekko_remote::e2e::seal_with_iv(&key, &v, nekko_remote::e2e::random_iv()) }).to_string()
    };
    let phones = Phones::new(&room);
    let client = |cid: &str, v: Value| {
        Message::text(json!({ "type": "c", "cid": cid, "data": seal(phones.frame(cid, v)) }).to_string())
    };
    let mut events = Vec::new();
    for (cid, device, name) in [("c1", "phone-1", "Pixel"), ("c2", "phone-2", "Philip's iPhone")] {
        let (_, grant) = post(d.port, "remote:pair", json!([]), Some(TOKEN)).await;
        open_conn(&mut agent, &key, &phones, cid).await;
        let hello =
            json!({ "type": "hello", "deviceId": device, "name": name, "platform": "ios", "pair": grant["code"] });
        agent.send(client(cid, hello)).await.unwrap();
        loop {
            let (f, sealed) = next_agent_frame(&mut agent, &key).await;
            if f["cid"] == cid && sealed.is_some_and(|s| s["type"] == "welcome") {
                break;
            }
        }
    }
    set_step_up(&data, true);
    // A chat in Ask; the phone will raise it to YOLO.
    post(d.port, "settings:update", json!([{ "defaultChatMode": "ask" }]), Some(TOKEN)).await;
    let (_, chat) = post(d.port, "session:create", json!([]), Some(TOKEN)).await;
    let sid = chat["id"].as_str().expect("a chat id").to_string();

    // phone-1 registers its Change key (the Secure Enclave key, not the security key).
    let change = p256::ecdsa::SigningKey::from_slice(&[7; 32]).unwrap();
    let public =
        base64::engine::general_purpose::STANDARD.encode(change.verifying_key().to_encoded_point(false).as_bytes());
    let now = || std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    let args = json!([public]);
    let proof = change_proof(&change, "phone-1", "device:registerKey", &args, now());
    let req = json!({ "type": "req", "id": 1, "channel": "device:registerKey", "args": args, "proof": proof });
    agent.send(client("c1", req)).await.unwrap();
    let res = reply_to(&mut agent, &key, "c1", 1, &mut events).await;
    assert_eq!(res["result"], json!({ "registered": true }), "{res}");

    // Each raise carries a fresh Change proof, so only the step-up decides.
    let raise_args = json!([sid, { "mode": "yolo" }]);
    let mut ts = now();
    let mut raise = |id: u32, step_up: Option<Value>| {
        ts += 1;
        let proof = change_proof(&change, "phone-1", "session:setOptions", &raise_args, ts);
        let mut req =
            json!({ "type": "req", "id": id, "channel": "session:setOptions", "args": raise_args, "proof": proof });
        if let Some(s) = step_up {
            req["stepUp"] = s;
        }
        client("c1", req)
    };
    agent.send(raise(2, None)).await.unwrap();
    let res = reply_to(&mut agent, &key, "c1", 2, &mut events).await;
    assert_eq!(res["error"], "Not allowed from a paired phone (step-up-required): session:setOptions", "{res}");
    let (_, saved) = post(d.port, "session:get", json!([sid]), Some(TOKEN)).await;
    assert_ne!(saved["mode"], "yolo", "a refused raise changed nothing: {saved}");

    // The phone fetches a challenge: single use, two minutes, and only the kinds of method.
    let req = json!({ "type": "req", "id": 3, "channel": "security:challenge", "args": [] });
    agent.send(client("c1", req)).await.unwrap();
    let res = reply_to(&mut agent, &key, "c1", 3, &mut events).await;
    let c = &res["result"];
    assert_eq!(c["required"], true, "{res}");
    assert_eq!(c["methods"], json!(["security-key", "totp"]), "{res}");
    // The relying-party id rides along so the phone's FIDO2 client can name it (SK-6); it is no secret.
    assert_eq!(c["rpId"], RP_ID, "{res}");
    assert_eq!(c.as_object().map(|o| o.len()), Some(5), "nothing else about the methods: {res}");
    assert!(!res.to_string().contains("YubiKey"), "no method names reach a phone: {res}");
    let challenge = c["challenge"].as_str().expect("a challenge").to_string();

    // The key answers it, and the raise runs.
    let assertion = fido2_assertion(&fido, RP_ID, &credential, &challenge, 1);
    agent.send(raise(4, Some(assertion.clone()))).await.unwrap();
    let res = reply_to(&mut agent, &key, "c1", 4, &mut events).await;
    assert!(res.get("error").is_none(), "{res}");
    let (_, saved) = post(d.port, "session:get", json!([sid]), Some(TOKEN)).await;
    assert_eq!(saved["mode"], "yolo", "{saved}");
    let stored: Value = serde_json::from_str(&std::fs::read_to_string(data.join("security.json")).unwrap()).unwrap();
    assert_eq!(stored["credentials"][0]["counter"], 1, "the counter is kept: {stored}");
    assert!(stored["credentials"][0]["lastUsedAt"].is_number(), "{stored}");

    // The desktop puts the chat back in Ask; the same assertion again is a
    // replay, even inside the five-minute cover, and the chat stays in Ask.
    post(d.port, "session:setOptions", json!([sid, { "mode": "ask" }]), Some(TOKEN)).await;
    agent.send(raise(5, Some(assertion))).await.unwrap();
    let res = reply_to(&mut agent, &key, "c1", 5, &mut events).await;
    assert_eq!(res["error"], "Not allowed from a paired phone (step-up-replayed): session:setOptions", "{res}");
    let (_, saved) = post(d.port, "session:get", json!([sid]), Some(TOKEN)).await;
    assert_eq!(saved["mode"], "ask", "{saved}");
    let (_, activity) = post(d.port, "remote:activity", json!(["phone-1"]), Some(TOKEN)).await;
    let reasons: Vec<Value> = activity
        .as_array()
        .unwrap()
        .iter()
        .filter(|a| a["channel"] == "session:setOptions")
        .map(|a| a["reason"].clone())
        .collect();
    assert_eq!(reasons, [json!("step-up-required"), Value::Null, json!("step-up-replayed")], "{activity}");

    // phone-2 has Change off: it may still stop remote access (a safety exit,
    // no proof, no step-up). Every phone is kicked and the agent hangs up
    // within a second.
    set_step_up(&data, false);
    post(d.port, "remote:setAccess", json!(["phone-2", { "change": false }]), Some(TOKEN)).await;
    let started = Instant::now();
    agent.send(client("c2", json!({ "type": "req", "id": 6, "channel": "remote:stop", "args": [] }))).await.unwrap();
    let mut kicked = Vec::new();
    let mut push_removed = Vec::new();
    let hung_up = tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            match agent.next().await {
                Some(Ok(Message::Text(t))) => {
                    let f: Value = serde_json::from_str(t.as_str()).unwrap();
                    // The relay closes each kicked phone with 4001 (apps/relay-server).
                    if f["type"] == "kick" {
                        kicked.push(f["cid"].as_str().unwrap().to_string());
                    }
                    if f["type"] == "push-remove" {
                        push_removed.push(f["deviceId"].clone());
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            }
        }
    })
    .await;
    assert!(hung_up.is_ok(), "the agent was still up after {:?}", started.elapsed());
    kicked.sort();
    assert_eq!(kicked, ["c1", "c2"], "every phone was kicked");
    // Disconnected, not signed out: each phone keeps its push token.
    assert!(push_removed.is_empty(), "remote:stop dropped push for {push_removed:?}");
    let (_, status) = post(d.port, "remote:status", json!([]), Some(TOKEN)).await;
    assert_eq!(status["enabled"], false, "{status}");
    assert_eq!(status["stoppedBy"]["deviceId"], "phone-2", "{status}");
    assert_eq!(status["stoppedBy"]["name"], "Philip's iPhone", "{status}");
    let (_, activity) = post(d.port, "remote:activity", json!(["phone-2"]), Some(TOKEN)).await;
    let stop = activity.as_array().unwrap().iter().find(|a| a["channel"] == "remote:stop").cloned();
    assert_eq!(stop.map(|a| a["ok"].clone()), Some(json!(true)), "{activity}");
    // It stays down: the agent does not dial the relay again.
    let redial = tokio::time::timeout(Duration::from_millis(1500), relay.accept()).await;
    assert!(redial.is_err(), "the agent dialled the relay again after remote:stop");
    drop(d);
    let _ = std::fs::remove_dir_all(&data);
}

/// One Nekko Cloud machine as the image runs it in relay-agent mode
/// (apps/local-web-ui/src/relay-agent.ts): nekkod on the machine's own data
/// directory with its own `security.json`, `remote:attach` to the room Nekko
/// Cloud minted, one phone paired with the printed code (its Change key
/// registered) and a chat in Ask.
struct Machine {
    d: Daemon,
    agent: RelaySide,
    key: nekko_remote::e2e::Key,
    phones: Phones,
    change: p256::ecdsa::SigningKey,
    sid: String,
    data: std::path::PathBuf,
    next: i64,
}

impl Machine {
    async fn start(name: &str, security: &Value) -> Self {
        use base64::Engine;
        let data = std::env::temp_dir().join(format!("nekkod-cloud-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        std::fs::create_dir_all(data.join("sessions")).unwrap();
        std::fs::write(data.join("security.json"), security.to_string()).unwrap();
        let d = start_with(&data);
        set_step_up(&data, false);
        let relay = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://127.0.0.1:{}/", relay.local_addr().unwrap().port());
        let (room, secret) = (format!("room-{name}"), format!("pair-key-{name}"));
        let (status, _) =
            post(d.port, "remote:attach", json!([{ "relayUrl": url, "room": room, "secret": secret }]), Some(TOKEN))
                .await;
        assert_eq!(status, 200);
        let (tcp, _) =
            tokio::time::timeout(Duration::from_secs(20), relay.accept()).await.expect("the agent dials").unwrap();
        let mut agent = tokio_tungstenite::accept_async(tcp).await.unwrap();
        let key = nekko_remote::e2e::derive_key(&secret, &room);
        let (_, grant) = post(d.port, "remote:pair", json!([]), Some(TOKEN)).await;
        let phones = Phones::new(&room);
        open_conn(&mut agent, &key, &phones, "c1").await;
        let hello = json!({ "type": "hello", "deviceId": "phone-1", "name": "Pixel", "platform": "android", "pair": grant["code"] });
        let mut m = Machine {
            d,
            agent,
            key,
            phones,
            change: p256::ecdsa::SigningKey::from_slice(&[7; 32]).unwrap(),
            sid: String::new(),
            data,
            next: 0,
        };
        m.send(hello).await;
        loop {
            let (_, sealed) = next_agent_frame(&mut m.agent, &m.key).await;
            if sealed.is_some_and(|s| s["type"] == "welcome") {
                break;
            }
        }
        set_step_up(&m.data, true);
        post(m.d.port, "settings:update", json!([{ "defaultChatMode": "ask" }]), Some(TOKEN)).await;
        let (_, chat) = post(m.d.port, "session:create", json!([]), Some(TOKEN)).await;
        m.sid = chat["id"].as_str().expect("a chat id").to_string();
        let public = base64::engine::general_purpose::STANDARD
            .encode(m.change.verifying_key().to_encoded_point(false).as_bytes());
        let res = m.call("device:registerKey", json!([public]), true, None).await;
        assert_eq!(res["result"], json!({ "registered": true }), "{res}");
        m
    }

    async fn send(&mut self, v: Value) {
        let v = self.phones.frame("c1", v);
        let data = json!({ "enc": nekko_remote::e2e::seal_with_iv(&self.key, &v, nekko_remote::e2e::random_iv()) });
        let frame = json!({ "type": "c", "cid": "c1", "data": data.to_string() });
        self.agent.send(Message::text(frame.to_string())).await.unwrap();
    }

    /// The phone's call, with a fresh Change proof when `signed`.
    async fn call(&mut self, channel: &str, args: Value, signed: bool, step_up: Option<Value>) -> Value {
        self.next += 1;
        let id = self.next as u32;
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        let mut req = json!({ "type": "req", "id": id, "channel": channel, "args": args });
        if signed {
            req["proof"] = change_proof(&self.change, "phone-1", channel, &args, now + self.next);
        }
        if let Some(s) = step_up {
            req["stepUp"] = s;
        }
        self.send(req).await;
        reply_to(&mut self.agent, &self.key, "c1", id, &mut Vec::new()).await
    }

    async fn raise(&mut self, step_up: Option<Value>) -> Value {
        let args = json!([self.sid, { "mode": "yolo" }]);
        self.call("session:setOptions", args, true, step_up).await
    }

    fn security(&self) -> Value {
        serde_json::from_str(&std::fs::read_to_string(self.data.join("security.json")).unwrap()).unwrap()
    }
}

/// SK-9: a Nekko Cloud machine is a computer like any other. In relay-agent
/// mode its nekkod runs the same step-up gate, against `security.json` in
/// that machine's own data directory: methods are per machine, so a key
/// registered on one machine answers nothing on another (the rpId differs),
/// and the challenge a phone gets names only the kinds of method.
#[tokio::test(flavor = "multi_thread")]
async fn each_cloud_machine_asks_for_its_own_step_up() {
    let (key_a, cred_a, rp_a) =
        (p256::ecdsa::SigningKey::from_slice(&[11; 32]).unwrap(), [0xa1u8; 16], "nekko-computer:machine-a");
    let (key_b, cred_b, rp_b) =
        (p256::ecdsa::SigningKey::from_slice(&[12; 32]).unwrap(), [0xb2u8; 16], "nekko-computer:machine-b");
    let mut a = Machine::start("a", &security_json(rp_a, &key_a, &cred_a, "Key for machine A")).await;
    let mut b = Machine::start("b", &security_json(rp_b, &key_b, &cred_b, "Key for machine B")).await;
    for m in [&mut a, &mut b] {
        let res = m.raise(None).await;
        assert_eq!(res["error"], "Not allowed from a paired phone (step-up-required): session:setOptions", "{res}");
    }

    // Machine A's key, even for machine B's own challenge, is not one of B's methods.
    let c = b.call("security:challenge", json!([]), false, None).await;
    assert_eq!(c["result"]["methods"], json!(["security-key", "totp"]), "{c}");
    assert!(!c.to_string().contains("machine B"), "no method names reach a phone: {c}");
    let challenge = c["result"]["challenge"].as_str().unwrap().to_string();
    let res = b.raise(Some(fido2_assertion(&key_a, rp_a, &cred_a, &challenge, 1))).await;
    assert_eq!(res["error"], "Not allowed from a paired phone (step-up-invalid): session:setOptions", "{res}");
    // Nor is machine B's key with machine A's rpId (a credential is bound to one machine).
    let c = b.call("security:challenge", json!([]), false, None).await;
    let challenge = c["result"]["challenge"].as_str().unwrap().to_string();
    let res = b.raise(Some(fido2_assertion(&key_b, rp_a, &cred_b, &challenge, 1))).await;
    assert_eq!(res["error"], "Not allowed from a paired phone (step-up-invalid): session:setOptions", "{res}");
    // Machine B's own key on its own rpId answers.
    let c = b.call("security:challenge", json!([]), false, None).await;
    let challenge = c["result"]["challenge"].as_str().unwrap().to_string();
    let res = b.raise(Some(fido2_assertion(&key_b, rp_b, &cred_b, &challenge, 2))).await;
    assert!(res.get("error").is_none(), "{res}");
    assert_eq!(b.security()["credentials"][0]["counter"], 2);
    // Machine A is untouched by what happened on machine B, and still asks.
    assert_eq!(a.security()["credentials"][0]["counter"], 0);
    let res = a.raise(None).await;
    assert_eq!(res["error"], "Not allowed from a paired phone (step-up-required): session:setOptions", "{res}");
    let c = a.call("security:challenge", json!([]), false, None).await;
    let challenge = c["result"]["challenge"].as_str().unwrap().to_string();
    let res = a.raise(Some(fido2_assertion(&key_a, rp_a, &cred_a, &challenge, 1))).await;
    assert!(res.get("error").is_none(), "{res}");
    for m in [a, b] {
        drop(m.d);
        let _ = std::fs::remove_dir_all(&m.data);
    }
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
    let d = start_with_config(&data, json!({ "telegramApiUrl": format!("http://127.0.0.1:{}", tg.port) }));

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
