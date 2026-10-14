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
//! agent -> relay : { type:'notify', title, body } (content-free push trigger)
//! agent -> relay : { type:'push-remove', deviceId }
//! ```
//!
//! A client's `data` is `{"enc": seal(frame)}`. Nothing is dispatched for a
//! connection until its sealed HELLO was welcomed; replies are unicast and
//! events go only to welcomed connections, one seal per event.

use crate::e2e::{self, Key};
use serde_json::{Value, json};

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
}

fn frame(v: Value) -> String {
    nekko_js::stringify(&v)
}

impl AgentCore {
    pub fn new(key: Key, iv: IvSource) -> Self {
        Self { key, iv, conns: Vec::new() }
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
                let reply = verify(&Value::Object(f));
                let welcomed = reply.get("type").and_then(Value::as_str) == Some("welcome");
                if welcomed {
                    *self.conn(cid) = reply.pointer("/device/id").map(nekko_js::display);
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

    /// The sealed reply to a dispatched request.
    pub fn reply(&mut self, cid: &str, id: Option<Value>, result: Result<Value, String>) -> String {
        let res = res(id, result);
        self.send_to(cid, &res)
    }

    /// A host event: the push ping when a run finished, then the event to
    /// every welcomed connection, sealed once.
    pub fn on_event(&mut self, channel: &str, payload: &Value) -> Vec<String> {
        let mut out = Vec::new();
        if channel == "agent:event" && payload.get("type").and_then(Value::as_str) == Some("done") {
            out.push(frame(json!({ "type": "notify", "title": "Nekko finished", "body": "Your task is ready." })));
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
