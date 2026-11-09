//! Chat pictures live in `sessions/blobs`, not in the chat file, and come
//! back on every read; the sweep removes only files no chat refers to.

use base64::Engine;
use nekko_store::SessionStore;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use std::time::Duration;

struct Tmp(std::path::PathBuf);

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn png(seed: u8) -> String {
    let bytes: Vec<u8> = (0..30_000u32).map(|i| (i as u8).wrapping_mul(seed)).collect();
    format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[test]
fn pictures_are_kept_beside_the_chat_and_swept_once_unused() {
    let dir = std::env::temp_dir().join(format!("nekko-store-blobs-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let _guard = Tmp(dir.clone());
    let store = SessionStore::new(&dir);
    let chat = store.create(None).unwrap();
    let id = chat["id"].as_str().unwrap().to_string();
    let shot = png(3);
    let messages = vec![
        json!({ "role": "assistant", "content": "", "createdAt": 1, "toolCalls": [{ "id": "c", "name": "capture", "input": {} }] }),
        json!({ "role": "tool", "content": "", "createdAt": 2, "toolResult": { "toolCallId": "c", "output": "shot", "images": [shot] } }),
    ];
    store.save_turn_shared(&Arc::new(Mutex::new(chat)), Some(messages.clone())).unwrap();

    let file = std::fs::read_to_string(store.dir().join(format!("{id}.json"))).unwrap();
    assert!(!file.contains(&shot), "the picture is still in the chat file");
    assert!(file.contains("nekko-blob:"));
    let read = store.get(&id).unwrap();
    assert_eq!(read["messages"], Value::Array(messages));

    // Still referred to: kept, however old.
    assert_eq!(store.gc_blobs(Duration::ZERO), 0);
    store.delete(&id).unwrap();
    // Unused but new: kept for a save that may be on its way.
    assert_eq!(store.gc_blobs(Duration::from_secs(3600)), 0);
    assert_eq!(store.gc_blobs(Duration::ZERO), 1);
    assert_eq!(std::fs::read_dir(store.dir().join("blobs")).unwrap().count(), 0);
}
