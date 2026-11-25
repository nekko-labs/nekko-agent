//! Timings for `summaries()` and `summary(id)` over synthetic chats in a temp
//! dir (never the real data folder). Run by hand, in release:
//! `cargo test -p nekko-store --release --test summaries_timing -- --ignored --nocapture`

use nekko_store::SessionStore;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use std::time::Instant;

fn chats(dir: &std::path::Path, n: usize) -> Vec<String> {
    let store = SessionStore::new(dir);
    let text = "word ".repeat(20_000);
    (0..n)
        .map(|i| {
            let mut c = store.create(None).unwrap();
            c["messages"] = json!([
                { "id": "u", "role": "user", "content": "go", "createdAt": 1 },
                { "id": "a", "role": "assistant", "content": text, "createdAt": 2 },
            ]);
            c["updatedAt"] = json!(i as u64 + 10);
            store.put_synced(&c).unwrap();
            c["id"].as_str().unwrap().to_string()
        })
        .collect()
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

#[test]
#[ignore]
fn time_summaries() {
    for n in [500usize, 2000] {
        let dir = std::env::temp_dir().join(format!("nekko-summaries-timing-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let ids = chats(&dir, n);
        let store = SessionStore::new(&dir);
        let t = Instant::now();
        store.summaries();
        println!("{n} chats: cold summaries() {:.1} ms", t.elapsed().as_secs_f64() * 1e3);
        let warm = |store: &SessionStore| {
            median(
                (0..15)
                    .map(|_| {
                        let t = Instant::now();
                        store.summaries();
                        t.elapsed().as_secs_f64() * 1e3
                    })
                    .collect(),
            )
        };
        println!("{n} chats: warm summaries(), nothing running: median {:.2} ms", warm(&store));
        // A running chat: held with a new transcript before every listing (a checkpoint per call).
        let mut chat = store.get(&ids[0]).unwrap();
        chat["messages"] = Value::Array(vec![]);
        let session = Arc::new(Mutex::new(chat));
        let mut times = Vec::new();
        for i in 0..15 {
            let msgs = vec![json!({ "id": "u", "role": "user", "content": "go", "createdAt": 1 }); i + 1];
            store.defer_turn_save(&session, Some(msgs));
            let t = Instant::now();
            store.summaries();
            times.push(t.elapsed().as_secs_f64() * 1e3);
        }
        println!("{n} chats: summaries() with one running chat held: median {:.2} ms", median(times));
        let t = Instant::now();
        for id in ids.iter().take(100) {
            store.summary(id);
        }
        println!("{n} chats: summary(id): {:.3} ms per call (100 calls)", t.elapsed().as_secs_f64() * 1e1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
