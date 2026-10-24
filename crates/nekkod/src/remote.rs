//! Phone remote access owned by the daemon (PF14): `remote:*`, `remote.json`
//! and the relay agent (`nekko-remote`).
//!
//! The agent answers a paired phone's requests through the daemon's own
//! router, so a phone reaches exactly what the UI reaches (the daemon's
//! services and, through it, the TS host's), and forwards the events the UI
//! hears from the hub, the daemon's and the host's merged. It used to live in
//! the TS host, which dispatched into its own copies of services the daemon
//! now owns (sessions, tasks) and so wrote their files beside the daemon.
//!
//! Owned only when the daemon knows the data directory; otherwise every
//! `remote:*` channel goes to the TS host as before.

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
    svc: Option<Arc<RemoteService>>,
    dispatch: Arc<OnceLock<PhoneDispatcher>>,
    /// Phones attached to terminals (FA-3), shared by the gate and the relay agent.
    terminals: Arc<PhoneTerminals>,
    /// `security.json` beside `remote.json`: step-up on guarded phone calls
    /// (SK-2), the same store Settings → Security writes (SK-4).
    security: Option<Arc<dyn nekko_remote::step_up::SecurityStore>>,
    /// Where a safety exit is announced, for the desktop's notification (SK-4).
    hub: Hub,
}

/// The hub event a phone's safety exit (`device:signOut`, `remote:stop`,
/// `app:quit`) sends once the computer has done it: `{ channel, deviceId,
/// name, at }`. The desktop's main process turns it into a notification.
pub const SAFETY_EXIT_EVENT: &str = "remote:safetyExit";

impl Remote {
    pub fn new(dir: Option<PathBuf>, hub: Hub) -> Self {
        let dispatch: Arc<OnceLock<PhoneDispatcher>> = Arc::default();
        let terminals = PhoneTerminals::new();
        let security = dir.as_deref().map(|d| {
            Arc::new(nekko_remote::step_up::SecurityFile::in_dir(d)) as Arc<dyn nekko_remote::step_up::SecurityStore>
        });
        let events = hub.clone();
        let svc = dir.map(|d| {
            let link = HubLink {
                rt: tokio::runtime::Handle::current(),
                hub,
                dispatch: dispatch.clone(),
                terminals: terminals.clone(),
            };
            RemoteService::new(&d, nekko_remote::hello::os_random(), nekko_remote::system_clock(), Box::new(link))
        });
        Self { svc, dispatch, terminals, security, hub: events }
    }

    /// `security.json`'s store, shared with Settings → Security (security.rs).
    pub fn security_store(&self) -> Option<Arc<dyn nekko_remote::step_up::SecurityStore>> {
        self.security.clone()
    }

    pub fn enabled(&self) -> bool {
        self.svc.is_some()
    }

    /// How a phone's request runs: through the router, limited to what the
    /// phone access policy allows (`nekko_remote::phone`), with secrets
    /// stripped from what it returns. The gate reads the calling device's
    /// switches, Change key and activity from the registry (IO-33), and
    /// shares terminal attachments with the relay agent (FA-3).
    pub fn set_dispatcher(&self, run: Dispatcher) {
        // Without a data directory there is no registry and no relay agent to dispatch for.
        if let Some(svc) = &self.svc {
            let classes = nekko_remote::phone::Classes::from_policy();
            let gate = nekko_remote::phone::gate_secured(
                run,
                svc.clone(),
                classes,
                self.terminals.clone(),
                self.security.clone(),
            );
            let _ = self.dispatch.set(announce_safety_exits(gate, svc.clone(), self.hub.clone()));
        }
    }

    /// Reconnect when remote access was left on.
    pub fn start(&self) {
        if let Some(svc) = self.svc.clone() {
            // Reads remote.json: off the async threads.
            tokio::task::spawn_blocking(move || svc.start_if_enabled());
        }
    }

    pub fn stop(&self) {
        if let Some(svc) = &self.svc {
            svc.stop();
        }
    }

    pub async fn route(&self, channel: &str, args: &[Value]) -> Result<Value, String> {
        let Some(svc) = self.svc.clone() else { return Err(format!("{channel}: no data directory")) };
        let (channel, args) = (channel.to_string(), args.to_vec());
        tokio::task::spawn_blocking(move || svc.route(&channel, &args)).await.map_err(|e| e.to_string())?
    }
}

/// Connects the agent to a relay, with the hub's events and the router.
struct HubLink {
    rt: tokio::runtime::Handle,
    hub: Hub,
    dispatch: Arc<OnceLock<PhoneDispatcher>>,
    terminals: Arc<PhoneTerminals>,
}

impl Link for HubLink {
    fn connect(&self, relay_url: &str, room: &str, key: &str, verify: Verifier) -> Arc<dyn LinkHandle> {
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
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        });
        let dispatch_cell = self.dispatch.clone();
        let dispatch: PhoneDispatcher = Arc::new(move |who, channel, args| match dispatch_cell.get() {
            Some(run) => run(who, channel, args),
            None => Box::pin(std::future::ready(Err("the daemon is still starting".to_string()))),
        });
        Arc::new(RelayAgent::spawn(
            &self.rt,
            Spawn {
                url: nekko_remote::agent_url(relay_url, room, key, None),
                secret: key.to_string(),
                room: room.to_string(),
                verify,
                dispatch,
                events,
                terminals: self.terminals.clone(),
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
        let remote = Remote::new(Some(dir.path().to_path_buf()), hub.clone());
        let svc = remote.svc.clone().unwrap();
        let payload = safety_exit_payload(&*svc, "remote:stop", "phone-1");
        assert_eq!(payload["channel"], "remote:stop");
        assert_eq!(payload["deviceId"], "phone-1");
        assert!(payload["name"].is_null(), "an unknown phone has no name");
        assert!(payload["at"].as_f64().unwrap() > 0.0);
        assert!(remote.security_store().is_some());
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
