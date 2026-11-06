//! The real `nekkod` binary with no TS backend at all (`backend` absent from
//! its config): what it serves on its own once it owns the data directory.

use crate::common::*;

#[tokio::test(flavor = "multi_thread")]
async fn runs_chats_and_answers_the_busy_checks_with_no_backend() {
    let data = std::env::temp_dir().join(format!("nekkod-backendless-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    let workspace = data.join("project");
    std::fs::create_dir_all(data.join("sessions")).unwrap();
    std::fs::create_dir_all(&workspace).unwrap();
    let chat =
        json!({ "id": "s_solo", "title": "Solo", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1 });
    std::fs::write(data.join("sessions/s_solo.json"), chat.to_string()).unwrap();
    let model = scripted_model(vec![
        call_tool("c_w", "write_file", json!({ "path": "note.txt", "content": "hi" })),
        call_tool("c_b", "bash", json!({ "command": "echo hello-agent-log" })),
        say_text("wrote it"),
    ])
    .await;
    let settings = json!({
        "providers": [{ "id": "p1", "kind": "openai-compat", "label": "Scripted", "enabled": true, "baseUrl": format!("http://127.0.0.1:{}/v1", model.port) }],
        "workspaces": [{ "id": "w1", "name": "project", "path": workspace.to_string_lossy() }],
        "defaultChatMode": "yolo", "defaultProviderId": "p1", "defaultModelId": "synthetic",
        // A TurnEnd hook: run here once the turn is over, in the chat's folder.
        "hooks": [{ "id": "h1", "event": "TurnEnd", "command": "echo turn-ended> turnend.txt" }],
    });
    std::fs::write(data.join("settings.json"), settings.to_string()).unwrap();
    let d = start_with(&data);
    let mut events = ws(d.port, &format!("/api/events?token={TOKEN}"), None).await.unwrap();

    let (_, info) = post(d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    assert!(info.get("backend").is_none(), "no backend to report: {info}");
    // Served here even with nothing to forward to (chat:send runs below).
    for c in ["chat:compact", "chat:suggest"] {
        assert_served(d.port, c, json!(["s_none"])).await;
    }
    assert_served(d.port, "chat:generateImage", json!([{ "sessionId": "s_none" }])).await;
    // A channel nothing here serves is unknown, not a missing backend.
    let (status, body) = post(d.port, "no:suchChannel", json!([]), Some(TOKEN)).await;
    assert!(status >= 400, "{status}");
    assert_eq!(body["error"], "unknown channel no:suchChannel");
    // A pasted file lands under the data directory, a second one beside it.
    let paste = json!(["s_solo", "note.txt", "data:text/plain;base64,aGk="]);
    let (_, first) = post(d.port, "attachment:import", paste.clone(), Some(TOKEN)).await;
    let (_, second) = post(d.port, "attachment:import", paste, Some(TOKEN)).await;
    assert_eq!(std::fs::read_to_string(first.as_str().unwrap()).unwrap(), "hi");
    assert!(second.as_str().unwrap().ends_with("note-2.txt"), "{second}");
    assert!(std::path::Path::new(first.as_str().unwrap()).starts_with(data.join("attachments").join("s_solo")));
    // A remote image is fetched here, and never from this machine's own network.
    let (status, body) = post(d.port, "image:fetch", json!(["http://127.0.0.1/x.png"]), Some(TOKEN)).await;
    assert!(status >= 400 && body["error"].is_string(), "{status} {body}");
    // The skill shelves, from the cache only (nothing fetched without a refresh).
    let (status, shelves) = post(d.port, "skillSources:list", json!([false]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{shelves}");
    assert!(shelves.as_array().is_some_and(|s| !s.is_empty()), "{shelves}");

    // A whole turn, its tool included, admitted and run here.
    let opts = json!({ "sessionId": "s_solo", "providerId": "p1", "modelId": "synthetic", "text": "write a note" });
    let (status, body) = post(d.port, "chat:send", json!([opts]), Some(TOKEN)).await;
    assert_eq!((status, body.clone()), (200, Value::Null), "{body}");
    assert_eq!(std::fs::read_to_string(workspace.join("note.txt")).unwrap(), "hi");
    let saved: Value =
        serde_json::from_str(&std::fs::read_to_string(data.join("sessions/s_solo.json")).unwrap()).unwrap();
    assert_eq!(saved["messages"].as_array().unwrap().last().unwrap()["content"], "wrote it", "{saved}");

    // The TurnEnd hook ran (nothing waits on it).
    wait_for("the TurnEnd hook", || {
        std::fs::read_to_string(workspace.join("turnend.txt")).is_ok_and(|t| t.contains("turn-ended"))
    })
    .await;

    // The UI hears that the chat's changes moved, from this daemon.
    let mut heard = false;
    while let Some(frame) = next_json(&mut events, Duration::from_secs(5)).await {
        if frame["channel"] == "changes:updated" && frame["payload"]["sessionId"] == "s_solo" {
            heard = true;
            break;
        }
    }
    assert!(heard, "changes:updated was published");
    let (_, changes) = post(d.port, "changes:list", json!(["s_solo"]), Some(TOKEN)).await;
    assert_eq!(changes.as_array().map(Vec::len), Some(1), "{changes}");

    // The command's output is in the chat's agent terminal, and saved beside the chat.
    let (_, terminals) = post(d.port, "terminals:list", json!([]), Some(TOKEN)).await;
    let agent = terminals.as_array().unwrap().iter().find(|t| t["id"] == "agent_s_solo").cloned();
    let agent = agent.unwrap_or_else(|| panic!("agent terminal listed: {terminals}"));
    assert_eq!((agent["shell"].clone(), agent["running"].clone()), (json!("agent"), json!(false)), "{agent}");
    let (_, snap) = post(d.port, "terminal:snapshot", json!(["agent_s_solo"]), Some(TOKEN)).await;
    assert!(snap["buffer"].as_str().unwrap().contains("hello-agent-log"), "{snap}");
    let log = data.join("sessions/s_solo.commands.log");
    assert!(std::fs::read_to_string(&log).unwrap().contains("hello-agent-log"));

    // Nothing is running, and nobody else could be: every check answers at once.
    let (_, running) = post(d.port, "chat:running", json!([]), Some(TOKEN)).await;
    assert_eq!(running, json!([]));
    let (_, pending) = post(d.port, "chat:pending", json!([]), Some(TOKEN)).await;
    assert!(pending.is_object(), "{pending}");
    let (status, stopped) = post(d.port, "chat:abort", json!(["s_solo"]), Some(TOKEN)).await;
    assert_eq!((status, stopped), (200, Value::Null));
    let (status, _) = post(d.port, "tool:approve", json!(["s_solo", "nope", true]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    // Steering a chat that is not running queues the text for after the turn.
    let (status, steered) = post(d.port, "chat:steer", json!(["s_solo", "  and then tidy up  "]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{steered}");
    assert_eq!(steered["queue"], json!(["and then tidy up"]));
    // Chats are made here with the settings' defaults, and their execution
    // mode changes only while they are empty.
    let (status, made) = post(d.port, "session:create", json!(["w1"]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{made}");
    assert_eq!((made["workspaceId"].clone(), made["gitIsolation"].clone()), (json!("w1"), json!(true)));
    let fresh = made["id"].as_str().unwrap().to_string();
    let (status, unified) =
        post(d.port, "session:setOptions", json!([fresh, { "executionMode": "unified" }]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{unified}");
    assert_eq!((unified["executionMode"].clone(), unified["gitIsolation"].clone()), (json!("unified"), json!(false)));
    let (status, refused) =
        post(d.port, "session:setOptions", json!(["s_solo", { "executionMode": "unified" }]), Some(TOKEN)).await;
    assert_eq!(status, 400);
    assert!(refused.to_string().contains("empty, idle chat"), "{refused}");
    post(d.port, "session:delete", json!([fresh]), Some(TOKEN)).await;

    // A folder with no chat running in it can be removed.
    let (status, folders) = post(d.port, "workspace:remove", json!(["w1"]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{folders}");
    assert_eq!(folders, json!([]));
    // Deleting the chat deletes its command log first.
    let (status, _) = post(d.port, "session:delete", json!(["s_solo"]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    assert!(!log.exists() && !data.join("sessions/s_solo.json").exists());
    drop(d);
    let _ = std::fs::remove_dir_all(&data);
}

#[tokio::test(flavor = "multi_thread")]
async fn delegation_targets_lists_exact_chat_models_without_the_host() {
    use axum::routing::get;
    // A second provider whose server lists models (one is not a chat model).
    let catalog = axum::Router::new().route(
        "/v1/models",
        get(|| async { axum::Json(json!({ "data": [{ "id": "big-chat" }, { "id": "text-embedding-3-small" }] })) }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let other = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move { axum::serve(listener, catalog).await.unwrap() });

    let data = std::env::temp_dir().join(format!("nekkod-delegation-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    let workspace = data.join("project");
    std::fs::create_dir_all(data.join("sessions")).unwrap();
    std::fs::create_dir_all(&workspace).unwrap();
    let chat =
        json!({ "id": "s_del", "title": "Del", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1 });
    std::fs::write(data.join("sessions/s_del.json"), chat.to_string()).unwrap();
    let model = scripted_model(vec![
        call_tool("c1", "delegation_targets", json!({ "provider_id": "p2" })),
        call_tool("c2", "delegation_targets", json!({ "provider_id": " p2 " })),
        call_tool("c3", "delegation_targets", json!({ "provider_id": "nope" })),
        say_text("listed"),
    ])
    .await;
    let settings = json!({
        "providers": [
            { "id": "p1", "kind": "openai-compat", "label": "Scripted", "enabled": true, "baseUrl": format!("http://127.0.0.1:{}/v1", model.port) },
            { "id": "p2", "kind": "openai-compat", "label": "Other", "enabled": true, "baseUrl": format!("http://127.0.0.1:{other}/v1") },
        ],
        "workspaces": [{ "id": "w1", "name": "project", "path": workspace.to_string_lossy() }],
        "defaultChatMode": "yolo",
    });
    std::fs::write(data.join("settings.json"), settings.to_string()).unwrap();
    let d = start_with(&data);
    let opts =
        json!({ "sessionId": "s_del", "providerId": "p1", "modelId": "synthetic", "text": "who can I delegate to" });
    let (status, body) = post(d.port, "chat:send", json!([opts]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{body}");
    let saved: Value =
        serde_json::from_str(&std::fs::read_to_string(data.join("sessions/s_del.json")).unwrap()).unwrap();
    let outputs: Vec<Value> = saved["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["role"] == "tool")
        .filter_map(|m| m["toolResult"]["output"].as_str().and_then(|c| serde_json::from_str(c).ok()))
        .collect();
    assert_eq!(outputs.len(), 3, "{saved}");
    assert_eq!(
        outputs[0],
        json!({ "ok": true, "providerId": "p2", "models": [{ "modelId": "big-chat" }], "message": "Use an exact modelId with spawn_agent.", "fallbackUsed": false })
    );
    assert_eq!(outputs[1]["code"], "invalid_provider_id");
    assert_eq!(outputs[2]["code"], "provider_unavailable");
    drop(d);
    server.abort();
    let _ = std::fs::remove_dir_all(&data);
}

#[tokio::test(flavor = "multi_thread")]
async fn spawn_agent_refuses_what_prepare_sub_agent_refuses() {
    let data = std::env::temp_dir().join(format!("nekkod-spawn-refusals-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    let workspace = data.join("project");
    std::fs::create_dir_all(data.join("sessions")).unwrap();
    std::fs::create_dir_all(&workspace).unwrap();
    let chat =
        json!({ "id": "s_sp", "title": "Sp", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1 });
    std::fs::write(data.join("sessions/s_sp.json"), chat.to_string()).unwrap();
    let model = scripted_model(vec![
        call_tool("c1", "spawn_agent", json!({ "task": "   " })),
        call_tool("c2", "spawn_agent", json!({ "task": "x", "provider_id": "p2" })),
        call_tool("c3", "spawn_agent", json!({ "task": "x", "model_id": " m " })),
        call_tool("c4", "spawn_agent", json!({ "task": "x", "provider_id": "p1", "model_id": "nope" })),
        call_tool("c5", "spawn_agent", json!({ "task": "x", "title": 5 })),
        say_text("refused"),
    ])
    .await;
    let settings = json!({
        "providers": [{ "id": "p1", "kind": "openai-compat", "label": "Scripted", "enabled": true, "baseUrl": format!("http://127.0.0.1:{}/v1", model.port) }],
        "workspaces": [{ "id": "w1", "name": "project", "path": workspace.to_string_lossy() }],
        "defaultChatMode": "yolo",
        "orchestration": { "strategy": "swarm" },
    });
    std::fs::write(data.join("settings.json"), settings.to_string()).unwrap();
    let d = start_with(&data);
    let opts = json!({ "sessionId": "s_sp", "providerId": "p1", "modelId": "synthetic", "text": "delegate" });
    let (status, body) = post(d.port, "chat:send", json!([opts]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{body}");
    let saved: Value =
        serde_json::from_str(&std::fs::read_to_string(data.join("sessions/s_sp.json")).unwrap()).unwrap();
    let out = |id: &str| -> String {
        saved["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["role"] == "tool" && m["toolResult"]["toolCallId"] == id)
            .map(|m| m["toolResult"]["output"].as_str().unwrap_or_default().to_string())
            .unwrap_or_else(|| panic!("no result for {id}: {saved}"))
    };
    assert!(out("c1").contains("A nonblank task is required"), "{}", out("c1"));
    assert!(out("c2").contains("Changing provider requires an explicit model_id"), "{}", out("c2"));
    assert!(out("c3").contains("model_id must be a nonblank exact ID"), "{}", out("c3"));
    // The scripted model lists no models: the exact id cannot be checked, so no child.
    assert!(out("c4").contains("Could not verify the target provider model list"), "{}", out("c4"));
    assert!(out("c5").contains("Sub-agent title must be a string"), "{}", out("c5"));
    let children = std::fs::read_dir(data.join("sessions"))
        .unwrap()
        .flatten()
        .filter(|e| std::fs::read_to_string(e.path()).unwrap_or_default().contains("\"parentSessionId\""))
        .count();
    assert_eq!(children, 0, "no child chat was made");
    drop(d);
    let _ = std::fs::remove_dir_all(&data);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_chat_that_runs_out_of_context_is_compacted_and_carried_on() {
    let data = std::env::temp_dir().join(format!("nekkod-backendless-ac-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    let workspace = data.join("project");
    std::fs::create_dir_all(data.join("sessions")).unwrap();
    std::fs::create_dir_all(&workspace).unwrap();
    let chat = json!({
        "id": "s_full", "title": "Full", "workspaceId": "w1", "providerId": "p1", "modelId": "synthetic",
        "messages": [
            { "id": "m1", "role": "user", "content": "start the long task", "createdAt": 1 },
            { "id": "m2", "role": "assistant", "content": "working on it", "createdAt": 2 },
        ],
        "createdAt": 1, "updatedAt": 2,
    });
    std::fs::write(data.join("sessions/s_full.json"), chat.to_string()).unwrap();
    // The reply overflows; the compaction's summary; then the continued reply.
    let model = scripted_model(vec![
        http_error(400, "This model's maximum context length is 8192 tokens"),
        say_text("Summary: the long task is half done."),
        say_text("carried on"),
    ])
    .await;
    let settings = json!({
        "providers": [{ "id": "p1", "kind": "openai-compat", "label": "Scripted", "enabled": true, "baseUrl": format!("http://127.0.0.1:{}/v1", model.port) }],
        "workspaces": [{ "id": "w1", "name": "project", "path": workspace.to_string_lossy() }],
        "defaultChatMode": "yolo", "defaultProviderId": "p1", "defaultModelId": "synthetic",
    });
    std::fs::write(data.join("settings.json"), settings.to_string()).unwrap();
    let d = start_with(&data);

    let opts = json!({ "sessionId": "s_full", "providerId": "p1", "modelId": "synthetic", "text": "keep going" });
    post(d.port, "chat:send", json!([opts]), Some(TOKEN)).await;
    let saved = until("the chat to be compacted and carried on", Duration::from_secs(30), || async {
        let text = std::fs::read_to_string(data.join("sessions/s_full.json")).ok()?;
        let s: Value = serde_json::from_str(&text).ok()?;
        let last = s["messages"].as_array()?.last()?.clone();
        (last["role"] == "assistant" && last["content"] == "carried on").then_some(s)
    })
    .await;
    let messages = saved["messages"].as_array().unwrap();
    assert!(messages.iter().any(|m| !m["compaction"].is_null()), "{saved}");
    let nudge = &messages[messages.len() - 2];
    assert_eq!(nudge["role"], "user");
    assert!(nudge["content"].as_str().unwrap().starts_with("The conversation was compacted automatically"), "{nudge}");
    drop(d);
    let _ = std::fs::remove_dir_all(&data);
}

#[tokio::test(flavor = "multi_thread")]
async fn reviews_a_repository_change_on_the_default_model_without_tools() {
    let data = std::env::temp_dir().join(format!("nekkod-backendless-rr-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(data.join("sessions")).unwrap();
    let verdict = json!({ "verdict": "COMMENT", "reviewedHead": "abc123", "complete": true, "summary": "One nit." });
    let model =
        scripted_model(vec![say_text(&verdict.to_string()), call_tool("c1", "bash", json!({ "command": "rm -rf /" }))])
            .await;
    let settings = json!({
        "providers": [{ "id": "p1", "kind": "openai-compat", "label": "Scripted", "enabled": true, "baseUrl": format!("http://127.0.0.1:{}/v1", model.port) }],
        "defaultProviderId": "p1", "defaultModelId": "synthetic",
    });
    std::fs::write(data.join("settings.json"), settings.to_string()).unwrap();
    let d = start_with(&data);
    let input = json!({ "head": "abc123", "prompt": "focus on safety", "title": "t", "description": "d", "files": [{ "filename": "a.rs", "status": "modified", "patch": "+x" }] });
    let (status, body) = post(d.port, "repository:review", json!([input.clone()]), Some(TOKEN)).await;
    assert_eq!((status, body), (200, verdict));
    // The model saw the policy and the review data, and no tools.
    let sent = model.requests.lock().unwrap()[0].clone();
    assert!(
        sent["messages"][0]["content"].as_str().unwrap().starts_with("You are performing a read-only code review"),
        "{sent}"
    );
    assert!(sent.get("tools").is_none(), "{sent}");
    let (status, body) = post(d.port, "repository:review", json!([input]), Some(TOKEN)).await;
    assert_eq!((status >= 400, body["error"].clone()), (true, json!("Review attempted tool use")));
    drop(d);
    let _ = std::fs::remove_dir_all(&data);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cloud_only_chat_never_calls_a_model_on_this_machine() {
    let data = std::env::temp_dir().join(format!("nekkod-cloud-only-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    let workspace = data.join("project");
    std::fs::create_dir_all(data.join("sessions")).unwrap();
    std::fs::create_dir_all(&workspace).unwrap();
    let chat = json!({ "id": "s_cloud", "title": "Cloud", "workspaceId": "w1", "cloudOnly": true, "executionMode": "unified", "messages": [], "createdAt": 1, "updatedAt": 1 });
    std::fs::write(data.join("sessions/s_cloud.json"), chat.to_string()).unwrap();
    let model = scripted_model(vec![say_text("ran locally")]).await;
    let settings = json!({
        // A loopback openai-compat server is a model on this machine.
        "providers": [{ "id": "p1", "kind": "openai-compat", "label": "Local", "enabled": true, "baseUrl": format!("http://127.0.0.1:{}/v1", model.port) }],
        "workspaces": [{ "id": "w1", "name": "project", "path": workspace.to_string_lossy() }],
        "defaultChatMode": "yolo",
    });
    std::fs::write(data.join("settings.json"), settings.to_string()).unwrap();
    let d = start_with(&data);
    let mut events = ws(d.port, &format!("/api/events?token={TOKEN}"), None).await.unwrap();
    let opts = json!({ "sessionId": "s_cloud", "providerId": "p1", "modelId": "synthetic", "text": "hello" });
    let (status, body) = post(d.port, "chat:send", json!([opts]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{body}");
    let mut refused = None;
    while let Some(frame) = next_json(&mut events, Duration::from_secs(5)).await {
        let ev = if frame["payload"].is_object() { &frame["payload"] } else { &frame };
        if ev["type"] == "error" && ev["sessionId"] == "s_cloud" {
            refused = ev["message"].as_str().map(str::to_string);
            break;
        }
    }
    assert_eq!(
        refused.as_deref(),
        Some("This chat runs on cloud models only. Pick a cloud model, or turn Cloud only off in the Mode panel.")
    );
    assert!(model.requests.lock().unwrap().is_empty(), "the local model was called");
    drop(d);
    model.server.abort();
    let _ = std::fs::remove_dir_all(&data);
}
