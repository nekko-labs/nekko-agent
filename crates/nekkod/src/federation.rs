//! How one window shows chats from several computers: a chat on another
//! computer has the id `@<computerId>:<rawId>`. The window treats that as an
//! opaque string, so its store and components need no second code path. Here a
//! call carrying one is sent to that computer, and what comes back is qualified.
//!
//! A channel that may cross is listed in [`ROUTED`]. A foreign id on any other
//! channel is refused, so a new channel can never reach the local store with one.

use serde_json::Value;

/// The channels a window may send to another computer with a qualified id. The
/// other computer's gate still decides each one.
pub const ROUTED: &[&str] = &[
    "agent:replay",
    "attachment:import",
    "changes:accept",
    "changes:acceptAll",
    "changes:list",
    "chat:abort",
    "chat:answer",
    "chat:cancelCompaction",
    "chat:compact",
    "chat:dequeue",
    "chat:editQueued",
    "chat:interruptQueued",
    "chat:queue",
    "chat:send",
    "chat:steer",
    "context:preview",
    "files:list",
    "files:read",
    "files:search",
    "files:write",
    "limits:get",
    "models:list",
    "pr:sessionList",
    "session:delete",
    "session:fork",
    "session:get",
    "session:images",
    "session:page",
    "session:setAttachments",
    "session:setOptions",
    "session:truncate",
    "session:watches",
    "tool:approve",
];

/// These answer when the whole turn is over.
pub const LONG: &[&str] = &["chat:send", "chat:interruptQueued", "chat:compact"];

/// The keys that hold a chat's, a folder's or a provider's id, in replies and events.
const ID_KEYS: &[&str] = &["sessionId", "parentSessionId", "workspaceId", "newSessionId", "providerId"];

/// The local form of an id on `computer`.
pub fn qualify(computer: &str, raw: &str) -> String {
    format!("@{computer}:{raw}")
}

/// `(computer, raw id)` of a qualified id. A local id never starts with `@`.
pub fn split(id: &str) -> Option<(&str, &str)> {
    id.strip_prefix('@')?.split_once(':')
}

/// The chat or folder a call is about: its first argument, or that argument's id field.
fn subject(args: &[Value]) -> Option<&str> {
    let first = args.first()?;
    first.as_str().or_else(|| ["sessionId", "workspaceId", "providerId"].iter().find_map(|k| first.get(k)?.as_str()))
}

/// Where a call goes.
#[derive(Debug, PartialEq)]
pub enum Route {
    Local,
    /// To this computer, with the arguments' ids made raw again.
    Remote(String, Vec<Value>),
    Refused(String),
}

pub fn route(channel: &str, args: &[Value]) -> Route {
    let Some((computer, _)) = subject(args).and_then(split) else { return Route::Local };
    if !ROUTED.contains(&channel) {
        return Route::Refused(format!("{channel} works on this computer only. Do this on that computer."));
    }
    let computer = computer.to_string();
    let mut args = args.to_vec();
    if let Some(first) = args.first_mut() {
        unqualify(&computer, first);
    }
    Route::Remote(computer, args)
}

fn unqualify(computer: &str, v: &mut Value) {
    let raw = |s: &str| split(s).filter(|(c, _)| *c == computer).map(|(_, r)| r.to_string());
    match v {
        Value::String(s) => {
            if let Some(r) = raw(s) {
                *s = r;
            }
        }
        Value::Object(o) => {
            for key in ID_KEYS {
                if let Some(Value::String(s)) = o.get_mut(*key)
                    && let Some(r) = raw(s)
                {
                    *s = r;
                }
            }
        }
        _ => {}
    }
}

/// Qualify every chat and folder id in `v`, the reply or event from `computer`.
/// A transcript's messages keep theirs: nothing here looks chats up by them.
pub fn qualify_ids(computer: &str, v: &mut Value) {
    match v {
        Value::Object(o) => {
            for (key, value) in o.iter_mut() {
                match value {
                    // Always: a host's ids are raw, and one that came with `@` must not pass as another computer's.
                    Value::String(s) if ID_KEYS.contains(&key.as_str()) => {
                        *s = qualify(computer, s);
                    }
                    Value::Array(list) if key == "supportingWorkspaceIds" => {
                        for id in list.iter_mut() {
                            if let Value::String(s) = id {
                                *s = qualify(computer, s);
                            }
                        }
                    }
                    Value::Array(_) if key == "messages" => {}
                    Value::Object(_) | Value::Array(_) => qualify_ids(computer, value),
                    _ => {}
                }
            }
        }
        Value::Array(list) => {
            for item in list {
                qualify_ids(computer, item);
            }
        }
        _ => {}
    }
}

/// The same for a chat or a list of chats, whose own `id` is qualified too.
pub fn qualify_chats(computer: &str, v: &mut Value) {
    match v {
        Value::Array(list) => {
            for chat in list {
                qualify_chats(computer, chat);
            }
        }
        Value::Object(o) => {
            if let Some(Value::String(id)) = o.get_mut("id") {
                *id = qualify(computer, id);
            }
            qualify_ids(computer, v);
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_local_id_stays_local() {
        assert_eq!(route("session:get", &[json!("s_abc")]), Route::Local);
        assert_eq!(route("session:create", &[]), Route::Local);
        assert_eq!(route("settings:update", &[json!({ "theme": "dark" })]), Route::Local);
    }

    #[test]
    fn a_foreign_id_goes_to_its_computer_with_a_raw_id() {
        assert_eq!(
            route("session:get", &[json!("@gomi1234:s_abc")]),
            Route::Remote("gomi1234".into(), vec![json!("s_abc")])
        );
        assert_eq!(
            route("chat:send", &[json!({ "sessionId": "@gomi1234:s_abc", "text": "hi @gomi1234:not-an-id" })]),
            Route::Remote("gomi1234".into(), vec![json!({ "sessionId": "s_abc", "text": "hi @gomi1234:not-an-id" })])
        );
        assert_eq!(
            route("tool:approve", &[json!("@gomi1234:s_abc"), json!("call_1"), json!(true)]),
            Route::Remote("gomi1234".into(), vec![json!("s_abc"), json!("call_1"), json!(true)])
        );
    }

    #[test]
    fn a_foreign_id_on_an_unlisted_channel_is_refused() {
        for channel in ["providers:save", "file:read", "workspace:remove", "brand:new"] {
            assert!(matches!(route(channel, &[json!("@gomi1234:s_abc")]), Route::Refused(_)), "{channel}");
        }
    }

    #[test]
    fn replies_and_events_come_back_qualified() {
        let mut chat = json!({
            "id": "s1",
            "workspaceId": "w1",
            "parentSessionId": "s0",
            "supportingWorkspaceIds": ["w2"],
            "messages": [{ "id": "m1", "sessionId": "kept" }],
        });
        qualify_chats("gomi1234", &mut chat);
        assert_eq!(chat["id"], "@gomi1234:s1");
        assert_eq!(chat["workspaceId"], "@gomi1234:w1");
        assert_eq!(chat["parentSessionId"], "@gomi1234:s0");
        assert_eq!(chat["supportingWorkspaceIds"][0], "@gomi1234:w2");
        assert_eq!(chat["messages"][0]["id"], "m1");

        let mut event = json!({ "type": "compaction", "sessionId": "s1", "progress": { "newSessionId": "s2" } });
        qualify_ids("gomi1234", &mut event);
        assert_eq!(event["sessionId"], "@gomi1234:s1");
        assert_eq!(event["progress"]["newSessionId"], "@gomi1234:s2");
    }

    #[test]
    fn a_computer_cannot_pass_its_chat_off_as_another_computers() {
        let mut chat = json!({ "id": "@studio99:s1", "workspaceId": "@studio99:w1" });
        qualify_chats("gomi1234", &mut chat);
        assert_eq!(split(chat["id"].as_str().unwrap()).unwrap().0, "gomi1234");
        assert_eq!(split(chat["workspaceId"].as_str().unwrap()).unwrap().0, "gomi1234");
    }
}
