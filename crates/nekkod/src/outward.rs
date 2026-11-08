//! Who an MCP call writes to: the recipients a chat has not used before ask
//! first, even for a tool the user always allowed (P1 of the agent data
//! security plan, decision 0063).
//!
//! Nekko has no email or chat tools of its own: messages leave through MCP
//! servers (Gmail, Slack, Linear, Telegram...), whose tools name their
//! recipient in an argument. Those arguments are found by name, at any depth,
//! so `{ "to": "a@b.c" }`, `{ "message": { "channel": "general" } }` and
//! `{ "recipients": ["x", "y"] }` all count. A value is compared trimmed and
//! case-folded, so `Ops@Example.com` and `ops@example.com` are one recipient.

use serde_json::Value;

/// Argument names that hold who a message goes to.
const RECIPIENT_KEYS: &[&str] = &[
    "to",
    "cc",
    "bcc",
    "recipient",
    "recipients",
    "email",
    "emails",
    "address",
    "addresses",
    "channel",
    "channel_id",
    "channelid",
    "channels",
    "chat_id",
    "chatid",
    "conversation",
    "conversation_id",
    "user",
    "user_id",
    "userid",
    "users",
    "phone",
    "phone_number",
    "number",
    "webhook",
    "webhook_url",
];

/// Whether an argument name holds who a message goes to.
pub fn is_recipient_key(key: &str) -> bool {
    RECIPIENT_KEYS.contains(&key.to_ascii_lowercase().replace('-', "_").as_str())
}

/// The recipients a call's input names, each once, as compared.
pub fn recipients(input: &Value) -> Vec<String> {
    let mut out = Vec::new();
    walk(input, 0, &mut out);
    out
}

fn walk(v: &Value, depth: usize, out: &mut Vec<String>) {
    if depth > 6 {
        return;
    }
    match v {
        Value::Object(map) => {
            for (k, child) in map {
                let key = k.to_ascii_lowercase().replace('-', "_");
                if RECIPIENT_KEYS.contains(&key.as_str()) {
                    collect(child, out);
                } else {
                    walk(child, depth + 1, out);
                }
            }
        }
        Value::Array(items) => items.iter().for_each(|i| walk(i, depth + 1, out)),
        _ => {}
    }
}

/// Strings, numbers, lists of them, or `{ "email": ... }`-style objects.
fn collect(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::String(s) => {
            // "a@b.c, d@e.f" is two recipients.
            for part in s.split([',', ';']) {
                push(part, out);
            }
        }
        Value::Number(n) => push(&n.to_string(), out),
        Value::Array(items) => items.iter().for_each(|i| collect(i, out)),
        Value::Object(_) => walk(v, 0, out),
        _ => {}
    }
}

fn push(raw: &str, out: &mut Vec<String>) {
    let r = normalize(raw);
    if !r.is_empty() && !out.contains(&r) {
        out.push(r);
    }
}

/// One spelling per recipient.
pub fn normalize(raw: &str) -> String {
    raw.trim().trim_start_matches('#').trim().to_lowercase()
}

/// The recipients of `input` that `known` does not hold.
pub fn unknown(input: &Value, known: &[String]) -> Vec<String> {
    recipients(input).into_iter().filter(|r| !known.contains(r)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn finds_recipients_by_argument_name_at_any_depth() {
        assert_eq!(recipients(&json!({ "to": "Ops@Example.com", "subject": "hi" })), ["ops@example.com"]);
        assert_eq!(recipients(&json!({ "message": { "channel": "#General" } })), ["general"]);
        assert_eq!(
            recipients(&json!({ "recipients": ["a@b.c", { "email": "d@e.f" }], "cc": "a@b.c; x@y.z" })),
            ["a@b.c", "d@e.f", "x@y.z"]
        );
        assert_eq!(recipients(&json!({ "chat_id": 12345 })), ["12345"]);
        assert!(recipients(&json!({ "query": "to: someone", "text": "hello" })).is_empty());
    }

    #[test]
    fn a_known_recipient_does_not_count_twice() {
        let known = vec!["general".to_string()];
        assert!(unknown(&json!({ "channel": "General" }), &known).is_empty());
        assert_eq!(unknown(&json!({ "channel": "random" }), &known), ["random"]);
    }
}
