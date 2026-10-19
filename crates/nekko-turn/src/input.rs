//! `applyTurnInput`, `titlePrompt`, `cleanTitle` and `sendOptionsForQueuedItem` (turn-plan.ts).

use crate::truthy;
use nekko_js as js;
use nekko_store::client_ids::{client_message_id_of, remember_client_message_ids};
use serde_json::{Map, Value, json};

fn base36(mut n: u64) -> String {
    const D: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(D[(n % 36) as usize]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

fn role(m: &Value) -> &str {
    m.get("role").and_then(Value::as_str).unwrap_or_default()
}

fn content(m: &Value) -> &str {
    m.get("content").and_then(Value::as_str).unwrap_or_default()
}

/// Put the user's input into `session`'s transcript, as `applyTurnInput` does.
pub fn apply_turn_input(session: &mut Value, opts: &Value, now: u64) {
    let Some(s) = session.as_object_mut() else { return };
    if !s.get("messages").is_some_and(Value::is_array) {
        s.insert("messages".into(), json!([]));
    }
    let resume = truthy(opts, "resume");
    let text = opts.get("text").and_then(Value::as_str).unwrap_or_default();
    let images = opts.get("images").and_then(Value::as_array).filter(|a| !a.is_empty());
    let videos = opts.get("videos").and_then(Value::as_array).filter(|a| !a.is_empty());
    {
        let Some(Value::Array(messages)) = s.get_mut("messages") else { return };
        if resume {
            nekko_loop::repair_interrupted_history(messages);
        }
    }
    if truthy(opts, "regenerate") && !resume {
        let Some(Value::Array(messages)) = s.get_mut("messages") else { return };
        while let Some(last) = messages.last() {
            if role(last) == "user" || truthy(last, "compaction") {
                break;
            }
            messages.pop();
        }
    } else if !resume || !js::trim(text).is_empty() || images.is_some() || videos.is_some() {
        let mut msg = Map::new();
        msg.insert("id".into(), json!(format!("msg_{}", base36(now))));
        msg.insert("role".into(), json!("user"));
        if let Some(text) = opts.get("text").filter(|v| !v.is_null()) {
            msg.insert("content".into(), text.clone());
        }
        msg.insert("createdAt".into(), json!(now));
        if let Some(images) = images {
            msg.insert("images".into(), Value::Array(images.clone()));
        }
        if let Some(videos) = videos {
            msg.insert("videos".into(), Value::Array(videos.clone()));
        }
        if let Some(skill) = opts.get("skill").filter(|v| js::truthy(Some(v))) {
            msg.insert("skill".into(), skill.clone());
        }
        if let Some(Value::Array(messages)) = s.get_mut("messages") {
            messages.push(Value::Object(msg));
        }
        if s.get("title").and_then(Value::as_str) == Some("New chat") {
            let title = js::slice16(text, 48);
            s.insert("title".into(), json!(if title.is_empty() { "New chat" } else { title }));
            s.insert("titleAuto".into(), json!(true));
        }
    }
    s.insert("providerId".into(), opts.get("providerId").cloned().unwrap_or(Value::Null));
    s.insert("modelId".into(), opts.get("modelId").cloned().unwrap_or(Value::Null));
    // Saved in the same write as the user turn, so a resend of it is answered without a second turn.
    if let Some(id) = client_message_id_of(opts.get("clientMessageId")) {
        let ids = remember_client_message_ids(s.get("clientMessageIds"), &[id.to_string()]);
        s.insert("clientMessageIds".into(), ids);
    }
}

/// `titlePrompt(messages)`: the title request, or `None` with nothing to name the chat from.
pub fn title_prompt(messages: &[Value]) -> Option<String> {
    let user = messages.iter().find(|m| role(m) == "user").map(content).unwrap_or_default();
    if js::trim(user).is_empty() {
        return None;
    }
    let assistant = messages
        .iter()
        .rev()
        .find(|m| role(m) == "assistant" && !js::trim(content(m)).is_empty())
        .map(content)
        .unwrap_or_default();
    let mut out = format!(
        "Give this task a short title, 3 to 6 words, for a workspace card. Answer with only the title: no quotes, no trailing punctuation.\n\nRequest: {}",
        js::slice16(user, 600)
    );
    if !assistant.is_empty() {
        out.push_str(&format!("\nWhat was done: {}", js::slice16(assistant, 240)));
    }
    Some(out)
}

/// `cleanTitle(out)`: a model's title answer, cleaned; empty keeps the placeholder.
pub fn clean_title(out: &str) -> String {
    let unquoted: String = out.chars().filter(|c| !matches!(c, '"' | '\'' | '`')).collect();
    let folded = js::fold_space(&unquoted);
    let trimmed = folded.trim_end_matches(['.', '!', '?', ':', ';', '-', '\u{2013}', '\u{2014}']);
    js::slice16(js::trim(trimmed), 64).to_string()
}

/// `sendOptionsForQueuedItem(base, item)`: `{ ...base, text, images, videos, skill }` from a queued prompt.
pub fn send_options_for_queued_item(base: &Value, item: &Value) -> Value {
    let mut out = base.as_object().cloned().unwrap_or_default();
    let (text, images, videos, skill) = match item {
        Value::String(s) => (json!(s), None, None, None),
        other => (
            other.get("text").cloned().unwrap_or(Value::Null),
            other.get("images").filter(|v| !v.is_null()).cloned(),
            other.get("videos").filter(|v| !v.is_null()).cloned(),
            other.get("skill").filter(|v| !v.is_null()).cloned(),
        ),
    };
    out.insert("text".into(), text);
    for (key, value) in [("images", images), ("videos", videos), ("skill", skill)] {
        match value {
            Some(v) => {
                out.insert(key.into(), v);
            }
            None => {
                out.shift_remove(key);
            }
        }
    }
    Value::Object(out)
}
