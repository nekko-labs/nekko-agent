//! The `clientMessageId`s a chat remembers (`clientMessageIdOf`,
//! `hasClientMessageId`, `rememberClientMessageIds` in shared/chat.ts), so a
//! resend from a phone's outbox after a dropped connection is answered without
//! a second turn or queue entry.

use serde_json::Value;

/// How many `clientMessageId`s a chat remembers (`CLIENT_MESSAGE_IDS_KEPT`).
pub const CLIENT_MESSAGE_IDS_KEPT: usize = 200;

/// `clientMessageIdOf`: a short id of letters, digits, `-` and `_` (a UUID), else `None`.
pub fn client_message_id_of(v: Option<&Value>) -> Option<&str> {
    let id = v?.as_str()?;
    ((1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
        .then_some(id)
}

/// `hasClientMessageId(session, id)`, given the chat's `clientMessageIds`: the chat has already taken this id.
pub fn has_client_message_id(ids: Option<&Value>, id: Option<&str>) -> bool {
    let Some(id) = id else { return false };
    ids.and_then(Value::as_array).is_some_and(|ids| ids.iter().any(|v| v.as_str() == Some(id)))
}

/// `rememberClientMessageIds(ids, add)`: `add` appended (each once, oldest
/// first), cut to the newest [`CLIENT_MESSAGE_IDS_KEPT`].
pub fn remember_client_message_ids(ids: Option<&Value>, add: &[String]) -> Value {
    let mut out: Vec<String> = ids
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    for id in add {
        if !out.contains(id) {
            out.push(id.clone());
        }
    }
    let from = out.len().saturating_sub(CLIENT_MESSAGE_IDS_KEPT);
    Value::Array(out.drain(from..).map(Value::String).collect())
}
