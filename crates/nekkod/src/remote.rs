//! Phone remote access owned by the daemon (PF14): `remote:*`, `remote.json`
//! and the relay agent (`nekko-remote`).
//!
//! The agent answers a paired phone's requests through the daemon's own
//! router, so a phone reaches the same Rust services as the UI. It forwards
//! daemon hub events and reads the complete `chat:pending` map for attention
//! reconciliation, independently of the phone's clipped Live Activity card.

use crate::hub::Hub;
use nekko_remote::{
    Dispatcher, Link, LinkHandle, PhoneDispatcher, PhoneTerminals, RELAYED_EVENTS, RelayAgent, RemoteService, Spawn,
    Verifier,
};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

pub use nekko_remote::CHANNELS;

pub struct Remote {
    svc: Arc<RemoteService>,
    dispatch: Arc<OnceLock<PhoneDispatcher>>,
    /// The router itself, for the chat list the phone's Live Activity card shows.
    router: Arc<OnceLock<Dispatcher>>,
    /// Phones attached to terminals (FA-3), shared by the gate and the relay agent.
    terminals: Arc<PhoneTerminals>,
    /// `security.json` beside `remote.json`: step-up on guarded phone calls
    /// (SK-2), the same store Settings → Security writes (SK-4).
    security: Arc<dyn nekko_remote::step_up::SecurityStore>,
    /// Where a safety exit is announced, for the desktop's notification (SK-4).
    hub: Hub,
}

/// The hub event a phone's safety exit (`device:signOut`, `remote:stop`,
/// `app:quit`) sends once the computer has done it: `{ channel, deviceId,
/// name, at }`. The desktop's main process turns it into a notification.
pub const SAFETY_EXIT_EVENT: &str = "remote:safetyExit";

impl Remote {
    pub fn new(dir: PathBuf, hub: Hub) -> Self {
        let dispatch: Arc<OnceLock<PhoneDispatcher>> = Arc::default();
        let router: Arc<OnceLock<Dispatcher>> = Arc::default();
        let terminals = PhoneTerminals::new();
        let security: Arc<dyn nekko_remote::step_up::SecurityStore> =
            Arc::new(nekko_remote::step_up::SecurityFile::in_dir(&dir));
        let events = hub.clone();
        let link = HubLink {
            rt: tokio::runtime::Handle::current(),
            hub,
            dispatch: dispatch.clone(),
            router: router.clone(),
            terminals: terminals.clone(),
        };
        let svc =
            RemoteService::new(&dir, nekko_remote::hello::os_random(), nekko_remote::system_clock(), Box::new(link));
        Self { svc, dispatch, router, terminals, security, hub: events }
    }

    /// `security.json`'s store, shared with Settings → Security (security.rs).
    pub fn security_store(&self) -> Arc<dyn nekko_remote::step_up::SecurityStore> {
        self.security.clone()
    }

    /// How a phone's request runs: through the router, limited to what the
    /// phone access policy allows (`nekko_remote::phone`), with secrets
    /// stripped from what it returns. The gate reads the calling device's
    /// switches, Change key and activity from the registry (IO-33), and
    /// shares terminal attachments with the relay agent (FA-3).
    pub fn set_dispatcher(&self, run: Dispatcher) {
        let _ = self.router.set(run.clone());
        let classes = nekko_remote::phone::Classes::from_policy();
        let gate = nekko_remote::phone::gate_secured(
            run,
            self.svc.clone(),
            classes,
            self.terminals.clone(),
            Some(self.security.clone()),
        );
        let _ = self.dispatch.set(announce_safety_exits(gate, self.svc.clone(), self.hub.clone()));
    }

    /// Reconnect when remote access was left on.
    pub fn start(&self) {
        let svc = self.svc.clone();
        // Reads remote.json: off the async threads.
        tokio::task::spawn_blocking(move || svc.start_if_enabled());
    }

    pub fn stop(&self) {
        self.svc.stop();
    }

    pub async fn route(&self, channel: &str, args: &[Value]) -> Result<Value, String> {
        let svc = self.svc.clone();
        let (channel, args) = (channel.to_string(), args.to_vec());
        tokio::task::spawn_blocking(move || svc.route(&channel, &args)).await.map_err(|e| e.to_string())?
    }
}

/// Connects the agent to a relay, with the hub's events and the router.
struct HubLink {
    rt: tokio::runtime::Handle,
    hub: Hub,
    dispatch: Arc<OnceLock<PhoneDispatcher>>,
    router: Arc<OnceLock<Dispatcher>>,
    terminals: Arc<PhoneTerminals>,
}

impl Link for HubLink {
    fn connect(
        &self,
        relay_url: &str,
        room: &str,
        key: &str,
        host_key: nekko_remote::client::SigningKey,
        verify: Verifier,
    ) -> Arc<dyn LinkHandle> {
        let (tx, events) = tokio::sync::mpsc::unbounded_channel();
        let mut rx = self.hub.subscribe();
        // Ends once the agent stops and drops its receiver.
        self.rt.spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(ev) => {
                        if let Some(e) = relayed(&ev.text)
                            && tx.send(e).is_err()
                        {
                            break;
                        }
                        if tx.is_closed() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        if tx.send((nekko_remote::ATTENTION_GAP.into(), Value::Null)).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        let dispatch_cell = self.dispatch.clone();
        let dispatch: PhoneDispatcher = Arc::new(move |who, channel, args| match dispatch_cell.get() {
            Some(run) => run(who, channel, args),
            None => Box::pin(std::future::ready(Err("the daemon is still starting".to_string()))),
        });
        let pending_router = self.router.clone();
        let pending: nekko_remote::Pending = Arc::new(move || match pending_router.get() {
            Some(run) => run("chat:pending".into(), Value::Array(Vec::new())),
            None => Box::pin(std::future::ready(Err("the daemon is still starting".to_string()))),
        });
        let router = self.router.clone();
        let summaries: nekko_remote::Summaries = Arc::new(move || match router.get() {
            Some(run) => run("sessions:summaries".into(), Value::Array(Vec::new())),
            None => Box::pin(std::future::ready(Err("the daemon is still starting".to_string()))),
        });
        Arc::new(RelayAgent::spawn(
            &self.rt,
            Spawn {
                // A Nekko Cloud machine presents its access token to the relay's enrolment gate (decision 0017).
                url: nekko_remote::agent_url(relay_url, room, key, std::env::var("NEKKO_RELAY_ACCESS").ok().as_deref()),
                secret: key.to_string(),
                room: room.to_string(),
                host_key,
                verify,
                dispatch,
                events,
                terminals: self.terminals.clone(),
                summaries: Some(summaries),
                pending: Some(pending),
            },
        ))
    }
}

/// The gate, announcing each safety exit it carried out on the hub
/// (`SAFETY_EXIT_EVENT`), with the phone's name as the registry has it.
fn announce_safety_exits(gate: PhoneDispatcher, svc: Arc<RemoteService>, hub: Hub) -> PhoneDispatcher {
    Arc::new(move |who, channel, args| {
        let (gate, svc, hub) = (gate.clone(), svc.clone(), hub.clone());
        Box::pin(async move {
            let exit = nekko_remote::phone::policy().safety_exits.contains(&channel);
            let device = who.device_id.clone();
            let out = gate(who, channel.clone(), args).await;
            if exit && out.is_ok() {
                hub.publish(SAFETY_EXIT_EVENT, safety_exit_payload(&*svc, &channel, &device), false);
            }
            out
        })
    })
}

fn safety_exit_payload(devices: &dyn nekko_remote::phone::Devices, channel: &str, device: &str) -> Value {
    serde_json::json!({
        "channel": channel,
        "deviceId": device,
        "name": devices.name(device),
        "at": nekko_remote::hello::nekko_num(devices.now()),
    })
}

/// A hub frame the agent forwards: one of the relayed channels, and not a
/// copy marked as already shown (`relayOnly`).
fn relayed(text: &str) -> Option<(String, Value)> {
    let channel = text.strip_prefix(r#"{"channel":""#)?.split('"').next()?;
    if !RELAYED_EVENTS.contains(&channel) {
        return None;
    }
    let mut v: Value = serde_json::from_str(text).ok()?;
    let payload = v.get_mut("payload").map(Value::take).unwrap_or(Value::Null);
    if payload.get("relayOnly") == Some(&Value::Bool(true)) {
        return None;
    }
    Some((channel.to_string(), payload))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_safety_exit_is_announced_with_the_phone_name() {
        let dir = tempfile::tempdir().unwrap();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let _guard = rt.enter();
        let hub = Hub::new();
        let remote = Remote::new(dir.path().to_path_buf(), hub.clone());
        let svc = remote.svc.clone();
        let payload = safety_exit_payload(&*svc, "remote:stop", "phone-1");
        assert_eq!(payload["channel"], "remote:stop");
        assert_eq!(payload["deviceId"], "phone-1");
        assert!(payload["name"].is_null(), "an unknown phone has no name");
        assert!(payload["at"].as_f64().unwrap() > 0.0);
    }

    #[tokio::test]
    async fn production_link_reads_the_complete_daemon_pending_map_and_recovers_hub_lag() {
        use futures_util::StreamExt;
        use serde_json::json;
        use std::time::Duration;
        let dir = tempfile::tempdir().unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let hub = Hub::new();
        let remote = Remote::new(dir.path().to_path_buf(), hub.clone());
        let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = calls.clone();
        let mut pending = serde_json::Map::new();
        for i in 0..20 {
            pending.insert(format!("chat-{i}"), json!({ "approval": {}, "question": {} }));
        }
        let pending = Value::Object(pending);
        remote.set_dispatcher(Arc::new(move |channel, args| {
            seen.lock().unwrap().push((channel.clone(), args));
            let pending = pending.clone();
            Box::pin(async move {
                assert_eq!(channel, "chat:pending", "attention must not borrow the card's summaries");
                Ok(pending)
            })
        }));
        remote.route("remote:enable", &[json!(format!("ws://{}", listener.local_addr().unwrap()))]).await.unwrap();
        let (tcp, _) = tokio::time::timeout(Duration::from_secs(10), listener.accept()).await.unwrap().unwrap();
        let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
        let mut frames = Vec::new();
        for _ in 0..2 {
            let text = tokio::time::timeout(Duration::from_secs(10), ws.next()).await.unwrap().unwrap().unwrap();
            frames.push(serde_json::from_str::<Value>(text.to_text().unwrap()).unwrap());
        }
        assert_eq!(frames[0]["type"], "attention-unknown");
        assert_eq!(frames[1]["type"], "attention-snapshot");
        let tags = frames[1]["tags"].as_array().unwrap();
        assert_eq!(tags.len(), 20, "complete source is not clipped to a phone/card list");
        assert!(tags.contains(&json!(nekko_remote::agent::activity_tag("chat-19"))));
        assert_eq!(*calls.lock().unwrap(), vec![("chat:pending".to_string(), json!([]))]);
        // This current-thread task does not yield while publishing, so the
        // production forwarder must observe broadcast lag (capacity 16K).
        for _ in 0..(16 * 1024 + 1) {
            hub.publish("not:relayed", Value::Null, false);
        }
        for kind in ["attention-unknown", "attention-snapshot"] {
            let text = tokio::time::timeout(Duration::from_secs(10), ws.next()).await.unwrap().unwrap().unwrap();
            let frame: Value = serde_json::from_str(text.to_text().unwrap()).unwrap();
            assert_eq!(frame["type"], kind);
        }
        remote.stop();
        assert_eq!(calls.lock().unwrap().len(), 2, "a hub gap triggers another complete read");
    }

    #[test]
    fn forwards_only_relayed_channels() {
        let (ch, payload) = relayed(r#"{"channel":"agent:event","payload":{"type":"done","sessionId":"s"}}"#).unwrap();
        assert_eq!(ch, "agent:event");
        assert_eq!(payload["type"], "done");
        assert!(relayed(r#"{"channel":"downloads:updated","payload":[]}"#).is_none());
        assert!(relayed(r#"{"channel":"limits:updated","payload":{"relayOnly":true}}"#).is_none());
        assert!(relayed("not json").is_none());
    }
}
