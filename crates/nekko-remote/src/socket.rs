//! The relay agent's connection: dial out to the relay, answer sealed
//! requests through a dispatcher, forward host events, and redial two seconds
//! after any drop until stopped (`connectRelayAgent`).
//!
//! Every frame goes out through one queue in the order it was produced, so a
//! phone never sees a later token overtake an earlier one.

use crate::agent::{AgentCore, Out};
use crate::e2e;
use crate::service::{LinkHandle, Verifier};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

/// Runs a host channel: the daemon's router, as the desktop and the local
/// bridges call it. A phone's calls reach it only through `phone::gate`.
pub type Dispatcher =
    Arc<dyn Fn(String, Value) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send>> + Send + Sync>;

/// Who is calling, for a welcomed phone's request: the device the HELLO
/// welcomed on that connection, and the request's signed Change proof
/// (`proof: { ts, sig }` beside `args`), when it sent one (IO-33), and its
/// step-up (`stepUp`, a FIDO2 assertion or `{ totp }`, SK-2).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct PhoneCall {
    pub device_id: String,
    pub proof: Option<Value>,
    pub step_up: Option<Value>,
}

/// Runs a welcomed phone's request (`phone::gate` over a `Dispatcher`).
pub type PhoneDispatcher =
    Arc<dyn Fn(PhoneCall, String, Value) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send>> + Send + Sync>;

/// Host events to forward: `(channel, payload)`.
pub type Events = mpsc::UnboundedReceiver<(String, Value)>;

const REDIAL: Duration = Duration::from_secs(2);
/// How often waiting terminal output is checked against its pacing window.
const TICK: Duration = Duration::from_millis(25);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

struct Shared {
    /// Set once the key is derived (100,000 PBKDF2 rounds, off the async threads).
    core: Mutex<Option<AgentCore>>,
    /// The open socket's outbound queue, when there is one.
    out: Mutex<Option<mpsc::UnboundedSender<String>>>,
    online: AtomicBool,
    last_error: Mutex<Option<String>>,
}

impl Shared {
    /// Send frames in order: produced and queued under the core's lock.
    fn send_all(&self, frames: Vec<String>) {
        if let Some(tx) = lock(&self.out).as_ref() {
            for f in frames {
                let _ = tx.send(f);
            }
        }
    }
}

/// A running agent; dropping it does not stop it, `stop` does.
pub struct RelayAgent {
    shared: Arc<Shared>,
    stop: watch::Sender<bool>,
}

/// The agent's URL: `<relay>/relay?role=agent&room=..&key=..[&access=..]`.
pub fn agent_url(relay_url: &str, room: &str, key: &str, access: Option<&str>) -> String {
    let base = relay_url.strip_suffix('/').unwrap_or(relay_url);
    let mut url =
        format!("{base}/relay?role=agent&room={}&key={}", encode_uri_component(room), encode_uri_component(key));
    if let Some(a) = access {
        url.push_str(&format!("&access={}", encode_uri_component(a)));
    }
    url
}

/// `encodeURIComponent`.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub struct Spawn {
    pub url: String,
    /// The pairing secret and room the E2E key is derived from.
    pub secret: String,
    pub room: String,
    pub verify: Verifier,
    pub dispatch: PhoneDispatcher,
    pub events: Events,
    /// Phones attached to terminals, shared with the gate (`phone::gate_shared`):
    /// terminal output goes only to them, and a disconnect detaches them.
    pub terminals: Arc<crate::phone_terminal::PhoneTerminals>,
}

impl RelayAgent {
    pub fn spawn(rt: &tokio::runtime::Handle, spec: Spawn) -> RelayAgent {
        let shared = Arc::new(Shared {
            core: Mutex::new(None),
            out: Mutex::new(None),
            online: AtomicBool::new(false),
            last_error: Mutex::new(None),
        });
        let (stop, stopped) = watch::channel(false);
        rt.spawn(run(shared.clone(), spec, stopped));
        RelayAgent { shared, stop }
    }
}

impl LinkHandle for RelayAgent {
    fn stop(&self) {
        let _ = self.stop.send(true);
    }

    fn kick_device(&self, device_id: &str) {
        let core = &mut lock(&self.shared.core);
        if let Some(core) = core.as_mut() {
            let frames = core.kick_device(device_id);
            self.shared.send_all(frames);
        }
    }

    fn disconnect_device(&self, device_id: &str) {
        let core = &mut lock(&self.shared.core);
        if let Some(core) = core.as_mut() {
            let frames = core.disconnect_device(device_id);
            self.shared.send_all(frames);
        }
    }

    fn connected_devices(&self) -> Vec<String> {
        lock(&self.shared.core).as_ref().map(AgentCore::connected_devices).unwrap_or_default()
    }

    fn is_online(&self) -> bool {
        self.shared.online.load(Ordering::SeqCst)
    }

    fn last_error(&self) -> Option<String> {
        lock(&self.shared.last_error).clone()
    }
}

async fn run(shared: Arc<Shared>, spec: Spawn, mut stopped: watch::Receiver<bool>) {
    let Spawn { url, secret, room, verify, dispatch, mut events, terminals } = spec;
    let derive = tokio::task::spawn_blocking(move || e2e::derive_key(&secret, &room));
    let key = tokio::select! {
        k = derive => match k { Ok(k) => k, Err(_) => return },
        _ = stopped.changed() => return,
    };
    let iv: crate::agent::IvSource = Box::new(e2e::random_iv);
    *lock(&shared.core) = Some(AgentCore::new(key, iv).with_terminals(terminals));
    loop {
        if *stopped.borrow() {
            return;
        }
        let connect = tokio::select! {
            r = tokio_tungstenite::connect_async(url.as_str()) => r,
            _ = stopped.changed() => return,
        };
        let (code, reason) = match connect {
            Ok((ws, _)) => serve(&shared, ws, &verify, &dispatch, &mut events, &mut stopped).await,
            // A browser WebSocket that cannot connect closes with 1006 and no reason.
            Err(_) => (1006, String::new()),
        };
        shared.online.store(false, Ordering::SeqCst);
        *lock(&shared.out) = None;
        if let Some(core) = lock(&shared.core).as_mut() {
            core.reset();
        }
        *lock(&shared.last_error) =
            Some(if reason.is_empty() { format!("relay disconnected (code {code})") } else { reason });
        if *stopped.borrow() {
            return;
        }
        // Wait out the redial, dropping events: nobody is connected to hear them.
        let wait = tokio::time::sleep(REDIAL);
        tokio::pin!(wait);
        loop {
            tokio::select! {
                _ = &mut wait => break,
                _ = stopped.changed() => return,
                e = events.recv() => if e.is_none() { return },
            }
        }
    }
}

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// One connection, until it closes or the agent stops: the close code and reason.
async fn serve(
    shared: &Arc<Shared>,
    ws: Ws,
    verify: &Verifier,
    dispatch: &PhoneDispatcher,
    events: &mut Events,
    stopped: &mut watch::Receiver<bool>,
) -> (u16, String) {
    let (mut sink, mut stream) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    *lock(&shared.out) = Some(tx);
    shared.online.store(true, Ordering::SeqCst);
    *lock(&shared.last_error) = None;
    let writer = tokio::spawn(async move {
        while let Some(text) = rx.recv().await {
            if sink.send(Message::text(text)).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });
    // Paced terminal output to phones waits for its window (phone_terminal::Coalescer).
    let mut tick = tokio::time::interval(TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let result = loop {
        tokio::select! {
            msg = stream.next() => match msg {
                Some(Ok(Message::Text(text))) => on_text(shared, text.as_str(), verify, dispatch),
                Some(Ok(Message::Binary(b))) => on_text(shared, &String::from_utf8_lossy(&b), verify, dispatch),
                Some(Ok(Message::Close(frame))) => {
                    break frame.map_or((1005, String::new()), |f| (u16::from(f.code), f.reason.to_string()));
                }
                Some(Ok(_)) => {}
                Some(Err(_)) | None => break (1006, String::new()),
            },
            e = events.recv() => match e {
                Some((channel, payload)) => {
                    if let Some(core) = lock(&shared.core).as_mut() {
                        let frames = core.on_event(&channel, &payload);
                        shared.send_all(frames);
                    }
                }
                None => break (1000, String::new()),
            },
            _ = tick.tick() => {
                if let Some(core) = lock(&shared.core).as_mut() {
                    let frames = core.tick();
                    shared.send_all(frames);
                }
            }
            _ = stopped.changed() => break (u16::from(CloseCode::Normal), String::new()),
        }
    };
    // Dropping the queue lets the writer flush what is queued and close.
    *lock(&shared.out) = None;
    let _ = tokio::time::timeout(Duration::from_secs(2), writer).await;
    result
}

fn on_text(shared: &Arc<Shared>, text: &str, verify: &Verifier, dispatch: &PhoneDispatcher) {
    let mut guard = lock(&shared.core);
    let Some(core) = guard.as_mut() else { return };
    for out in core.on_relay(text, verify.as_ref()) {
        match out {
            Out::Send(f) => shared.send_all(vec![f]),
            Out::Dispatch { cid, id, device_id, channel, args, proof, step_up } => {
                let (shared, dispatch) = (shared.clone(), dispatch.clone());
                tokio::spawn(async move {
                    let result = dispatch(PhoneCall { device_id, proof, step_up }, channel, args).await;
                    if let Some(core) = lock(&shared.core).as_mut() {
                        let frame = core.reply(&cid, id, result);
                        shared.send_all(vec![frame]);
                    }
                });
            }
        }
    }
}
