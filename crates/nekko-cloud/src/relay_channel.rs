//! The Nekko Cloud Relay account channel (decision 0116): one socket per
//! signed-in device of the account, through the hosted relay, so computers
//! and phones learn about each other at once instead of polling Nekko Cloud.
//!
//! - **Presence.** Which of the account's devices are online now, as they
//!   come and go (`ready`, `presence`), shown on `cloud:status` as `relay`.
//! - **Sync nudges.** After a pass that pushed something, this device says
//!   `sync`; another device that hears it syncs at once rather than at its
//!   next minute. A nudge carries a topic, never what changed: the change
//!   itself still travels sealed through `/v1/sync`.
//!
//! Only for accounts whose plan includes Nekko Cloud Relay (Pro, Team) once
//! the `cloud-relay` switch shows it to them. Without it nothing here runs,
//! and sync keeps its once-a-minute pass.

use crate::{Cloud, lock, pace};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio_tungstenite::tungstenite::Message;

/// Topics that mean "something synced changed": pull now.
const SYNC_TOPICS: [&str; 3] = ["sync", "library", "settings"];
/// While the account may not use the channel, look again this often.
const RETRY: Duration = Duration::from_secs(60);
const CONNECT_LIMIT: Duration = Duration::from_secs(15);

/// One frame from the relay on the account channel.
#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    Ready { dev: String, devices: Vec<(String, String)> },
    Presence { dev: String, kind: String, online: bool },
    Nudge { topic: String, from: String },
    Other,
}

pub fn parse(text: &str) -> Frame {
    let Ok(v) = serde_json::from_str::<Value>(text) else { return Frame::Other };
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    match v.get("type").and_then(Value::as_str) {
        Some("ready") => Frame::Ready {
            dev: s("dev").unwrap_or_default(),
            devices: v
                .get("devices")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|d| {
                            Some((d.get("dev")?.as_str()?.to_string(), d.get("kind")?.as_str()?.to_string()))
                        })
                        .collect()
                })
                .unwrap_or_default(),
        },
        Some("presence") => match (s("dev"), s("kind"), v.get("online").and_then(Value::as_bool)) {
            (Some(dev), Some(kind), Some(online)) => Frame::Presence { dev, kind, online },
            _ => Frame::Other,
        },
        Some("nudge") => match (s("topic"), s("from")) {
            (Some(topic), Some(from)) => Frame::Nudge { topic, from },
            _ => Frame::Other,
        },
        _ => Frame::Other,
    }
}

/// What this device knows about the channel right now.
#[derive(Default)]
pub struct Channel {
    out: Mutex<Option<tokio::sync::mpsc::UnboundedSender<String>>>,
    /// This device as the relay knows it, once ready.
    me: Mutex<Option<String>>,
    /// The account's devices online now (this one included): dev → kind.
    peers: Mutex<BTreeMap<String, String>>,
}

impl Channel {
    /// Applies a frame; true when presence changed (the status should be republished).
    pub fn apply(&self, frame: &Frame) -> bool {
        match frame {
            Frame::Ready { dev, devices } => {
                *lock(&self.me) = Some(dev.clone());
                *lock(&self.peers) = devices.iter().cloned().collect();
                true
            }
            Frame::Presence { dev, kind, online } => {
                let mut peers = lock(&self.peers);
                if *online { peers.insert(dev.clone(), kind.clone()).is_none() } else { peers.remove(dev).is_some() }
            }
            _ => false,
        }
    }

    fn clear(&self) {
        *lock(&self.out) = None;
        *lock(&self.me) = None;
        lock(&self.peers).clear();
    }

    /// For `cloud:status`: whether the channel is up, and who else is online.
    pub fn status(&self) -> Value {
        let me = lock(&self.me).clone();
        let peers: Vec<Value> = lock(&self.peers)
            .iter()
            .filter(|(dev, _)| Some(*dev) != me.as_ref())
            .map(|(dev, kind)| json!({ "dev": dev, "kind": kind }))
            .collect();
        json!({ "connected": me.is_some(), "online": peers })
    }

    /// The account channel is up (the relay has said `ready`).
    pub fn connected(&self) -> bool {
        lock(&self.me).is_some()
    }

    /// Tell the account's other devices to look at `topic`. Nothing while offline.
    pub fn nudge(&self, topic: &str) {
        if let Some(tx) = lock(&self.out).as_ref() {
            let _ = tx.send(json!({ "type": "nudge", "topic": topic }).to_string());
        }
    }
}

impl Cloud {
    /// Nekko Cloud Relay is on this account's plan and shown to it.
    pub(crate) fn relay_included(&self) -> bool {
        self.vault.get("token").is_some()
            && self.account().is_some_and(|a| a.cloud_relay && (a.plan == "pro" || a.plan == "team" || a.staff))
    }

    /// Hold the account channel open on `relay_url` while the account may use it. After a session
    /// that ends or fails to open, wait 5 s, then 10 s, 20 s... up to 5 min (each with 20% jitter),
    /// starting again from 5 s once a session has held for a minute, so a down Relay isn't dialled in
    /// step by every device of every account.
    pub fn start_relay_channel(self: &Arc<Self>, relay_url: String) {
        let me = self.clone();
        tokio::spawn(async move {
            let mut failures = 0u32;
            loop {
                if !me.relay_included() {
                    failures = 0;
                    tokio::time::sleep(pace::jittered(RETRY, pace::unit())).await;
                    continue;
                }
                let began = Instant::now();
                let held = matches!(me.relay_session(&relay_url).await, Ok(true));
                me.relay.clear();
                me.changed();
                failures = if held && began.elapsed() >= pace::STABLE_SESSION { 0 } else { failures.saturating_add(1) };
                tokio::time::sleep(pace::redial_wait(failures.saturating_sub(1), pace::unit())).await;
            }
        });
    }

    /// One session on the channel. `Ok(true)` when the relay accepted this device (it sent `ready`),
    /// `Ok(false)` when it closed the socket without: the ticket is then dropped so the redial asks for a new one.
    async fn relay_session(self: &Arc<Self>, relay_url: &str) -> Result<bool, String> {
        let (ticket, renew) = self.relay_ticket("account", None).await?;
        let url = format!("{}/account", relay_url.trim_end_matches('/'));
        let (ws, _) = tokio::time::timeout(CONNECT_LIMIT, tokio_tungstenite::connect_async(url.as_str()))
            .await
            .map_err(|_| "no answer".to_string())?
            .map_err(|e| e.to_string())?;
        let (mut sink, mut stream) = ws.split();
        let auth = json!({ "type": "auth", "access": ticket, "kind": "computer" }).to_string();
        sink.send(Message::text(auth)).await.map_err(|e| e.to_string())?;
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        *lock(&self.relay.out) = Some(tx);
        let renew_at = tokio::time::sleep(renew);
        tokio::pin!(renew_at);
        let mut accepted = false;
        let outcome = loop {
            tokio::select! {
                msg = stream.next() => match msg {
                    Some(Ok(Message::Text(t))) => {
                        accepted |= matches!(parse(t.as_str()), Frame::Ready { .. });
                        self.on_relay_frame(t.as_str());
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break accepted,
                    Some(Ok(_)) => {}
                },
                Some(out) = rx.recv() => {
                    if sink.send(Message::text(out)).await.is_err() {
                        break accepted;
                    }
                }
                _ = &mut renew_at => {
                    let next = match self.relay_ticket("account", None).await {
                        Ok((t, r)) => {
                            let frame = json!({ "type": "access", "access": t }).to_string();
                            if sink.send(Message::text(frame)).await.is_err() {
                                break accepted;
                            }
                            r
                        }
                        // The relay closes the socket when the old ticket runs out; try again before then.
                        Err(_) => RETRY,
                    };
                    renew_at.as_mut().reset(tokio::time::Instant::now() + next);
                }
            }
        };
        if !outcome {
            // Closed without accepting us: the ticket may be what it refused, so the redial asks for a new one.
            self.tickets.forget("account", None);
        }
        Ok(outcome)
    }

    fn on_relay_frame(self: &Arc<Self>, text: &str) {
        let frame = parse(text);
        if self.relay.apply(&frame) {
            self.changed();
        }
        // Another of this account's computers changed what it shares: the Computers list reads it again
        // (only with the slow beat, which leaves the 15 s poll for a minute).
        if matches!(&frame, Frame::Nudge { topic, .. } if topic == "fleet") && crate::orgs::SLOW_HEARTBEAT_ENABLED {
            self.changed();
        }
        if let Frame::Nudge { topic, .. } = &frame
            && SYNC_TOPICS.contains(&topic.as_str())
            && self.ready()
            && self.nudge_pending.begin()
        {
            // Every device of the account hears the same nudge: wait 0 to 3 s, and let a burst of nudges share one pass.
            let me = self.clone();
            tokio::spawn(async move {
                tokio::time::sleep(pace::nudge_delay(pace::unit())).await;
                me.nudge_pending.end();
                if me.ready() && !lock(&me.live).syncing {
                    let _ = me.sync_once().await;
                }
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_relay_frames_and_nothing_else() {
        assert_eq!(
            parse(
                r#"{"type":"ready","dev":"mac","expiresAt":"x","devices":[{"dev":"mac","kind":"computer"},{"dev":"phone","kind":"phone"}]}"#
            ),
            Frame::Ready {
                dev: "mac".into(),
                devices: vec![("mac".into(), "computer".into()), ("phone".into(), "phone".into())]
            }
        );
        assert_eq!(
            parse(r#"{"type":"presence","dev":"phone","kind":"phone","online":false}"#),
            Frame::Presence { dev: "phone".into(), kind: "phone".into(), online: false }
        );
        assert_eq!(
            parse(r#"{"type":"nudge","topic":"sync","rev":3,"from":"pc"}"#),
            Frame::Nudge { topic: "sync".into(), from: "pc".into() }
        );
        for junk in [
            "",
            "[]",
            r#"{"type":"presence","dev":"x"}"#,
            r#"{"type":"signal","from":"x","data":"y"}"#,
            r#"{"type":"access-ok"}"#,
        ] {
            assert_eq!(parse(junk), Frame::Other, "{junk}");
        }
    }

    #[test]
    fn keeps_who_is_online_and_leaves_itself_out_of_the_status() {
        let c = Channel::default();
        assert_eq!(c.status(), json!({ "connected": false, "online": [] }));
        assert!(c.apply(&parse(r#"{"type":"ready","dev":"mac","devices":[{"dev":"mac","kind":"computer"}]}"#)));
        assert!(c.apply(&Frame::Presence { dev: "phone".into(), kind: "phone".into(), online: true }));
        assert!(!c.apply(&Frame::Presence { dev: "phone".into(), kind: "phone".into(), online: true }), "no news");
        assert_eq!(c.status(), json!({ "connected": true, "online": [{ "dev": "phone", "kind": "phone" }] }));
        assert!(c.apply(&Frame::Presence { dev: "phone".into(), kind: "phone".into(), online: false }));
        assert!(!c.apply(&Frame::Nudge { topic: "sync".into(), from: "pc".into() }));
        c.clear();
        assert_eq!(c.status()["connected"], json!(false));
    }

    #[test]
    fn a_nudge_goes_out_only_while_connected() {
        let c = Channel::default();
        c.nudge("sync"); // offline: dropped, no panic
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        *lock(&c.out) = Some(tx);
        c.nudge("sync");
        let sent: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(sent, json!({ "type": "nudge", "topic": "sync" }));
    }
}
