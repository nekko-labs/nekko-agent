//! Route policy exercised through the real daemon, with loopback-only catalogs.
#[allow(dead_code)]
mod common;
use common::*;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

#[tokio::test(flavor = "multi_thread")]
async fn delegation_guard_new_default_and_resumed_routes_use_saved_permission() {
    let hits = Arc::new(AtomicUsize::new(0));
    let count = hits.clone();
    let app = axum::Router::new().route(
        "/v1/models",
        axum::routing::get(move || {
            let count = count.clone();
            async move {
                count.fetch_add(1, Ordering::SeqCst);
                axum::Json(json!({ "data": [{ "id": "chat-model" }] }))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let data = tempfile::tempdir().unwrap();
    std::fs::create_dir(data.path().join("sessions")).unwrap();
    let settings = json!({
        "providers": [
            { "id": "cloud", "kind": "openai", "enabled": true, "baseUrl": format!("http://127.0.0.1:{port}/v1") },
            { "id": "local", "kind": "openai-compat", "enabled": true, "baseUrl": format!("http://127.0.0.1:{port}/v1") },
            { "id": "nekko-engine", "kind": "llamacpp", "enabled": true, "baseUrl": format!("http://127.0.0.1:{port}/v1") }
        ],
        "defaultSessionOptions": { "autoModel": true, "autoProviderSwitch": true },
        "orchestration": { "delegationRoute": { "providerId": "local", "modelId": "chat-model" } }
    });
    std::fs::write(data.path().join("settings.json"), settings.to_string()).unwrap();
    let cases = [
        ("plain", json!({}), "cloud", "local", false),
        ("explicit_engine", json!({}), "cloud", "nekko-engine", false),
        ("switch_only", json!({"autoProviderSwitch": true}), "cloud", "local", false),
        ("router", json!({"autoModel": true}), "cloud", "local", true),
        ("fusion", json!({"autoModel": true, "autoProviderSwitch": true}), "cloud", "local", true),
        (
            "cloud_only",
            json!({"cloudOnly": true, "autoModel": true, "autoProviderSwitch": true}),
            "cloud",
            "local",
            false,
        ),
        ("local_local", json!({}), "local", "local", true),
        ("cloud_cloud", json!({}), "cloud", "cloud", true),
        ("default_plain", json!({}), "cloud", "local", false),
        ("default_fusion", json!({"autoModel": true, "autoProviderSwitch": true}), "cloud", "local", true),
    ];
    for (id, flags, source, _, _) in &cases {
        let mut parent = json!({"id": id, "providerId": source, "modelId": "chat-model", "messages": [], "createdAt": 1, "updatedAt": 1});
        parent.as_object_mut().unwrap().extend(flags.as_object().unwrap().clone());
        std::fs::write(data.path().join(format!("sessions/{id}.json")), parent.to_string()).unwrap();
    }
    let d = start_with(data.path());
    for (id, flags, source, target, allowed) in cases {
        let input = if id.starts_with("default_") {
            json!({"task": "test"})
        } else {
            json!({"task": "test", "provider_id": target, "model_id": "chat-model"})
        };
        // Deliberately stale permissions: only the saved parent may authorize routing.
        let req = json!({"parent": {"id": id, "autoModel": !allowed}, "providerId": source,
            "modelId": "chat-model", "input": input});
        let before = hits.load(Ordering::SeqCst);
        let (status, result) = post(d.port, "turn:spawnPrepare", json!([req]), Some(TOKEN)).await;
        assert_eq!(status, 200, "{id}: {result}");
        if !allowed {
            assert!(result["error"].as_str().is_some_and(|e| e.contains("local model")), "{id}: {result}");
            assert_eq!(hits.load(Ordering::SeqCst), before, "{id}: refused before discovery");
            continue;
        }
        assert!(result["spec"].is_object(), "{id}: admitted a child turn: {result}");
        let child = result["childId"].as_str().unwrap_or_else(|| panic!("{id}: {result}"));
        let resume = json!({"parent": {"id": id}, "providerId": source,
            "modelId": "chat-model", "childId": child, "attempt": 1});
        let (_, resumed) = post(d.port, "turn:spawnPrepare", json!([resume.clone()]), Some(TOKEN)).await;
        assert!(resumed["spec"].is_object(), "{id}: permitted resume: {resumed}");
        let saved: Value =
            serde_json::from_str(&std::fs::read_to_string(data.path().join(format!("sessions/{child}.json"))).unwrap())
                .unwrap();
        for key in ["autoModel", "autoProviderSwitch"] {
            assert_eq!(saved[key], json!(flags[key].as_bool().unwrap_or(false)), "{id}: {key}");
        }
        if id == "cloud_cloud" {
            // A parent's broader routing scope must not erase a child's restriction.
            let (status, _) =
                post(d.port, "session:setOptions", json!([child, {"cloudOnly": true}]), Some(TOKEN)).await;
            assert_eq!(status, 200);
            let (_, resumed) = post(d.port, "turn:spawnPrepare", json!([resume.clone()]), Some(TOKEN)).await;
            assert!(resumed["spec"].is_object(), "{resumed}");
            let saved: Value = serde_json::from_str(
                &std::fs::read_to_string(data.path().join(format!("sessions/{child}.json"))).unwrap(),
            )
            .unwrap();
            assert_eq!(saved["cloudOnly"], true);
            for key in ["offline", "incognito"] {
                let (status, _) = post(
                    d.port,
                    "session:setOptions",
                    json!([id, {"offline": false, "incognito": false, key: true}]),
                    Some(TOKEN),
                )
                .await;
                assert_eq!(status, 200);
                let (_, refused) = post(d.port, "turn:spawnPrepare", json!([resume.clone()]), Some(TOKEN)).await;
                assert!(
                    refused["error"].as_str().is_some_and(|e| e.contains("Offline or incognito")),
                    "{key}: {refused}"
                );
            }
        }
        if id == "router" {
            // Cloud-only wins even when Auto is still enabled, including on resume.
            let (status, _) = post(d.port, "session:setOptions", json!([id, {"cloudOnly": true}]), Some(TOKEN)).await;
            assert_eq!(status, 200);
            let before = hits.load(Ordering::SeqCst);
            let (_, refused) = post(d.port, "turn:spawnPrepare", json!([resume]), Some(TOKEN)).await;
            assert!(refused["error"].as_str().is_some_and(|e| e.contains("cloud models only")), "{refused}");
            assert_eq!(hits.load(Ordering::SeqCst), before);
        }
        if id == "fusion" {
            // Revoke permission while a caller still holds its Fusion snapshot.
            let (_, patched) = post(
                d.port,
                "session:setOptions",
                json!([id, {"autoModel": false, "autoProviderSwitch": false}]),
                Some(TOKEN),
            )
            .await;
            assert_eq!(patched["autoModel"], false, "{patched}");
            let before = hits.load(Ordering::SeqCst);
            let (_, resumed) = post(
                d.port,
                "turn:spawnPrepare",
                json!([{
                    "parent": {"id": id, "autoModel": true, "autoProviderSwitch": true},
                    "providerId": source, "modelId": "chat-model", "childId": child, "attempt": 1
                }]),
                Some(TOKEN),
            )
            .await;
            assert!(resumed["error"].as_str().is_some_and(|e| e.contains("Cloud chats cannot delegate")), "{resumed}");
            assert_eq!(hits.load(Ordering::SeqCst), before);
        }
    }
    let children = std::fs::read_dir(data.path().join("sessions"))
        .unwrap()
        .flatten()
        .filter(|e| std::fs::read_to_string(e.path()).unwrap_or_default().contains("\"parentSessionId\""))
        .count();
    assert_eq!(children, 5, "only the five permitted routes created children");
    drop(d);
    server.abort();
}
