//! The Rust remote access against the TS code it replaces.
//!
//! `golden/*.json` is written by `packages/host/src/remote.golden.test.ts`
//! (UPDATE_GOLDEN=1). Everything must come out exactly as the TS wrote it:
//! keys, sealed blobs, verdicts, `remote.json` and the relay agent's frames.

use base64::Engine;
use nekko_remote::agent::AgentCore;
use nekko_remote::e2e;
use nekko_remote::hello::{self, Grant, Random};
use nekko_remote::service::{Link, LinkHandle, RemoteService, Verifier};
use nekko_remote::{Activity, Devices, Out, PhoneCall, PhoneDevice, RELAYED_EVENTS};
use serde_json::{Value, json};
use std::collections::VecDeque;
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
        Some(PhoneDevice { access: nekko_remote::DeviceAccess::default(), key: None })
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
    // Each sealed frame the TS sent carries its IV in its first 12 bytes: feed
    // those to the port in order, and its output must match byte for byte.
    let ivs: Arc<Mutex<VecDeque<[u8; 12]>>> = Arc::default();
    let feed = ivs.clone();
    // A challenge (which the TS agent never sent) is sealed with a fresh IV.
    let mut core =
        AgentCore::new(key.clone(), Box::new(move || feed.lock().unwrap().pop_front().unwrap_or_else(e2e::random_iv)));
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
        {
            let mut q = ivs.lock().unwrap();
            q.clear();
            let mut last = None;
            for w in &want {
                let f: Value = serde_json::from_str(w).unwrap();
                if f["type"] == "d" {
                    let data: Value = serde_json::from_str(s(&f["data"])).unwrap();
                    let iv = iv_of(s(&data["enc"]));
                    // One seal per broadcast event: the same blob to every connection.
                    if last != Some(iv) {
                        q.push_back(iv);
                        last = Some(iv);
                    }
                }
            }
        }
        let input = &step["input"];
        let mut sent = Vec::new();
        if let Some(text) = input.get("relay").and_then(Value::as_str) {
            let mut outs = core.on_relay(text, &verify);
            if text.contains(r#""type":"client-open""#) {
                // Relay replay protection: each connection the relay announces
                // is sealed a challenge first (the TS agent sent nothing). The
                // recorded phones are legacy, so nothing else changes.
                let Some(Out::Send(first)) = (!outs.is_empty()).then(|| outs.remove(0)) else {
                    panic!("step {i}: no challenge")
                };
                let f: Value = serde_json::from_str(&first).unwrap();
                let opened = e2e::open(&key, s(&serde_json::from_str::<Value>(s(&f["data"])).unwrap()["enc"])).unwrap();
                assert_eq!(opened["type"], "challenge", "step {i}");
            }
            for out in outs {
                match out {
                    Out::Send(f) => sent.push(f),
                    Out::Dispatch { cid, id, device_id, channel, args, proof } => {
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
                        let result = rt.block_on(gated(PhoneCall { device_id, proof }, channel, args));
                        calls.extend(seen.lock().unwrap().drain(..));
                        sent.push(core.reply(&cid, id, result));
                    }
                }
            }
        } else if let Some(ev) = input.get("event") {
            sent.extend(core.on_event(s(&ev["channel"]), &ev["payload"]));
        } else if let Some(id) = input.get("kick").and_then(Value::as_str) {
            sent.extend(core.kick_device(id));
        }
        assert_eq!(sent, want, "step {i}: {input}");
        let connected: Vec<&str> = step["connected"].as_array().unwrap().iter().map(s).collect();
        assert_eq!(core.connected_devices(), connected, "step {i} connected");
        assert!(ivs.lock().unwrap().is_empty(), "step {i} sealed fewer frames than the TS");
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
    fn connect(&self, _url: &str, _room: &str, _key: &str, _verify: Verifier) -> Arc<dyn LinkHandle> {
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

/// A recorded HELLO as a protocol 4 phone sends it (an object only).
fn as_current(hello: &Value) -> Value {
    let mut h = hello.clone();
    if let Some(o) = h.as_object_mut() {
        o.insert("protocol".into(), json!(4));
    }
    h
}

#[test]
fn a_legacy_phone_is_marked_and_can_be_refused() {
    let dir = tempfile::tempdir().unwrap();
    let svc = RemoteService::new(
        dir.path(),
        counter_random(),
        Arc::new(|| 1_760_000_000_000.0),
        Box::new(FakeLink { kicked: Arc::default() }),
    );
    let file = dir.path().join("remote.json");
    let device = json!({ "id": "p1", "name": "Old phone", "platform": "ios", "createdAt": 1, "lastSeenAt": 1 });
    std::fs::write(&file, json!({ "enabled": false, "devices": [device] }).to_string()).unwrap();
    let devices = |file: &Path| -> Value {
        serde_json::from_str::<Value>(&std::fs::read_to_string(file).unwrap()).unwrap()["devices"][0].clone()
    };
    let activity = |svc: &RemoteService| svc.route("remote:activity", &[json!("p1")]).unwrap();
    // On by default: welcomed, marked, and written to the activity once.
    for _ in 0..2 {
        let reply = svc.verify(&json!({ "type": "hello", "deviceId": "p1", "protocol": 3 }));
        assert_eq!(reply["type"], "welcome", "{reply}");
    }
    assert_eq!(devices(&file)["legacyProtocol"], json!(true));
    let log = activity(&svc);
    assert_eq!(log.as_array().unwrap().len(), 1, "{log}");
    assert_eq!(log[0]["channel"], "relay:hello");
    assert_eq!(log[0]["ok"], true);
    assert_eq!(log[0]["reason"], "legacy-protocol");
    // The app updated: the mark goes.
    svc.verify(&json!({ "type": "hello", "deviceId": "p1", "protocol": 4 }));
    assert!(devices(&file).get("legacyProtocol").is_none());
    // The owner turned legacy phones off.
    let mut cfg: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    cfg["acceptLegacyPhones"] = json!(false);
    std::fs::write(&file, cfg.to_string()).unwrap();
    let reply = svc.verify(&json!({ "type": "hello", "deviceId": "p1" }));
    assert_eq!(reply, json!({ "type": "denied", "reason": "update-required" }));
    let log = activity(&svc);
    assert_eq!(log[1]["ok"], false);
    assert_eq!(log[1]["reason"], "legacy-protocol");
    // The setting survives the registry's own writes.
    svc.verify(&json!({ "type": "hello", "deviceId": "p1", "protocol": 4 }));
    let cfg: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(cfg["acceptLegacyPhones"], json!(false));
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
            "hello" => svc.verify(&as_current(&args[0])),
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
    // relay.ts does the same: the relay drops frames over its limit without a word.
    // Nothing here is compared byte for byte, so fresh random IVs as in real use.
    let key = e2e::derive_key("00112233445566778899aabbccddeeff", "room-1");
    let mut core = AgentCore::new(key.clone(), Box::new(e2e::random_iv));
    let hello = json!({ "type": "hello", "deviceId": "p1" });
    let data = json!({ "enc": e2e::seal_with_iv(&key, &hello, e2e::random_iv()) }).to_string();
    let verify = |_: &Value| json!({ "type": "welcome", "device": { "id": "p1" } });
    let relay = json!({ "type": "c", "cid": "c1", "data": data }).to_string();
    core.on_relay(&relay, &verify);
    let open_reply = |frame: &str| -> Value {
        let f: Value = serde_json::from_str(frame).unwrap();
        let d: Value = serde_json::from_str(s(&f["data"])).unwrap();
        e2e::open(&key, s(&d["enc"])).unwrap()
    };
    // Small: the result as is.
    let small = open_reply(&core.reply("c1", Some(json!(1)), Ok(json!({ "ok": true }))));
    assert_eq!(small, json!({ "type": "res", "id": 1, "result": { "ok": true } }));
    // ~9.6 MB of JSON: sealed and base64'd it is over the phone limit.
    let big = Value::Array((0..1200).map(|i| json!({ "id": format!("s{i}"), "title": "x".repeat(8000) })).collect());
    let reply = open_reply(&core.reply("c1", Some(json!(2)), Ok(big)));
    assert_eq!(reply["id"], json!(2));
    assert!(reply.get("result").is_none());
    let e = s(&reply["error"]);
    assert!(e.starts_with("This reply is too large to send to a phone ("), "{e}");
    assert!(e.ends_with(" MB). Open it on the computer."), "{e}");
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

#[test]
fn the_relay_handshake_matches_the_phones() {
    // relay-handshake.json is shared with the iPhone and Android protocol
    // tests: the same challenge, HELLO and requests on all three sides.
    let g = golden("relay-handshake.json");
    let key = e2e::derive_key(s(&g["secret"]), s(&g["room"]));
    let hex: String = key.raw().iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(hex, s(&g["key"]));
    let nonce: Vec<u8> = (0..s(&g["challenge"]["nonceBytes"]).len() / 2)
        .map(|i| u8::from_str_radix(&s(&g["challenge"]["nonceBytes"])[i * 2..i * 2 + 2], 16).unwrap())
        .collect();
    // The fixture's nonce first, then fresh ones (a re-challenge is never the same).
    let first = Mutex::new(Some(nonce));
    let random: Random = Arc::new(move |buf: &mut [u8]| match first.lock().unwrap().take() {
        Some(n) => buf.copy_from_slice(&n),
        None => getrandom_fill(buf),
    });
    let blob = s(&g["challenge"]["blob"]).to_string();
    let iv = iv_of(&blob);
    let mut core = AgentCore::new(key.clone(), Box::new(move || iv)).with_random(random);
    let device = s(&g["device"]["deviceId"]).to_string();
    let verify = move |h: &Value| json!({ "type": "welcome", "device": { "id": h["deviceId"] } });
    // The challenge, byte for byte.
    let out = core.on_relay(&json!({ "type": "client-open", "cid": "c1" }).to_string(), &verify);
    let want = json!({ "type": "d", "cid": "c1", "data": json!({ "enc": blob }).to_string() }).to_string();
    assert_eq!(out, vec![Out::Send(want)]);
    same(&e2e::open(&key, &blob).unwrap(), &g["challenge"]["frame"], "challenge frame");
    let send = |core: &mut AgentCore, v: &Value| {
        let data = json!({ "enc": e2e::seal_with_iv(&key, v, e2e::random_iv()) }).to_string();
        core.on_relay(&json!({ "type": "c", "cid": "c1", "data": data }).to_string(), &verify)
    };
    // The phone's HELLO is welcomed, then its two requests run in order.
    assert_eq!(g["hello"]["protocol"], json!(g["protocol"]));
    let welcome = send(&mut core, &g["hello"]);
    assert_eq!(welcome.len(), 1, "{welcome:?}");
    assert_eq!(core.connected_devices(), vec![device.clone()]);
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
    // Replayed, the second request is dropped and the phone is challenged again.
    let replay = send(&mut core, &g["requests"][1]);
    assert!(matches!(replay.as_slice(), [Out::Send(_)]), "{replay:?}");
    assert!(core.connected_devices().is_empty());
    // The same HELLO again (its challenge is spent) is not welcomed either.
    send(&mut core, &g["hello"]);
    assert!(core.connected_devices().is_empty());
    // A phone from before protocol 4 is the verifier's call.
    assert!(g["legacyHello"].get("challenge").is_none());
    send(&mut core, &g["legacyHello"]);
    assert_eq!(core.connected_devices(), vec![device]);
}

fn getrandom_fill(buf: &mut [u8]) {
    (hello::os_random())(buf)
}
