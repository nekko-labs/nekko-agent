//! The Telegram bridge (`createMessagingService` in
//! packages/host/src/messaging/service.ts) as a state machine with no I/O.
//!
//! Inputs are the calls the TS service received (settings updates, agent
//! events, `stop`) plus the completions of what it awaited (a Telegram call,
//! the long poll, a timer, a chat made, a model list, a turn). Each returns
//! the [`Effect`]s the TS service would have performed at that point, in the
//! order it performed them. Whoever drives the machine runs them and reports
//! back through the matching `*_done` method with the effect's id.
//!
//! The one structural difference: `host.createSession()` was synchronous in
//! the TS host and is a round trip here (the backend owns a new chat's
//! defaults), so messages from a chat whose session is being made wait for it
//! and then run in order.

use crate::telegram;
use serde_json::{Map, Value, json};
use std::collections::{HashMap, VecDeque};

/// Telegram caps edit throughput near one write per second per chat.
pub const EDIT_INTERVAL_MS: u64 = 1_500;
pub const POLL_TIMEOUT_SEC: u64 = 25;
pub const ERROR_BACKOFF_MS: u64 = 5_000;

const REFUSED: &str = "Nekko Agent: this chat is not on the allowlist.";
const NO_TARGET: &str = "Nekko Agent: no provider/model is configured for this chat.";
const EXPIRED: &str = "That action expired.";

/// What the bridge reads from its host at the moment it needs it.
pub trait Host {
    /// The current settings (`getSettings()`).
    fn settings(&self) -> Value;
    /// A chat by id (`getSession`), `None` when there is none.
    fn session(&self, id: &str) -> Option<Value>;
}

/// One Bot API request: `POST url` with `body` as its JSON text.
#[derive(Clone, Debug, PartialEq)]
pub struct TgCall {
    pub id: u64,
    pub method: String,
    pub url: String,
    pub body: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Effect {
    /// A Bot API call; answer with [`Bridge::tg_done`]. Run them in order.
    Tg(TgCall),
    /// The long poll (`getUpdates`); answer with [`Bridge::poll_done`].
    Poll(TgCall),
    /// Call [`Bridge::timer`] with this id after `ms`.
    Arm { timer: u64, ms: u64 },
    /// Forget an armed timer.
    Disarm { timer: u64 },
    /// Write `messaging-state.json` (atomically).
    Save(Value),
    /// Make a new chat (`session:create`); answer with [`Bridge::created`].
    CreateSession { req: u64 },
    /// A provider's models (`models:list`); answer with [`Bridge::models_listed`].
    ListModels { req: u64, provider_id: Value },
    /// Start a turn (`chat:send`); answer with [`Bridge::sent`] once it ends.
    SendChat { req: u64, opts: Value },
    /// `tool:approve`.
    Approve { session_id: String, call_id: String, approved: bool },
    /// `chat:answer`.
    Answer { session_id: String, call_id: Value, answers: Value },
}

/// The channel message a session's reply streams into.
struct Out {
    session: String,
    chat_id: String,
    /// `undefined` until the first send lands.
    message_id: Value,
    text: String,
    /// Transient tool-status tail ("running read_file...").
    status: String,
    timer: Option<u64>,
    /// Flushes in flight, which still refer to this message.
    flushing: u32,
}

enum Callback {
    Approve { session_id: String, call_id: String },
    Ask { session_id: String, call_id: Value, question_id: Option<Value>, label: Option<Value> },
}

enum TgJob {
    Plain,
    GetMe { client: u64 },
    Flush { out: u64, final_: bool, send: bool },
}

enum Timer {
    Flush { out: u64 },
    Backoff,
}

enum Request {
    Create { chat_id: String, text: String },
    Models { session_id: String, chat_id: String, provider_id: Value, text: String },
    Send { session_id: String, chat_id: String },
}

struct Client {
    serial: u64,
    token: Value,
}

pub struct Bridge {
    api_root: String,
    state: Map<String, Value>,
    /// `state.offset` once an update moved it (JavaScript arithmetic, `NaN` included).
    offset: Option<f64>,
    client: Option<Client>,
    clients: u64,
    stopped: bool,
    polling: bool,
    bot_username: Option<Value>,
    last_error: Option<String>,
    outs: HashMap<u64, Out>,
    outbound: HashMap<String, u64>,
    callbacks: HashMap<u64, Callback>,
    callback_seq: u64,
    pending_questions: HashMap<String, Value>,
    /// Chats whose session is being made, with the messages waiting on it.
    creating: HashMap<String, VecDeque<String>>,
    ids: u64,
    jobs: HashMap<u64, TgJob>,
    timers: HashMap<u64, Timer>,
    requests: HashMap<u64, Request>,
    fx: Vec<Effect>,
}

/// `Math.max`'s answer as JSON holds it (`NaN` prints as `null`).
fn num(f: f64) -> Value {
    if !f.is_finite() {
        return Value::Null;
    }
    if f.fract() == 0.0 && f.abs() < 9_007_199_254_740_992.0 {
        return json!(f as i64);
    }
    serde_json::Number::from_f64(f).map_or(Value::Null, Value::Number)
}

/// `v + 1` as a number, as `Math.max` then reads it.
fn plus_one(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::String(_) | Value::Array(_) | Value::Object(_)) => {
            nekko_js::string_to_number(&format!("{}1", nekko_js::display(v.unwrap_or(&Value::Null))))
        }
        _ => nekko_js::to_number(v) + 1.0,
    }
}

fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) }
}

/// `allowedChatIds ?? []` then `.includes(chatId)`.
fn allowed(settings: &Value, chat_id: &str) -> bool {
    match settings.pointer("/messaging/telegram/allowedChatIds") {
        Some(Value::Array(ids)) => ids.iter().any(|v| v.as_str() == Some(chat_id)),
        // A string's includes is a substring search.
        Some(Value::String(s)) => s.contains(chat_id),
        _ => false,
    }
}

/// `a ?? b`.
fn coalesce(a: Option<&Value>, b: Option<&Value>) -> Option<Value> {
    nekko_js::coalesce(a, b).filter(|v| !v.is_null()).cloned()
}

impl Bridge {
    /// A stopped bridge over a loaded state (`crate::state::load`).
    pub fn new(state: Map<String, Value>, api_root: &str) -> Self {
        Bridge {
            api_root: api_root.trim_end_matches('/').to_string(),
            state,
            offset: None,
            client: None,
            clients: 0,
            stopped: true,
            polling: false,
            bot_username: None,
            last_error: None,
            outs: HashMap::new(),
            outbound: HashMap::new(),
            callbacks: HashMap::new(),
            callback_seq: 0,
            pending_questions: HashMap::new(),
            creating: HashMap::new(),
            ids: 0,
            jobs: HashMap::new(),
            timers: HashMap::new(),
            requests: HashMap::new(),
            fx: Vec::new(),
        }
    }

    fn id(&mut self) -> u64 {
        self.ids += 1;
        self.ids
    }

    fn take(&mut self) -> Vec<Effect> {
        std::mem::take(&mut self.fx)
    }

    // ---- the state file ----

    fn offset_value(&self) -> Value {
        match self.offset {
            Some(f) => num(f),
            None => self.state.get("offset").cloned().unwrap_or(Value::Null),
        }
    }

    /// The state as it is written to the file.
    pub fn state(&self) -> Value {
        let mut s = self.state.clone();
        if self.offset.is_some() {
            s.insert("offset".into(), self.offset_value());
        }
        Value::Object(s)
    }

    fn persist(&mut self) {
        let s = self.state();
        self.fx.push(Effect::Save(s));
    }

    fn bindings(&self) -> Option<&Map<String, Value>> {
        self.state.get("bindings").and_then(Value::as_object)
    }

    fn bind(&mut self, chat_id: &str, session_id: Value) {
        if !self.state.get("bindings").is_some_and(Value::is_object) {
            self.state.insert("bindings".into(), json!({}));
        }
        if let Some(Value::Object(b)) = self.state.get_mut("bindings") {
            b.insert(chat_id.to_string(), session_id);
            // Integer-like chat ids sort first, as JavaScript keeps them.
            if let Value::Object(sorted) = nekko_js::js_order(Value::Object(std::mem::take(b))) {
                *b = sorted;
            }
        }
    }

    /// `chatIdForSession`: the first binding to this session.
    fn chat_for_session(&self, session_id: &str) -> Option<String> {
        self.bindings()?.iter().find(|(_, s)| s.as_str() == Some(session_id)).map(|(c, _)| c.clone())
    }

    // ---- Telegram ----

    /// A call on the current client, or nothing when there is none (the TS
    /// threw on `null.sendMessage` and nothing went out).
    fn tg(&mut self, method: &str, body: Value, job: TgJob) {
        self.tg_raw(method, Some(&body), job);
    }

    fn tg_raw(&mut self, method: &str, body: Option<&Value>, job: TgJob) {
        let Some(c) = &self.client else { return };
        let url = telegram::url(&self.api_root, &c.token, method);
        let id = self.id();
        self.jobs.insert(id, job);
        self.fx.push(Effect::Tg(TgCall { id, method: method.into(), url, body: telegram::body_text(body) }));
    }

    fn send(&mut self, chat_id: &str, text: &str, keyboard: Option<Value>) {
        self.tg("sendMessage", telegram::send_message(chat_id, text, keyboard), TgJob::Plain);
    }

    fn save_callback(&mut self, cb: Callback) -> String {
        self.callback_seq += 1;
        self.callbacks.insert(self.callback_seq, cb);
        format!("m:{}", self.callback_seq)
    }

    // ---- the reply message ----

    fn new_out(&mut self, session: &str, chat_id: &str, status: &str) -> u64 {
        let serial = self.id();
        self.outs.insert(
            serial,
            Out {
                session: session.into(),
                chat_id: chat_id.into(),
                message_id: Value::Null,
                text: String::new(),
                status: status.into(),
                timer: None,
                flushing: 0,
            },
        );
        if let Some(old) = self.outbound.insert(session.into(), serial) {
            self.gc(old);
        }
        serial
    }

    fn drop_out(&mut self, session: &str) {
        if let Some(old) = self.outbound.remove(session) {
            self.gc(old);
        }
    }

    /// Forget a message nothing refers to any more.
    fn gc(&mut self, serial: u64) {
        if let Some(o) = self.outs.get(&serial)
            && o.timer.is_none()
            && o.flushing == 0
            && self.outbound.get(&o.session) != Some(&serial)
        {
            self.outs.remove(&serial);
        }
    }

    /// `outboundFor`: the session's message, made on the first streamed
    /// delta so app-started turns mirror to the channel too.
    fn outbound_for(&mut self, session: &str) -> Option<u64> {
        if let Some(s) = self.outbound.get(session) {
            return Some(*s);
        }
        let chat = self.chat_for_session(session)?;
        Some(self.new_out(session, &chat, ""))
    }

    fn schedule_flush(&mut self, session: &str) {
        let Some(&serial) = self.outbound.get(session) else { return };
        if self.outs.get(&serial).is_none_or(|o| o.timer.is_some()) {
            return;
        }
        let t = self.id();
        self.timers.insert(t, Timer::Flush { out: serial });
        if let Some(o) = self.outs.get_mut(&serial) {
            o.timer = Some(t);
        }
        self.fx.push(Effect::Arm { timer: t, ms: EDIT_INTERVAL_MS });
    }

    fn flush(&mut self, session: &str, final_: bool) {
        let Some(&serial) = self.outbound.get(session) else { return };
        if self.client.is_none() {
            return;
        }
        let Some(o) = self.outs.get_mut(&serial) else { return };
        let tail = if !o.status.is_empty() && !final_ { format!("\n\n_{}_", o.status) } else { String::new() };
        let joined = format!("{}{tail}", o.text);
        let body = match nekko_js::trim(&joined) {
            "" => "\u{2026}".to_string(),
            b => b.to_string(),
        };
        o.flushing += 1;
        let (chat, mid) = (o.chat_id.clone(), o.message_id.clone());
        if !nekko_js::truthy(Some(&mid)) {
            let req = telegram::send_message(&chat, &body, None);
            self.tg("sendMessage", req, TgJob::Flush { out: serial, final_, send: true });
        } else {
            let req = telegram::edit_message_text(&chat, &mid, &body);
            self.tg("editMessageText", req, TgJob::Flush { out: serial, final_, send: false });
        }
    }

    // ---- inputs ----

    /// `update(settings.messaging)`: start, restart with a new token, or stop.
    pub fn update(&mut self, messaging: Option<&Value>) -> Vec<Effect> {
        let cfg = messaging.and_then(|m| m.get("telegram"));
        let enabled = nekko_js::truthy(cfg.and_then(|c| c.get("enabled")));
        let token = cfg.and_then(|c| c.get("botToken")).filter(|t| nekko_js::truthy(Some(t))).cloned();
        let Some(token) = token.filter(|_| enabled) else {
            self.teardown();
            return self.take();
        };
        if self.client.as_ref().is_some_and(|c| c.token == token) {
            return self.take();
        }
        if self.client.is_none() {
            self.stopped = false;
        }
        self.clients += 1;
        let serial = self.clients;
        self.client = Some(Client { serial, token });
        self.bot_username = None;
        self.tg_raw("getMe", None, TgJob::GetMe { client: serial });
        if !self.polling {
            self.polling = true;
            self.poll_next();
        }
        self.take()
    }

    /// Which client (a serial that changes with the token) a poll started
    /// now would use; `None` while stopped.
    pub fn client_serial(&self) -> Option<u64> {
        self.client.as_ref().filter(|_| !self.stopped).map(|c| c.serial)
    }

    /// The driver dropped the long poll in flight (the bridge stopped or the
    /// token changed): the loop goes on as if it had returned with nothing
    /// new, so it ends when stopped and polls with the new token otherwise.
    /// The TS loop kept the old request waiting up to 25 s instead.
    pub fn poll_aborted(&mut self) -> Vec<Effect> {
        self.poll_next();
        self.take()
    }

    /// `stop()`.
    pub fn stop(&mut self) -> Vec<Effect> {
        self.teardown();
        self.take()
    }

    fn teardown(&mut self) {
        self.stopped = true;
        self.client = None;
        self.bot_username = None;
        let serials: Vec<u64> = self.outbound.values().copied().collect();
        for s in &serials {
            if let Some(t) = self.outs.get_mut(s).and_then(|o| o.timer.take()) {
                self.timers.remove(&t);
                self.fx.push(Effect::Disarm { timer: t });
            }
        }
        self.outbound.clear();
        for s in serials {
            self.gc(s);
        }
        self.pending_questions.clear();
    }

    /// `status().telegram` as the UI reads it.
    pub fn status(&self) -> Value {
        let Some(_) = &self.client else { return json!({}) };
        let mut t = Map::new();
        t.insert("running".into(), json!(!self.stopped));
        if let Some(u) = &self.bot_username {
            t.insert("botUsername".into(), u.clone());
        }
        if let Some(e) = &self.last_error {
            t.insert("lastError".into(), json!(e));
        }
        t.insert("boundChats".into(), json!(self.bindings().map_or(0, Map::len)));
        json!({ "telegram": t })
    }

    /// The poll loop's next turn: `while (!stopped && tg) getUpdates(...)`.
    fn poll_next(&mut self) {
        let Some(c) = self.client.as_ref().filter(|_| !self.stopped) else {
            self.polling = false;
            return;
        };
        let url = telegram::url(&self.api_root, &c.token, "getUpdates");
        let body = telegram::body_text(Some(&telegram::get_updates(&self.offset_value(), POLL_TIMEOUT_SEC)));
        let id = self.id();
        self.fx.push(Effect::Poll(TgCall { id, method: "getUpdates".into(), url, body }));
    }

    /// The long poll's answer (`telegram::reply` of it).
    pub fn poll_done(&mut self, result: Result<Value, String>, host: &dyn Host) -> Vec<Effect> {
        match result {
            Ok(Value::Array(updates)) => {
                for u in &updates {
                    self.on_update(u, host);
                }
                if !updates.is_empty() {
                    self.persist();
                }
                self.last_error = None;
                self.poll_next();
            }
            other => {
                self.last_error = Some(match other {
                    Err(e) => e,
                    Ok(_) => "updates is not iterable".into(),
                });
                let t = self.id();
                self.timers.insert(t, Timer::Backoff);
                self.fx.push(Effect::Arm { timer: t, ms: ERROR_BACKOFF_MS });
            }
        }
        self.take()
    }

    /// A Bot API call's answer.
    pub fn tg_done(&mut self, id: u64, result: Result<Value, String>) -> Vec<Effect> {
        match self.jobs.remove(&id) {
            Some(TgJob::GetMe { client }) if self.client.as_ref().is_some_and(|c| c.serial == client) => match result {
                Ok(Value::Null) => {
                    self.last_error = Some("Cannot read properties of null (reading 'username')".into());
                }
                Ok(me) => {
                    self.bot_username = me.get("username").cloned();
                    self.last_error = None;
                }
                Err(e) => self.last_error = Some(e),
            },
            Some(TgJob::Flush { out, final_, send }) => {
                if send
                    && let Ok(Value::Object(m)) = &result
                    && let Some(o) = self.outs.get_mut(&out)
                {
                    o.message_id = m.get("message_id").cloned().unwrap_or(Value::Null);
                }
                let session = self.outs.get(&out).map(|o| o.session.clone());
                if let Some(o) = self.outs.get_mut(&out) {
                    o.flushing = o.flushing.saturating_sub(1);
                }
                if final_ {
                    if let Some(t) = self.outs.get_mut(&out).and_then(|o| o.timer.take()) {
                        self.timers.remove(&t);
                        self.fx.push(Effect::Disarm { timer: t });
                    }
                    if let Some(s) = session {
                        self.drop_out(&s);
                    }
                }
                self.gc(out);
            }
            _ => {}
        }
        self.take()
    }

    /// An armed timer went off.
    pub fn timer(&mut self, timer: u64) -> Vec<Effect> {
        match self.timers.remove(&timer) {
            Some(Timer::Flush { out }) => {
                let session = self.outs.get_mut(&out).map(|o| {
                    o.timer = None;
                    o.session.clone()
                });
                if let Some(s) = session {
                    self.gc(out);
                    self.flush(&s, false);
                }
            }
            Some(Timer::Backoff) => self.poll_next(),
            None => {}
        }
        self.take()
    }

    /// One agent event, as the UI hears it (`agent:event`).
    pub fn event(&mut self, e: &Value) -> Vec<Effect> {
        let Some(sid) = e.get("sessionId").and_then(Value::as_str).filter(|s| !s.is_empty()) else {
            return self.take();
        };
        if self.client.is_none() {
            return self.take();
        }
        let sid = sid.to_string();
        let out_chat = self.outbound.get(&sid).and_then(|s| self.outs.get(s)).map(|o| o.chat_id.clone());
        match e.get("type").and_then(Value::as_str).unwrap_or_default() {
            "text" => {
                if let Some(o) = self.outbound_for(&sid) {
                    let delta = crate::show(e.get("delta"));
                    if let Some(o) = self.outs.get_mut(&o) {
                        o.text.push_str(&delta);
                    }
                    self.schedule_flush(&sid);
                }
            }
            t @ ("tool_call" | "tool_result") => {
                if let Some(o) = self.outbound_for(&sid) {
                    let status = if t == "tool_call" {
                        format!("running {}\u{2026}", crate::show(e.pointer("/call/name")))
                    } else {
                        String::new()
                    };
                    if let Some(o) = self.outs.get_mut(&o) {
                        o.status = status;
                    }
                    self.schedule_flush(&sid);
                }
            }
            "tool_approval_required" => {
                let Some(chat) = out_chat.or_else(|| self.chat_for_session(&sid)) else { return self.take() };
                let call_id = crate::show(e.pointer("/call/id"));
                let ok = self.save_callback(Callback::Approve { session_id: sid.clone(), call_id: call_id.clone() });
                let no =
                    self.save_callback(Callback::Approve { session_id: sid.clone(), call_id: format!("!{call_id}") });
                let text = format!(
                    "Approval needed: {}: {} (severity: {})",
                    crate::show(e.pointer("/call/name")),
                    crate::show(e.get("reason")),
                    crate::show(e.get("severity"))
                );
                let keyboard =
                    json!([[{ "text": "Approve", "callback_data": ok }, { "text": "Deny", "callback_data": no }]]);
                self.send(&chat, &text, Some(keyboard));
            }
            "question" => self.question(&sid, e.get("request"), out_chat),
            "question_resolved" => {
                self.pending_questions.remove(&sid);
            }
            "done" => self.flush(&sid, true),
            "error" => {
                if let Some(chat) = out_chat.or_else(|| self.chat_for_session(&sid)) {
                    let text = format!("Nekko Agent error: {}", crate::show(e.get("message")));
                    self.send(&chat, &text, None);
                }
                self.flush(&sid, true);
            }
            _ => {}
        }
        self.take()
    }

    fn question(&mut self, sid: &str, request: Option<&Value>, out_chat: Option<String>) {
        match request.filter(|r| nekko_js::truthy(Some(r))) {
            Some(r) => self.pending_questions.insert(sid.to_string(), r.clone()),
            None => self.pending_questions.remove(sid),
        };
        let Some(chat) = out_chat.or_else(|| self.chat_for_session(sid)) else { return };
        let Some(request) = request else { return };
        let Some(questions) = request.get("questions").and_then(Value::as_array) else { return };
        let one = questions.first().filter(|_| questions.len() == 1);
        let options = one.and_then(|q| q.get("options")).and_then(Value::as_array).cloned().unwrap_or_default();
        if let Some(q) = one.filter(|_| options.len() <= 4) {
            let mut rows = Vec::new();
            for opt in &options {
                let label = opt.get("label").cloned();
                let data = self.save_callback(Callback::Ask {
                    session_id: sid.to_string(),
                    call_id: request.get("callId").cloned().unwrap_or(Value::Null),
                    question_id: q.get("id").cloned(),
                    label: label.clone(),
                });
                let mut button = Map::new();
                if let Some(l) = label {
                    button.insert("text".into(), l);
                }
                button.insert("callback_data".into(), json!(data));
                rows.push(json!([button]));
            }
            let text = format!("Agent asks: {}\n(reply with text for something else)", crate::show(q.get("question")));
            self.send(&chat, &text, Some(Value::Array(rows)));
        } else {
            let text = questions
                .iter()
                .map(|x| {
                    let opts = x.get("options").and_then(Value::as_array).cloned().unwrap_or_default();
                    let bullets: Vec<String> =
                        opts.iter().map(|o| format!("\u{2022} {}", crate::show(o.get("label")))).collect();
                    format!("{}\n{}", crate::show(x.get("question")), bullets.join("\n"))
                })
                .collect::<Vec<_>>()
                .join("\n\n");
            self.send(&chat, &format!("Agent asks:\n\n{text}\n\n(reply with your answer)"), None);
        }
    }

    fn on_update(&mut self, u: &Value, host: &dyn Host) {
        let base = self.offset.unwrap_or_else(|| nekko_js::to_number(self.state.get("offset")));
        self.offset = Some(js_max(base, plus_one(u.get("update_id"))));
        if let Some(m) = u.get("message")
            && nekko_js::truthy(m.get("text"))
            && nekko_js::truthy(m.get("chat"))
        {
            if let Some(text) = m.get("text").and_then(Value::as_str) {
                let chat = crate::show(m.pointer("/chat/id"));
                self.inbound_text(&chat, nekko_js::trim(text).to_string(), host);
            }
            return;
        }
        let Some(cb) = u.get("callback_query").filter(|c| nekko_js::truthy(Some(c))) else { return };
        if self.client.is_none() {
            return;
        }
        let chat = cb.pointer("/message/chat/id").filter(|v| !v.is_null()).map(nekko_js::display);
        let Some(chat) = chat.filter(|c| !c.is_empty() && allowed(&host.settings(), c)) else { return };
        let data = match cb.get("data") {
            None | Some(Value::Null) => String::new(),
            Some(d) => nekko_js::display(d),
        };
        let seq = data
            .strip_prefix("m:")
            .filter(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()))
            .map(nekko_js::string_to_number)
            .filter(|n| n.fract() == 0.0 && *n < 9_007_199_254_740_992.0)
            .map(|n| n as u64);
        let cb_id = cb.get("id").cloned().unwrap_or(Value::Null);
        let Some(entry) = seq.and_then(|s| self.callbacks.remove(&s)) else {
            let body = telegram::answer_callback_query(&cb_id, Some(&json!(EXPIRED)));
            self.tg("answerCallbackQuery", body, TgJob::Plain);
            return;
        };
        match entry {
            Callback::Approve { session_id, call_id } => {
                let approved = !call_id.starts_with('!');
                let id = call_id.strip_prefix('!').unwrap_or(&call_id).to_string();
                self.fx.push(Effect::Approve { session_id, call_id: id, approved });
                let word = if approved { "Approved" } else { "Denied" };
                self.tg(
                    "answerCallbackQuery",
                    telegram::answer_callback_query(&cb_id, Some(&json!(word))),
                    TgJob::Plain,
                );
                if let Some(mid) = cb.pointer("/message/message_id").filter(|m| nekko_js::truthy(Some(m))) {
                    let head = match cb.pointer("/message/text") {
                        None | Some(Value::Null) => "Approval".to_string(),
                        Some(t) => nekko_js::display(t),
                    };
                    let text = format!("{head}: {} from Telegram.", if approved { "approved" } else { "denied" });
                    self.tg("editMessageText", telegram::edit_message_text(&chat, mid, &text), TgJob::Plain);
                }
            }
            Callback::Ask { session_id, call_id, question_id, label } => {
                let mut answer = Map::new();
                answer.insert("questionId".into(), question_id.filter(|q| !q.is_null()).unwrap_or(json!("")));
                let labels = match &label {
                    Some(l) if nekko_js::truthy(Some(l)) => json!([l]),
                    _ => json!([]),
                };
                answer.insert("labels".into(), labels);
                self.fx.push(Effect::Answer { session_id: session_id.clone(), call_id, answers: json!([answer]) });
                self.pending_questions.remove(&session_id);
                self.tg("answerCallbackQuery", telegram::answer_callback_query(&cb_id, label.as_ref()), TgJob::Plain);
            }
        }
    }

    fn inbound_text(&mut self, chat_id: &str, text: String, host: &dyn Host) {
        if self.client.is_none() || text.is_empty() {
            return;
        }
        if !allowed(&host.settings(), chat_id) {
            // The allowlist is the whole authorization boundary: refuse loudly.
            self.send(chat_id, REFUSED, None);
            return;
        }
        if let Some(waiting) = self.creating.get_mut(chat_id) {
            waiting.push_back(text);
            return;
        }
        let bound = self.bindings().and_then(|b| b.get(chat_id)).filter(|b| nekko_js::truthy(Some(b))).cloned();
        if let Some(session) = bound.and_then(|b| host.session(&nekko_js::display(&b))) {
            self.with_session(&session, chat_id, text, host);
            return;
        }
        self.creating.insert(chat_id.to_string(), VecDeque::new());
        let req = self.id();
        self.requests.insert(req, Request::Create { chat_id: chat_id.to_string(), text });
        self.fx.push(Effect::CreateSession { req });
    }

    /// The chat `session:create` made for a chat.
    pub fn created(&mut self, req: u64, result: Result<Value, String>, host: &dyn Host) -> Vec<Effect> {
        let Some(Request::Create { chat_id, text }) = self.requests.remove(&req) else { return self.take() };
        let waiting = self.creating.remove(&chat_id).unwrap_or_default();
        if let Ok(session) = result {
            self.bind(&chat_id, session.get("id").cloned().unwrap_or(Value::Null));
            self.persist();
            self.with_session(&session, &chat_id, text, host);
        }
        for t in waiting {
            self.inbound_text(&chat_id, t, host);
        }
        self.take()
    }

    fn with_session(&mut self, session: &Value, chat_id: &str, text: String, host: &dyn Host) {
        let sid = crate::show(session.get("id"));
        // A pending ask_user question takes the next text as its free-text answer.
        if let Some(pending) = self.pending_questions.remove(&sid) {
            // `pending.questions[0].id`: with no first question the TS threw here and answered nothing.
            let Some(first) = pending.pointer("/questions/0") else { return };
            let mut answer = Map::new();
            if let Some(q) = first.get("id") {
                answer.insert("questionId".into(), q.clone());
            }
            answer.insert("labels".into(), json!([]));
            answer.insert("note".into(), json!(text));
            self.fx.push(Effect::Answer {
                session_id: sid,
                call_id: pending.get("callId").cloned().unwrap_or(Value::Null),
                answers: json!([answer]),
            });
            return;
        }
        let settings = host.settings();
        let first_enabled = settings
            .get("providers")
            .and_then(Value::as_array)
            .and_then(|ps| ps.iter().find(|p| nekko_js::truthy(p.get("enabled"))))
            .and_then(|p| p.get("id"));
        let provider = coalesce(session.get("providerId"), settings.get("defaultProviderId"))
            .or_else(|| first_enabled.filter(|v| !v.is_null()).cloned())
            .filter(|p| nekko_js::truthy(Some(p)));
        let Some(provider) = provider else {
            self.send(chat_id, NO_TARGET, None);
            return;
        };
        if nekko_js::truthy(session.get("autoModel")) {
            let req = self.id();
            self.requests.insert(
                req,
                Request::Models { session_id: sid, chat_id: chat_id.into(), provider_id: provider.clone(), text },
            );
            self.fx.push(Effect::ListModels { req, provider_id: provider });
            return;
        }
        match coalesce(session.get("modelId"), settings.get("defaultModelId")).filter(|m| nekko_js::truthy(Some(m))) {
            Some(model) => self.start_chat(&sid, chat_id, provider, model, text),
            None => self.send(chat_id, NO_TARGET, None),
        }
    }

    /// The models an Auto chat's provider lists (`[]` when listing failed).
    pub fn models_listed(&mut self, req: u64, models: Result<Value, String>) -> Vec<Effect> {
        let Some(Request::Models { session_id, chat_id, provider_id, text }) = self.requests.remove(&req) else {
            return self.take();
        };
        let list = match models {
            Ok(Value::Array(a)) => a,
            _ => Vec::new(),
        };
        match crate::auto::pick(&list, &text) {
            Some(model) => self.start_chat(&session_id, &chat_id, provider_id, model, text),
            None => self.send(&chat_id, NO_TARGET, None),
        }
        self.take()
    }

    fn start_chat(&mut self, sid: &str, chat_id: &str, provider: Value, model: Value, text: String) {
        self.new_out(sid, chat_id, "queued\u{2026}");
        self.schedule_flush(sid);
        let req = self.id();
        self.requests.insert(req, Request::Send { session_id: sid.into(), chat_id: chat_id.into() });
        let mut opts = Map::new();
        opts.insert("sessionId".into(), json!(sid));
        opts.insert("providerId".into(), provider);
        if !model.is_null() {
            opts.insert("modelId".into(), model);
        }
        opts.insert("text".into(), json!(text));
        self.fx.push(Effect::SendChat { req, opts: Value::Object(opts) });
    }

    /// A turn `chat:send` started has ended (or was refused).
    pub fn sent(&mut self, req: u64, result: Result<Value, String>) -> Vec<Effect> {
        if let Some(Request::Send { session_id, chat_id }) = self.requests.remove(&req)
            && let Err(e) = result
        {
            self.drop_out(&session_id);
            self.send(&chat_id, &format!("Nekko Agent error: {e}"), None);
        }
        self.take()
    }
}
