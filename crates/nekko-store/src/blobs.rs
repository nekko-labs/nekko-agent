//! Pictures kept beside the chats instead of inside them.
//!
//! A chat file used to carry every screenshot and photo as a base64 data URL,
//! about a third of all chat bytes here (2026-11-09), and a running turn
//! rewrites its whole file on every save. Now a data URL in a message's
//! `images` or its `toolResult.images` is written once to
//! `sessions/blobs/<sha256>.<ext>`, as its decoded bytes, and the chat file
//! holds `nekko-blob:<sha256>.<ext>` in its place. Reading a chat through the
//! store puts the data URL back, so every caller sees what it always saw.
//!
//! Only a data URL that comes back byte for byte is moved: anything else (an
//! unknown type, parameters, non-canonical base64) stays inline. A reference
//! whose file is missing is left as it is. Files nothing refers to any more
//! are removed by [`SessionStore::gc_blobs`](crate::SessionStore::gc_blobs).

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::ser::{Serialize, SerializeMap, SerializeSeq, Serializer};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub const REF: &str = "nekko-blob:";
/// Smaller pictures stay inline: a file each would cost more than it saves.
const MIN_BYTES: usize = 4 * 1024;
const TYPES: [(&str, &str); 5] = [
    ("image/png", "png"),
    ("image/jpeg", "jpg"),
    ("image/webp", "webp"),
    ("image/gif", "gif"),
    ("image/svg+xml", "svg"),
];

pub fn dir(sessions: &Path) -> PathBuf {
    sessions.join("blobs")
}

/// Whether a file name is one this module writes: 64 hex digits and a known extension.
pub fn valid_name(name: &str) -> bool {
    let Some((hash, ext)) = name.split_once('.') else { return false };
    hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()) && TYPES.iter().any(|(_, e)| *e == ext)
}

/// `nekko-blob:<name>` for a data URL, its bytes written to `dir` if they are
/// not there yet; `None` when it stays inline.
fn store(dir: &Path, url: &str) -> Option<String> {
    if url.len() < MIN_BYTES {
        return None;
    }
    let rest = url.strip_prefix("data:")?;
    let (mime, payload) = rest.split_once(";base64,")?;
    let ext = TYPES.iter().find(|(m, _)| *m == mime)?.1;
    let bytes = STANDARD.decode(payload).ok()?;
    // Moved only when it comes back exactly.
    if STANDARD.encode(&bytes) != payload {
        return None;
    }
    let name = format!("{:x}.{ext}", Sha256::digest(&bytes));
    let path = dir.join(&name);
    if !path.is_file() {
        std::fs::create_dir_all(dir).ok()?;
        crate::write::write_atomic_bytes(&path, &bytes).ok()?;
    }
    Some(format!("{REF}{name}"))
}

/// The data URL a reference stands for, or `None` when it is not one or its file is gone.
fn load(dir: &Path, reference: &str) -> Option<String> {
    let name = reference.strip_prefix(REF)?;
    if !valid_name(name) {
        return None;
    }
    let ext = name.rsplit('.').next()?;
    let mime = TYPES.iter().find(|(_, e)| *e == ext)?.0;
    let bytes = std::fs::read(dir.join(name)).ok()?;
    Some(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

/// Each string of an `images` array changed by `f`, or `None` when none changed.
fn map_images(images: &Value, f: &impl Fn(&str) -> Option<String>) -> Option<Value> {
    let list = images.as_array()?;
    let mut changed = false;
    let out: Vec<Value> = list
        .iter()
        .map(|v| match v.as_str().and_then(f) {
            Some(s) => {
                changed = true;
                Value::String(s)
            }
            None => v.clone(),
        })
        .collect();
    changed.then_some(Value::Array(out))
}

/// A message with `f` applied to its pictures, or `None` when it has none to change.
fn map_message(msg: &Value, f: &impl Fn(&str) -> Option<String>) -> Option<Value> {
    let obj = msg.as_object()?;
    let own = obj.get("images").and_then(|i| map_images(i, f));
    let tool = obj
        .get("toolResult")
        .and_then(Value::as_object)
        .and_then(|t| t.get("images").and_then(|i| map_images(i, f)).map(|images| (t, images)));
    if own.is_none() && tool.is_none() {
        return None;
    }
    let mut out = Map::with_capacity(obj.len());
    for (k, v) in obj {
        let v = match (k.as_str(), &own, &tool) {
            ("images", Some(images), _) => images.clone(),
            ("toolResult", _, Some((t, images))) => {
                let mut t = (*t).clone();
                t.insert("images".into(), images.clone());
                Value::Object(t)
            }
            _ => v.clone(),
        };
        out.insert(k.clone(), v);
    }
    Some(Value::Object(out))
}

/// Put the data URLs back into a chat read from disk.
pub fn restore(chat: &mut Value, dir: &Path) {
    let Some(messages) = chat.get_mut("messages").and_then(Value::as_array_mut) else { return };
    let load = |s: &str| if s.starts_with(REF) { load(dir, s) } else { None };
    for msg in messages.iter_mut() {
        if let Some(m) = map_message(msg, &load) {
            *msg = m;
        }
    }
}

/// A transcript serialized with its pictures moved to `dir` as it goes, so a
/// long chat is never copied whole to do it.
pub struct Moved<'a> {
    pub messages: &'a [Value],
    pub dir: &'a Path,
}

impl Serialize for Moved<'_> {
    fn serialize<S: Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        let mut seq = ser.serialize_seq(Some(self.messages.len()))?;
        let put = |s: &str| store(self.dir, s);
        for msg in self.messages {
            match map_message(msg, &put) {
                Some(m) => seq.serialize_element(&m)?,
                None => seq.serialize_element(msg)?,
            }
        }
        seq.end()
    }
}

/// A chat's fields with its `messages` (inline, or given apart) written through [`Moved`].
pub struct MovedChat<'a> {
    pub fields: &'a Map<String, Value>,
    pub messages: Option<&'a [Value]>,
    pub dir: &'a Path,
}

impl Serialize for MovedChat<'_> {
    fn serialize<S: Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        let inline = || self.fields.get("messages").and_then(Value::as_array).map(Vec::as_slice);
        let messages = self.messages.or_else(inline);
        let placed = self.fields.contains_key("messages");
        let extra = usize::from(!placed && self.messages.is_some());
        let mut map = ser.serialize_map(Some(self.fields.len() + extra))?;
        for (k, v) in self.fields {
            match (k.as_str(), messages) {
                ("messages", Some(m)) => map.serialize_entry(k, &Moved { messages: m, dir: self.dir })?,
                _ => map.serialize_entry(k, v)?,
            }
        }
        if extra == 1
            && let Some(m) = self.messages
        {
            map.serialize_entry("messages", &Moved { messages: m, dir: self.dir })?;
        }
        map.end()
    }
}

/// Every blob name a chat file's bytes refer to.
pub fn references(bytes: &[u8], into: &mut std::collections::HashSet<String>) {
    let finder = memchr::memmem::Finder::new(REF.as_bytes());
    for at in finder.find_iter(bytes) {
        let start = at + REF.len();
        let end = bytes[start..].iter().position(|b| *b == b'"').map_or(bytes.len(), |n| start + n);
        if let Ok(name) = std::str::from_utf8(&bytes[start..end])
            && valid_name(name)
        {
            into.insert(name.to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn png(n: usize) -> String {
        let bytes: Vec<u8> = (0..n).map(|i| (i * 7 % 251) as u8).collect();
        format!("data:image/png;base64,{}", STANDARD.encode(bytes))
    }

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nekko-blobs-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn pictures_move_out_and_come_back_exactly() {
        let dir = tmp("roundtrip");
        let (big, small) = (png(20_000), png(10));
        let messages = vec![
            json!({ "role": "tool", "toolResult": { "toolCallId": "c", "output": "ok", "images": [big, small] } }),
            json!({ "role": "user", "content": "hi", "images": [big] }),
            json!({ "role": "assistant", "content": "plain" }),
        ];
        let fields = Map::new();
        let text = serde_json::to_string(&MovedChat { fields: &fields, messages: Some(&messages), dir: &dir }).unwrap();
        assert!(!text.contains(&big), "the big picture stayed inline");
        assert!(text.contains(&small), "a small picture stays inline");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1, "one file for one picture used twice");
        let mut back: Value = serde_json::from_str(&text).unwrap();
        restore(&mut back, &dir);
        assert_eq!(back["messages"], Value::Array(messages));
        let mut refs = std::collections::HashSet::new();
        references(text.as_bytes(), &mut refs);
        assert_eq!(refs.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn what_would_not_come_back_exactly_stays_inline() {
        let dir = tmp("inline");
        let odd = format!("data:image/png;charset=x;base64,{}", &png(20_000)[22..]);
        let unknown = png(20_000).replace("image/png", "image/tiff");
        let messages = vec![json!({ "role": "user", "images": [odd, unknown, 42] })];
        let fields = Map::new();
        let text = serde_json::to_string(&MovedChat { fields: &fields, messages: Some(&messages), dir: &dir }).unwrap();
        assert!(!text.contains(REF));
        assert!(!dir.exists());
    }

    #[test]
    fn a_missing_file_leaves_the_reference() {
        let dir = tmp("missing");
        let name = format!("{}.png", "a".repeat(64));
        let mut chat = json!({ "messages": [{ "role": "user", "images": [format!("{REF}{name}")] }] });
        let before = chat.clone();
        restore(&mut chat, &dir);
        assert_eq!(chat, before);
    }
}
