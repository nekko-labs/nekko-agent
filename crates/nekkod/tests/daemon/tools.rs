//! The real `nekkod` binary end to end: tools a daemon turn runs itself: MCP, sub-agents, decide, fetch and processes, hooks, the browser bridge and watches.

use crate::common::*;

/// A streamable-HTTP MCP server with one tool, `echo`, on a loopback port.
#[tokio::test(flavor = "multi_thread")]
async fn reports_mcp_status_from_its_own_servers() {
    let (mcp_port, mcp_server, _) = http_mcp().await;
    let data = std::env::temp_dir().join(format!("nekkod-mcp-status-{}", std::process::id()));
    std::fs::create_dir_all(&data).unwrap();
    let settings = json!({ "mcpServers": [
        { "id": "srv", "name": "Echo", "enabled": true, "command": "", "args": [], "url": format!("http://127.0.0.1:{mcp_port}/mcp") },
        { "id": "off", "name": "Off", "enabled": false, "command": "nope", "args": [] },
    ] });
    std::fs::write(data.join("settings.json"), settings.to_string()).unwrap();
    let d = start_with(true, Some(&data));
    let (_, info) = post(d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    assert!(info["owned"].as_array().unwrap().contains(&json!("mcp:status")), "{info}");
    let (status, rows) = post(d.port, "mcp:status", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    assert_eq!(
        rows,
        json!([
            { "id": "srv", "name": "Echo", "connected": true, "tools": [{ "name": "echo", "description": "Echo it" }] },
            { "id": "off", "name": "Off", "connected": false, "tools": [] },
        ])
    );
    // Answered here: the backend never heard of it.
    let (_, all) = post(d.port, "test:completions", json!([]), Some(TOKEN)).await;
    assert!(!all.as_array().unwrap().iter().any(|e| e[0] == "mcp:status"), "{all}");
    mcp_server.abort();
    drop(d);
    std::fs::remove_dir_all(data).ok();
}

async fn http_mcp() -> (u16, tokio::task::JoinHandle<()>, std::sync::Arc<std::sync::Mutex<Vec<Value>>>) {
    use axum::routing::post as route_post;
    let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let seen = calls.clone();
    let app = axum::Router::new().route(
        "/mcp",
        route_post(move |axum::Json(msg): axum::Json<Value>| {
            let seen = seen.clone();
            async move {
                let Some(id) = msg.get("id").cloned() else {
                    return (axum::http::StatusCode::ACCEPTED, axum::Json(Value::Null));
                };
                let result = match msg["method"].as_str().unwrap_or_default() {
                    "initialize" => json!({ "protocolVersion": "2024-11-05" }),
                    "tools/list" => {
                        json!({ "tools": [{ "name": "echo", "description": "Echo it", "inputSchema": { "type": "object" } }] })
                    }
                    _ => {
                        seen.lock().unwrap().push(msg.clone());
                        let text = msg["params"]["arguments"]["text"].as_str().unwrap_or("").to_string();
                        json!({ "content": [{ "type": "text", "text": format!("echo: {text}") }] })
                    }
                };
                (axum::http::StatusCode::OK, axum::Json(json!({ "jsonrpc": "2.0", "id": id, "result": result })))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    (port, tokio::spawn(async move { axum::serve(listener, app).await.unwrap() }), calls)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_daemon_turn_syncs_and_calls_its_mcp_servers_itself() {
    let session = json!({
        "id": "s_turn_m", "title": "Named", "mode": "ask", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1
    });
    let rig = turn_rig("mcp", session);
    let (_, info) = post(rig.d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    assert!(info["owned"].as_array().unwrap().iter().any(|o| o == "turn:mcp"), "{info}");
    let (mcp_port, mcp_server, mcp_calls) = http_mcp().await;
    let model =
        scripted_model(vec![call_tool("c_mcp", "mcp__srv__echo", json!({ "text": "hi" })), say_text("done")]).await;
    let mut spec = turn_spec(&rig, &model, "turn_m", "s_turn_m", json!({}));
    spec["settings"]["defaultChatMode"] = json!("ask");
    let facts = spec["facts"].as_object_mut().unwrap();
    facts.remove("mcpTools");
    facts.insert(
        "mcpServers".into(),
        json!([{ "id": "srv", "name": "srv", "enabled": true, "command": "", "args": [], "url": format!("http://127.0.0.1:{mcp_port}/mcp") }]),
    );
    let (status, _) = post(rig.d.port, "chat:turn", json!([spec]), Some(TOKEN)).await;
    assert_eq!(status, 200);

    // Ask mode: the MCP call's approval is parked in the daemon and answered there.
    let approval = wait_pending(rig.d.port, "s_turn_m", "approval", "c_mcp").await;
    assert_eq!(approval["reason"], "Call mcp__srv__echo");
    assert_eq!(approval["severity"], "medium");
    let (status, body) = post(rig.d.port, "tool:approve", json!(["s_turn_m", "c_mcp", true]), Some(TOKEN)).await;
    assert_eq!((status, body), (200, Value::Null));
    let (_, end) = turn_record(rig.d.port, "turn_m").await;
    assert_eq!(end["stop"], "complete", "{end}");

    // The daemon synced the server, offered its tool and ran the call; the host never saw it.
    let tools: Vec<String> = model.requests.lock().unwrap()[0]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["function"]["name"].as_str().unwrap().to_string())
        .collect();
    assert!(tools.contains(&"mcp__srv__echo".to_string()), "{tools:?}");
    assert_eq!(mcp_calls.lock().unwrap().len(), 1);
    let (_, all) = post(rig.d.port, "test:completions", json!([]), Some(TOKEN)).await;
    assert!(!all.as_array().unwrap().iter().any(|e| e[0] == "turn:tool"), "no host round trip for MCP");
    let saved = saved_session(&rig, "s_turn_m");
    let result = saved["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["role"] == "tool" && m["toolResult"]["toolCallId"] == "c_mcp")
        .unwrap()
        .clone();
    assert_eq!(result["toolResult"]["output"], "echo: hi");
    mcp_server.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn hypergate_is_found_and_connected_by_the_daemon() {
    use axum::routing::{get, post as route_post};
    let gate = axum::Router::new()
        .route(
            "/health",
            get(|| async { axum::Json(json!({ "service": "hypergated", "version": "9.9", "servers": 2 })) }),
        )
        .route("/api/gateway", get(|| async { axum::Json(json!({ "url": "http://127.0.0.1:1/mcp", "token": "gw" })) }))
        .route(
            "/api/clients/resolve",
            route_post(|| async { axum::Json(json!({ "token": "agent", "name": "Nekko Agent" })) }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move { axum::serve(listener, gate).await.unwrap() });
    let data = std::env::temp_dir().join(format!("nekkod-hypergate-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(&data).unwrap();
    let mine = json!({ "id": "fs", "name": "Files", "command": "npx", "args": [], "enabled": false });
    std::fs::write(data.join("settings.json"), json!({ "mcpServers": [mine] }).to_string()).unwrap();
    let d = start_with(true, Some(&data));
    let (_, found) = post(d.port, "mcp:hypergate", json!([port]), Some(TOKEN)).await;
    assert_eq!(found["version"], "9.9");
    assert_eq!(found["port"], port);
    assert!(found.get("token").is_none(), "detecting mints nothing");
    let (_, connected) = post(d.port, "mcp:hypergate:connect", json!([port]), Some(TOKEN)).await;
    assert_eq!(connected["token"], "agent");
    assert_eq!(connected["agent"], "Nekko Agent");
    // Saved here, beside the user's own servers, and nothing asked of the host.
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(data.join("settings.json")).unwrap()).unwrap();
    let servers = saved["mcpServers"].as_array().unwrap();
    assert_eq!(servers[0], mine);
    assert_eq!(
        (
            servers[1]["id"].clone(),
            servers[1]["name"].clone(),
            servers[1]["token"].clone(),
            servers[1]["enabled"].clone()
        ),
        (json!("hypergate"), json!("Hypergate"), json!("agent"), json!(true))
    );
    let (_, all) = post(d.port, "test:completions", json!([]), Some(TOKEN)).await;
    assert!(!all.as_array().unwrap().iter().any(|e| e[0] == "mcp:hypergate:save"), "{all}");
    // Nothing listening: null, not an error.
    server.abort();
    let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let (status, none) = post(d.port, "mcp:hypergate", json!([free]), Some(TOKEN)).await;
    assert_eq!((status, none), (200, Value::Null));
    drop(d);
    let _ = std::fs::remove_dir_all(&data);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_daemon_turn_drives_its_sub_agent_and_answers_with_it() {
    let session = json!({
        "id": "s_turn_p", "title": "Named", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1
    });
    let rig = turn_rig("spawn", session);
    let (_, info) = post(rig.d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    assert!(info["owned"].as_array().unwrap().iter().any(|o| o == "turn:spawn"), "{info}");
    let model = scripted_model(vec![
        call_tool("c_spawn", "spawn_agent", json!({ "task": "count the files" })),
        say_text("there are 2 files"),
        say_text("parent done"),
    ])
    .await;
    let spec = turn_spec(&rig, &model, "turn_p", "s_turn_p", json!({}));
    // The child's turn is admitted by the host from this template.
    let (status, _) = post(rig.d.port, "test:prepareTemplate", json!([spec.clone()]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let mut spec = spec;
    spec["facts"]["spawn"] = json!(true);
    let (status, _) = post(rig.d.port, "chat:turn", json!([spec]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let (_, end) = turn_record(rig.d.port, "turn_p").await;
    assert_eq!(end["stop"], "complete", "{end}");

    let (_, all) = post(rig.d.port, "test:completions", json!([]), Some(TOKEN)).await;
    let all = all.as_array().unwrap().clone();
    let prepare = all.iter().find(|e| e[0] == "spawn:prepare").expect("the host was asked to make the child");
    assert_eq!(prepare[1][0], "turn_p");
    assert_eq!(prepare[1][2], 0, "first attempt");
    assert!(!all.iter().any(|e| e[0] == "turn:tool"), "spawn_agent never ran in the host");
    assert!(all.iter().any(|e| e[0] == "turn:end" && e[1][0] == "turn_child"), "the child ran as its own daemon turn");

    let child = saved_session(&rig, "s_child");
    assert_eq!(child["messages"][0]["content"], "count the files");
    assert_eq!(child["messages"].as_array().unwrap().last().unwrap()["content"], "there are 2 files");
    let parent = saved_session(&rig, "s_turn_p");
    let result = parent["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["role"] == "tool" && m["toolResult"]["toolCallId"] == "c_spawn")
        .unwrap()
        .clone();
    assert_eq!(result["toolResult"]["output"], "there are 2 files");
    assert_eq!(parent["messages"].as_array().unwrap().last().unwrap()["content"], "parent done");
}

#[tokio::test(flavor = "multi_thread")]
async fn stopping_the_parent_stops_its_sub_agent() {
    let session = json!({
        "id": "s_turn_ps", "title": "Named", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1
    });
    let rig = turn_rig("spawn-stop", session);
    let model =
        scripted_model(vec![call_tool("c_spawn", "spawn_agent", json!({ "task": "wait forever" })), HANG.to_string()])
            .await;
    let spec = turn_spec(&rig, &model, "turn_ps", "s_turn_ps", json!({}));
    post(rig.d.port, "test:prepareTemplate", json!([spec.clone()]), Some(TOKEN)).await;
    let mut spec = spec;
    spec["facts"]["spawn"] = json!(true);
    post(rig.d.port, "chat:turn", json!([spec]), Some(TOKEN)).await;
    // Wait for the child to be running, then stop the parent.
    until("the child to start", Duration::from_secs(30), || async {
        let (_, alive) = post(rig.d.port, "turn:alive", json!(["turn_child"]), Some(TOKEN)).await;
        (alive == json!(true)).then_some(())
    })
    .await;
    let (_, stopped) = post(rig.d.port, "turn:abort", json!(["turn_ps"]), Some(TOKEN)).await;
    assert_eq!(stopped, json!(true));
    let (_, end) = turn_record(rig.d.port, "turn_ps").await;
    assert_eq!(end["aborted"], true, "{end}");
    let (_, child_alive) = post(rig.d.port, "turn:alive", json!(["turn_child"]), Some(TOKEN)).await;
    assert_eq!(child_alive, json!(false), "the child stopped with its parent");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_daemon_turn_runs_the_local_decide_tool_itself() {
    let session = json!({
        "id": "s_turn_d", "title": "Named", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1
    });
    let rig = turn_rig("decide", session);
    let model = scripted_model(vec![
        call_tool("c_empty", "decide", json!({ "state": "  ", "questions": [{ "id": "q", "type": "noul", "instructions": "x" }] })),
        call_tool("c_run", "decide", json!({ "state": "a refund after 40 days", "questions": [{ "id": "refund", "type": "choice", "instructions": "Grant it?", "options": ["yes", "no"] }] })),
        say_text("decided"),
    ])
    .await;
    let mut spec = turn_spec(&rig, &model, "turn_d", "s_turn_d", json!({}));
    spec["facts"]["decide"] = json!(true);
    spec["facts"]["decideWith"] = json!("local");
    let (status, _) = post(rig.d.port, "chat:turn", json!([spec]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let (_, end) = turn_record(rig.d.port, "turn_d").await;
    assert_eq!(end["stop"], "complete", "{end}");
    let saved = saved_session(&rig, "s_turn_d");
    let out = |id: &str| -> Value {
        saved["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["role"] == "tool" && m["toolResult"]["toolCallId"] == id)
            .unwrap()["toolResult"]
            .clone()
    };
    assert_eq!(out("c_empty")["output"], "decide failed: The state is empty.");
    // No model is loaded in this daemon: the daemon's own answer, not the host's.
    assert_eq!(out("c_run")["output"], "decide failed: No decision model is loaded. Load one with decide:load.");
    assert_eq!(out("c_run")["isError"], true);
    let (_, all) = post(rig.d.port, "test:completions", json!([]), Some(TOKEN)).await;
    assert!(!all.as_array().unwrap().iter().any(|e| e[0] == "turn:tool"), "decide never ran in the host");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_daemon_turn_fetches_pages_and_runs_background_processes_itself() {
    use axum::routing::get;
    let app = axum::Router::new().route(
        "/page",
        get(|| async {
            (
                [(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")],
                "<html><head><title>Cats</title></head><body><p>Cats sleep &amp; purr.</p></body></html>",
            )
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let page_port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let session = json!({
        "id": "s_turn_f", "title": "Named", "mode": "ask", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1
    });
    let rig = turn_rig("fetch", session);
    let url = format!("http://127.0.0.1:{page_port}/page");
    let echo = if cfg!(windows) { "echo from-the-daemon" } else { "printf 'from-the-daemon\n'" };
    let model = scripted_model(vec![
        call_tool("c_fetch", "fetch_url", json!({ "url": url })),
        call_tool("c_start", "start_process", json!({ "command": echo, "name": "echoer" })),
        say_text("started"),
    ])
    .await;
    let spec = turn_spec(&rig, &model, "turn_f", "s_turn_f", json!({}));
    let (status, _) = post(rig.d.port, "chat:turn", json!([spec]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let approval = wait_pending(rig.d.port, "s_turn_f", "approval", "c_fetch").await;
    assert_eq!(approval["reason"], format!("Fetch {url}"));
    post(rig.d.port, "tool:approve", json!(["s_turn_f", "c_fetch", true]), Some(TOKEN)).await;
    let approval = wait_pending(rig.d.port, "s_turn_f", "approval", "c_start").await;
    assert_eq!(approval["reason"], "Start a background process");
    post(rig.d.port, "tool:approve", json!(["s_turn_f", "c_start", true]), Some(TOKEN)).await;
    let (_, end) = turn_record(rig.d.port, "turn_f").await;
    assert_eq!(end["stop"], "complete", "{end}");

    let saved = saved_session(&rig, "s_turn_f");
    let messages = saved["messages"].as_array().unwrap();
    let tool_out = |id: &str| -> String {
        let m = messages.iter().find(|m| m["role"] == "tool" && m["toolResult"]["toolCallId"] == id).unwrap();
        m["toolResult"]["output"].as_str().unwrap().to_string()
    };
    assert_eq!(tool_out("c_fetch"), format!("{url} (HTTP 200, text/html, 26 chars)\n\n# Cats\n\nCats sleep & purr."));
    let started = tool_out("c_start");
    assert!(started.starts_with("Started p_"), "{started}");
    assert!(started.contains("(echoer)"), "{started}");
    let (_, all) = post(rig.d.port, "test:completions", json!([]), Some(TOKEN)).await;
    let calls = all.as_array().unwrap();
    assert!(!calls.iter().any(|e| e[0] == "turn:tool"), "neither tool went through the host: {all}");
    // The output reached the chat's agent terminal, kept here.
    assert!(!calls.iter().any(|e| e[0] == "loop:log"), "nothing logged through the host: {all}");
    until_agent_log(rig.d.port, "s_turn_f", "[echoer, background]", Duration::from_secs(10)).await;
    server.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_daemon_turn_runs_its_tool_hooks_itself() {
    let session = json!({
        "id": "s_turn_h", "title": "Named", "mode": "yolo", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1
    });
    let rig = turn_rig("hooks", session);
    let model = scripted_model(vec![
        call_tool("c_bash", "bash", json!({ "command": "echo should-not-run > ran.txt" })),
        call_tool("c_read", "read_file", json!({ "path": "app.ts" })),
        say_text("done"),
    ])
    .await;
    let (pre_cmd, post_cmd) = if cfg!(windows) {
        ("echo no shell today 1>&2 & exit /b 2", "echo saw %NEKKO_TOOL_NAME% in %CD%")
    } else {
        ("echo no shell today 1>&2; exit 2", "echo saw $NEKKO_TOOL_NAME in $(pwd)")
    };
    let rules = json!([
        { "id": "h1", "event": "PreToolUse", "name": "guard", "matcher": "bash", "command": pre_cmd },
        { "id": "h2", "event": "PostToolUse", "name": "note", "matcher": "read_file", "command": post_cmd },
    ]);
    // The daemon writes settings.json and re-reads the hooks from it per call;
    // the spec's copy is only for a daemon without a data directory.
    let (status, _) = post(rig.d.port, "settings:update", json!([{ "hooks": rules }]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let mut spec = turn_spec(&rig, &model, "turn_h", "s_turn_h", json!({}));
    spec["facts"]["hookRules"] = json!([]);
    let (status, _) = post(rig.d.port, "chat:turn", json!([spec]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let (_, end) = turn_record(rig.d.port, "turn_h").await;
    assert_eq!(end["stop"], "complete", "{end}");
    let saved = saved_session(&rig, "s_turn_h");
    let messages = saved["messages"].as_array().unwrap();
    let tool = |id: &str| -> Value {
        messages.iter().find(|m| m["role"] == "tool" && m["toolResult"]["toolCallId"] == id).unwrap()["toolResult"]
            .clone()
    };
    assert_eq!(tool("c_bash")["output"], "Blocked by hook guard: no shell today");
    assert_eq!(tool("c_bash")["isError"], true);
    assert!(!rig.workspace.join("ran.txt").exists(), "the blocked command never ran");
    let read = tool("c_read")["output"].as_str().unwrap().to_string();
    assert!(read.contains("pineapple"), "{read}");
    assert!(read.contains("\n\n[hook note]: saw read_file in "), "{read}");
    let (_, all) = post(rig.d.port, "test:completions", json!([]), Some(TOKEN)).await;
    let calls = all.as_array().unwrap();
    assert!(!calls.iter().any(|e| e[0] == "turn:hook" || e[0] == "turn:tool"), "the host ran nothing: {all}");
}

#[tokio::test(flavor = "multi_thread")]
async fn classifies_commands_and_lists_tools_without_the_host() {
    let data = std::env::temp_dir().join(format!("nekkod-tooling-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(&data).unwrap();
    let d = start_with(false, Some(&data));
    let (status, decision) = post(d.port, "guardrails:classify", json!(["rm -rf /"]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{decision}");
    assert_eq!(decision["action"], "ask", "{decision}");
    assert_eq!(decision["matches"][0]["ruleId"], "rm-rf", "{decision}");
    let (_, safe) = post(d.port, "guardrails:classify", json!(["ls"]), Some(TOKEN)).await;
    assert_eq!(safe["action"], "allow", "{safe}");
    let (_, tools) = post(d.port, "tools:list", json!([]), Some(TOKEN)).await;
    let names: Vec<&str> = tools.as_array().unwrap().iter().filter_map(|t| t["name"].as_str()).collect();
    assert!(names.contains(&"read_file") && names.contains(&"bash"), "{names:?}");
    assert!(tools[0]["description"].as_str().is_some_and(|d| !d.is_empty()));
    drop(d);
    let _ = std::fs::remove_dir_all(&data);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_daemon_turn_drives_the_in_app_browser_and_capture_through_the_bridge() {
    use axum::routing::post as route_post;
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let s2 = seen.clone();
    let app = axum::Router::new().route(
        "/bridge",
        route_post(move |headers: axum::http::HeaderMap, axum::Json(body): axum::Json<Value>| {
            let s2 = s2.clone();
            async move {
                let authorized =
                    headers.get("authorization").and_then(|v| v.to_str().ok()) == Some("Bearer bridge-token");
                s2.lock().unwrap().push(json!({ "authorized": authorized, "body": body }));
                let reply = if body["tool"] == "capture" {
                    json!({ "windows": [{ "window_id": "window:1", "title": "Editor" }] })
                } else {
                    json!({ "output": "Example page" })
                };
                axum::Json(reply)
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let bridge_port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let session = json!({
        "id": "s_turn_b", "title": "Named", "mode": "yolo", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1
    });
    let bridge = json!({ "browserBridge": { "url": format!("http://127.0.0.1:{bridge_port}/bridge"), "token": "bridge-token" } });
    let rig = turn_rig_with("browser", session, bridge);
    let model = scripted_model(vec![
        call_tool(
            "c_nav",
            "browser",
            json!({ "mode": "dedicated", "action": "navigate", "url": "https://example.com" }),
        ),
        call_tool("c_list", "capture", json!({ "action": "list" })),
        say_text("looked"),
    ])
    .await;
    let mut spec = turn_spec(&rig, &model, "turn_b", "s_turn_b", json!({}));
    spec["allowBrowserControl"] = json!(true);
    let (status, _) = post(rig.d.port, "chat:turn", json!([spec]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let (_, end) = turn_record(rig.d.port, "turn_b").await;
    assert_eq!(end["stop"], "complete", "{end}");
    let saved = saved_session(&rig, "s_turn_b");
    let messages = saved["messages"].as_array().unwrap();
    let tool_out = |id: &str| -> String {
        let m = messages.iter().find(|m| m["role"] == "tool" && m["toolResult"]["toolCallId"] == id).unwrap();
        m["toolResult"]["output"].as_str().unwrap().to_string()
    };
    assert_eq!(tool_out("c_nav"), "Example page");
    assert!(tool_out("c_list").contains("\"window_id\": \"window:1\""), "{}", tool_out("c_list"));
    let seen = seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 2, "{seen:?}");
    assert!(seen.iter().all(|r| r["authorized"] == true));
    assert_eq!(seen[0]["body"]["sessionId"], "s_turn_b");
    assert_eq!(seen[1]["body"], json!({ "tool": "capture", "sessionId": "s_turn_b", "action": "list" }));
    let (_, all) = post(rig.d.port, "test:completions", json!([]), Some(TOKEN)).await;
    assert!(!all.as_array().unwrap().iter().any(|e| e[0] == "turn:tool"), "the host ran nothing: {all}");
    server.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_daemon_turn_arms_agent_watches_itself_and_owns_their_file() {
    let session = json!({
        "id": "s_turn_w", "title": "Named", "mode": "yolo", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1
    });
    let rig = turn_rig("watch", session);
    let model = scripted_model(vec![
        call_tool(
            "c_arm",
            "agent_watch",
            json!({ "action": "create", "kind": "timer", "prompt": "Check the build", "delay_seconds": 120 }),
        ),
        call_tool("c_bad", "agent_watch", json!({ "action": "create", "kind": "pr", "prompt": "x", "url": "nope" })),
        say_text("armed"),
    ])
    .await;
    let spec = turn_spec(&rig, &model, "turn_w", "s_turn_w", json!({}));
    let (status, _) = post(rig.d.port, "chat:turn", json!([spec]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let (_, end) = turn_record(rig.d.port, "turn_w").await;
    assert_eq!(end["stop"], "complete", "{end}");
    let saved = saved_session(&rig, "s_turn_w");
    let messages = saved["messages"].as_array().unwrap();
    let tool_out = |id: &str| -> String {
        let m = messages.iter().find(|m| m["role"] == "tool" && m["toolResult"]["toolCallId"] == id).unwrap();
        m["toolResult"]["output"].as_str().unwrap().to_string()
    };
    assert!(tool_out("c_arm").starts_with("Watch armed: "), "{}", tool_out("c_arm"));
    assert_eq!(tool_out("c_bad"), "Agent watch failed: A valid GitHub PR URL is required");
    let file: Value =
        serde_json::from_str(&std::fs::read_to_string(rig.data.join("agent-watches.json")).unwrap()).unwrap();
    assert_eq!(file[0]["prompt"], "Check the build");
    assert_eq!(file[0]["status"], "active");
    let (_, wake) = post(rig.d.port, "session:nextWatch", json!(["s_turn_w"]), Some(TOKEN)).await;
    assert_eq!(wake, file[0]["deadlineAt"]);
    let (_, listed) = post(rig.d.port, "watch:tool", json!(["s_turn_w", { "action": "list" }]), Some(TOKEN)).await;
    assert!(listed.as_str().unwrap().contains("\"Check the build\""), "{listed}");
    let (_, info) = post(rig.d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    assert!(info["owned"].as_array().unwrap().contains(&json!("session:nextWatch")));
    let (_, all) = post(rig.d.port, "test:completions", json!([]), Some(TOKEN)).await;
    assert!(!all.as_array().unwrap().iter().any(|e| e[0] == "turn:tool"), "the host ran nothing: {all}");
}
