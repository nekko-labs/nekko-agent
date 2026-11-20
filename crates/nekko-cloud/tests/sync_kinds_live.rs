//! Chats turned off on one computer (#3089), against the local Nekko Cloud dev
//! stack: nothing of it goes up or comes down while off, and turning it back on
//! brings what arrived meanwhile. Skipped unless `NEKKO_CLOUD_ITEST_URL` is set:
//!
//!   cd apps/nekko-agent-api && DEV_CODE=123456 npm run dev:local
//!   NEKKO_CLOUD_ITEST_URL=http://127.0.0.1:4330 cargo test -p nekko-cloud --test sync_kinds_live -- --nocapture

use nekko_cloud::vault::FileVault;
use nekko_cloud::{Cloud, Options};
use nekko_store::SessionStore;
use serde_json::{Value, json};
use std::sync::Arc;

const CODE: &str = "123456";

struct Device {
    cloud: Arc<Cloud>,
    store: Arc<SessionStore>,
    _dir: tempfile::TempDir,
}

fn device(url: &str, label: &str) -> Device {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(SessionStore::new(dir.path()));
    let cloud = Cloud::new(Options {
        dir: dir.path().join("cloud"),
        api_url: url.into(),
        device_label: label.into(),
        sessions: store.clone(),
        vault: Box::new(FileVault::new(dir.path().join("cloud").join("secrets.json"))),
        publish: Arc::new(|_| {}),
        busy: Arc::new(|_| false),
    });
    Device { cloud, store, _dir: dir }
}

async fn call(d: &Device, channel: &str, args: Value) -> Result<Value, String> {
    d.cloud.route(channel, args.as_array().unwrap()).await
}

async fn sign_in(d: &Device, email: &str) {
    call(d, "cloud:sendCode", json!([email])).await.unwrap();
    let s = call(d, "cloud:verifyCode", json!([email, CODE])).await.unwrap();
    assert!(s["signedIn"] == true, "sign-in didn't finish");
}

fn chat(id: &str, text: &str, updated: f64) -> Value {
    json!({ "id": id, "title": id, "messages": [{ "role": "user", "content": text }], "createdAt": 1.0, "updatedAt": updated })
}

fn text(d: &Device, id: &str) -> Option<String> {
    d.store.get(id).map(|c| c["messages"][0]["content"].as_str().unwrap_or("").to_string())
}

#[tokio::test]
async fn chats_off_on_one_computer_holds_both_ways_and_back_on_catches_up() {
    let Ok(url) = std::env::var("NEKKO_CLOUD_ITEST_URL") else {
        eprintln!("NEKKO_CLOUD_ITEST_URL not set; skipping");
        return;
    };
    let email = format!("kinds-itest-{}@example.com", std::process::id());
    let (a, b) = (device(&url, "Desk"), device(&url, "Laptop"));

    // A syncs a chat; B joins with the recovery key and has it.
    sign_in(&a, &email).await;
    let recovery = call(&a, "sync:turnOn", json!([])).await.unwrap()["recoveryKey"].as_str().unwrap().to_string();
    a.store.put_synced(&chat("s_1_aaa", "first", 10.0)).unwrap();
    call(&a, "sync:now", json!([])).await.unwrap();
    sign_in(&b, &email).await;
    call(&b, "sync:restore", json!([recovery])).await.unwrap();
    assert_eq!(text(&b, "s_1_aaa").as_deref(), Some("first"));
    let s = b.cloud.status();
    assert_eq!(s["sync"]["kinds"], json!({ "chats": true, "library": true }));

    // B turns Chats off. An unknown kind is refused.
    assert!(call(&b, "sync:setKind", json!(["photos", false])).await.is_err());
    let off = call(&b, "sync:setKind", json!(["chats", false])).await.unwrap();
    assert_eq!(off["sync"]["kinds"]["chats"], false);
    assert_eq!(off["sync"]["kinds"]["library"], true);

    // While off: A's new chat and edit don't reach B, and B's new chat doesn't reach A.
    a.store.put_synced(&chat("s_1_aaa", "edited on A", 20.0)).unwrap();
    a.store.put_synced(&chat("s_2_bbb", "new on A", 21.0)).unwrap();
    call(&a, "sync:now", json!([])).await.unwrap();
    b.store.put_synced(&chat("s_3_ccc", "new on B", 22.0)).unwrap();
    call(&b, "sync:now", json!([])).await.unwrap();
    assert!(b.cloud.status()["sync"]["phase"] == "idle", "B isn't idle with Chats off");
    assert_eq!(text(&b, "s_1_aaa").as_deref(), Some("first"));
    assert!(b.store.get("s_2_bbb").is_none(), "a chat came down while Chats was off");
    call(&a, "sync:now", json!([])).await.unwrap();
    assert!(a.store.get("s_3_ccc").is_none(), "a chat went up while Chats was off");

    // Back on: B pulls what it passed over and pushes what it kept.
    let on = call(&b, "sync:setKind", json!(["chats", true])).await.unwrap();
    assert_eq!(on["sync"]["kinds"]["chats"], true);
    call(&b, "sync:now", json!([])).await.unwrap();
    assert_eq!(text(&b, "s_1_aaa").as_deref(), Some("edited on A"));
    assert_eq!(text(&b, "s_2_bbb").as_deref(), Some("new on A"));
    call(&a, "sync:now", json!([])).await.unwrap();
    assert_eq!(text(&a, "s_3_ccc").as_deref(), Some("new on B"));
}
