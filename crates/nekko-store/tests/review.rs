use nekko_store::{ReviewScope, SessionStore};
use serde_json::json;
use std::sync::{Arc, mpsc};
use std::time::Duration;

struct Rig(std::path::PathBuf, Arc<SessionStore>);
impl Rig {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("nekko-store-review-{}", nekko_js::uuid()));
        let store = Arc::new(SessionStore::new(&dir));
        std::fs::create_dir_all(store.dir()).unwrap();
        std::fs::write(
            store.dir().join("saved.json"),
            json!({"id":"saved","updatedAt":1,"archivedAt":1,"messages":[]}).to_string(),
        )
        .unwrap();
        Self(dir, store)
    }
    fn sidecar(&self) -> std::path::PathBuf {
        self.0.join("changes/saved.json")
    }
    fn save(&self) {
        self.1
            .with_review("saved", |scope| {
                let ReviewScope::Saved(path) = scope else { panic!("saved") };
                nekko_js::fs::atomic_write(&path, b"original", nekko_js::fs::AtomicWrite::PRIVATE)
                    .map_err(|e| e.to_string())
            })
            .unwrap();
    }
}
impl Drop for Rig {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn all_deletion_entrypoints_remove_sidecars_but_retention_noop_keeps_them() {
    for operation in ["delete", "clear", "history", "purge"] {
        let r = Rig::new();
        r.save();
        match operation {
            "delete" => r.1.delete("saved").unwrap(), // also cloud tombstones
            "clear" => {
                assert_eq!(r.1.clear("all").unwrap(), 1);
            }
            "history" => {
                assert_eq!(r.1.clear_history_with("older-2-weeks", |_| false, |_| Ok(())).unwrap(), 1);
            }
            _ => {
                assert_eq!(r.1.purge_archived(|_| Ok(())).unwrap(), 0);
            }
        }
        assert_eq!(r.sidecar().exists(), operation == "purge", "{operation}");
    }
}

#[test]
fn privacy_errors_are_not_ephemeral_and_incognito_transition_discards_originals() {
    let r = Rig::new();
    r.save();
    r.1.set_options("saved", &json!({"incognito":true})).unwrap();
    assert!(!r.sidecar().exists());
    r.1.with_review("saved", |scope| {
        assert!(matches!(scope, ReviewScope::Incognito));
        Ok(())
    })
    .unwrap();
    std::fs::write(r.1.dir().join("saved.json"), "corrupt").unwrap();
    assert!(
        r.1.with_review("saved", |_| -> Result<(), String> { panic!("must not run on unreadable policy") }).is_err()
    );
    assert!(r.1.with_review("../escape", |_| Ok(())).is_err());
}

#[test]
fn shared_turn_save_also_discards_incognito_sidecars() {
    let r = Rig::new();
    r.save();
    // Simulate an incognito chat restored by another store writer, with a stale
    // sidecar still present. The shared-turn writer must enforce cleanup too.
    let mut chat = r.1.get("saved").unwrap();
    chat["incognito"] = json!(true);
    std::fs::write(r.1.dir().join("saved.json"), chat.to_string()).unwrap();
    r.1.save_turn_shared(&std::sync::Mutex::new(chat), Some(vec![])).unwrap();
    assert!(!r.sidecar().exists());
}

#[test]
fn deletion_and_privacy_changes_wait_for_inflight_snapshot_writes() {
    for deleting in [true, false] {
        let r = Rig::new();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let writer_store = r.1.clone();
        let writer = std::thread::spawn(move || {
            writer_store.with_review("saved", |scope| {
                let ReviewScope::Saved(path) = scope else { panic!("saved") };
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                nekko_js::fs::atomic_write(&path, b"original", nekko_js::fs::AtomicWrite::PRIVATE)
                    .map_err(|e| e.to_string())
            })
        });
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let deletion_store = r.1.clone();
        let (done_tx, done_rx) = mpsc::channel();
        let deleting_thread = std::thread::spawn(move || {
            let result = if deleting {
                deletion_store.delete("saved")
            } else {
                deletion_store.set_options("saved", &json!({"incognito":true})).map(|_| ())
            };
            done_tx.send(result).unwrap();
        });
        assert!(done_rx.recv_timeout(Duration::from_millis(50)).is_err());
        release_tx.send(()).unwrap();
        writer.join().unwrap().unwrap();
        done_rx.recv_timeout(Duration::from_secs(5)).unwrap().unwrap();
        deleting_thread.join().unwrap();
        assert!(!r.sidecar().exists());
        r.1.with_review("saved", |scope| {
            assert!(if deleting {
                matches!(scope, ReviewScope::Missing)
            } else {
                matches!(scope, ReviewScope::Incognito)
            });
            Ok(())
        })
        .unwrap();
    }
}
