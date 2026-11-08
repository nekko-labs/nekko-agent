//! The Rust relay agent's protocol, without any I/O: relay frames and daemon
//! events in, the exact frames to send the relay out. Historical TS golden
//! fixtures cover the legacy controls, including phase-based dismissals. The
//! production socket holds those dismissals until a complete pending snapshot
//! confirms no input remains. Core-only goldens do not model that I/O boundary.
//!
//! Relay v2 (see `packages/shared/src/remote.ts`):
//!
//! ```text
//! relay -> agent : { type:'client-open', cid } | { type:'client-close', cid }
//! relay -> agent : { type:'c', cid, data }        (data = the client's raw frame)
//! agent -> relay : { type:'d', cid, data }        (unicast to one client)
//! agent -> relay : { type:'kick', cid }           (relay closes that client)
//! agent -> relay : { type:'welcomed', cid, deviceId } (sent before the sealed welcome;
//!                  only this may register for pushes, which the relay can't read)
//! agent -> relay : { type:'notify', kind, tag?, deviceId?, title, body } (content-free push trigger)
//! agent -> relay : { type:'dismiss', tag }        (a needs-you push was handled)
//! agent -> relay : { type:'attention-snapshot', tags } (complete pending-chat set)
//! agent -> relay : { type:'attention-unknown' }    (withdraw completeness)
//! agent -> relay : { type:'push-remove', deviceId }
//! agent -> relay : { type:'activity', tag, phase, callId?, severity? } (content-free Live Activity update)
//! agent -> relay : { type:'card' | 'card-start', state } (the iPhone's one Live Activity card, `card.rs`)
//! ```
//!
//! A client's `data` is `{"enc": seal(frame)}`. Nothing is dispatched for a
//! connection until its sealed HELLO was welcomed; replies are unicast and
//! events go only to welcomed connections, sealed for each.
//!
//! The handshake (phone protocol 6, decision 0041, `relay-handshake.json`):
//! when the relay announces a connection the agent makes a one-use P-256 key
//! and sends `{type:'challenge', challenge, eph, sig}` under the room key,
//! `sig` being its host key's signature ([`hello::host_text`]). A device checks
//! that against the host key pinned from its pairing link, makes its own
//! one-use key and answers `{eph, enc}`: its half of the exchange beside the
//! HELLO sealed under the key the two derive. Only the two ends can derive it,
//! so holding the room secret, as every device ever paired did, buys nothing.
//! The HELLO answers the challenge once and is signed with the device key over
//! both ephemeral keys. Every frame after it is sealed under that key.
//!
//! Every request on a welcomed connection carries the challenge and a `seq`
//! that only goes up; anything else is dropped and the connection is sent back
//! to the handshake. A HELLO under the room key is an older app: refused with
//! `update-required`. Relay frames that announce connections are capped: at
//! most `MAX_UNWELCOMED` connections wait for a HELLO, the oldest is forgotten
//! first.

use crate::card::{CARD_CHANNEL, Cards, REFERENCE_DATE};
use crate::e2e::{self, Ephemeral, Key};
use crate::phone_terminal::{Coalescer, PhoneTerminals, data_event};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

/// Where IVs come from: random in production, scripted in the golden tests.
pub type IvSource = Box<dyn FnMut() -> [u8; 12] + Send>;

/// The wall clock the card's dates come from, in seconds since 2001 (ActivityKit's).
pub type CardClock = Box<dyn Fn() -> f64 + Send>;

fn wall_clock() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64()) - REFERENCE_DATE
}

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

/// What to do after a relay frame. Short-lived (one per frame, consumed at
/// once), so the larger `Dispatch` is not worth a box.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, PartialEq)]
pub enum Out {
    /// Send this text to the relay.
    Send(String),
    /// Run a host channel for a welcomed connection, then send `reply(..)`.
    /// `device_id` is the device the HELLO welcomed on `cid`, so the phone
    /// gate knows who is calling; `proof` is the request's signed Change
    /// proof, when it carried one (IO-33).
    Dispatch {
        cid: String,
        id: Option<Value>,
        device_id: String,
        channel: String,
        args: Value,
        proof: Option<Value>,
        /// The request's step-up (`stepUp`), when it carried one (SK-2).
        step_up: Option<Value>,
    },
}

/// The most connections kept waiting for a HELLO; past it the oldest is forgotten.
pub const MAX_UNWELCOMED: usize = 64;

/// Random bytes in a challenge (base64, 24 characters).
const CHALLENGE_BYTES: usize = 18;

/// One relay connection as the agent knows it.
#[derive(Debug, Default)]
struct Conn {
    /// When the relay announced it, for the welcomed order and eviction.
    order: u64,
    /// The welcomed device, set only after a valid HELLO.
    device: Option<String>,
    /// The challenge sent and not yet answered (single use).
    challenge: Option<String>,
    /// This connection's half of the key exchange, until a HELLO uses it.
    ephemeral: Option<Ephemeral>,
    /// The key this connection and its device derived, once welcomed.
    session: Option<Key>,
    /// The challenge the welcomed HELLO answered: every request carries it.
    bound: Option<String>,
    /// The highest `seq` accepted on this connection.
    seq: u64,
    /// The owner's Read switch: without it a connection gets no events.
    reads: bool,
}

/// Who this agent is: the room it serves and the key its devices pinned.
pub struct Host {
    pub room: String,
    pub key: crate::client::SigningKey,
}

pub struct AgentCore {
    key: Key,
    host: Host,
    iv: IvSource,
    /// Where challenges come from: the OS in production, scripted in tests.
    random: crate::hello::Random,
    /// Live connections by cid.
    conns: HashMap<String, Conn>,
    /// The next connection's `order`.
    next_order: u64,
    /// Each chat's last Live Activity phase (`activity_frame`).
    phases: HashMap<String, &'static str>,
    /// Which phone is attached to which terminal (shared with the phone
    /// gate): `terminal:event` goes only to those phones (FA-3).
    terminals: Arc<PhoneTerminals>,
    /// Paces each terminal's output to phones.
    flow: Coalescer,
    epoch: Instant,
    /// The iPhone's Live Activity card, for the phones that asked for one.
    cards: Cards,
    clock: CardClock,
}

fn frame(v: Value) -> String {
    nekko_js::stringify(&v)
}

impl AgentCore {
    pub fn new(key: Key, host: Host, iv: IvSource) -> Self {
        Self {
            key,
            host,
            iv,
            random: crate::hello::os_random(),
            conns: HashMap::new(),
            next_order: 0,
            phases: HashMap::new(),
            terminals: PhoneTerminals::new(),
            flow: Coalescer::from_policy(),
            epoch: Instant::now(),
            cards: Cards::default(),
            clock: Box::new(wall_clock),
        }
    }

    /// Date the card from `clock` instead of the system's (tests).
    pub fn with_clock(mut self, clock: CardClock) -> Self {
        self.clock = clock;
        self
    }

    /// Whether the card needs the chat list (`sessions:summaries`) read: the
    /// caller reads it and hands it to `set_summaries`. True once per need.
    pub fn wants_summaries(&mut self) -> bool {
        self.cards.wants_summaries()
    }

    /// The chat list for the card: its titles, reply lines and watches.
    pub fn set_summaries(&mut self, list: &Value) -> Vec<String> {
        let now = (self.clock)();
        self.cards.set_summaries(list, now).into_iter().map(frame).collect()
    }

    /// Share the phone gate's terminal attachments (`phone::gate_shared`).
    /// Without it no phone is ever attached, so no terminal output is relayed.
    pub fn with_terminals(mut self, terminals: Arc<PhoneTerminals>) -> Self {
        self.terminals = terminals;
        self
    }

    /// Draw challenges from `random` instead of the OS (tests).
    pub fn with_random(mut self, random: crate::hello::Random) -> Self {
        self.random = random;
        self
    }

    /// Pace terminal output with these limits instead of the policy's (tests).
    pub fn with_flow(mut self, flow: Coalescer) -> Self {
        self.flow = flow;
        self
    }

    fn now_ms(&self) -> u64 {
        self.epoch.elapsed().as_millis() as u64
    }

    /// Devices that had a welcomed connection in `before` and have none now:
    /// they are detached from every terminal.
    fn forget_gone(&mut self, before: Vec<String>) {
        let after = self.connected_devices();
        for d in before.into_iter().filter(|d| !after.contains(d)) {
            self.terminals.device_gone(&d);
        }
    }

    /// `value` to `cid` under `key`.
    fn sealed(&mut self, key: &Key, cid: &str, value: &Value) -> String {
        let iv = (self.iv)();
        let data = frame(json!({ "enc": e2e::seal_with_iv(key, value, iv) }));
        frame(json!({ "type": "d", "cid": cid, "data": data }))
    }

    /// `value` to a connection under its own key. `None` without one: nothing
    /// but a challenge or a refusal to update ever goes out under the room key.
    fn send_to(&mut self, cid: &str, value: &Value) -> Option<String> {
        let key = self.conns.get(cid)?.session.clone()?;
        Some(self.sealed(&key, cid, value))
    }

    /// Under the room key: a challenge, or telling an older app to update.
    fn send_room(&mut self, cid: &str, value: &Value) -> String {
        let key = self.key.clone();
        self.sealed(&key, cid, value)
    }

    /// The connection `cid`, made (unwelcomed) if the relay never announced it.
    fn conn(&mut self, cid: &str) -> &mut Conn {
        if !self.conns.contains_key(cid) {
            self.open_conn(cid);
        }
        self.conns.get_mut(cid).expect("just made")
    }

    /// A fresh, unwelcomed connection `cid` (replacing any before it), keeping
    /// at most `MAX_UNWELCOMED` waiting for a HELLO.
    fn open_conn(&mut self, cid: &str) {
        self.conns.remove(cid);
        let waiting = self.conns.values().filter(|c| c.device.is_none()).count();
        if waiting >= MAX_UNWELCOMED {
            let oldest = self
                .conns
                .iter()
                .filter(|(_, c)| c.device.is_none())
                .min_by_key(|(_, c)| c.order)
                .map(|(cid, _)| cid.clone());
            if let Some(oldest) = oldest {
                self.conns.remove(&oldest);
            }
        }
        let order = self.next_order;
        self.next_order += 1;
        self.conns.insert(cid.to_string(), Conn { order, ..Conn::default() });
    }

    /// Send `cid` a fresh challenge signed with the host key, replacing any it
    /// had: the connection goes back to the handshake and loses its key.
    fn challenge(&mut self, cid: &str) -> String {
        let mut bytes = [0u8; CHALLENGE_BYTES];
        (self.random)(&mut bytes);
        let nonce = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes);
        let ephemeral = Ephemeral::new(&self.random);
        let text = crate::hello::host_text(&self.host.room, &nonce, &ephemeral.public);
        let sig = crate::proof::sign(&self.host.key, &text);
        let eph = ephemeral.public.clone();
        let conn = self.conn(cid);
        conn.device = None;
        conn.bound = None;
        conn.seq = 0;
        conn.session = None;
        conn.ephemeral = Some(ephemeral);
        conn.challenge = Some(nonce.clone());
        self.send_room(cid, &json!({ "type": "challenge", "challenge": nonce, "eph": eph, "sig": sig }))
    }

    /// Welcomed connections' cids, in the order the relay announced them.
    fn welcomed(&self) -> Vec<String> {
        let mut list: Vec<(&String, &Conn)> = self.conns.iter().filter(|(_, c)| c.device.is_some()).collect();
        list.sort_by_key(|(_, c)| c.order);
        list.into_iter().map(|(cid, _)| cid.clone()).collect()
    }

    /// Welcomed connections allowed to read, for events.
    fn readers(&self) -> Vec<String> {
        self.welcomed().into_iter().filter(|cid| self.conns[cid].reads).collect()
    }

    /// The relay socket closed: every connection is gone with it.
    pub fn reset(&mut self) {
        let before = self.connected_devices();
        self.conns.clear();
        self.cards.reconnected();
        self.forget_gone(before);
    }

    /// One frame from the relay. `verify` answers a HELLO (`RemoteHelloReply`).
    /// A device left with no welcomed connection is detached from its terminals.
    pub fn on_relay(&mut self, text: &str, verify: &dyn Fn(&Value) -> Value) -> Vec<Out> {
        let before = self.connected_devices();
        let out = self.on_relay_frame(text, verify);
        self.forget_gone(before);
        out
    }

    fn on_relay_frame(&mut self, text: &str, verify: &dyn Fn(&Value) -> Value) -> Vec<Out> {
        let Ok(Value::Object(msg)) = serde_json::from_str::<Value>(text) else { return Vec::new() };
        // `String(msg.cid)`.
        let cid = || msg.get("cid").map_or_else(|| "undefined".to_string(), nekko_js::display);
        match msg.get("type").and_then(Value::as_str) {
            Some("client-open") => {
                let cid = cid();
                self.open_conn(&cid);
                vec![Out::Send(self.challenge(&cid))]
            }
            Some("client-close") => {
                self.conns.remove(&cid());
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
        if let Some(theirs) = envelope.get("eph").and_then(Value::as_str) {
            return self.on_hello(cid, theirs, enc, verify);
        }
        if let Some(key) = self.conns.get(cid).and_then(|c| c.session.clone()) {
            return match e2e::open(&key, enc) {
                Some(Value::Object(f)) if f.get("type").and_then(Value::as_str) == Some("req") => {
                    self.on_request(cid, &f)
                }
                _ => Vec::new(), // wrong key / tampered
            };
        }
        match e2e::open(&self.key, enc) {
            Some(Value::Object(f)) if f.get("type").and_then(Value::as_str) == Some("hello") => self.older_app(cid),
            _ => Vec::new(),
        }
    }

    /// A HELLO with the key exchange: answers the challenge, once, and is
    /// signed for this exchange. Whatever it says, the reply goes under the key
    /// only its sender can have derived.
    fn on_hello(&mut self, cid: &str, theirs: &str, enc: &str, verify: &dyn Fn(&Value) -> Value) -> Vec<Out> {
        let Some(conn) = self.conns.get(cid) else { return Vec::new() };
        let (Some(ours), Some(issued)) = (conn.ephemeral.as_ref(), conn.challenge.as_deref()) else {
            return vec![Out::Send(self.challenge(cid))];
        };
        let info = crate::hello::session_info(&self.host.room, issued, &ours.public, theirs);
        let Some(key) = ours.session_key(theirs, &info) else { return Vec::new() };
        // Not this connection's exchange: the challenge stands for the real one.
        let Some(Value::Object(mut f)) = e2e::open(&key, enc) else { return Vec::new() };
        let conn = self.conn(cid);
        let (issued, ours) = (conn.challenge.take(), conn.ephemeral.take());
        let answered = f.get("challenge").and_then(Value::as_str);
        if f.get("type").and_then(Value::as_str) != Some("hello") || answered != issued.as_deref() {
            return vec![Out::Send(self.challenge(cid))];
        }
        f.insert("hostEph".into(), json!(ours.map(|e| e.public)));
        f.insert("clientEph".into(), json!(theirs));
        let mut reply = verify(&Value::Object(f));
        let welcomed = reply.get("type").and_then(Value::as_str) == Some("welcome");
        let mut out = Vec::new();
        if welcomed {
            let device = reply.pointer("/device/id").map(nekko_js::display);
            let reads = reply.pointer("/device/access/read") != Some(&Value::Bool(false));
            let conn = self.conn(cid);
            conn.device = device.clone();
            conn.session = Some(key.clone());
            conn.bound = issued;
            conn.seq = 0;
            conn.reads = reads;
            // The phone compares this with its own and says which side to update.
            if let Some(o) = reply.as_object_mut() {
                o.insert("protocol".into(), json!(crate::hello::PROTOCOL_VERSION));
            }
            // First: a phone registers for pushes as soon as it hears the welcome.
            out.push(Out::Send(frame(json!({ "type": "welcomed", "cid": cid, "deviceId": device }))));
        }
        out.push(Out::Send(self.sealed(&key, cid, &reply)));
        if !welcomed {
            out.push(Out::Send(frame(json!({ "type": "kick", "cid": cid }))));
        }
        out
    }

    /// A HELLO under the room key: an app from before this computer's protocol,
    /// or someone holding the room secret. Neither is welcomed, whatever it
    /// claims, and it reaches no registry or log: anyone ever paired can send one.
    fn older_app(&mut self, cid: &str) -> Vec<Out> {
        let reply = json!({ "type": "denied", "reason": "update-required" });
        vec![Out::Send(self.send_room(cid, &reply)), Out::Send(frame(json!({ "type": "kick", "cid": cid })))]
    }

    /// A request on a welcomed connection.
    fn on_request(&mut self, cid: &str, f: &serde_json::Map<String, Value>) -> Vec<Out> {
        let id = f.get("id").cloned();
        if !self.in_order(cid, f) {
            // Replayed, reordered or from another connection: dropped
            // unanswered, and the connection goes back to the handshake.
            return vec![Out::Send(self.challenge(cid))];
        }
        if f.get("channel").and_then(Value::as_str) == Some(CARD_CHANNEL) {
            // The phone's card level, focus or dismissal: answered here, never by the host.
            let device = self.conn(cid).device.clone().unwrap_or_default();
            let now = (self.clock)();
            let args = f.get("args").cloned().unwrap_or(Value::Null);
            let mut out: Vec<Out> =
                self.cards.set(&device, &args, now).into_iter().map(|v| Out::Send(frame(v))).collect();
            out.extend(self.reply(cid, id, Ok(json!({ "ok": true }))).map(Out::Send));
            return out;
        }
        if f.get("channel").and_then(Value::as_str) == Some(PUSH_TEST_CHANNEL) {
            // *Send a test notification*: the relay pushes to this phone only.
            let device = self.conn(cid).device.clone();
            let notify = frame(notify_frame("test", None, device.as_deref(), None));
            let mut out = vec![Out::Send(notify)];
            out.extend(self.reply(cid, id, Ok(json!({ "ok": true }))).map(Out::Send));
            return out;
        }
        let channel = f.get("channel").map_or_else(|| "undefined".to_string(), nekko_js::display);
        let args = match f.get("args") {
            None | Some(Value::Null) => json!([]),
            Some(a) => a.clone(),
        };
        // Welcomed above, so the connection has its device.
        let device_id = self.conn(cid).device.clone().unwrap_or_default();
        let proof = f.get("proof").filter(|p| !p.is_null()).cloned();
        let step_up = f.get("stepUp").filter(|p| !p.is_null()).cloned();
        self.cards.phone_call(&channel, &args, (self.clock)());
        vec![Out::Dispatch { cid: cid.to_string(), id, device_id, channel, args, proof, step_up }]
    }

    /// Whether a request is the next one: it carries the connection's
    /// challenge and a `seq` above every one before it (accepted and remembered).
    fn in_order(&mut self, cid: &str, f: &serde_json::Map<String, Value>) -> bool {
        let conn = self.conn(cid);
        let Some(bound) = conn.bound.as_deref() else { return false };
        let seq = f.get("seq").and_then(Value::as_u64);
        match seq {
            Some(seq) if seq > conn.seq && f.get("challenge").and_then(Value::as_str) == Some(bound) => {
                conn.seq = seq;
                true
            }
            _ => false,
        }
    }

    /// The sealed reply to a dispatched request. The relay silently drops a
    /// frame over its limit, so a reply that seals larger than the phone limit
    /// goes out as an error the phone can show at once (`reply` in relay.ts).
    /// `None` when the connection lost its key meanwhile: its reply can't be sealed.
    pub fn reply(&mut self, cid: &str, id: Option<Value>, result: Result<Value, String>) -> Option<String> {
        let out = self.send_to(cid, &res(id.clone(), result))?;
        if out.len() <= crate::phone::policy().max_frame_bytes {
            return Some(out);
        }
        let error = res(id, Err(crate::phone::frame_too_large(out.len())));
        self.send_to(cid, &error)
    }

    /// A host event: the relay's content-free control frames (`relay_frames`),
    /// then the event to every welcomed connection, sealed once.
    pub fn on_event(&mut self, channel: &str, payload: &Value) -> Vec<String> {
        let now = self.now_ms();
        self.on_event_at(channel, payload, now)
    }

    /// `on_event` at `now` (ms on the agent's own clock). A terminal's
    /// output goes only to the phones attached to it, paced (`Coalescer`).
    pub fn on_event_at(&mut self, channel: &str, payload: &Value, now: u64) -> Vec<String> {
        if channel == "terminal:event" {
            return self.terminal_event(payload, now);
        }
        let mut out = Vec::new();
        if channel == "agent:event" {
            out.extend(self.relay_frames(payload).into_iter().map(frame));
            let now = (self.clock)();
            out.extend(self.cards.on_event(payload, now).into_iter().map(frame));
        }
        let event = json!({ "type": "event", "channel": channel, "payload": payload });
        for cid in self.readers() {
            out.extend(self.send_to(&cid, &event));
        }
        out
    }

    /// Welcomed connections whose device is attached to `terminal`.
    fn viewers_of(&self, terminal: &str) -> Vec<String> {
        self.readers()
            .into_iter()
            .filter(|cid| self.conns[cid].device.as_deref().is_some_and(|d| self.terminals.attached(d, terminal)))
            .collect()
    }

    /// One sealed event to each of `cids`.
    fn send_event(&mut self, cids: &[String], channel: &str, payload: Value) -> Vec<String> {
        let event = json!({ "type": "event", "channel": channel, "payload": payload });
        cids.iter().filter_map(|cid| self.send_to(cid, &event)).collect()
    }

    fn terminal_event(&mut self, payload: &Value, now: u64) -> Vec<String> {
        let Some(id) = payload.get("terminalId").and_then(Value::as_str).map(str::to_string) else { return Vec::new() };
        let cids = self.viewers_of(&id);
        match payload.get("type").and_then(Value::as_str) {
            Some("data") => {
                if cids.is_empty() {
                    // Nobody is watching: nothing waits for a phone either.
                    self.flow.take(&id);
                    return Vec::new();
                }
                let data = payload.get("data").and_then(Value::as_str).unwrap_or("");
                match self.flow.push(&id, data, now) {
                    Some((data, skipped)) => self.send_event(&cids, "terminal:event", data_event(&id, &data, skipped)),
                    None => Vec::new(),
                }
            }
            Some("exit") => {
                // What was still waiting goes first, then the exit; the terminal's sessions end.
                let mut out = match self.flow.take(&id) {
                    Some((data, skipped)) => self.send_event(&cids, "terminal:event", data_event(&id, &data, skipped)),
                    None => Vec::new(),
                };
                out.extend(self.send_event(&cids, "terminal:event", payload.clone()));
                self.terminals.terminal_gone(&id);
                out
            }
            _ => self.send_event(&cids, "terminal:event", payload.clone()),
        }
    }

    /// Terminal output whose pacing window has come round (call often, e.g.
    /// every 25 ms; it does nothing while no output waits).
    pub fn tick(&mut self) -> Vec<String> {
        let now = self.now_ms();
        self.tick_at(now)
    }

    pub fn tick_at(&mut self, now: u64) -> Vec<String> {
        let wall = (self.clock)();
        let mut out: Vec<String> = self.cards.tick(wall).into_iter().map(frame).collect();
        if self.flow.is_idle() {
            return out;
        }
        for (id, data, skipped) in self.flow.due(now) {
            let cids = self.viewers_of(&id);
            out.extend(self.send_event(&cids, "terminal:event", data_event(&id, &data, skipped)));
        }
        out
    }

    /// A complete, unclipped `chat:pending` map from the daemon, never the card
    /// or a saved session list. One chat contributes once regardless of how many
    /// approvals/questions it has. Invalid input withdraws authority, not zero.
    pub fn attention_snapshot(&self, pending: &Value) -> String {
        let Some(pending) = pending.as_object() else { return Self::attention_unknown() };
        // The protocol caps supplied entries before deduplication. Never clip.
        if pending.len() > 4096 {
            return Self::attention_unknown();
        }
        let mut tags = Vec::new();
        for (sid, entry) in pending {
            if sid.is_empty() || !entry.is_object() {
                return Self::attention_unknown();
            }
            let waits = |key| entry.get(key).is_some_and(Value::is_object);
            if !waits("approval") && !waits("question") {
                return Self::attention_unknown();
            }
            tags.push(activity_tag(sid));
        }
        tags.sort_unstable();
        tags.dedup();
        frame(json!({ "type": "attention-snapshot", "tags": tags }))
    }

    pub fn attention_unknown() -> String {
        frame(json!({ "type": "attention-unknown" }))
    }

    /// Whether an event can change the full pending map. The socket reads again
    /// after these events and rejects reads overtaken by a subsequent event.
    pub fn attention_changed(channel: &str, e: &Value) -> bool {
        channel == "agent:event"
            && matches!(
                e.get("type").and_then(Value::as_str),
                Some("tool_approval_required" | "question" | "tool_result" | "question_resolved" | "approval_resolved" | "done" | "error")
            )
    }

    /// Legacy activity phases are not chat-wide pending state. Before any
    /// removal control, withdraw authority until the socket completes a full
    /// read. Resolving one request must never assert a known zero for its chat.
    fn relay_frames(&mut self, e: &Value) -> Vec<Value> {
        let sid = e.get("sessionId").and_then(Value::as_str).map(str::to_string);
        let prev = sid.as_ref().and_then(|s| self.phases.get(s).copied());
        let mut out = Vec::new();
        if matches!(e.get("type").and_then(Value::as_str), Some("tool_result" | "question_resolved" | "approval_resolved" | "done" | "error"))
        {
            out.push(json!({ "type": "attention-unknown" }));
        }
        match e.get("type").and_then(Value::as_str) {
            Some("done") => out.push(notify_frame("finished", sid.as_deref(), None, None)),
            Some("error") if !stopped(e) => out.push(notify_frame("failed", sid.as_deref(), None, None)),
            _ => {}
        }
        let Some(activity) = self.activity_frame(e) else { return out };
        let phase = activity.get("phase").and_then(Value::as_str).unwrap_or("").to_string();
        let tag = activity.get("tag").cloned().unwrap_or(Value::Null);
        if !matches!(phase.as_str(), "approval" | "question")
            && out.first().and_then(|f| f["type"].as_str()) != Some("attention-unknown")
        {
            // Even the first text after reconnect can say "running" while
            // another request in this chat is still pending.
            out.insert(0, json!({ "type": "attention-unknown" }));
        }
        out.push(activity);
        if matches!(prev, Some("approval" | "question")) && !matches!(phase.as_str(), "approval" | "question") {
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
            "tool_result" | "question_resolved" | "approval_resolved" => {
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
        self.cards.forget(device_id);
        let mut out = self.disconnect_device(device_id);
        out.push(frame(json!({ "type": "push-remove", "deviceId": device_id })));
        out
    }

    /// Kick the device's live connections and keep its push token, so the
    /// phone is still told about chats when remote access comes back
    /// (`remote:stop`). Only an intentional disconnect (revoke, sign out)
    /// drops push. The connections end here first: a kick is only a request to
    /// the relay, and a relay that ignores it must get nothing more to pass on.
    pub fn disconnect_device(&mut self, device_id: &str) -> Vec<String> {
        let before = self.connected_devices();
        let cids: Vec<String> =
            self.welcomed().into_iter().filter(|cid| self.conns[cid].device.as_deref() == Some(device_id)).collect();
        for cid in &cids {
            self.conns.remove(cid);
        }
        self.forget_gone(before);
        cids.into_iter().map(|cid| frame(json!({ "type": "kick", "cid": cid }))).collect()
    }

    /// The owner changed a device's Read switch.
    pub fn set_reads(&mut self, device_id: &str, reads: bool) {
        for conn in self.conns.values_mut().filter(|c| c.device.as_deref() == Some(device_id)) {
            conn.reads = reads;
        }
    }

    /// A device's end of the handshake on a new connection, for tests: opens
    /// `cid`, answers its challenge with `hello` and hands back what the agent
    /// said and the connection's key.
    #[doc(hidden)]
    pub fn say_hello(&mut self, cid: &str, hello: Value, verify: &dyn Fn(&Value) -> Value) -> (Vec<Out>, Key) {
        let out = self.on_relay(&json!({ "type": "client-open", "cid": cid }).to_string(), verify);
        let Some(Out::Send(text)) = out.into_iter().next() else { panic!("no challenge") };
        let f: Value = serde_json::from_str(&text).expect("a frame");
        let d: Value = serde_json::from_str(f["data"].as_str().expect("data")).expect("an envelope");
        let challenge = e2e::open(&self.key, d["enc"].as_str().expect("sealed")).expect("under the room key");
        let (data, key) = answer_challenge(&self.host.room, &challenge, hello);
        let out = self.on_relay(&json!({ "type": "c", "cid": cid, "data": data }).to_string(), verify);
        (out, key)
    }

    /// Device ids with a welcomed live connection, each once.
    pub fn connected_devices(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for cid in self.welcomed() {
            if let Some(d) = &self.conns[&cid].device
                && !out.contains(d)
            {
                out.push(d.clone());
            }
        }
        out
    }
}

/// A device's answer to `challenge`, for tests: the `{eph, enc}` it sends and
/// the key it derived. `hello` gets the challenge, the protocol when it names
/// none, and a signature when it carries a `signWith` device key.
#[doc(hidden)]
pub fn answer_challenge(room: &str, challenge: &Value, mut hello: Value) -> (String, Key) {
    let nonce = challenge["challenge"].as_str().expect("a challenge");
    let host_eph = challenge["eph"].as_str().expect("the computer's half");
    let ours = Ephemeral::new(&crate::hello::os_random());
    let info = crate::hello::session_info(room, nonce, host_eph, &ours.public);
    let key = ours.session_key(host_eph, &info).expect("a point on the curve");
    hello["challenge"] = json!(nonce);
    if hello.get("protocol").is_none() {
        hello["protocol"] = json!(crate::hello::PROTOCOL_VERSION);
    }
    if let Some(device_key) = hello.as_object_mut().and_then(|o| o.remove("signWith")) {
        let device_key = crate::proof::parse_key_text(device_key.as_str().expect("text")).expect("a key");
        let id = hello["deviceId"].as_str().expect("a device");
        let text = crate::hello::hello_text(id, room, nonce, host_eph, &ours.public);
        hello["helloKey"] = json!(crate::proof::public_key(&device_key));
        hello["sig"] = json!(crate::proof::sign(&device_key, &text));
    }
    (frame(json!({ "eph": ours.public, "enc": e2e::seal_with_iv(&key, &hello, e2e::random_iv()) })), key)
}

/// The protocol a HELLO declares: 1 when it says none (phones from before the field).
pub fn hello_protocol(hello: &serde_json::Map<String, Value>) -> u64 {
    hello.get("protocol").and_then(Value::as_u64).filter(|p| *p > 0).unwrap_or(1)
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

#[cfg(test)]
mod tests {
    use super::*;

    const ROOM: &str = "room-1";

    fn host_key() -> crate::client::SigningKey {
        crate::proof::new_key(&crate::hello::os_random())
    }

    fn core() -> (AgentCore, Key) {
        let key = e2e::derive_key("00112233445566778899aabbccddeeff", ROOM);
        (AgentCore::new(key.clone(), Host { room: ROOM.into(), key: host_key() }, Box::new(e2e::random_iv)), key)
    }

    fn client(key: &Key, cid: &str, v: Value) -> String {
        let data = json!({ "enc": e2e::seal_with_iv(key, &v, e2e::random_iv()) }).to_string();
        json!({ "type": "c", "cid": cid, "data": data }).to_string()
    }

    fn welcome_all(h: &Value) -> Value {
        json!({ "type": "welcome", "device": { "id": h["deviceId"] } })
    }

    /// Welcomes `device` on `cid`: the connection's key.
    fn hello_on(core: &mut AgentCore, cid: &str, device: &str) -> Key {
        core.say_hello(cid, json!({ "type": "hello", "deviceId": device }), &welcome_all).1
    }

    /// A request on a connection welcomed by `hello_on`, whose first seq is `seq`.
    fn request(core: &mut AgentCore, cid: &str, key: &Key, seq: u64, mut r: Value) -> Vec<Out> {
        r["seq"] = json!(seq);
        r["challenge"] = json!(core.conns[cid].bound);
        core.on_relay(&client(key, cid, r), &welcome_all)
    }

    fn open_frame(key: &Key, out: &Out) -> (String, Value) {
        let Out::Send(text) = out else { panic!("{out:?}") };
        let f: Value = serde_json::from_str(text).unwrap();
        let d: Value = serde_json::from_str(f["data"].as_str().unwrap()).unwrap();
        (f["cid"].as_str().unwrap().to_string(), e2e::open(key, d["enc"].as_str().unwrap()).unwrap())
    }

    #[test]
    fn each_request_names_the_device_welcomed_on_its_connection() {
        let (mut core, _) = core();
        hello_on(&mut core, "c1", "phone-1");
        let key = hello_on(&mut core, "c2", "phone-2");
        let req = json!({ "type": "req", "id": 7, "channel": "tasks:list", "args": [] });
        let out = request(&mut core, "c2", &key, 1, req);
        assert_eq!(
            out,
            vec![Out::Dispatch {
                cid: "c2".into(),
                id: Some(json!(7)),
                device_id: "phone-2".into(),
                channel: "tasks:list".into(),
                args: json!([]),
                proof: None,
                step_up: None,
            }]
        );
    }

    #[test]
    fn a_change_proof_travels_beside_the_args() {
        let (mut core, _) = core();
        let key = hello_on(&mut core, "c1", "phone-1");
        let proof = json!({ "ts": 1, "sig": "c2ln" });
        let step = json!({ "totp": "123456" });
        let req =
            json!({ "type": "req", "id": 1, "channel": "file:write", "args": ["a"], "proof": proof, "stepUp": step });
        match request(&mut core, "c1", &key, 1, req).pop() {
            Some(Out::Dispatch { device_id, args, proof: p, step_up, .. }) => {
                assert_eq!(device_id, "phone-1");
                assert_eq!(args, json!(["a"]), "the proof is not one of the args");
                assert_eq!(p, Some(proof));
                assert_eq!(step_up, Some(step), "the step-up travels beside the proof (SK-2)");
            }
            other => panic!("{other:?}"),
        }
        // `proof: null` is no proof.
        let req = json!({ "type": "req", "id": 2, "channel": "file:write", "args": [], "proof": null });
        assert!(matches!(request(&mut core, "c1", &key, 2, req).pop(), Some(Out::Dispatch { proof: None, .. })));
    }

    #[test]
    fn a_reconnected_cid_is_nobody_until_it_says_hello_again() {
        let (mut core, _) = core();
        let key = hello_on(&mut core, "c1", "phone-1");
        let bound = core.conns["c1"].bound.clone();
        core.on_relay(&json!({ "type": "client-open", "cid": "c1" }).to_string(), &welcome_all);
        let req = json!({ "type": "req", "id": 3, "seq": 1, "challenge": bound, "channel": "tasks:list", "args": [] });
        let out = core.on_relay(&client(&key, "c1", req), &welcome_all);
        assert!(out.is_empty(), "its old key is worth nothing now: {out:?}");
    }

    /// The phone's Live Activity card (`card.rs`): `card:set` is answered here,
    /// and the agent's events then drive `card` frames for the relay to push.
    #[test]
    fn card_set_is_answered_here_and_events_drive_card_frames() {
        let (core, _) = core();
        let mut core = core.with_clock(Box::new(|| 800_000_000.0));
        let key = hello_on(&mut core, "c1", "phone-1");
        let tool = json!({ "type": "tool_call", "sessionId": "s1", "call": { "id": "t", "name": "bash", "input": { "command": "ls" } } });
        let plain = |frames: &[String]| -> Vec<Value> {
            frames.iter().map(|f| serde_json::from_str::<Value>(f).unwrap()).filter(|f| f["type"] != "d").collect()
        };
        // No phone asked: the old per-chat activity frame only.
        let first = plain(&core.on_event("agent:event", &tool));
        assert_eq!(
            first.iter().map(|f| f["type"].as_str().unwrap()).collect::<Vec<_>>(),
            ["attention-unknown", "activity"]
        );
        assert!(!core.wants_summaries());

        let req = json!({ "type": "req", "id": 5, "channel": "card:set", "args": [{ "level": "standard" }] });
        let out = request(&mut core, "c1", &key, 1, req);
        let sent: Vec<String> = out
            .iter()
            .map(|o| match o {
                Out::Send(f) => f.clone(),
                Out::Dispatch { .. } => panic!("card:set is never dispatched: {o:?}"),
            })
            .collect();
        let card = plain(&sent);
        assert_eq!(card.len(), 1);
        assert_eq!(card[0]["type"], "card");
        assert_eq!(card[0]["state"]["chats"][0]["step"], "Run ls");
        let reply = open_frame(&key, out.last().unwrap()).1;
        assert_eq!(reply, json!({ "type": "res", "id": 5, "result": { "ok": true } }));

        // The chat list fills in the title.
        assert!(core.wants_summaries());
        let titled = plain(&core.set_summaries(&json!([{ "id": "s1", "title": "List files", "updatedAt": 1 }])));
        assert_eq!(titled[0]["state"]["chats"][0]["short"], "List");

        // A prompt the phone sends makes that chat's next run start a card.
        let send =
            json!({ "type": "req", "id": 6, "channel": "chat:send", "args": [{ "sessionId": "s2", "text": "go" }] });
        assert!(matches!(request(&mut core, "c1", &key, 2, send).as_slice(), [Out::Dispatch { .. }]));
        let run = json!({ "type": "text", "sessionId": "s2", "delta": "Hi" });
        let frames = plain(&core.on_event("agent:event", &run));
        assert_eq!(frames.last().unwrap()["type"], "card-start", "{frames:?}");

        // A revoked phone stops the card.
        core.kick_device("phone-1");
        let after = plain(&core.on_event("agent:event", &json!({ "type": "text", "sessionId": "s3", "delta": "x" })));
        assert!(after.iter().all(|f| f["type"] != "card" && f["type"] != "card-start"), "{after:?}");
    }

    mod handshake {
        use super::*;

        /// Opens `cid` and returns the challenge frame the agent sent it.
        fn open(core: &mut AgentCore, key: &Key, cid: &str) -> Value {
            let out = core.on_relay(&json!({ "type": "client-open", "cid": cid }).to_string(), &welcome_all);
            assert_eq!(out.len(), 1, "{out:?}");
            let (to, f) = open_frame(key, &out[0]);
            assert_eq!(to, cid);
            assert_eq!(f["type"], "challenge");
            assert_eq!(f["challenge"].as_str().unwrap().len(), 24, "18 random bytes, base64");
            f
        }

        fn hello() -> Value {
            json!({ "type": "hello", "deviceId": "phone-1" })
        }

        fn answer(cid: &str, challenge: &Value, hello: Value) -> (String, Key) {
            let (data, key) = answer_challenge(ROOM, challenge, hello);
            (json!({ "type": "c", "cid": cid, "data": data }).to_string(), key)
        }

        fn req(id: u64, seq: Value, challenge: &str) -> Value {
            json!({ "type": "req", "id": id, "seq": seq, "challenge": challenge, "channel": "tasks:list", "args": [] })
        }

        fn is_challenge(key: &Key, out: &[Out]) -> bool {
            matches!(out, [o @ Out::Send(_)] if open_frame(key, o).1["type"] == "challenge")
        }

        /// A welcomed connection: its challenge and its key.
        fn welcomed(core: &mut AgentCore, key: &Key, cid: &str) -> (String, Key) {
            let c = open(core, key, cid);
            let (frame, session) = answer(cid, &c, hello());
            let out = core.on_relay(&frame, &welcome_all);
            let (_, reply) = open_frame(&session, out.last().unwrap());
            assert_eq!(reply["type"], "welcome", "{reply}");
            assert_eq!(reply["protocol"], json!(crate::hello::PROTOCOL_VERSION));
            (c["challenge"].as_str().unwrap().to_string(), session)
        }

        #[test]
        fn the_challenge_is_signed_by_the_host_key_for_this_room() {
            let (mut core, key) = core();
            let public = crate::proof::parse_key(&crate::proof::public_key(&core.host.key)).unwrap();
            let c = open(&mut core, &key, "c1");
            let (nonce, eph) = (c["challenge"].as_str().unwrap(), c["eph"].as_str().unwrap());
            let sig = crate::proof::b64(c["sig"].as_str().unwrap()).unwrap();
            assert!(crate::proof::verify(&public, &crate::hello::host_text(ROOM, nonce, eph), &sig));
            assert!(!crate::proof::verify(&public, &crate::hello::host_text("room-2", nonce, eph), &sig));
        }

        #[test]
        fn a_hello_under_the_room_key_is_never_welcomed_whatever_it_claims() {
            let (mut core, key) = core();
            let c = open(&mut core, &key, "c1");
            let never = |_: &Value| -> Value { panic!("a registry check for a frame anyone ever paired can send") };
            let claim = json!({ "type": "hello", "deviceId": "phone-1", "protocol": 99, "challenge": c["challenge"] });
            let out = core.on_relay(&client(&key, "c1", claim), &never);
            assert_eq!(open_frame(&key, &out[0]).1["reason"], "update-required");
            let kick = json!({ "type": "kick", "cid": "c1" }).to_string();
            assert_eq!(out[1], Out::Send(kick));
            assert!(core.connected_devices().is_empty());
        }

        #[test]
        fn a_kicked_connection_hears_nothing_more_whatever_the_relay_does() {
            let (mut core, key) = core();
            welcomed(&mut core, &key, "c1");
            let frames = core.kick_device("phone-1");
            assert!(frames[0].contains(r#""type":"kick""#), "{frames:?}");
            assert!(core.connected_devices().is_empty());
            // The relay never closed it: no event goes to it, and no request is taken from it.
            assert!(core.on_event("tasks:updated", &json!({})).is_empty());
            let (c, session) = welcomed(&mut core, &key, "c2");
            core.kick_device("phone-1");
            let out = core.on_relay(&client(&session, "c2", req(1, json!(1), &c)), &welcome_all);
            assert!(out.is_empty(), "{out:?}");
        }

        #[test]
        fn the_relay_hears_who_was_welcomed_before_the_phone_does() {
            let (mut core, key) = core();
            let c = open(&mut core, &key, "c1");
            let (frame, _) = answer("c1", &c, hello());
            let out = core.on_relay(&frame, &welcome_all);
            let want = json!({ "type": "welcomed", "cid": "c1", "deviceId": "phone-1" }).to_string();
            assert_eq!(out[0], Out::Send(want));
            assert_eq!(out.len(), 2);
        }

        #[test]
        fn a_device_with_read_off_gets_no_events() {
            let (mut core, key) = core();
            let off = |h: &Value| json!({ "type": "welcome", "device": { "id": h["deviceId"], "access": { "read": false, "change": true } } });
            let c = open(&mut core, &key, "c1");
            core.on_relay(&answer("c1", &c, hello()).0, &off);
            assert_eq!(core.connected_devices(), vec!["phone-1"]);
            assert!(core.on_event("tasks:updated", &json!({})).is_empty());
            // The switch applies to the live connection, both ways.
            core.set_reads("phone-1", true);
            assert_eq!(core.on_event("tasks:updated", &json!({})).len(), 1);
            core.set_reads("phone-1", false);
            assert!(core.on_event("tasks:updated", &json!({})).is_empty());
        }

        #[test]
        fn the_room_key_opens_nothing_on_a_welcomed_connection() {
            let (mut core, key) = core();
            let (c, session) = welcomed(&mut core, &key, "c1");
            let forged = core.on_relay(&client(&key, "c1", req(1, json!(1), &c)), &welcome_all);
            assert!(forged.is_empty(), "{forged:?}");
            assert_eq!(core.connected_devices(), vec!["phone-1"]);
            // Nor can it read what the connection is sent.
            let out = core.on_event("tasks:updated", &json!({}));
            let d: Value = serde_json::from_str(&out[0]).unwrap();
            let d: Value = serde_json::from_str(d["data"].as_str().unwrap()).unwrap();
            assert_eq!(e2e::open(&key, d["enc"].as_str().unwrap()), None);
            assert!(e2e::open(&session, d["enc"].as_str().unwrap()).is_some());
        }

        #[test]
        fn each_connection_has_its_own_key() {
            let (mut core, key) = core();
            let (_, one) = welcomed(&mut core, &key, "c1");
            let (_, two) = welcomed(&mut core, &key, "c2");
            assert_ne!(one.raw(), two.raw());
            let out = core.on_event("tasks:updated", &json!({}));
            assert_eq!(out.len(), 2, "sealed for each");
            for (frame, (mine, other)) in out.iter().zip([(&one, &two), (&two, &one)]) {
                let d: Value = serde_json::from_str(frame).unwrap();
                let d: Value = serde_json::from_str(d["data"].as_str().unwrap()).unwrap();
                assert!(e2e::open(mine, d["enc"].as_str().unwrap()).is_some());
                assert_eq!(e2e::open(other, d["enc"].as_str().unwrap()), None);
            }
        }

        #[test]
        fn a_replayed_hello_opens_on_no_other_connection() {
            let (mut core, key) = core();
            let c = open(&mut core, &key, "c1");
            let (frame, _) = answer("c1", &c, hello());
            core.on_relay(&frame, &welcome_all);
            open(&mut core, &key, "c2");
            let never = |_: &Value| -> Value { panic!("verified a replayed HELLO") };
            let out = core.on_relay(&frame.replace("\"cid\":\"c1\"", "\"cid\":\"c2\""), &never);
            assert!(out.is_empty(), "{out:?}");
            assert_eq!(core.connected_devices(), vec!["phone-1"]);
        }

        #[test]
        fn a_hello_answers_the_challenge_once() {
            let (mut core, key) = core();
            let never = |_: &Value| -> Value { panic!("verified a HELLO that did not answer the challenge") };
            for wrong in [json!("AAAAAAAAAAAAAAAAAAAAAAAA"), Value::Null] {
                let c = open(&mut core, &key, "c1");
                let ours = Ephemeral::new(&crate::hello::os_random());
                let (nonce, eph) = (c["challenge"].as_str().unwrap(), c["eph"].as_str().unwrap());
                let session =
                    ours.session_key(eph, &crate::hello::session_info(ROOM, nonce, eph, &ours.public)).unwrap();
                let h = json!({ "type": "hello", "deviceId": "phone-1", "protocol": 6, "challenge": wrong });
                let enc = e2e::seal_with_iv(&session, &h, e2e::random_iv());
                let data = json!({ "eph": ours.public, "enc": enc }).to_string();
                let out = core.on_relay(&json!({ "type": "c", "cid": "c1", "data": data }).to_string(), &never);
                assert!(is_challenge(&key, &out), "{out:?}");
            }
            assert!(core.connected_devices().is_empty());
        }

        #[test]
        fn what_the_device_says_about_the_exchange_is_not_believed() {
            let (mut core, key) = core();
            let c = open(&mut core, &key, "c1");
            let seen: std::sync::Mutex<Value> = Default::default();
            let verify = |h: &Value| {
                *seen.lock().unwrap() = h.clone();
                welcome_all(h)
            };
            let liar = json!({ "type": "hello", "deviceId": "phone-1", "hostEph": "mine", "clientEph": "mine" });
            let (frame, _) = answer("c1", &c, liar);
            core.on_relay(&frame, &verify);
            let h = seen.lock().unwrap().clone();
            assert_eq!(h["hostEph"], c["eph"]);
            assert_ne!(h["clientEph"], "mine");
        }

        #[test]
        fn requests_carry_the_challenge_and_a_rising_seq() {
            let (mut core, key) = core();
            let (c, session) = welcomed(&mut core, &key, "c1");
            let first = core.on_relay(&client(&session, "c1", req(1, json!(1), &c)), &welcome_all);
            assert!(matches!(first.as_slice(), [Out::Dispatch { .. }]), "{first:?}");
            // Gaps are fine (a phone may give up on one), going back is not.
            let gap = core.on_relay(&client(&session, "c1", req(2, json!(5), &c)), &welcome_all);
            assert!(matches!(gap.as_slice(), [Out::Dispatch { .. }]));
            let replay = core.on_relay(&client(&session, "c1", req(2, json!(5), &c)), &welcome_all);
            assert!(is_challenge(&key, &replay), "a replay is dropped and the phone must say hello again");
            assert!(core.connected_devices().is_empty());
            // Back to the handshake: nothing is dispatched until a new HELLO.
            let out = core.on_relay(&client(&session, "c1", req(3, json!(6), &c)), &welcome_all);
            assert!(!out.iter().any(|o| matches!(o, Out::Dispatch { .. })));
        }

        #[test]
        fn a_request_without_seq_or_from_another_connection_is_dropped() {
            let (mut core, key) = core();
            let (c1, _) = welcomed(&mut core, &key, "c1");
            let (mut c2, mut session) = welcomed(&mut core, &key, "c2");
            for case in 0..4 {
                let f = match case {
                    0 => json!({ "type": "req", "id": 1, "challenge": c2, "channel": "tasks:list" }),
                    1 => req(1, json!(1), &c1),
                    2 => req(1, json!("2"), &c2),
                    _ => req(1, json!(0), &c2),
                };
                let out = core.on_relay(&client(&session, "c2", f.clone()), &welcome_all);
                assert!(is_challenge(&key, &out), "{f}: {out:?}");
                // Welcomed again, so each frame meets a fresh connection.
                let ch = open_frame(&key, &out[0]).1;
                let (frame, next) = answer("c2", &ch, hello());
                core.on_relay(&frame, &welcome_all);
                (c2, session) = (ch["challenge"].as_str().unwrap().to_string(), next);
            }
        }

        #[test]
        fn caps_connections_waiting_for_a_hello() {
            let (mut core, key) = core();
            welcomed(&mut core, &key, "phone");
            for i in 0..(MAX_UNWELCOMED + 10) {
                core.on_relay(&json!({ "type": "client-open", "cid": format!("x{i}") }).to_string(), &welcome_all);
            }
            let waiting = core.conns.values().filter(|c| c.device.is_none()).count();
            assert_eq!(waiting, MAX_UNWELCOMED);
            assert!(!core.conns.contains_key("x0"), "the oldest went first");
            assert!(core.conns.contains_key(&format!("x{}", MAX_UNWELCOMED + 9)));
            assert_eq!(core.connected_devices(), vec!["phone-1"], "a welcomed phone is never evicted");
        }
    }
}
