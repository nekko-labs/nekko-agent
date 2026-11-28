//! A computer's `reach` record (decision 0128), end to end against a real
//! Nekko Cloud API (the local dev stack: `DEV_CODE=123456 npm run dev:local`
//! in `apps/nekko-agent-api`). Skipped unless `NEKKO_CLOUD_ITEST_URL` is set:
//!
//!   NEKKO_CLOUD_ITEST_URL=http://127.0.0.1:4330 cargo test -p nekko-cloud --test live_reach
//!
//! The computer publishes how it is reached while remote access is on, the
//! server holds only the sealed blob, the account's keys open it, and it
//! becomes a tombstone once remote access is off.

use nekko_cloud::vault::{FileVault, Vault};
use nekko_cloud::{Cloud, ConnectInfo, HostInfo, Options};
use nekko_store::SessionStore;
use nekko_sync::{Keyring, b64_decode, object_id, open_record};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

const CODE: &str = "123456";
const CLOUD_RELAY: &str = "wss://nekko-agent-relay.fly.dev";

async fn call(cloud: &Arc<Cloud>, channel: &str, args: Value) -> Result<Value, String> {
    cloud.route(channel, args.as_array().unwrap()).await
}

/// Every `reach` object in the account, newest revision of each, opened with this device's keys.
async fn reach_records(url: &str, vault: &FileVault, device_id: &str) -> Vec<Value> {
    let token = vault.get("token").expect("signed in");
    let http = reqwest::Client::new();
    let get = |path: String| {
        let req = http.get(format!("{url}{path}")).bearer_auth(&token);
        async move { req.send().await.unwrap().json::<Value>().await.unwrap() }
    };
    let me = get("/v1/auth/me".into()).await;
    let account = me["account"]["id"].as_str().expect("an account id").to_string();
    let pulled = get("/v1/sync/pull?since=0&limit=500".into()).await;
    let mut out = Vec::new();
    for o in pulled["objects"].as_array().expect("objects") {
        if o["collection"] != "reach" {
            continue;
        }
        let key_id = o["keyId"].as_u64().unwrap() as u32;
        let raw = b64_decode(&vault.get(&format!("keyring:{key_id}")).expect("the epoch's keyring")).unwrap();
        let ring = Keyring::from_bytes(&raw).unwrap();
        let oid = o["objectId"].as_str().unwrap();
        // Named after the computer's own account device id, so a phone finds one record per computer.
        assert_eq!(oid, object_id(&ring, "reach", device_id).unwrap());
        let rev = o["revision"].as_u64().unwrap();
        let plain = open_record(&ring, &account, key_id, "reach", oid, rev, o["blob"].as_str().unwrap())
            .expect("the account's keys open it");
        out.push(serde_json::from_slice(&plain).unwrap());
    }
    out
}

#[tokio::test]
async fn a_computer_publishes_how_it_is_reached_and_withdraws_it() {
    let Ok(url) = std::env::var("NEKKO_CLOUD_ITEST_URL") else {
        eprintln!("NEKKO_CLOUD_ITEST_URL not set; skipping");
        return;
    };
    let tag = format!("{}-{}", std::process::id(), nekko_js::now_ms());
    let email = format!("reach-{tag}@example.com");
    let dir = tempfile::tempdir().unwrap();
    let secrets = dir.path().join("cloud").join("secrets.json");
    let cloud = Cloud::new(Options {
        dir: dir.path().join("cloud"),
        api_url: url.clone(),
        device_label: "Desk-PC".into(),
        sessions: Arc::new(SessionStore::new(dir.path())),
        vault: Box::new(FileVault::new(secrets.clone())),
        publish: Arc::new(|_| {}),
        busy: Arc::new(|_| false),
    });
    let reach: Arc<Mutex<Option<ConnectInfo>>> = Arc::default();
    let r = reach.clone();
    cloud.set_host(HostInfo {
        app_version: "9.9.9-test".into(),
        name: Arc::new(|| "Desk-PC".into()),
        models: Arc::new(|| Box::pin(async { Vec::new() })),
        connect: None,
        reach: Some(Arc::new(move || r.lock().unwrap().clone())),
        runners: None,
    });

    call(&cloud, "cloud:sendCode", json!([email])).await.unwrap();
    assert_eq!(call(&cloud, "cloud:verifyCode", json!([email, CODE])).await.unwrap()["signedIn"], true);
    call(&cloud, "sync:turnOn", json!([])).await.unwrap();
    let vault = FileVault::new(secrets);
    let device_id = cloud.fleet_device().expect("an account device id once sync is on");

    // Remote access off and never published: nothing in the store, not even a tombstone.
    call(&cloud, "sync:now", json!([])).await.unwrap();
    assert!(reach_records(&url, &vault, &device_id).await.is_empty());

    // Remote access on, through Tailscale and Nekko Cloud Relay.
    *reach.lock().unwrap() = ConnectInfo::new(
        vec!["ws://desk.tail1234.ts.net:4400".into(), CLOUD_RELAY.into()],
        "faa985fa39488785".into(),
        "0123456789abcdef0123456789abcdef".into(),
        "BHostKeyText".into(),
    );
    call(&cloud, "sync:now", json!([])).await.unwrap();
    let got = reach_records(&url, &vault, &device_id).await;
    assert_eq!(
        got,
        [json!({
            "v": 1, "deviceId": device_id, "name": "Desk-PC",
            "routes": ["ws://desk.tail1234.ts.net:4400", CLOUD_RELAY],
            "room": "faa985fa39488785", "secret": "0123456789abcdef0123456789abcdef", "hostKey": "BHostKeyText",
        })]
    );

    // Nothing changed: no new revision.
    call(&cloud, "sync:now", json!([])).await.unwrap();
    assert_eq!(reach_records(&url, &vault, &device_id).await.len(), 1);

    // Remote access off (or account devices off): a tombstone.
    *reach.lock().unwrap() = None;
    call(&cloud, "sync:now", json!([])).await.unwrap();
    assert_eq!(
        reach_records(&url, &vault, &device_id).await,
        [json!({ "v": 1, "deleted": true, "deviceId": device_id })]
    );
}
