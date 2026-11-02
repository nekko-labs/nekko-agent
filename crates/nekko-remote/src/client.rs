//! The device side of relay v2, for a desktop connected to another computer:
//! a port of the iPhone's `RelayClient`, with its timings and close rules.
//! The agent in this crate is the other end. One link per computer, always on.
//!
//! The first welcome enrolls the device with the pairing code, then registers
//! its key as the Change key. Every HELLO and every guarded call is signed with
//! that key, so a stolen transcript of frames is good for nothing.

use crate::e2e::{self, Key};
use crate::hello;
use crate::phone::policy;
use crate::socket::encode_uri_component;
use futures_util::{SinkExt, StreamExt};
pub use p256::ecdsa::SigningKey;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::tungstenite::Message;

const HANDSHAKE: Duration = Duration::from_secs(15);
const REQUEST: Duration = Duration::from_secs(120);
const RETRY_BASE: Duration = Duration::from_secs(1);
const RETRY_MAX: Duration = Duration::from_secs(30);
const OFFLINE_POLL: Duration = Duration::from_secs(15);
/// A private address on another network doesn't refuse, it hangs.
const OPEN_TIMEOUT: Duration = Duration::from_secs(5);
const PING: Duration = Duration::from_secs(30);

/// How a link reaches one computer. Holds the room secret and the private key,
/// so it is kept in memory and in the OS key store only.
#[derive(Clone)]
pub struct Config {
    /// Every address of the relay, best first.
    pub routes: Vec<String>,
    pub room: String,
    pub secret: String,
    pub device_id: String,
    /// What the other computer calls this one.
    pub name: String,
    pub key: SigningKey,
    /// The one-time code, on the first connection only.
    pub pair_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum State {
    Connecting,
    Online,
    /// The relay answered and the computer isn't there.
    Offline,
    /// Refused, with the computer's reason. Never retried.
    Denied(String),
    Stopped,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Status {
    pub state: State,
    /// The address in use.
    pub route: Option<String>,
    /// This device's record on the computer, from its welcome: `kind`, `access`.
    pub device: Value,
    /// The computer's protocol version, from its welcome.
    pub protocol: u64,
}

impl Status {
    fn new(state: State) -> Self {
        Self { state, route: None, device: Value::Null, protocol: 0 }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallError {
    pub message: String,
    /// The computer answered with this error: the request was taken and turned
    /// down, not lost on the way.
    pub from_computer: bool,
}

impl std::fmt::Display for CallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

fn lost(message: &str) -> CallError {
    CallError { message: message.to_string(), from_computer: false }
}

/// The socket's handshake. Requests carry `challenge` and the next `seq`.
#[derive(Default)]
struct Conn {
    out: Option<mpsc::UnboundedSender<String>>,
    welcomed: bool,
    challenge: Option<String>,
    seq: u64,
}

type Waiters = HashMap<u64, oneshot::Sender<Result<Value, CallError>>>;

struct Shared {
    cfg: Config,
    status: watch::Sender<Status>,
    conn: Mutex<Conn>,
    pending: Mutex<Waiters>,
    pair: Mutex<Option<String>>,
    next_id: AtomicU64,
    stopped: AtomicBool,
    events: mpsc::UnboundedSender<(String, Value)>,
    e2e: Mutex<Option<Key>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// A live link. Dropping it does not stop it: call [`Client::stop`].
#[derive(Clone)]
pub struct Client {
    shared: Arc<Shared>,
    stop: Arc<watch::Sender<bool>>,
}

impl Client {
    /// Start connecting. The computer's events arrive on `events`.
    pub fn start(cfg: Config, events: mpsc::UnboundedSender<(String, Value)>) -> Self {
        let pair = cfg.pair_code.clone();
        let (status, _) = watch::channel(Status::new(State::Connecting));
        let shared = Arc::new(Shared {
            cfg,
            status,
            conn: Mutex::default(),
            pending: Mutex::default(),
            pair: Mutex::new(pair),
            next_id: AtomicU64::new(1),
            stopped: AtomicBool::new(false),
            events,
            e2e: Mutex::new(None),
        });
        let (stop, stopped) = watch::channel(false);
        tokio::spawn(run(shared.clone(), stopped));
        Self { shared, stop: Arc::new(stop) }
    }

    pub fn status(&self) -> Status {
        self.shared.status.borrow().clone()
    }

    /// Every status change, for a caller that follows them.
    pub fn watch(&self) -> watch::Receiver<Status> {
        self.shared.status.subscribe()
    }

    pub fn stop(&self) {
        self.shared.stopped.store(true, Ordering::SeqCst);
        let _ = self.stop.send(true);
    }

    /// Call a channel on the computer, as a phone would, waiting briefly for the handshake.
    pub async fn call(&self, channel: &str, args: Value) -> Result<Value, CallError> {
        self.call_for(channel, args, REQUEST).await
    }

    /// `call` with its own limit: `chat:send` answers only when the whole turn is over.
    pub async fn call_for(&self, channel: &str, args: Value, limit: Duration) -> Result<Value, CallError> {
        self.ready().await?;
        let id = self.shared.next_id.fetch_add(1, Ordering::SeqCst);
        let mut frame = json!({ "type": "req", "id": id, "channel": channel, "args": args });
        if let Some(proof) = self.shared.proof_for(channel, &frame["args"])
            && let Some(o) = frame.as_object_mut()
        {
            o.insert("proof".into(), proof);
        }
        let (tx, rx) = oneshot::channel();
        lock(&self.shared.pending).insert(id, tx);
        if !self.shared.send_request(frame) {
            lock(&self.shared.pending).remove(&id);
            return Err(lost("Could not reach that computer."));
        }
        let out = tokio::time::timeout(limit, rx).await;
        lock(&self.shared.pending).remove(&id);
        match out {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(lost("Connection lost.")),
            Err(_) => Err(lost(&format!("{channel}: timed out"))),
        }
    }

    async fn ready(&self) -> Result<(), CallError> {
        let mut rx = self.watch();
        let settled = rx.wait_for(|s| !matches!(s.state, State::Connecting | State::Offline));
        let state = match tokio::time::timeout(HANDSHAKE, settled).await {
            Ok(Ok(s)) => s.state.clone(),
            _ => self.status().state,
        };
        match state {
            State::Online => Ok(()),
            State::Denied(_) => Err(lost("This computer is no longer paired.")),
            State::Offline => Err(lost("That computer is offline.")),
            _ => Err(lost("Could not reach that computer.")),
        }
    }
}

impl Shared {
    fn key(&self) -> Option<Key> {
        lock(&self.e2e).clone()
    }

    fn set_state(&self, state: State, route: Option<&str>) {
        self.status.send_modify(|s| {
            s.state = state;
            if route.is_some() {
                s.route = route.map(str::to_string);
            }
        });
    }

    fn fail_pending(&self, message: &str) {
        let waiting: Vec<_> = lock(&self.pending).drain().collect();
        for (_, tx) in waiting {
            let _ = tx.send(Err(lost(message)));
        }
    }

    /// Number a request and send it, under the lock so seqs leave in order.
    fn send_request(&self, mut frame: Value) -> bool {
        let Some(key) = self.key() else { return false };
        let mut conn = lock(&self.conn);
        if !conn.welcomed {
            return false;
        }
        conn.seq += 1;
        if let Some(o) = frame.as_object_mut() {
            o.insert("seq".into(), json!(conn.seq));
            o.insert("challenge".into(), json!(conn.challenge));
        }
        let sealed = json!({ "enc": e2e::seal_with_iv(&key, &frame, e2e::random_iv()) }).to_string();
        conn.out.as_ref().is_some_and(|out| out.send(sealed).is_ok())
    }

    fn send_sealed(&self, frame: &Value) {
        let Some(key) = self.key() else { return };
        let sealed = json!({ "enc": e2e::seal_with_iv(&key, frame, e2e::random_iv()) }).to_string();
        if let Some(out) = &lock(&self.conn).out {
            let _ = out.send(sealed);
        }
    }

    /// The signed Change proof a guarded channel needs, beside its arguments.
    fn proof_for(&self, channel: &str, args: &Value) -> Option<Value> {
        let p = policy();
        let guarded = p.change_channels.iter().chain(&p.mode_channels).any(|c| c == channel);
        if !guarded && channel != p.key_channel {
            return None;
        }
        let ts = crate::service::system_clock()() as i64;
        let text = crate::proof::payload(&self.cfg.device_id, channel, args, ts)?;
        Some(json!({ "ts": ts, "sig": crate::proof::sign(&self.cfg.key, &text) }))
    }

    /// Answer a challenge with a HELLO signed for this room and this nonce only.
    fn hello(&self, nonce: &str) {
        {
            let mut conn = lock(&self.conn);
            conn.welcomed = false;
            conn.seq = 0;
            conn.challenge = Some(nonce.to_string());
        }
        let cfg = &self.cfg;
        let text = hello::hello_text(&cfg.device_id, &cfg.room, nonce);
        let mut frame = json!({
            "type": "hello",
            "deviceId": cfg.device_id,
            "name": cfg.name,
            "platform": hello::COMPUTER_PLATFORM,
            "protocol": hello::PROTOCOL_VERSION,
            "challenge": nonce,
            "helloKey": crate::proof::public_key(&cfg.key),
            "sig": crate::proof::sign(&cfg.key, &text),
        });
        if let (Some(code), Some(o)) = (lock(&self.pair).clone(), frame.as_object_mut()) {
            o.insert("pair".into(), json!(code));
        }
        self.send_sealed(&frame);
    }

    /// One decrypted frame. `Some` ends the socket.
    fn on_frame(self: &Arc<Self>, frame: &Value, route: &str) -> Option<End> {
        match frame.get("type").and_then(Value::as_str) {
            Some("challenge") => {
                let nonce = frame.get("challenge").and_then(Value::as_str).filter(|n| !n.is_empty())?;
                // While online it means the computer reset the handshake; calls in
                // flight stay pending, since their replies may still arrive.
                if self.status.borrow().state == State::Online {
                    self.set_state(State::Connecting, None);
                }
                self.hello(nonce);
            }
            Some("welcome") => {
                lock(&self.conn).welcomed = true;
                *lock(&self.pair) = None;
                let device = frame.get("device").cloned().unwrap_or(Value::Null);
                let protocol = frame.get("protocol").and_then(Value::as_u64).unwrap_or(0);
                let register = device.get("changeKey").is_none();
                self.status.send_modify(|s| {
                    s.state = State::Online;
                    s.route = Some(route.to_string());
                    s.device = device;
                    s.protocol = protocol;
                });
                if register {
                    self.register_key();
                }
            }
            Some("denied") => {
                let reason = frame.get("reason").and_then(Value::as_str).unwrap_or("invalid");
                return Some(End::Denied(reason.to_string()));
            }
            Some("res") => {
                let id = frame.get("id").and_then(Value::as_u64)?;
                let tx = lock(&self.pending).remove(&id)?;
                let result = match frame.get("error").filter(|e| !e.is_null()) {
                    Some(e) => Err(CallError {
                        message: e.as_str().map_or_else(|| e.to_string(), str::to_string),
                        from_computer: true,
                    }),
                    None => Ok(frame.get("result").cloned().unwrap_or(Value::Null)),
                };
                let _ = tx.send(result);
            }
            Some("event") => {
                let channel = frame.get("channel").and_then(Value::as_str)?;
                let payload = frame.get("payload").cloned().unwrap_or(Value::Null);
                let _ = self.events.send((channel.to_string(), payload));
            }
            _ => {}
        }
        None
    }

    /// Trust on first use: the key this device enrolled with also signs its changes.
    fn register_key(self: &Arc<Self>) {
        let client = Client { shared: self.clone(), stop: Arc::new(watch::channel(false).0) };
        let key = crate::proof::public_key(&self.cfg.key);
        tokio::spawn(async move {
            if let Err(e) = client.call(&policy().key_channel, json!([key])).await {
                eprintln!("nekkod: a connected computer refused this device's key: {e}");
            }
        });
    }
}

/// How one socket ended.
enum End {
    Stopped,
    Denied(String),
    /// It never opened, or dropped before a welcome.
    Failed,
    /// The computer isn't there, and the relay said so.
    Offline,
    /// It was working and dropped: start again from the best route.
    Lost,
}

/// `<relay>/relay?role=client&room=…&key=…`, `key` being the room credential.
pub fn client_url(relay_url: &str, room: &str, secret: &str) -> String {
    let base = relay_url.trim_end_matches('/');
    let key = e2e::relay_auth(secret, room);
    format!("{base}/relay?role=client&room={}&key={}", encode_uri_component(room), encode_uri_component(&key))
}

/// `shortcut: stays on a fallback route until the socket drops; the iPhone also
/// probes the better route and moves back, worth porting if a desktop sits on
/// the relay for days while its LAN route is fine.`
async fn run(shared: Arc<Shared>, stopped: watch::Receiver<bool>) {
    let (secret, room) = (shared.cfg.secret.clone(), shared.cfg.room.clone());
    let Ok(key) = tokio::task::spawn_blocking(move || e2e::derive_key(&secret, &room)).await else { return };
    *lock(&shared.e2e) = Some(key);
    let routes = shared.cfg.routes.clone();
    let (mut at, mut retry) = (0usize, 0u32);
    while !routes.is_empty() {
        let route = &routes[at % routes.len()];
        let end = session(&shared, route, routes.len() > 1, stopped.clone()).await;
        *lock(&shared.conn) = Conn::default();
        let wait = match end {
            End::Stopped => break,
            End::Denied(reason) => {
                shared.fail_pending("This computer is no longer paired.");
                shared.set_state(State::Denied(reason), None);
                return;
            }
            End::Offline => {
                shared.fail_pending("That computer is offline.");
                shared.set_state(State::Offline, Some(route));
                OFFLINE_POLL
            }
            End::Lost => {
                shared.fail_pending("Connection lost.");
                shared.set_state(State::Connecting, None);
                (at, retry) = (0, 0);
                RETRY_BASE
            }
            End::Failed => {
                shared.fail_pending("Could not reach that computer.");
                shared.set_state(State::Connecting, None);
                at += 1;
                if at % routes.len() == 0 {
                    retry = (retry + 1).min(8);
                    RETRY_MAX.min(RETRY_BASE * 2u32.pow(retry))
                } else {
                    Duration::ZERO
                }
            }
        };
        let mut gone = stopped.clone();
        tokio::select! {
            _ = tokio::time::sleep(wait) => {}
            _ = until_stopped(&mut gone) => break,
        }
    }
    shared.fail_pending("Not connected.");
    shared.set_state(State::Stopped, None);
}

async fn until_stopped(stopped: &mut watch::Receiver<bool>) {
    let _ = stopped.wait_for(|s| *s).await;
}

/// One socket, from dial to close.
async fn session(shared: &Arc<Shared>, route: &str, more: bool, mut stopped: watch::Receiver<bool>) -> End {
    const ID: &str = "connected-computers";
    let host = crate::route::relay_host(route);
    if !nekko_net::allowed_to(ID, Some(&host)) {
        return End::Offline;
    }
    let url = client_url(route, &shared.cfg.room, &shared.cfg.secret);
    let open = if more && crate::route::relay_route(route) != crate::route::Route::Internet { OPEN_TIMEOUT } else { HANDSHAKE };
    let dial = tokio::time::timeout(open, tokio_tungstenite::connect_async(url.as_str()));
    let ws = tokio::select! {
        r = dial => r,
        _ = until_stopped(&mut stopped) => return End::Stopped,
    };
    let Ok(Ok((ws, _))) = ws else { return End::Failed };
    nekko_net::record(ID, nekko_net::Event::new("connect").host(&host));
    let (mut sink, mut stream) = ws.split();
    let (out, mut outgoing) = mpsc::unbounded_channel();
    lock(&shared.conn).out = Some(out);

    let mut ping = tokio::time::interval(PING);
    ping.tick().await;
    // Missed pongs: no frame of any kind for two pings means the path is dead.
    let mut seen = tokio::time::Instant::now();
    let handshake = tokio::time::sleep(HANDSHAKE);
    tokio::pin!(handshake);
    let mut away = false;
    loop {
        let welcomed = lock(&shared.conn).welcomed;
        tokio::select! {
            _ = until_stopped(&mut stopped) => {
                let _ = sink.send(Message::Close(None)).await;
                return End::Stopped;
            }
            _ = &mut handshake, if !welcomed && !away => return End::Failed,
            _ = ping.tick() => {
                if !nekko_net::allowed_to(ID, Some(&host)) {
                    let _ = sink.send(Message::Close(None)).await;
                    return End::Offline;
                }
                if seen.elapsed() > PING * 2 + PING / 2 {
                    return if welcomed { End::Lost } else { End::Failed };
                }
                if sink.send(Message::Ping(Vec::new().into())).await.is_err() {
                    return if welcomed { End::Lost } else { End::Failed };
                }
            }
            Some(text) = outgoing.recv() => {
                if sink.send(Message::text(text)).await.is_err() {
                    return if welcomed { End::Lost } else { End::Failed };
                }
            }
            msg = stream.next() => {
                seen = tokio::time::Instant::now();
                match msg {
                    Some(Ok(Message::Text(text))) => match on_raw(shared, text.as_str(), route, &mut away) {
                        Some(end) => return end,
                        None => {
                            if away {
                                shared.set_state(State::Offline, Some(route));
                            }
                        }
                    },
                    Some(Ok(Message::Close(frame))) => {
                        let (code, reason) = frame.map_or((1006, String::new()), |f| (f.code.into(), f.reason.to_string()));
                        return on_close(code, &reason, welcomed);
                    }
                    Some(Ok(_)) => {}
                    Some(Err(_)) | None => return if welcomed { End::Lost } else { End::Failed },
                }
            }
        }
    }
}

fn on_raw(shared: &Arc<Shared>, raw: &str, route: &str, away: &mut bool) -> Option<End> {
    let env: Value = serde_json::from_str(raw).ok()?;
    if let Some(enc) = env.get("enc").and_then(Value::as_str) {
        // Wrong key or tampered: dropped silently, as the agent does.
        let frame = e2e::open(&shared.key()?, enc)?;
        *away = false;
        return shared.on_frame(&frame, route);
    }
    match env.get("type").and_then(Value::as_str) {
        Some("agent-offline") => {
            let mut conn = lock(&shared.conn);
            (conn.welcomed, conn.challenge, conn.seq) = (false, None, 0);
            *away = true;
        }
        Some("agent-online") => {
            *away = false;
            shared.set_state(State::Connecting, None);
        }
        _ => {}
    }
    None
}

/// The relay's close rules: 4001 this device was removed, 1008 "bad pairing key"
/// the same, 1008 "agent offline" poll until the computer is back.
fn on_close(code: u16, reason: &str, welcomed: bool) -> End {
    let r = reason.to_lowercase();
    if code == 4001 {
        End::Denied("kicked".into())
    } else if code == 1008 && r.contains("bad pairing key") {
        End::Denied("bad-key".into())
    } else if code == 1008 && r.contains("agent offline") {
        End::Offline
    } else if welcomed {
        End::Lost
    } else {
        End::Failed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn close_codes_follow_the_phones_rules() {
        assert!(matches!(on_close(4001, "", true), End::Denied(r) if r == "kicked"));
        assert!(matches!(on_close(1008, "Bad pairing key", false), End::Denied(r) if r == "bad-key"));
        assert!(matches!(on_close(1008, "agent offline", false), End::Offline));
        assert!(matches!(on_close(1006, "", true), End::Lost));
        assert!(matches!(on_close(1006, "", false), End::Failed));
    }

    #[test]
    fn dials_with_the_room_credential_never_the_secret() {
        let url = client_url("wss://relay.example/", "room1", "s3cret-s3cret");
        assert!(url.starts_with("wss://relay.example/relay?role=client&room=room1&key="));
        assert!(!url.contains("s3cret"));
    }
}
