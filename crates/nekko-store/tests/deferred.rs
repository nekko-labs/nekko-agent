//! A running turn's checkpoint saves can be held and written together, but
//! nothing that reads or writes the chat through the store ever sees it older
//! than the turn has made it.

use nekko_store::SessionStore;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

/// A store in a fresh folder of its own, removed when the guard drops.
struct Tmp(std::path::PathBuf);

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn store() -> (Tmp, SessionStore) {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("nekko-deferred-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let store = SessionStore::new(&dir);
    (Tmp(dir), store)
}

fn on_disk(store: &SessionStore, id: &str) -> Value {
    serde_json::from_slice(&std::fs::read(store.dir().join(format!("{id}.json"))).unwrap()).unwrap()
}

fn messages(n: usize) -> Vec<Value> {
    (0..n).map(|i| json!({ "role": "assistant", "content": format!("m{i}"), "createdAt": i })).collect()
}

#[test]
fn a_held_save_is_not_written_until_something_reads_the_chat() {
    let (_tmp, store) = store();
    let chat = store.create(None).unwrap();
    let id = chat["id"].as_str().unwrap().to_string();
    let session = Arc::new(Mutex::new(chat));

    store.defer_turn_save(&session, Some(messages(3)));
    assert!(store.has_deferred(&id));
    // In memory at once; on disk not yet.
    assert_eq!(session.lock().unwrap()["messages"].as_array().unwrap().len(), 3);
    assert_eq!(on_disk(&store, &id)["messages"].as_array().map_or(0, Vec::len), 0);

    // A read writes it first.
    let read = store.get(&id).unwrap();
    assert_eq!(read["messages"].as_array().unwrap().len(), 3);
    assert!(!store.has_deferred(&id));
    assert_eq!(on_disk(&store, &id)["messages"].as_array().unwrap().len(), 3);
}

#[test]
fn later_holds_replace_earlier_ones_and_every_reader_flushes() {
    let (_tmp, store) = store();
    let chat = store.create(None).unwrap();
    let id = chat["id"].as_str().unwrap().to_string();
    let session = Arc::new(Mutex::new(chat));

    store.defer_turn_save(&session, Some(messages(1)));
    store.defer_turn_save(&session, Some(messages(2)));
    let meta = store.meta(&id).unwrap();
    assert!(meta.messages_array);
    assert_eq!(on_disk(&store, &id)["messages"].as_array().unwrap().len(), 2);

    store.defer_turn_save(&session, Some(messages(4)));
    let listed = store.summaries();
    assert_eq!(listed.len(), 1);
    assert_eq!(on_disk(&store, &id)["messages"].as_array().unwrap().len(), 4);

    store.defer_turn_save(&session, Some(messages(5)));
    assert_eq!(store.list_meta().len(), 1);
    assert!(!store.has_deferred(&id));
}

#[test]
fn a_user_write_lands_after_the_held_turn_save_and_keeps_both() {
    let (_tmp, store) = store();
    let chat = store.create(None).unwrap();
    let id = chat["id"].as_str().unwrap().to_string();
    let session = Arc::new(Mutex::new(chat));

    store.defer_turn_save(&session, Some(messages(3)));
    store.set_options(&id, &json!({ "effort": "high" })).unwrap();
    let disk = on_disk(&store, &id);
    assert_eq!(disk["messages"].as_array().unwrap().len(), 3);
    assert_eq!(disk["effort"], "high");
    assert!(!store.has_deferred(&id));
}

#[test]
fn a_discarded_hold_is_never_written() {
    let (_tmp, store) = store();
    let chat = store.create(None).unwrap();
    let id = chat["id"].as_str().unwrap().to_string();
    let session = Arc::new(Mutex::new(chat));

    store.defer_turn_save(&session, Some(messages(3)));
    store.discard_deferred(&id);
    assert!(!store.has_deferred(&id));
    assert_eq!(on_disk(&store, &id)["messages"].as_array().map_or(0, Vec::len), 0);
    store.flush(&id).unwrap();
    assert_eq!(on_disk(&store, &id)["messages"].as_array().map_or(0, Vec::len), 0);
}
