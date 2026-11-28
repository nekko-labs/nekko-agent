//! Opening a chat on a computer of the same account found through an org's
//! fleet (decision 0102), end to end against a real Nekko Cloud API (the local
//! dev stack, organizations on: `DEV_CODE=123456 npm run dev:local` in
//! `apps/nekko-agent-api`). Skipped unless `NEKKO_CLOUD_ITEST_URL` is set:
//!
//!   NEKKO_CLOUD_ITEST_URL=http://127.0.0.1:4330 cargo test -p nekko-cloud --test live_fleet_connect -- --nocapture
//!
//! Real: the API, both devices' account keys and org keys, the sealed
//! descriptor and connect block, the fleet HELLO proof and the computer's
//! gate, the relay agent core (`AgentCore` + `RemoteService`) and the desktop
//! client (`nekko_remote::client`). Stand-ins: the relay is a loopback socket
//! that moves frames as the real one does, and the computer's chat answers
//! with a canned reply instead of a model.

use futures_util::{SinkExt, StreamExt};
use nekko_cloud::vault::FileVault;
use nekko_cloud::{Cloud, ConnectInfo, FleetAdmitted, HelloBinding, HostInfo, LocalModel, Options};
use nekko_remote::agent::{AgentCore, Out};
use nekko_remote::client::{Client, Config, State};
use nekko_remote::e2e;
use nekko_remote::fleet::{Admitted, Binding, FleetGate, FleetSigner, link_device_id};
use nekko_remote::phone::Devices;
use nekko_remote::{Link, LinkHandle, RemoteService, Verifier, system_clock};
use nekko_store::SessionStore;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

const CODE: &str = "123456";

struct Device {
    cloud: Arc<Cloud>,
    connect: Arc<Mutex<Option<ConnectInfo>>>,
    _dir: tempfile::TempDir,
}

fn device(url: &str, label: &str) -> Device {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(SessionStore::new(dir.path()));
    let cloud = Cloud::new(Options {
        dir: dir.path().join("cloud"),
        api_url: url.into(),
        device_label: label.into(),
        sessions: store,
        vault: Box::new(FileVault::new(dir.path().join("cloud").join("secrets.json"))),
        publish: Arc::new(|_| {}),
        busy: Arc::new(|_| false),
    });
    let connect: Arc<Mutex<Option<ConnectInfo>>> = Arc::default();
    let (c, name) = (connect.clone(), label.to_string());
    cloud.set_host(HostInfo {
        app_version: "9.9.9-test".into(),
        name: Arc::new(move || name.clone()),
        models: Arc::new(|| {
            let m = LocalModel {
                id: "qwen3-8b".into(),
                label: "Qwen3 8B".into(),
                runtime: "llamacpp".into(),
                size_bytes: None,
            };
            Box::pin(async move { vec![m] })
        }),
        reach: None,
        connect: Some(Arc::new(move || c.lock().unwrap().clone())),
        runners: None,
    });
    Device { cloud, connect, _dir: dir }
}

async fn call(d: &Device, channel: &str, args: Value) -> Result<Value, String> {
    d.cloud.route(channel, args.as_array().unwrap()).await
}

async fn sign_in(d: &Device, email: &str) {
    call(d, "cloud:sendCode", json!([email])).await.unwrap();
    let s = call(d, "cloud:verifyCode", json!([email, CODE])).await.unwrap();
    assert!(s["signedIn"] == true, "sign-in didn't finish");
}

/// The computer's gate, as the daemon wires it (`crates/nekkod/src/fleet.rs`).
struct CloudGate(Arc<Cloud>);

impl FleetGate for CloudGate {
    fn admit(&self, fleet: &Value, b: &Binding) -> Result<Admitted, &'static str> {
        let hb = HelloBinding {
            room: &b.room,
            challenge: &b.challenge,
            host_eph: &b.host_eph,
            client_eph: &b.client_eph,
            hello_key: &b.hello_key,
        };
        let a = self.0.fleet_admit(fleet, &hb)?;
        Ok(Admitted { device_id: a.device_id, org_id: a.org_id, key_id: a.key_id, name: a.name })
    }
    fn still(&self, a: &Admitted) -> bool {
        self.0.fleet_still(&FleetAdmitted {
            device_id: a.device_id.clone(),
            org_id: a.org_id.clone(),
            key_id: a.key_id,
            name: a.name.clone(),
        })
    }
}

/// The desktop's signer, as the daemon wires it.
fn signer(cloud: Arc<Cloud>, org: String) -> FleetSigner {
    Arc::new(move |b: &Binding| {
        let hb = HelloBinding {
            room: &b.room,
            challenge: &b.challenge,
            host_eph: &b.host_eph,
            client_eph: &b.client_eph,
            hello_key: &b.hello_key,
        };
        cloud.fleet_hello(&org, &hb)
    })
}

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

/// The computer's relay agent behind a loopback relay. Its chat answers with
/// a canned reply and a streamed `agent:event`. Returns the service and the url.
async fn computer(svc: Arc<RemoteService>, room: String, secret: String, host_key: p256::ecdsa::SigningKey) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        loop {
            let Ok((tcp, _)) = listener.accept().await else { return };
            let (svc, room, secret, host_key) = (svc.clone(), room.clone(), secret.clone(), host_key.clone());
            tokio::spawn(async move {
                let Ok(ws) = tokio_tungstenite::accept_async(tcp).await else { return };
                let (mut sink, mut stream) = ws.split();
                let host = nekko_remote::agent::Host { room: room.clone(), key: host_key };
                let mut core = AgentCore::new(e2e::derive_key(&secret, &room), host, Box::new(e2e::random_iv));
                let verify_svc = svc.clone();
                let verify = move |h: &Value| verify_svc.verify(h);
                let data = |frames: Vec<String>| -> Vec<String> {
                    frames
                        .into_iter()
                        .filter_map(|f| serde_json::from_str::<Value>(&f).ok())
                        .filter_map(|f| f["data"].as_str().map(str::to_string))
                        .collect()
                };
                let sends = |outs: Vec<Out>| -> Vec<String> {
                    outs.into_iter().filter_map(|o| if let Out::Send(f) = o { Some(f) } else { None }).collect()
                };
                let first = core.on_relay(&json!({ "type": "client-open", "cid": "c1" }).to_string(), &verify);
                for d in data(sends(first)) {
                    sink.send(Message::text(d)).await.unwrap();
                }
                while let Some(Ok(msg)) = stream.next().await {
                    let Message::Text(text) = msg else { continue };
                    let frame = json!({ "type": "c", "cid": "c1", "data": text.as_str() }).to_string();
                    for out in core.on_relay(&frame, &verify) {
                        let mut replies = Vec::new();
                        match out {
                            Out::Send(f) => replies.push(f),
                            Out::Dispatch { cid, id, device_id, channel, args, .. } => {
                                // Only an admitted device gets anything: the phone gate's question.
                                let known = svc.device(&device_id).is_some();
                                let result = match (known, channel.as_str()) {
                                    (false, _) => Err("device-unknown".to_string()),
                                    (true, "chat:send") => {
                                        let sid = args[0]["sessionId"].as_str().unwrap_or("s").to_string();
                                        let event = json!({ "type": "text", "sessionId": sid, "delta": "Hello from the desk." });
                                        replies.extend(core.on_event("agent:event", &event));
                                        replies.extend(
                                            core.on_event("agent:event", &json!({ "type": "done", "sessionId": sid })),
                                        );
                                        Ok(json!({ "ok": true, "by": device_id }))
                                    }
                                    (true, _) => Ok(json!({ "echo": args })),
                                };
                                replies.extend(core.reply(&cid, id, result));
                            }
                        }
                        for d in data(replies) {
                            sink.send(Message::text(d)).await.unwrap();
                        }
                    }
                }
            });
        }
    });
    url
}

#[tokio::test]
async fn a_device_of_the_account_opens_a_chat_on_a_shared_computer_and_loses_it_when_the_account_changes() {
    let Ok(url) = std::env::var("NEKKO_CLOUD_ITEST_URL") else {
        eprintln!("NEKKO_CLOUD_ITEST_URL not set; skipping");
        return;
    };
    let tag = format!("{}-{}", std::process::id(), nekko_js::now_ms());
    let email = format!("fleet-connect-{tag}@example.com");
    let desk = device(&url, "Desk-PC");
    let laptop = device(&url, "Laptop");

    // The desk: signed in, unlocked, an org, remote access on (a relay agent and its pairing).
    sign_in(&desk, &email).await;
    let recovery = call(&desk, "sync:turnOn", json!([])).await.unwrap()["recoveryKey"].as_str().unwrap().to_string();
    call(&desk, "sync:setEnabled", json!([false])).await.unwrap();
    let org = call(&desk, "org:create", json!(["Nekko Labs"])).await.unwrap();
    let org_id = org["id"].as_str().unwrap().to_string();
    let rdir = tempfile::tempdir().unwrap();
    let svc = RemoteService::new(rdir.path(), nekko_remote::hello::os_random(), system_clock(), Box::new(NoLink));
    svc.enable(&json!("ws://127.0.0.1:1")).unwrap();
    let pairing = svc.pairing();
    let (room, secret) = (pairing["room"].as_str().unwrap().to_string(), pairing["key"].as_str().unwrap().to_string());
    let saved: Value = serde_json::from_slice(&std::fs::read(rdir.path().join("remote.json")).unwrap()).unwrap();
    let host_key = nekko_remote::proof::parse_key_text(saved["hostKey"].as_str().unwrap()).unwrap();
    let relay = computer(svc.clone(), room.clone(), secret.clone(), host_key).await;
    *desk.connect.lock().unwrap() = ConnectInfo::new(
        vec![relay.clone()],
        room.clone(),
        secret.clone(),
        pairing["hostKey"].as_str().unwrap().into(),
    );
    svc.set_fleet_gate(Arc::new(CloudGate(desk.cloud.clone())));

    // The laptop: same account, unlocked once with the recovery key, chat sync off.
    sign_in(&laptop, &email).await;
    call(&laptop, "sync:restore", json!([recovery])).await.unwrap();
    call(&laptop, "sync:setEnabled", json!([false])).await.unwrap();
    call(&laptop, "org:list", json!([])).await.unwrap();

    // Not shared yet: nothing to reach.
    let list = call(&laptop, "fleet:list", json!([org_id])).await.unwrap();
    assert!(list["computers"].as_array().unwrap().is_empty());

    // The desk shares; the laptop lists it as reachable, and only the laptop's own keys open how.
    call(&desk, "fleet:setSharing", json!([org_id, true])).await.unwrap();
    let list = call(&laptop, "fleet:list", json!([org_id])).await.unwrap();
    let row = &list["computers"][0];
    assert_eq!((row["name"].as_str(), row["reach"].as_str()), (Some("Desk-PC"), Some("ready")), "{list}");
    let desk_device = row["deviceId"].as_str().unwrap().to_string();
    let target = laptop.cloud.fleet_target(&org_id, &desk_device).expect("a target");
    assert_eq!(target.connect.routes, std::slice::from_ref(&relay));
    assert_eq!(target.connect.room, room);
    assert_eq!(target.connect.host_key, pairing["hostKey"].as_str().unwrap());
    // The desk's own view: itself, nothing to connect to.
    assert_eq!(call(&desk, "fleet:list", json!([org_id])).await.unwrap()["computers"][0]["reach"], "you");

    // The laptop connects with no code: the HELLO proves its account keys, the desk's gate lets it in.
    let key = p256::ecdsa::SigningKey::from_slice(&[7u8; 32]).unwrap();
    let signer = signer(laptop.cloud.clone(), org_id.clone());
    // The proof names the laptop's account device; its link id is built from it.
    let probe = signer(&Binding {
        room: room.clone(),
        challenge: "c".into(),
        host_eph: "h".into(),
        client_eph: "e".into(),
        hello_key: "k".into(),
    })
    .expect("an unlocked laptop can prove itself");
    let account_device = probe["deviceId"].as_str().unwrap().to_string();
    let cfg = Config {
        routes: target.connect.routes.clone(),
        room: target.connect.room.clone(),
        secret: target.connect.secret.clone(),
        host_key: target.connect.host_key.clone(),
        device_id: link_device_id(&account_device),
        name: "Laptop".into(),
        key,
        pair_code: None,
        fleet: Some(signer.clone()),
    };
    let (tx, mut events) = tokio::sync::mpsc::unbounded_channel();
    // The desk's copy of the account record predates the laptop: the first try is refused and
    // makes the desk catch up in the background; the try after it gets in (the desktop retries once).
    let first = Client::start(cfg.clone(), tx.clone());
    let mut rx = first.watch();
    let state = tokio::time::timeout(Duration::from_secs(15), rx.wait_for(|s| !matches!(s.state, State::Connecting)))
        .await
        .expect("settled")
        .unwrap()
        .state
        .clone();
    first.stop();
    if state != State::Online {
        assert_eq!(state, State::Denied("fleet-device".into()));
        for _ in 0..50 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let a = desk.cloud.clone();
            let caught = tokio::task::spawn_blocking(move || a.fleet_ready()).await.unwrap();
            if caught && desk.cloud.status()["sync"]["devices"].as_array().is_some_and(|d| d.len() >= 2) {
                break;
            }
        }
    }
    let client = Client::start(cfg.clone(), tx.clone());
    let mut rx = client.watch();
    let state = tokio::time::timeout(Duration::from_secs(15), rx.wait_for(|s| !matches!(s.state, State::Connecting)))
        .await
        .expect("settled")
        .unwrap()
        .state
        .clone();
    assert_eq!(state, State::Online);
    assert_eq!(client.status().device["fleet"], true);
    assert_eq!(client.status().device["name"], "Laptop");
    assert_eq!(svc.devices(), json!([]), "nothing joins the paired registry");

    // A prompt: a chat turn on the desk, its streamed text back on the laptop.
    let reply = client.call("chat:send", json!([{ "sessionId": "s1", "text": "hello" }])).await.unwrap();
    assert_eq!(reply["by"], json!(link_device_id(&account_device)));
    let mut text = String::new();
    while let Ok(Some((channel, payload))) = tokio::time::timeout(Duration::from_secs(5), events.recv()).await {
        if channel == "agent:event" && payload["type"] == "text" {
            text.push_str(payload["delta"].as_str().unwrap_or(""));
        }
        if payload["type"] == "done" {
            break;
        }
    }
    assert_eq!(text, "Hello from the desk.");
    assert!(svc.recheck_fleet().is_empty(), "nothing changed, nothing cut");

    // The real gate, asked directly: a proof is good for its own handshake only, and only for this account.
    let b = HelloBinding { room: &room, challenge: "c1", host_eph: "h1", client_eph: "e1", hello_key: "k1" };
    let proof = laptop.cloud.fleet_hello(&org_id, &b).unwrap();
    assert!(desk.cloud.fleet_admit(&proof, &b).is_ok());
    let replayed = HelloBinding { challenge: "c2", ..b.clone() };
    assert_eq!(desk.cloud.fleet_admit(&proof, &replayed), Err("invalid"), "another challenge");
    let other_key = HelloBinding { hello_key: "k2", ..b.clone() };
    assert_eq!(desk.cloud.fleet_admit(&proof, &other_key), Err("invalid"), "another HELLO key");
    let mut stranger = proof.clone();
    stranger["accountId"] = json!("a1111111-2b3d-4e5f-8a6b-9c0d1e2f3a4b");
    assert_eq!(desk.cloud.fleet_admit(&stranger, &b), Err("fleet-account"));
    let mut moved = proof.clone();
    moved["deviceId"] = json!("8e1f0a9c-2b3d-4e5f-8a6b-9c0d1e2f3a4b");
    assert_eq!(desk.cloud.fleet_admit(&moved, &b), Err("invalid"), "the proof is bound to its device");
    let mut future = proof.clone();
    future["keyId"] = json!(proof["keyId"].as_u64().unwrap() + 1);
    assert_eq!(desk.cloud.fleet_admit(&future, &b), Err("fleet-epoch"));

    // Decision 0128: an account proof (no org) is let in by the gate with no sharing at all, and
    // stays in after sharing is off; it is still bound to its handshake and its account.
    let account_proof = laptop.cloud.fleet_hello("", &b).unwrap();
    let admitted = desk.cloud.fleet_admit(&account_proof, &b).expect("an account device");
    assert_eq!(admitted.org_id, "");
    assert_eq!(desk.cloud.fleet_admit(&account_proof, &replayed), Err("invalid"));
    let mut posing = account_proof.clone();
    posing["accountId"] = json!("a1111111-2b3d-4e5f-8a6b-9c0d1e2f3a4b");
    assert_eq!(desk.cloud.fleet_admit(&posing, &b), Err("fleet-account"));

    // The desk turns sharing off: the live link is cut, and a redial is refused.
    call(&desk, "fleet:setSharing", json!([org_id, false])).await.unwrap();
    assert_eq!(svc.recheck_fleet(), vec![link_device_id(&account_device)]);
    assert!(svc.device(&link_device_id(&account_device)).is_none());
    client.stop();
    let again = Client::start(cfg.clone(), tx.clone());
    let mut rx = again.watch();
    let state = tokio::time::timeout(Duration::from_secs(15), rx.wait_for(|s| matches!(s.state, State::Denied(_))))
        .await
        .expect("refused")
        .unwrap()
        .state
        .clone();
    assert_eq!(state, State::Denied("fleet-off".into()));
    again.stop();
    assert!(desk.cloud.fleet_still(&admitted), "an account device doesn't depend on org sharing");

    // Sharing back on: in again. Then the desk removes the laptop from the account (a new key
    // epoch): the link is cut, and the old proof is worth nothing.
    call(&desk, "fleet:setSharing", json!([org_id, true])).await.unwrap();
    let back = Client::start(cfg.clone(), tx.clone());
    let mut rx = back.watch();
    tokio::time::timeout(Duration::from_secs(15), rx.wait_for(|s| s.state == State::Online)).await.unwrap().unwrap();
    call(&desk, "cloud:refresh", json!([])).await.unwrap();
    call(&desk, "sync:revoke", json!([account_device])).await.unwrap();
    assert_eq!(svc.recheck_fleet(), vec![link_device_id(&account_device)], "revocation cuts the live link");
    back.stop();
    let after = Client::start(cfg, tx);
    let mut rx = after.watch();
    let state = tokio::time::timeout(Duration::from_secs(15), rx.wait_for(|s| matches!(s.state, State::Denied(_))))
        .await
        .expect("refused")
        .unwrap()
        .state
        .clone();
    assert_eq!(state, State::Denied("fleet-epoch".into()), "a revoked device's proof is from the old epoch");
    after.stop();

    // Signed out: nothing to reach.
    call(&desk, "cloud:signOut", json!([])).await.unwrap();
    call(&laptop, "cloud:signOut", json!([])).await.unwrap();
    assert!(laptop.cloud.fleet_target(&org_id, &desk_device).is_none(), "signed out: no targets");
}
