//! A chat's memory frame: the notes its system prompt carries, taken once and
//! then left alone, so the prompt's prefix stays byte-stable from turn to turn
//! and a local model's KV cache (or a cloud prompt cache) keeps being reused.
//!
//! The frame holds the chat's core notes only (`recall::core_notes`); every
//! other note reaches the model when a message recalls it (#3276). `known`
//! lists every note the model has been shown, in the system prompt or in a
//! message, with the version it saw: a shown note edited or deleted later is
//! announced once, in the context that rides on the next user message (the
//! prompt's tail), and never rewritten into the system prompt. A new note
//! that belongs in the core is announced the same way; any other new note
//! waits until a message recalls it.
//!
//! Stored on the chat as `memoryFrame`:
//! `{ "scope": "all" | "project", "notes": [{id, scope, title, body}], "known": { id: { "title", "hash" } } }`.
//! Frames from before recall held every note; they keep working, with all
//! their notes counted as shown.

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
/// the chat's notes on disk now (newest first), `core` the ones that belong
/// in its system prompt (`recall::core_notes` over `current`). With the scope
/// `Off` there is no frame: the chat reads no memory.
pub fn memory_frame(saved: Option<&Value>, scope: MemoryScope, current: &[Value], core: &[Value]) -> MemoryFrame {
    if scope == MemoryScope::Off {
        return MemoryFrame { value: Value::Null, ..Default::default() };
    }
    let name = scope_name(scope);
    let saved = saved.filter(|f| f.get("scope").and_then(Value::as_str) == Some(name));
    let Some(saved) = saved else {
        let known: Map<String, Value> = core.iter().map(|n| (text(n, "id").to_string(), seen(n))).collect();
        let notes: Vec<Value> = core.iter().map(slim).collect();
        let value = json!({ "scope": name, "notes": notes, "known": known });
        return MemoryFrame { notes, changed: Vec::new(), removed: Vec::new(), value, fresh: true };
    };
    let notes: Vec<Value> = saved.get("notes").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut known = saved.get("known").and_then(Value::as_object).cloned().unwrap_or_default();
    let core_ids: std::collections::HashSet<&str> = core.iter().map(|n| text(n, "id")).collect();
    let mut changed = Vec::new();
    for note in current {
        let id = text(note, "id");
        let shown = known.get(id).and_then(|k| k.get("hash")).and_then(Value::as_str);
        let edited = shown.is_some_and(|h| h != hash(note));
        if edited || (shown.is_none() && core_ids.contains(id)) {
            changed.push(slim(note));
            known.insert(id.to_string(), seen(note));
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

/// What the frame stores of a note the model was shown.
fn seen(note: &Value) -> Value {
    json!({ "title": text(note, "title"), "hash": hash(note) })
}

impl MemoryFrame {
    /// The ids of every note the model has been shown in this chat.
    pub fn shown(&self) -> std::collections::HashSet<String> {
        self.value.get("known").and_then(Value::as_object).map(|k| k.keys().cloned().collect()).unwrap_or_default()
    }

    /// Count `notes` as shown, once a message carries them.
    pub fn mark_shown(&mut self, notes: &[Value]) {
        mark_shown(&mut self.value, notes);
    }
}

/// Count `notes` as shown in a stored `memoryFrame` (the chat's), as a
/// `recall_memory` result does, so a message never recalls them again.
pub fn mark_shown(frame: &mut Value, notes: &[Value]) {
    if let Some(known) = frame.get_mut("known").and_then(Value::as_object_mut) {
        for n in notes {
            known.insert(text(n, "id").to_string(), seen(n));
        }
    }
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
    fn the_first_turn_takes_the_core_and_announces_nothing() {
        let all = [note("a", "Name", "Ada"), note("b", "Editor", "Zed")];
        let f = memory_frame(None, MemoryScope::All, &all, &all[..1]);
        assert!(f.fresh);
        assert_eq!(f.notes, vec![json!({ "id": "a", "scope": "global", "title": "Name", "body": "Ada" })]);
        assert!(f.changed.is_empty() && f.removed.is_empty());
        assert_eq!(f.value["scope"], "all");
        assert_eq!(f.shown(), ["a".to_string()].into(), "only the core counts as shown");
    }

    #[test]
    fn a_new_core_note_goes_to_the_tail_and_any_other_waits_for_recall() {
        let a = note("a", "Name", "Ada");
        let first = memory_frame(None, MemoryScope::All, std::slice::from_ref(&a), std::slice::from_ref(&a));
        let (style, editor) = (note("s", "Style", "Be brief"), note("b", "Editor", "Zed"));
        let now = [style.clone(), editor, a.clone()];
        let next = memory_frame(Some(&first.value), MemoryScope::All, &now, &[style, a]);
        assert!(!next.fresh);
        assert_eq!(next.notes, first.notes, "the system prompt's notes never move");
        assert_eq!(next.changed.len(), 1);
        assert_eq!(next.changed[0]["id"], "s");
        assert!(!next.shown().contains("b"), "a note outside the core is not announced");
        // Once stored, the same notes announce nothing again.
        let again = memory_frame(Some(&next.value), MemoryScope::All, &now, &[]);
        assert!(again.changed.is_empty() && again.removed.is_empty());
        assert_eq!(again.notes, first.notes);
    }

    #[test]
    fn a_shown_note_edited_or_deleted_is_announced_once_and_a_recalled_one_counts() {
        let all = [note("a", "Name", "Ada"), note("b", "Editor", "Zed"), note("c", "Cat", "Miso")];
        let mut first = memory_frame(None, MemoryScope::All, &all, &all[..2]);
        first.mark_shown(&all[2..]);
        let next = memory_frame(Some(&first.value), MemoryScope::All, &[note("a", "Name", "Ada L.")], &[]);
        assert_eq!(next.changed[0]["body"], "Ada L.");
        assert_eq!(next.removed, vec!["Editor".to_string(), "Cat".to_string()], "in the order they were shown");
        let text = render_memory_changes(&next, &Default::default());
        assert!(text.contains("# Memory saved or changed: Name\n"), "{text}");
        assert!(text.contains("# Memory deleted: Editor\n"), "{text}");
        let hidden = render_memory_changes(&next, &["mem:a".to_string()].into_iter().collect());
        assert!(!hidden.contains("Ada L."), "{hidden}");
    }

    #[test]
    fn a_frame_from_before_recall_counts_all_its_notes_as_shown() {
        let old = json!({ "scope": "all", "notes": [{ "id": "a", "scope": "global", "title": "Name", "body": "Ada" }, { "id": "b", "scope": "global", "title": "Editor", "body": "Zed" }],
            "known": { "a": seen(&note("a", "Name", "Ada")), "b": seen(&note("b", "Editor", "Zed")) } });
        let f =
            memory_frame(Some(&old), MemoryScope::All, &[note("a", "Name", "Ada"), note("b", "Editor", "Zed")], &[]);
        assert_eq!(f.notes.len(), 2);
        assert!(f.changed.is_empty() && f.shown().contains("b"));
    }

    #[test]
    fn a_scope_change_retakes_the_frame_and_off_has_none() {
        let a = [note("a", "Name", "Ada")];
        let first = memory_frame(None, MemoryScope::All, &a, &a);
        let project = memory_frame(Some(&first.value), MemoryScope::Project, &[], &[]);
        assert!(project.fresh && project.notes.is_empty());
        let off = memory_frame(Some(&first.value), MemoryScope::Off, &a, &a);
        assert!(off.notes.is_empty() && off.value.is_null());
    }
}
