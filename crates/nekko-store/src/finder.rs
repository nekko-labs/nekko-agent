//! A chat's searchable text, for the chat finder and the command palette.
//!
//! The finder matches user and assistant message text and the files a chat
//! produced. It never needs pictures, videos, reasoning or tool output, which
//! are most of a long chat's bytes. This reads a chat file and keeps only what
//! the finder's index reads (the renderer's `indexChat` and `sessionArtifacts`):
//! each user or assistant message's id, role, text, time and skill input, and
//! of each tool call its name and the two arguments that can name a file
//! (`path`, `file_path`). Everything else is skipped while parsing, never built.

use serde::Deserialize;
use serde::de::{Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;
use std::time::SystemTime;

/// Text kept in memory before the cache starts over (the views are text only,
/// so this holds many thousands of chats).
const CACHE_BYTES: usize = 128 * 1024 * 1024;

/// One value read as a string, anything else (or a missing key) as `None`.
#[derive(Default)]
struct Str(Option<String>);

/// One value read as a number, anything else as `None`.
#[derive(Default)]
struct Num(Option<f64>);

macro_rules! lenient {
    ($ty:ident, $inner:ty, $($visit:ident($arg:ty) => $body:expr),*) => {
        impl<'de> Deserialize<'de> for $ty {
            fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                struct V;
                impl<'de> Visitor<'de> for V {
                    type Value = $ty;
                    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                        f.write_str("any JSON value")
                    }
                    $(fn $visit<E>(self, v: $arg) -> Result<$ty, E> { Ok($ty($body(v))) })*
                    fn visit_unit<E>(self) -> Result<$ty, E> {
                        Ok($ty(None))
                    }
                    fn visit_bool<E>(self, _: bool) -> Result<$ty, E> {
                        Ok($ty(None))
                    }
                    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<$ty, A::Error> {
                        while seq.next_element::<IgnoredAny>()?.is_some() {}
                        Ok($ty(None))
                    }
                    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<$ty, A::Error> {
                        while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                        Ok($ty(None))
                    }
                }
                d.deserialize_any(V)
            }
        }
    };
}

lenient!(Str, String, visit_str(&str) => |v: &str| Some(v.to_string()), visit_string(String) => Some,
    visit_i64(i64) => |_| None, visit_u64(u64) => |_| None, visit_f64(f64) => |_| None);
lenient!(Num, f64, visit_i64(i64) => |v| Some(v as f64), visit_u64(u64) => |v| Some(v as f64), visit_f64(f64) => Some,
    visit_str(&str) => |_| None);

/// A tool call's arguments, keeping only the two that can name a file.
#[derive(Default)]
struct Input {
    path: Option<String>,
    file_path: Option<String>,
}

impl<'de> Deserialize<'de> for Input {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Input;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("any JSON value")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Input, A::Error> {
                let mut out = Input::default();
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "path" => out.path = map.next_value::<Str>()?.0,
                        "file_path" => out.file_path = map.next_value::<Str>()?.0,
                        _ => {
                            map.next_value::<IgnoredAny>()?;
                        }
                    }
                }
                Ok(out)
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Input, A::Error> {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(Input::default())
            }
            fn visit_str<E>(self, _: &str) -> Result<Input, E> {
                Ok(Input::default())
            }
            fn visit_unit<E>(self) -> Result<Input, E> {
                Ok(Input::default())
            }
            fn visit_bool<E>(self, _: bool) -> Result<Input, E> {
                Ok(Input::default())
            }
            fn visit_i64<E>(self, _: i64) -> Result<Input, E> {
                Ok(Input::default())
            }
            fn visit_u64<E>(self, _: u64) -> Result<Input, E> {
                Ok(Input::default())
            }
            fn visit_f64<E>(self, _: f64) -> Result<Input, E> {
                Ok(Input::default())
            }
        }
        d.deserialize_any(V)
    }
}

/// A message's tool calls; anything but an array of them reads as none.
#[derive(Default)]
struct Calls(Vec<Call>);

impl<'de> Deserialize<'de> for Calls {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Calls;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("any JSON value")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Calls, A::Error> {
                let mut out = Vec::new();
                while let Some(call) = seq.next_element::<Call>()? {
                    out.push(call);
                }
                Ok(Calls(out))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Calls, A::Error> {
                while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(Calls::default())
            }
            fn visit_str<E>(self, _: &str) -> Result<Calls, E> {
                Ok(Calls::default())
            }
            fn visit_unit<E>(self) -> Result<Calls, E> {
                Ok(Calls::default())
            }
            fn visit_bool<E>(self, _: bool) -> Result<Calls, E> {
                Ok(Calls::default())
            }
            fn visit_i64<E>(self, _: i64) -> Result<Calls, E> {
                Ok(Calls::default())
            }
            fn visit_u64<E>(self, _: u64) -> Result<Calls, E> {
                Ok(Calls::default())
            }
            fn visit_f64<E>(self, _: f64) -> Result<Calls, E> {
                Ok(Calls::default())
            }
        }
        d.deserialize_any(V)
    }
}

#[derive(Deserialize, Default)]
struct Call {
    #[serde(default)]
    name: Str,
    #[serde(default)]
    input: Input,
}

#[derive(Deserialize, Default)]
struct Skill {
    #[serde(default)]
    input: Str,
}

#[derive(Deserialize, Default)]
struct Message {
    #[serde(default)]
    id: Str,
    #[serde(default)]
    role: Str,
    #[serde(default)]
    content: Str,
    #[serde(default, rename = "createdAt")]
    created_at: Num,
    #[serde(default)]
    skill: Option<Skill>,
    #[serde(default, rename = "toolCalls")]
    tool_calls: Calls,
}

#[derive(Deserialize, Default)]
struct Worktree {
    #[serde(default)]
    path: Str,
}

#[derive(Deserialize, Default)]
struct Chat {
    #[serde(default)]
    id: Str,
    #[serde(default)]
    title: Str,
    #[serde(default, rename = "updatedAt")]
    updated_at: Num,
    #[serde(default, rename = "workspaceId")]
    workspace_id: Str,
    #[serde(default, rename = "gitWorktrees")]
    git_worktrees: Option<HashMap<String, Worktree>>,
    #[serde(default)]
    messages: Option<Vec<Message>>,
}

fn call_json(call: &Call) -> Option<Value> {
    let mut input = Map::new();
    if let Some(p) = &call.input.path {
        input.insert("path".into(), json!(p));
    }
    if let Some(p) = &call.input.file_path {
        input.insert("file_path".into(), json!(p));
    }
    // A call that names no file cannot make an artifact: leave it out.
    (!input.is_empty()).then(|| json!({ "name": call.name.0.clone().unwrap_or_default(), "input": input }))
}

/// The finder's view of one chat file's bytes, or `None` when it is not a chat
/// with a transcript. A shape the finder's index would read the same as the
/// full chat: only user and assistant messages with text or a file-naming tool
/// call survive, in order.
pub fn text_view(bytes: &[u8]) -> Option<Value> {
    let chat: Chat = serde_json::from_slice(bytes).ok()?;
    let messages = chat.messages?;
    let mut out = Vec::with_capacity(messages.len());
    for m in &messages {
        let role = m.role.0.as_deref().unwrap_or_default();
        if role != "user" && role != "assistant" {
            continue;
        }
        let content = m.content.0.clone().unwrap_or_default();
        let calls: Vec<Value> =
            if role == "assistant" { m.tool_calls.0.iter().filter_map(call_json).collect() } else { Vec::new() };
        let skill_input = m.skill.as_ref().and_then(|s| s.input.0.clone()).filter(|s| !s.is_empty());
        if content.trim().is_empty() && calls.is_empty() {
            continue;
        }
        let mut msg = json!({ "id": m.id.0, "role": role, "content": content, "createdAt": m.created_at.0 });
        if let Some(input) = skill_input {
            msg["skill"] = json!({ "input": input });
        }
        if !calls.is_empty() {
            msg["toolCalls"] = Value::Array(calls);
        }
        out.push(msg);
    }
    let mut view = json!({
        "id": chat.id.0,
        "title": chat.title.0.unwrap_or_default(),
        "updatedAt": chat.updated_at.0,
        "workspaceId": chat.workspace_id.0,
        "messages": out,
    });
    // `basePathOf` reads only the primary folder's checkout.
    if let (Some(ws), Some(trees)) = (view["workspaceId"].as_str().map(str::to_string), &chat.git_worktrees)
        && let Some(path) = trees.get(&ws).and_then(|w| w.path.0.as_deref())
    {
        view["gitWorktrees"] = json!({ ws: { "path": path } });
    }
    Some(view)
}

/// About how many bytes a view holds: its messages' text and file names.
fn weight(view: &Value) -> usize {
    let text = |v: &Value| v.as_str().map_or(0, str::len);
    let mut n = 256;
    for m in view["messages"].as_array().into_iter().flatten() {
        n += 96 + text(&m["content"]) + text(&m["skill"]["input"]);
        for c in m["toolCalls"].as_array().into_iter().flatten() {
            n += 64 + text(&c["input"]["path"]) + text(&c["input"]["file_path"]);
        }
    }
    n
}

/// A view, the file stamp (mtime, size) it was made for, and its weight.
type Cached = ((SystemTime, u64), Arc<Value>, usize);

/// A chat file as it stood when its view was made.
#[derive(Default)]
pub(crate) struct ViewCache {
    entries: HashMap<String, Cached>,
    bytes: usize,
}

impl ViewCache {
    pub(crate) fn get(&self, id: &str, stamp: (SystemTime, u64)) -> Option<Arc<Value>> {
        self.entries.get(id).filter(|(s, _, _)| *s == stamp).map(|(_, v, _)| v.clone())
    }

    pub(crate) fn put(&mut self, id: &str, stamp: (SystemTime, u64), view: Arc<Value>) {
        let size = weight(&view);
        if let Some((_, _, old)) = self.entries.remove(id) {
            self.bytes -= old;
        }
        if self.bytes + size > CACHE_BYTES {
            self.entries.clear();
            self.bytes = 0;
        }
        self.bytes += size;
        self.entries.insert(id.to_string(), (stamp, view, size));
    }

    pub(crate) fn forget(&mut self, id: &str) {
        if let Some((_, _, old)) = self.entries.remove(id) {
            self.bytes -= old;
        }
    }
}
