//! SK-9: a computer's step-up methods never reach Nekko Cloud. A device whose
//! data directory holds `security.json` (a registered security key, a TOTP
//! secret, recovery-code hashes) and a paired phone in `remote.json` signs
//! in, turns sync on and syncs a chat through a recording proxy; nothing the
//! device sends (paths, queries, bodies) names or carries any of it. The
//! same holds on a Nekko Cloud machine, which is the same nekkod with its
//! own data directory (decision 0018: methods are per machine, never per
//! account, so a Nekko Labs operator cannot add one).
//!
//! Against the local dev stack (`apps/nekko-agent-api`:
//! `DEV_CODE=123456 npm run dev:local`). Skipped unless `NEKKO_CLOUD_ITEST_URL`
//! is set, as `tests/live.rs`.

use axum::body::{Body, to_bytes};
use axum::extract::Request;
use axum::response::Response;
use nekko_cloud::vault::FileVault;
use nekko_cloud::{Cloud, Options};
use nekko_store::SessionStore;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

const CODE: &str = "123456";

/// Everything the device sent: `(method, path and query, body)`.
type Sent = Arc<Mutex<Vec<(String, String, String)>>>;

/// Forwards to `upstream` and records each request. Sign-in's Supabase URL
/// (in `/v1/auth/config`) is pointed at the proxy too, so nothing bypasses it.
async fn recording_proxy(upstream: String) -> (String, Sent) {
    let sent: Sent = Arc::default();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (seen, me) = (sent.clone(), url.clone());
    let http = reqwest::Client::new();
    let app = axum::Router::new().fallback(move |req: Request| {
        let (seen, http, upstream, me) = (seen.clone(), http.clone(), upstream.clone(), me.clone());
        async move {
            let method = req.method().clone();
            let path = req.uri().path_and_query().map(|p| p.to_string()).unwrap_or_default();
            let headers = req.headers().clone();
            let body = to_bytes(req.into_body(), 16 << 20).await.unwrap();
            seen.lock().unwrap().push((method.to_string(), path.clone(), String::from_utf8_lossy(&body).into_owned()));
            let mut out = http.request(method, format!("{upstream}{path}")).body(body.to_vec());
            for name in ["authorization", "apikey", "content-type"] {
                if let Some(v) = headers.get(name) {
                    out = out.header(name, v);
                }
            }
            let res = out.send().await.unwrap();
            let status = res.status().as_u16();
            let kind = res.headers().get("content-type").cloned();
            let text = res.text().await.unwrap().replace(&upstream, &me);
            let mut r = Response::builder().status(status);
            if let Some(k) = kind {
                r = r.header("content-type", k);
            }
            r.body(Body::from(text)).unwrap()
        }
    });
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, sent)
}

async fn call(cloud: &Arc<Cloud>, channel: &str, args: Value) -> Result<Value, String> {
    cloud.route(channel, args.as_array().unwrap()).await
}

#[tokio::test]
async fn registered_methods_never_reach_nekko_cloud() {
    let Ok(upstream) = std::env::var("NEKKO_CLOUD_ITEST_URL") else {
        eprintln!("NEKKO_CLOUD_ITEST_URL not set; skipping");
        return;
    };
    let (url, sent) = recording_proxy(upstream.trim_end_matches('/').to_string()).await;
    let dir = tempfile::tempdir().unwrap();
    // What Settings → Security and remote access leave in the data directory.
    let leaks = [
        "nekko-computer:machine-7f3a",
        "Q3JlZGVudGlhbElkRm9yU0s5",
        "BPublicKeyOfTheSecurityKeyForSK9",
        "JBSWY3DPEHPK3PXPSK9TOTP",
        "5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8",
        "Philip's YubiKey",
        "security-key",
        "phone-sk9",
    ];
    let security = json!({
        "version": 1, "enabled": true, "rpId": leaks[0], "origins": ["nekko-app://desktop"],
        "credentials": [{ "id": leaks[1], "publicKey": leaks[2], "counter": 7, "name": leaks[5], "kind": leaks[6], "addedAt": 1 }],
        "totp": { "secret": leaks[3], "addedAt": 1 },
        "recoveryHashes": [leaks[4]],
    });
    std::fs::write(dir.path().join("security.json"), security.to_string()).unwrap();
    let remote = json!({ "enabled": false, "devices": [{ "id": leaks[7], "name": "Pixel", "pairedAt": 1 }] });
    std::fs::write(dir.path().join("remote.json"), remote.to_string()).unwrap();

    let store = Arc::new(SessionStore::new(dir.path()));
    let cloud = Cloud::new(Options {
        dir: dir.path().join("cloud"),
        api_url: url,
        device_label: "Cloud machine".into(),
        sessions: store.clone(),
        vault: Box::new(FileVault::new(dir.path().join("cloud").join("secrets.json"))),
        publish: Arc::new(|_| {}),
        busy: Arc::new(|_| false),
    });
    let email = format!("sk9-{}@example.com", std::process::id());
    call(&cloud, "cloud:sendCode", json!([email])).await.unwrap();
    let s = call(&cloud, "cloud:verifyCode", json!([email, CODE])).await.unwrap();
    assert!(s["signedIn"] == true, "sign-in didn't finish");
    let recovery = call(&cloud, "sync:turnOn", json!([])).await.unwrap()["recoveryKey"].as_str().unwrap().to_string();
    call(&cloud, "sync:confirmRecoveryKey", json!([recovery])).await.unwrap();
    let chat = json!({ "id": "s_1_sk9", "title": "Raise to YOLO", "messages": [{ "role": "user", "content": "hi" }], "createdAt": 1.0, "updatedAt": 2.0 });
    store.put_synced(&chat).unwrap();
    call(&cloud, "sync:now", json!([])).await.unwrap();
    assert_eq!(cloud.status()["sync"]["phase"], "idle");

    let sent = sent.lock().unwrap().clone();
    assert!(
        sent.iter().any(|(m, p, _)| m == "POST" && p.starts_with("/v1/sync/push")),
        "the chat was pushed: {sent:?}"
    );
    for (method, path, body) in &sent {
        for leak in leaks {
            assert!(!path.contains(leak) && !body.contains(leak), "{method} {path} carried {leak}");
        }
        assert!(!body.contains("rpId") && !body.contains("recoveryHashes"), "{method} {path} carried security.json");
    }
}
