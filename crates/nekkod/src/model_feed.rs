//! A model list newer than the one built into the daemon, without a release.
//!
//! The recommendations are made from `nekko-machine`'s bundled
//! `model-feed.json`. A release can carry a newer one beside its update feed
//! file, signed (native.rs fetches it on each update check):
//!
//! ```json
//! { "payload": "<base64 of the JSON below>", "signature": "<base64 Ed25519 signature of those bytes>" }
//! { "type": "nekko.modelFeed", "version": 1, "serial": 3, "issuedAt": "2026-11-20T00:00:00Z",
//!   "feed": { ...the whole model-feed.json... } }
//! ```
//!
//! It is verified against the release signing key, the same one the update
//! feed and the Claude policy override use. While that key is the all-zero
//! placeholder every signed list is refused, so the bundled list is the only
//! one. A list is used only when:
//!
//! - its `format` is the one this daemon reads (a list for a later daemon is refused);
//! - its `version` is newer than the bundled list's, so an app update that
//!   brings a newer bundled list wins over an older saved one;
//! - its serial is above the one applied before (no rollback).
//!
//! A picture or video model whose companion set this engine does not know is
//! left out of it, and out of its tasks: its text encoder and VAE are named
//! in the engine (`acquire.rs`), so it would download and not start. The list
//! only ever names Hugging Face repositories and files; where a download goes
//! is the engine's, not the list's.
//!
//! The verified document is kept in the data directory and read at the next start.

use base64::Engine as _;
use ed25519_dalek::{Signature, VerifyingKey};
use nekko_machine::recommend::{Feed, feed_version_key};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// The release's file name beside its update feed.
pub const FEED_FILE: &str = "model-feed.json";
/// The verified document in the data directory.
const CACHE_FILE: &str = "model-feed.signed.json";
const DOC_TYPE: &str = "nekko.modelFeed";
const DOC_VERSION: u64 = 1;

#[derive(Clone, Debug, PartialEq)]
struct Applied {
    serial: u64,
    issued_at: String,
    version: String,
}

pub struct ModelFeedStore {
    key: [u8; 32],
    cache: Option<PathBuf>,
    machine: Arc<nekko_machine::Machine>,
    applied: Mutex<Option<Applied>>,
}

impl ModelFeedStore {
    /// The daemon's store: the release key and the saved list in `data_dir`, applied when it still verifies.
    pub fn new(machine: Arc<nekko_machine::Machine>, data_dir: Option<PathBuf>) -> Self {
        Self::with_key(nekko_native::release_key::RELEASE_SIGNING_KEY, machine, data_dir.map(|d| d.join(CACHE_FILE)))
    }

    pub fn with_key(key: [u8; 32], machine: Arc<nekko_machine::Machine>, cache: Option<PathBuf>) -> Self {
        let store = Self { key, cache, machine, applied: Mutex::new(None) };
        if let Some(text) = store.cache.as_ref().and_then(|p| std::fs::read_to_string(p).ok()) {
            match serde_json::from_str::<Value>(&text).map_err(|e| e.to_string()).and_then(|d| store.verify(&d)) {
                Ok((applied, feed)) => store.install(applied, feed),
                // The usual reason: the app was updated and its bundled list is now the newer one.
                Err(e) => eprintln!("nekkod: saved model list not used: {e}"),
            }
        }
        store
    }

    fn install(&self, applied: Applied, feed: Feed) {
        self.machine.set_feed(Some(feed));
        *self.applied.lock().unwrap_or_else(|e| e.into_inner()) = Some(applied);
    }

    /// Check a signed document: key, signature, type, version, and that the
    /// list is one this daemon reads and newer than its own.
    fn verify(&self, doc: &Value) -> Result<(Applied, Feed), String> {
        if nekko_native::release_key::is_placeholder(&self.key) {
            return Err("no release signing key is configured".into());
        }
        let b64 = base64::engine::general_purpose::STANDARD;
        let payload = doc.get("payload").and_then(Value::as_str).ok_or("missing payload")?;
        let signature = doc.get("signature").and_then(Value::as_str).ok_or("missing signature")?;
        let payload = b64.decode(payload).map_err(|_| "payload is not base64")?;
        let signature: [u8; 64] = b64
            .decode(signature)
            .map_err(|_| "signature is not base64")?
            .try_into()
            .map_err(|_| "signature is not 64 bytes")?;
        let key = VerifyingKey::from_bytes(&self.key).map_err(|_| "the signing key is invalid")?;
        key.verify_strict(&payload, &Signature::from_bytes(&signature)).map_err(|_| "bad signature")?;
        let body: Value = serde_json::from_slice(&payload).map_err(|_| "payload is not JSON")?;
        if body.get("type").and_then(Value::as_str) != Some(DOC_TYPE) {
            return Err("not a modelFeed document".into());
        }
        if body.get("version").and_then(Value::as_u64) != Some(DOC_VERSION) {
            return Err("unsupported modelFeed version".into());
        }
        let serial = body.get("serial").and_then(Value::as_u64).ok_or("missing serial")?;
        let issued_at = body.get("issuedAt").and_then(Value::as_str).unwrap_or_default().to_string();
        let feed = body.get("feed").cloned().ok_or("missing feed")?;
        let mut feed: Feed = serde_json::from_value(feed).map_err(|e| format!("the list does not parse: {e}"))?;
        let bundled = nekko_machine::bundled_feed();
        if feed.format != bundled.format {
            return Err(format!("list format {} is not the {} this version reads", feed.format, bundled.format));
        }
        if feed_version_key(&feed.version) <= feed_version_key(&bundled.version) {
            return Err(format!("list {} is not newer than this version's {}", feed.version, bundled.version));
        }
        keep_known_picture_models(&mut feed);
        Ok((Applied { serial, issued_at, version: feed.version.clone() }, feed))
    }

    /// Verify and use a signed list, and keep it for the next start. Refuses
    /// one whose serial is not above the applied one's.
    pub fn apply_signed(&self, doc: &Value) -> Result<(), String> {
        let (applied, feed) = self.verify(doc)?;
        let current = self.applied.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(cur) = current {
            if applied == cur {
                return Ok(());
            }
            if applied.serial <= cur.serial {
                return Err(format!("serial {} is not newer than the applied {}", applied.serial, cur.serial));
            }
        }
        if let Some(path) = &self.cache {
            let text = serde_json::to_string(doc).map_err(|e| e.to_string())?;
            nekko_js::fs::atomic_write(path, text.as_bytes(), Default::default())
                .map_err(|e| format!("{}: {e}", path.display()))?;
        }
        self.install(applied, feed);
        Ok(())
    }

    /// Where the list in use came from: `bundled`, or the signed one's serial and date.
    /// Models shows it once the release publishes a list (#2916's second step).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn status(&self) -> Value {
        match self.applied.lock().unwrap_or_else(|e| e.into_inner()).clone() {
            Some(a) => json!({ "source": "update", "version": a.version, "serial": a.serial, "issuedAt": a.issued_at }),
            None => json!({ "source": "bundled", "version": nekko_machine::bundled_feed().version }),
        }
    }
}

/// Leave out picture and video models whose companion set this engine does not
/// have, and take them off their tasks' candidates.
fn keep_known_picture_models(feed: &mut Feed) {
    let known: Vec<&str> = nekko_engine::acquire::image_companion_sets()
        .iter()
        .filter_map(|s| s.get("id").and_then(Value::as_str))
        .collect();
    feed.image_models.retain(|m| known.contains(&m.companion_set.as_str()));
    let kept: Vec<String> = feed.image_models.iter().map(|m| m.id.clone()).collect();
    for task in &mut feed.image_tasks {
        task.candidates.retain(|c| kept.contains(c));
    }
    feed.image_measured.retain(|m| kept.contains(&m.model));
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    const SEED: [u8; 32] = [9; 32];

    fn key() -> [u8; 32] {
        SigningKey::from_bytes(&SEED).verifying_key().to_bytes()
    }

    fn sign_with(seed: [u8; 32], body: &Value) -> Value {
        let b64 = base64::engine::general_purpose::STANDARD;
        let payload = serde_json::to_vec(body).unwrap();
        let sig = SigningKey::from_bytes(&seed).sign(&payload);
        json!({ "payload": b64.encode(&payload), "signature": b64.encode(sig.to_bytes()) })
    }

    /// The bundled list as JSON, to change and sign.
    fn bundled() -> Value {
        serde_json::from_str(include_str!("../../nekko-machine/src/model-feed.json")).unwrap()
    }

    fn newer(n: u32) -> Value {
        let mut feed = bundled();
        feed["version"] = json!(format!("2999-01-01.{n}"));
        feed
    }

    fn signed(serial: u64, feed: Value) -> Value {
        sign_with(
            SEED,
            &json!({ "type": DOC_TYPE, "version": 1, "serial": serial, "issuedAt": "2026-11-20T00:00:00Z", "feed": feed }),
        )
    }

    fn machine() -> Arc<nekko_machine::Machine> {
        Arc::new(nekko_machine::Machine::new(None, Box::new(|| None)))
    }

    fn store(machine: &Arc<nekko_machine::Machine>, cache: Option<PathBuf>) -> ModelFeedStore {
        ModelFeedStore::with_key(key(), machine.clone(), cache)
    }

    #[test]
    fn without_a_release_key_every_list_is_refused() {
        let m = machine();
        let s = ModelFeedStore::with_key([0; 32], m.clone(), None);
        assert_eq!(s.apply_signed(&signed(1, newer(1))).unwrap_err(), "no release signing key is configured");
        assert_eq!(m.feed().version, nekko_machine::bundled_feed().version);
        assert_eq!(s.status()["source"], "bundled");
    }

    #[test]
    fn a_signed_newer_list_replaces_the_bundled_one_and_survives_a_restart() {
        let dir = std::env::temp_dir().join(format!("nekkod-model-feed-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cache = dir.join(CACHE_FILE);
        let m = machine();
        let s = store(&m, Some(cache.clone()));
        s.apply_signed(&signed(1, newer(1))).unwrap();
        assert_eq!(m.feed().version, "2999-01-01.1");
        assert_eq!(
            s.status(),
            json!({ "source": "update", "version": "2999-01-01.1", "serial": 1, "issuedAt": "2026-11-20T00:00:00Z" })
        );
        // The same document again is nothing new; an older serial is a rollback.
        s.apply_signed(&signed(1, newer(1))).unwrap();
        s.apply_signed(&signed(2, newer(10))).unwrap();
        assert!(s.apply_signed(&signed(1, newer(11))).unwrap_err().contains("not newer than the applied"));
        assert_eq!(m.feed().version, "2999-01-01.10");

        let again = machine();
        assert_eq!(store(&again, Some(cache.clone())).status()["serial"], 2);
        assert_eq!(again.feed().version, "2999-01-01.10");
        // A daemon whose key does not sign it (or has none) starts from its bundled list.
        let other = machine();
        ModelFeedStore::with_key([0; 32], other.clone(), Some(cache));
        assert_eq!(other.feed().version, nekko_machine::bundled_feed().version);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_list_that_is_tampered_with_older_or_for_another_daemon_is_refused() {
        let m = machine();
        let s = store(&m, None);
        assert_eq!(s.apply_signed(&sign_with([8; 32], &json!({}))).unwrap_err(), "bad signature");
        let mut edited = signed(1, newer(1));
        edited["payload"] = json!(base64::engine::general_purpose::STANDARD.encode(b"{}"));
        assert_eq!(s.apply_signed(&edited).unwrap_err(), "bad signature");
        assert!(s.apply_signed(&signed(1, bundled())).unwrap_err().contains("is not newer than this version's"));
        let mut old = bundled();
        old["version"] = json!("2020-01-01.9");
        assert!(s.apply_signed(&signed(1, old)).unwrap_err().contains("is not newer"));
        let mut later = newer(1);
        later["format"] = json!(999);
        assert!(s.apply_signed(&signed(1, later)).unwrap_err().contains("is not the"));
        assert!(
            s.apply_signed(&signed(1, json!({ "version": "2999-01-01.1" }))).unwrap_err().contains("does not parse")
        );
        assert_eq!(m.feed().version, nekko_machine::bundled_feed().version);
    }

    #[test]
    fn a_picture_model_whose_supporting_files_this_engine_does_not_know_is_left_out() {
        let mut feed = newer(1);
        let mut stranger = feed["imageModels"][0].clone();
        stranger["id"] = json!("flux9-next");
        stranger["companionSet"] = json!("flux9-next");
        feed["imageModels"].as_array_mut().unwrap().push(stranger);
        feed["imageTasks"][0]["candidates"].as_array_mut().unwrap().insert(0, json!("flux9-next"));
        let before = nekko_machine::bundled_feed().image_models.len();
        let m = machine();
        store(&m, None).apply_signed(&signed(1, feed)).unwrap();
        let used = m.feed();
        assert_eq!(used.image_models.len(), before);
        assert!(!used.image_tasks[0].candidates.contains(&"flux9-next".to_string()));
        assert_eq!(used.image_tasks[0].candidates, nekko_machine::bundled_feed().image_tasks[0].candidates);
    }

    #[test]
    fn versions_order_by_date_then_by_the_days_count() {
        let k = feed_version_key;
        assert!(k("2026-10-22.10") > k("2026-10-22.9"));
        assert!(k("2026-11-01.1") > k("2026-10-22.10"));
        assert_eq!(k("2026-11-01"), ("2026-11-01".to_string(), 0));
    }
}
