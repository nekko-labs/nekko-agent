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
        ("forged_source", json!({}), "cloud", "local", false),
        ("explicit_engine", json!({}), "cloud", "nekko-engine", false),
        ("switch_only", json!({"autoProviderSwitch": true}), "cloud", "local", false),
        ("router", json!({"autoModel": true}), "cloud", "local", false),
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
        ("assignment_plain", json!({"orchestrate":true}), "cloud", "local", false),
        (
            "assignment_fusion",
            json!({"orchestrate":true,"autoModel":true,"autoProviderSwitch":true}),
            "cloud",
            "local",
            true,
        ),
    ];
    for (id, flags, source, _, _) in &cases {
        let mut parent = json!({"id": id, "providerId": source, "modelId": "chat-model", "messages": [], "createdAt": 1, "updatedAt": 1});
        parent.as_object_mut().unwrap().extend(flags.as_object().unwrap().clone());
        std::fs::write(data.path().join(format!("sessions/{id}.json")), parent.to_string()).unwrap();
    }
    let d = start_with(data.path());
    for (id, flags, source, target, allowed) in cases {
        let input = if id.starts_with("assignment_") {
            json!({"task": "test", "capability": "small"})
        } else if id.starts_with("default_") {
            json!({"task": "test"})
        } else {
            json!({"task": "test", "provider_id": target, "model_id": "chat-model"})
        };
        // Deliberately stale permissions: only the saved parent may authorize routing.
        let req = json!({"parent": {"id": id, "autoModel": !allowed}, "providerId": if id == "forged_source" { "local" } else { source },
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
        if id == "default_fusion" {
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
            assert!(
                resumed["error"].as_str().is_some_and(|e| e.contains("Provider switching requires Fusion")),
                "{resumed}"
            );
            assert_eq!(hits.load(Ordering::SeqCst), before);
        }
    }
    // Discovery uses the same saved provider scope and refuses before browsing.
    for (parent, target, allowed) in [
        ("plain", "local", false),
        ("plain", "cloud", true),
        ("local_local", "cloud", false),
        ("default_fusion", "local", false),
    ] {
        let before = hits.load(Ordering::SeqCst);
        let (status, result) = post(
            d.port,
            "turn:delegationTargets",
            json!([{"sessionId":parent, "sourceId":"cloud", "providerId":target}]),
            Some(TOKEN),
        )
        .await;
        assert_eq!(status == 200, allowed, "{parent} -> {target}: {status} {result}");
        assert_eq!(hits.load(Ordering::SeqCst) - before, usize::from(allowed));
    }
    let children = std::fs::read_dir(data.path().join("sessions"))
        .unwrap()
        .flatten()
        .filter(|e| std::fs::read_to_string(e.path()).unwrap_or_default().contains("\"parentSessionId\""))
        .count();
    assert_eq!(children, 5, "only permitted routes created children");
    drop(d);
    server.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn automatic_tiers_respect_provider_permission_and_rank_across_local_catalogs() {
    let app = axum::Router::new()
        .route(
            "/cloud/models",
            axum::routing::get(|| async { axum::Json(json!({"data":[{"id":"gpt-5"},{"id":"gpt-5-mini"}]})) }),
        )
        .route("/small/models", axum::routing::get(|| async { axum::Json(json!({"data":[{"id":"qwen-8b"}]})) }))
        .route(
            "/local/models",
            axum::routing::get(|| async { axum::Json(json!({"data":[{"id":"qwen-32b"},{"id":"llama-70b"}]})) }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    for (name, fusion, tier, expected_provider, expected_model) in [
        ("pinned", false, "medium", "cloud", "gpt-5-mini"),
        ("medium", true, "medium", "local", "qwen-32b"),
        ("small", true, "small", "small-local", "qwen-8b"),
    ] {
        let data = tempfile::tempdir().unwrap();
        std::fs::create_dir(data.path().join("sessions")).unwrap();
        let settings = json!({"providers":[
            {"id":"cloud","kind":"openai","enabled":true,"baseUrl":format!("http://127.0.0.1:{port}/cloud")},
            {"id":"small-local","kind":"openai-compat","enabled":true,"baseUrl":format!("http://127.0.0.1:{port}/small")},
            {"id":"local","kind":"openai-compat","enabled":true,"baseUrl":format!("http://127.0.0.1:{port}/local")}
        ], "orchestration":{"subagentModel":"auto-local","subagentTier":tier}});
        std::fs::write(data.path().join("settings.json"), settings.to_string()).unwrap();
        let parent = json!({"id":name,"providerId":"cloud","modelId":"gpt-5","messages":[],"createdAt":1,"updatedAt":1,"autoModel":fusion,"autoProviderSwitch":fusion});
        std::fs::write(data.path().join(format!("sessions/{name}.json")), parent.to_string()).unwrap();
        let d = start_with(data.path());
        let (_, result) = post(
            d.port,
            "turn:spawnPrepare",
            json!([{"parent":{"id":name},"providerId":"cloud","modelId":"gpt-5","input":{"task":"focused worker"}}]),
            Some(TOKEN),
        )
        .await;
        assert!(result["spec"].is_object(), "{name}: {result}");
        let child = result["childId"].as_str().unwrap();
        let saved: Value =
            serde_json::from_str(&std::fs::read_to_string(data.path().join(format!("sessions/{child}.json"))).unwrap())
                .unwrap();
        assert_eq!(saved["providerId"], expected_provider, "{name}: {saved}");
        assert_eq!(saved["modelId"], expected_model, "{name}: {saved}");
        drop(d);
    }
    server.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn assignment_capability_obeys_saved_bounds_and_never_falls_back_on_error() {
    let cloud_hits = Arc::new(AtomicUsize::new(0));
    let local_hits = Arc::new(AtomicUsize::new(0));
    let (cloud, local) = (cloud_hits.clone(), local_hits.clone());
    let app = axum::Router::new()
        .route(
            "/cloud/models",
            axum::routing::get(move || async move {
                cloud.fetch_add(1, Ordering::SeqCst);
                axum::Json(json!({"data":[{"id":"gpt-5"},{"id":"gpt-4o"},{"id":"gpt-5-mini"}]}))
            }),
        )
        .route(
            "/local/models",
            axum::routing::get(move || async move {
                local.fetch_add(1, Ordering::SeqCst);
                (axum::http::StatusCode::BAD_GATEWAY, "private diagnostic")
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let cap = |tier: &str| json!({"task":"review result","capability":tier});
    let no_prefs = json!({});
    let fusion = json!({"autoModel":true,"autoProviderSwitch":true});
    let auto_local = json!({"subagentModel":"auto-local"});
    // (saved parent model, saved flags, user settings, input, cloud/local discovery, expected model or error)
    for (parent_model, flags, prefs, input, hits, expected) in [
        ("gpt-5", json!({}), &no_prefs, cap("large"), (1, 0), Ok("gpt-5")),
        ("gpt-5", json!({}), &no_prefs, cap("medium"), (1, 0), Ok("gpt-4o")),
        ("gpt-5", json!({}), &no_prefs, cap("small"), (1, 0), Ok("gpt-5-mini")),
        ("gpt-4o", json!({}), &no_prefs, cap("large"), (1, 0), Ok("gpt-4o")),
        (
            "gpt-4o",
            json!({}),
            &json!({"subagentTier":"small", "delegationRoute":{"providerId":"cloud","modelId":"gpt-5"}}),
            cap("small"),
            (1, 0),
            Ok("gpt-5"),
        ),
        (
            "gpt-5",
            json!({"privacy":{"mode":"redact"}}),
            &no_prefs,
            cap("small"),
            (0, 0),
            Err("Delegation is unavailable"),
        ),
        ("gpt-5", json!({"syncOff":true}), &no_prefs, cap("small"), (0, 0), Err("Delegation is unavailable")),
        (
            "gpt-5",
            json!({}),
            &json!({"delegationRoute":false}),
            cap("small"),
            (0, 0),
            Err("saved delegation route requires exact"),
        ),
        ("gpt-5", json!({}), &json!({"subagentTier":"medium"}), cap("large"), (1, 0), Ok("gpt-4o")),
        ("gpt-5", json!({}), &json!({"subagentModel":"inherit"}), cap("small"), (0, 0), Ok("gpt-5")),
        ("gpt-5", json!({}), &auto_local, cap("small"), (1, 0), Ok("gpt-5-mini")),
        ("gpt-5", fusion.clone(), &auto_local, cap("small"), (0, 1), Err("Could not verify")),
        (
            "gpt-5",
            json!({"autoModel":true,"autoProviderSwitch":true,"cloudOnly":true}),
            &auto_local,
            cap("small"),
            (1, 0),
            Ok("gpt-5-mini"),
        ),
        ("gpt-5", json!({"orchestrate":"true"}), &no_prefs, cap("small"), (0, 0), Err("only available in Orchestrate")),
        (
            "gpt-5",
            json!({}),
            &no_prefs,
            json!({"task":"x","capability":null}),
            (0, 0),
            Err("must be small, medium, or large"),
        ),
        ("gpt-5", json!({}), &no_prefs, cap("frontier"), (0, 0), Err("must be small, medium, or large")),
        (
            "gpt-5",
            json!({}),
            &no_prefs,
            json!({"task":"x","capability":"small","model_id":"gpt-5"}),
            (0, 0),
            Err("Omit provider_id and model_id"),
        ),
        (
            "gpt-5",
            json!({"disabledTools":["spawn_agent"]}),
            &no_prefs,
            cap("small"),
            (0, 0),
            Err("Delegation is unavailable"),
        ),
        (
            "gpt-5",
            json!({"executionMode":"sandbox"}),
            &no_prefs,
            cap("small"),
            (0, 0),
            Err("Delegation is unavailable"),
        ),
        ("unknown", json!({}), &no_prefs, cap("small"), (0, 0), Err("known capability tier")),
        ("gpt-5-mini", json!({}), &json!({"subagentTier":"smaller"}), cap("large"), (1, 0), Err("No eligible model")),
        (
            "gpt-5",
            json!({}),
            &json!({"delegationRoute":{"providerId":"cloud","modelId":"not-listed"}}),
            cap("small"),
            (1, 0),
            Err("exact model ID is not available"),
        ),
        (
            "gpt-5",
            json!({}),
            &json!({"delegationRoute":{"providerId":"cloud"}}),
            cap("small"),
            (0, 0),
            Err("saved delegation route requires exact"),
        ),
    ] {
        let data = tempfile::tempdir().unwrap();
        let sessions = data.path().join("sessions");
        std::fs::create_dir(&sessions).unwrap();
        let settings = json!({"providers":[
            {"id":"cloud","kind":"openai","enabled":true,"baseUrl":format!("http://127.0.0.1:{port}/cloud")},
            {"id":"local","kind":"openai-compat","enabled":true,"baseUrl":format!("http://127.0.0.1:{port}/local")}
        ], "orchestration":prefs});
        std::fs::write(data.path().join("settings.json"), settings.to_string()).unwrap();
        let mut parent = json!({"id":"parent","orchestrate":true,"providerId":"cloud","modelId":parent_model,"messages":[],"createdAt":1,"updatedAt":1});
        parent.as_object_mut().unwrap().extend(flags.as_object().unwrap().clone());
        std::fs::write(sessions.join("parent.json"), parent.to_string()).unwrap();
        let d = start_with(data.path());
        let before = (cloud_hits.load(Ordering::SeqCst), local_hits.load(Ordering::SeqCst));
        let (status, result) = post(
            d.port,
            "turn:spawnPrepare",
            json!([{
                "parent":{"id":"parent","orchestrate":true},"providerId":"cloud","modelId":parent_model,"input":input
            }]),
            Some(TOKEN),
        )
        .await;
        assert_eq!(status, 200, "{flags}: {input}: {result}");
        assert_eq!(
            (cloud_hits.load(Ordering::SeqCst) - before.0, local_hits.load(Ordering::SeqCst) - before.1),
            hits,
            "{flags}: {prefs}: {input}: {result}"
        );
        match expected {
            Ok(model) => {
                assert!(result["spec"].is_object(), "{flags}: {input}: {result}");
                let child = result["childId"].as_str().unwrap();
                let saved: Value =
                    serde_json::from_str(&std::fs::read_to_string(sessions.join(format!("{child}.json"))).unwrap())
                        .unwrap();
                assert_eq!(saved["providerId"], "cloud");
                assert_eq!(saved["modelId"], model, "{flags}: {input}: {saved}");
            }
            Err(message) => {
                let error = result["error"].as_str().unwrap_or_else(|| panic!("{flags}: {input}: {result}"));
                assert!(error.contains(message) && !error.contains("private diagnostic"), "{error}");
                assert_eq!(std::fs::read_dir(&sessions).unwrap().count(), 1, "no child persisted");
            }
        }
        drop(d);
    }
    server.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn delegation_does_not_use_old_permissions_after_a_catalog_request() {
    let started = Arc::new(tokio::sync::Notify::new());
    let finish = Arc::new(tokio::sync::Notify::new());
    let catalog = (started.clone(), finish.clone());
    let app = axum::Router::new().route(
        "/v1/models",
        axum::routing::get(move || {
            let (started, finish) = catalog.clone();
            async move {
                started.notify_one();
                finish.notified().await;
                axum::Json(json!({"data":[{"id":"gpt-5-mini"}]}))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let data = tempfile::tempdir().unwrap();
    let sessions = data.path().join("sessions");
    std::fs::create_dir(&sessions).unwrap();
    let parent = json!({"id":"parent","orchestrate":true,"mode":"yolo","providerId":"p","modelId":"gpt-5","messages":[],"createdAt":1,"updatedAt":1});
    let settings = json!({"providers":[{"id":"p","enabled":true,"kind":"openai","baseUrl":format!("http://127.0.0.1:{port}/v1")}]});
    std::fs::write(sessions.join("parent.json"), parent.to_string()).unwrap();
    std::fs::write(data.path().join("settings.json"), settings.to_string()).unwrap();
    let d = start_with(data.path());
    let port = d.port;
    let prepare = tokio::spawn(async move {
        post(
            port,
            "turn:spawnPrepare",
            json!([{"parent":{"id":"parent"}, "input":{"task":"owned task", "capability":"small"}}]),
            Some(TOKEN),
        )
        .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), started.notified()).await.unwrap();
    let (status, _) =
        post(port, "session:setOptions", json!(["parent", {"mode":"ask","orchestrate":false}]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    finish.notify_one();
    let (_, reply) = tokio::time::timeout(std::time::Duration::from_secs(5), prepare).await.unwrap().unwrap();
    assert!(reply["error"].as_str().is_some_and(|e| e.contains("changed while checking")), "{reply}");
    assert_eq!(std::fs::read_dir(&sessions).unwrap().count(), 1);
    server.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn resume_requires_the_original_task_owner_and_a_well_formed_attempt() {
    let data = tempfile::tempdir().unwrap();
    let sessions = data.path().join("sessions");
    std::fs::create_dir(&sessions).unwrap();
    let parent = json!({"id":"parent","orchestrate":true,"providerId":"p","modelId":"m","messages":[],"createdAt":1,"updatedAt":1});
    let child = json!({"id":"worker","parentSessionId":"parent","spawnCallId":"call_1","providerId":"p","modelId":"m","messages":[],"createdAt":1,"updatedAt":1});
    for (id, record) in [("parent", parent), ("worker", child)] {
        std::fs::write(sessions.join(format!("{id}.json")), record.to_string()).unwrap();
    }
    let d = start_with(data.path());
    for (attempt, call, expected) in [
        (json!(1), json!("call_2"), "Unknown child session"),
        (json!(1), Value::Null, "Invalid sub-agent call ID"),
        (json!("1"), json!("call_1"), "Invalid sub-agent start or resume"),
        (json!(0), json!("call_1"), "Invalid sub-agent start or resume"),
    ] {
        let (_, reply) = post(
            d.port,
            "turn:spawnPrepare",
            json!([{"parent":{"id":"parent"}, "childId":"worker", "attempt":attempt, "callId":call}]),
            Some(TOKEN),
        )
        .await;
        assert!(reply["error"].as_str().is_some_and(|e| e.contains(expected)), "{reply}");
    }
    assert_eq!(std::fs::read_dir(&sessions).unwrap().count(), 2);
}
