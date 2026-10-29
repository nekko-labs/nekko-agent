//! `applyPlanUpdate` and `planEcho` (packages/shared/src/training.ts): an
//! `update_plan` call applied to an ordinary chat's live plan.

use crate::lower;
use nekko_js as js;
use serde_json::{Map, Value, json};

const VALID: &[&str] = &["pending", "active", "done", "skipped"];
/// `PLAN_STEP_KINDS`: the step's place in the work loop.
const KINDS: &[&str] = &["explore", "build", "verify", "ship"];

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

// Keep this sanitizer aligned with the shared TS contract.
fn verification(value: Option<&Value>) -> Option<Value> {
    let v = value?.as_object()?;
    let st = v.get("status")?.as_str()?;
    if !["pending", "active", "passed", "failed", "blocked", "unknown"].contains(&st) {
        return None;
    }
    let mut result = Map::new();
    result.insert("status".into(), json!(st));
    for (key, cap) in [("device", 160), ("detail", 1000)] {
        if let Some(text) = v.get(key).and_then(Value::as_str).map(js::trim).filter(|s| !s.is_empty()) {
            result.insert(key.into(), json!(js::slice16(text, cap)));
        }
    }
    if let Some(link) = v.get("evidenceUrl").and_then(Value::as_str).map(js::trim) {
        let lower = link.to_ascii_lowercase();
        if link.encode_utf16().count() <= 2048
            && (lower.starts_with("https://") || lower.starts_with("http://"))
            && let Ok(url) = url::Url::parse(link)
            && matches!(url.scheme(), "http" | "https")
            && url.username().is_empty()
            && url.password().is_none()
        {
            result.insert("evidenceUrl".into(), json!(link));
        }
    }
    Some(Value::Object(result))
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
        let kind = r.get("kind").and_then(Value::as_str).filter(|k| KINDS.contains(k)).map(str::to_string);
        let verification = verification(r.get("verification"));
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
            if let Some(k) = &kind {
                step["kind"] = json!(k);
            }
            // A finished step picked up again is another pass through the loop.
            if was == "done" && status(step) == "active" {
                let pass = step.get("pass").and_then(Value::as_u64).unwrap_or(1) + 1;
                step["pass"] = json!(pass);
            }
            if let Some(n) = &note {
                set_note(step, n, note_slots.contains(&i));
            }
            if let Some(v) = verification {
                step["verification"] = v;
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
            if let Some(k) = kind {
                step.insert("kind".into(), json!(k));
            }
            match note {
                Some(n) => {
                    step.insert("note".into(), json!(n));
                }
                None => note_slots.push(next.len()),
            }
            step.insert("createdAt".into(), json!(now));
            step.insert("updatedAt".into(), json!(now));
            if let Some(v) = verification {
                step.insert("verification".into(), v);
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn apply(current: Option<&Value>, input: Value, now: u64) -> Vec<Value> {
        match apply_plan_update(current, &input, now) {
            PlanOutcome::Applied { plan, .. } => plan,
            _ => panic!("expected applied plan"),
        }
    }

    #[test]
    fn verification_is_explicit_persisted_and_independent() {
        for st in ["pending", "active", "passed", "failed", "blocked", "unknown"] {
            let plan = apply(
                None,
                json!({"steps":[{"title":"Inspect", "status":"done", "verification":{"status":st, "device":" phone ", "detail":" inspecting "}}]}),
                10,
            );
            assert_eq!(plan[0]["verification"], json!({"status":st,"device":"phone","detail":"inspecting"}));
            let current = json!(plan);
            let updated = apply(
                Some(&current),
                json!({"steps":[{"id":"step_1", "verification":{"status":"passed","evidenceUrl":"https://example.com/proof"}}]}),
                20,
            );
            assert_eq!(updated[0]["status"], "done");
            assert_eq!(updated[0]["createdAt"], 10);
            assert_eq!(updated[0]["updatedAt"], 20);
            assert_eq!(updated[0]["verification"]["status"], "passed");
            let current = json!(updated);
            for invalid in [Value::Null, json!([]), json!("passed"), json!({}), json!({"status":"done"})] {
                let next = apply(Some(&current), json!({"steps":[{"id":"step_1","verification":invalid}]}), 30);
                assert_eq!(next[0]["verification"], current[0]["verification"]);
            }
            let next = apply(Some(&current), json!({"replace":true,"steps":[{"title":"Next"}]}), 40);
            assert_eq!(next[0], current[0]);
        }
        let plain = apply(None, json!({"steps":[{"title":"Build","status":"done"}]}), 10);
        assert!(plain[0].get("verification").is_none());
        assert_eq!(plan_echo(&plain), "Plan saved (1/1 done):\n1. [done] step_1: Build");
    }

    #[test]
    fn steps_carry_a_loop_kind_and_count_passes_when_reopened() {
        let plan = apply(
            None,
            json!({"steps":[{"title":"Look","kind":"explore","status":"done"},{"title":"Make","kind":"build","status":"done"},{"title":"Check","kind":"verify","status":"active"},{"title":"Odd","kind":"deploy"}]}),
            10,
        );
        assert_eq!(plan[0]["kind"], "explore");
        assert_eq!(plan[2]["kind"], "verify");
        assert!(plan[3].get("kind").is_none());
        // Key order matches the TS object: id, title, status, kind, note slot, createdAt.
        let keys: Vec<&String> = plan[1].as_object().unwrap().keys().collect();
        assert_eq!(keys, ["id", "title", "status", "kind", "createdAt", "updatedAt"]);
        // Verify fails: Build is picked up again (pass 2), then again (pass 3).
        let current = json!(plan);
        let again = apply(Some(&current), json!({"steps":[{"id":"step_2","status":"active"},{"id":"step_3","status":"pending"}]}), 20);
        assert_eq!(again[1]["pass"], 2);
        assert!(again[2].get("pass").is_none());
        let current = json!(again);
        let done = apply(Some(&current), json!({"steps":[{"id":"step_2","status":"done"}]}), 30);
        assert_eq!(done[1]["pass"], 2);
        let current = json!(done);
        let third = apply(Some(&current), json!({"steps":[{"id":"step_2","status":"active","kind":"build"}]}), 40);
        assert_eq!(third[1]["pass"], 3);
        // Re-planning keeps finished history as it was: no new pass.
        let current = json!(done);
        let replanned = apply(Some(&current), json!({"replace":true,"steps":[{"title":"Make","status":"active"}]}), 50);
        assert!(replanned[1].get("pass").is_some_and(|p| p == 2));
    }

    #[test]
    fn catalog_exposes_independent_verification_contract() {
        let catalog: Value = serde_json::from_str(include_str!("catalog.json")).unwrap();
        let tool = &catalog["tools"]["updatePlan"];
        let properties = &tool["parameters"]["properties"]["steps"]["items"]["properties"];
        assert_eq!(properties["status"]["enum"], json!(["pending", "active", "done", "skipped"]));
        assert_eq!(properties["kind"]["enum"], json!(["explore", "build", "verify", "ship"]));
        assert_eq!(
            properties["verification"]["properties"]["status"]["enum"],
            json!(["pending", "active", "passed", "failed", "blocked", "unknown"])
        );
        assert_eq!(properties["verification"]["required"], json!(["status"]));
        let description = tool["description"].as_str().unwrap();
        assert!(description.contains("tool return is not proof"));
        assert!(description.contains("counts only verification.status passed"));
    }

    #[test]
    fn verification_sanitizes_optional_fields() {
        for link in [
            json!("file:///tmp/proof"),
            json!("javascript:alert(1)"),
            json!("https://user:secret@example.com"),
            json!(format!("https://example.com/{}", "a".repeat(2048))),
            json!("https://"),
            json!(123),
        ] {
            let plan = apply(
                None,
                json!({"steps":[{"title":"Inspect", "verification":{"status":"unknown","device":"x".repeat(200),"detail":"y".repeat(1100),"evidenceUrl":link}}]}),
                10,
            );
            assert_eq!(
                plan[0]["verification"],
                json!({"status":"unknown","device":"x".repeat(160),"detail":"y".repeat(1000)})
            );
        }
    }
}
