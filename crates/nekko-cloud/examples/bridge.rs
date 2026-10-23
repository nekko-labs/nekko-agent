//! The cloud engine over plain HTTP, for UI work without the whole app:
//! `POST /call {channel, args}` runs a `cloud:*` / `sync:*` channel, and
//! `GET /status` returns the latest status (the UI polls it in place of the
//! `cloud:status` event). Point it at the local dev API:
//!
//!   cargo run -p nekko-cloud --example bridge -- <data dir> http://127.0.0.1:4330 4331 "Studio Mac" [demo chats]

use axum::Json;
use axum::extract::State;
use nekko_cloud::vault::FileVault;
use nekko_cloud::{Cloud, Options};
use nekko_store::SessionStore;
use serde_json::{Value, json};
use std::sync::Arc;

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dir = std::path::PathBuf::from(args.get(1).expect("data dir"));
    let api = args.get(2).cloned().unwrap_or_else(|| "http://127.0.0.1:4330".into());
    let port: u16 = args.get(3).and_then(|p| p.parse().ok()).unwrap_or(4331);
    let label = args.get(4).cloned().unwrap_or_else(|| "This computer".into());
    let demo: usize = args.get(5).and_then(|n| n.parse().ok()).unwrap_or(0);
    let store = Arc::new(SessionStore::new(&dir));
    for i in 0..demo {
        let topics = [
            "Plan the Kyoto trip",
            "Fix the flaky login test",
            "Draft the launch post",
            "Refactor the billing module",
            "Compare vector databases",
        ];
        let t = topics[i % topics.len()];
        let chat = json!({ "id": format!("s_demo_{i}"), "title": t, "createdAt": 1.0, "updatedAt": 1_760_000_000_000.0 + i as f64,
            "messages": [{ "role": "user", "content": format!("{t}: let's get started.") }, { "role": "assistant", "content": "Here's a plan." }] });
        store.put_synced(&chat).unwrap();
    }
    let cloud = Cloud::new(Options {
        dir: dir.join("cloud"),
        api_url: api,
        device_label: label,
        sessions: store,
        vault: Box::new(FileVault::new(dir.join("cloud").join("secrets.json"))),
        publish: Arc::new(|_| {}),
        busy: Arc::new(|_| false),
    });
    cloud.start(std::time::Duration::from_secs(20));
    let app = axum::Router::new()
        .route(
            "/call",
            axum::routing::post(|State(c): State<Arc<Cloud>>, Json(body): Json<Value>| async move {
                let channel = body["channel"].as_str().unwrap_or("").to_string();
                let args = body["args"].as_array().cloned().unwrap_or_default();
                Json(match c.route(&channel, &args).await {
                    Ok(v) => json!({ "ok": v }),
                    Err(e) => json!({ "error": e }),
                })
            })
            .options(|| async { "" }),
        )
        .route("/status", axum::routing::get(|State(c): State<Arc<Cloud>>| async move { Json(c.status()) }))
        .layer(axum::middleware::from_fn(|req: axum::extract::Request, next: axum::middleware::Next| async move {
            let mut res = next.run(req).await;
            let h = res.headers_mut();
            h.insert("access-control-allow-origin", "*".parse().unwrap());
            h.insert("access-control-allow-headers", "content-type".parse().unwrap());
            res
        }))
        .with_state(cloud);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.unwrap();
    eprintln!("cloud bridge on http://127.0.0.1:{port}");
    axum::serve(listener, app).await.unwrap();
}
