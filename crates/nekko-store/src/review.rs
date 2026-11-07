//! Local review sidecars share chat lifecycle locks. No snapshot operation
//! can race deletion, bulk clear, or an incognito option change. Cloud tombstones
//! use the same SessionStore::delete path as local callers.

use crate::{SessionStore, valid_id};
use std::path::PathBuf;

pub enum ReviewScope {
    Saved(PathBuf),
    Incognito,
    Missing,
}

impl SessionStore {
    pub(crate) fn review_path(&self, id: &str) -> PathBuf {
        self.dir.parent().unwrap_or(&self.dir).join("changes").join(format!("{id}.json"))
    }

    pub(crate) fn remove_review(&self, id: &str) -> Result<(), String> {
        if !valid_id(id) {
            return Err("Invalid session id.".into());
        }
        match std::fs::remove_file(self.review_path(id)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("Could not delete review snapshot: {e}")),
            _ => Ok(()),
        }
    }

    /// Invoke once under the same lock as chat writes/deletion. Metadata read
    /// errors are errors, not permission to overwrite a persistent original.
    /// The callback must not call back into the session store.
    pub fn with_review<R>(&self, id: &str, f: impl FnOnce(ReviewScope) -> Result<R, String>) -> Result<R, String> {
        if !valid_id(id) {
            return Err("Invalid session id.".into());
        }
        self.with_chat(id, || {
            let scope = match std::fs::File::open(self.dir.join(format!("{id}.json"))) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => ReviewScope::Missing,
                Err(e) => return Err(format!("Could not read chat privacy state: {e}")),
                Ok(file) => {
                    // Streaming metadata decode avoids allocating the transcript.
                    let meta: crate::meta::Meta = serde_json::from_reader(std::io::BufReader::new(file))
                        .map_err(|e| format!("Could not read chat privacy state: {e}"))?;
                    if nekko_js::truthy(meta.get("incognito")) {
                        ReviewScope::Incognito
                    } else {
                        ReviewScope::Saved(self.review_path(id))
                    }
                }
            };
            f(scope)
        })
    }
}
