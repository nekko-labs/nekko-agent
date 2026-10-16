//! `repairInterruptedHistory` and the resume strings (packages/core/src/agent/resume.ts).
//!
//! A run killed between the model asking for a tool and the tool answering
//! leaves a request with no result, which every provider rejects. Each such
//! call gets a result saying it never ran, placed directly after the request,
//! so the same transcript can be sent again.

use serde_json::{Value, json};
use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};

/// Appended to a reply whose stream broke, so the transcript says what happened.
pub const INTERRUPTED_NOTE: &str =
    "_This reply was cut off before it finished. Everything above is kept, resume to carry on from here._";

/// Stands in for a tool call that was requested but never got to run.
pub const INTERRUPTED_TOOL_OUTPUT: &str =
    "This tool call did not run: the reply was interrupted first. Call it again if you still need the result.";

/// Injected as one transient user turn when resuming; never persisted.
pub const RESUME_PROMPT: &str = "Your previous reply was cut off before it finished. Continue from exactly where it stopped. The work above, including every tool result, is already done: build on it and do not repeat it. If the task was already finished, just give the final answer.";

static PATCH_COUNTER: AtomicU64 = AtomicU64::new(0);

fn tool_call_ids(m: &Value) -> Vec<String> {
    m.get("toolCalls")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|c| c.get("id").and_then(Value::as_str).map(str::to_string))
        .collect()
}

/// Fill in results for tool calls that never ran. Mutates `history` in place
/// and returns how many gaps were filled.
pub fn repair_interrupted_history(history: &mut Vec<Value>) -> usize {
    let mut filled = 0;
    let mut i = 0;
    while i < history.len() {
        let msg = &history[i];
        if msg.get("role").and_then(Value::as_str) != Some("assistant") {
            i += 1;
            continue;
        }
        let requested: HashSet<String> = tool_call_ids(msg).into_iter().collect();
        let mut end = i + 1;
        while history.get(end).and_then(|m| m.get("role")).and_then(Value::as_str) == Some("tool") {
            end += 1;
        }
        let immediate: HashSet<&str> = history[i + 1..end]
            .iter()
            .filter_map(|m| m.pointer("/toolResult/toolCallId").and_then(Value::as_str))
            .collect();
        if requested.iter().all(|id| immediate.contains(id.as_str())) {
            i += 1;
            continue;
        }
        // Preserve delayed real results, placing them before intervening turns.
        let mut j = end;
        while j < history.len() {
            let result = &history[j];
            let id = result.pointer("/toolResult/toolCallId").and_then(Value::as_str);
            if result["role"] == "tool" && id.is_some_and(|id| requested.contains(id)) {
                let result = history.remove(j);
                history.insert(end, result);
                end += 1;
            }
            j += 1;
        }
        let answered: HashSet<String> = history[i + 1..end]
            .iter()
            .filter_map(|m| m.pointer("/toolResult/toolCallId").and_then(Value::as_str).map(str::to_string))
            .collect();
        let msg = &history[i];
        let missing: Vec<String> = tool_call_ids(msg).into_iter().filter(|id| !answered.contains(id)).collect();
        if missing.is_empty() {
            i += 1;
            continue;
        }
        let created = msg.get("createdAt").cloned();
        let patches: Vec<Value> = missing
            .iter()
            .map(|id| {
                let n = PATCH_COUNTER.fetch_add(1, Ordering::Relaxed) + 1;
                let mut p = json!({
                    "id": format!("msg_repair_{n}"),
                    "role": "tool",
                    "content": "",
                    "toolResult": { "toolCallId": id, "output": INTERRUPTED_TOOL_OUTPUT, "isError": true },
                });
                // An absent `createdAt` stays absent, as `undefined` does in JSON.
                if let Some(c) = &created {
                    p["createdAt"] = c.clone();
                }
                p
            })
            .collect();
        let n = patches.len();
        history.splice(i + 1..i + 1, patches);
        filled += n;
        i += n + 1;
    }
    filled
}
