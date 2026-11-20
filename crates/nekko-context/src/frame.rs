//! A chat's memory frame: the notes its system prompt carries, taken once and
//! then left alone, so the prompt's prefix stays byte-stable from turn to turn
//! and a local model's KV cache (or a cloud prompt cache) keeps being reused.
//!
//! A note saved, edited or deleted after the frame was taken is not written
//! back into the system prompt. It is announced once, in the context that rides
//! on the next user message (the prompt's tail), and remembered as announced.
//!
//! Stored on the chat as `memoryFrame`:
//! `{ "scope": "all" | "project", "notes": [{id, scope, title, body}], "known": { id: { "title", "hash" } } }`.

use serde_json::{Map, Value, json};

use crate::MemoryScope;

/// What a turn takes from the chat's memory frame.
#[derive(Debug, Default)]
pub struct MemoryFrame {
    /// The notes for the system prompt: the frame's, never this turn's reads.
    pub notes: Vec<Value>,
    /// Notes new or changed since the model was last told, for the tail.
    pub changed: Vec<Value>,
    /// Titles of notes deleted since the model was last told, for the tail.
    pub removed: Vec<String>,
    /// The frame to store when the turn's tail is saved with its message.
    pub value: Value,
    /// No frame was stored (or it was for another scope): this one is new and
    /// has to be stored even on a turn that saves no message.
    pub fresh: bool,
}

fn scope_name(scope: MemoryScope) -> &'static str {
    match scope {
        MemoryScope::All => "all",
        MemoryScope::Project => "project",
        MemoryScope::Off => "off",
    }
}

fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or_default()
}

/// FNV-1a over a note's title and body: stable across builds and platforms,
/// unlike `std`'s hasher, and only ever compared with itself.
fn hash(note: &Value) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in text(note, "title").bytes().chain([0u8]).chain(text(note, "body").bytes()) {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// Only what the prompt renders, so the stored frame stays small.
fn slim(note: &Value) -> Value {
    json!({ "id": text(note, "id"), "scope": text(note, "scope"), "title": text(note, "title"), "body": text(note, "body") })
}

/// The frame for this turn. `saved` is the chat's `memoryFrame`, `current`
/// the notes on disk now (as `list_memory` reads them, in its order). With the
/// scope `Off` there is no frame: the chat reads no memory.
pub fn memory_frame(saved: Option<&Value>, scope: MemoryScope, current: &[Value]) -> MemoryFrame {
    if scope == MemoryScope::Off {
        return MemoryFrame { value: Value::Null, ..Default::default() };
    }
    let name = scope_name(scope);
    let saved = saved.filter(|f| f.get("scope").and_then(Value::as_str) == Some(name));
    let Some(saved) = saved else {
        let known: Map<String, Value> = current
            .iter()
            .map(|n| (text(n, "id").to_string(), json!({ "title": text(n, "title"), "hash": hash(n) })))
            .collect();
        let notes: Vec<Value> = current.iter().map(slim).collect();
        let value = json!({ "scope": name, "notes": notes, "known": known });
        return MemoryFrame { notes, changed: Vec::new(), removed: Vec::new(), value, fresh: true };
    };
    let notes: Vec<Value> = saved.get("notes").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut known = saved.get("known").and_then(Value::as_object).cloned().unwrap_or_default();
    let mut changed = Vec::new();
    for note in current {
        let id = text(note, "id");
        let h = hash(note);
        if known.get(id).and_then(|k| k.get("hash")).and_then(Value::as_str) != Some(h.as_str()) {
            changed.push(slim(note));
            known.insert(id.to_string(), json!({ "title": text(note, "title"), "hash": h }));
        }
    }
    let present: std::collections::HashSet<&str> = current.iter().map(|n| text(n, "id")).collect();
    let gone: Vec<String> = known.keys().filter(|id| !present.contains(id.as_str())).cloned().collect();
    let mut removed = Vec::new();
    for id in gone {
        if let Some(k) = known.remove(&id) {
            removed.push(text(&k, "title").to_string());
        }
    }
    let value = json!({ "scope": name, "notes": notes, "known": known });
    MemoryFrame { notes, changed, removed, value, fresh: false }
}

/// The tail's memory section: changed notes in full, deleted ones by title.
/// `excluded` holds Context Inspector ids (`mem:<id>`) the user switched off.
pub fn render_memory_changes(frame: &MemoryFrame, excluded: &std::collections::HashSet<String>) -> String {
    let mut parts = Vec::new();
    for note in &frame.changed {
        if excluded.contains(&format!("mem:{}", text(note, "id"))) {
            continue;
        }
        parts.push(format!(
            "# Memory saved or changed: {}\n(This replaces any earlier version of this note.)\n{}",
            text(note, "title"),
            text(note, "body")
        ));
    }
    for title in &frame.removed {
        parts.push(format!("# Memory deleted: {title}\n(This note no longer applies; disregard it.)"));
    }
    parts.join("\n\n---\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(id: &str, title: &str, body: &str) -> Value {
        json!({ "id": id, "scope": "global", "title": title, "body": body, "tags": [], "createdAt": 1, "updatedAt": 2 })
    }

    #[test]
    fn the_first_turn_takes_a_frame_and_announces_nothing() {
        let f = memory_frame(None, MemoryScope::All, &[note("a", "Name", "Ada")]);
        assert!(f.fresh);
        assert_eq!(f.notes, vec![json!({ "id": "a", "scope": "global", "title": "Name", "body": "Ada" })]);
        assert!(f.changed.is_empty() && f.removed.is_empty());
        assert_eq!(f.value["scope"], "all");
    }

    #[test]
    fn a_later_save_goes_to_the_tail_and_the_frame_notes_stay() {
        let first = memory_frame(None, MemoryScope::All, &[note("a", "Name", "Ada")]);
        let now = [note("b", "Editor", "Zed"), note("a", "Name", "Ada")];
        let next = memory_frame(Some(&first.value), MemoryScope::All, &now);
        assert!(!next.fresh);
        assert_eq!(next.notes, first.notes, "the system prompt's notes never move");
        assert_eq!(next.changed.len(), 1);
        assert_eq!(next.changed[0]["id"], "b");
        // Once stored, the same notes announce nothing again.
        let again = memory_frame(Some(&next.value), MemoryScope::All, &now);
        assert!(again.changed.is_empty() && again.removed.is_empty());
        assert_eq!(again.notes, first.notes);
    }

    #[test]
    fn an_edit_and_a_delete_are_announced_once() {
        let first = memory_frame(None, MemoryScope::All, &[note("a", "Name", "Ada"), note("b", "Editor", "Zed")]);
        let next = memory_frame(Some(&first.value), MemoryScope::All, &[note("a", "Name", "Ada L.")]);
        assert_eq!(next.changed[0]["body"], "Ada L.");
        assert_eq!(next.removed, vec!["Editor".to_string()]);
        let text = render_memory_changes(&next, &Default::default());
        assert!(text.contains("# Memory saved or changed: Name\n"), "{text}");
        assert!(text.contains("# Memory deleted: Editor\n"), "{text}");
        let hidden = render_memory_changes(&next, &["mem:a".to_string()].into_iter().collect());
        assert!(!hidden.contains("Ada L."), "{hidden}");
    }

    #[test]
    fn a_scope_change_retakes_the_frame_and_off_has_none() {
        let first = memory_frame(None, MemoryScope::All, &[note("a", "Name", "Ada")]);
        let project = memory_frame(Some(&first.value), MemoryScope::Project, &[]);
        assert!(project.fresh && project.notes.is_empty());
        let off = memory_frame(Some(&first.value), MemoryScope::Off, &[note("a", "Name", "Ada")]);
        assert!(off.notes.is_empty() && off.value.is_null());
    }
}
