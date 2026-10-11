//! `applyPlanUpdate` and `planEcho` (packages/shared/src/training.ts): an
//! `update_plan` call applied to an ordinary chat's live plan.

use crate::lower;
use nekko_js as js;
use serde_json::{Map, Value, json};

const VALID: &[&str] = &["pending", "active", "done", "skipped"];

pub enum PlanOutcome {
    /// `{ plan, replaced, finished, skippedNow }`.
    Applied { plan: Vec<Value>, replaced: bool, finished: Vec<Value>, skipped_now: Vec<Value> },
    /// `{ error }`: the call was understood and refused.
    Refused(String),
    /// The TS function threw (a `null` step); the tool reports the message.
    Threw(String),
}

fn status(v: &Value) -> &str {
    v.get("status").and_then(Value::as_str).unwrap_or_default()
}

fn title(v: &Value) -> String {
    v.get("title").map(js::display).unwrap_or_else(|| "undefined".into())
}

/// A step created in this call with `note: undefined` holds the note's slot,
/// so a note set later lands before `createdAt`, where JavaScript keeps it.
fn set_note(step: &mut Value, note: &str, has_slot: bool) {
    let Some(obj) = step.as_object_mut() else { return };
    if !has_slot || obj.contains_key("note") {
        obj.insert("note".into(), json!(note));
        return;
    }
    let mut next = Map::new();
    for (k, v) in std::mem::take(obj) {
        if k == "createdAt" {
            next.insert("note".into(), json!(note));
        }
        next.insert(k, v);
    }
    *obj = next;
}

/// `applyPlanUpdate(current, input)` at time `now`.
pub fn apply_plan_update(current: Option<&Value>, input: &Value, now: u64) -> PlanOutcome {
    let raw: Vec<Value> = input.get("steps").and_then(Value::as_array).cloned().unwrap_or_default();
    if raw.is_empty() {
        return PlanOutcome::Refused("Pass at least one step.".into());
    }
    let current: Vec<Value> = current.and_then(Value::as_array).cloned().unwrap_or_default();
    let had_plan = !current.is_empty();
    let replace = input.get("replace") == Some(&Value::Bool(true)) || !had_plan;
    let mut next: Vec<Value> =
        current.into_iter().filter(|s| !replace || matches!(status(s), "done" | "skipped")).collect();
    // Indices into `next`, materialized at the end as the TS references are.
    let mut finished: Vec<usize> = Vec::new();
    let mut skipped_now: Vec<usize> = Vec::new();
    let mut note_slots: Vec<usize> = Vec::new();

    for r in &raw {
        if r.is_null() {
            return PlanOutcome::Threw("Cannot read properties of null (reading 'title')".into());
        }
        let t = r.get("title").filter(|v| !v.is_null()).map(js::display).unwrap_or_default();
        let t = js::slice16(js::trim(&t), 160).to_string();
        let id = match r.get("id").and_then(Value::as_str).map(js::trim) {
            Some(i) if !i.is_empty() => i.to_string(),
            _ => String::new(),
        };
        let st = r.get("status").and_then(Value::as_str).filter(|s| VALID.contains(s)).map(str::to_string);
        let note = match r.get("note").and_then(Value::as_str).map(js::trim) {
            Some(n) if !n.is_empty() => Some(js::slice16(n, 240).to_string()),
            _ => None,
        };
        let mut found = if id.is_empty() {
            None
        } else {
            next.iter().position(|s| s.get("id").and_then(Value::as_str) == Some(&id))
        };
        if replace && !t.is_empty() && found.is_some_and(|i| lower(&title(&next[i])) != lower(&t)) {
            found = None;
        }
        if found.is_none() && !t.is_empty() {
            found = next.iter().position(|s| lower(&title(s)) == lower(&t));
        }
        if let Some(i) = found {
            let was = status(&next[i]).to_string();
            let step = &mut next[i];
            if !t.is_empty() {
                step["title"] = json!(t);
            }
            if let Some(st) = &st
                && !(replace && matches!(was.as_str(), "done" | "skipped"))
            {
                step["status"] = json!(st);
            }
            if let Some(n) = &note {
                set_note(step, n, note_slots.contains(&i));
            }
            step["updatedAt"] = json!(now);
            let now_status = status(step);
            if now_status == "done" && was != "done" {
                finished.push(i);
            } else if now_status == "skipped" && was != "skipped" {
                skipped_now.push(i);
            }
        } else if !t.is_empty() {
            let new_id = if !id.is_empty() && !next.iter().any(|s| s.get("id").and_then(Value::as_str) == Some(&id)) {
                id
            } else {
                let mut n = next.len() + 1;
                while next.iter().any(|s| s.get("id").and_then(Value::as_str) == Some(&format!("step_{n}"))) {
                    n += 1;
                }
                format!("step_{n}")
            };
            let mut step = Map::new();
            step.insert("id".into(), json!(new_id));
            step.insert("title".into(), json!(t));
            step.insert("status".into(), json!(st.unwrap_or_else(|| "pending".into())));
            match note {
                Some(n) => {
                    step.insert("note".into(), json!(n));
                }
                None => note_slots.push(next.len()),
            }
            step.insert("createdAt".into(), json!(now));
            step.insert("updatedAt".into(), json!(now));
            next.push(Value::Object(step));
        }
    }
    if next.is_empty() {
        return PlanOutcome::Refused("The plan cannot be empty; pass the full step list.".into());
    }
    let pick = |ix: &[usize]| ix.iter().map(|&i| next[i].clone()).collect::<Vec<_>>();
    let (finished, skipped_now) = (pick(&finished), pick(&skipped_now));
    PlanOutcome::Applied { plan: next, replaced: replace, finished, skipped_now }
}

/// `planEcho(plan)`: what an `update_plan` call echoes back, so the agent knows each step's id.
pub fn plan_echo(plan: &[Value]) -> String {
    let done = plan.iter().filter(|s| status(s) == "done").count();
    let skipped = plan.iter().filter(|s| status(s) == "skipped").count();
    let lines: Vec<String> = plan
        .iter()
        .enumerate()
        .map(|(i, s)| {
            format!(
                "{}. [{}] {}: {}",
                i + 1,
                s.get("status").map(js::display).unwrap_or_else(|| "undefined".into()),
                s.get("id").map(js::display).unwrap_or_else(|| "undefined".into()),
                title(s)
            )
        })
        .collect();
    let skipped_part = if skipped > 0 { format!(", {skipped} skipped") } else { String::new() };
    format!("Plan saved ({done}/{} done{skipped_part}):\n{}", plan.len(), lines.join("\n"))
}
