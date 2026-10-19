//! The relay agent's protocol (`packages/host/src/relay.ts`), without any I/O:
//! relay frames and host events in, the exact frames to send the relay out.
//!
//! Relay v2 (see `packages/shared/src/remote.ts`):
//!
//! ```text
//! relay -> agent : { type:'client-open', cid } | { type:'client-close', cid }
//! relay -> agent : { type:'c', cid, data }        (data = the client's raw frame)
//! agent -> relay : { type:'d', cid, data }        (unicast to one client)
//! agent -> relay : { type:'kick', cid }           (relay closes that client)
//! agent -> relay : { type:'notify', kind, tag?, deviceId?, title, body } (content-free push trigger)
//! agent -> relay : { type:'dismiss', tag }        (a needs-you push was handled)
//! agent -> relay : { type:'push-remove', deviceId }
//! agent -> relay : { type:'activity', tag, phase, callId?, severity? } (content-free Live Activity update)
//! ```
//!
//! A client's `data` is `{"enc": seal(frame)}`. Nothing is dispatched for a
//! connection until its sealed HELLO was welcomed; replies are unicast and
//! events go only to welcomed connections, one seal per event.

use crate::e2e::{self, Key};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

/// Where IVs come from: random in production, scripted in the golden tests.
pub type IvSource = Box<dyn FnMut() -> [u8; 12] + Send>;

/// The events the agent forwards to welcomed devices (`IpcEvents`).
pub const RELAYED_EVENTS: &[&str] = &[
    "agent:event",
    "index:progress",
    "terminal:event",
    "changes:updated",
    "tasks:updated",
    "training:updated",
    "workflows:updated",
    "limits:updated",
    // The desktop's public look (theme, preset, accents) for a phone that mirrors it.
    "appearance:updated",
];

/// What to do after a relay frame.
#[derive(Debug, PartialEq)]
pub enum Out {
    /// Send this text to the relay.
    Send(String),
    /// Run a host channel for a welcomed connection, then send `reply(..)`.
    Dispatch { cid: String, id: Option<Value>, channel: String, args: Value },
}

pub struct AgentCore {
    key: Key,
    iv: IvSource,
    /// Live connections in the order the relay announced them: cid and the
    /// welcomed device, set only after a valid HELLO.
    conns: Vec<(String, Option<String>)>,
    /// Each chat's last Live Activity phase (`activity_frame`).
    phases: HashMap<String, &'static str>,
}

fn frame(v: Value) -> String {
    nekko_js::stringify(&v)
}

impl AgentCore {
    pub fn new(key: Key, iv: IvSource) -> Self {
        Self { key, iv, conns: Vec::new(), phases: HashMap::new() }
    }

    fn seal(&mut self, value: &Value) -> String {
        let iv = (self.iv)();
        frame(json!({ "enc": e2e::seal_with_iv(&self.key, value, iv) }))
    }

    fn send_to(&mut self, cid: &str, value: &Value) -> String {
        let data = self.seal(value);
        frame(json!({ "type": "d", "cid": cid, "data": data }))
    }

    fn conn(&mut self, cid: &str) -> &mut Option<String> {
        let i = match self.conns.iter().position(|(c, _)| c == cid) {
            Some(i) => i,
            None => {
                self.conns.push((cid.to_string(), None));
                self.conns.len() - 1
            }
        };
        &mut self.conns[i].1
    }

    /// The relay socket closed: every connection is gone with it.
    pub fn reset(&mut self) {
        self.conns.clear();
    }

    /// One frame from the relay. `verify` answers a HELLO (`RemoteHelloReply`).
    pub fn on_relay(&mut self, text: &str, verify: &dyn Fn(&Value) -> Value) -> Vec<Out> {
        let Ok(Value::Object(msg)) = serde_json::from_str::<Value>(text) else { return Vec::new() };
        // `String(msg.cid)`.
        let cid = || msg.get("cid").map_or_else(|| "undefined".to_string(), nekko_js::display);
        match msg.get("type").and_then(Value::as_str) {
            Some("client-open") => {
                let cid = cid();
                match self.conns.iter_mut().find(|(c, _)| *c == cid) {
                    Some(slot) => slot.1 = None,
                    None => self.conns.push((cid, None)),
                }
                Vec::new()
            }
            Some("client-close") => {
                let cid = cid();
                self.conns.retain(|(c, _)| *c != cid);
                Vec::new()
            }
            Some("c") => match (msg.get("cid").and_then(Value::as_str), msg.get("data").and_then(Value::as_str)) {
                (Some(cid), Some(data)) => self.on_client(cid, data, verify),
                _ => Vec::new(),
            },
            _ => Vec::new(),
        }
    }

    fn on_client(&mut self, cid: &str, data: &str, verify: &dyn Fn(&Value) -> Value) -> Vec<Out> {
        let Ok(Value::Object(envelope)) = serde_json::from_str::<Value>(data) else { return Vec::new() };
        let Some(enc) = envelope.get("enc").filter(|e| nekko_js::truthy(Some(e))).and_then(Value::as_str) else {
            return Vec::new();
        };
        let Some(Value::Object(f)) = e2e::open(&self.key, enc) else { return Vec::new() }; // wrong key / tampered
        self.conn(cid);
        match f.get("type").and_then(Value::as_str) {
            Some("hello") => {
                let mut reply = verify(&Value::Object(f));
                let welcomed = reply.get("type").and_then(Value::as_str) == Some("welcome");
                if welcomed {
                    *self.conn(cid) = reply.pointer("/device/id").map(nekko_js::display);
                    // The phone compares this with its own and says which side to update.
                    if let Some(o) = reply.as_object_mut() {
                        o.insert("protocol".into(), json!(crate::hello::PROTOCOL_VERSION));
                    }
                }
                let mut out = vec![Out::Send(self.send_to(cid, &reply))];
                if !welcomed {
                    out.push(Out::Send(frame(json!({ "type": "kick", "cid": cid }))));
                }
                out
            }
            Some("req") => {
                let id = f.get("id").cloned();
                if self.conn(cid).is_none() {
                    // No completed handshake: never dispatch. Tell the client why.
                    let res = res(id, Err("not paired (send hello first)".into()));
                    return vec![Out::Send(self.send_to(cid, &res))];
                }
                if f.get("channel").and_then(Value::as_str) == Some(PUSH_TEST_CHANNEL) {
                    // *Send a test notification*: the relay pushes to this phone only.
                    let device = self.conn(cid).clone();
                    let notify = frame(notify_frame("test", None, device.as_deref(), None));
                    return vec![Out::Send(notify), Out::Send(self.reply(cid, id, Ok(json!({ "ok": true }))))];
                }
                let channel = f.get("channel").map_or_else(|| "undefined".to_string(), nekko_js::display);
                let args = match f.get("args") {
                    None | Some(Value::Null) => json!([]),
                    Some(a) => a.clone(),
                };
                vec![Out::Dispatch { cid: cid.to_string(), id, channel, args }]
            }
            _ => Vec::new(),
        }
    }

    /// The sealed reply to a dispatched request. The relay silently drops a
    /// frame over its limit, so a reply that seals larger than the phone limit
    /// goes out as an error the phone can show at once (`reply` in relay.ts).
    pub fn reply(&mut self, cid: &str, id: Option<Value>, result: Result<Value, String>) -> String {
        let data = self.seal(&res(id.clone(), result));
        if data.len() <= crate::phone::policy().max_frame_bytes {
            return frame(json!({ "type": "d", "cid": cid, "data": data }));
        }
        let error = res(id, Err(crate::phone::frame_too_large(data.len())));
        self.send_to(cid, &error)
    }

    /// A host event: the relay's content-free control frames (`relay_frames`),
    /// then the event to every welcomed connection, sealed once.
    pub fn on_event(&mut self, channel: &str, payload: &Value) -> Vec<String> {
        let mut out = Vec::new();
        if channel == "agent:event" {
            out.extend(self.relay_frames(payload).into_iter().map(frame));
        }
        let welcomed: Vec<String> = self.conns.iter().filter(|(_, d)| d.is_some()).map(|(c, _)| c.clone()).collect();
        if welcomed.is_empty() {
            return out;
        }
        let data = self.seal(&json!({ "type": "event", "channel": channel, "payload": payload }));
        for cid in welcomed {
            out.push(frame(json!({ "type": "d", "cid": cid, "data": data })));
        }
        out
    }

    /// Every relay control frame one agent event causes, in order: a
    /// `finished` or `failed` push request, the Live Activity update, a
    /// `dismiss` when an approval or a question was answered or its run ended,
    /// and a `needs-you` push request when one is waiting. Exactly
    /// `relayFrames` in packages/host/src/relay.ts.
    fn relay_frames(&mut self, e: &Value) -> Vec<Value> {
        let sid = e.get("sessionId").and_then(Value::as_str).map(str::to_string);
        let prev = sid.as_ref().and_then(|s| self.phases.get(s).copied());
        let mut out = Vec::new();
        match e.get("type").and_then(Value::as_str) {
            Some("done") => out.push(notify_frame("finished", sid.as_deref(), None, None)),
            Some("error") if !stopped(e) => out.push(notify_frame("failed", sid.as_deref(), None, None)),
            _ => {}
        }
        let Some(activity) = self.activity_frame(e) else { return out };
        let phase = activity.get("phase").and_then(Value::as_str).unwrap_or("").to_string();
        let tag = activity.get("tag").cloned().unwrap_or(Value::Null);
        out.push(activity);
        if matches!(prev, Some("approval" | "question")) && prev != Some(phase.as_str()) {
            out.push(json!({ "type": "dismiss", "tag": tag }));
        }
        if phase == "approval" || phase == "question" {
            out.push(notify_frame("needs-you", sid.as_deref(), None, Some(&phase)));
        }
        out
    }

    /// A content-free `activity` frame when a chat's phase changes, so the relay
    /// can update a phone's Live Activity while iOS has suspended the app.
    /// Exactly `activityFrame` in packages/host/src/relay.ts.
    fn activity_frame(&mut self, e: &Value) -> Option<Value> {
        let sid = e.get("sessionId")?.as_str()?.to_string();
        let ty = e.get("type")?.as_str()?;
        let prev = self.phases.get(&sid).copied();
        let mut extra: Vec<(&str, Value)> = Vec::new();
        let phase: &'static str = match ty {
            "tool_approval_required" => {
                let id = e.get("call")?.get("id")?.as_str()?;
                extra.push(("callId", json!(id)));
                let sev = match e.get("severity").and_then(Value::as_str) {
                    Some("high") => "high",
                    Some("medium") => "medium",
                    _ => "low",
                };
                extra.push(("severity", json!(sev)));
                "approval"
            }
            "question" => "question",
            "tool_result" | "question_resolved" => {
                if prev != Some("approval") && prev != Some("question") {
                    return None;
                }
                "running"
            }
            "text" | "reasoning" | "tool_call" => {
                if prev.is_some() {
                    return None;
                }
                "running"
            }
            "done" => "done",
            "error" => {
                if stopped(e) {
                    "done"
                } else {
                    "failed"
                }
            }
            _ => return None,
        };
        if Some(phase) == prev && phase != "approval" {
            return None;
        }
        if phase == "done" || phase == "failed" {
            prev?;
            self.phases.remove(&sid);
        } else {
            self.phases.insert(sid.clone(), phase);
        }
        let mut o = serde_json::Map::new();
        o.insert("type".into(), json!("activity"));
        o.insert("tag".into(), json!(activity_tag(&sid)));
        o.insert("phase".into(), json!(phase));
        for (k, v) in extra {
            o.insert(k.into(), v);
        }
        Some(Value::Object(o))
    }

    /// Revocation: kick the device's live connections and drop its push token.
    pub fn kick_device(&mut self, device_id: &str) -> Vec<String> {
        let mut out: Vec<String> = self
            .conns
            .iter()
            .filter(|(_, d)| d.as_deref() == Some(device_id))
            .map(|(cid, _)| frame(json!({ "type": "kick", "cid": cid })))
            .collect();
        out.push(frame(json!({ "type": "push-remove", "deviceId": device_id })));
        out
    }

    /// Device ids with a welcomed live connection, each once.
    pub fn connected_devices(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for d in self.conns.iter().filter_map(|(_, d)| d.as_ref()) {
            if !out.contains(d) {
                out.push(d.clone());
            }
        }
        out
    }
}

/// The phone channel the relay agent answers itself (`PUSH_TEST_CHANNEL`).
pub const PUSH_TEST_CHANNEL: &str = "push:test";

/// An `error` event that is the user stopping the run, not a failure.
fn stopped(e: &Value) -> bool {
    e.get("message")
        .and_then(Value::as_str)
        .map(|m| m.eq_ignore_ascii_case("stopped") || m.eq_ignore_ascii_case("aborted"))
        .unwrap_or(false)
}

/// The content-free push request for one kind (`notifyFrame` in relay.ts);
/// `tag` is the chat's `activity_tag`.
pub fn notify_frame(kind: &str, session_id: Option<&str>, device_id: Option<&str>, phase: Option<&str>) -> Value {
    let mut o = serde_json::Map::new();
    o.insert("type".into(), json!("notify"));
    o.insert("kind".into(), json!(kind));
    if let Some(sid) = session_id {
        o.insert("tag".into(), json!(activity_tag(sid)));
    }
    if let Some(d) = device_id {
        o.insert("deviceId".into(), json!(d));
    }
    let (title, body) = match kind {
        "needs-you" => (
            "Nekko needs you",
            if phase == Some("question") { "Your computer has a question." } else { "A tool needs your approval." },
        ),
        "failed" => ("Nekko stopped", "A task stopped with an error."),
        "test" => ("Nekko Agent", "Test notification: your computer can reach this phone."),
        _ => ("Nekko finished", "Your task is ready."),
    };
    o.insert("title".into(), json!(title));
    o.insert("body".into(), json!(body));
    Value::Object(o)
}

/// `{ type:'res', id, result: result ?? null }` or `{ type:'res', id, error }`;
/// an absent id stays absent, as `JSON.stringify` drops `undefined`.
fn res(id: Option<Value>, result: Result<Value, String>) -> Value {
    let mut m = serde_json::Map::new();
    m.insert("type".into(), json!("res"));
    if let Some(id) = id {
        m.insert("id".into(), id);
    }
    match result {
        Ok(v) => m.insert("result".into(), v),
        Err(e) => m.insert("error".into(), json!(e)),
    };
    Value::Object(m)
}

/// The relay-visible tag of a chat's Live Activity: the first 32 hex digits of
/// sha256("nekko-activity:" + session id). The phone computes the same.
pub fn activity_tag(session_id: &str) -> String {
    let d = Sha256::digest(format!("nekko-activity:{session_id}").as_bytes());
    d.iter().take(16).map(|b| format!("{b:02x}")).collect()
}
