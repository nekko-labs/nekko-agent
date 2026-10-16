//! The Bot API as `packages/host/src/messaging/telegram.ts` speaks it: every
//! method a `POST` of a JSON body to `<root>/bot<token>/<method>`, and the
//! `{ ok, result, description }` reply.

use serde_json::{Map, Value, json};

/// Where the Bot API is unless the daemon's config says otherwise.
pub const DEFAULT_API_ROOT: &str = "https://api.telegram.org";

/// Max body Telegram will accept in one message (`TELEGRAM_MESSAGE_LIMIT`).
pub const MESSAGE_LIMIT: usize = 4096;

/// `cutForTelegram`: the first 4096 UTF-16 units, stopping before a
/// character the cut would split.
pub fn cut(text: &str) -> &str {
    nekko_js::slice16(text, MESSAGE_LIMIT)
}

/// `${apiRoot}/bot${token}/${method}`.
pub fn url(api_root: &str, token: &Value, method: &str) -> String {
    format!("{api_root}/bot{}/{method}", nekko_js::display(token))
}

/// The body `call` sends: `JSON.stringify(body)`, or `{}` without one.
pub fn body_text(body: Option<&Value>) -> String {
    body.map_or_else(|| "{}".to_string(), nekko_js::stringify)
}

/// `getUpdates(offset, 25, 50)`.
pub fn get_updates(offset: &Value, timeout_sec: u64) -> Value {
    json!({ "offset": offset, "timeout": timeout_sec, "limit": 50 })
}

/// `sendMessage(chatId, text, keyboard)`; the keyboard only when it has rows.
pub fn send_message(chat_id: &str, text: &str, keyboard: Option<Value>) -> Value {
    let mut body = Map::new();
    body.insert("chat_id".into(), json!(chat_id));
    body.insert("text".into(), json!(cut(text)));
    if let Some(rows) = keyboard.filter(|k| k.as_array().is_some_and(|a| !a.is_empty())) {
        body.insert("reply_markup".into(), json!({ "inline_keyboard": rows }));
    }
    Value::Object(body)
}

/// `editMessageText(chatId, messageId, text)`.
pub fn edit_message_text(chat_id: &str, message_id: &Value, text: &str) -> Value {
    json!({ "chat_id": chat_id, "message_id": message_id, "text": cut(text) })
}

/// `answerCallbackQuery(id, text)`; the text only when it is truthy.
pub fn answer_callback_query(callback_query_id: &Value, text: Option<&Value>) -> Value {
    let mut body = Map::new();
    body.insert("callback_query_id".into(), callback_query_id.clone());
    if let Some(t) = text.filter(|t| nekko_js::truthy(Some(t))) {
        body.insert("text".into(), t.clone());
    }
    Value::Object(body)
}

/// What `call` makes of a reply: the result when `ok`, else
/// `telegram <method>: <description ?? status>`. A body that is not JSON is
/// an error too (worded by the parser, where Node's said `Unexpected token`).
pub fn reply(method: &str, status: u16, body: &[u8]) -> Result<Value, String> {
    let data: Value = serde_json::from_slice(body).map_err(|e| e.to_string())?;
    if nekko_js::truthy(data.get("ok")) {
        return Ok(data.get("result").cloned().unwrap_or(Value::Null));
    }
    let why = match data.get("description").filter(|d| !d.is_null()) {
        Some(d) => nekko_js::display(d),
        None => status.to_string(),
    };
    Err(format!("telegram {method}: {why}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_are_shaped_as_the_ts_client_sends_them() {
        assert_eq!(url("http://127.0.0.1:9", &json!("123:TEST"), "getMe"), "http://127.0.0.1:9/bot123:TEST/getMe");
        assert_eq!(body_text(None), "{}");
        assert_eq!(body_text(Some(&get_updates(&json!(5), 25))), r#"{"offset":5,"timeout":25,"limit":50}"#);
        assert_eq!(body_text(Some(&send_message("42", "hi", Some(json!([]))))), r#"{"chat_id":"42","text":"hi"}"#);
        assert_eq!(
            body_text(Some(&answer_callback_query(&json!("q"), Some(&json!(""))))),
            r#"{"callback_query_id":"q"}"#
        );
        let long = format!("{}\u{1F600}", "a".repeat(4095));
        assert_eq!(cut(&long).len(), 4095);
    }

    #[test]
    fn replies_are_read_as_the_ts_client_reads_them() {
        assert_eq!(reply("getMe", 200, br#"{"ok":true,"result":{"username":"b"}}"#), Ok(json!({ "username": "b" })));
        assert_eq!(reply("getMe", 200, br#"{"ok":true}"#), Ok(Value::Null));
        assert_eq!(
            reply("getUpdates", 409, br#"{"ok":false,"description":"Conflict"}"#),
            Err("telegram getUpdates: Conflict".into())
        );
        assert_eq!(reply("sendMessage", 502, br#"{"ok":false}"#), Err("telegram sendMessage: 502".into()));
        assert!(reply("getMe", 502, b"<html>").is_err());
    }
}
