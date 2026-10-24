//! `fit.ts` (packages/core/src/agent): keeping a long run inside the model's
//! context window by eliding the oldest bulky tool outputs from what is sent,
//! and `isContextOverflowError` (shared/context.ts). Sizes are UTF-16 units,
//! as the TS functions measure them.

use nekko_js as js;
use serde_json::Value;

pub const FIT_TRIGGER: f64 = 0.8;
pub const FIT_TARGET: f64 = 0.6;
pub const ELIDE_MIN_CHARS: usize = 600;
pub const KEEP_RECENT: usize = 4;
/// "Everything eligible" (`Number.MAX_SAFE_INTEGER`).
pub const ELIDE_ALL: usize = 9_007_199_254_740_991;

/// `CONTEXT_OVERFLOW_NEEDLES`.
const NEEDLES: &[&str] = &[
    "context length",
    "context_length",
    "context window",
    "context size",
    "maximum context",
    "max context",
    "prompt is too long",
    "prompt too long",
    "too many tokens",
    "exceeds the context",
    "exceed the context",
    "exceeds the maximum",
    "exceed_context_size",
    "input is too long",
    "input too long",
    "reduce the length of the messages",
    "n_ctx",
];

/// `isContextOverflowError`.
pub fn is_context_overflow(message: &str) -> bool {
    let lower = message.to_lowercase();
    if lower.contains("rate limit") || lower.contains("rate_limit") || lower.contains("per min") {
        return false;
    }
    NEEDLES.iter().any(|n| lower.contains(n))
}

/// A context overflow said in the user's terms: the window the model was
/// loaded with, what this chat needed and the fix, when the server's error
/// carries the numbers (llama.cpp and LM Studio: `n_ctx`, `n_prompt_tokens`);
/// else the error as it came. Still an overflow by `is_context_overflow`.
pub fn overflow_message(message: &str) -> String {
    let (Some(window), Some(needed)) = (error_number(message, "n_ctx"), error_number(message, "n_prompt_tokens"))
    else {
        return message.to_string();
    };
    format!(
        "The model is loaded with a {window}-token context window, and this chat needs {needed} tokens. \
         Reload the model with a larger context length (16384 or more) in your model server, then send again."
    )
}

/// The window and the prompt size an overflow names, from the server's error
/// (`n_ctx`, `n_prompt_tokens`) or from `overflow_message`'s sentence.
pub fn overflow_sizes(message: &str) -> Option<(u64, u64)> {
    if let (Some(w), Some(n)) = (error_number(message, "n_ctx"), error_number(message, "n_prompt_tokens")) {
        return Some((w, n));
    }
    let number_before = |end: &str| -> Option<u64> {
        let head = &message[..message.find(end)?];
        let digits: String = head.chars().rev().take_while(char::is_ascii_digit).collect();
        digits.chars().rev().collect::<String>().parse().ok()
    };
    Some((number_before("-token context window")?, number_before(" tokens. Reload the model")?))
}

/// The context window a server's overflow error says the model was loaded
/// with (llama.cpp and LM Studio: `"n_ctx":8192`).
pub fn reported_window(message: &str) -> Option<f64> {
    error_number(message, "n_ctx").map(|w| w as f64).filter(|w| *w > 0.0)
}

/// `"key":123` in an error body.
fn error_number(message: &str, key: &str) -> Option<u64> {
    let at = message.find(&format!("\"{key}\":"))? + key.len() + 3;
    let digits: String = message[at..].trim_start().chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

/// `elidedToolOutput`.
pub fn elided_tool_output(chars: usize) -> String {
    format!(
        "[Older tool output elided to keep this conversation inside the model's context window ({chars} characters). Run the tool again if you still need it.]"
    )
}

fn tool_output(m: &Value) -> Option<&str> {
    m.get("toolResult").and_then(|r| r.get("output")).and_then(Value::as_str)
}

/// `elidable`.
pub fn elidable(messages: &[Value]) -> Vec<usize> {
    let end = messages.len().saturating_sub(KEEP_RECENT);
    (0..end)
        .filter(|&i| {
            messages[i].get("role").and_then(Value::as_str) == Some("tool")
                && tool_output(&messages[i]).is_some_and(|o| js::len16(o) > ELIDE_MIN_CHARS)
        })
        .collect()
}

/// `historyText` (shared/context.ts), measured.
fn history_units(m: &Value) -> usize {
    let mut parts: Vec<String> = vec![m.get("content").and_then(Value::as_str).unwrap_or("").to_string()];
    if let Some(calls) = m.get("toolCalls").and_then(Value::as_array) {
        for call in calls {
            parts.push(call.get("name").and_then(Value::as_str).unwrap_or("").to_string());
            if let Some(input) = call.get("input") {
                parts.push(js::stringify(input));
            }
        }
    }
    if let Some(o) = tool_output(m).filter(|o| !o.is_empty()) {
        parts.push(o.to_string());
    }
    parts.retain(|p| !p.is_empty());
    js::len16(&parts.join("\n"))
}

/// `promptUnits`.
pub fn prompt_units(system: &str, tools: &[Value], messages: &[Value]) -> usize {
    let mut units = js::len16(system);
    if !tools.is_empty() {
        units += js::len16(&js::stringify(&Value::Array(tools.to_vec())));
    }
    units + messages.iter().map(history_units).sum::<usize>()
}

/// `applyElision`.
pub fn apply_elision(messages: Vec<Value>, count: usize) -> Vec<Value> {
    if count == 0 {
        return messages;
    }
    let at: Vec<usize> = elidable(&messages).into_iter().take(count).collect();
    let mut out = messages;
    for i in at {
        let chars = tool_output(&out[i]).map(js::len16).unwrap_or(0);
        out[i]["toolResult"]["output"] = Value::String(elided_tool_output(chars));
    }
    out
}

/// `elisionFor`.
pub fn elision_for(
    system: &str,
    tools: &[Value],
    messages: &[Value],
    context_window: Option<f64>,
    current: usize,
) -> usize {
    let Some(window) = context_window.filter(|w| *w > 0.0) else { return current };
    let eligible = elidable(messages);
    let applied = current.min(eligible.len());
    let mut units = prompt_units(system, tools, messages) as f64;
    let saving = |i: usize| {
        let chars = tool_output(&messages[i]).map(js::len16).unwrap_or(0);
        chars as f64 - js::len16(&elided_tool_output(chars)) as f64
    };
    for &i in &eligible[..applied] {
        units -= saving(i);
    }
    if units / 4.0 <= window * FIT_TRIGGER {
        return current;
    }
    let mut count = applied;
    while count < eligible.len() && units / 4.0 > window * FIT_TARGET {
        units -= saving(eligible[count]);
        count += 1;
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overflow_wordings_are_recognized_and_rate_limits_are_not() {
        assert!(is_context_overflow("openai 400: This model's maximum context length is 8192 tokens"));
        assert!(is_context_overflow("anthropic 400: prompt is too long: 210000 tokens > 200000 maximum"));
        assert!(is_context_overflow("the request exceeds the available context size, try increasing it"));
        assert!(!is_context_overflow("429 rate limit: too many tokens per min"));
        assert!(!is_context_overflow("fetch failed"));
    }

    #[test]
    fn an_overflow_with_numbers_says_the_window_and_the_fix() {
        let raw = r#"Model stream failed: Engine protocol predict request returned 400: {"error":{"code":400,"message":"request (10510 tokens) exceeds the available context size (8192 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":10510,"n_ctx":8192}}"#;
        let said = overflow_message(raw);
        assert!(
            said.starts_with("The model is loaded with a 8192-token context window, and this chat needs 10510 tokens.")
        );
        assert!(is_context_overflow(&said));
        assert_eq!(reported_window(raw), Some(8192.0));
        assert_eq!(overflow_sizes(raw), Some((8192, 10510)));
        assert_eq!(overflow_sizes(&said), Some((8192, 10510)));
        assert_eq!(overflow_sizes("This model's maximum context length is 8192 tokens"), None);
        assert_eq!(reported_window("This model's maximum context length is 8192 tokens"), None);
        let plain = "anthropic 400: prompt is too long";
        assert_eq!(overflow_message(plain), plain);
    }
}
