//! Three devices against a real Nekko Cloud API: the local dev stack
//! (`apps/nekko-agent-api`: `DEV_CODE=123456 npm run dev:local`, PGlite and a
//! fake Supabase Auth). Skipped unless `NEKKO_CLOUD_ITEST_URL` is set:
//!
//!   NEKKO_CLOUD_ITEST_URL=http://127.0.0.1:4330 cargo test -p nekko-cloud --test live -- --nocapture

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
    assert_eq!(s["signedIn"], true, "{s}");
}

fn chat(id: &str, title: &str, text: &str, updated: f64) -> Value {
    json!({ "id": id, "title": title, "messages": [{ "role": "user", "content": text }], "createdAt": 1.0, "updatedAt": updated })
}

fn phase(d: &Device) -> String {
    d.cloud.status()["sync"]["phase"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn three_devices_sync_end_to_end() {
    let Ok(url) = std::env::var("NEKKO_CLOUD_ITEST_URL") else {
        eprintln!("NEKKO_CLOUD_ITEST_URL not set; skipping");
        return;
    };
    let email = format!("itest-{}@example.com", std::process::id());
    let (a, b, c) = (device(&url, "Desk"), device(&url, "Laptop"), device(&url, "Studio"));

    // A turns sync on: the recovery key appears once, and typing it back confirms it.
    sign_in(&a, &email).await;
    assert_eq!(phase(&a), "off");
    let on = call(&a, "sync:turnOn", json!([])).await.unwrap();
    let recovery = on["recoveryKey"].as_str().unwrap().to_string();
    assert_eq!(recovery.len(), 65);
    assert!(
        call(
            &a,
            "sync:confirmRecoveryKey",
            json!(["AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA"])
        )
        .await
        .is_err()
    );
    assert_eq!(
        call(&a, "sync:confirmRecoveryKey", json!([recovery.to_lowercase()])).await.unwrap()["sync"]["recoveryConfirmed"],
        true
    );

    // A chat with a secret in it, and an incognito one that must never leave.
    a.store.put_synced(&chat("s_1_aaa", "Trip to Kyoto", "the hotel code is 4471", 10.0)).unwrap();
    a.store
        .put_synced(
            &json!({ "id": "s_2_bbb", "title": "Private", "incognito": true, "messages": [], "updatedAt": 11.0 }),
        )
        .unwrap();
    call(&a, "sync:now", json!([])).await.unwrap();
    let s = a.cloud.status();
    assert_eq!(s["sync"]["phase"], "idle", "{s}");
    assert_eq!(s["sync"]["skipped"]["incognito"], 1);

    // The server holds ciphertext only.
    let token_a = std::fs::read_to_string(a._dir.path().join("cloud/secrets.json")).unwrap();
    let token_a: Value = serde_json::from_str(&token_a).unwrap();
    let raw = reqwest::Client::new()
        .get(format!("{url}/v1/sync/pull"))
        .bearer_auth(token_a["token"].as_str().unwrap())
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    for leak in ["Kyoto", "4471", "s_1_aaa", "Private", "Desk"] {
        assert!(!raw.contains(leak), "the server saw {leak}");
    }

    // B: the account already syncs, so B joins with the recovery key and gets the chat.
    sign_in(&b, &email).await;
    assert!(call(&b, "sync:turnOn", json!([])).await.unwrap_err().starts_with("needs-join"));
    assert_eq!(phase(&b), "needs-join");
    assert!(
        call(&b, "sync:restore", json!(["00000-00000-00000-00000-00000-00000-00000-00000-00000-00000-00000"]))
            .await
            .is_err()
    );
    call(&b, "sync:restore", json!([recovery])).await.unwrap();
    assert_eq!(b.store.get("s_1_aaa").unwrap()["messages"][0]["content"], "the hotel code is 4471");
    assert!(b.store.get("s_2_bbb").is_none(), "incognito never syncs");

    // B edits it; A picks the edit up, newest wins.
    b.store.put_synced(&chat("s_1_aaa", "Trip to Kyoto", "booked the ryokan", 20.0)).unwrap();
    call(&b, "sync:now", json!([])).await.unwrap();
    call(&a, "sync:now", json!([])).await.unwrap();
    assert_eq!(a.store.get("s_1_aaa").unwrap()["messages"][0]["content"], "booked the ryokan");

    // C asks to join; A approves it after comparing fingerprints.
    sign_in(&c, &email).await;
    let join = call(&c, "sync:requestJoin", json!([])).await.unwrap();
    let fp = join["fingerprint"].as_str().unwrap().to_string();
    call(&c, "sync:now", json!([])).await.unwrap();
    assert_eq!(phase(&c), "awaiting-approval");
    call(&a, "cloud:refresh", json!([])).await.unwrap();
    let devices = a.cloud.status()["sync"]["devices"].as_array().unwrap().clone();
    let pending = devices.iter().find(|d| d["trusted"] == false).unwrap();
    assert_eq!(pending["fingerprint"], fp, "both screens show the same code");
    call(&a, "sync:approve", json!([pending["id"]])).await.unwrap();
    call(&c, "sync:now", json!([])).await.unwrap();
    assert_eq!(phase(&c), "idle");
    assert_eq!(c.store.get("s_1_aaa").unwrap()["messages"][0]["content"], "booked the ryokan");

    // A removes B: a new key epoch, wrapped to A and C only.
    call(&a, "cloud:refresh", json!([])).await.unwrap();
    let b_id = a.cloud.status()["sync"]["devices"].as_array().unwrap().iter().find(|d| d["label"] == "Laptop").unwrap()
        ["id"]
        .clone();
    let after = call(&a, "sync:revoke", json!([b_id])).await.unwrap();
    assert_eq!(after["sync"]["keyEpoch"], 2);
    a.store.put_synced(&chat("s_3_ccc", "After revoke", "B must not read this", 30.0)).unwrap();
    call(&a, "sync:now", json!([])).await.unwrap();
    assert!(call(&b, "sync:now", json!([])).await.is_err(), "B is signed out of sync");
    assert!(b.store.get("s_3_ccc").is_none());
    call(&c, "sync:now", json!([])).await.unwrap();
    assert_eq!(c.cloud.status()["sync"]["keyEpoch"], 2);
    assert_eq!(c.store.get("s_3_ccc").unwrap()["messages"][0]["content"], "B must not read this");

    // A deletes a chat; C's copy goes too.
    a.store.delete("s_1_aaa").unwrap();
    call(&a, "sync:now", json!([])).await.unwrap();
    call(&c, "sync:now", json!([])).await.unwrap();
    assert!(c.store.get("s_1_aaa").is_none());

    // The recovery key still opens the newest epoch (it was sealed to its public half).
    let d = device(&url, "New laptop");
    sign_in(&d, &email).await;
    call(&d, "sync:restore", json!([recovery])).await.unwrap();
    assert_eq!(d.store.get("s_3_ccc").unwrap()["title"], "After revoke");

    // Delete everything synced.
    call(&a, "sync:deleteAll", json!([])).await.unwrap();
    assert_eq!(phase(&a), "off");
}
