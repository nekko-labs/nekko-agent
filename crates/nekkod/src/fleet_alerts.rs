//! Fleet runner notifications (decision 0064): every minute this computer reads its
//! organizations' CI runners (`fleet:runners`, sealed descriptors only) and tells the
//! desktop when another Mac went offline with a job running or a runner went into Error.
//! The first read after start only sets the baseline, so nothing old is announced.

use crate::hub::Hub;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

/// The desktop's notification watcher listens for this.
pub const EVENT: &str = "runners:fleetAlert";
const EVERY: Duration = Duration::from_secs(60);

#[derive(Debug, PartialEq)]
pub struct Alert {
    /// Stable per event, so a repeat (or the same news from another computer) collapses.
    pub id: String,
    pub title: String,
    pub body: String,
}

/// Each other computer's state by `org/deviceId`: online, and per runner label its state and busy VMs.
type Snapshot = HashMap<String, (bool, String, Vec<(String, String, u64)>)>;

fn snapshot(fleet: &Value) -> Snapshot {
    let mut out = Snapshot::new();
    for org in fleet["orgs"].as_array().into_iter().flatten() {
        let org_id = org["orgId"].as_str().unwrap_or_default();
        for c in org["computers"].as_array().into_iter().flatten() {
            let (Some(id), Some(name)) = (c["deviceId"].as_str(), c["name"].as_str()) else { continue };
            if c["you"].as_bool() == Some(true) {
                continue;
            }
            let runners = c["runners"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|r| {
                    Some((
                        r["label"].as_str()?.to_string(),
                        r["state"].as_str()?.to_string(),
                        r["busy"].as_u64().unwrap_or(0),
                    ))
                })
                .collect();
            out.insert(format!("{org_id}/{id}"), (c["online"].as_bool() == Some(true), name.to_string(), runners));
        }
    }
    out
}

/// What changed for the worse between two reads.
pub fn alerts(before: &Value, after: &Value) -> Vec<Alert> {
    let (before, after) = (snapshot(before), snapshot(after));
    let mut out = Vec::new();
    let mut keys: Vec<_> = after.keys().collect();
    keys.sort();
    for key in keys {
        let (online, name, runners) = &after[key];
        let Some((was_online, _, was)) = before.get(key) else { continue };
        let busy: u64 = was.iter().map(|r| r.2).sum();
        if *was_online && !online && busy > 0 {
            out.push(Alert {
                id: format!("offline:{key}"),
                title: "A Mac went offline mid-job".into(),
                body: format!(
                    "{name} went offline while running {}. GitHub will report {} as failed.",
                    if busy == 1 { "a CI job".to_string() } else { format!("{busy} CI jobs") },
                    if busy == 1 { "it" } else { "them" }
                ),
            });
        }
        if !online {
            continue;
        }
        for (label, state, _) in runners {
            let was_error = was.iter().any(|r| &r.0 == label && r.1 == "error");
            if state == "error" && !was_error {
                out.push(Alert {
                    id: format!("error:{key}/{label}"),
                    title: "A CI runner needs attention".into(),
                    body: format!("CI runner {label} on {name} stopped with an error."),
                });
            }
        }
    }
    out
}

/// Reads the fleet every minute while signed in to Nekko Cloud; a refusal (signed out,
/// no organization) just waits for the next minute.
pub fn spawn(cloud: Arc<nekko_cloud::Cloud>, hub: Hub) {
    tokio::spawn(async move {
        let mut last: Option<Value> = None;
        loop {
            match cloud.route("fleet:runners", &[]).await {
                Ok(now) => {
                    if let Some(before) = &last {
                        for a in alerts(before, &now) {
                            hub.publish(EVENT, json!({ "id": a.id, "title": a.title, "body": a.body }), false);
                        }
                    }
                    last = Some(now);
                }
                Err(_) => last = None,
            }
            tokio::time::sleep(EVERY).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fleet(online: bool, state: &str, busy: u64) -> Value {
        json!({ "orgs": [{ "orgId": "o1", "orgName": "Nekko Labs", "computers": [
            { "deviceId": "me", "name": "This Mac", "online": true, "you": true,
              "runners": [{ "label": "mine", "state": "error", "busy": 0, "slots": 1 }] },
            { "deviceId": "d2", "name": "Office mini", "online": online,
              "runners": [{ "label": "office", "state": state, "busy": busy, "slots": 2 }] },
        ]}]})
    }

    #[test]
    fn a_mac_going_offline_mid_job_and_a_runner_entering_error_are_told_once() {
        let ids = |v: Vec<Alert>| v.into_iter().map(|a| a.id).collect::<Vec<_>>();
        assert_eq!(ids(alerts(&fleet(true, "running", 1), &fleet(true, "running", 1))), Vec::<String>::new());
        let gone = alerts(&fleet(true, "running", 1), &fleet(false, "running", 1));
        assert_eq!(ids(gone), vec!["offline:o1/d2"]);
        assert_eq!(
            alerts(&fleet(true, "running", 2), &fleet(false, "running", 2))[0].body,
            "Office mini went offline while running 2 CI jobs. GitHub will report them as failed."
        );
        assert!(alerts(&fleet(true, "ready", 0), &fleet(false, "ready", 0)).is_empty(), "an idle Mac may sleep");
        let broke = alerts(&fleet(true, "ready", 0), &fleet(true, "error", 0));
        assert_eq!(broke[0].body, "CI runner office on Office mini stopped with an error.");
        assert!(alerts(&fleet(true, "error", 0), &fleet(true, "error", 0)).is_empty(), "still in Error is old news");
        assert!(
            alerts(&json!(null), &fleet(true, "error", 0)).is_empty(),
            "a Mac seen for the first time is a baseline"
        );
    }
}
