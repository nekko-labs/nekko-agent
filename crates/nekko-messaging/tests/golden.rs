//! The Rust bridge against the TS one.
//!
//! `golden/bridge.json` is a frozen record of the deleted TS
//! `createMessagingService` and `TelegramApi` over a scripted Bot API and a
//! fake host (edit it by hand per docs/runbooks/golden-fixtures.md). The same script runs here through [`Bridge`] with a
//! harness that behaves like the TS test's fakes (the Bot API answering at
//! once, the long poll waiting for the script, virtual timers), and every
//! Telegram request, long poll, host call, state file and status must come out
//! exactly as the TS recorded them.

use nekko_messaging::bridge::{Bridge, Effect, Host};
use nekko_messaging::{state, telegram};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::path::Path;

fn golden() -> Value {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("golden").join("bridge.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn same(got: &Value, want: &Value, what: &str) {
    assert_eq!(nekko_js::stringify(got), nekko_js::stringify(want), "{what}");
}

struct FakeHost {
    settings: Value,
    sessions: HashMap<String, Value>,
}

impl Host for FakeHost {
    fn settings(&self) -> Value {
        self.settings.clone()
    }
    fn session(&self, id: &str) -> Option<Value> {
        self.sessions.get(id).cloned()
    }
}

struct Harness {
    host: FakeHost,
    bridge: Bridge,
    generation: u32,
    now: u64,
    timers: Vec<(u64, u64, u32, u64)>,
    arm_seq: u64,
    /// Long polls waiting for the script: (bridge generation, nothing else needed).
    polls_waiting: VecDeque<u32>,
    state_text: Option<String>,
    session_n: u32,
    message_id: u64,
    models: Value,
    fail_chat: Option<String>,
    fail_send: Option<String>,
    fail_get_me: Option<String>,
    telegram: Vec<Value>,
    polls: Vec<Value>,
    host_calls: Vec<Value>,
}

const API: &str = "https://api.telegram.org";

impl Harness {
    fn run(&mut self, fx: Vec<Effect>) {
        let mut queue: VecDeque<Effect> = fx.into();
        while let Some(e) = queue.pop_front() {
            let more = match e {
                Effect::Tg(call) => {
                    self.telegram.push(json!({ "url": call.url, "body": call.body }));
                    let reply = self.answer(&call.method, &call.body);
                    let result = telegram::reply(&call.method, 200, reply.to_string().as_bytes());
                    self.bridge.tg_done(call.id, result)
                }
                Effect::Poll(call) => {
                    self.polls.push(json!({ "url": call.url, "body": call.body }));
                    self.polls_waiting.push_back(self.generation);
                    vec![]
                }
                Effect::Arm { timer, ms } => {
                    self.arm_seq += 1;
                    self.timers.push((self.now + ms, self.arm_seq, self.generation, timer));
                    vec![]
                }
                Effect::Disarm { timer } => {
                    let g = self.generation;
                    self.timers.retain(|t| !(t.3 == timer && t.2 == g));
                    vec![]
                }
                Effect::Save(s) => {
                    self.state_text = Some(nekko_js::stringify_pretty(&s, "  "));
                    vec![]
                }
                Effect::CreateSession { req } => {
                    self.session_n += 1;
                    let id = format!("s{}", self.session_n);
                    let s = json!({ "id": id, "title": "New chat", "messages": [], "createdAt": 1, "updatedAt": 1 });
                    self.host.sessions.insert(id.clone(), s.clone());
                    self.host_calls.push(json!({ "create": id }));
                    self.bridge.created(req, Ok(s), &self.host)
                }
                Effect::ListModels { req, provider_id } => {
                    self.host_calls.push(json!({ "listModels": provider_id }));
                    self.bridge.models_listed(req, Ok(self.models.clone()))
                }
                Effect::SendChat { req, opts } => {
                    self.host_calls.push(json!({ "send": opts }));
                    let r = match self.fail_chat.take() {
                        Some(m) => Err(m),
                        None => Ok(Value::Null),
                    };
                    self.bridge.sent(req, r)
                }
                Effect::Approve { session_id, call_id, approved } => {
                    self.host_calls.push(json!({ "approve": [session_id, call_id, approved] }));
                    vec![]
                }
                Effect::Answer { session_id, call_id, answers } => {
                    self.host_calls.push(json!({ "answer": [session_id, call_id, answers] }));
                    vec![]
                }
            };
            queue.extend(more);
        }
    }

    /// The scripted Bot API's answers (the TS test's `fetchImpl`).
    fn answer(&mut self, method: &str, body: &str) -> Value {
        match method {
            "getMe" => match self.fail_get_me.take() {
                Some(d) => json!({ "ok": false, "error_code": 401, "description": d }),
                None => json!({ "ok": true, "result": { "id": 7, "is_bot": true, "username": "nekko_bot" } }),
            },
            "sendMessage" => match self.fail_send.take() {
                Some(d) => json!({ "ok": false, "error_code": 400, "description": d }),
                None => {
                    let chat: Value = serde_json::from_str::<Value>(body).unwrap()["chat_id"].clone();
                    let id = self.message_id;
                    self.message_id += 1;
                    let n = nekko_js::to_number(Some(&chat));
                    json!({ "ok": true, "result": { "message_id": id, "chat": { "id": n as i64, "type": "private" } } })
                }
            },
            _ => json!({ "ok": true, "result": true }),
        }
    }

    fn tick(&mut self, ms: u64) {
        let until = self.now + ms;
        loop {
            let g = self.generation;
            let next = self
                .timers
                .iter()
                .enumerate()
                .filter(|(_, t)| t.0 <= until)
                .min_by_key(|(_, t)| (t.0, t.1))
                .map(|(i, _)| i);
            let Some(i) = next else { break };
            let (due, _, gen_, timer) = self.timers.remove(i);
            self.now = due;
            if gen_ == g {
                let fx = self.bridge.timer(timer);
                self.run(fx);
            }
        }
        self.now = until;
    }

    fn resolve_poll(&mut self, result: Result<Value, String>) {
        let g = self.polls_waiting.pop_front().expect("no poll waiting");
        assert_eq!(g, self.generation, "the script only answers the live bridge's polls");
        let fx = self.bridge.poll_done(result, &self.host);
        self.run(fx);
    }
}

#[test]
fn state_files_load_as_the_ts_bridge_loads_them() {
    let g = golden();
    for case in g["loads"].as_array().unwrap() {
        let file = case["file"].as_str().map(str::as_bytes);
        assert_eq!(state::text(&state::load(file)), case["state"].as_str().unwrap(), "{}", case["file"]);
    }
}

#[test]
fn auto_chats_pick_the_model_the_composer_would() {
    let g = golden();
    for case in g["autoPicks"].as_array().unwrap() {
        let models = case["models"].as_array().unwrap();
        let prompt = case["prompt"].as_str().unwrap();
        let got = nekko_messaging::auto::pick(models, prompt).unwrap_or(Value::Null);
        assert_eq!(got, case["pick"], "{prompt}: {}", case["models"]);
    }
}

#[test]
fn the_bridge_runs_the_golden_script() {
    let g = golden();
    let initial = g["initialState"].as_str().unwrap().to_string();
    let sessions =
        g["sessions"].as_array().unwrap().iter().map(|s| (s["id"].as_str().unwrap().to_string(), s.clone())).collect();
    let mut h = Harness {
        host: FakeHost { settings: g["settings"].clone(), sessions },
        bridge: Bridge::new(state::load(Some(initial.as_bytes())), API),
        generation: 0,
        now: 0,
        timers: Vec::new(),
        arm_seq: 0,
        polls_waiting: VecDeque::new(),
        state_text: Some(initial),
        session_n: 0,
        message_id: 100,
        models: json!([]),
        fail_chat: None,
        fail_send: None,
        fail_get_me: None,
        telegram: Vec::new(),
        polls: Vec::new(),
        host_calls: Vec::new(),
    };
    for (i, step) in g["steps"].as_array().unwrap().iter().enumerate() {
        h.telegram.clear();
        h.polls.clear();
        h.host_calls.clear();
        let op = &step["op"];
        if let Some(m) = op.get("settings") {
            h.host.settings["messaging"] = m.clone();
            let fx = h.bridge.update(Some(m));
            h.run(fx);
        } else if let Some(updates) = op.get("updates") {
            if let Some(m) = op.get("models") {
                h.models = m.clone();
            }
            if let Some(f) = op.get("failChat") {
                h.fail_chat = f.as_str().map(str::to_string);
            }
            let reply = json!({ "ok": true, "result": updates });
            h.resolve_poll(telegram::reply("getUpdates", 200, reply.to_string().as_bytes()));
        } else if let Some(e) = op.get("pollError") {
            let reply = json!({ "ok": false, "error_code": 409, "description": e });
            h.resolve_poll(telegram::reply("getUpdates", 409, reply.to_string().as_bytes()));
        } else if let Some(e) = op.get("event") {
            let fx = h.bridge.event(e);
            h.run(fx);
        } else if let Some(ms) = op.get("tick") {
            h.tick(ms.as_u64().unwrap());
        } else if let Some(f) = op.get("failSend") {
            h.fail_send = f.as_str().map(str::to_string);
        } else if let Some(f) = op.get("failGetMe") {
            h.fail_get_me = f.as_str().map(str::to_string);
        } else if op.get("stop").is_some() {
            let fx = h.bridge.stop();
            h.run(fx);
        } else if let Some(m) = op.get("restart") {
            let text = h.state_text.clone();
            h.generation += 1;
            h.bridge = Bridge::new(state::load(text.as_deref().map(str::as_bytes)), API);
            h.host.settings["messaging"] = m.clone();
            let fx = h.bridge.update(Some(m));
            h.run(fx);
        } else {
            panic!("unknown op {op}");
        }
        let what = |k: &str| format!("step {i} {k}: {}", nekko_js::stringify(op));
        same(&json!(h.telegram), &step["telegram"], &what("telegram"));
        same(&json!(h.polls), &step["polls"], &what("polls"));
        same(&json!(h.host_calls), &step["host"], &what("host"));
        same(&json!(h.state_text), &step["state"], &what("state"));
        same(&h.bridge.status(), &step["status"], &what("status"));
    }
}
