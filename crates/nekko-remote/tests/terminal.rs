//! Terminals and SSH from a paired phone (IO-33 FA-3, FA-6): the gate's
//! rules against the TS (`golden/phone-terminal.json`), the terminal session
//! token, and the relay agent scoping and pacing terminal output.

use base64::Engine;
use nekko_remote::agent::AgentCore;
use nekko_remote::phone::{Classes, DeviceAccess};
use nekko_remote::phone_terminal::{self, Coalescer, PhoneTerminals};
use nekko_remote::{Activity, Devices, Dispatcher, PhoneCall, PhoneDevice, PhoneDispatcher, e2e};
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use serde_json::{Value, json};
use std::path::Path;
use std::sync::{Arc, Mutex};

fn golden(name: &str) -> Value {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("golden").join(name);
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

#[test]
fn screens_and_views_match_the_ts() {
    let g = golden("phone-terminal.json");
    let screens = g["screens"].as_array().unwrap();
    assert!(screens.len() > 50);
    for case in screens {
        let channel = case["channel"].as_str().unwrap();
        let args = case["args"].as_array().unwrap().clone();
        let what = format!("{channel} {}", case["args"]);
        match (nekko_remote::phone::screen(channel, &args), case.get("error")) {
            (Ok(_), None) => {
                assert_eq!(Value::Array(phone_terminal::call_args(channel, &args)), case["forwarded"], "{what}");
            }
            (Err(d), Some(e)) => assert_eq!(d.to_string(), e.as_str().unwrap(), "{what}"),
            (got, want) => panic!("{what}: got {got:?}, the TS said {want:?}"),
        }
    }
    for case in g["terminals"].as_array().unwrap() {
        assert_eq!(phone_terminal::terminals_view(&case["input"]), case["output"], "{}", case["input"]);
    }
    for case in g["tails"].as_array().unwrap() {
        assert_eq!(phone_terminal::tail_view(&case["input"]), case["output"], "{}", case["input"]);
    }
    for case in g["hosts"].as_array().unwrap() {
        assert_eq!(phone_terminal::hosts_view(&case["input"]), case["output"]);
    }
}

const NOW: f64 = 1_760_000_000_000.0;

#[derive(Default)]
struct Phones {
    devices: Mutex<Vec<(String, PhoneDevice)>>,
    log: Mutex<Vec<(String, Activity)>>,
    now: Mutex<f64>,
}

impl Devices for Phones {
    fn device(&self, id: &str) -> Option<PhoneDevice> {
        self.devices.lock().unwrap().iter().find(|(d, _)| d == id).map(|(_, p)| p.clone())
    }
    fn register_key(&self, _: &str, _: &str) -> Result<bool, &'static str> {
        Ok(false)
    }
    fn record(&self, id: &str, entry: Activity) {
        self.log.lock().unwrap().push((id.to_string(), entry));
    }
    fn now(&self) -> f64 {
        *self.now.lock().unwrap()
    }
    fn name(&self, id: &str) -> Option<String> {
        Some(format!("{id}'s iPhone"))
    }
}

/// The computer's router as the gate sees it: a chat's terminal, a desktop
/// terminal with no chat, the chat's agent log.
fn computer(calls: Arc<Mutex<Vec<(String, Value)>>>) -> Dispatcher {
    Arc::new(move |channel: String, args: Value| {
        calls.lock().unwrap().push((channel.clone(), args.clone()));
        let info = |id: &str, sid: Option<&str>| {
            json!({ "id": id, "title": "zsh", "cwd": "/Users/philip/code/app", "shell": "/bin/zsh", "running": true,
                    "createdAt": 5, "sessionId": sid })
        };
        let out = match channel.as_str() {
            "terminals:list" => {
                let all = vec![
                    info("term_1", Some("s1")),
                    info("term_desk", None),
                    json!({ "id": "agent_s1", "title": "Agent commands", "shell": "agent", "agentSessionId": "s1", "cwd": "" }),
                ];
                let only = args[0].get("sessionId").and_then(Value::as_str).map(str::to_string);
                json!(
                    all.into_iter()
                        .filter(|t| only.is_none()
                            || t["sessionId"].as_str() == only.as_deref()
                            || t["agentSessionId"].as_str() == only.as_deref())
                        .collect::<Vec<_>>()
                )
            }
            "terminal:tail" => json!({ "info": info(args[0].as_str().unwrap(), Some("s1")), "buffer": "$ ", "cols": 80,
                                       "rows": 24, "truncated": false, "totalBytes": 2 }),
            "session:get" => json!({ "id": "s1", "workspaceId": "w1", "messages": [] }),
            "terminal:create" => info("term_9", Some("s1")),
            "ssh:open" => json!({ "id": "term_ssh", "title": "devbox", "cwd": "/Users/philip", "shell": "/usr/bin/ssh",
                                  "running": true, "sessionId": "s1" }),
            "ssh:hosts" => json!([{ "alias": "devbox", "hostName": "devbox.lan", "user": "root", "port": 22 }]),
            "terminal:attach" => json!([args[1]]),
            _ => Value::Null,
        };
        Box::pin(std::future::ready(Ok(out)))
    })
}

struct Rig {
    phones: Arc<Phones>,
    calls: Arc<Mutex<Vec<(String, Value)>>>,
    terminals: Arc<PhoneTerminals>,
    gated: PhoneDispatcher,
    key: SigningKey,
    ts: Mutex<i64>,
    rt: tokio::runtime::Runtime,
}

fn rig(access: DeviceAccess) -> Rig {
    let key = SigningKey::from_slice(&[9; 32]).unwrap();
    let public =
        base64::engine::general_purpose::STANDARD.encode(key.verifying_key().to_encoded_point(false).as_bytes());
    let phones = Arc::new(Phones::default());
    *phones.now.lock().unwrap() = NOW;
    for id in ["phone-1", "phone-2"] {
        phones
            .devices
            .lock()
            .unwrap()
            .push((id.into(), PhoneDevice { access, key: Some(public.clone()), computer: false }));
    }
    let calls: Arc<Mutex<Vec<(String, Value)>>> = Arc::default();
    let terminals = PhoneTerminals::new();
    let gated = nekko_remote::phone::gate_full(
        computer(calls.clone()),
        phones.clone(),
        Classes::from_policy(),
        terminals.clone(),
    );
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    Rig { phones, calls, terminals, gated, key, ts: Mutex::new(NOW as i64), rt }
}

const ON: DeviceAccess = DeviceAccess { read: true, change: true };

impl Rig {
    fn ask(&self, device: &str, channel: &str, args: Value, proof: Option<Value>) -> Result<Value, String> {
        let who = PhoneCall { device_id: device.into(), proof, step_up: None };
        self.rt.block_on((self.gated)(who, channel.to_string(), args))
    }
    /// A change-class call with a fresh signed proof.
    fn change(&self, device: &str, channel: &str, args: Value) -> Result<Value, String> {
        let ts = {
            let mut t = self.ts.lock().unwrap();
            *t = (*t + 1).max(self.phones.now() as i64);
            *t
        };
        let text = nekko_remote::proof::payload(device, channel, &args, ts).unwrap();
        let sig: Signature = self.key.sign(text.as_bytes());
        let proof = json!({ "ts": ts, "sig": base64::engine::general_purpose::STANDARD.encode(sig.to_bytes()) });
        self.ask(device, channel, args, Some(proof))
    }
    fn host(&self) -> Vec<String> {
        self.calls.lock().unwrap().iter().map(|(c, _)| c.clone()).collect()
    }
    fn sent(&self, channel: &str) -> Vec<Value> {
        self.calls.lock().unwrap().iter().filter(|(c, _)| c == channel).map(|(_, a)| a.clone()).collect()
    }
    fn activity(&self) -> Vec<(String, bool)> {
        self.phones.log.lock().unwrap().iter().map(|(_, a)| (a.channel.clone(), a.ok)).collect()
    }
    fn wait(&self, ms: f64) {
        *self.phones.now.lock().unwrap() += ms;
    }
}

fn refused(code: &str, detail: &str) -> Result<Value, String> {
    Err(format!("Not allowed from a paired phone ({code}): {detail}"))
}

#[test]
fn opening_needs_a_proof_and_hands_out_a_token_for_typing() {
    let r = rig(ON);
    assert_eq!(r.ask("phone-1", "terminal:open", json!(["term_1"]), None), refused("proof-required", "terminal:open"));
    let opened = r.change("phone-1", "terminal:open", json!(["term_1"])).unwrap();
    let token = opened["token"].as_str().unwrap().to_string();
    assert_eq!(opened["buffer"], "$ ");
    assert_eq!(opened["terminal"]["folder"], "app", "no absolute path");
    assert_eq!((opened["idleMs"].clone(), opened["maxMs"].clone()), (json!(300_000), json!(1_800_000)));
    // The desktop's badge names the phone.
    assert_eq!(
        r.sent("terminal:attach"),
        [json!(["term_1", { "id": "phone-1", "kind": "phone", "name": "phone-1's iPhone" }])]
    );
    assert_eq!(r.sent("terminal:tail"), [json!(["term_1", 65536])]);
    // Typing needs no proof, only the token; the computer never sees the token.
    assert_eq!(r.ask("phone-1", "terminal:write", json!(["term_1", "ls\r", token]), None), Ok(Value::Null));
    assert_eq!(r.ask("phone-1", "terminal:resize", json!(["term_1", 60, 20, token]), None), Ok(Value::Null));
    assert_eq!(r.sent("terminal:write"), [json!(["term_1", "ls\r"])]);
    assert_eq!(r.sent("terminal:resize"), [json!(["term_1", 60, 20])]);
    // Not without it, not someone else's, not for another terminal.
    assert_eq!(
        r.ask("phone-1", "terminal:write", json!(["term_1", "x"]), None),
        refused("token-required", "terminal:write")
    );
    assert_eq!(
        r.ask("phone-1", "terminal:write", json!(["term_1", "x", "nope"]), None),
        refused("token-invalid", "terminal:write")
    );
    assert_eq!(
        r.ask("phone-2", "terminal:write", json!(["term_1", "x", token]), None),
        refused("token-invalid", "terminal:write")
    );
    assert_eq!(
        r.ask("phone-1", "terminal:write", json!(["term_9", "x", token]), None),
        refused("token-invalid", "terminal:write")
    );
    assert_eq!(r.sent("terminal:write").len(), 1);
    // The activity list has the open, never a keystroke.
    assert_eq!(r.activity(), [("terminal:open".to_string(), false), ("terminal:open".to_string(), true)]);
}

#[test]
fn a_token_ends_when_idle_too_old_or_change_is_turned_off() {
    let r = rig(ON);
    let token = r.change("phone-1", "terminal:open", json!(["term_1"])).unwrap()["token"].as_str().unwrap().to_string();
    r.wait(300_001.0);
    assert_eq!(
        r.ask("phone-1", "terminal:write", json!(["term_1", "x", token]), None),
        refused("token-expired", "terminal:write")
    );
    // Opening again (Face ID within five minutes) gives a new one.
    let token = r.change("phone-1", "terminal:open", json!(["term_1"])).unwrap()["token"].as_str().unwrap().to_string();
    for _ in 0..6 {
        r.wait(290_000.0);
        assert!(r.ask("phone-1", "terminal:write", json!(["term_1", "x", token]), None).is_ok());
    }
    r.wait(290_000.0);
    assert_eq!(
        r.ask("phone-1", "terminal:write", json!(["term_1", "x", token]), None),
        refused("token-expired", "terminal:write")
    );
    // The Change switch is read on every write.
    let token = r.change("phone-1", "terminal:open", json!(["term_1"])).unwrap()["token"].as_str().unwrap().to_string();
    r.phones.devices.lock().unwrap()[0].1.access.change = false;
    assert_eq!(
        r.ask("phone-1", "terminal:write", json!(["term_1", "x", token]), None),
        refused("change-off", "terminal:write")
    );
    r.phones.devices.lock().unwrap().clear(); // revoked
    assert_eq!(
        r.ask("phone-1", "terminal:write", json!(["term_1", "x", token]), None),
        refused("device-unknown", "terminal:write")
    );
}

#[test]
fn a_phone_reaches_only_a_chats_terminals() {
    let r = rig(ON);
    assert_eq!(r.change("phone-1", "terminal:open", json!(["term_desk"])), refused("terminal-hidden", "term_desk"));
    assert_eq!(r.change("phone-1", "terminal:open", json!(["term_nope"])), refused("terminal-hidden", "term_nope"));
    // The agent's command log: read, never typed into, signalled or closed.
    assert!(r.ask("phone-1", "terminal:tail", json!(["agent_s1"]), None).is_ok());
    assert_eq!(r.change("phone-1", "terminal:open", json!(["agent_s1"])), refused("terminal-hidden", "agent_s1"));
    assert_eq!(r.change("phone-1", "terminal:close", json!(["agent_s1"])), refused("terminal-hidden", "agent_s1"));
    assert_eq!(r.ask("phone-1", "terminal:tail", json!(["term_desk"]), None), refused("terminal-hidden", "term_desk"));
    assert_eq!(r.change("phone-1", "terminal:signal", json!(["term_desk"])), refused("terminal-hidden", "term_desk"));
    assert!(!r.host().iter().any(|c| c == "terminal:attach" || c == "terminal:signal" || c == "terminal:close"));
    // One chat's list only.
    assert_eq!(r.ask("phone-1", "terminals:list", json!([]), None), refused("value-invalid", "chat id"));
    let list = r.ask("phone-1", "terminals:list", json!([{ "sessionId": "s1" }]), None).unwrap();
    let ids: Vec<&str> = list.as_array().unwrap().iter().map(|t| t["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["term_1", "agent_s1"]);
    assert!(!list.to_string().contains("/Users"), "{list}");
}

#[test]
fn reading_follows_the_read_switch_and_hosts_hide_the_user() {
    let r = rig(DeviceAccess { read: false, change: true });
    assert_eq!(r.ask("phone-1", "terminal:tail", json!(["term_1"]), None), refused("read-off", "terminal:tail"));
    assert_eq!(r.ask("phone-1", "ssh:hosts", json!([]), None), refused("read-off", "ssh:hosts"));
    let r = rig(ON);
    assert_eq!(
        r.ask("phone-1", "ssh:hosts", json!([]), None),
        Ok(json!([{ "alias": "devbox", "hostName": "devbox.lan", "port": 22 }]))
    );
}

#[test]
fn a_new_terminal_or_ssh_session_starts_in_the_chat_and_is_attached() {
    let r = rig(ON);
    let opened =
        r.change("phone-1", "terminal:create", json!([{ "sessionId": "s1", "cols": 50, "rows": 20 }])).unwrap();
    assert_eq!(
        r.sent("terminal:create"),
        [json!([{ "sessionId": "s1", "cols": 50, "rows": 20, "workspaceId": "w1" }])]
    );
    assert!(opened["token"].is_string());
    assert!(r.terminals.attached("phone-1", "term_9"));
    let ssh =
        r.change("phone-1", "ssh:open", json!(["devbox", { "sessionId": "s1", "cols": 50, "rows": 20 }])).unwrap();
    assert_eq!(r.sent("ssh:open"), [json!(["devbox", { "sessionId": "s1", "cols": 50, "rows": 20 }])]);
    assert!(ssh["token"].is_string());
    assert!(r.terminals.attached("phone-1", "term_ssh"));
    assert_eq!(
        r.change("phone-1", "terminal:create", json!([{ "sessionId": "s1", "cwd": "/" }])),
        refused("option-denied", "cwd")
    );
}

#[test]
fn leaving_and_closing_end_the_session() {
    let r = rig(ON);
    let token = r.change("phone-1", "terminal:open", json!(["term_1"])).unwrap()["token"].as_str().unwrap().to_string();
    assert_eq!(r.ask("phone-1", "terminal:leave", json!(["term_1"]), None), Ok(json!({ "left": true })));
    assert_eq!(r.sent("terminal:detach"), [json!(["term_1", "phone-1"])]);
    assert_eq!(
        r.ask("phone-1", "terminal:write", json!(["term_1", "x", token]), None),
        refused("token-invalid", "terminal:write")
    );
    let token = r.change("phone-1", "terminal:open", json!(["term_1"])).unwrap()["token"].as_str().unwrap().to_string();
    assert!(r.change("phone-1", "terminal:close", json!(["term_1"])).is_ok());
    assert!(!r.terminals.attached("phone-1", "term_1"));
    assert_eq!(
        r.ask("phone-1", "terminal:write", json!(["term_1", "x", token]), None),
        refused("token-invalid", "terminal:write")
    );
    let log: Vec<String> = r.activity().into_iter().filter(|(_, ok)| *ok).map(|(c, _)| c).collect();
    assert_eq!(log, ["terminal:open", "terminal:leave", "terminal:open", "terminal:close"]);
}

#[test]
fn a_disconnected_phone_is_detached_on_the_computer() {
    let r = rig(ON);
    r.change("phone-1", "terminal:open", json!(["term_1"])).unwrap();
    // As the relay agent does when the phone's last connection closes.
    r.rt.block_on(async {
        r.terminals.device_gone("phone-1");
        tokio::task::yield_now().await;
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    });
    assert_eq!(r.sent("terminal:detach"), [json!([null, "phone-1"])]);
    assert!(!r.terminals.attached("phone-1", "term_1"));
}

// The relay agent: output goes only to attached phones, paced.

fn core(terminals: Arc<PhoneTerminals>) -> (AgentCore, e2e::Key) {
    let key = e2e::derive_key("00112233445566778899aabbccddeeff", "room-1");
    let core = AgentCore::new(key.clone(), Box::new(e2e::random_iv))
        .with_terminals(terminals)
        .with_flow(Coalescer::new(8, 100, 64));
    (core, key)
}

fn client(key: &e2e::Key, cid: &str, v: Value) -> String {
    let data = json!({ "enc": e2e::seal_with_iv(key, &v, e2e::random_iv()) }).to_string();
    json!({ "type": "c", "cid": cid, "data": data }).to_string()
}

/// `(cid, payload)` of each event frame.
fn opened(key: &e2e::Key, frames: &[String]) -> Vec<(String, Value)> {
    frames
        .iter()
        .map(|f| {
            let f: Value = serde_json::from_str(f).unwrap();
            let d: Value = serde_json::from_str(f["data"].as_str().unwrap()).unwrap();
            let ev = e2e::open(key, d["enc"].as_str().unwrap()).unwrap();
            (f["cid"].as_str().unwrap().to_string(), ev["payload"].clone())
        })
        .collect()
}

#[test]
fn terminal_output_reaches_only_attached_phones_paced() {
    let terminals = PhoneTerminals::new();
    let gone: Arc<Mutex<Vec<String>>> = Arc::default();
    let g = gone.clone();
    terminals.on_device_gone(Arc::new(move |d| g.lock().unwrap().push(d)));
    let (mut core, key) = core(terminals.clone());
    let welcome = |h: &Value| json!({ "type": "welcome", "device": { "id": h["deviceId"] } });
    for (cid, device) in [("c1", "phone-1"), ("c2", "phone-2"), ("c3", "phone-1")] {
        core.on_relay(&client(&key, cid, json!({ "type": "hello", "deviceId": device })), &welcome);
    }
    let data = |t: &str, d: &str| json!({ "type": "data", "terminalId": t, "data": d });
    // Nobody attached: nothing goes out (this used to go to every phone).
    assert!(core.on_event_at("terminal:event", &data("term_1", "secret"), 0).is_empty());
    terminals.open("phone-1", "term_1", 0.0);
    let out = opened(&key, &core.on_event_at("terminal:event", &data("term_1", "hello"), 1));
    assert_eq!(
        out,
        [("c1".into(), data("term_1", "hello")), ("c3".into(), data("term_1", "hello"))],
        "both of phone-1's connections"
    );
    // Over the window's budget: the rest waits for the next window.
    let out = opened(&key, &core.on_event_at("terminal:event", &data("term_1", "world!!"), 2));
    assert_eq!(out.len(), 2);
    assert_eq!(out[0].1["data"], "wor");
    assert!(core.tick_at(50).is_empty());
    let out = opened(&key, &core.tick_at(101));
    assert_eq!(out[0].1["data"], "ld!!");
    // A flood past the backlog is dropped and the phone told how much.
    core.on_event_at("terminal:event", &data("term_1", &"x".repeat(8)), 300);
    core.on_event_at("terminal:event", &data("term_1", &"y".repeat(100)), 301);
    let out = opened(&key, &core.tick_at(400));
    assert_eq!(out[0].1, json!({ "type": "data", "terminalId": "term_1", "data": "", "skipped": 100 }));
    // Other agent events still reach everyone.
    assert_eq!(core.on_event_at("tasks:updated", &json!([]), 500).len(), 3);
    // One connection of phone-1 closing keeps it attached; the last one detaches it.
    core.on_relay(&json!({ "type": "client-close", "cid": "c1" }).to_string(), &welcome);
    assert!(gone.lock().unwrap().is_empty());
    assert!(terminals.attached("phone-1", "term_1"));
    core.on_relay(&json!({ "type": "client-close", "cid": "c3" }).to_string(), &welcome);
    assert_eq!(*gone.lock().unwrap(), ["phone-1"]);
    assert!(core.on_event_at("terminal:event", &data("term_1", "after"), 600).is_empty());
}

#[test]
fn an_exit_flushes_what_waits_then_ends_the_session() {
    let terminals = PhoneTerminals::new();
    let (mut core, key) = core(terminals.clone());
    let welcome = |h: &Value| json!({ "type": "welcome", "device": { "id": h["deviceId"] } });
    core.on_relay(&client(&key, "c1", json!({ "type": "hello", "deviceId": "phone-1" })), &welcome);
    terminals.open("phone-1", "term_1", 0.0);
    core.on_event_at("terminal:event", &json!({ "type": "data", "terminalId": "term_1", "data": "0123456789" }), 0);
    let exit = json!({ "type": "exit", "terminalId": "term_1", "code": 0 });
    let out = opened(&key, &core.on_event_at("terminal:event", &exit, 10));
    assert_eq!(
        out.iter().map(|(_, p)| p.clone()).collect::<Vec<_>>(),
        [json!({ "type": "data", "terminalId": "term_1", "data": "89" }), exit.clone()]
    );
    assert!(!terminals.attached("phone-1", "term_1"));
    // The relay socket dropping detaches everyone too.
    terminals.open("phone-1", "term_2", 0.0);
    core.reset();
    assert!(!terminals.attached("phone-1", "term_2"));
}
