//! The real `nekkod` binary end to end: settings, sign-in tokens, providers, folders and connectors, written and read by the daemon.

use crate::common::*;

#[tokio::test(flavor = "multi_thread")]
async fn settings_are_the_daemons_to_write_when_it_knows_the_data_dir() {
    let data = std::env::temp_dir().join(format!("nekkod-settings-{}", std::process::id()));
    std::fs::create_dir_all(&data).unwrap();
    std::fs::write(data.join("settings.json"), r#"{"theme":"dark","maxSteps":3}"#).unwrap();
    let d = start_with(&data);

    let (status, got) = post(d.port, "settings:get", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    assert_eq!(got["theme"], "dark");
    assert!(got.get("maxSteps").is_none());
    assert!(got["guardrails"].as_array().is_some_and(|g| !g.is_empty()), "merged over the defaults");
    // The UI's update: written by the daemon.
    let patch = json!({ "voice": { "enabled": true }, "workspaces": [{ "id": "a", "path": "/x" }, { "id": "b", "path": "/x/" }] });
    let (_, next) = post(d.port, "settings:update", json!([patch]), Some(TOKEN)).await;
    assert_eq!(next["workspaces"], json!([{ "id": "a", "path": "/x" }]));
    let on_disk: Value = serde_json::from_str(&std::fs::read_to_string(data.join("settings.json")).unwrap()).unwrap();
    assert_eq!(on_disk, next);
    // A patch merges over what is saved.
    let (_, saved) = post(d.port, "settings:update", json!([{ "theme": "light" }]), Some(TOKEN)).await;
    assert_eq!((saved["theme"].clone(), saved["voice"].clone()), (json!("light"), json!({ "enabled": true })));
    // The TS host's own write channel is gone with the host.
    let (status, _) = post(d.port, "settings:save", json!([{ "theme": "dark" }]), Some(TOKEN)).await;
    assert_ne!(status, 200);
    let (status, err) = post(d.port, "settings:update", json!([null]), Some(TOKEN)).await;
    assert_ne!(status, 200, "a missing patch is refused as saveSettings refuses it: {err}");
    let (_, reset) = post(d.port, "settings:reset", json!([]), Some(TOKEN)).await;
    assert_eq!(reset["theme"], "system");
    drop(d);
    std::fs::remove_dir_all(data).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn tokens_are_the_daemons_to_read_renew_and_forget() {
    let data = std::env::temp_dir().join(format!("nekkod-tokens-{}", std::process::id()));
    std::fs::create_dir_all(&data).unwrap();
    std::fs::write(
        data.join("settings.json"),
        r#"{"providers":[{"id":"or","kind":"openrouter","tokenKey":"openrouter:k","auth":"apikey"},{"id":"plain","kind":"openai"}]}"#,
    )
    .unwrap();
    std::fs::write(
        data.join("tokens.json"),
        r#"{"openrouter:k":{"provider":"openrouter","accessToken":"sk-or","obtainedAt":1}}"#,
    )
    .unwrap();
    let d = start_with(&data);

    let (_, status) = post(d.port, "oauth:status", json!(["or"]), Some(TOKEN)).await;
    assert_eq!(
        status,
        json!({ "tokenKey": "openrouter:k", "provider": "openrouter", "connected": true, "state": "success" })
    );
    let (_, plain) = post(d.port, "oauth:status", json!(["plain"]), Some(TOKEN)).await;
    assert_eq!(plain["message"], "Provider has no token key.");
    // A permanent key needs no renewal.
    let (_, fresh) = post(d.port, "oauth:fresh", json!(["openrouter:k", false]), Some(TOKEN)).await;
    assert_eq!(fresh, json!("sk-or"));
    let (status_code, missing) = post(d.port, "oauth:fresh", json!(["claude:none", false]), Some(TOKEN)).await;
    assert_ne!(status_code, 200, "{missing}");
    post(d.port, "oauth:signout", json!(["or"]), Some(TOKEN)).await;
    let tokens: Value = serde_json::from_str(&std::fs::read_to_string(data.join("tokens.json")).unwrap()).unwrap();
    assert_eq!(tokens, json!({}));
    drop(d);
    std::fs::remove_dir_all(data).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn providers_are_listed_saved_tested_and_asked_for_models_by_the_daemon() {
    let data = std::env::temp_dir().join(format!("nekkod-providers-{}", std::process::id()));
    std::fs::create_dir_all(&data).unwrap();
    // An OpenAI-compatible server that wants a key.
    let app = axum::Router::new().route(
        "/v1/models",
        axum::routing::get(|headers: axum::http::HeaderMap| async move {
            if headers.get("authorization").and_then(|v| v.to_str().ok()) == Some("Bearer k1") {
                (axum::http::StatusCode::OK, axum::Json(json!({ "data": [{ "id": "m1" }, { "id": "m2" }] })))
            } else {
                (axum::http::StatusCode::UNAUTHORIZED, axum::Json(json!({ "error": { "message": "bad key" } })))
            }
        }),
    );
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    let d = start_with(&data);
    // The model server's own entry, added at launch.
    boot_settled(&data);
    let read =
        || -> Value { serde_json::from_str(&std::fs::read_to_string(data.join("settings.json")).unwrap()).unwrap() };
    let engine = read()["providers"][0].clone();
    assert_eq!(engine["kind"], "llamacpp");

    let p = json!({ "id": "p1", "kind": "openai-compat", "label": "Local", "baseUrl": base, "apiKey": "k1", "enabled": true });
    let (_, saved) = post(d.port, "providers:save", json!([p]), Some(TOKEN)).await;
    assert_eq!(saved, json!([engine, p]));
    let (_, listed) = post(d.port, "providers:list", json!([]), Some(TOKEN)).await;
    assert_eq!(listed, json!([engine, p]));
    let (_, ok) = post(d.port, "providers:test", json!(["p1"]), Some(TOKEN)).await;
    assert_eq!(ok, json!({ "ok": true, "message": "Connected" }));
    let mut bad = p.clone();
    bad["apiKey"] = json!("nope");
    let (_, refused) = post(d.port, "providers:testConfig", json!([bad]), Some(TOKEN)).await;
    assert_eq!(refused, json!({ "ok": false, "message": "HTTP 401, check your API key: bad key" }));
    let (_, missing) = post(d.port, "providers:test", json!(["nope"]), Some(TOKEN)).await;
    assert_eq!(missing, json!({ "ok": false, "message": "Not found" }));
    let (_, models) = post(d.port, "models:list", json!(["p1"]), Some(TOKEN)).await;
    let ids: Vec<&str> = models.as_array().unwrap().iter().map(|m| m["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["m1", "m2"]);
    let (_, status) = post(d.port, "models:listStatus", json!(["p1"]), Some(TOKEN)).await;
    assert_eq!(status["models"], models);
    assert_eq!(status.get("error"), None);
    let (_, missing) = post(d.port, "models:listStatus", json!(["nope"]), Some(TOKEN)).await;
    assert_eq!(missing, json!({ "models": [] }));

    // A key the server refuses: models:list stays [], listStatus says why.
    post(d.port, "providers:save", json!([bad]), Some(TOKEN)).await;
    let (_, empty) = post(d.port, "models:list", json!(["p1"]), Some(TOKEN)).await;
    assert_eq!(empty, json!([]));
    let (_, failed) = post(d.port, "models:listStatus", json!(["p1"]), Some(TOKEN)).await;
    assert_eq!(failed, json!({ "models": [], "error": "listModels 401: bad key" }));
    let (_, none) = post(d.port, "lms:probe", json!(["p1"]), Some(TOKEN)).await;
    assert_eq!(none, json!({ "available": false }));
    let (_, removed) = post(d.port, "providers:remove", json!(["p1"]), Some(TOKEN)).await;
    assert_eq!(removed, json!([engine]));
    assert_eq!(read()["providers"], json!([engine]));
    drop(d);
    std::fs::remove_dir_all(data).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cloud_catalog_is_reused_until_the_key_changes_or_the_update_check_runs() {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    let data = std::env::temp_dir().join(format!("nekkod-catalog-{}", std::process::id()));
    std::fs::create_dir_all(&data).unwrap();
    // An Anthropic Models API that counts its calls and can be taken down.
    let calls = Arc::new(AtomicUsize::new(0));
    let down = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (c, dn) = (calls.clone(), down.clone());
    let app = axum::Router::new().route(
        "/v1/models",
        axum::routing::get(move || {
            let (c, dn) = (c.clone(), dn.clone());
            async move {
                c.fetch_add(1, Ordering::SeqCst);
                if dn.load(Ordering::SeqCst) {
                    return (axum::http::StatusCode::SERVICE_UNAVAILABLE, axum::Json(json!({})));
                }
                (axum::http::StatusCode::OK, axum::Json(json!({ "data": [{ "id": "claude-live-1" }] })))
            }
        }),
    );
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    let d = start_with(&data);
    boot_settled(&data);
    let ids = |models: &Value| -> Vec<String> {
        models.as_array().unwrap().iter().map(|m| m["id"].as_str().unwrap().to_string()).collect()
    };

    let p =
        json!({ "id": "c1", "kind": "anthropic", "label": "Claude", "baseUrl": base, "apiKey": "k1", "enabled": true });
    post(d.port, "providers:save", json!([p]), Some(TOKEN)).await;
    // The chat pane, the picker and the Models page: one request between them.
    let (_, first) = post(d.port, "models:list", json!(["c1"]), Some(TOKEN)).await;
    assert_eq!(ids(&first), ["claude-live-1"]);
    post(d.port, "models:list", json!(["c1"]), Some(TOKEN)).await;
    let (_, status) = post(d.port, "models:listStatus", json!(["c1"]), Some(TOKEN)).await;
    assert_eq!(status["models"], first);
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    // A new key is a new catalog.
    let mut rekeyed = p.clone();
    rekeyed["apiKey"] = json!("k2");
    post(d.port, "providers:save", json!([rekeyed]), Some(TOKEN)).await;
    post(d.port, "models:list", json!(["c1"]), Some(TOKEN)).await;
    assert_eq!(calls.load(Ordering::SeqCst), 2);

    // The update check always asks the provider.
    post(d.port, "updates:check", json!([]), Some(TOKEN)).await;
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    post(d.port, "models:list", json!(["c1"]), Some(TOKEN)).await;
    assert_eq!(calls.load(Ordering::SeqCst), 3);

    // An outage seen by the update check drops the entry, and the shipped
    // list it falls back to is never kept: every caller asks again.
    down.store(true, Ordering::SeqCst);
    post(d.port, "updates:check", json!([]), Some(TOKEN)).await;
    assert_eq!(calls.load(Ordering::SeqCst), 4);
    let (_, shipped) = post(d.port, "models:list", json!(["c1"]), Some(TOKEN)).await;
    assert!(ids(&shipped).contains(&"claude-opus-5-5".to_string()));
    assert_eq!(calls.load(Ordering::SeqCst), 5);
    down.store(false, Ordering::SeqCst);
    let (_, back) = post(d.port, "models:list", json!(["c1"]), Some(TOKEN)).await;
    assert_eq!(ids(&back), ["claude-live-1"]);
    assert_eq!(calls.load(Ordering::SeqCst), 6);
    drop(d);
    std::fs::remove_dir_all(data).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn adds_and_revokes_folders_through_the_daemons_settings() {
    let data = std::env::temp_dir().join(format!("nekkod-folders-{}", std::process::id()));
    let project = data.join("My Project");
    std::fs::create_dir_all(project.join("src")).unwrap();
    std::fs::write(project.join("src").join("x.rs"), "pub fn x() {}\n").unwrap();
    let path = project.to_string_lossy().into_owned();
    let d = start_with(&data);
    let (_, added) = post(d.port, "workspace:addByPath", json!([path]), Some(TOKEN)).await;
    let folder = added[0].clone();
    assert_eq!((folder["name"].clone(), folder["path"].clone()), (json!("My Project"), json!(path)));
    let id = folder["id"].as_str().unwrap().to_string();
    assert!(id.starts_with("ws_"));
    // The same folder spelled differently is not added twice.
    let respelled = format!("{path}{}", std::path::MAIN_SEPARATOR);
    let (_, again) = post(d.port, "workspace:addByPath", json!([respelled]), Some(TOKEN)).await;
    assert_eq!(again.as_array().unwrap().len(), 1);
    let (_, listed) = post(d.port, "workspace:list", json!([]), Some(TOKEN)).await;
    assert_eq!(listed, added);
    // Indexed shortly after it was added.
    let status = until("the folder's index", Duration::from_secs(10), || async {
        let status = post(d.port, "workspace:indexStatus", json!([id]), Some(TOKEN)).await.1;
        (status["state"] == "ready").then_some(status)
    })
    .await;
    assert_eq!((status["state"].clone(), status["symbolCount"].clone()), (json!("ready"), json!(1)));
    // A chat using it loses it when access is revoked; a running one blocks that.
    let sessions = data.join("sessions");
    std::fs::create_dir_all(&sessions).unwrap();
    let chat = |sid: &str| json!({ "id": sid, "title": sid, "workspaceId": id, "supportingWorkspaceIds": [id], "messages": [], "createdAt": 1, "updatedAt": 1 });
    std::fs::write(sessions.join("s_busy.json"), chat("s_busy").to_string()).unwrap();
    // A turn that waits on its model keeps s_busy running.
    let model = scripted_model(vec![HANG.into()]).await;
    let provider = json!({ "id": "p1", "kind": "openai-compat", "label": "Scripted", "enabled": true,
        "baseUrl": format!("http://127.0.0.1:{}/v1", model.port) });
    let spec = json!({
        "turnId": "turn_busy",
        "opts": { "sessionId": "s_busy", "providerId": "p1", "modelId": "synthetic", "text": "wait" },
        "settings": { "providers": [provider], "defaultChatMode": "yolo" },
        "facts": { "workspaces": [], "provider": provider, "promptCaching": true },
    });
    let (status, _) = post(d.port, "chat:turn", json!([spec]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    until_model_asked(&model, 1, "the busy chat's model call", Duration::from_secs(10)).await;
    let (status, refused) = post(d.port, "workspace:remove", json!([id]), Some(TOKEN)).await;
    assert_ne!(status, 200);
    assert!(refused.to_string().contains("Wait for chats"), "{refused}");
    post(d.port, "turn:abort", json!(["turn_busy"]), Some(TOKEN)).await;
    until("the busy turn to stop", Duration::from_secs(10), || async {
        let (_, alive) = post(d.port, "turn:alive", json!(["turn_busy"]), Some(TOKEN)).await;
        (alive == json!(false)).then_some(())
    })
    .await;
    std::fs::remove_file(sessions.join("s_busy.json")).unwrap();
    std::fs::write(sessions.join("s_idle.json"), chat("s_idle").to_string()).unwrap();
    let (status, left) = post(d.port, "workspace:remove", json!([id]), Some(TOKEN)).await;
    assert_eq!((status, left), (200, json!([])));
    let (_, saved) = post(d.port, "session:get", json!(["s_idle"]), Some(TOKEN)).await;
    assert!(saved.get("workspaceId").is_none());
    assert_eq!(saved["supportingWorkspaceIds"], json!([]));
    assert!(project.join("src").join("x.rs").exists(), "the folder itself is never touched");
    drop(d);
    std::fs::remove_dir_all(data).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn the_daemon_keeps_and_reads_connectors() {
    let data = std::env::temp_dir().join(format!("nekkod-connectors-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(&data).unwrap();
    let d = start_with(&data);
    let (_, missing) = post(d.port, "connector:fetch", json!(["teams"]), Some(TOKEN)).await;
    assert_eq!(missing["error"], "Connector not connected", "{missing}");
    let hook = json!({ "webhookUrl": "https://acme.webhook.office.com/x" });
    let (_, list) = post(d.port, "connector:connect", json!(["teams", null, hook]), Some(TOKEN)).await;
    assert_eq!(list[0]["kind"], "teams", "{list}");
    assert_eq!(list[0]["connected"], true);
    assert!(list[0]["connectedAt"].is_number());
    // The daemon wrote settings.json itself.
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(data.join("settings.json")).unwrap()).unwrap();
    assert_eq!(saved["connectors"][0]["settings"], hook);
    let (_, found) = post(d.port, "connector:fetch", json!(["teams"]), Some(TOKEN)).await;
    assert_eq!(found[0]["subtitle"], "acme.webhook.office.com", "{found}");
    let (_, list) = post(d.port, "connector:disconnect", json!(["teams"]), Some(TOKEN)).await;
    assert_eq!(list, json!([]));
    let (_, list) = post(d.port, "connectors:list", json!([]), Some(TOKEN)).await;
    assert_eq!(list, json!([]));
    drop(d);
    let _ = std::fs::remove_dir_all(&data);
}
