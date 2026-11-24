//! Pictures in chats sync to the account's other computers (#3298), against the
//! local Nekko Cloud dev stack. Skipped unless `NEKKO_CLOUD_ITEST_URL` is set:
//!
//!   cd apps/nekko-agent-api && DEV_CODE=123456 npm run dev:local
//!   NEKKO_CLOUD_ITEST_URL=http://127.0.0.1:4330 cargo test -p nekko-cloud --test pictures_live -- --nocapture

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
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

fn token(d: &Device) -> String {
    let secrets: Value =
        serde_json::from_str(&std::fs::read_to_string(d._dir.path().join("cloud/secrets.json")).unwrap()).unwrap();
    secrets["token"].as_str().unwrap().to_string()
}

async fn raw_pull(url: &str, d: &Device) -> Vec<Value> {
    let page: Value = reqwest::Client::new()
        .get(format!("{url}/v1/sync/pull?limit=500"))
        .bearer_auth(token(d))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    page["objects"].as_array().unwrap().clone()
}

/// A PNG-typed data URL of `n` bytes no other test makes.
fn picture(n: usize, seed: u8) -> String {
    let bytes: Vec<u8> = (0..n).map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed)).collect();
    format!("data:image/png;base64,{}", STANDARD.encode(bytes))
}

fn chat(id: &str, images: &[&str], updated: f64) -> Value {
    json!({ "id": id, "title": id, "createdAt": 1.0, "updatedAt": updated, "messages": [
        { "role": "user", "content": "look at this", "images": images },
        { "role": "tool", "toolResult": { "toolCallId": "c", "output": "ok", "images": images } },
    ] })
}

fn images(d: &Device, id: &str) -> Vec<String> {
    let c = d.store.get(id).unwrap();
    let list = |v: &Value| v.as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect::<Vec<_>>();
    let mut out = list(&c["messages"][0]["images"]);
    out.extend(list(&c["messages"][1]["toolResult"]["images"]));
    out
}

#[tokio::test]
async fn pictures_reach_the_other_computer_sealed_and_leave_with_their_chat() {
    let Ok(url) = std::env::var("NEKKO_CLOUD_ITEST_URL") else {
        eprintln!("NEKKO_CLOUD_ITEST_URL not set; skipping");
        return;
    };
    let email = format!("pictures-itest-{}@example.com", std::process::id());
    let (a, b) = (device(&url, "Desk"), device(&url, "Laptop"));
    // A large one (kept beside the chat on A) and a small one (inline in A's chat file).
    let (big, small) = (picture(60_000, 3), picture(500, 9));

    sign_in(&a, &email).await;
    let recovery = call(&a, "sync:turnOn", json!([])).await.unwrap()["recoveryKey"].as_str().unwrap().to_string();
    a.store.put_synced(&chat("s_1_pic", &[&big, &small], 10.0)).unwrap();
    call(&a, "sync:now", json!([])).await.unwrap();

    // Nekko Cloud holds one record per picture (not per use), and none of it in the clear.
    let objects = raw_pull(&url, &a).await;
    let pictures: Vec<&Value> = objects.iter().filter(|o| o["collection"] == "picture").collect();
    assert_eq!(pictures.len(), 2, "one record per picture");
    let everything = serde_json::to_string(&objects).unwrap();
    for needle in [&big[22..80], &small[22..80], "look at this", "Desk"] {
        assert!(!everything.contains(needle), "the server can read part of a chat or picture");
    }

    // B joins and has the chat with its pictures, exactly as A has them.
    sign_in(&b, &email).await;
    call(&b, "sync:restore", json!([recovery])).await.unwrap();
    assert_eq!(images(&b, "s_1_pic"), vec![big.clone(), small.clone(), big.clone(), small.clone()]);
    assert_eq!(b.store.get("s_1_pic").unwrap()["home"]["device"], "Desk");

    // A picture gone from B (cleared away) is fetched again on the next sync.
    let blobs = b.store.dir().join("blobs");
    for f in std::fs::read_dir(&blobs).unwrap().flatten() {
        std::fs::remove_file(f.path()).unwrap();
    }
    assert!(images(&b, "s_1_pic")[0].starts_with("nekko-blob:"), "the picture is still there");
    // The chat changes on A, so B applies it again and notices.
    a.store.put_synced(&chat("s_1_pic", &[&big, &small], 20.0)).unwrap();
    call(&a, "sync:now", json!([])).await.unwrap();
    call(&b, "sync:now", json!([])).await.unwrap();
    assert_eq!(images(&b, "s_1_pic")[0], big, "a missing picture wasn't fetched again");

    // A deletes the chat: its pictures leave Nekko Cloud too (as tombstones).
    a.store.delete("s_1_pic").unwrap();
    call(&a, "sync:now", json!([])).await.unwrap();
    let left: Vec<usize> = raw_pull(&url, &a)
        .await
        .iter()
        .filter(|o| o["collection"] == "picture")
        .map(|o| o["blob"].as_str().unwrap().len())
        .collect();
    assert_eq!(left.len(), 2);
    assert!(left.iter().all(|n| *n < 2_000), "a picture's bytes are still in Nekko Cloud");
    call(&b, "sync:now", json!([])).await.unwrap();
    assert!(b.store.get("s_1_pic").is_none());
}

#[tokio::test]
async fn a_chat_synced_before_pictures_did_sends_them_once_it_is_looked_at_again() {
    let Ok(url) = std::env::var("NEKKO_CLOUD_ITEST_URL") else {
        eprintln!("NEKKO_CLOUD_ITEST_URL not set; skipping");
        return;
    };
    let email = format!("pictures-old-itest-{}@example.com", std::process::id());
    let (a, b) = (device(&url, "Desk"), device(&url, "Laptop"));
    let pic = picture(20_000, 5);
    sign_in(&a, &email).await;
    let recovery = call(&a, "sync:turnOn", json!([])).await.unwrap()["recoveryKey"].as_str().unwrap().to_string();
    a.store.put_synced(&chat("s_2_old", &[&pic], 10.0)).unwrap();
    a.store.put_synced(&json!({ "id": "s_3_txt", "title": "t", "updatedAt": 10.0, "messages": [] })).unwrap();
    call(&a, "sync:now", json!([])).await.unwrap();

    // Pretend both were synced by a version that left pictures out: no `pictured`, another digest.
    let state_path = a._dir.path().join("cloud/state.json");
    let mut state: Value = serde_json::from_str(&std::fs::read_to_string(&state_path).unwrap()).unwrap();
    for c in state["chats"].as_object_mut().unwrap().values_mut() {
        c["pictured"] = json!(false);
        c["pictures"] = json!([]);
        c["digest"] = json!("old");
    }
    state["pictures"] = json!({});
    std::fs::write(&state_path, serde_json::to_vec(&state).unwrap()).unwrap();
    let a = {
        let Device { store, _dir, .. } = a;
        let cloud = Cloud::new(Options {
            dir: _dir.path().join("cloud"),
            api_url: url.clone(),
            device_label: "Desk".into(),
            sessions: store.clone(),
            vault: Box::new(FileVault::new(_dir.path().join("cloud").join("secrets.json"))),
            publish: Arc::new(|_| {}),
            busy: Arc::new(|_| false),
        });
        Device { cloud, store, _dir }
    };
    call(&a, "sync:now", json!([])).await.unwrap();
    // Sent again with its picture, which is still one record.
    let pictures = raw_pull(&url, &a).await.iter().filter(|o| o["collection"] == "picture").count();
    assert_eq!(pictures, 1);
    sign_in(&b, &email).await;
    call(&b, "sync:restore", json!([recovery])).await.unwrap();
    assert_eq!(b.store.get("s_2_old").unwrap()["messages"][0]["images"][0], pic.as_str());
    let state: Value = serde_json::from_str(&std::fs::read_to_string(&state_path).unwrap()).unwrap();
    assert!(state["chats"].as_object().unwrap().values().all(|c| c["pictured"] == true));
}
