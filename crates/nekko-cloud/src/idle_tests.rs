//! What an idle computer asks Nekko Cloud, against a stub API that counts calls per path: a timer
//! pass only pulls, and the account and sync state are read again on start, on a settings or
//! organizations nudge, when a pull meets a newer epoch, and every 10 minutes.

use super::*;
use crate::vault::{FileVault, Vault};
use std::collections::BTreeMap;
use std::sync::atomic::Ordering;

#[derive(Default)]
struct Calls(Mutex<BTreeMap<String, usize>>);

impl Calls {
    fn get(&self, path: &str) -> usize {
        lock(&self.0).get(path).copied().unwrap_or(0)
    }

    fn total(&self) -> usize {
        lock(&self.0).values().sum()
    }

    /// `(auth/me, sync/state, sync/pull)` so far.
    fn reads(&self) -> (usize, usize, usize) {
        (self.get("/v1/auth/me"), self.get("/v1/sync/state"), self.get("/v1/sync/pull"))
    }
}

/// A stub Nekko Cloud for a synced account on key epoch 1. `pull_answer` is what `/v1/sync/pull` says.
async fn stub(pull_answer: Arc<Mutex<Value>>) -> (String, Arc<Calls>) {
    let calls = Arc::new(Calls::default());
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let seen = calls.clone();
    let app = axum::Router::new().fallback(move |req: axum::extract::Request| {
        let (seen, pull_answer) = (seen.clone(), pull_answer.clone());
        async move {
            let path = req.uri().path().to_string();
            *lock(&seen.0).entry(path.clone()).or_default() += 1;
            let answer = match path.as_str() {
                "/v1/auth/me" => json!({ "account": { "id": "u1", "email": "a@b.c", "plan": "pro", "canSync": true } }),
                "/v1/sync/state" => json!({ "currentKeyId": 1, "device": "dev-1", "devices": [] }),
                "/v1/sync/pull" => lock(&pull_answer).clone(),
                _ => json!({}),
            };
            axum::response::Response::builder()
                .header("content-type", "application/json")
                .body(axum::body::Body::from(answer.to_string()))
                .unwrap()
        }
    });
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, calls)
}

fn empty_pull() -> Arc<Mutex<Value>> {
    Arc::new(Mutex::new(json!({ "objects": [], "next": 0, "more": false })))
}

/// A computer with sync on at epoch 1, signed in with a token, and a keyring.
fn synced(dir: &std::path::Path, api_url: String) -> Arc<Cloud> {
    let cloud_dir = dir.join("cloud");
    std::fs::create_dir_all(&cloud_dir).unwrap();
    let state = json!({
        "account": { "id": "u1", "email": "a@b.c", "plan": "pro", "canSync": true },
        "enabled": true, "deviceId": "dev-1", "keyId": 1
    });
    std::fs::write(cloud_dir.join("state.json"), state.to_string()).unwrap();
    let vault = FileVault::new(cloud_dir.join("secrets.json"));
    vault.set("token", "nk_test").unwrap();
    vault.set("keyring:1", &b64_encode(&Keyring::generate().to_bytes())).unwrap();
    let cloud = Cloud::new(Options {
        dir: cloud_dir.clone(),
        api_url,
        device_label: "Test Mac".into(),
        sessions: Arc::new(SessionStore::new(dir)),
        vault: Box::new(FileVault::new(cloud_dir.join("secrets.json"))),
        publish: Arc::new(|_| {}),
        busy: Arc::new(|_| false),
    });
    // Nudge passes start at once in tests.
    cloud.nudge_window_ms.store(0, Ordering::SeqCst);
    cloud
}

/// Wait (briefly) for a background pass to make `n` pulls in all.
async fn pulls_reach(calls: &Calls, n: usize) {
    for _ in 0..200 {
        if calls.get("/v1/sync/pull") >= n {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    // And a moment more, for a pass that would wrongly make extra calls.
    tokio::time::sleep(Duration::from_millis(100)).await;
}

fn frame(v: Value) -> String {
    v.to_string()
}

#[tokio::test]
async fn the_first_pass_reads_in_full_and_an_idle_pass_after_it_is_one_call() {
    let (url, calls) = stub(empty_pull()).await;
    let dir = tempfile::tempdir().unwrap();
    let cloud = synced(dir.path(), url);
    cloud.sync_quick().await.unwrap();
    assert_eq!(calls.reads(), (1, 1, 1), "on start: account, state, pull");
    let before = calls.total();
    for _ in 0..5 {
        cloud.sync_quick().await.unwrap();
    }
    assert_eq!(calls.total() - before, 5, "an idle timer pass is one call: the pull");
    assert_eq!(calls.reads(), (1, 1, 6));
}

#[tokio::test]
async fn a_user_action_reads_in_full() {
    let (url, calls) = stub(empty_pull()).await;
    let dir = tempfile::tempdir().unwrap();
    let cloud = synced(dir.path(), url);
    cloud.sync_quick().await.unwrap();
    cloud.sync_once().await.unwrap();
    assert_eq!(calls.reads(), (2, 2, 2));
}

#[tokio::test]
async fn a_nudge_triggers_a_pull_and_nothing_else() {
    let (url, calls) = stub(empty_pull()).await;
    let dir = tempfile::tempdir().unwrap();
    let cloud = synced(dir.path(), url);
    cloud.sync_quick().await.unwrap();
    let nudge = |topic: &str| frame(json!({ "type": "nudge", "topic": topic, "from": "phone" }));
    cloud.on_relay_frame(&nudge("sync"));
    pulls_reach(&calls, 2).await;
    assert_eq!(calls.reads(), (1, 1, 2));
    cloud.on_relay_frame(&nudge("library"));
    pulls_reach(&calls, 3).await;
    assert_eq!(calls.reads(), (1, 1, 3));
    cloud.on_relay_frame(&nudge("fleet"));
    pulls_reach(&calls, 4).await;
    assert_eq!(calls.reads(), (1, 1, 3), "a fleet nudge isn't for sync");
}

#[tokio::test]
async fn a_burst_of_nudges_is_one_pass() {
    let (url, calls) = stub(empty_pull()).await;
    let dir = tempfile::tempdir().unwrap();
    let cloud = synced(dir.path(), url);
    cloud.sync_quick().await.unwrap();
    cloud.nudge_window_ms.store(200, Ordering::SeqCst);
    for _ in 0..8 {
        cloud.on_relay_frame(&frame(json!({ "type": "nudge", "topic": "sync", "from": "phone" })));
    }
    pulls_reach(&calls, 2).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(calls.get("/v1/sync/pull"), 2, "one pull for the first pass and one for the whole burst");
}

#[tokio::test]
async fn a_settings_or_organizations_nudge_reads_in_full() {
    for topic in ["settings", "orgs"] {
        let (url, calls) = stub(empty_pull()).await;
        let dir = tempfile::tempdir().unwrap();
        let cloud = synced(dir.path(), url);
        cloud.sync_quick().await.unwrap();
        cloud.on_relay_frame(&frame(json!({ "type": "nudge", "topic": topic, "from": "phone" })));
        pulls_reach(&calls, 2).await;
        assert_eq!(calls.reads(), (2, 2, 2), "{topic}");
        // And the want was used up: the next timer pass is a pull again.
        cloud.sync_quick().await.unwrap();
        assert_eq!(calls.reads(), (2, 2, 3), "{topic}");
    }
}

#[tokio::test]
async fn coming_back_on_the_channel_pulls_and_slows_the_timer_to_a_safety_poll() {
    let (url, calls) = stub(empty_pull()).await;
    let dir = tempfile::tempdir().unwrap();
    let cloud = synced(dir.path(), url);
    cloud.sync_quick().await.unwrap();
    assert!(!cloud.relay.connected());
    cloud.on_relay_frame(&frame(json!({ "type": "ready", "dev": "mac", "devices": [] })));
    assert!(cloud.relay.connected());
    pulls_reach(&calls, 2).await;
    assert_eq!(calls.reads(), (1, 1, 2), "ready pulls what was nudged while the channel was down");
    assert_eq!(pace::poll_interval(cloud.relay.connected(), Duration::from_secs(60)), Duration::from_secs(300));
}

#[tokio::test]
async fn a_newer_epoch_in_a_pull_still_reads_the_account_and_state() {
    let newer = json!({ "objects": [{ "keyId": 2, "seq": 1, "collection": "chat", "objectId": "x", "revision": 1, "blob": "" }],
                        "next": 1, "more": false });
    let pull = Arc::new(Mutex::new(newer));
    let (url, calls) = stub(pull.clone()).await;
    let dir = tempfile::tempdir().unwrap();
    let cloud = synced(dir.path(), url);
    // A full read is already done, so only the pull's own finding can cause another.
    cloud.sync_once().await.unwrap();
    let before = calls.reads();
    *lock(&pull) = json!({ "objects": [], "next": 0, "more": false });
    cloud.sync_quick().await.unwrap();
    assert_eq!(calls.reads(), (before.0, before.1, before.2 + 1), "quiet again: one call");
    *lock(&pull) = json!({ "objects": [{ "keyId": 2, "seq": 1, "collection": "chat", "objectId": "x", "revision": 1, "blob": "" }],
                           "next": 1, "more": false });
    let before = calls.reads();
    let _ = cloud.sync_quick().await;
    let after = calls.reads();
    assert!(
        after.0 > before.0 && after.1 > before.1,
        "the newer epoch sent it to read the account and state again: {before:?} {after:?}"
    );
}

#[tokio::test]
async fn the_full_read_happens_again_after_ten_minutes() {
    let (url, calls) = stub(empty_pull()).await;
    let dir = tempfile::tempdir().unwrap();
    let cloud = synced(dir.path(), url);
    cloud.sync_quick().await.unwrap();
    cloud.sync_quick().await.unwrap();
    assert_eq!(calls.reads(), (1, 1, 2));
    // Pretend the last full read was 11 minutes ago.
    let old = Instant::now().checked_sub(Duration::from_secs(11 * 60)).expect("the clock has run 11 minutes");
    lock(&cloud.full_read).done("nk_test", old);
    cloud.sync_quick().await.unwrap();
    assert_eq!(calls.reads(), (2, 2, 3));
    cloud.sync_quick().await.unwrap();
    assert_eq!(calls.reads(), (2, 2, 4), "and quiet again");
}

#[tokio::test]
async fn a_new_sign_in_reads_in_full() {
    let (url, calls) = stub(empty_pull()).await;
    let dir = tempfile::tempdir().unwrap();
    let cloud = synced(dir.path(), url);
    cloud.sync_quick().await.unwrap();
    cloud.vault.set("token", "nk_other").unwrap();
    cloud.sync_quick().await.unwrap();
    assert_eq!(calls.reads().0, 2);
}
