//! Messaging channels owned by the daemon (PF14): `messaging:status`,
//! `messaging-state.json` and the Telegram bridge (`nekko-messaging`).
//!
//! The bridge is a state machine; this module runs its effects: the Bot API
//! calls on one ordered lane, the long poll on its own (dropped as soon as
//! the bridge stops or its token changes, so a disabled bot stops polling at
//! once), the 1.5 s reply flushes and the 5 s poll backoff as timers, the
//! state file written atomically in order, and the host-side work through
//! the daemon's router: `session:create` (with a new chat's defaults),
//! `models:list`, `chat:send` (admitted by the daemon), and
//! `tool:approve` / `chat:answer`. It hears every agent event the UI hears
//! from the hub, and reconfigures on every settings save.
//!
//! Telegram allows one long poll per bot token (a second gets 409 Conflict).

use crate::hub::Hub;
use nekko_messaging::bridge::{Bridge, Effect, Host};
use nekko_messaging::{TgCall, state, telegram};
use nekko_settings::SettingsStore;
use nekko_store::SessionStore;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::mpsc;

pub const CHANNELS: &[&str] = &["messaging:status"];

/// The longest a Bot API call may take (the long poll asks for 25 s).
const CALL_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_TIMEOUT: Duration = Duration::from_secs(60);
/// How long a poll waits while Telegram is switched off in Settings > Connections.
const BLOCKED_POLL: Duration = Duration::from_secs(30);

pub use crate::automation::Dispatcher;

struct DaemonHost {
    settings: Arc<SettingsStore>,
    sessions: Arc<SessionStore>,
}

impl Host for DaemonHost {
    fn settings(&self) -> Value {
        self.settings.get()
    }
    fn session(&self, id: &str) -> Option<Value> {
        self.sessions.get(id)
    }
}

struct Poll {
    serial: u64,
    task: tokio::task::AbortHandle,
}

struct Inner {
    bridge: Bridge,
    poll: Option<Poll>,
    timers: HashMap<u64, tokio::task::AbortHandle>,
    /// The `messaging` settings last applied.
    applied: Option<Value>,
}

pub struct Messaging {
    inner: Mutex<Inner>,
    host: DaemonHost,
    path: PathBuf,
    http: reqwest::Client,
    tg: mpsc::UnboundedSender<TgCall>,
    saves: mpsc::UnboundedSender<Value>,
    dispatch: OnceLock<Dispatcher>,
}

impl Messaging {
    pub fn new(
        dir: PathBuf,
        settings: Arc<SettingsStore>,
        sessions: Arc<SessionStore>,
        api_root: Option<String>,
    ) -> Arc<Self> {
        let path = dir.join(state::FILE);
        let loaded = state::load(std::fs::read(&path).ok().as_deref());
        let root = api_root.unwrap_or_else(|| telegram::DEFAULT_API_ROOT.to_string());
        let (tg, tg_rx) = mpsc::unbounded_channel();
        let (saves, saves_rx) = mpsc::unbounded_channel();
        let me = Arc::new(Messaging {
            inner: Mutex::new(Inner {
                bridge: Bridge::new(loaded, &root),
                poll: None,
                timers: HashMap::new(),
                applied: None,
            }),
            host: DaemonHost { settings, sessions },
            path,
            http: reqwest::Client::new(),
            tg,
            saves,
            dispatch: OnceLock::new(),
        });
        tokio::spawn(Self::tg_lane(Arc::downgrade(&me), tg_rx));
        tokio::spawn(Self::save_lane(me.path.clone(), saves_rx));
        me
    }

    /// How turns, chats, models and answers reach the rest of the daemon.
    pub fn set_dispatcher(&self, d: Dispatcher) {
        let _ = self.dispatch.set(d);
    }

    /// Bring the bridge up as configured, then follow every settings save
    /// and every agent event.
    pub fn start(self: &Arc<Self>, hub: &Hub) {
        let mut changes = self.host.settings.subscribe();
        let mut events = hub.subscribe();
        let weak = Arc::downgrade(self);
        // The first read: the configuration at startup, read from the file
        // without filling the store's cache (nothing else has read it yet,
        // and whatever writes the file before then must still be seen).
        let me = self.clone();
        tokio::spawn(async move {
            let path = me.host.settings.path().to_path_buf();
            let read = tokio::task::spawn_blocking(move || std::fs::read(path).ok()).await;
            if let Ok(Some(bytes)) = read {
                let now = Value::Object(nekko_settings::from_text(&String::from_utf8_lossy(&bytes)));
                me.configure(&now);
            }
            drop(me);
            loop {
                if changes.changed().await.is_err() {
                    break;
                }
                let next = changes.borrow_and_update().clone();
                let Some(me) = weak.upgrade() else { break };
                me.configure(&next);
            }
        });
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                match events.recv().await {
                    Ok(ev) => {
                        let Some(payload) = agent_event(&ev.text) else { continue };
                        let Some(me) = weak.upgrade() else { break };
                        me.with(|b| b.event(&payload));
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        });
    }

    /// Apply the `messaging` settings when they changed (`update` in the TS
    /// host ran on every save that touched them).
    fn configure(self: &Arc<Self>, settings: &Value) {
        let messaging = settings.get("messaging").cloned().unwrap_or(Value::Null);
        {
            let mut inner = self.lock();
            if inner.applied.as_ref() == Some(&messaging) {
                return;
            }
            inner.applied = Some(messaging.clone());
        }
        let m = (!messaging.is_null()).then_some(messaging);
        self.with(|b| b.update(m.as_ref()));
    }

    pub fn stop(self: &Arc<Self>) {
        self.with(|b| b.stop());
    }

    pub fn status(&self) -> Value {
        self.lock().bridge.status()
    }

    pub fn route(&self, channel: &str) -> Result<Value, String> {
        match channel {
            "messaging:status" => Ok(self.status()),
            _ => Err(format!("unknown channel {channel}")),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Feed the bridge one input and run what it asks for.
    fn with(self: &Arc<Self>, f: impl FnOnce(&mut Bridge) -> Vec<Effect>) {
        let fx = f(&mut self.lock().bridge);
        self.run(fx);
    }

    fn run(self: &Arc<Self>, fx: Vec<Effect>) {
        for e in fx {
            match e {
                Effect::Tg(call) => {
                    let _ = self.tg.send(call);
                }
                Effect::Poll(call) => self.start_poll(call),
                Effect::Arm { timer, ms } => {
                    let weak = Arc::downgrade(self);
                    let task = tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(ms)).await;
                        if let Some(me) = weak.upgrade() {
                            me.lock().timers.remove(&timer);
                            me.with(|b| b.timer(timer));
                        }
                    });
                    self.lock().timers.insert(timer, task.abort_handle());
                }
                Effect::Disarm { timer } => {
                    if let Some(t) = self.lock().timers.remove(&timer) {
                        t.abort();
                    }
                }
                Effect::Save(s) => {
                    let _ = self.saves.send(s);
                }
                Effect::CreateSession { req } => {
                    self.call("session:create", vec![], move |me, r| {
                        let host = &me.host;
                        let fx = me.lock().bridge.created(req, r, host);
                        me.run(fx);
                    });
                }
                Effect::ListModels { req, provider_id } => {
                    self.call("models:list", vec![provider_id], move |me, r| me.with(|b| b.models_listed(req, r)));
                }
                Effect::SendChat { req, opts } => {
                    self.call("chat:send", vec![opts], move |me, r| me.with(|b| b.sent(req, r)));
                }
                Effect::Approve { session_id, call_id, approved } => {
                    self.call("tool:approve", vec![json!(session_id), json!(call_id), json!(approved)], |_, _| {});
                }
                Effect::Answer { session_id, call_id, answers } => {
                    self.call("chat:answer", vec![json!(session_id), call_id, answers], |_, _| {});
                }
            }
        }
        self.check_poll();
    }

    /// A channel through the router, its answer handed back to the bridge.
    fn call(
        self: &Arc<Self>,
        channel: &'static str,
        args: Vec<Value>,
        done: impl FnOnce(&Arc<Self>, Result<Value, String>) + Send + 'static,
    ) {
        let Some(dispatch) = self.dispatch.get().cloned() else {
            done(self, Err("the daemon is still starting".into()));
            return;
        };
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            let r = dispatch(channel.to_string(), args).await;
            if let Some(me) = weak.upgrade() {
                done(&me, r);
            }
        });
    }

    fn start_poll(self: &Arc<Self>, call: TgCall) {
        let mut inner = self.lock();
        let Some(serial) = inner.bridge.client_serial() else {
            drop(inner);
            self.with(|b| b.poll_aborted());
            return;
        };
        let (weak, http) = (Arc::downgrade(self), self.http.clone());
        let task = tokio::spawn(async move {
            // Switched off in Settings > Connections: ask again every half minute, not every 5 s.
            if !nekko_net::allowed("telegram") {
                tokio::time::sleep(BLOCKED_POLL).await;
            }
            let result = post(&http, &call, POLL_TIMEOUT).await;
            let Some(me) = weak.upgrade() else { return };
            {
                let mut inner = me.lock();
                // Dropped meanwhile: a newer poll owns the loop.
                if inner.poll.as_ref().is_none_or(|p| p.serial != serial) {
                    return;
                }
                inner.poll = None;
            }
            let host = &me.host;
            let fx = me.lock().bridge.poll_done(result, host);
            me.run(fx);
        });
        if let Some(old) = inner.poll.replace(Poll { serial, task: task.abort_handle() }) {
            old.task.abort();
        }
    }

    /// Drop the poll in flight once its client is gone (stopped, or a new token).
    fn check_poll(self: &Arc<Self>) {
        let stale = {
            let mut inner = self.lock();
            let live = inner.bridge.client_serial();
            match &inner.poll {
                Some(p) if Some(p.serial) != live => inner.poll.take(),
                _ => None,
            }
        };
        if let Some(p) = stale {
            p.task.abort();
            self.with(|b| b.poll_aborted());
        }
    }

    /// Bot API calls, one at a time in the order the bridge made them.
    async fn tg_lane(me: std::sync::Weak<Self>, mut rx: mpsc::UnboundedReceiver<TgCall>) {
        while let Some(call) = rx.recv().await {
            let Some(http) = me.upgrade().map(|m| m.http.clone()) else { break };
            let result = post(&http, &call, CALL_TIMEOUT).await;
            let Some(m) = me.upgrade() else { break };
            m.with(|b| b.tg_done(call.id, result));
        }
    }

    /// `messaging-state.json`, written in order, each write atomic.
    async fn save_lane(path: PathBuf, mut rx: mpsc::UnboundedReceiver<Value>) {
        while let Some(mut s) = rx.recv().await {
            // Only the newest of a burst matters.
            while let Ok(next) = rx.try_recv() {
                s = next;
            }
            let p = path.clone();
            let written = tokio::task::spawn_blocking(move || nekko_settings::write_json_atomic(&p, &s)).await;
            if let Ok(Err(e)) = written {
                eprintln!("nekkod: messaging state not saved: {e}");
            }
        }
    }
}

/// `POST` a Bot API call and read the reply as the TS client does. The URL
/// holds the bot token, so it is never logged.
async fn post(http: &reqwest::Client, call: &TgCall, timeout: Duration) -> Result<Value, String> {
    let rb = http.post(&call.url).header("content-type", "application/json").body(call.body.clone()).timeout(timeout);
    let res = nekko_net::send("telegram", rb).await.map_err(|e| match e {
        nekko_net::Error::Blocked(m) => m,
        // Node's fetch says this for every network failure.
        nekko_net::Error::Http(_) => "fetch failed".to_string(),
    })?;
    let status = res.status().as_u16();
    let body = res.bytes().await.map_err(|_| "terminated".to_string())?;
    telegram::reply(&call.method, status, &body)
}

/// The payload of an `agent:event` frame the UI is shown (not a `relayOnly` copy).
fn agent_event(text: &str) -> Option<Value> {
    if !text.starts_with(r#"{"channel":"agent:event""#) {
        return None;
    }
    let mut v: Value = serde_json::from_str(text).ok()?;
    let payload = v.get_mut("payload").map(Value::take)?;
    (payload.get("relayOnly") != Some(&Value::Bool(true))).then_some(payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hears_only_agent_events_the_ui_is_shown() {
        let e = agent_event(r#"{"channel":"agent:event","payload":{"type":"text","sessionId":"s","delta":"x"}}"#);
        assert_eq!(e.unwrap()["delta"], "x");
        assert!(agent_event(r#"{"channel":"agent:event","payload":{"type":"text","relayOnly":true}}"#).is_none());
        assert!(agent_event(r#"{"channel":"tasks:updated","payload":[]}"#).is_none());
    }
}
