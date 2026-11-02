//! The relay client against the real host core: `AgentCore` and `RemoteService`
//! behind a stand-in relay that only moves frames, as the real one does.

use futures_util::{SinkExt, StreamExt};
use nekko_remote::agent::{AgentCore, Out};
use nekko_remote::client::{Client, Config, State};
use nekko_remote::e2e;
use nekko_remote::hello::{Random, os_random};
use nekko_remote::phone::Devices;
use nekko_remote::{Link, LinkHandle, RemoteService, Verifier, system_clock};
use p256::ecdsa::SigningKey;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

struct NoLink;
struct NoHandle;
impl Link for NoLink {
    fn connect(
        &self,
        _: &str,
        _: &str,
        _: &str,
        _: nekko_remote::client::SigningKey,
        _: Verifier,
    ) -> Arc<dyn LinkHandle> {
        Arc::new(NoHandle)
    }
}
impl LinkHandle for NoHandle {
    fn stop(&self) {}
    fn kick_device(&self, _: &str) {}
    fn is_online(&self) -> bool {
        true
    }
    fn connected_devices(&self) -> Vec<String> {
        Vec::new()
    }
    fn last_error(&self) -> Option<String> {
        None
    }
}

struct Host {
    svc: Arc<RemoteService>,
    room: String,
    secret: String,
    url: String,
    /// `(deviceId, channel, args)` of each call the host ran.
    calls: Arc<Mutex<Vec<(String, String, Value)>>>,
    /// Close every socket with this code and reason.
    close: tokio::sync::broadcast::Sender<(u16, String)>,
    /// Send the client this host event.
    event: tokio::sync::broadcast::Sender<(String, Value)>,
    /// The host key the client pins.
    pinned: String,
    /// Frames that reached the host.
    heard: Arc<std::sync::atomic::AtomicUsize>,
    /// Send the client this frame under the room key, as anyone ever paired can.
    forge: tokio::sync::broadcast::Sender<Value>,
    _dir: tempfile::TempDir,
}

fn signing_key(seed: u8) -> SigningKey {
    SigningKey::from_slice(&[seed; 32]).unwrap()
}

async fn host() -> Host {
    host_signed_with(None).await
}

/// A host signing challenges with `impostor` in place of its own key.
async fn host_signed_with(impostor: Option<SigningKey>) -> Host {
    let dir = tempfile::tempdir().unwrap();
    let random: Random = os_random();
    let svc = RemoteService::new(dir.path(), random, system_clock(), Box::new(NoLink));
    svc.enable(&json!("ws://127.0.0.1:1")).unwrap();
    let pairing = svc.pairing();
    let (room, secret) = (pairing["room"].as_str().unwrap().to_string(), pairing["key"].as_str().unwrap().to_string());
    let pinned = pairing["hostKey"].as_str().unwrap().to_string();
    let saved: Value = serde_json::from_slice(&std::fs::read(dir.path().join("remote.json")).unwrap()).unwrap();
    let real = nekko_remote::proof::parse_key_text(saved["hostKey"].as_str().unwrap()).unwrap();
    let host_key = impostor.unwrap_or(real);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let calls: Arc<Mutex<Vec<(String, String, Value)>>> = Arc::default();
    let heard: Arc<std::sync::atomic::AtomicUsize> = Arc::default();
    let (forge, _) = tokio::sync::broadcast::channel::<Value>(4);
    let (close, _) = tokio::sync::broadcast::channel::<(u16, String)>(4);
    let (event, _) = tokio::sync::broadcast::channel::<(String, Value)>(4);
    let (s, k, seen, closing, events, service) =
        (room.clone(), secret.clone(), calls.clone(), close.clone(), event.clone(), svc.clone());
    let (ears, forger) = (heard.clone(), forge.clone());
    tokio::spawn(async move {
        loop {
            let Ok((tcp, _)) = listener.accept().await else { return };
            let (s, k, seen, mut closing, mut events, service) =
                (s.clone(), k.clone(), seen.clone(), closing.subscribe(), events.subscribe(), service.clone());
            let (host_key, ears, mut forged) = (host_key.clone(), ears.clone(), forger.subscribe());
            tokio::spawn(async move {
                let Ok(ws) = tokio_tungstenite::accept_async(tcp).await else { return };
                let (mut sink, mut stream) = ws.split();
                let room_key = e2e::derive_key(&k, &s);
                let host = nekko_remote::agent::Host { room: s.clone(), key: host_key };
                let mut core = AgentCore::new(e2e::derive_key(&k, &s), host, Box::new(e2e::random_iv));
                let svc = service.clone();
                let verify = move |h: &Value| svc.verify(h);
                let relay_to_client = |frames: Vec<String>| {
                    frames
                        .into_iter()
                        .filter_map(|f| serde_json::from_str::<Value>(&f).ok())
                        .filter_map(|f| f["data"].as_str().map(str::to_string))
                        .collect::<Vec<_>>()
                };
                let first = core.on_relay(&json!({ "type": "client-open", "cid": "c1" }).to_string(), &verify);
                let hello: Vec<String> =
                    first.into_iter().filter_map(|o| if let Out::Send(f) = o { Some(f) } else { None }).collect();
                for data in relay_to_client(hello) {
                    sink.send(Message::text(data)).await.unwrap();
                }
                loop {
                    tokio::select! {
                        c = closing.recv() => {
                            let Ok((code, reason)) = c else { return };
                            let frame = CloseFrame { code: CloseCode::from(code), reason: reason.into() };
                            let _ = sink.send(Message::Close(Some(frame))).await;
                            // Read to the end, as a real relay does: a socket dropped with
                            // bytes unread resets, and on Windows that loses the close frame.
                            while matches!(stream.next().await, Some(Ok(_))) {}
                            return;
                        }
                        f = forged.recv() => {
                            let Ok(f) = f else { return };
                            let sealed = json!({ "enc": e2e::seal_with_iv(&room_key, &f, e2e::random_iv()) });
                            sink.send(Message::text(sealed.to_string())).await.unwrap();
                        }
                        e = events.recv() => {
                            let Ok((channel, payload)) = e else { return };
                            for data in relay_to_client(core.on_event(&channel, &payload)) {
                                sink.send(Message::text(data)).await.unwrap();
                            }
                        }
                        msg = stream.next() => {
                            let Some(Ok(Message::Text(text))) = msg else {
                                if matches!(msg, Some(Ok(_))) { continue; }
                                return;
                            };
                            ears.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                            let frame = json!({ "type": "c", "cid": "c1", "data": text.as_str() }).to_string();
                            for out in core.on_relay(&frame, &verify) {
                                let replies = match out {
                                    Out::Send(f) => vec![f],
                                    Out::Dispatch { cid, id, device_id, channel, args, proof, .. } => {
                                        seen.lock().unwrap().push((device_id.clone(), channel.clone(), args.clone()));
                                        let result = if channel == "device:registerKey" {
                                            let key = args[0].as_str().unwrap();
                                            assert!(proof.is_some(), "a key is registered with a proof");
                                            service.register_key(&device_id, key).map(|_| json!({ "registered": true })).map_err(str::to_string)
                                        } else {
                                            Ok(json!({ "echo": args }))
                                        };
                                        core.reply(&cid, id, result).into_iter().collect()
                                    }
                                };
                                for data in relay_to_client(replies) {
                                    sink.send(Message::text(data)).await.unwrap();
                                }
                            }
                        }
                    }
                }
            });
        }
    });
    Host { svc, room, secret, pinned, url, calls, close, event, heard, forge, _dir: dir }
}

fn config(h: &Host, code: Option<String>) -> Config {
    Config {
        routes: vec![h.url.clone()],
        room: h.room.clone(),
        secret: h.secret.clone(),
        host_key: h.pinned.clone(),
        device_id: "macbook".into(),
        name: "MacBook".into(),
        key: signing_key(7),
        pair_code: code,
    }
}

async fn settled(c: &Client, want: impl Fn(&State) -> bool) -> State {
    let mut rx = c.watch();
    let s = tokio::time::timeout(Duration::from_secs(10), rx.wait_for(|s| want(&s.state))).await;
    s.expect("state in time").expect("link alive").state.clone()
}

#[tokio::test]
async fn a_computer_grant_enrolls_a_computer_and_registers_its_key() {
    let h = host().await;
    let code = h.svc.pair_computer()["code"].as_str().unwrap().to_string();
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let client = Client::start(config(&h, Some(code)), tx);
    settled(&client, |s| *s == State::Online).await;

    assert_eq!(client.status().device["kind"], "computer");
    assert_eq!(client.status().protocol, nekko_remote::hello::PROTOCOL_VERSION);
    let device = h.svc.device("macbook").expect("enrolled");
    assert!(device.computer, "the record carries the class");
    // Registered in the background right after the welcome.
    for _ in 0..50 {
        if h.svc.device("macbook").unwrap().key.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(h.svc.device("macbook").unwrap().key.is_some());
    client.stop();
}

#[tokio::test]
async fn a_phone_grant_does_not_pair_a_computer() {
    let h = host().await;
    let code = h.svc.pair()["code"].as_str().unwrap().to_string();
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let client = Client::start(config(&h, Some(code)), tx);
    let state = settled(&client, |s| matches!(s, State::Denied(_))).await;
    assert_eq!(state, State::Denied("bad-code".into()));
    assert!(h.svc.device("macbook").is_none());
}

#[tokio::test]
async fn calls_are_numbered_and_answered_and_events_arrive() {
    let h = host().await;
    let code = h.svc.pair_computer()["code"].as_str().unwrap().to_string();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let client = Client::start(config(&h, Some(code)), tx);
    settled(&client, |s| *s == State::Online).await;

    let one = client.call("sessions:summaries", json!([1])).await.unwrap();
    let two = client.call("sessions:summaries", json!([2])).await.unwrap();
    assert_eq!((one["echo"][0].as_i64(), two["echo"][0].as_i64()), (Some(1), Some(2)));

    h.event.send(("agent:event".into(), json!({ "type": "text", "sessionId": "s1" }))).unwrap();
    let (channel, payload) = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.unwrap().unwrap();
    assert_eq!((channel.as_str(), payload["sessionId"].as_str()), ("agent:event", Some("s1")));
    assert!(h.calls.lock().unwrap().iter().all(|(d, _, _)| d == "macbook"));
    client.stop();
}

#[tokio::test]
async fn reconnects_without_the_code_and_is_known_by_its_key() {
    let h = host().await;
    let code = h.svc.pair_computer()["code"].as_str().unwrap().to_string();
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let client = Client::start(config(&h, Some(code)), tx);
    settled(&client, |s| *s == State::Online).await;
    h.close.send((1001, "going away".into())).unwrap();
    settled(&client, |s| *s == State::Connecting).await;
    settled(&client, |s| *s == State::Online).await;
    assert_eq!(client.call("app:info", json!([])).await.unwrap()["echo"], json!([]));
    client.stop();
}

#[tokio::test]
async fn another_key_on_the_same_device_is_refused() {
    let h = host().await;
    let code = h.svc.pair_computer()["code"].as_str().unwrap().to_string();
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let client = Client::start(config(&h, Some(code)), tx.clone());
    settled(&client, |s| *s == State::Online).await;
    client.stop();
    let mut stolen = config(&h, None);
    stolen.key = signing_key(9);
    let thief = Client::start(stolen, tx);
    assert_eq!(settled(&thief, |s| matches!(s, State::Denied(_))).await, State::Denied("bad-key".into()));
}

#[tokio::test]
async fn a_close_is_not_a_removal_but_a_sealed_refusal_is() {
    let h = host().await;
    let code = h.svc.pair_computer()["code"].as_str().unwrap().to_string();
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let client = Client::start(config(&h, Some(code)), tx);
    settled(&client, |s| *s == State::Online).await;
    // Anyone holding the room credential can get the relay to send this.
    h.close.send((4001, "removed".into())).unwrap();
    settled(&client, |s| *s == State::Connecting).await;
    settled(&client, |s| *s == State::Online).await;
    // Really removed: the redial hears it sealed.
    h.svc.revoke(&json!("macbook")).unwrap();
    h.close.send((4001, "removed".into())).unwrap();
    assert_eq!(settled(&client, |s| matches!(s, State::Denied(_))).await, State::Denied("revoked".into()));
    assert!(client.call("app:info", json!([])).await.is_err());
}

#[tokio::test]
async fn an_impostor_with_the_room_secret_hears_nothing() {
    let h = host_signed_with(Some(signing_key(11))).await;
    let code = h.svc.pair_computer()["code"].as_str().unwrap().to_string();
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let client = Client::start(config(&h, Some(code)), tx);
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(client.status().state, State::Connecting);
    assert_eq!(h.heard.load(std::sync::atomic::Ordering::SeqCst), 0, "not even a HELLO, let alone the code");
    client.stop();
}

#[tokio::test]
async fn the_room_key_can_forge_no_refusal_and_no_reply() {
    let h = host().await;
    let code = h.svc.pair_computer()["code"].as_str().unwrap().to_string();
    let (tx, mut events) = tokio::sync::mpsc::unbounded_channel();
    let client = Client::start(config(&h, Some(code)), tx);
    settled(&client, |s| *s == State::Online).await;
    h.forge.send(json!({ "type": "denied", "reason": "revoked" })).unwrap();
    h.forge.send(json!({ "type": "event", "channel": "agent:event", "payload": { "forged": true } })).unwrap();
    // A call after them proves they were read and ignored.
    assert_eq!(client.call("app:info", json!([])).await.unwrap()["echo"], json!([]));
    assert_eq!(client.status().state, State::Online);
    assert!(events.try_recv().is_err());
    client.stop();
}

#[tokio::test]
async fn a_dead_route_moves_on_to_the_next() {
    let h = host().await;
    let code = h.svc.pair_computer()["code"].as_str().unwrap().to_string();
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let mut cfg = config(&h, Some(code));
    cfg.routes.insert(0, "ws://127.0.0.1:1".into());
    let client = Client::start(cfg, tx);
    settled(&client, |s| *s == State::Online).await;
    assert_eq!(client.status().route.as_deref(), Some(h.url.as_str()));
    client.stop();
}
