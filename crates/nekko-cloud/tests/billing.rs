//! Plans and billing (#2724) and the team switch (decision 0092) against a
//! stub Nekko Cloud: the account's `staff` and `features` reach the status,
//! the billing channels call the right routes, and a switch refreshes what
//! the account sees.

use nekko_cloud::vault::{FileVault, Vault};
use nekko_cloud::{Cloud, Options};
use nekko_store::SessionStore;
use serde_json::json;
use std::sync::{Arc, Mutex};

/// Records `method path body`; `/v1/auth/me` answers a team account with billing on.
async fn stub() -> (String, Arc<Mutex<Vec<String>>>) {
    let seen: Arc<Mutex<Vec<String>>> = Arc::default();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let log = seen.clone();
    let app = axum::Router::new().fallback(move |req: axum::extract::Request| {
        let log = log.clone();
        async move {
            let (method, path) = (req.method().to_string(), req.uri().path().to_string());
            let body = axum::body::to_bytes(req.into_body(), 1 << 16).await.unwrap();
            log.lock().unwrap().push(format!("{method} {path} {}", String::from_utf8_lossy(&body)));
            let answer = match path.as_str() {
                "/v1/auth/me" => json!({ "account": { "id": "u1", "email": "philip@nekkolabs.com", "plan": "free", "canSync": false, "staff": true, "features": { "billing": true } } }),
                "/v1/sync/state" => json!({ "devices": [] }),
                "/v1/billing/checkout" => json!({ "url": "https://checkout.stripe.com/c/1" }),
                "/v1/billing/portal" => json!({ "url": "https://billing.stripe.com/p/1" }),
                _ => json!({ "features": { "billing": "team" } }),
            };
            axum::response::Response::builder()
                .header("content-type", "application/json")
                .body(axum::body::Body::from(answer.to_string()))
                .unwrap()
        }
    });
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, seen)
}

fn signed_in(dir: &std::path::Path, api_url: String) -> Arc<Cloud> {
    let cloud_dir = dir.join("cloud");
    std::fs::create_dir_all(&cloud_dir).unwrap();
    // A state.json from before #2724: no staff or billing fields.
    let state = json!({ "account": { "id": "u1", "email": "philip@nekkolabs.com", "plan": "free", "canSync": false } });
    std::fs::write(cloud_dir.join("state.json"), state.to_string()).unwrap();
    FileVault::new(cloud_dir.join("secrets.json")).set("token", "nk_test").unwrap();
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
async fn an_older_state_reads_as_no_team_and_no_billing_until_refreshed() {
    let (url, _) = stub().await;
    let dir = tempfile::tempdir().unwrap();
    let cloud = signed_in(dir.path(), url);
    assert_eq!(cloud.status()["account"]["staff"], false);
    assert_eq!(cloud.status()["account"]["features"]["billing"], false);
    let status = cloud.route("cloud:refresh", &[]).await.unwrap();
    assert_eq!(status["account"]["staff"], true);
    assert_eq!(status["account"]["features"]["billing"], true);
}

#[tokio::test]
async fn billing_channels_call_the_billing_routes() {
    let (url, seen) = stub().await;
    let dir = tempfile::tempdir().unwrap();
    let cloud = signed_in(dir.path(), url);
    let checkout = cloud.route("cloud:billingCheckout", &[json!("pro")]).await.unwrap();
    assert_eq!(checkout["url"], "https://checkout.stripe.com/c/1");
    let portal = cloud.route("cloud:billingPortal", &[]).await.unwrap();
    assert_eq!(portal["url"], "https://billing.stripe.com/p/1");
    assert_eq!(
        seen.lock().unwrap().as_slice(),
        [r#"POST /v1/billing/checkout {"plan":"pro"}"#, "POST /v1/billing/portal "]
    );
}

#[tokio::test]
async fn a_team_switch_refreshes_the_account_and_refuses_odd_keys() {
    let (url, seen) = stub().await;
    let dir = tempfile::tempdir().unwrap();
    let cloud = signed_in(dir.path(), url);
    assert!(cloud.route("cloud:setTeamFeature", &[json!("../auth"), json!("on")]).await.is_err());
    assert!(seen.lock().unwrap().is_empty());
    let out = cloud.route("cloud:setTeamFeature", &[json!("billing"), json!("team")]).await.unwrap();
    assert_eq!(out["features"]["billing"], "team");
    assert_eq!(seen.lock().unwrap()[0], r#"PUT /v1/staff/features/billing {"state":"team"}"#);
    assert!(seen.lock().unwrap().iter().any(|l| l.starts_with("GET /v1/auth/me")));
    assert_eq!(cloud.status()["account"]["features"]["billing"], true);
}
