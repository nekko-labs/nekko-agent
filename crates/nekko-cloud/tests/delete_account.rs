//! `cloud:deleteAccount` against a stub Nekko Cloud: `DELETE /v1/account`
//! with the device's bearer token. 204 forgets the token, keys and sync state
//! here; 401 and 502 keep everything and say why.

use nekko_cloud::vault::{FileVault, Vault};
use nekko_cloud::{Cloud, Options};
use nekko_store::SessionStore;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

/// A Nekko Cloud that answers `DELETE /v1/account` with `status` and records
/// what it was asked (`method path authorization`).
async fn stub(status: u16) -> (String, Arc<Mutex<Vec<String>>>) {
    let seen: Arc<Mutex<Vec<String>>> = Arc::default();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let log = seen.clone();
    let app = axum::Router::new().fallback(move |req: axum::extract::Request| {
        let log = log.clone();
        async move {
            let auth = req.headers().get("authorization").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
            log.lock().unwrap().push(format!("{} {} {auth}", req.method(), req.uri().path()));
            let body = match status {
                204 => String::new(),
                401 => json!({ "error": "unauthenticated" }).to_string(),
                _ => json!({ "error": "machine-teardown-failed" }).to_string(),
            };
            axum::response::Response::builder().status(status).body(axum::body::Body::from(body)).unwrap()
        }
    });
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, seen)
}

/// A device signed in to Nekko Cloud, with a device key, a keyring and sync state.
fn signed_in(dir: &std::path::Path, api_url: String) -> Arc<Cloud> {
    let cloud_dir = dir.join("cloud");
    std::fs::create_dir_all(&cloud_dir).unwrap();
    let state = json!({ "account": { "id": "u1", "email": "sam@example.com", "plan": "pro", "canSync": true }, "enabled": true, "keyId": 1, "deviceId": "d1" });
    std::fs::write(cloud_dir.join("state.json"), state.to_string()).unwrap();
    let vault = FileVault::new(cloud_dir.join("secrets.json"));
    for (k, v) in [("token", "nk_test"), ("device-key", "key"), ("keyring:1", "ring")] {
        vault.set(k, v).unwrap();
    }
    Cloud::new(Options {
        dir: cloud_dir.clone(),
        api_url,
        device_label: "Test Mac".into(),
        sessions: Arc::new(SessionStore::new(dir)),
        vault: Box::new(FileVault::new(cloud_dir.join("secrets.json"))),
        publish: Arc::new(|_| {}),
        busy: Arc::new(|_| false),
    })
}

fn secrets(dir: &std::path::Path) -> Value {
    serde_json::from_slice(&std::fs::read(dir.join("cloud/secrets.json")).unwrap()).unwrap()
}

#[tokio::test]
async fn a_deleted_account_is_forgotten_on_this_device() {
    let (url, seen) = stub(204).await;
    let dir = tempfile::tempdir().unwrap();
    let cloud = signed_in(dir.path(), url);
    assert_eq!(cloud.status()["signedIn"], true);

    let status = cloud.route("cloud:deleteAccount", &[]).await.unwrap();
    assert_eq!(seen.lock().unwrap().as_slice(), ["DELETE /v1/account Bearer nk_test"]);
    assert_eq!(status["signedIn"], false);
    assert_eq!(status["sync"]["phase"], "signed-out");
    assert_eq!(secrets(dir.path()), json!({}), "token, device key and keyring are gone");
    assert!(!dir.path().join("cloud/state.json").exists());
}

#[tokio::test]
async fn an_unauthenticated_delete_keeps_everything() {
    let (url, _) = stub(401).await;
    let dir = tempfile::tempdir().unwrap();
    let cloud = signed_in(dir.path(), url);
    let err = cloud.route("cloud:deleteAccount", &[]).await.unwrap_err();
    assert!(err.contains("Sign in again"), "{err}");
    assert_eq!(secrets(dir.path())["token"], "nk_test");
    assert!(dir.path().join("cloud/state.json").exists());
}

#[tokio::test]
async fn a_failed_machine_teardown_keeps_everything() {
    let (url, _) = stub(502).await;
    let dir = tempfile::tempdir().unwrap();
    let cloud = signed_in(dir.path(), url);
    let err = cloud.route("cloud:deleteAccount", &[]).await.unwrap_err();
    assert!(err.contains("was not deleted"), "{err}");
    assert_eq!(cloud.status()["signedIn"], true);
    assert_eq!(secrets(dir.path())["keyring:1"], "ring");
}

#[tokio::test]
async fn delete_everything_forgets_the_device_and_ends_the_session() {
    let (url, seen) = stub(204).await;
    let dir = tempfile::tempdir().unwrap();
    let cloud = signed_in(dir.path(), url);
    cloud.sign_out_and_forget().await.unwrap();
    assert_eq!(seen.lock().unwrap().as_slice(), ["DELETE /v1/auth/session Bearer nk_test"]);
    assert_eq!(secrets(dir.path()), json!({}));
    assert_eq!(cloud.status()["signedIn"], false);
}
