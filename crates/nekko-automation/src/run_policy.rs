//! When an automation that nobody started just now may run: its policy
//! (`runPolicy` on the task or workflow, else the settings'
//! `automationRunPolicy`), judged against whether someone is using the
//! computer (`activity:state`, the host's).
//!
//! - **idle**: wait while someone is using the computer, or it runs on
//!   battery or hot.
//! - **lowPriority**: run while someone is there, but not on a low battery or
//!   a hot machine.
//! - **always**: run at once.
//!
//! With neither set, an automation on a local model waits for idle and one on
//! a cloud model runs at once: only the first competes with the user for this
//! machine. A run kept waiting [`WAIT_CAP_MS`] starts anyway, in low priority:
//! nothing waits forever unseen.

use serde_json::Value;

/// How long a due run waits for the policy before it starts regardless.
pub const WAIT_CAP_MS: f64 = 2.0 * 3600.0 * 1000.0;
/// The idle threshold when the settings name none (`automationIdleMinutes`).
pub const IDLE_MINUTES: f64 = 5.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Policy {
    Idle,
    LowPriority,
    Always,
}

impl Policy {
    fn parse(v: Option<&Value>) -> Option<Policy> {
        match v?.as_str()? {
            "idle" => Some(Policy::Idle),
            "lowPriority" => Some(Policy::LowPriority),
            "always" => Some(Policy::Always),
            _ => None,
        }
    }
}

/// The automation's own policy, else the settings' default, else idle for a
/// local model and always for a cloud one.
pub fn policy_of(item: &Value, settings: &Value, local: bool) -> Policy {
    Policy::parse(item.get("runPolicy"))
        .or_else(|| Policy::parse(settings.get("automationRunPolicy")))
        .unwrap_or(if local { Policy::Idle } else { Policy::Always })
}

/// Whether `provider_id` names a provider in `settings.providers` that runs
/// on this machine (`localModelOnly`'s test: a local kind on a loopback address).
pub fn is_local_provider(settings: &Value, provider_id: Option<&Value>) -> bool {
    let Some(id) = provider_id.filter(|v| nekko_js::truthy(Some(v))) else { return false };
    settings
        .get("providers")
        .and_then(Value::as_array)
        .and_then(|ps| ps.iter().find(|p| p.get("id") == Some(id)))
        .is_some_and(nekko_turn::providers::offline_provider_allowed)
}

/// `settings.automationIdleMinutes` in seconds, the default when unset or nonsense.
pub fn idle_after_secs(settings: &Value) -> f64 {
    let m = settings.get("automationIdleMinutes").and_then(Value::as_f64).filter(|m| m.is_finite() && *m > 0.0);
    m.unwrap_or(IDLE_MINUTES) * 60.0
}

/// What the policy says now.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Gate {
    /// Run; `low_priority` when it runs beside the user or after the cap,
    /// `waited_ms` when it was held back first.
    Go {
        low_priority: bool,
        waited_ms: Option<f64>,
    },
    Wait,
}

fn strained(activity: &Value, kinds: &[&str]) -> bool {
    activity
        .get("strain")
        .and_then(Value::as_array)
        .is_some_and(|s| s.iter().any(|k| k.as_str().is_some_and(|k| kinds.contains(&k))))
}

/// The policy against `activity` (`None` when the host cannot tell: run), for
/// a run due since `due_at`.
pub fn gate(policy: Policy, activity: Option<&Value>, due_at: f64, now: f64) -> Gate {
    let waited = (now - due_at).max(0.0);
    let Some(a) = activity.filter(|_| policy != Policy::Always) else {
        return Gate::Go { low_priority: false, waited_ms: None };
    };
    let present = a.get("userActive") == Some(&Value::Bool(true));
    let (hold, low_priority) = match policy {
        Policy::Idle => (present || strained(a, &["battery", "lowBattery", "hot"]), false),
        Policy::LowPriority => (strained(a, &["lowBattery", "hot"]), present),
        Policy::Always => unreachable!("answered above"),
    };
    if !hold {
        return Gate::Go { low_priority, waited_ms: None };
    }
    if waited >= WAIT_CAP_MS {
        return Gate::Go { low_priority: true, waited_ms: Some(waited) };
    }
    Gate::Wait
}

/// How a run behaves once started, for the turn's model client (nekkod's chat_client
/// `YieldingClient`): `idle` steps aside whenever someone uses the computer;
/// `lowPriority` only for a chat of theirs on a local model. `None` (always)
/// never steps aside. Sent in the turn's `chat:send` as `background`.
pub fn running_mode(policy: Policy, low_priority: bool) -> Option<&'static str> {
    match policy {
        Policy::Always => None,
        Policy::LowPriority => Some("lowPriority"),
        Policy::Idle if low_priority => Some("lowPriority"),
        Policy::Idle => Some("idle"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn act(active: bool, strain: &[&str]) -> Value {
        json!({ "userActive": active, "strain": strain })
    }

    #[test]
    fn the_default_follows_where_the_model_runs() {
        let none = json!({});
        assert_eq!(policy_of(&none, &none, true), Policy::Idle);
        assert_eq!(policy_of(&none, &none, false), Policy::Always);
        let all_low = json!({ "automationRunPolicy": "lowPriority" });
        assert_eq!(policy_of(&none, &all_low, false), Policy::LowPriority);
        let own = json!({ "runPolicy": "always" });
        assert_eq!(policy_of(&own, &all_low, true), Policy::Always);
        assert_eq!(
            policy_of(&json!({ "runPolicy": "soon" }), &none, true),
            Policy::Idle,
            "unknown values fall through"
        );
    }

    #[test]
    fn a_local_provider_is_one_on_this_machine() {
        let settings = json!({ "providers": [
            { "id": "engine", "kind": "llamacpp", "baseUrl": "http://127.0.0.1:11500/v1" },
            { "id": "cloud", "kind": "openai", "baseUrl": "https://api.openai.com/v1" },
        ]});
        assert!(is_local_provider(&settings, Some(&json!("engine"))));
        assert!(!is_local_provider(&settings, Some(&json!("cloud"))));
        assert!(!is_local_provider(&settings, Some(&json!("gone"))));
        assert!(!is_local_provider(&settings, None));
    }

    #[test]
    fn idle_waits_for_the_user_and_for_mains_power() {
        let go = Gate::Go { low_priority: false, waited_ms: None };
        assert_eq!(gate(Policy::Idle, Some(&act(false, &[])), 0.0, 1.0), go);
        assert_eq!(gate(Policy::Idle, Some(&act(true, &[])), 0.0, 1.0), Gate::Wait);
        assert_eq!(gate(Policy::Idle, Some(&act(false, &["battery"])), 0.0, 1.0), Gate::Wait);
        assert_eq!(gate(Policy::Idle, Some(&act(false, &["hot"])), 0.0, 1.0), Gate::Wait);
    }

    #[test]
    fn low_priority_runs_beside_the_user_but_not_on_a_low_battery() {
        assert_eq!(
            gate(Policy::LowPriority, Some(&act(true, &["battery"])), 0.0, 1.0),
            Gate::Go { low_priority: true, waited_ms: None }
        );
        assert_eq!(
            gate(Policy::LowPriority, Some(&act(false, &[])), 0.0, 1.0),
            Gate::Go { low_priority: false, waited_ms: None }
        );
        assert_eq!(gate(Policy::LowPriority, Some(&act(false, &["lowBattery"])), 0.0, 1.0), Gate::Wait);
    }

    #[test]
    fn always_and_an_unknown_machine_run_at_once() {
        let go = Gate::Go { low_priority: false, waited_ms: None };
        assert_eq!(gate(Policy::Always, Some(&act(true, &["hot"])), 0.0, 1.0), go);
        assert_eq!(gate(Policy::Idle, None, 0.0, 1.0), go);
    }

    #[test]
    fn a_run_held_past_the_cap_starts_in_low_priority() {
        let busy = act(true, &[]);
        assert_eq!(gate(Policy::Idle, Some(&busy), 1000.0, 1000.0 + WAIT_CAP_MS - 1.0), Gate::Wait);
        assert_eq!(
            gate(Policy::Idle, Some(&busy), 1000.0, 1000.0 + WAIT_CAP_MS),
            Gate::Go { low_priority: true, waited_ms: Some(WAIT_CAP_MS) }
        );
    }

    #[test]
    fn a_run_past_the_cap_or_beside_the_user_steps_aside_only_for_their_chats() {
        assert_eq!(running_mode(Policy::Idle, false), Some("idle"));
        assert_eq!(running_mode(Policy::Idle, true), Some("lowPriority"));
        assert_eq!(running_mode(Policy::LowPriority, false), Some("lowPriority"));
        assert_eq!(running_mode(Policy::Always, true), None);
    }

    #[test]
    fn the_idle_threshold_comes_from_settings() {
        assert_eq!(idle_after_secs(&json!({})), 300.0);
        assert_eq!(idle_after_secs(&json!({ "automationIdleMinutes": 15 })), 900.0);
        assert_eq!(idle_after_secs(&json!({ "automationIdleMinutes": -1 })), 300.0);
    }
}
