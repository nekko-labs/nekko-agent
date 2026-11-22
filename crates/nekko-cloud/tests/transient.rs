//! A brief Nekko Cloud stall (#3186): the daemon retries a 503 or the API's
//! database not answering before the user sees anything, and a 5xx it gives
//! up on shows our words, never the server's internal text.

use nekko_cloud::vault::{FileVault, Vault};
use nekko_cloud::{Cloud, Options};
use nekko_store::SessionStore;
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

/// `/v1/auth/me` answers `fail(n)` for its first calls (`None` once healthy); everything else is fine.
async fn stub(fail: fn(usize) -> Option<(u16, Value)>) -> (String, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let count = calls.clone();
    let app = axum::Router::new().fallback(move |req: axum::extract::Request| {
        let count = count.clone();
        async move {
            let (status, answer) = match req.uri().path() {
                "/v1/auth/me" => fail(count.fetch_add(1, Ordering::SeqCst)).unwrap_or((
                    200,
                    json!({ "account": { "id": "u1", "email": "philip@nekkolabs.com", "plan": "pro", "canSync": true } }),
                )),
                _ => (200, json!({ "devices": [] })),
            };
            axum::response::Response::builder()
                .status(status)
                .header("content-type", "application/json")
                .body(axum::body::Body::from(answer.to_string()))
                .unwrap()
        }
    });
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, calls)
}

fn signed_in(dir: &std::path::Path, api_url: String) -> Arc<Cloud> {
    let cloud_dir = dir.join("cloud");
    std::fs::create_dir_all(&cloud_dir).unwrap();
    let state = json!({ "account": { "id": "u1", "email": "philip@nekkolabs.com", "plan": "pro", "canSync": true } });
    std::fs::write(cloud_dir.join("state.json"), state.to_string()).unwrap();
    FileVault::new(cloud_dir.join("secrets.json")).set("token", "nk_test").unwrap();
    Cloud::new(Options {
        dir: cloud_dir.clone(),
        api_url,
        device_label: "Test PC".into(),
        sessions: Arc::new(SessionStore::new(dir)),
        vault: Box::new(FileVault::new(cloud_dir.join("secrets.json"))),
        publish: Arc::new(|_| {}),
        busy: Arc::new(|_| false),
    })
}

/// What the API before #3186 sent when Postgres didn't connect in time.
fn pg_timeout() -> (u16, Value) {
    (
        500,
        json!({ "statusCode": 500, "error": "Internal Server Error", "message": "Connection terminated due to connection timeout" }),
    )
}

#[tokio::test]
async fn a_database_stall_is_retried_until_the_api_answers() {
    let (url, calls) = stub(|n| (n < 2).then(pg_timeout)).await;
    let dir = tempfile::tempdir().unwrap();
    let cloud = signed_in(dir.path(), url);
    let status = cloud.route("cloud:refresh", &[]).await.unwrap();
    assert_eq!(status["account"]["email"], "philip@nekkolabs.com");
    assert_eq!(calls.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn a_503_is_retried_too() {
    let (url, calls) = stub(|n| (n < 1).then(|| (503, json!({ "error": "unavailable" })))).await;
    let dir = tempfile::tempdir().unwrap();
    let cloud = signed_in(dir.path(), url);
    cloud.route("cloud:refresh", &[]).await.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_stall_that_outlasts_the_retries_reads_in_our_words() {
    let (url, calls) = stub(|_| Some(pg_timeout())).await;
    let dir = tempfile::tempdir().unwrap();
    let cloud = signed_in(dir.path(), url);
    let err = cloud.route("cloud:refresh", &[]).await.unwrap_err();
    assert_eq!(err, "Nekko Cloud is busy right now. Try again in a moment.");
    assert_eq!(calls.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn any_other_500_is_tried_once_and_keeps_its_text_to_the_server() {
    let (url, calls) = stub(|_| {
        Some((500, json!({ "statusCode": 500, "error": "Internal Server Error", "message": "relation \"users\" does not exist" })))
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let cloud = signed_in(dir.path(), url);
    let err = cloud.route("cloud:refresh", &[]).await.unwrap_err();
    assert_eq!(err, "Nekko Cloud ran into a problem. Try again in a moment.");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}
