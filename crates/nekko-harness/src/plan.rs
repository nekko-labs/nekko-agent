//! Claude Code's own plan, as the chat's plan (`agentPlan`).
//!
//! Claude Code has no `update_plan`: it plans with its own tools, which the
//! plan sheet would otherwise only show as tool calls. Each one that
//! succeeded becomes a [`PlanCall`], in `update_plan`'s step shape, for nekkod
//! to apply to the chat's plan. Display only: Nekko reads what the unmodified
//! Claude Code printed and adds nothing to its session.
//!
//! | Claude Code | Plan |
//! |---|---|
//! | `TodoWrite` `{ todos }` | the whole plan, replaced |
//! | `TaskCreate` `{ subject, description }`, result `Task #<id> created successfully` | a step `task_<id>` added |
//! | `TaskUpdate` `{ taskId, subject?, status? }` | that step changed, or removed (`deleted`) |

use serde_json::{Value, json};

/// The Claude Code tools whose calls carry its plan.
pub const PLAN_TOOLS: &[&str] = &["TodoWrite", "TaskCreate", "TaskUpdate"];

/// A change to the chat's plan. Steps are `update_plan` steps
/// (`{ id, title, status, note? }`).
#[derive(Debug, Clone, PartialEq)]
pub enum PlanCall {
    /// A new plan in place of the old one, finished steps included.
    Replace(Vec<Value>),
    /// Add the step, or change the one with its id.
    Upsert(Value),
    /// Drop the step with this id.
    Remove(String),
}

fn str_at<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

/// Claude Code's `pending` / `in_progress` / `completed` as a plan status.
fn status(s: &str) -> Option<&'static str> {
    match s {
        "pending" => Some("pending"),
        "in_progress" => Some("active"),
        "completed" => Some("done"),
        _ => None,
    }
}

fn task_step_id(task_id: &str) -> String {
    format!("task_{task_id}")
}

/// The first line of a task's description, as the step's note.
fn note(description: Option<&str>) -> Option<String> {
    let line = description?.lines().map(str::trim).find(|l| !l.is_empty())?;
    Some(line.to_string())
}

/// What a successful call of a [`PLAN_TOOLS`] tool did to the plan, from its
/// input and its result's text; `None` when it changed nothing readable.
pub fn plan_call(name: &str, input: &Value, output: &str) -> Option<PlanCall> {
    match name {
        "TodoWrite" => {
            let steps: Vec<Value> = input
                .get("todos")?
                .as_array()?
                .iter()
                .filter_map(|t| {
                    let title = str_at(t, "content").map(str::trim).filter(|s| !s.is_empty())?;
                    Some((title, status(str_at(t, "status").unwrap_or_default()).unwrap_or("pending")))
                })
                .enumerate()
                .map(|(i, (title, st))| json!({ "id": format!("todo_{}", i + 1), "title": title, "status": st }))
                .collect();
            (!steps.is_empty()).then_some(PlanCall::Replace(steps))
        }
        "TaskCreate" => {
            let title = str_at(input, "subject").map(str::trim).filter(|s| !s.is_empty())?;
            let id = output.split_once("Task #")?.1.split_whitespace().next()?;
            let mut step = json!({ "id": task_step_id(id), "title": title, "status": "pending" });
            if let Some(n) = note(str_at(input, "description")) {
                step["note"] = json!(n);
            }
            Some(PlanCall::Upsert(step))
        }
        "TaskUpdate" => {
            let id = task_step_id(str_at(input, "taskId").map(str::trim).filter(|s| !s.is_empty())?);
            let raw = str_at(input, "status");
            if raw == Some("deleted") {
                return Some(PlanCall::Remove(id));
            }
            let mut step = json!({ "id": id });
            if let Some(st) = raw.and_then(status) {
                step["status"] = json!(st);
            }
            if let Some(t) = str_at(input, "subject").map(str::trim).filter(|s| !s.is_empty()) {
                step["title"] = json!(t);
            }
            if let Some(n) = note(str_at(input, "description")) {
                step["note"] = json!(n);
            }
            (step.as_object().is_some_and(|o| o.len() > 1)).then_some(PlanCall::Upsert(step))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn todo_write_replaces_the_plan() {
        let input = json!({ "todos": [
            { "content": "Read the code", "status": "completed", "activeForm": "Reading" },
            { "content": "Fix it", "status": "in_progress", "activeForm": "Fixing" },
            { "content": "  ", "status": "pending", "activeForm": "" },
            { "content": "Test it", "status": "pending", "activeForm": "Testing" },
        ] });
        assert_eq!(
            plan_call("TodoWrite", &input, "Todos have been modified successfully."),
            Some(PlanCall::Replace(vec![
                json!({ "id": "todo_1", "title": "Read the code", "status": "done" }),
                json!({ "id": "todo_2", "title": "Fix it", "status": "active" }),
                json!({ "id": "todo_3", "title": "Test it", "status": "pending" }),
            ]))
        );
        assert_eq!(plan_call("TodoWrite", &json!({ "todos": [] }), ""), None);
    }

    #[test]
    fn task_create_takes_its_id_from_the_result() {
        let input = json!({ "subject": "Fix it", "description": "\nThe parser drops tabs.\nMore." });
        assert_eq!(
            plan_call("TaskCreate", &input, "Task #3 created successfully: Fix it"),
            Some(PlanCall::Upsert(
                json!({ "id": "task_3", "title": "Fix it", "status": "pending", "note": "The parser drops tabs." })
            ))
        );
        assert_eq!(plan_call("TaskCreate", &input, "Something else"), None);
    }

    #[test]
    fn task_update_changes_or_removes_a_step() {
        assert_eq!(
            plan_call("TaskUpdate", &json!({ "taskId": "3", "status": "in_progress" }), "Updated task #3 status"),
            Some(PlanCall::Upsert(json!({ "id": "task_3", "status": "active" })))
        );
        assert_eq!(
            plan_call("TaskUpdate", &json!({ "taskId": "3", "status": "deleted" }), ""),
            Some(PlanCall::Remove("task_3".into()))
        );
        assert_eq!(plan_call("TaskUpdate", &json!({ "taskId": "3", "owner": "me" }), ""), None);
        assert_eq!(plan_call("Bash", &json!({}), ""), None);
    }
}
