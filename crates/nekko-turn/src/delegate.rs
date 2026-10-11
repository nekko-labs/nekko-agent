//! What a `spawn_agent` child's run comes back as
//! (`packages/host/src/delegation-recovery.ts`): whether a failed child is
//! resumed, its answer, the interrupted message with its saved progress, and
//! the coded failure result.

use nekko_tools::jsre::JsRegex;
use serde_json::{Value, json};
use std::sync::OnceLock;

/// `MAX_CHILD_RESUMES`: one resume after a recoverable failure.
pub const MAX_CHILD_RESUMES: u32 = 1;

fn patterns() -> &'static (Option<JsRegex>, Option<JsRegex>) {
    static P: OnceLock<(Option<JsRegex>, Option<JsRegex>)> = OnceLock::new();
    P.get_or_init(|| {
        (
            JsRegex::new(
                r"stopped$|cancel|abort|credential|unauthoriz|forbidden|permission|approval|model.*(?:unavailable|not found)|\b(?:400|401|403|404)\b",
                "i",
            )
            .ok(),
            JsRegex::new(
                r"engine (?:stopped driving|could not be reached)|stopped sending|stream ended unexpectedly|network error|ECONNRESET|ETIMEDOUT|fetch failed|terminated|\b(?:408|429|500|502|503|504|529)\b",
                "i",
            )
            .ok(),
        )
    })
}

/// `canResumeChildFailure(message)`: a transient failure is resumed once; a
/// stop, an auth or permission problem or a missing model never is.
pub fn can_resume_child_failure(message: &str) -> bool {
    let (never, transient) = patterns();
    if never.as_ref().is_none_or(|r| r.test(message)) {
        return false;
    }
    transient.as_ref().is_some_and(|r| r.test(message))
}

/// The last assistant message with written content.
fn last_answer(messages: Option<&[Value]>) -> Option<&str> {
    messages?.iter().rev().find_map(|m| {
        let content = m.get("content").and_then(Value::as_str)?;
        (m.get("role").and_then(Value::as_str) == Some("assistant") && !nekko_js::trim(content).is_empty())
            .then_some(content)
    })
}

/// `subAgentAnswer(messages)`.
pub fn sub_agent_answer(messages: Option<&[Value]>) -> String {
    last_answer(messages).unwrap_or("Sub-agent finished without producing a written answer.").to_string()
}

/// `s.slice(-n)` in UTF-16 units, a lone surrogate at the cut kept as
/// JavaScript keeps it (lossily, since a Rust string cannot hold one).
fn tail16(s: &str, n: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().collect();
    let start = units.len().saturating_sub(n);
    String::from_utf16_lossy(&units[start..])
}

/// `childInterruptedMessage(childId, failure, messages)`.
pub fn child_interrupted_message(child_id: &str, failure: &str, messages: Option<&[Value]>) -> String {
    let progress = last_answer(messages).map(|c| tail16(c, 2000)).filter(|p| !p.is_empty());
    let mut out = format!(
        "Child session {child_id} interrupted: {failure}. Saved work remains in the shared project. No provider/model fallback was used. Continue the delegated task directly from its checkpoint, or explain the concrete blocker; do not assume it is complete."
    );
    if let Some(p) = progress {
        out.push_str("\nLast saved progress:\n");
        out.push_str(&p);
    }
    out
}

/// `subAgentFailure(callId, message)`: the tool result, with a code the model can act on.
pub fn sub_agent_failure(call_id: &str, message: &str) -> Value {
    let code = if message.contains("exact model ID is not available") {
        "model_unavailable"
    } else if message.contains("not a chat model") {
        "not_chat_model"
    } else if message.contains("model list") {
        "model_list_unavailable"
    } else if message.contains("unknown or disabled") {
        "provider_unavailable"
    } else if message.contains("endpoint") {
        "invalid_endpoint"
    } else if message.contains("cancelled") {
        "cancelled"
    } else {
        "delegation_failed"
    };
    let body =
        json!({ "ok": false, "code": code, "message": format!("Sub-agent failed: {message}"), "fallbackUsed": false });
    json!({ "toolCallId": call_id, "output": nekko_js::stringify(&body), "isError": true })
}
