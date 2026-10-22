//! Terminals and SSH from a paired phone (IO-33 FA-3, FA-6): the daemon's
//! copy of `packages/shared/src/phone-terminal.ts`, plus what only the
//! computer can hold: the terminal session tokens and who is attached.
//!
//! - Read (`terminals:list` for one chat, `terminal:tail`, `ssh:hosts`) and
//!   Change (`terminal:create`, `ssh:open`, `terminal:signal`,
//!   `terminal:close`, and the gate's own `terminal:open`) go through the
//!   foundation's switches and signed proofs.
//! - Typing (`terminal:write`, `terminal:resize`) carries the token that
//!   opening the terminal handed out: bound to the phone and the terminal,
//!   ended by leaving, a disconnect, the terminal's exit, `tokenIdleMs`
//!   without input or `tokenMaxMs` after it was handed out. The phone's
//!   Change switch is read on every write.
//! - Output (`terminal:event`) goes only to the phones attached to that
//!   terminal (`PhoneTerminals::attached`), paced by `Coalescer`.
//! - A phone reaches only terminals opened for a chat and the agent's
//!   command logs (read only).
//!
//! `tests/golden/phone-terminal.json`, written by the TS, holds the screen,
//! the forwarded arguments and the views equal to the TS.

use crate::phone::{Denied, Gate, policy};
use crate::socket::PhoneCall;
use base64::Engine;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// `PHONE_TERMINAL` and the gate's channels, from `phone-access.json`.
/// Missing numbers are zero: nothing fits, so nothing is let through.
#[derive(Debug, Clone, Default)]
pub struct Limits {
    pub tail_bytes: usize,
    pub write_bytes: usize,
    pub title_chars: usize,
    pub hosts: usize,
    pub host_chars: usize,
    pub max_cols: i64,
    pub max_rows: i64,
    pub token_idle_ms: f64,
    pub token_max_ms: f64,
    pub event_bytes: usize,
    pub event_window_ms: u64,
    pub event_backlog_bytes: usize,
    pub open_channel: String,
    pub leave_channel: String,
    pub read_channels: Vec<String>,
    pub change_channels: Vec<String>,
    pub token_channels: Vec<String>,
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect()).unwrap_or_default()
}

/// The terminal channels by class, as the TS lists them.
const READ: &[&str] = &["ssh:hosts", "terminal:tail", "terminals:list"];
const CHANGE: &[&str] = &["ssh:open", "terminal:close", "terminal:create", "terminal:signal"];

impl Limits {
    pub fn from_policy(v: &Value) -> Self {
        let t = &v["terminal"];
        let n = |k: &str| t[k].as_u64().unwrap_or(0);
        let only = |list: &Value, of: &[&str]| -> Vec<String> {
            strings(list).into_iter().filter(|c| of.contains(&c.as_str())).collect()
        };
        Limits {
            tail_bytes: n("tailBytes") as usize,
            write_bytes: n("writeBytes") as usize,
            title_chars: n("titleChars") as usize,
            hosts: n("hosts") as usize,
            host_chars: n("hostChars") as usize,
            max_cols: n("maxCols") as i64,
            max_rows: n("maxRows") as i64,
            token_idle_ms: n("tokenIdleMs") as f64,
            token_max_ms: n("tokenMaxMs") as f64,
            event_bytes: n("eventBytes") as usize,
            event_window_ms: n("eventWindowMs"),
            event_backlog_bytes: n("eventBacklogBytes") as usize,
            open_channel: t["openChannel"].as_str().unwrap_or("terminal:open").to_string(),
            leave_channel: t["leaveChannel"].as_str().unwrap_or("terminal:leave").to_string(),
            read_channels: only(&v["readChannels"], READ),
            change_channels: only(&v["changeChannels"], CHANGE),
            token_channels: strings(&v["tokenChannels"]),
        }
    }

    /// Whether `channel` is one of the terminal channels a phone may call.
    pub fn is_terminal(&self, channel: &str) -> bool {
        [&self.read_channels, &self.change_channels, &self.token_channels]
            .iter()
            .any(|l| l.iter().any(|c| c == channel))
    }
}

fn limits() -> &'static Limits {
    &policy().terminal
}

fn no(code: &'static str, detail: impl Into<String>) -> Denied {
    Denied { code, detail: detail.into() }
}

/// `Number.isInteger`: an integer, or a double with no fraction.
fn int(v: &Value) -> Option<i64> {
    v.as_i64()
        .or_else(|| v.as_f64().filter(|f| f.is_finite() && f.fract() == 0.0 && f.abs() < 9.0e15).map(|f| f as i64))
}

fn cut(s: &str, n: usize) -> String {
    crate::hello::cut16(s, n).to_string()
}

fn text(v: Option<&Value>) -> &str {
    v.and_then(Value::as_str).unwrap_or("")
}

/// `phoneBaseName`: the last part of a path, `/` or `\` separated.
pub fn base_name(path: &str) -> &str {
    path.split(['/', '\\']).rfind(|p| !p.is_empty()).unwrap_or("")
}

fn shell_name(path: &str) -> String {
    let base = base_name(path);
    match base.len().checked_sub(4).and_then(|i| base.get(i..).map(|tail| (i, tail))) {
        Some((i, tail)) if tail.eq_ignore_ascii_case(".exe") => base[..i].to_string(),
        _ => base.to_string(),
    }
}

/// `phoneTerminalView`: one terminal without paths or other viewers' names.
pub fn terminal_view(info: &Value) -> Option<Value> {
    let o = info.as_object()?;
    let id = o.get("id")?.as_str()?;
    let shell = shell_name(text(o.get("shell")));
    let agent = !text(o.get("agentSessionId")).is_empty() || shell == "agent";
    let kind = if agent {
        "agent"
    } else if shell.eq_ignore_ascii_case("ssh") {
        "ssh"
    } else {
        "shell"
    };
    let mut out = Map::new();
    out.insert("id".into(), json!(id));
    out.insert("title".into(), json!(cut(text(o.get("title")), limits().title_chars)));
    out.insert("kind".into(), json!(kind));
    out.insert("folder".into(), json!(base_name(text(o.get("cwd")))));
    out.insert("shell".into(), json!(shell));
    out.insert("running".into(), json!(o.get("running") == Some(&Value::Bool(true))));
    out.insert("viewers".into(), json!(o.get("viewers").and_then(Value::as_array).map_or(0, Vec::len)));
    for k in ["exitCode", "createdAt"] {
        if let Some(v) = o.get(k).filter(|v| v.is_number()) {
            out.insert(k.into(), v.clone());
        }
    }
    let sid = Some(text(o.get("sessionId"))).filter(|s| !s.is_empty()).unwrap_or(text(o.get("agentSessionId")));
    if !sid.is_empty() {
        out.insert("sessionId".into(), json!(sid));
    }
    Some(Value::Object(out))
}

pub fn terminals_view(list: &Value) -> Value {
    Value::Array(list.as_array().map(|a| a.iter().filter_map(terminal_view).collect()).unwrap_or_default())
}

/// `phoneTerminalTailView`.
pub fn tail_view(snap: &Value) -> Value {
    let Some(o) = snap.as_object() else { return Value::Null };
    let mut out = Map::new();
    out.insert("terminal".into(), o.get("info").and_then(terminal_view).unwrap_or(Value::Null));
    out.insert("buffer".into(), json!(text(o.get("buffer"))));
    out.insert("cols".into(), json!(o.get("cols").and_then(int).unwrap_or(80)));
    out.insert("rows".into(), json!(o.get("rows").and_then(int).unwrap_or(24)));
    out.insert("truncated".into(), json!(o.get("truncated") == Some(&Value::Bool(true))));
    if let Some(total) = o.get("totalBytes").and_then(int) {
        out.insert("totalBytes".into(), json!(total));
    }
    Value::Object(out)
}

/// `phoneSshHostsView`: alias, host name and port; never the user or keys.
pub fn hosts_view(list: &Value) -> Value {
    let l = limits();
    let mut out = Vec::new();
    for h in list.as_array().into_iter().flatten() {
        if out.len() >= l.hosts {
            break;
        }
        let Some(alias) = h.get("alias").and_then(Value::as_str).filter(|a| !a.is_empty()) else { continue };
        let mut host = Map::new();
        host.insert("alias".into(), json!(cut(alias, l.host_chars)));
        if let Some(name) = h.get("hostName").and_then(Value::as_str).filter(|n| !n.is_empty()) {
            host.insert("hostName".into(), json!(cut(name, l.host_chars)));
        }
        if let Some(port) = h.get("port").and_then(int).filter(|p| (1..=65535).contains(p)) {
            host.insert("port".into(), json!(port));
        }
        out.push(Value::Object(host));
    }
    Value::Array(out)
}

fn size_problem(cols: Option<&Value>, rows: Option<&Value>) -> Option<Denied> {
    let l = limits();
    let bad = |v: Option<&Value>, max: i64| v.is_some_and(|v| !int(v).is_some_and(|n| n >= 1 && n <= max));
    if bad(cols, l.max_cols) {
        return Some(no("value-invalid", "cols"));
    }
    if bad(rows, l.max_rows) {
        return Some(no("value-invalid", "rows"));
    }
    None
}

fn keys_problem(o: &Map<String, Value>, allowed: &[&str]) -> Option<Denied> {
    o.keys().find(|k| !allowed.contains(&k.as_str())).map(|k| no("option-denied", k.clone()))
}

fn non_empty(v: Option<&Value>) -> bool {
    v.and_then(Value::as_str).is_some_and(|s| !s.is_empty())
}

/// `phoneTerminalProblem`: what is wrong with a terminal call's arguments.
pub fn problem(channel: &str, args: &[Value]) -> Option<Denied> {
    let arg = |i: usize| args.get(i);
    let id = |i: usize, what: &str| if non_empty(arg(i)) { None } else { Some(no("value-invalid", what)) };
    let token = |i: usize| if non_empty(arg(i)) { None } else { Some(no("token-required", channel)) };
    match channel {
        "terminals:list" => match arg(0).and_then(Value::as_object) {
            Some(o) if non_empty(o.get("sessionId")) => keys_problem(o, &["sessionId"]),
            _ => Some(no("value-invalid", "chat id")),
        },
        "terminal:tail" => {
            let max = arg(1).filter(|v| !v.is_null());
            if max.is_some_and(|v| int(v).is_none_or(|n| n < 1)) {
                return Some(no("value-invalid", "maxBytes"));
            }
            id(0, "terminal id")
        }
        "terminal:create" => {
            let Some(o) = arg(0).and_then(Value::as_object) else {
                return Some(no("value-invalid", "terminal options"));
            };
            if let Some(d) = keys_problem(o, &["cols", "rows", "sessionId", "title"]) {
                return Some(d);
            }
            if !non_empty(o.get("sessionId")) {
                return Some(no("value-invalid", "chat id"));
            }
            if o.get("title").is_some_and(|t| !t.is_string()) {
                return Some(no("value-invalid", "title"));
            }
            size_problem(o.get("cols"), o.get("rows"))
        }
        "ssh:open" => {
            let alias_ok = arg(0)
                .and_then(Value::as_str)
                .is_some_and(|a| !a.is_empty() && a.encode_utf16().count() <= limits().host_chars);
            if !alias_ok {
                return Some(no("value-invalid", "host alias"));
            }
            let Some(o) = arg(1).and_then(Value::as_object) else {
                return Some(no("value-invalid", "terminal options"));
            };
            if let Some(d) = keys_problem(o, &["cols", "rows", "sessionId"]) {
                return Some(d);
            }
            if !non_empty(o.get("sessionId")) {
                return Some(no("value-invalid", "chat id"));
            }
            size_problem(o.get("cols"), o.get("rows"))
        }
        "terminal:write" => {
            if arg(1).and_then(Value::as_str).is_none_or(|d| d.len() > limits().write_bytes) {
                return Some(no("value-invalid", "input"));
            }
            id(0, "terminal id").or_else(|| token(2))
        }
        "terminal:resize" => id(0, "terminal id")
            .or_else(|| size_problem(Some(arg(1).unwrap_or(&Value::Null)), Some(arg(2).unwrap_or(&Value::Null))))
            .or_else(|| token(3)),
        "terminal:signal" | "terminal:close" => id(0, "terminal id"),
        _ => None,
    }
}

/// `phoneTerminalCallArgs`: what the computer's own call takes, the token
/// dropped and the tail capped (`terminal:create` gets `workspaceId` later).
pub fn call_args(channel: &str, args: &[Value]) -> Vec<Value> {
    let arg = |i: usize| args.get(i).cloned().unwrap_or(Value::Null);
    let size = |o: &Value, out: &mut Map<String, Value>| {
        for k in ["cols", "rows"] {
            if let Some(n) = o.get(k).and_then(int) {
                out.insert(k.into(), json!(n));
            }
        }
    };
    match channel {
        "terminals:list" => vec![json!({ "sessionId": arg(0)["sessionId"] })],
        "terminal:tail" => {
            let max = limits().tail_bytes as i64;
            vec![arg(0), json!(args.get(1).and_then(int).unwrap_or(max).min(max))]
        }
        "ssh:hosts" => Vec::new(),
        "terminal:create" => {
            let o = arg(0);
            let mut out = Map::new();
            out.insert("sessionId".into(), o["sessionId"].clone());
            size(&o, &mut out);
            if let Some(t) = o.get("title").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                out.insert("title".into(), json!(cut(t, limits().title_chars)));
            }
            vec![Value::Object(out)]
        }
        "ssh:open" => {
            let o = arg(1);
            let mut out = Map::new();
            out.insert("sessionId".into(), o["sessionId"].clone());
            size(&o, &mut out);
            vec![arg(0), Value::Object(out)]
        }
        "terminal:write" => vec![arg(0), arg(1)],
        "terminal:resize" => vec![arg(0), arg(1), arg(2)],
        "terminal:signal" | "terminal:close" => vec![arg(0)],
        _ => args.to_vec(),
    }
}

/// `phoneTerminalResult`: what a phone receives for a terminal channel.
pub fn result(channel: &str, value: &Value) -> Value {
    match channel {
        "terminals:list" => terminals_view(value),
        "terminal:tail" => tail_view(value),
        "ssh:hosts" => hosts_view(value),
        "terminal:create" | "ssh:open" => terminal_view(value).unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

/// One phone attached to one terminal.
struct Session {
    device: String,
    terminal: String,
    /// sha256 of the token: the token itself is not kept.
    token: [u8; 32],
    opened: f64,
    used: f64,
}

/// Leave every terminal on the computer for this device (its last
/// connection dropped): the daemon's `terminal:detach(null, device)`.
pub type DeviceGone = Arc<dyn Fn(String) + Send + Sync>;

/// Who is attached to which terminal, and their tokens. Shared by the phone
/// gate (which opens and checks) and the relay agent (which scopes output
/// and sees disconnects). Memory only: a restart ends every session.
#[derive(Default)]
pub struct PhoneTerminals {
    sessions: Mutex<Vec<Session>>,
    gone: Mutex<Option<DeviceGone>>,
}

fn hash(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

impl PhoneTerminals {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<Session>> {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// What to run when a device with attachments disconnects.
    pub fn on_device_gone(&self, f: DeviceGone) {
        *self.gone.lock().unwrap_or_else(|e| e.into_inner()) = Some(f);
    }

    /// Attach `device` to `terminal` with a new token (replacing any it had there).
    pub fn open(&self, device: &str, terminal: &str, now: f64) -> String {
        let mut raw = [0u8; 32];
        getrandom::fill(&mut raw).expect("the OS random source is available");
        let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw);
        let mut all = self.lock();
        all.retain(|s| !(s.device == device && s.terminal == terminal));
        all.push(Session {
            device: device.into(),
            terminal: terminal.into(),
            token: hash(&token),
            opened: now,
            used: now,
        });
        token
    }

    /// Whether `token` lets `device` type into `terminal` at `now`; a use
    /// keeps it alive. `token-invalid` (not this phone's for this terminal,
    /// or not attached) or `token-expired` (idle or too old: open it again).
    pub fn check(&self, device: &str, terminal: &str, token: &str, now: f64) -> Result<(), &'static str> {
        let l = limits();
        let mut all = self.lock();
        let s = all.iter_mut().find(|s| s.device == device && s.terminal == terminal).ok_or("token-invalid")?;
        if s.token != hash(token) {
            return Err("token-invalid");
        }
        if now - s.used > l.token_idle_ms || now - s.opened > l.token_max_ms {
            return Err("token-expired");
        }
        s.used = now;
        Ok(())
    }

    pub fn attached(&self, device: &str, terminal: &str) -> bool {
        self.lock().iter().any(|s| s.device == device && s.terminal == terminal)
    }

    /// The device left the terminal; whether it was attached.
    pub fn leave(&self, device: &str, terminal: &str) -> bool {
        let mut all = self.lock();
        let before = all.len();
        all.retain(|s| !(s.device == device && s.terminal == terminal));
        all.len() != before
    }

    /// The device's last connection dropped: every session ends, and the
    /// computer forgets it as a viewer.
    pub fn device_gone(&self, device: &str) {
        let had = {
            let mut all = self.lock();
            let before = all.len();
            all.retain(|s| s.device != device);
            all.len() != before
        };
        if had && let Some(f) = self.gone.lock().unwrap_or_else(|e| e.into_inner()).clone() {
            f(device.to_string());
        }
    }

    /// The terminal exited or was closed: nobody is attached any more.
    pub fn terminal_gone(&self, terminal: &str) {
        self.lock().retain(|s| s.terminal != terminal);
    }
}

/// One terminal's output on its way to phones.
#[derive(Default)]
struct Flow {
    start: u64,
    sent: usize,
    pending: String,
    skipped: usize,
}

/// Paces a terminal's output to phones: at most `bytes` per `window_ms` per
/// terminal. The first output after a quiet window goes at once; the rest
/// waits for the next window (`due`). Past `backlog` bytes waiting, the
/// backlog is dropped and the next event carries `skipped`, so the phone
/// reads the tail again instead of the relay carrying a flood.
pub struct Coalescer {
    bytes: usize,
    window_ms: u64,
    backlog: usize,
    flows: HashMap<String, Flow>,
}

/// The longest prefix of `s` within `n` bytes that ends on a character.
fn prefix(s: &str, n: usize) -> usize {
    let mut i = n.min(s.len());
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

impl Coalescer {
    pub fn new(bytes: usize, window_ms: u64, backlog: usize) -> Self {
        Self { bytes, window_ms, backlog, flows: HashMap::new() }
    }

    pub fn from_policy() -> Self {
        let l = limits();
        Self::new(l.event_bytes, l.event_window_ms, l.event_backlog_bytes)
    }

    /// Output for `terminal` at `now` (ms): what to send at once, with how
    /// many bytes were dropped before it.
    pub fn push(&mut self, terminal: &str, data: &str, now: u64) -> Option<(String, usize)> {
        let (bytes, window, backlog) = (self.bytes, self.window_ms, self.backlog);
        let f = self.flows.entry(terminal.to_string()).or_default();
        if now >= f.start + window {
            f.start = now;
            f.sent = 0;
        }
        let mut out = None;
        let mut rest = data;
        if f.pending.is_empty() && f.skipped == 0 && f.sent < bytes {
            let n = prefix(data, bytes - f.sent);
            if n > 0 {
                f.sent += n;
                out = Some((data[..n].to_string(), 0));
                rest = &data[n..];
            }
        }
        if !rest.is_empty() {
            f.pending.push_str(rest);
            if f.pending.len() > backlog {
                f.skipped += f.pending.len();
                f.pending.clear();
            }
        }
        out
    }

    /// Output whose window has come round at `now`: `(terminal, data, skipped)`.
    pub fn due(&mut self, now: u64) -> Vec<(String, String, usize)> {
        let (bytes, window) = (self.bytes, self.window_ms);
        let mut out = Vec::new();
        for (id, f) in self.flows.iter_mut() {
            if (f.pending.is_empty() && f.skipped == 0) || now < f.start + window {
                continue;
            }
            f.start = now;
            let n = prefix(&f.pending, bytes);
            f.sent = n;
            let data: String = f.pending.drain(..n).collect();
            out.push((id.clone(), data, std::mem::take(&mut f.skipped)));
        }
        // Quiet terminals are forgotten; a new burst starts a fresh window anyway.
        self.flows.retain(|_, f| !f.pending.is_empty() || f.skipped > 0 || now < f.start + window);
        out.sort();
        out
    }

    /// Everything still waiting for `terminal`, at once (before its exit), and forget it.
    pub fn take(&mut self, terminal: &str) -> Option<(String, usize)> {
        let f = self.flows.remove(terminal)?;
        (!f.pending.is_empty() || f.skipped > 0).then_some((f.pending, f.skipped))
    }

    pub fn is_idle(&self) -> bool {
        self.flows.values().all(|f| f.pending.is_empty() && f.skipped == 0)
    }
}

/// A `terminal:event` data payload as a phone receives it.
pub fn data_event(terminal: &str, data: &str, skipped: usize) -> Value {
    let mut o = Map::new();
    o.insert("type".into(), json!("data"));
    o.insert("terminalId".into(), json!(terminal));
    o.insert("data".into(), json!(data));
    if skipped > 0 {
        o.insert("skipped".into(), json!(skipped));
    }
    Value::Object(o)
}

/// The gate's side: the steps a terminal call needs beyond the foundation's.
impl Gate {
    /// The terminal channels that need more than the generic read path,
    /// answered here; `None` for every other channel.
    pub(crate) async fn terminal_call(
        &self,
        who: &PhoneCall,
        channel: &str,
        args: &Value,
    ) -> Option<Result<Value, String>> {
        let l = limits();
        let list: Vec<Value> = args.as_array().cloned().unwrap_or_default();
        if channel == l.leave_channel {
            return Some(self.leave(who, channel, &list).await.map_err(|d| d.to_string()));
        }
        let change = channel == l.open_channel || l.change_channels.iter().any(|c| c == channel);
        if change {
            if channel != l.open_channel && !crate::phone::channel_allowed(channel) {
                return Some(Err(no("channel-denied", channel).to_string()));
            }
            if let Err(d) = self.check_change(who, channel, args) {
                self.record(who, channel, Err(d.code.to_string()));
                return Some(Err(d.to_string()));
            }
            let out = self.terminal_change(who, channel, &list).await;
            self.record(who, channel, out.as_ref().map(|_| ()).map_err(|e| crate::phone::reason_of(e)));
            return Some(out);
        }
        if l.token_channels.iter().any(|c| c == channel) {
            return Some(self.typed(who, channel, &list).await);
        }
        if channel == "terminal:tail" && l.read_channels.iter().any(|c| c == channel) {
            return Some(self.tail(who, channel, &list).await);
        }
        None
    }

    async fn tail(&self, who: &PhoneCall, channel: &str, args: &[Value]) -> Result<Value, String> {
        if !crate::phone::channel_allowed(channel) {
            return Err(no("channel-denied", channel).to_string());
        }
        let device = self.devices.device(&who.device_id).ok_or_else(|| no("device-unknown", channel).to_string())?;
        if !device.access.read {
            return Err(no("read-off", channel).to_string());
        }
        if let Some(d) = problem(channel, args) {
            return Err(d.to_string());
        }
        self.reachable(text(args.first()), true).await?;
        crate::phone::call(&self.run, channel.to_string(), Value::Array(args.to_vec())).await
    }

    /// A terminal a phone may reach: one opened for a chat, or (with
    /// `logs`) an agent's command log. Anything else reads as not there.
    async fn reachable(&self, id: &str, logs: bool) -> Result<(), String> {
        let all = (self.run)("terminals:list".into(), json!([{}])).await?;
        let found = all.as_array().into_iter().flatten().find(|t| t.get("id").and_then(Value::as_str) == Some(id));
        let ok = found.is_some_and(|t| non_empty(t.get("sessionId")) || (logs && non_empty(t.get("agentSessionId"))));
        if ok { Ok(()) } else { Err(no("terminal-hidden", id).to_string()) }
    }

    async fn terminal_change(&self, who: &PhoneCall, channel: &str, args: &[Value]) -> Result<Value, String> {
        let l = limits();
        if channel == l.open_channel {
            let id = text(args.first());
            if id.is_empty() {
                return Err(no("value-invalid", "terminal id").to_string());
            }
            self.reachable(id, false).await?;
            return self.attach(who, id).await;
        }
        match channel {
            "terminal:create" | "ssh:open" => {
                let info = crate::phone::call(&self.run, channel.to_string(), Value::Array(args.to_vec())).await?;
                let id = info.get("id").and_then(Value::as_str).ok_or("The computer didn’t open a terminal.")?;
                self.attach(who, id).await
            }
            _ => {
                // terminal:signal, terminal:close: only a chat's terminals, never an agent log.
                if let Some(d) = problem(channel, args) {
                    return Err(d.to_string());
                }
                let id = text(args.first()).to_string();
                self.reachable(&id, false).await?;
                let out = crate::phone::call(&self.run, channel.to_string(), Value::Array(args.to_vec())).await?;
                if channel == "terminal:close" {
                    self.terminals.terminal_gone(&id);
                }
                Ok(out)
            }
        }
    }

    /// Mark this phone as a viewer, send it the tail, and hand it a token.
    async fn attach(&self, who: &PhoneCall, id: &str) -> Result<Value, String> {
        let l = limits();
        let mut viewer = Map::new();
        viewer.insert("id".into(), json!(who.device_id));
        viewer.insert("kind".into(), json!("phone"));
        if let Some(name) = self.devices.name(&who.device_id) {
            viewer.insert("name".into(), json!(name));
        }
        (self.run)("terminal:attach".into(), json!([id, viewer])).await?;
        let snap = (self.run)("terminal:tail".into(), json!([id, l.tail_bytes])).await?;
        let token = self.terminals.open(&who.device_id, id, self.devices.now());
        let mut out = match tail_view(&snap) {
            Value::Object(o) => o,
            _ => Map::new(),
        };
        out.insert("token".into(), json!(token));
        out.insert("idleMs".into(), crate::hello::nekko_num(l.token_idle_ms));
        out.insert("maxMs".into(), crate::hello::nekko_num(l.token_max_ms));
        Ok(Value::Object(out))
    }

    /// `terminal:leave [id]`: no proof (it only gives access up), logged.
    async fn leave(&self, who: &PhoneCall, channel: &str, args: &[Value]) -> Result<Value, Denied> {
        let id = text(args.first());
        if id.is_empty() {
            return Err(no("value-invalid", "terminal id"));
        }
        self.devices.device(&who.device_id).ok_or_else(|| no("device-unknown", channel))?;
        let was = self.terminals.leave(&who.device_id, id);
        // The terminal may be gone already; leaving it is still done.
        let _ = (self.run)("terminal:detach".into(), json!([id, who.device_id])).await;
        if was {
            self.record(who, channel, Ok(()));
        }
        Ok(json!({ "left": was }))
    }

    /// `terminal:write` / `terminal:resize`: the Change switch, the
    /// arguments, then the token for this phone and this terminal.
    async fn typed(&self, who: &PhoneCall, channel: &str, args: &[Value]) -> Result<Value, String> {
        self.may_type(who, channel, args).map_err(|d| d.to_string())?;
        (self.run)(channel.to_string(), Value::Array(call_args(channel, args))).await?;
        Ok(Value::Null)
    }

    fn may_type(&self, who: &PhoneCall, channel: &str, args: &[Value]) -> Result<(), Denied> {
        if !crate::phone::channel_allowed(channel) {
            return Err(no("channel-denied", channel));
        }
        let device = self.devices.device(&who.device_id).ok_or_else(|| no("device-unknown", channel))?;
        if !device.access.change {
            return Err(no("change-off", channel));
        }
        if let Some(d) = problem(channel, args) {
            return Err(d);
        }
        let id = text(args.first());
        let token = text(args.get(if channel == "terminal:write" { 2 } else { 3 }));
        self.terminals.check(&who.device_id, id, token, self.devices.now()).map_err(|code| no(code, channel))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_policy_carries_the_terminal_limits() {
        let l = limits();
        assert_eq!((l.tail_bytes, l.event_bytes, l.event_window_ms), (65536, 32768, 100));
        assert_eq!((l.token_idle_ms, l.token_max_ms), (300_000.0, 1_800_000.0));
        assert_eq!((l.open_channel.as_str(), l.leave_channel.as_str()), ("terminal:open", "terminal:leave"));
        assert_eq!(l.token_channels, ["terminal:resize", "terminal:write"]);
        for c in ["terminals:list", "ssh:open", "terminal:write"] {
            assert!(l.is_terminal(c), "{c}");
        }
        assert!(!l.is_terminal("terminal:run"));
    }

    #[test]
    fn a_token_is_this_phones_for_this_terminal_until_idle_or_old() {
        let t = PhoneTerminals::default();
        let tok = t.open("phone-1", "term_1", 0.0);
        assert_eq!(tok.len(), 43, "32 random bytes, base64url");
        assert_eq!(t.check("phone-1", "term_1", &tok, 1.0), Ok(()));
        assert_eq!(t.check("phone-2", "term_1", &tok, 1.0), Err("token-invalid"), "another phone");
        assert_eq!(t.check("phone-1", "term_2", &tok, 1.0), Err("token-invalid"), "another terminal");
        assert_eq!(t.check("phone-1", "term_1", "guess", 1.0), Err("token-invalid"));
        // Used within the idle window, it lives on, up to the maximum.
        let mut now = 1.0;
        while now < 1_700_000.0 {
            now += 290_000.0;
            let r = t.check("phone-1", "term_1", &tok, now);
            if now <= 1_800_000.0 {
                assert_eq!(r, Ok(()), "at {now}");
            }
        }
        assert_eq!(t.check("phone-1", "term_1", &tok, 1_800_001.0), Err("token-expired"), "too old");
        let tok = t.open("phone-1", "term_1", 2_000_000.0);
        assert_eq!(t.check("phone-1", "term_1", &tok, 2_300_001.0), Err("token-expired"), "idle");
        assert!(t.attached("phone-1", "term_1"), "an expired token still watches until it leaves");
        // Opening again hands out a new token; the old one is dead.
        let fresh = t.open("phone-1", "term_1", 2_400_000.0);
        assert_eq!(t.check("phone-1", "term_1", &tok, 2_400_001.0), Err("token-invalid"));
        assert_eq!(t.check("phone-1", "term_1", &fresh, 2_400_001.0), Ok(()));
    }

    #[test]
    fn leaving_a_disconnect_and_an_exit_end_sessions() {
        let t = PhoneTerminals::default();
        let gone: Arc<Mutex<Vec<String>>> = Arc::default();
        let g = gone.clone();
        t.on_device_gone(Arc::new(move |d| g.lock().unwrap().push(d)));
        let a = t.open("phone-1", "term_1", 0.0);
        t.open("phone-1", "term_2", 0.0);
        t.open("phone-2", "term_1", 0.0);
        assert!(t.leave("phone-1", "term_1"));
        assert!(!t.leave("phone-1", "term_1"));
        assert_eq!(t.check("phone-1", "term_1", &a, 1.0), Err("token-invalid"));
        t.device_gone("phone-1");
        assert!(!t.attached("phone-1", "term_2"));
        t.device_gone("phone-3"); // never attached: nothing to detach
        assert_eq!(*gone.lock().unwrap(), ["phone-1"]);
        t.terminal_gone("term_1");
        assert!(!t.attached("phone-2", "term_1"));
    }

    #[test]
    fn output_is_paced_per_terminal() {
        let mut c = Coalescer::new(10, 100, 40);
        assert_eq!(c.push("t1", "hello", 0), Some(("hello".into(), 0)), "the first output goes at once");
        assert_eq!(c.push("t1", "world!", 10), Some(("world".into(), 0)), "up to the window's budget");
        assert_eq!(c.push("t2", "other", 10), Some(("other".into(), 0)), "each terminal has its own");
        assert_eq!(c.push("t1", "more", 20), None);
        assert!(c.due(50).is_empty(), "not before the window ends");
        assert_eq!(c.due(100), vec![("t1".to_string(), "!more".to_string(), 0)]);
        assert!(c.is_idle());
        // A flood past the backlog is dropped and counted.
        c.push("t1", &"x".repeat(10), 200);
        assert_eq!(c.push("t1", &"y".repeat(45), 201), None);
        assert_eq!(c.due(300), vec![("t1".to_string(), String::new(), 45)]);
        // Never half a character.
        let mut c = Coalescer::new(5, 100, 100);
        assert_eq!(c.push("t", "aaaaé", 0), Some(("aaaa".into(), 0)));
        assert_eq!(c.take("t"), Some(("é".into(), 0)));
        assert_eq!(c.take("t"), None);
    }

    #[test]
    fn names_without_paths() {
        assert_eq!(base_name("/Users/philip/code/app/"), "app");
        assert_eq!(base_name("C:\\Users\\philip"), "philip");
        assert_eq!(base_name(""), "");
        assert_eq!(shell_name("C:\\Windows\\System32\\cmd.EXE"), "cmd");
        assert_eq!(shell_name("/bin/zsh"), "zsh");
        assert_eq!(shell_name("é.exe"), "é");
    }
}
