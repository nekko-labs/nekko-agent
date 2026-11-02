//! Two real daemons, the way a MacBook reaches a desktop: one pairs with the
//! other through a relay and calls across it. The relay here only moves frames.

use crate::common::*;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

type Tx = mpsc::UnboundedSender<Message>;

#[derive(Default)]
struct Room {
    agent: Option<Tx>,
    clients: HashMap<String, Tx>,
}

/// The relay's frame rules (apps/relay-server/src/server.ts), one room.
async fn relay() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let room: Arc<Mutex<Room>> = Arc::default();
    tokio::spawn(async move {
        let mut next = 0;
        while let Ok((tcp, _)) = listener.accept().await {
            next += 1;
            let (room, cid) = (room.clone(), format!("c{next}"));
            tokio::spawn(async move {
                let mut agent = false;
                #[allow(clippy::result_large_err)] // tungstenite's callback signature
                let ws = tokio_tungstenite::accept_hdr_async(
                    tcp,
                    |req: &tokio_tungstenite::tungstenite::handshake::server::Request,
                     res: tokio_tungstenite::tungstenite::handshake::server::Response| {
                        agent = req.uri().to_string().contains("role=agent");
                        Ok(res)
                    },
                )
                .await
                .unwrap();
                let (mut sink, mut stream) = ws.split();
                let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
                tokio::spawn(async move {
                    while let Some(m) = rx.recv().await {
                        let close = matches!(m, Message::Close(_));
                        if sink.send(m).await.is_err() || close {
                            return;
                        }
                    }
                });
                let text = |v: Value| Message::text(v.to_string());
                {
                    let mut r = room.lock().unwrap();
                    if agent {
                        r.agent = Some(tx.clone());
                        for (id, c) in &r.clients {
                            let _ = c.send(text(json!({ "type": "agent-online" })));
                            let _ = tx.send(text(json!({ "type": "client-open", "cid": id })));
                        }
                    } else {
                        r.clients.insert(cid.clone(), tx.clone());
                        let online = r.agent.is_some();
                        let _ = tx.send(text(json!({ "type": if online { "agent-online" } else { "agent-offline" } })));
                        if let Some(a) = &r.agent {
                            let _ = a.send(text(json!({ "type": "client-open", "cid": cid })));
                        }
                    }
                }
                while let Some(Ok(m)) = stream.next().await {
                    let Message::Text(t) = m else { continue };
                    let r = room.lock().unwrap();
                    if !agent {
                        if let Some(a) = &r.agent {
                            let _ = a.send(text(json!({ "type": "c", "cid": cid, "data": t.as_str() })));
                        }
                        continue;
                    }
                    let f: Value = serde_json::from_str(t.as_str()).unwrap();
                    let Some(c) = f["cid"].as_str().and_then(|id| r.clients.get(id)) else { continue };
                    match f["type"].as_str() {
                        Some("d") => {
                            let _ = c.send(Message::text(f["data"].as_str().unwrap()));
                        }
                        Some("kick") => {
                            let close = tokio_tungstenite::tungstenite::protocol::CloseFrame {
                                code: 4001.into(),
                                reason: "kicked by agent".into(),
                            };
                            let _ = c.send(Message::Close(Some(close)));
                        }
                        _ => {}
                    }
                }
                let mut r = room.lock().unwrap();
                if agent {
                    r.agent = None;
                    for c in r.clients.values() {
                        let _ = c.send(Message::text(json!({ "type": "agent-offline" }).to_string()));
                    }
                } else {
                    r.clients.remove(&cid);
                    if let Some(a) = &r.agent {
                        let _ = a.send(Message::text(json!({ "type": "client-close", "cid": cid }).to_string()));
                    }
                }
            });
        }
    });
    url
}

/// A call as the desktop window makes it, on its socket.
struct Window {
    socket: Socket,
    next: u64,
}

impl Window {
    async fn open(port: u16) -> Self {
        Self { socket: ws(port, &format!("/api/ws?token={TOKEN}"), None).await.unwrap(), next: 0 }
    }

    async fn call(&mut self, channel: &str, args: Value) -> Result<Value, String> {
        self.next += 1;
        let frame = json!({ "id": self.next, "channel": channel, "args": args });
        self.socket.send(Message::text(frame.to_string())).await.unwrap();
        loop {
            let v = next_json(&mut self.socket, Duration::from_secs(40)).await.expect("a reply");
            if v["id"] != json!(self.next) {
                continue;
            }
            return match v["error"].as_str() {
                Some(e) => Err(e.to_string()),
                None => Ok(v["result"].clone()),
            };
        }
    }

    async fn state_of(&mut self, id: &str) -> String {
        let list = self.call("computers:list", json!([])).await.unwrap();
        let found = list.as_array().unwrap().iter().find(|c| c["id"] == id).cloned();
        found.map_or_else(String::new, |c| c["state"].as_str().unwrap().to_string())
    }

    async fn wait_state(&mut self, id: &str, want: &str) {
        for _ in 0..200 {
            if self.state_of(id).await == want {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("never reached {want}: {}", self.state_of(id).await);
    }
}

fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("nekkod-computers-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

const FILE_VAULT: &[(&str, Option<&str>)] = &[("NEKKO_FILE_VAULT", Some("1"))];

#[tokio::test(flavor = "multi_thread")]
async fn one_daemon_pairs_with_another_and_calls_across() {
    let url = relay().await;
    let (host_dir, laptop_dir) = (scratch("host"), scratch("laptop"));
    let host = start_with_env(&host_dir, json!({}), FILE_VAULT);
    let laptop = start_with_env(&laptop_dir, json!({}), FILE_VAULT);

    let (_, status) = post(host.port, "remote:enable", json!([url]), Some(TOKEN)).await;
    assert_eq!(status["enabled"], true, "{status}");
    let (_, pairing) = post(host.port, "remote:pairing", json!([]), Some(TOKEN)).await;
    let (_, grant) = post(host.port, "remote:pairComputer", json!([]), Some(TOKEN)).await;
    let link =
        json!({ "relayUrl": url, "room": pairing["room"], "key": pairing["key"], "pair": grant["code"], "alts": [] });

    let mut window = Window::open(laptop.port).await;
    let paired = window.call("computers:pair", json!([link])).await.unwrap();
    let id = paired["id"].as_str().unwrap().to_string();
    window.wait_state(&id, "online").await;

    // The agent's paths never reach it: only the window's socket does.
    let (code, body) = post(laptop.port, "computers:list", json!([]), Some(TOKEN)).await;
    assert_ne!(code, 200, "{body}");

    // A chat made on the host is visible, and readable whole, from here.
    let (_, chat) = post(host.port, "session:create", json!([{ "title": "On gomi" }]), Some(TOKEN)).await;
    let chat_id = chat["id"].as_str().unwrap();
    let list = window.call("computers:call", json!([id, "sessions:summaries", []])).await.unwrap();
    assert!(list.to_string().contains(chat_id), "{list}");
    let read = window.call("computers:call", json!([id, "session:get", [chat_id]])).await.unwrap();
    assert_eq!(read["id"], json!(chat_id));

    // It has the computer class, and no reach into the host's accounts.
    let replay = window.call("computers:call", json!([id, "agent:replay", [chat_id]])).await.unwrap();
    assert!(replay.is_null(), "{replay}");
    let refused = window.call("computers:call", json!([id, "providers:save", [{}]])).await.unwrap_err();
    assert!(refused.contains("channel-denied"), "{refused}");

    // The list on disk holds no secret.
    let saved = std::fs::read_to_string(laptop_dir.join("computers.json")).unwrap();
    assert!(!saved.contains(pairing["key"].as_str().unwrap()), "{saved}");

    // Still paired after the laptop restarts, and with no code.
    drop(window);
    drop(laptop);
    let laptop = start_with_env(&laptop_dir, json!({}), FILE_VAULT);
    let mut window = Window::open(laptop.port).await;
    window.wait_state(&id, "online").await;

    // The host removes it: the link stops for good.
    let (_, devices) = post(host.port, "remote:devices", json!([]), Some(TOKEN)).await;
    let device = devices[0]["id"].as_str().unwrap();
    assert_eq!(devices[0]["kind"], "computer", "{devices}");
    post(host.port, "remote:revoke", json!([device]), Some(TOKEN)).await;
    window.wait_state(&id, "denied").await;

    drop(window);
    drop(laptop);
    drop(host);
    let _ = std::fs::remove_dir_all(host_dir);
    let _ = std::fs::remove_dir_all(laptop_dir);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_phone_link_is_refused_with_what_to_do() {
    let url = relay().await;
    let (host_dir, laptop_dir) = (scratch("host2"), scratch("laptop2"));
    let host = start_with_env(&host_dir, json!({}), FILE_VAULT);
    let laptop = start_with_env(&laptop_dir, json!({}), FILE_VAULT);
    post(host.port, "remote:enable", json!([url]), Some(TOKEN)).await;
    let (_, pairing) = post(host.port, "remote:pairing", json!([]), Some(TOKEN)).await;
    let (_, grant) = post(host.port, "remote:pair", json!([]), Some(TOKEN)).await;
    let link =
        json!({ "relayUrl": url, "room": pairing["room"], "key": pairing["key"], "pair": grant["code"], "alts": [] });
    let mut window = Window::open(laptop.port).await;
    let refused = window.call("computers:pair", json!([link])).await.unwrap_err();
    assert!(refused.contains("for a phone"), "{refused}");
    assert_eq!(window.call("computers:list", json!([])).await.unwrap(), json!([]));
    drop(host);
    drop(laptop);
    let _ = std::fs::remove_dir_all(host_dir);
    let _ = std::fs::remove_dir_all(laptop_dir);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_window_runs_a_chat_on_another_computer_and_sees_it_stream() {
    let url = relay().await;
    let rig = turn_rig(
        "computers-host",
        json!({ "id": "s_gomi", "title": "On gomi", "messages": [], "createdAt": 1, "updatedAt": 1 }),
    );
    let model = scripted_model(vec![say_text("Hello from gomi")]).await;
    let provider = json!({
        "id": "p1", "kind": "openai-compat", "label": "Scripted", "enabled": true,
        "baseUrl": format!("http://127.0.0.1:{}/v1", model.port),
    });
    write_settings(&rig, json!({ "providers": [provider], "modelCatalog": { "p1": [{ "id": "synthetic" }] } })).await;

    let laptop_dir = scratch("laptop3");
    let laptop = start_with_env(&laptop_dir, json!({}), FILE_VAULT);
    let host = rig.d.port;
    post(host, "remote:enable", json!([url]), Some(TOKEN)).await;
    let (_, pairing) = post(host, "remote:pairing", json!([]), Some(TOKEN)).await;
    let (_, grant) = post(host, "remote:pairComputer", json!([]), Some(TOKEN)).await;
    let link =
        json!({ "relayUrl": url, "room": pairing["room"], "key": pairing["key"], "pair": grant["code"], "alts": [] });

    let mut window = Window::open(laptop.port).await;
    let id = window.call("computers:pair", json!([link])).await.unwrap()["id"].as_str().unwrap().to_string();
    window.wait_state(&id, "online").await;
    let chat = format!("@{id}:s_gomi");

    // The merged list has it, under its qualified id, without any network call.
    let mut listed = false;
    for _ in 0..100 {
        let list = window.call("sessions:summaries", json!([])).await.unwrap();
        listed = list.as_array().unwrap().iter().any(|c| c["id"] == json!(chat));
        if listed {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(listed, "the host's chat shows here");

    // The other surfaces see this computer only.
    let (_, api) = post(laptop.port, "sessions:summaries", json!([]), Some(TOKEN)).await;
    assert!(!api.to_string().contains(&chat), "{api}");

    // Read it, then run it, through the same channels a local chat uses.
    let read = window.call("session:get", json!([chat])).await.unwrap();
    assert_eq!(read["id"], json!(chat));

    let mut stream = ws(laptop.port, &format!("/api/ws?token={TOKEN}"), None).await.unwrap();
    let send = json!({ "sessionId": chat, "providerId": "p1", "modelId": "synthetic", "text": "Say hello" });
    window.call("chat:send", json!([send])).await.unwrap();
    let mut said = String::new();
    let mut done = false;
    while let Some(frame) = next_json(&mut stream, Duration::from_secs(10)).await {
        if frame["channel"] != "agent:event" {
            continue;
        }
        assert_eq!(frame["payload"]["sessionId"], json!(chat), "{frame}");
        said.push_str(frame["payload"]["delta"].as_str().unwrap_or_default());
        if frame["payload"]["type"] == "done" {
            done = true;
            break;
        }
    }
    assert!(done && said.contains("Hello from gomi"), "{said}");

    // The turn ran over there: the model was called on the host, with no credential here.
    assert_eq!(model.requests.lock().unwrap().len(), 1);
    let after = window.call("session:get", json!([chat])).await.unwrap();
    assert!(after["messages"].to_string().contains("Hello from gomi"), "{after}");

    // A foreign id never reaches a channel that isn't routed.
    let refused = window.call("workspace:remove", json!([chat])).await.unwrap_err();
    assert!(refused.contains("Do this on that computer"), "{refused}");

    drop(window);
    drop(laptop);
    let _ = std::fs::remove_dir_all(laptop_dir);
}
