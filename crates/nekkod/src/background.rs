//! Background turns on a local model step aside for the person at the
//! computer (B2). An automation's `chat:send` says how its turn runs
//! (`background`: `idle` or `lowPriority`, nekko-automation's
//! `run_policy::running_mode`); the turn's model client then asks a [`TurnGate`]
//! before each call and while it streams (nekkod's `chat_client::YieldingClient`):
//!
//! - `idle` steps aside while someone uses the computer (input within the
//!   idle threshold, or a chat of theirs replying), and while it runs on
//!   battery or hot;
//! - `lowPriority` steps aside only while a chat of theirs replies on a local
//!   model, or on a low battery or a hot machine.
//!
//! The call under way is stopped and sent again once the gate opens; the
//! model stays loaded. The gate looks every [`POLL`] only while a background
//! call is waiting or streaming. `background:state` and the
//! `background:updated` event say how many such turns run and are paused, and
//! why (the monitor's chip, B3).

use crate::chat_client::{GateFuture, YieldGate};
use crate::hub::Hub;
use nekko_machine::Machine;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const CHANNELS: &[&str] = &["background:state"];

/// How often a waiting or streaming background call looks again. With the
/// input read every 200 ms, the user's return is noticed within about 0.4 s.
pub const POLL: Duration = Duration::from_millis(200);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Idle,
    LowPriority,
}

impl Mode {
    /// From `chat:send`'s `background`.
    pub fn from_opts(opts: &Value) -> Option<Mode> {
        match opts.get("background").and_then(Value::as_str)? {
            "idle" => Some(Mode::Idle),
            "lowPriority" => Some(Mode::LowPriority),
            _ => None,
        }
    }
}

/// Why a background turn waits, given the activity (`activity:state`'s
/// shape) and whether a chat of the user's replies on a local model.
pub fn holds(mode: Mode, activity: &Value, local_chat: bool) -> Option<&'static str> {
    let strained = |k: &str| activity["strain"].as_array().is_some_and(|s| s.iter().any(|v| v == k));
    if strained("lowBattery") {
        return Some("lowBattery");
    }
    if strained("hot") {
        return Some("hot");
    }
    match mode {
        Mode::Idle if activity["chatActive"] == json!(true) => Some("chat"),
        Mode::Idle if activity["userActive"] == json!(true) => Some("active"),
        Mode::Idle if strained("battery") => Some("battery"),
        Mode::LowPriority if local_chat => Some("chat"),
        _ => None,
    }
}

pub struct Background {
    machine: Arc<Machine>,
    admission: Option<Arc<crate::admission::Admission>>,
    settings: Option<Arc<nekko_settings::SettingsStore>>,
    hub: Hub,
    next: AtomicU64,
    /// Each background turn's gate, and why it is paused if it is.
    turns: Mutex<HashMap<u64, Option<&'static str>>>,
}

impl Background {
    pub fn new(
        machine: Arc<Machine>,
        admission: Option<Arc<crate::admission::Admission>>,
        settings: Option<Arc<nekko_settings::SettingsStore>>,
        hub: Hub,
    ) -> Arc<Self> {
        Arc::new(Self { machine, admission, settings, hub, next: AtomicU64::new(1), turns: Mutex::default() })
    }

    /// The gate for one background turn; it counts as running until dropped.
    pub fn gate(self: &Arc<Self>, mode: Mode) -> Arc<TurnGate> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.set(id, Some(None));
        Arc::new(TurnGate { bg: self.clone(), id, mode })
    }

    async fn reason(&self, mode: Mode) -> Option<&'static str> {
        let idle_after = match &self.settings {
            Some(s) => {
                let store = s.clone();
                let settings = tokio::task::spawn_blocking(move || store.get()).await.unwrap_or(Value::Null);
                nekko_automation::run_policy::idle_after_secs(&settings)
            }
            None => nekko_machine::activity::IDLE_AFTER_SECS,
        };
        let readings = self.machine.activity().await;
        let chat = self.admission.as_ref().is_some_and(|a| a.attended_running());
        let local_chat = self.admission.as_ref().is_some_and(|a| a.attended_local_running());
        let activity =
            serde_json::to_value(nekko_machine::activity::assess(&readings, chat, idle_after)).unwrap_or(Value::Null);
        holds(mode, &activity, local_chat)
    }

    /// `None` removes the turn; `Some(reason)` records it, paused or not.
    fn set(&self, id: u64, state: Option<Option<&'static str>>) {
        let snapshot = {
            let mut turns = self.turns.lock().unwrap_or_else(|e| e.into_inner());
            let before = turns.get(&id).copied();
            match state {
                Some(s) => turns.insert(id, s),
                None => turns.remove(&id),
            };
            if before == state {
                return;
            }
            snapshot(&turns)
        };
        self.hub.publish("background:updated", snapshot, false);
    }

    /// `background:state`.
    pub fn state(&self) -> Value {
        snapshot(&self.turns.lock().unwrap_or_else(|e| e.into_inner()))
    }
}

/// How many background turns run, how many are paused, and why (the most
/// common reason among the paused).
fn snapshot(turns: &HashMap<u64, Option<&'static str>>) -> Value {
    let paused: Vec<&'static str> = turns.values().filter_map(|r| *r).collect();
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for r in &paused {
        *counts.entry(r).or_default() += 1;
    }
    let reason = counts.into_iter().max_by_key(|(r, n)| (*n, std::cmp::Reverse(*r))).map(|(r, _)| r);
    json!({ "running": turns.len(), "paused": paused.len(), "reason": reason })
}

/// One background turn's gate.
pub struct TurnGate {
    bg: Arc<Background>,
    id: u64,
    mode: Mode,
}

impl Drop for TurnGate {
    fn drop(&mut self) {
        self.bg.set(self.id, None);
    }
}

impl YieldGate for TurnGate {
    fn wait_turn(&self) -> GateFuture<'_> {
        Box::pin(async move {
            loop {
                let reason = self.bg.reason(self.mode).await;
                self.bg.set(self.id, Some(reason));
                if reason.is_none() {
                    return;
                }
                tokio::time::sleep(POLL).await;
            }
        })
    }

    fn must_yield(&self) -> GateFuture<'_> {
        Box::pin(async move {
            loop {
                tokio::time::sleep(POLL).await;
                if let Some(reason) = self.bg.reason(self.mode).await {
                    self.bg.set(self.id, Some(Some(reason)));
                    return;
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn act(user: bool, chat: bool, strain: &[&str]) -> Value {
        json!({ "userActive": user || chat, "chatActive": chat, "strain": strain })
    }

    #[test]
    fn idle_turns_step_aside_for_the_user_and_for_mains_power() {
        assert_eq!(holds(Mode::Idle, &act(false, false, &[]), false), None);
        assert_eq!(holds(Mode::Idle, &act(true, false, &[]), false), Some("active"));
        assert_eq!(holds(Mode::Idle, &act(false, true, &[]), false), Some("chat"));
        assert_eq!(holds(Mode::Idle, &act(false, false, &["battery"]), false), Some("battery"));
        assert_eq!(holds(Mode::Idle, &act(true, false, &["battery", "lowBattery"]), false), Some("lowBattery"));
    }

    #[test]
    fn low_priority_turns_step_aside_only_for_a_local_chat() {
        assert_eq!(holds(Mode::LowPriority, &act(true, true, &["battery"]), false), None, "a cloud chat, typing");
        assert_eq!(holds(Mode::LowPriority, &act(true, true, &[]), true), Some("chat"));
        assert_eq!(holds(Mode::LowPriority, &act(false, false, &["hot"]), false), Some("hot"));
    }

    #[test]
    fn the_mode_comes_from_the_send() {
        assert_eq!(Mode::from_opts(&json!({ "background": "idle" })), Some(Mode::Idle));
        assert_eq!(Mode::from_opts(&json!({ "background": "lowPriority" })), Some(Mode::LowPriority));
        assert_eq!(Mode::from_opts(&json!({})), None);
    }

    #[test]
    fn the_state_counts_turns_and_names_the_commonest_reason() {
        let mut turns = HashMap::new();
        assert_eq!(snapshot(&turns), json!({ "running": 0, "paused": 0, "reason": null }));
        turns.insert(1, Some("active"));
        turns.insert(2, Some("active"));
        turns.insert(3, Some("chat"));
        turns.insert(4, None);
        assert_eq!(snapshot(&turns), json!({ "running": 4, "paused": 3, "reason": "active" }));
    }
}
