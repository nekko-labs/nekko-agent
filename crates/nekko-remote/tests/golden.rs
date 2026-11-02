//! The Rust remote access against the TS code it replaces.
//!
//! `golden/*.json` is a frozen record of the deleted TS code (edit it by hand
//! per docs/runbooks/golden-fixtures.md), apart from `phone-files.json`, `phone-artifacts.json` and
//! `phone-git.json`, which packages/shared still writes. Everything must come
//! out exactly as the TS wrote it:
//! keys, sealed blobs, verdicts, `remote.json` and the relay agent's frames.

use base64::Engine;
use nekko_remote::agent::{AgentCore, Host, answer_challenge};
use nekko_remote::e2e;
use nekko_remote::hello::{self, Grant, Random};
use nekko_remote::service::{Link, LinkHandle, RemoteService, Verifier};
use nekko_remote::{Activity, Devices, Out, PhoneCall, PhoneDevice, RELAYED_EVENTS};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

fn golden(name: &str) -> Value {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("golden").join(name);
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

/// The TS gate these goldens recorded knew no devices (IO-33 came after).
/// Every channel a phone may call is classed now, so the gate asks: every
/// paired phone here has Read and Change on and no Change key, as a phone
/// paired before IO-33 has. No recorded call needs a proof.
struct AllOn;

impl Devices for AllOn {
    fn device(&self, _id: &str) -> Option<PhoneDevice> {
        Some(PhoneDevice { access: nekko_remote::DeviceAccess::default(), key: None, computer: false })
    }
    fn register_key(&self, id: &str, _key: &str) -> Result<bool, &'static str> {
        panic!("register_key({id})")
    }
    fn record(&self, _id: &str, entry: Activity) {
        assert!(entry.ok, "a recorded call was refused: {entry:?}");
    }
    fn now(&self) -> f64 {
        0.0
    }
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap()
}

fn same(got: &Value, want: &Value, what: &str) {
    assert_eq!(nekko_js::stringify(got), nekko_js::stringify(want), "{what}");
}

/// The fixtures' random source: call `n` fills byte `i` with `(n*31 + i*7 + 3) & 0xff`.
fn counter_random() -> Random {
    let n = Arc::new(Mutex::new(0u32));
    Arc::new(move |buf: &mut [u8]| {
        let mut n = n.lock().unwrap();
        for (i, b) in buf.iter_mut().enumerate() {
            *b = ((*n * 31 + i as u32 * 7 + 3) & 0xff) as u8;
        }
        *n += 1;
    })
}

fn iv_of(blob: &str) -> [u8; 12] {
    let bytes = base64::engine::general_purpose::STANDARD.decode(blob).unwrap();
    bytes[..12].try_into().unwrap()
}

#[test]
fn keys_and_sealed_frames_match_webcrypto() {
    let g = golden("crypto.json");
    let key = e2e::derive_key(s(&g["secret"]), s(&g["room"]));
    let hex: String = key.raw().iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(hex, s(&g["key"]));
    // What the relay sees: derived under its own label, so neither the
    // secret nor the E2E key.
    let auth = e2e::relay_auth(s(&g["secret"]), s(&g["room"]));
    assert_eq!(auth, s(&g["relayAuth"]));
    assert_ne!(auth, s(&g["secret"]));
    assert_ne!(auth, hex);
    assert_ne!(auth, e2e::relay_auth(s(&g["secret"]), "another-room"));
    let frames = g["frames"].as_array().unwrap();
    assert!(frames.len() >= 10);
    for f in frames {
        let blob = s(&f["blob"]);
        assert_eq!(nekko_js::stringify(&f["value"]), s(&f["text"]), "the plaintext is JSON.stringify's");
        assert_eq!(e2e::seal_with_iv(&key, &f["value"], iv_of(blob)), blob, "seal {}", f["text"]);
        same(&e2e::open(&key, blob).expect("opens"), &f["opened"], "open");
    }
    // A frame sealed for another room never opens here, and opens there.
    let other = &g["other"];
    assert!(e2e::open(&key, s(&other["blob"])).is_none());
    let other_key = e2e::derive_key(s(&other["secret"]), s(&other["room"]));
    same(&e2e::open(&other_key, s(&other["blob"])).unwrap(), &json!({ "type": "hello", "deviceId": "x" }), "other");
}

#[test]
fn random_material_matches() {
    let g = golden("crypto.json");
    let r = counter_random();
    let m = &g["material"];
    assert_eq!(hello::new_pairing_code(&r, 8), s(&m["pairingCode"]));
    assert_eq!(hello::new_pairing_code(&r, 4), s(&m["pairingCode4"]));
    assert_eq!(hello::new_room_code(&r), s(&m["room"]));
    assert_eq!(hello::new_room_secret(&r), s(&m["secret"]));
}

#[test]
fn hello_verdicts_match() {
    let g = golden("crypto.json");
    let devices = g["devices"].as_array().unwrap().clone();
    let cases = g["verdicts"].as_array().unwrap();
    assert!(cases.len() > 60);
    for c in cases {
        let pairing = c["pairing"].as_object().map(|p| Grant {
            code: p["code"].as_str().unwrap().to_string(),
            expires_at: p["expiresAt"].as_f64().unwrap(),
            computer: false,
        });
        let got = hello::verify_hello(&devices, &c["hello"], pairing.as_ref(), c["now"].as_f64().unwrap());
        same(&got.value(), &c["verdict"], &format!("hello {} with {}", c["hello"], c["pairing"]));
    }
    for p in g["platforms"].as_array().unwrap() {
        let platform = p["platform"].as_str();
        assert_eq!(hello::normalize_platform(platform), s(&p["normalized"]), "{platform:?}");
        assert_eq!(hello::default_device_name(platform), s(&p["name"]), "{platform:?}");
    }
}

/// Whether a recorded reply is the old "send hello first".
fn refused(key: &e2e::Key, frame: &str) -> bool {
    let f: Value = serde_json::from_str(frame).unwrap();
    let d: Value = serde_json::from_str(s(&f["data"])).unwrap();
    e2e::open(key, s(&d["enc"])).is_some_and(|m| m["error"] == "not paired (send hello first)")
}

#[test]
fn the_relay_agent_sends_the_same_frames() {
    let g = golden("agent.json");
    assert_eq!(
        nekko_remote::agent_url("ws://127.0.0.1:4400/", s(&g["room"]), s(&g["secret"]), Some("tok en/1")),
        s(&g["url"])
    );
    let relayed: Vec<&str> = g["relayedEvents"].as_array().unwrap().iter().map(s).collect();
    assert_eq!(relayed, RELAYED_EVENTS);

    let key = e2e::derive_key(s(&g["secret"]), s(&g["room"]));
    // The record is of phones on the room key, which now only carries a
    // challenge. Each recorded phone goes through the handshake here and the
    // frames are compared opened: what is routed and said hasn't changed.
    let host = Host { room: s(&g["room"]).into(), key: nekko_remote::proof::new_key(&hello::os_random()) };
    let mut sessions: HashMap<String, (e2e::Key, String, u64)> = HashMap::new();
    let mut challenges: HashMap<String, Value> = HashMap::new();
    // The Live Activity card's dates come from a fixed clock (seconds since 2001).
    let mut core = AgentCore::new(key.clone(), host, Box::new(e2e::random_iv)).with_clock(Box::new(|| 800_000_000.0));
    let verify = |hello: &Value| -> Value {
        let id = hello.get("deviceId").and_then(Value::as_str).unwrap_or("");
        if id == "phone-1" || id == "phone-2" {
            json!({ "type": "welcome", "device": { "id": id, "name": "Phone", "platform": "android", "createdAt": 1, "lastSeenAt": 2 } })
        } else {
            json!({ "type": "denied", "reason": "unknown-device" })
        }
    };
    let responses = g["responses"].as_object().unwrap();
    let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
    let mut calls = Vec::new();
    let steps = g["steps"].as_array().unwrap();
    assert!(steps.len() > 25);
    for (i, step) in steps.iter().enumerate() {
        let want: Vec<&str> = step["sent"].as_array().unwrap().iter().map(s).collect();
        let input = &step["input"];
        let mut sent = Vec::new();
        if let Some(text) = input.get("relay").and_then(Value::as_str) {
            let recorded: Value = serde_json::from_str(text).unwrap_or(Value::Null);
            let cid = recorded["cid"].as_str().unwrap_or_default().to_string();
            let said = recorded["data"].as_str().and_then(|d| serde_json::from_str::<Value>(d).ok());
            let said = said.and_then(|d| e2e::open(&key, d["enc"].as_str()?));
            let mut text = text.to_string();
            match said.as_ref().and_then(|f| f["type"].as_str()) {
                Some("hello") => {
                    // A second HELLO on a connection answers a fresh challenge.
                    if !challenges.contains_key(&cid) || sessions.contains_key(&cid) {
                        let open = json!({ "type": "client-open", "cid": cid }).to_string();
                        let Some(Out::Send(first)) = core.on_relay(&open, &verify).into_iter().next() else {
                            panic!("step {i}: no challenge")
                        };
                        let f: Value = serde_json::from_str(&first).unwrap();
                        let d: Value = serde_json::from_str(s(&f["data"])).unwrap();
                        challenges.insert(cid.clone(), e2e::open(&key, s(&d["enc"])).unwrap());
                    }
                    let (data, session) = answer_challenge(s(&g["room"]), &challenges[&cid], said.clone().unwrap());
                    let nonce = s(&challenges[&cid]["challenge"]).to_string();
                    sessions.insert(cid.clone(), (session, nonce, 0));
                    text = json!({ "type": "c", "cid": cid, "data": data }).to_string();
                }
                // A connection without a key was answered "not paired"; now nobody can read it.
                Some("req") if want.first().is_some_and(|w| w.contains(r#""type":"d""#)) && refused(&key, want[0]) => {
                    let silent = core.on_relay(&text, &verify);
                    assert!(silent.is_empty(), "step {i}: {silent:?}");
                    continue;
                }
                Some("req") if sessions.contains_key(&cid) => {
                    let (session, nonce, seq) = sessions.get_mut(&cid).unwrap();
                    *seq += 1;
                    let mut f = said.clone().unwrap();
                    f["seq"] = json!(*seq);
                    f["challenge"] = json!(*nonce);
                    let data = json!({ "enc": e2e::seal_with_iv(session, &f, e2e::random_iv()) }).to_string();
                    text = json!({ "type": "c", "cid": cid, "data": data }).to_string();
                }
                _ => {}
            }
            let mut outs = core.on_relay(&text, &verify);
            if text.contains(r#""type":"client-open""#) {
                // Each connection the relay announces gets a challenge first.
                let Some(Out::Send(first)) = (!outs.is_empty()).then(|| outs.remove(0)) else {
                    panic!("step {i}: no challenge")
                };
                let f: Value = serde_json::from_str(&first).unwrap();
                let opened = e2e::open(&key, s(&serde_json::from_str::<Value>(s(&f["data"])).unwrap()["enc"])).unwrap();
                assert_eq!(opened["type"], "challenge", "step {i}");
                challenges.insert(cid.clone(), opened);
            }
            for out in outs {
                match out {
                    Out::Send(f) => sent.push(f),
                    Out::Dispatch { cid, id, device_id, channel, args, proof, .. } => {
                        // As the daemon runs it: through the phone gate, then the host.
                        let seen = Arc::new(Mutex::new(Vec::new()));
                        let (record, responses) = (seen.clone(), responses.clone());
                        let host: nekko_remote::Dispatcher = Arc::new(move |channel: String, args: Value| {
                            let result = match responses.get(&channel) {
                                Some(r) => {
                                    record.lock().unwrap().push(json!({ "channel": channel, "args": args }));
                                    match r.get("error") {
                                        Some(e) => Err(s(e).to_string()),
                                        None => Ok(r.get("result").cloned().unwrap_or(Value::Null)),
                                    }
                                }
                                None => Err(format!("Unknown channel: {channel}")),
                            };
                            Box::pin(std::future::ready(result))
                        });
                        let gated = nekko_remote::phone::gate(host, Arc::new(AllOn));
                        let result = rt.block_on(gated(PhoneCall { device_id, proof, step_up: None }, channel, args));
                        calls.extend(seen.lock().unwrap().drain(..));
                        sent.extend(core.reply(&cid, id, result));
                    }
                }
            }
        } else if let Some(ev) = input.get("event") {
            sent.extend(core.on_event(s(&ev["channel"]), &ev["payload"]));
        } else if let Some(id) = input.get("kick").and_then(Value::as_str) {
            sent.extend(core.kick_device(id));
        }
        // A `d` frame by who it's for and what it says; the rest byte for byte.
        let opened = |frame: &str, key: &e2e::Key| -> String {
            let f: Value = serde_json::from_str(frame).unwrap();
            if f["type"] != "d" {
                return frame.to_string();
            }
            let d: Value = serde_json::from_str(s(&f["data"])).unwrap();
            let mut said = e2e::open(key, s(&d["enc"])).unwrap();
            if said.get("protocol").is_some() {
                said["protocol"] = json!(hello::PROTOCOL_VERSION);
            }
            format!("{} {said}", f["cid"])
        };
        let got: Vec<String> = sent
            .iter()
            .map(|f| {
                let cid: Value = serde_json::from_str(f).unwrap();
                let session = sessions.get(cid["cid"].as_str().unwrap_or_default());
                opened(f, session.map_or(&key, |(k, ..)| k))
            })
            .collect();
        let want: Vec<String> = want.iter().map(|f| opened(f, &key)).collect();
        assert_eq!(got, want, "step {i}: {input}");
        let connected: Vec<&str> = step["connected"].as_array().unwrap().iter().map(s).collect();
        assert_eq!(core.connected_devices(), connected, "step {i} connected");
    }
    // The host saw the same calls. The TS row holds the arguments the host
    // method took after the dispatcher picked them out; the agent forwards
    // the whole list to the same dispatcher, so those lead it.
    let want_calls: Vec<Value> = g["calls"].as_array().unwrap().clone();
    assert_eq!(calls.len(), want_calls.len());
    for (got, want) in calls.iter().zip(&want_calls) {
        assert_eq!(got["channel"], want["channel"]);
        let (got, want) = (got["args"].as_array().unwrap(), want["args"].as_array().unwrap());
        same(&json!(got[..want.len()]), &json!(want), "args");
    }
}

/// A relay link that never connects: the golden ran against a stub agent.
struct FakeLink {
    kicked: Arc<Mutex<Vec<String>>>,
}

struct FakeHandle {
    kicked: Arc<Mutex<Vec<String>>>,
}

impl Link for FakeLink {
    fn connect(
        &self,
        _url: &str,
        _room: &str,
        _key: &str,
        _host_key: nekko_remote::client::SigningKey,
        _verify: Verifier,
    ) -> Arc<dyn LinkHandle> {
        Arc::new(FakeHandle { kicked: self.kicked.clone() })
    }
}

impl LinkHandle for FakeHandle {
    fn stop(&self) {}
    fn kick_device(&self, id: &str) {
        self.kicked.lock().unwrap().push(id.to_string());
    }
    fn connected_devices(&self) -> Vec<String> {
        Vec::new()
    }
    fn is_online(&self) -> bool {
        false
    }
    fn last_error(&self) -> Option<String> {
        None
    }
}

/// A phone's device key in these tests: one fixed key per device id.
fn device_key(device_id: &str) -> p256::ecdsa::SigningKey {
    use sha2::Digest;
    p256::ecdsa::SigningKey::from_slice(&sha2::Sha256::digest(device_id.as_bytes())).unwrap()
}

fn device_key_b64(device_id: &str) -> String {
    let point = device_key(device_id).verifying_key().to_encoded_point(false);
    base64::engine::general_purpose::STANDARD.encode(point.as_bytes())
}

/// A recorded HELLO as a current phone sends it and the agent hands it on:
/// protocol 6, answering a challenge, signed with the device's key for `room`
/// and one key exchange.
fn as_current(hello: &Value, room: &str) -> Value {
    use p256::ecdsa::signature::Signer;
    let mut h = hello.clone();
    let id = h.get("deviceId").and_then(Value::as_str).unwrap_or_default().to_string();
    if let Some(o) = h.as_object_mut() {
        o.insert("protocol".into(), json!(hello::SESSION_PROTOCOL));
        o.insert("challenge".into(), json!("golden-challenge"));
        o.insert("helloKey".into(), json!(device_key_b64(&id)));
        o.insert("hostEph".into(), json!("host-half"));
        o.insert("clientEph".into(), json!("client-half"));
        let text = hello::hello_text(&id, room, "golden-challenge", "host-half", "client-half");
        let sig: p256::ecdsa::Signature = device_key(&id).sign(text.as_bytes());
        o.insert("sig".into(), json!(base64::engine::general_purpose::STANDARD.encode(sig.to_bytes())));
    }
    h
}

#[test]
fn a_phone_app_from_before_device_keys_is_told_to_update() {
    let dir = tempfile::tempdir().unwrap();
    let svc = RemoteService::new(
        dir.path(),
        counter_random(),
        Arc::new(|| 1_760_000_000_000.0),
        Box::new(FakeLink { kicked: Arc::default() }),
    );
    let file = dir.path().join("remote.json");
    let device = json!({ "id": "p1", "name": "Old phone", "platform": "ios", "createdAt": 1, "lastSeenAt": 1 });
    std::fs::write(&file, json!({ "enabled": false, "room": "r", "devices": [device] }).to_string()).unwrap();
    let activity = |svc: &RemoteService| svc.route("remote:activity", &[json!("p1")]).unwrap();
    for protocol in [json!(null), json!(3), json!(4), json!(5)] {
        let reply = svc.verify(&json!({ "type": "hello", "deviceId": "p1", "protocol": protocol, "challenge": "c" }));
        assert_eq!(reply, json!({ "type": "denied", "reason": "update-required" }), "protocol {protocol}");
    }
    let log = activity(&svc);
    assert_eq!(log[0]["channel"], "relay:hello");
    assert_eq!(log[0]["ok"], false);
    assert_eq!(log[0]["reason"], "legacy-protocol");
    // A current app on a device paired before device keys: pair again.
    let reply = svc.verify(&as_current(&json!({ "type": "hello", "deviceId": "p1" }), "r"));
    assert_eq!(reply, json!({ "type": "denied", "reason": "bad-key" }));
}

#[test]
fn a_hello_must_be_signed_with_the_key_the_device_enrolled_with() {
    let dir = tempfile::tempdir().unwrap();
    let svc = RemoteService::new(
        dir.path(),
        counter_random(),
        Arc::new(|| 1_760_000_000_000.0),
        Box::new(FakeLink { kicked: Arc::default() }),
    );
    svc.route("remote:enable", &[json!("wss://relay.example/")]).unwrap();
    let cfg: Value = serde_json::from_str(&std::fs::read_to_string(dir.path().join("remote.json")).unwrap()).unwrap();
    let room = cfg["room"].as_str().unwrap().to_string();
    let code = svc.pair()["code"].as_str().unwrap().to_string();
    let hello = |extra: Value| {
        let mut h = json!({ "type": "hello", "deviceId": "p1", "name": "Phone", "platform": "ios" });
        for (k, v) in extra.as_object().unwrap() {
            h[k] = v.clone();
        }
        h
    };
    // Enrolling: the code, the key and a signature with it.
    let unsigned = json!({ "type": "hello", "deviceId": "p1", "protocol": 6, "challenge": "c", "pair": code,
        "hostEph": "h", "clientEph": "c" });
    assert_eq!(svc.verify(&unsigned), json!({ "type": "denied", "reason": "invalid" }));
    let welcome = svc.verify(&as_current(&hello(json!({ "pair": code })), &room));
    assert_eq!(welcome["type"], "welcome", "{welcome}");
    let keys: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.path().join("remote-hello-keys.json")).unwrap()).unwrap();
    assert_eq!(keys["p1"], json!(device_key_b64("p1")));
    // Back again: signed with that key, no code needed.
    assert_eq!(svc.verify(&as_current(&hello(json!({})), &room))["type"], "welcome");
    // Signed for another room, or for another challenge than it answers: refused.
    assert_eq!(svc.verify(&as_current(&hello(json!({})), "other-room"))["reason"], "bad-key");
    let mut moved = as_current(&hello(json!({})), &room);
    moved["challenge"] = json!("another-challenge");
    assert_eq!(svc.verify(&moved)["reason"], "bad-key");
    // Nor for another exchange: a signature relayed from elsewhere is good for nothing.
    let mut relayed = as_current(&hello(json!({})), &room);
    relayed["clientEph"] = json!("someone-elses-half");
    assert_eq!(svc.verify(&relayed)["reason"], "bad-key");
    // Another key claiming the same device, without a live code: refused.
    let mut other = as_current(&hello(json!({ "deviceId": "p2" })), &room);
    other["deviceId"] = json!("p1");
    assert_eq!(svc.verify(&other)["reason"], "bad-key");
    // With a live code, the device enrolls again with a new key.
    let code = svc.pair()["code"].as_str().unwrap().to_string();
    let mut rekey = as_current(&hello(json!({ "deviceId": "p2", "pair": code })), &room);
    rekey["deviceId"] = json!("p1");
    // (signed as p2's key over p1's text)
    use p256::ecdsa::signature::Signer;
    let sig: p256::ecdsa::Signature = device_key("p2")
        .sign(hello::hello_text("p1", &room, "golden-challenge", "host-half", "client-half").as_bytes());
    rekey["sig"] = json!(base64::engine::general_purpose::STANDARD.encode(sig.to_bytes()));
    assert_eq!(svc.verify(&rekey)["type"], "welcome");
    let keys: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.path().join("remote-hello-keys.json")).unwrap()).unwrap();
    assert_eq!(keys["p1"], json!(device_key_b64("p2")));
    // The new key is the device's now, and the code was single use.
    assert_eq!(svc.verify(&rekey)["type"], "welcome");
    let mut again = as_current(&hello(json!({ "deviceId": "p3", "pair": code })), &room);
    again["deviceId"] = json!("p1");
    assert_eq!(svc.verify(&again)["reason"], "bad-key");
    // Signing out every phone forgets every key.
    svc.route("remote:rotate", &[]).unwrap();
    assert!(!dir.path().join("remote-hello-keys.json").exists());
}

#[test]
fn remote_json_and_replies_match_across_operations() {
    let g = golden("service.json");
    let dir = tempfile::tempdir().unwrap();
    let now = Arc::new(Mutex::new(g["start"].as_f64().unwrap()));
    let clock_now = now.clone();
    let kicked: Arc<Mutex<Vec<String>>> = Arc::default();
    let svc = RemoteService::new(
        dir.path(),
        counter_random(),
        Arc::new(move || *clock_now.lock().unwrap()),
        Box::new(FakeLink { kicked: kicked.clone() }),
    );
    let file = dir.path().join("remote.json");
    let ops = g["ops"].as_array().unwrap();
    assert!(ops.len() > 30);
    for (i, op) in ops.iter().enumerate() {
        *now.lock().unwrap() = op["now"].as_f64().unwrap();
        let args = op["args"].as_array().unwrap();
        let name = s(&op["op"]);
        let result = match name {
            "file" => {
                std::fs::write(&file, s(&ops[i]["file"])).unwrap();
                Value::Null
            }
            // The TS phones in this record predate relay replay protection;
            // read them as protocol 4 phones whose challenge the agent already
            // checked, so the registry is the one the TS wrote. The legacy
            // path has its own test (`a_legacy_phone_is_marked_and_can_be_refused`).
            "hello" => {
                let room = std::fs::read_to_string(&file)
                    .ok()
                    .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                    .and_then(|c| c["room"].as_str().map(str::to_string))
                    .unwrap_or_default();
                svc.verify(&as_current(&args[0], &room))
            }
            "pair" => svc.pair(),
            other => svc.route(&format!("remote:{other}"), args).unwrap_or_else(|e| json!({ "error": e })),
        };
        same(&result, &op["result"], &format!("op {i} {name} result"));
        if name != "file" {
            let text = std::fs::read_to_string(&file).ok();
            assert_eq!(text.as_deref(), op["file"].as_str(), "op {i} {name} remote.json");
        }
        let want_kicked: Vec<&str> = op["kicked"].as_array().unwrap().iter().map(s).collect();
        assert_eq!(*kicked.lock().unwrap(), want_kicked, "op {i} kicked");
    }
}

#[test]
fn the_phone_gate_decides_as_the_ts_does() {
    // phone-access.json and phone.json are both written from
    // packages/shared/src/phone-access.ts by the TS golden test.
    let g = golden("phone.json");
    let settings = g["settings"].clone();
    let skills = g["skills"].clone();
    let sessions = g["sessions"].clone();
    let changes = g["changes"].clone();
    let beyond = g["beyond"].clone();
    let cases = g["cases"].as_array().unwrap();
    assert!(cases.len() >= 30);
    let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
    for case in cases {
        let calls: Arc<Mutex<Vec<Value>>> = Arc::default();
        let (seen, settings, skills, sessions, changes, beyond) =
            (calls.clone(), settings.clone(), skills.clone(), sessions.clone(), changes.clone(), beyond.clone());
        let host: nekko_remote::Dispatcher = Arc::new(move |channel: String, args: Value| {
            seen.lock().unwrap().push(json!([channel, args]));
            let out = match channel.as_str() {
                "session:get" => sessions.get(args[0].as_str().unwrap_or("")).cloned().unwrap_or(Value::Null),
                "changes:list" => changes.get(args[0].as_str().unwrap_or("")).cloned().unwrap_or(json!([])),
                "providers:list" => settings["providers"].clone(),
                "skills:runnable" => skills.clone(),
                // The channels beyond the chat answer with what the TS fixture holds (task:runNow: nothing).
                "task:runNow" => Value::Null,
                c if beyond.get(c).is_some() => beyond[c].clone(),
                c if c.starts_with("settings:") => settings.clone(),
                c => json!({ "ok": c }),
            };
            Box::pin(std::future::ready(Ok(out)))
        });
        // The screening and redaction the TS recorded, under the access
        // classes (tested in phone.rs): `phone::call` is what the gate runs
        // once a call's class lets it through.
        let channel = s(&case["channel"]).to_string();
        let got = rt.block_on(nekko_remote::phone::call(&host, channel.clone(), case["args"].clone()));
        let what = format!("{channel} {}", case["args"]);
        match case.get("error") {
            Some(e) => assert_eq!(got.as_ref().unwrap_err(), s(e), "{what}"),
            None => same(got.as_ref().unwrap(), &case["result"], &what),
        }
        same(&json!(*calls.lock().unwrap()), &case["calls"], &format!("{what}: host calls"));
    }
}

#[test]
fn a_reply_too_large_for_the_relay_becomes_an_error() {
    // relay.ts did the same: the relay drops frames over its limit without a word.
    let key = e2e::derive_key("00112233445566778899aabbccddeeff", "room-1");
    let host = Host { room: "room-1".into(), key: nekko_remote::proof::new_key(&hello::os_random()) };
    let mut core = AgentCore::new(key, host, Box::new(e2e::random_iv));
    let verify = |_: &Value| json!({ "type": "welcome", "device": { "id": "p1" } });
    let (_, session) = core.say_hello("c1", json!({ "type": "hello", "deviceId": "p1" }), &verify);
    let open_reply = |frame: Option<String>| -> Value {
        let f: Value = serde_json::from_str(&frame.unwrap()).unwrap();
        let d: Value = serde_json::from_str(s(&f["data"])).unwrap();
        e2e::open(&session, s(&d["enc"])).unwrap()
    };
    // Small: the result as is.
    let small = open_reply(core.reply("c1", Some(json!(1)), Ok(json!({ "ok": true }))));
    assert_eq!(small, json!({ "type": "res", "id": 1, "result": { "ok": true } }));
    // ~9.6 MB of JSON: sealed and base64'd it is over the phone limit.
    let big = Value::Array((0..1200).map(|i| json!({ "id": format!("s{i}"), "title": "x".repeat(8000) })).collect());
    let reply = open_reply(core.reply("c1", Some(json!(2)), Ok(big)));
    assert_eq!(reply["id"], json!(2));
    assert!(reply.get("result").is_none());
    let e = s(&reply["error"]);
    assert!(e.starts_with("This reply is too large to send to a phone ("), "{e}");
    assert!(e.ends_with(" MB). Open it on the computer."), "{e}");
    // A connection that lost its key has no reply to send.
    assert_eq!(core.reply("nobody", Some(json!(3)), Ok(json!(1))), None);
}

#[test]
fn files_and_logs_from_a_phone_match_the_ts() {
    // Written from packages/shared/src/phone-files.ts by phone-files.golden.test.ts.
    let g = golden("phone-files.json");
    let screens = g["screens"].as_array().unwrap();
    assert!(screens.len() >= 40);
    for c in screens {
        let channel = s(&c["channel"]);
        let args = c["args"].as_array().unwrap();
        let got = nekko_remote::phone::screen(channel, args);
        let what = format!("{channel} {}", c["args"]);
        match c.get("error") {
            Some(e) => assert_eq!(got.err().map(|d| d.to_string()).as_deref(), Some(s(e)), "{what}"),
            None => {
                let args = got.unwrap_or_else(|d| panic!("{what}: {d}")).args.map(Value::Array).unwrap_or(Value::Null);
                assert_eq!(args, c["callArgs"], "{what}");
            }
        }
    }
    let views = g["views"].as_array().unwrap();
    assert!(views.len() >= 20);
    for c in views {
        let channel = s(&c["channel"]);
        let got = nekko_remote::phone::redact(channel, c["result"].clone());
        assert_eq!(got, c["view"], "{channel} {}", c["result"]);
    }
}

#[test]
fn artifacts_and_previews_from_a_phone_match_the_ts() {
    // Written from packages/shared/src/chat-links.ts and phone-artifacts.ts by phone-artifacts.golden.test.ts.
    use nekko_remote::chat_links::{self, ChatLinks};
    let g = golden("phone-artifacts.json");
    let cases = |k: &str, at_least: usize| {
        let list = g[k].as_array().unwrap().clone();
        assert!(list.len() >= at_least, "{k}");
        list
    };
    for c in cases("links", 15) {
        let got = chat_links::chat_links(&c["messages"], c["base"].as_str());
        assert_eq!(got.value(), c["links"], "{} with base {}", c["messages"], c["base"]);
    }
    for c in cases("paths", 15) {
        let got = chat_links::local_path(s(&c["path"]), None);
        assert_eq!(got.map(Value::String).unwrap_or(Value::Null), c["local"], "{}", c["path"]);
    }
    for c in cases("urls", 15) {
        let got = chat_links::loopback_url(s(&c["url"]), 2048);
        assert_eq!(got.map(|u| u.value()).unwrap_or(Value::Null), c["parsed"], "{}", c["url"]);
    }
    for c in cases("access", 15) {
        let links = ChatLinks::from_value(&c["links"]);
        let got = chat_links::artifact_access(s(&c["path"]), &links, c["caseInsensitive"] == json!(true));
        assert_eq!(
            got.map(|a| a.value()).unwrap_or(Value::Null),
            c["access"],
            "{} ci {}",
            c["path"],
            c["caseInsensitive"]
        );
    }
    for c in cases("screens", 25) {
        let channel = s(&c["channel"]);
        let args = c["args"].as_array().unwrap();
        let got = nekko_remote::phone::screen(channel, args);
        let what = format!("{channel} {}", c["args"]);
        match c.get("error") {
            Some(e) => assert_eq!(got.err().map(|d| d.to_string()).as_deref(), Some(s(e)), "{what}"),
            None => {
                let args = got.unwrap_or_else(|d| panic!("{what}: {d}")).args.map(Value::Array).unwrap_or(Value::Null);
                assert_eq!(args, c["callArgs"], "{what}");
            }
        }
    }
    for c in cases("views", 10) {
        let channel = s(&c["channel"]);
        let got = nekko_remote::phone::redact(channel, c["result"].clone());
        assert_eq!(got, c["view"], "{channel} {}", c["result"]);
    }
}

#[test]
fn the_relay_route_rule_matches_the_ts() {
    for case in golden("relay-route.json").as_array().unwrap() {
        let url = s(&case["url"]);
        assert_eq!(nekko_remote::route::relay_route(url).as_str(), s(&case["route"]), "route of {url:?}");
        assert_eq!(
            nekko_remote::route::relay_url_problem(url).as_deref(),
            case["problem"].as_str(),
            "problem with {url:?}"
        );
    }
}

#[test]
fn git_from_a_phone_matches_the_ts() {
    // Written from packages/shared/src/phone-git.ts by phone-git.golden.test.ts.
    let g = golden("phone-git.json");
    let screens = g["screens"].as_array().unwrap();
    assert!(screens.len() >= 40);
    for c in screens {
        let channel = s(&c["channel"]);
        let args = c["args"].as_array().unwrap();
        let got = nekko_remote::phone::screen(channel, args);
        let what = format!("{channel} {}", c["args"]);
        match c.get("error") {
            Some(e) => assert_eq!(got.err().map(|d| d.to_string()).as_deref(), Some(s(e)), "{what}"),
            None => {
                let args = got.unwrap_or_else(|d| panic!("{what}: {d}")).args.map(Value::Array).unwrap_or(Value::Null);
                assert_eq!(args, c["callArgs"], "{what}");
            }
        }
    }
    let views = g["views"].as_array().unwrap();
    assert!(views.len() >= 20);
    for c in views {
        let channel = s(&c["channel"]);
        let got = nekko_remote::phone::redact(channel, c["result"].clone());
        assert_eq!(got, c["view"], "{channel} {}", c["result"]);
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2).map(|i| u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).unwrap()).collect()
}

/// `first`, then the OS.
fn scripted(first: Vec<Vec<u8>>) -> Random {
    let queue = Mutex::new(std::collections::VecDeque::from(first));
    Arc::new(move |buf: &mut [u8]| match queue.lock().unwrap().pop_front() {
        Some(n) => buf.copy_from_slice(&n),
        None => getrandom_fill(buf),
    })
}

/// Rewrites relay-handshake.json from its inputs (`UPDATE_GOLDEN=1`): the keys
/// and nonces in it decide everything else, and every client reads the result.
#[test]
fn the_handshake_vector_is_derived_from_its_inputs() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/relay-handshake.json");
    let mut g = golden("relay-handshake.json");
    let (room, secret) = (s(&g["room"]).to_string(), s(&g["secret"]).to_string());
    let room_key = e2e::derive_key(&secret, &room);
    let host_key = p256::ecdsa::SigningKey::from_slice(&unhex(s(&g["hostKey"]["privateKeyHex"]))).unwrap();
    let nonce = unhex(s(&g["challenge"]["nonceBytes"]));
    let host_eph = e2e::Ephemeral::new(&scripted(vec![unhex(s(&g["hostEph"]["privateKeyHex"]))]));
    let client_eph = e2e::Ephemeral::new(&scripted(vec![unhex(s(&g["clientEph"]["privateKeyHex"]))]));
    let challenge = base64::engine::general_purpose::STANDARD.encode(&nonce);
    let host_text = hello::host_text(&room, &challenge, &host_eph.public);
    let info = hello::session_info(&room, &challenge, &host_eph.public, &client_eph.public);
    let session = host_eph.session_key(&client_eph.public, &info).unwrap();
    let id = s(&g["device"]["deviceId"]).to_string();
    let device_key = p256::ecdsa::SigningKey::from_slice(&unhex(s(&g["helloKey"]["privateKeyHex"]))).unwrap();
    let hello_text = hello::hello_text(&id, &room, &challenge, &host_eph.public, &client_eph.public);

    g["protocol"] = json!(hello::PROTOCOL_VERSION);
    g["key"] = json!(hex(room_key.raw()));
    g["hostKey"]["publicKey"] = json!(nekko_remote::proof::public_key(&host_key));
    g["hostEph"]["publicKey"] = json!(host_eph.public);
    g["clientEph"]["publicKey"] = json!(client_eph.public);
    g["hostText"] = json!(host_text);
    g["sessionInfo"] = json!(info);
    g["sessionKey"] = json!(hex(session.raw()));
    let frame = json!({ "type": "challenge", "challenge": challenge, "eph": host_eph.public,
        "sig": nekko_remote::proof::sign(&host_key, &host_text) });
    g["challenge"]["frame"] = frame.clone();
    g["challenge"]["blob"] = json!(e2e::seal_with_iv(&room_key, &frame, iv_of(s(&g["challenge"]["blob"]))));
    g["helloKey"]["text"] = json!(hello_text);
    g["helloKey"]["publicKey"] = json!(nekko_remote::proof::public_key(&device_key));
    g["helloKey"]["sig"] = json!(nekko_remote::proof::sign(&device_key, &hello_text));
    g["hello"]["protocol"] = g["protocol"].clone();
    g["hello"]["challenge"] = json!(challenge);
    g["hello"]["helloKey"] = g["helloKey"]["publicKey"].clone();
    g["hello"]["sig"] = g["helloKey"]["sig"].clone();
    let envelope = json!({ "eph": client_eph.public, "enc": e2e::seal_with_iv(&session, &g["hello"], [7u8; 12]) });
    g["helloFrame"] = envelope;
    for r in g["requests"].as_array_mut().unwrap() {
        r["challenge"] = json!(challenge);
    }
    let text = serde_json::to_string_pretty(&g).unwrap() + "\n";
    if std::env::var("UPDATE_GOLDEN").is_ok() {
        std::fs::write(&path, text).unwrap();
    } else {
        assert_eq!(text, std::fs::read_to_string(&path).unwrap(), "UPDATE_GOLDEN=1 rewrites it");
    }
}

#[test]
fn the_relay_handshake_matches_the_phones() {
    // relay-handshake.json is shared with the iPhone, Android and the browser:
    // the same challenge, HELLO and requests on every side.
    let g = golden("relay-handshake.json");
    let key = e2e::derive_key(s(&g["secret"]), s(&g["room"]));
    assert_eq!(hex(key.raw()), s(&g["key"]));
    let random = scripted(vec![unhex(s(&g["challenge"]["nonceBytes"])), unhex(s(&g["hostEph"]["privateKeyHex"]))]);
    let blob = s(&g["challenge"]["blob"]).to_string();
    let iv = iv_of(&blob);
    let signing = p256::ecdsa::SigningKey::from_slice(&unhex(s(&g["hostKey"]["privateKeyHex"]))).unwrap();
    let host = Host { room: s(&g["room"]).into(), key: signing };
    let mut core = AgentCore::new(key.clone(), host, Box::new(move || iv)).with_random(random);
    let device = s(&g["device"]["deviceId"]).to_string();
    let seen: Mutex<Option<Value>> = Mutex::default();
    let verify = |h: &Value| {
        *seen.lock().unwrap() = Some(h.clone());
        json!({ "type": "welcome", "device": { "id": h["deviceId"] } })
    };
    // The challenge, byte for byte.
    let out = core.on_relay(&json!({ "type": "client-open", "cid": "c1" }).to_string(), &verify);
    let want = json!({ "type": "d", "cid": "c1", "data": json!({ "enc": blob }).to_string() }).to_string();
    assert_eq!(out, vec![Out::Send(want)]);
    same(&e2e::open(&key, &blob).unwrap(), &g["challenge"]["frame"], "challenge frame");
    // The device's answer is welcomed, and the agent passes on the exchange it ran.
    let relay = |data: String| json!({ "type": "c", "cid": "c1", "data": data }).to_string();
    let welcome = core.on_relay(&relay(g["helloFrame"].to_string()), &verify);
    assert_eq!(welcome.len(), 1, "{welcome:?}");
    assert_eq!(core.connected_devices(), vec![device.clone()]);
    let heard = seen.lock().unwrap().clone().unwrap();
    assert_eq!(heard["hostEph"], g["hostEph"]["publicKey"]);
    assert_eq!(heard["clientEph"], g["clientEph"]["publicKey"]);
    // Its two requests run in order, under the connection's key.
    let info = s(&g["sessionInfo"]);
    let client_eph = e2e::Ephemeral::new(&scripted(vec![unhex(s(&g["clientEph"]["privateKeyHex"]))]));
    let session = client_eph.session_key(s(&g["hostEph"]["publicKey"]), info).unwrap();
    assert_eq!(hex(session.raw()), s(&g["sessionKey"]));
    let send = |core: &mut AgentCore, v: &Value| {
        let data = json!({ "enc": e2e::seal_with_iv(&session, v, e2e::random_iv()) }).to_string();
        core.on_relay(&relay(data), &verify)
    };
    for r in g["requests"].as_array().unwrap() {
        match send(&mut core, r).as_slice() {
            [Out::Dispatch { channel, args, device_id, .. }] => {
                assert_eq!(channel, s(&r["channel"]));
                assert_eq!(args, &r["args"]);
                assert_eq!(device_id, &device);
            }
            other => panic!("{r}: {other:?}"),
        }
    }
    // Replayed, the second request is dropped and the device is challenged again.
    let replay = send(&mut core, &g["requests"][1]);
    assert!(matches!(replay.as_slice(), [Out::Send(_)]), "{replay:?}");
    assert!(core.connected_devices().is_empty());
    // The same answer again (its exchange is spent) is not welcomed either.
    core.on_relay(&relay(g["helloFrame"].to_string()), &verify);
    assert!(core.connected_devices().is_empty());
}

fn getrandom_fill(buf: &mut [u8]) {
    (hello::os_random())(buf)
}

/// SK-2: the step-up verifier decides every case the TS twin wrote
/// (`packages/shared/src/step-up.golden.test.ts`): real ES256 assertions from
/// a software authenticator, TOTP codes and their rate limit.
#[test]
fn step_up_matches_the_ts_verifier() {
    use nekko_remote::step_up::{self, Issued};
    let g = golden("step-up.json");
    let cases = g["cases"].as_array().unwrap();
    assert!(cases.len() > 20);
    for c in cases {
        let name = c["name"].as_str().unwrap();
        let mut state = c["state"].clone();
        let mut issued: Vec<Issued> = c["issued"].as_array().unwrap().iter().map(|v| Issued::of(v).unwrap()).collect();
        let out = step_up::check(&mut state, &mut issued, c["now"].as_f64().unwrap(), Some(&c["stepUp"]));
        let e = &c["expect"];
        assert_eq!(out.result, e["result"].as_str().unwrap(), "{name}");
        assert_eq!(out.method, e["method"].as_str(), "{name}");
        assert_eq!(out.uv, e["uv"].as_bool(), "{name}");
        assert_eq!(out.cloned.as_deref(), e["cloned"].as_str(), "{name}");
        assert_eq!(state, e["state"], "{name}: security.json after");
        assert_eq!(Value::Array(issued.iter().map(Issued::value).collect()), e["issued"], "{name}: challenges after");
    }
    for v in g["totpVectors"].as_array().unwrap() {
        let secret = step_up::base32_decode(v["secret"].as_str().unwrap()).unwrap();
        assert_eq!(step_up::totp_at(&secret, v["step"].as_i64().unwrap(), 6), v["code"].as_str().unwrap());
    }
    let r = &g["recovery"];
    for (code, hash) in r["codes"].as_array().unwrap().iter().zip(r["hashes"].as_array().unwrap()) {
        assert_eq!(step_up::hash_recovery_code(code.as_str().unwrap()), hash.as_str().unwrap());
    }
}

#[test]
fn the_hello_signature_matches_the_phones() {
    // relay-handshake.json's device key: the text a HELLO signs, and a
    // signature the phones' tests verify too.
    let g = golden("relay-handshake.json");
    let k = &g["helloKey"];
    let (host_eph, client_eph) = (s(&g["hostEph"]["publicKey"]), s(&g["clientEph"]["publicKey"]));
    let nonce = s(&g["challenge"]["frame"]["challenge"]);
    let text = hello::hello_text(s(&g["device"]["deviceId"]), s(&g["room"]), nonce, host_eph, client_eph);
    assert_eq!(text, s(&k["text"]));
    let key = nekko_remote::proof::parse_key(s(&k["publicKey"])).expect("an X9.63 P-256 key");
    let sig = base64::engine::general_purpose::STANDARD.decode(s(&k["sig"])).unwrap();
    assert!(nekko_remote::proof::verify(&key, &text, &sig));
    assert!(!nekko_remote::proof::verify(&key, &text.replace("a1b2", "ffff"), &sig));
    let signing = p256::ecdsa::SigningKey::from_slice(&unhex(s(&k["privateKeyHex"]))).unwrap();
    assert_eq!(&key, signing.verifying_key());
    assert_eq!(g["protocol"], json!(hello::PROTOCOL_VERSION));
}
