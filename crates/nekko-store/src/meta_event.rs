//! The fields a `session_meta` event carries, so a window can apply them to the
//! summary it already has instead of reading the chat list again.
//!
//! Taken from what each write here puts in the chat file (no file is read), and
//! kept per chat in memory, so the hub can attach them to an event without
//! waiting on the disk.

use crate::SessionStore;
use crate::write::OPTION_KEYS;
use serde_json::{Map, Value};

/// The chat fields beside the options a user can set ([`OPTION_KEYS`]) the event carries.
const EXTRA_FIELDS: &[&str] = &["updatedAt", "titleAuto", "workspaceId"];

impl SessionStore {
    /// Remember the event fields of the chat `fields` (a whole chat record, its
    /// transcript not needed) was just written as.
    pub(crate) fn note_meta_fields(&self, fields: &Map<String, Value>) {
        let Some(id) = fields.get("id").and_then(Value::as_str) else { return };
        // A key the chat does not have is sent as null, so a removal reaches the window too.
        let snapshot: Map<String, Value> = OPTION_KEYS
            .iter()
            .chain(EXTRA_FIELDS)
            .map(|k| ((*k).to_string(), fields.get(*k).cloned().unwrap_or(Value::Null)))
            .collect();
        self.meta_fields.lock().unwrap_or_else(|e| e.into_inner()).insert(id.to_string(), Value::Object(snapshot));
    }

    /// Forget a deleted chat's fields.
    pub(crate) fn forget_meta_fields(&self, id: &str) {
        self.meta_fields.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
    }

    /// Chat `id`'s title, plan, `updatedAt` and the rest of the small fields a
    /// window shows in a list, as of this store's last write of the chat (a key
    /// the chat does not have is `null`), or `None` when the chat was not
    /// written since the daemon started. Reads no file.
    pub fn meta_event_fields(&self, id: &str) -> Option<Value> {
        self.meta_fields.lock().unwrap_or_else(|e| e.into_inner()).get(id).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_write_records_the_event_fields_and_a_removal_is_null() {
        let dir = std::env::temp_dir().join(format!("nekko-meta-event-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let s = SessionStore::new(&dir);
        let id = s.create(None).unwrap()["id"].as_str().unwrap().to_string();
        s.set_options(&id, &json!({ "title": "Fix the build", "plan": { "steps": [] }, "pinned": true })).unwrap();
        let f = s.meta_event_fields(&id).unwrap();
        assert_eq!(f["title"], "Fix the build");
        assert_eq!(f["pinned"], true);
        assert!(f["updatedAt"].as_f64().unwrap() > 0.0);
        assert!(f.get("messages").is_none());
        s.set_options(&id, &json!({ "pinned": null })).unwrap();
        assert!(s.meta_event_fields(&id).unwrap()["pinned"].is_null());
        s.delete(&id).unwrap();
        assert!(s.meta_event_fields(&id).is_none());
        assert!(s.meta_event_fields("s_never_written").is_none());
        std::fs::remove_dir_all(dir).ok();
    }
}
