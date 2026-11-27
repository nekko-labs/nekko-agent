//! `cloud:refresh` is asked for by Settings > Sync on every mount, by sign-in and
//! by Plan on every window focus: calls within a few seconds share one read of the
//! account and sync state. Against a stub Nekko Cloud that counts calls.

use nekko_cloud::vault::{FileVault, Vault};
use nekko_cloud::{Cloud, Options};
use nekko_store::SessionStore;
use serde_json::json;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

async fn stub() -> (String, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let count = calls.clone();
    let app = axum::Router::new().fallback(move |req: axum::extract::Request| {
        let count = count.clone();
        async move {
            count.fetch_add(1, Ordering::SeqCst);
            let answer = match req.uri().path() {
                "/v1/auth/me" => json!({ "account": { "id": "u1", "email": "a@b.c", "plan": "pro", "canSync": true } }),
                _ => json!({ "devices": [] }),
            };
            // Slow enough that concurrent callers overlap.
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
            axum::response::Response::builder()
                .header("content-type", "application/json")
                .body(axum::body::Body::from(answer.to_string()))
                .unwrap()
        }
    });
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, calls)
}

fn signed_in(dir: &std::path::Path, api_url: String, token: &str) -> Arc<Cloud> {
    let cloud_dir = dir.join("cloud");
    std::fs::create_dir_all(&cloud_dir).unwrap();
    FileVault::new(cloud_dir.join("secrets.json")).set("token", token).unwrap();
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

#[tokio::test]
async fn refreshes_in_a_row_make_two_calls_once() {
    let (url, calls) = stub().await;
    let dir = tempfile::tempdir().unwrap();
    let cloud = signed_in(dir.path(), url, "nk_test");
    for _ in 0..5 {
        let status = cloud.route("cloud:refresh", &[]).await.unwrap();
        assert_eq!(status["account"]["plan"], "pro");
    }
    assert_eq!(calls.load(Ordering::SeqCst), 2, "/v1/auth/me and /v1/sync/state, once");
}

#[tokio::test]
async fn refreshes_that_arrive_together_share_one() {
    let (url, calls) = stub().await;
    let dir = tempfile::tempdir().unwrap();
    let cloud = signed_in(dir.path(), url, "nk_test");
    let asks = (0..6).map(|_| cloud.route("cloud:refresh", &[]));
    for r in futures_util::future::join_all(asks).await {
        assert_eq!(r.unwrap()["account"]["plan"], "pro");
    }
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_failed_refresh_is_not_remembered() {
    let (url, calls) = stub().await;
    let dir = tempfile::tempdir().unwrap();
    // Nothing listens here, so the call fails fast without being counted.
    let down = signed_in(dir.path(), "http://127.0.0.1:1".into(), "nk_test");
    assert!(down.route("cloud:refresh", &[]).await.is_err());
    assert!(down.route("cloud:refresh", &[]).await.is_err(), "asked again, not answered from a cache");
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let _ = url;
}
