//! `sessions:finderText` for a phone's chat search (#3448), as
//! `phoneFinderTextView` in packages/shared/src/phone-access.ts: what each
//! asked chat said, cut to `PHONE_FINDER_VIEW`, so a phrase from the middle of
//! a chat is found without downloading its transcript.

use serde_json::{Map, Value};

/// `PHONE_FINDER_VIEW`.
#[derive(Debug, Clone, Copy, Default)]
pub struct Limits {
    /// Most chats one call asks for.
    pub chats: usize,
    /// Newest messages kept per chat.
    pub messages: usize,
    /// A message's text, in UTF-16 units.
    pub text_chars: usize,
    /// File paths kept per message.
    pub files: usize,
    /// The reply's budget in UTF-8 bytes of JSON.
    pub bytes: usize,
}

impl Limits {
    /// Missing numbers keep nothing rather than send a frame too large to arrive.
    pub fn from_policy(v: &Value) -> Limits {
        let n = |k: &str| v[k].as_u64().unwrap_or(0) as usize;
        Limits {
            chats: n("chats"),
            messages: n("messages"),
            text_chars: n("textChars"),
            files: n("files"),
            bytes: n("bytes"),
        }
    }
}

/// A refused call's code and what was wrong.
pub type Refusal = (&'static str, &'static str);

/// The chat ids a phone may ask for: one to `chats` non-empty ids, nothing else.
pub fn screen(args: &[Value], limits: &Limits) -> Result<(), Refusal> {
    let ids = args.first().and_then(Value::as_array).ok_or(("value-invalid", "chat ids"))?;
    if ids.is_empty() || ids.len() > limits.chats {
        return Err(("value-invalid", "chat ids"));
    }
    if !ids.iter().all(|id| id.as_str().is_some_and(|s| !s.is_empty() && s.encode_utf16().count() <= 128)) {
        return Err(("value-invalid", "chat id"));
    }
    if args.len() > 1 {
        return Err(("option-denied", "extra argument"));
    }
    Ok(())
}

fn cut(s: &str, n: usize) -> String {
    crate::hello::cut16(s, n).to_string()
}

fn json_bytes(v: &Value) -> usize {
    serde_json::to_string(v).map_or(0, |s| s.len())
}

/// One message as a phone gets it: its role, text and the file paths its tool calls named.
fn message(m: &Value, limits: &Limits) -> Option<Value> {
    let role = m["role"].as_str().filter(|r| *r == "user" || *r == "assistant")?;
    let parts: Vec<&str> = [m["content"].as_str().unwrap_or(""), m["skill"]["input"].as_str().unwrap_or("")]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect();
    let mut out = Map::new();
    out.insert("role".into(), Value::String(role.into()));
    out.insert("text".into(), Value::String(cut(&parts.join("\n"), limits.text_chars)));
    let files: Vec<Value> = m["toolCalls"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|c| [&c["input"]["path"], &c["input"]["file_path"]])
        .filter_map(Value::as_str)
        .filter(|p| !p.is_empty())
        .take(limits.files)
        .map(|p| Value::String(cut(p, 512)))
        .collect();
    if !files.is_empty() {
        out.insert("files".into(), Value::Array(files));
    }
    Some(Value::Object(out))
}

/// One chat as a phone gets it, or null for a chat the computer doesn't have.
fn chat(c: &Value, limits: &Limits) -> Value {
    let Some(o) = c.as_object() else { return Value::Null };
    let all: &[Value] = o.get("messages").and_then(Value::as_array).map_or(&[], Vec::as_slice);
    let keep = &all[all.len().saturating_sub(limits.messages)..];
    let mut out = Map::new();
    out.insert("title".into(), Value::String(cut(o.get("title").and_then(Value::as_str).unwrap_or(""), 512)));
    out.insert("updatedAt".into(), o.get("updatedAt").filter(|v| v.is_number()).cloned().unwrap_or(Value::Null));
    out.insert("messages".into(), Value::Array(keep.iter().filter_map(|m| message(m, limits)).collect()));
    if all.len() > keep.len() {
        out.insert("omittedMessages".into(), Value::from(all.len() - keep.len()));
    }
    Value::Object(out)
}

/// The reply: chats in the asked order while it fits `bytes`. Later chats wait for the
/// phone's next call; a first chat too large alone drops its oldest messages instead.
pub fn view(result: &Value, limits: &Limits) -> Value {
    let mut out = Map::new();
    let Some(chats) = result.as_object() else { return Value::Object(out) };
    let mut used = 2;
    for (id, c) in chats {
        let mut v = chat(c, limits);
        let key = json_bytes(&Value::String(id.clone())) + 1;
        let mut size = key + json_bytes(&v) + 1;
        if used + size > limits.bytes {
            if !out.is_empty() || v.is_null() {
                break;
            }
            let o = v.as_object_mut().expect("a chat view is an object");
            let messages = o.get("messages").and_then(Value::as_array).cloned().unwrap_or_default();
            let sizes: Vec<usize> = messages.iter().map(|m| json_bytes(m) + 1).collect();
            let mut drop = 0;
            // `omittedMessages` and its count fit in the 32 bytes held back.
            while drop < messages.len() && used + size + 32 > limits.bytes {
                size -= sizes[drop];
                drop += 1;
            }
            let omitted = o.get("omittedMessages").and_then(Value::as_u64).unwrap_or(0) as usize + drop;
            o.insert("messages".into(), Value::Array(messages[drop..].to_vec()));
            o.insert("omittedMessages".into(), Value::from(omitted));
            size = key + json_bytes(&v) + 1;
        }
        out.insert(id.clone(), v);
        used += size;
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn limits() -> Limits {
        crate::phone::policy().finder
    }

    #[test]
    fn screens_the_chat_ids_a_phone_asks_for() {
        let l = limits();
        assert!(screen(&[json!(["s1", "s2"])], &l).is_ok());
        let many: Vec<String> = (0..=l.chats).map(|i| format!("s{i}")).collect();
        for bad in [vec![], vec![json!([])], vec![json!([""])], vec![json!([1])], vec![json!(many)], vec![json!("s1")]]
        {
            assert!(screen(&bad, &l).is_err(), "{bad:?}");
        }
        assert_eq!(screen(&[json!(["s1"]), json!("extra")], &l), Err(("option-denied", "extra argument")));
    }

    #[test]
    fn sends_each_chats_text_and_file_names_only() {
        let l = limits();
        let long = "x".repeat(l.text_chars + 50);
        let result = json!({
            "s1": {
                "id": "s1", "title": "Release notes", "updatedAt": 5, "workspaceId": "w1",
                "gitWorktrees": { "w1": { "path": "/Users/me/app" } },
                "messages": [
                    { "id": "m1", "role": "user", "content": "Group the release notes", "createdAt": 1, "skill": { "input": "by area" } },
                    { "id": "m2", "role": "assistant", "content": long, "createdAt": 2,
                      "toolCalls": [{ "name": "write_file", "input": { "path": "NOTES.md" } }, { "name": "edit", "input": { "file_path": "src/a.ts" } }] },
                    { "id": "m3", "role": "tool", "content": "tool output" }
                ]
            },
            "gone": null
        });
        let view = view(&result, &l);
        assert_eq!(view.as_object().unwrap().keys().collect::<Vec<_>>(), ["s1", "gone"]);
        assert_eq!(view["gone"], Value::Null);
        assert_eq!(
            view["s1"],
            json!({
                "title": "Release notes", "updatedAt": 5,
                "messages": [
                    { "role": "user", "text": "Group the release notes\nby area" },
                    { "role": "assistant", "text": "x".repeat(l.text_chars), "files": ["NOTES.md", "src/a.ts"] }
                ]
            })
        );
        assert_eq!(super::view(&Value::Null, &l), json!({}));
    }

    #[test]
    fn keeps_the_reply_under_its_byte_budget() {
        let l = limits();
        let big = |n: usize, ch: &str| {
            let messages: Vec<Value> = (0..n)
                .map(|i| json!({ "role": "user", "content": format!("{i} {}", ch.repeat(l.text_chars - 10)) }))
                .collect();
            json!({ "title": "t", "updatedAt": 1, "messages": messages })
        };
        let per_chat = l.bytes.div_ceil(3 * l.text_chars);
        let result = json!({ "a": big(per_chat, "y"), "b": big(per_chat, "y"), "c": big(per_chat, "y"), "d": big(per_chat, "y") });
        let v = view(&result, &l);
        assert_eq!(v.as_object().unwrap().keys().collect::<Vec<_>>(), ["a", "b"]);
        assert!(json_bytes(&v) <= l.bytes);
        // Three UTF-8 bytes a character: 300 full messages are over the budget on their own.
        let one = view(&json!({ "h": big(l.messages, "€"), "next": big(1, "y") }), &l);
        assert_eq!(one.as_object().unwrap().keys().next().map(String::as_str), Some("h"));
        assert!(json_bytes(&one) <= l.bytes);
        let h = &one["h"];
        assert_eq!(
            h["omittedMessages"].as_u64().unwrap() as usize + h["messages"].as_array().unwrap().len(),
            l.messages
        );
        assert!(
            h["messages"].as_array().unwrap().last().unwrap()["text"]
                .as_str()
                .unwrap()
                .starts_with(&format!("{} ", l.messages - 1))
        );
    }
}
