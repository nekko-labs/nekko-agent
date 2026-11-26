//! Deflated records and the account record's capabilities (decision 0122), against a stub Nekko
//! Cloud: this computer lists that it opens them (once), and an update from a build that could not
//! reads the account again from the start when the account has used them.

use super::*;
use crate::vault::{FileVault, Vault};
use records::{AccountRecord, CAP_DEFLATE, TrustedDevice};

#[derive(Default)]
struct Seen {
    pulls: Vec<String>,
    pushes: Vec<Value>,
}

struct Stub {
    url: String,
    seen: Arc<Mutex<Seen>>,
}

/// A stub for an account on epoch 1. `account_object` is what the account record's own route says.
async fn stub(account_object: Value) -> Stub {
    let seen = Arc::new(Mutex::new(Seen::default()));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let log = seen.clone();
    let app = axum::Router::new().fallback(move |req: axum::extract::Request| {
        let (log, account_object) = (log.clone(), account_object.clone());
        async move {
            let path = req.uri().path().to_string();
            let query = req.uri().query().unwrap_or("").to_string();
            let body = axum::body::to_bytes(req.into_body(), 1 << 20).await.unwrap_or_default();
            let answer = match path.as_str() {
                "/v1/auth/me" => json!({ "account": { "id": "u1", "email": "a@b.c", "plan": "pro", "canSync": true } }),
                "/v1/sync/state" => json!({ "currentKeyId": 1, "device": "dev-1", "devices": [] }),
                "/v1/sync/pull" => {
                    lock(&log).pulls.push(query);
                    json!({ "objects": [], "next": 0, "more": false })
                }
                "/v1/sync/push" => {
                    lock(&log).pushes.push(serde_json::from_slice(&body).unwrap_or_default());
                    json!({ "results": [{ "status": "ok" }] })
                }
                p if p.starts_with("/v1/sync/objects/account/") => account_object,
                _ => json!({}),
            };
            axum::response::Response::builder()
                .header("content-type", "application/json")
                .body(axum::body::Body::from(answer.to_string()))
                .unwrap()
        }
    });
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Stub { url, seen }
}

fn device(id: &str, caps: &[&str]) -> TrustedDevice {
    TrustedDevice {
        id: id.into(),
        public_key: format!("pk-{id}"),
        label: id.into(),
        caps: caps.iter().map(|c| c.to_string()).collect(),
    }
}

/// A computer that syncs at epoch 1 and already holds this account record.
fn computer(
    dir: &std::path::Path,
    url: String,
    ring: &Keyring,
    record: &AccountRecord,
    cursor: u64,
    z_ready: bool,
) -> Arc<Cloud> {
    let cloud_dir = dir.join("cloud");
    std::fs::create_dir_all(&cloud_dir).unwrap();
    let state = json!({
        "account": { "id": "u1", "email": "a@b.c", "plan": "pro", "canSync": true },
        "enabled": true, "deviceId": "dev-1", "keyId": 1, "cursor": cursor, "zReady": z_ready,
        "accountRecord": String::from_utf8(record.to_bytes()).unwrap(),
    });
    std::fs::write(cloud_dir.join("state.json"), state.to_string()).unwrap();
    let vault = FileVault::new(cloud_dir.join("secrets.json"));
    vault.set("token", "nk_test").unwrap();
    vault.set("keyring:1", &b64_encode(&ring.to_bytes())).unwrap();
    Cloud::new(Options {
        dir: cloud_dir.clone(),
        api_url: url,
        device_label: "Test Mac".into(),
        sessions: Arc::new(SessionStore::new(dir)),
        vault: Box::new(FileVault::new(cloud_dir.join("secrets.json"))),
        publish: Arc::new(|_| {}),
        busy: Arc::new(|_| false),
    })
}

fn record(devices: Vec<TrustedDevice>, compressed: bool) -> AccountRecord {
    AccountRecord { epoch: 1, recovery_public: "rp".into(), devices, compressed }
}

/// The account record the stub's route serves: sealed as a device would.
fn served(ring: &Keyring, rec: &AccountRecord, revision: u64) -> Value {
    let oid = Cloud::account_oid(ring, 1).unwrap();
    let blob = nekko_sync::seal_record(ring, "u1", 1, records::ACCOUNT, &oid, revision, &rec.to_bytes()).unwrap();
    json!({ "collection": "account", "objectId": oid, "revision": revision, "keyId": 1, "blob": blob })
}

fn pushed_account(ring: &Keyring, push: &Value) -> AccountRecord {
    let o = &push["objects"][0];
    let plain = nekko_sync::open_record(
        ring,
        "u1",
        1,
        records::ACCOUNT,
        o["objectId"].as_str().unwrap(),
        o["revision"].as_u64().unwrap(),
        o["blob"].as_str().unwrap(),
    )
    .unwrap();
    AccountRecord::parse(&plain).unwrap()
}

#[tokio::test]
async fn this_computer_lists_that_it_opens_deflated_records_once() {
    let ring = Keyring::generate();
    let rec = record(vec![device("dev-1", &[]), device("dev-2", &[])], false);
    let s = stub(served(&ring, &rec, 1)).await;
    let dir = tempfile::tempdir().unwrap();
    let cloud = computer(dir.path(), s.url.clone(), &ring, &rec, 0, true);
    cloud.sync_once().await.unwrap();
    {
        let seen = lock(&s.seen);
        assert_eq!(seen.pushes.len(), 1, "one write to the account record");
        let pushed = pushed_account(&ring, &seen.pushes[0]);
        assert!(pushed.devices.iter().find(|d| d.id == "dev-1").unwrap().can(CAP_DEFLATE));
        assert!(pushed.devices.iter().find(|d| d.id == "dev-2").unwrap().caps.is_empty(), "only its own entry");
        assert!(!pushed.all_read_deflate());
    }
    cloud.sync_once().await.unwrap();
    assert_eq!(lock(&s.seen).pushes.len(), 1, "listed already: nothing more is written");
}

#[tokio::test]
async fn a_computer_that_is_not_in_the_record_writes_nothing() {
    let ring = Keyring::generate();
    let rec = record(vec![device("dev-2", &[])], false);
    let s = stub(served(&ring, &rec, 1)).await;
    let dir = tempfile::tempdir().unwrap();
    let cloud = computer(dir.path(), s.url.clone(), &ring, &rec, 0, true);
    cloud.sync_once().await.unwrap();
    assert!(lock(&s.seen).pushes.is_empty());
}

#[tokio::test]
async fn an_update_pulls_again_from_the_start_when_the_account_used_deflated_records() {
    let ring = Keyring::generate();
    // Saved by a build that dropped the mark; Nekko Cloud's copy has it.
    let saved = record(vec![device("dev-1", &[CAP_DEFLATE])], false);
    let fresh = record(vec![device("dev-1", &[CAP_DEFLATE])], true);
    let s = stub(served(&ring, &fresh, 4)).await;
    let dir = tempfile::tempdir().unwrap();
    let cloud = computer(dir.path(), s.url.clone(), &ring, &saved, 7, false);
    cloud.sync_once().await.unwrap();
    {
        let seen = lock(&s.seen);
        assert_eq!(seen.pulls.len(), 2, "{:?}", seen.pulls);
        assert!(seen.pulls[0].starts_with("since=7"), "{:?}", seen.pulls);
        assert!(seen.pulls[1].starts_with("since=0"), "{:?}", seen.pulls);
    }
    assert!(!lock(&cloud.state).z_catchup);
    // Once only.
    cloud.sync_once().await.unwrap();
    assert_eq!(lock(&s.seen).pulls.len(), 3);
}

#[tokio::test]
async fn an_update_does_not_pull_again_when_nothing_was_deflated_or_it_never_synced() {
    let ring = Keyring::generate();
    let rec = record(vec![device("dev-1", &[CAP_DEFLATE])], false);
    let s = stub(served(&ring, &rec, 1)).await;
    let dir = tempfile::tempdir().unwrap();
    let cloud = computer(dir.path(), s.url.clone(), &ring, &rec, 7, false);
    cloud.sync_once().await.unwrap();
    assert_eq!(lock(&s.seen).pulls.len(), 1, "the account never used them");
    assert!(!lock(&cloud.state).z_catchup);

    // A computer new to sync (cursor 0) has nothing it passed over.
    let marked = record(vec![device("dev-1", &[CAP_DEFLATE])], true);
    let s = stub(served(&ring, &marked, 1)).await;
    let dir = tempfile::tempdir().unwrap();
    let cloud = computer(dir.path(), s.url.clone(), &ring, &marked, 0, false);
    cloud.sync_once().await.unwrap();
    assert_eq!(lock(&s.seen).pulls.len(), 1);
}
