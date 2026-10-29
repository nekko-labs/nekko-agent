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
    let d = start_with(Some(&data));
    let (status, rows) = post(d.port, "mcp:status", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    assert_eq!(
        rows,
        json!([
            { "id": "srv", "name": "Echo", "connected": true, "tools": [{ "name": "echo", "description": "Echo it" }] },
            { "id": "off", "name": "Off", "connected": false, "tools": [] },
        ])
    );
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
    let (mcp_port, mcp_server, mcp_calls) = http_mcp().await;
    let model =
        scripted_model(vec![call_tool("c_mcp", "mcp__srv__echo", json!({ "text": "hi" })), say_text("done")]).await;
    let mut spec = turn_spec(&rig, &model, "turn_m", "s_turn_m", json!({}));
    spec["settings"]["defaultChatMode"] = json!("ask");
    let facts = spec["facts"].as_object_mut().unwrap();
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
    let (_, end) = turn_record(&rig, "turn_m", "s_turn_m").await;
    assert_eq!(end["stop"], "complete", "{end}");

    // The daemon synced the server, offered its tool and ran the call.
    let tools: Vec<String> = model.requests.lock().unwrap()[0]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["function"]["name"].as_str().unwrap().to_string())
        .collect();
    assert!(tools.contains(&"mcp__srv__echo".to_string()), "{tools:?}");
    assert_eq!(mcp_calls.lock().unwrap().len(), 1);
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
async fn a_code_mode_turn_runs_the_models_script_and_asks_for_each_call_it_makes() {
    let session = json!({
        "id": "s_turn_cm", "title": "Named", "mode": "ask", "toolApproach": "code", "workspaceId": "w1",
        "messages": [], "createdAt": 1, "updatedAt": 1
    });
    let rig = turn_rig("codemode", session);
    let (mcp_port, mcp_server, mcp_calls) = http_mcp().await;
    let script = "const out = [];\nfor (const text of ['one', 'two']) out.push(await tools.mcp__srv__echo({ text }));\nreturn out.join('|');";
    let model = scripted_model(vec![
        call_tool("c_find", "search_tools", json!({ "query": "echo" })),
        call_tool("c_code", "run_code", json!({ "code": script })),
        say_text("done"),
    ])
    .await;
    let mut spec = turn_spec(&rig, &model, "turn_cm", "s_turn_cm", json!({}));
    spec["settings"]["defaultChatMode"] = json!("ask");
    let facts = spec["facts"].as_object_mut().unwrap();
    facts.remove("mcpTools");
    facts.insert(
        "mcpServers".into(),
        json!([{ "id": "srv", "name": "srv", "enabled": true, "command": "", "args": [], "url": format!("http://127.0.0.1:{mcp_port}/mcp") }]),
    );
    let (status, _) = post(rig.d.port, "chat:turn", json!([spec]), Some(TOKEN)).await;
    assert_eq!(status, 200);

    // Each call the script makes is asked about as a direct call would be.
    for nested in ["c_code.1", "c_code.2"] {
        let approval = wait_pending(rig.d.port, "s_turn_cm", "approval", nested).await;
        assert_eq!(approval["reason"], "Call mcp__srv__echo");
        let (status, _) = post(rig.d.port, "tool:approve", json!(["s_turn_cm", nested, true]), Some(TOKEN)).await;
        assert_eq!(status, 200);
    }
    let (_, end) = turn_record(&rig, "turn_cm", "s_turn_cm").await;
    assert_eq!(end["stop"], "complete", "{end}");

    // The model saw search_tools and run_code, not the tools behind them.
    let tools: Vec<String> = model.requests.lock().unwrap()[0]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["function"]["name"].as_str().unwrap().to_string())
        .collect();
    assert!(tools.contains(&"run_code".to_string()) && tools.contains(&"search_tools".to_string()), "{tools:?}");
    assert!(!tools.iter().any(|t| t == "mcp__srv__echo" || t == "read_file" || t == "bash"), "{tools:?}");
    assert!(tools.contains(&"update_plan".to_string()), "{tools:?}");
    assert_eq!(mcp_calls.lock().unwrap().len(), 2);

    let saved = saved_session(&rig, "s_turn_cm");
    let messages = saved["messages"].as_array().unwrap();
    let output = |id: &str| {
        messages.iter().find(|m| m["role"] == "tool" && m["toolResult"]["toolCallId"] == id).unwrap()["toolResult"]
            ["output"]
            .clone()
    };
    assert!(output("c_find").as_str().unwrap().contains("tools.mcp__srv__echo(input?: Record<string, any>)"));
    assert_eq!(output("c_code"), "echo: one|echo: two");
    let stats = messages.iter().rev().find(|m| m["role"] == "assistant").unwrap()["turnStats"]["codeMode"].clone();
    assert_eq!((stats["runs"].clone(), stats["toolCalls"].clone()), (json!(1), json!(2)), "{stats}");
    assert!(stats["toolsWrapped"].as_u64().unwrap() > 5, "{stats}");
    assert!(stats["schemaTokensPerCall"].as_i64().unwrap() > 0, "{stats}");
    assert!(stats["searchTokens"].as_u64().unwrap() > 0, "{stats}");
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
    let d = start_with(Some(&data));
    let (_, found) = post(d.port, "mcp:hypergate", json!([port]), Some(TOKEN)).await;
    assert_eq!(found["version"], "9.9");
    assert_eq!(found["port"], port);
    assert!(found.get("token").is_none(), "detecting mints nothing");
    let (_, connected) = post(d.port, "mcp:hypergate:connect", json!([port]), Some(TOKEN)).await;
    assert_eq!(connected["token"], "agent");
    assert_eq!(connected["agent"], "Nekko Agent");
    // Saved here, beside the user's own servers.
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
        "id": "s_turn_p", "title": "Named", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1,
        "privacy": { "mode": "redact", "allow": ["a@b.io"] },
    });
    let rig = turn_rig("spawn", session);
    let model = scripted_model(vec![
        call_tool("c_spawn", "spawn_agent", json!({ "task": "count the files" })),
        say_text("there are 2 files"),
        say_text("parent done"),
    ])
    .await;
    // The child's chat is made and its turn admitted here, from these settings.
    write_settings(&rig, scripted_settings(&rig, &model)).await;
    let mut spec = turn_spec(&rig, &model, "turn_p", "s_turn_p", json!({}));
    spec["facts"]["spawn"] = json!(true);
    let (status, _) = post(rig.d.port, "chat:turn", json!([spec]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let (_, end) = turn_record(&rig, "turn_p", "s_turn_p").await;
    assert_eq!(end["stop"], "complete", "{end}");

    // The child: made here, named after its task, inheriting the parent's provider and model.
    let child = child_of(&rig, "s_turn_p").expect("the child chat");
    assert_eq!(child["title"], "count the files");
    assert_eq!((child["providerId"].clone(), child["modelId"].clone()), (json!("p1"), json!("synthetic")));
    // A shielded chat's sub-agent is shielded too.
    assert_eq!(child["privacy"], json!({ "mode": "redact", "allow": ["a@b.io"] }));
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
    write_settings(&rig, scripted_settings(&rig, &model)).await;
    let mut spec = turn_spec(&rig, &model, "turn_ps", "s_turn_ps", json!({}));
    spec["facts"]["spawn"] = json!(true);
    post(rig.d.port, "chat:turn", json!([spec]), Some(TOKEN)).await;
    // Wait for the child to be running, then stop the parent.
    let child = until("the child to start", Duration::from_secs(30), || async {
        let child = child_of(&rig, "s_turn_ps")?;
        let id = child["id"].as_str()?.to_string();
        let (_, running) = post(rig.d.port, "chat:running", json!([]), Some(TOKEN)).await;
        running.as_array()?.iter().any(|r| r == &json!(id)).then_some(id)
    })
    .await;
    let (_, stopped) = post(rig.d.port, "turn:abort", json!(["turn_ps"]), Some(TOKEN)).await;
    assert_eq!(stopped, json!(true));
    let (_, end) = turn_record(&rig, "turn_ps", "s_turn_ps").await;
    assert_eq!(end["aborted"], true, "{end}");
    until("the child to stop with its parent", Duration::from_secs(10), || async {
        let (_, running) = post(rig.d.port, "chat:running", json!([]), Some(TOKEN)).await;
        (!running.as_array()?.iter().any(|r| r == &json!(child))).then_some(())
    })
    .await;
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
    let (_, end) = turn_record(&rig, "turn_d", "s_turn_d").await;
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
}

#[tokio::test(flavor = "multi_thread")]
async fn a_daemon_turn_runs_the_typesafe_decide_tool_through_its_decision_service() {
    // A real key would send this to the hosted Jev; the keyless answer proves the route.
    if std::env::var("TYPESAFE_API_KEY").is_ok_and(|k| !k.is_empty()) {
        return;
    }
    let session = json!({
        "id": "s_turn_dt", "title": "Named", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1
    });
    let rig = turn_rig("decide-typesafe", session);
    let model = scripted_model(vec![
        call_tool("c_ts", "decide", json!({ "state": "a refund after 40 days", "questions": [{ "id": "refund", "type": "choice", "instructions": "Grant it?", "options": ["yes", "no"] }] })),
        say_text("decided"),
    ])
    .await;
    let mut spec = turn_spec(&rig, &model, "turn_dt", "s_turn_dt", json!({}));
    spec["facts"]["decide"] = json!(true);
    spec["facts"]["decideWith"] = json!("typesafe");
    post(rig.d.port, "chat:turn", json!([spec]), Some(TOKEN)).await;
    let (_, end) = turn_record(&rig, "turn_dt", "s_turn_dt").await;
    assert_eq!(end["stop"], "complete", "{end}");
    let saved = saved_session(&rig, "s_turn_dt");
    let out = saved["messages"].as_array().unwrap().iter().find(|m| m["role"] == "tool").unwrap()["toolResult"].clone();
    assert_eq!(out["output"], "decide failed: Add a TypeSafe API key to use Jev.");
    assert_eq!(out["isError"], true);
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
    // A local address: one approval, worded as such, even in ask mode.
    let approval = wait_pending(rig.d.port, "s_turn_f", "approval", "c_fetch").await;
    assert_eq!(
        approval["reason"],
        format!(
            "Fetch {url}? 127.0.0.1 is on this computer or your local network, not the public internet. Approve only if you expected the agent to read it."
        )
    );
    assert_eq!(approval["severity"], "medium");
    post(rig.d.port, "tool:approve", json!(["s_turn_f", "c_fetch", true]), Some(TOKEN)).await;
    let approval = wait_pending(rig.d.port, "s_turn_f", "approval", "c_start").await;
    assert_eq!(approval["reason"], "Start a background process");
    post(rig.d.port, "tool:approve", json!(["s_turn_f", "c_start", true]), Some(TOKEN)).await;
    let (_, end) = turn_record(&rig, "turn_f", "s_turn_f").await;
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
    let (_, end) = turn_record(&rig, "turn_h", "s_turn_h").await;
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
}

#[tokio::test(flavor = "multi_thread")]
async fn classifies_commands_and_lists_tools_without_the_host() {
    let data = std::env::temp_dir().join(format!("nekkod-tooling-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(&data).unwrap();
    let d = start_with(Some(&data));
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
    let (_, end) = turn_record(&rig, "turn_b", "s_turn_b").await;
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
    let (_, end) = turn_record(&rig, "turn_w", "s_turn_w").await;
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
}

/// A loopback GitHub with two PRs: #42, whose combined status the test sets,
/// and #43, which it cannot read (a PR the user's token cannot see).
async fn fake_github_pr(status: std::sync::Arc<std::sync::Mutex<&'static str>>) -> u16 {
    use axum::routing::get;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let pr = json!({ "title": "Fix it", "state": "open", "draft": false, "head": { "sha": "abc", "ref": "fix" }, "base": { "ref": "main" } });
    let app = axum::Router::new().route("/repos/o/r/pulls/42", get(move || async move { axum::Json(pr) })).route(
        "/repos/o/r/commits/abc/status",
        get(move || async move { axum::Json(json!({ "state": *status.lock().unwrap(), "total_count": 1 })) }),
    );
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    port
}

/// The "Watch CI and merge when passing" button end to end: the user's
/// request (a plain chat:send) has the model register a real PR watch, a
/// failed registration leaves nothing armed, and a CI change wakes the chat
/// through a normal continuation turn with the armed prompt.
#[tokio::test(flavor = "multi_thread")]
async fn a_user_started_pr_watch_registers_and_wakes_the_chat_when_ci_changes() {
    let data = std::env::temp_dir().join(format!("nekkod-user-pr-watch-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    let workspace = data.join("project");
    std::fs::create_dir_all(data.join("sessions")).unwrap();
    std::fs::create_dir_all(&workspace).unwrap();
    for id in ["s_ok", "s_bad"] {
        let chat =
            json!({ "id": id, "title": id, "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1 });
        std::fs::write(data.join(format!("sessions/{id}.json")), chat.to_string()).unwrap();
    }
    let (ok_url, bad_url) = ("https://github.com/o/r/pull/42", "https://github.com/o/r/pull/43");
    let arm = |id: &str, url: &str| {
        call_tool(
            id,
            "agent_watch",
            json!({ "action": "create", "kind": "pr", "url": url, "prompt": "Merge it if CI passed", "timeout_seconds": 3600 }),
        )
    };
    let model = scripted_model(vec![
        arm("c_bad", bad_url),
        say_text("Could not start the watch."),
        arm("c_ok", ok_url),
        say_text("Watching."),
        say_text("CI passed; merging."),
    ])
    .await;
    let ci = std::sync::Arc::new(std::sync::Mutex::new("pending"));
    let gh = fake_github_pr(ci.clone()).await;
    let settings = json!({
        "providers": [{ "id": "p1", "kind": "openai-compat", "label": "Scripted", "enabled": true, "baseUrl": format!("http://127.0.0.1:{}/v1", model.port) }],
        "workspaces": [{ "id": "w1", "name": "project", "path": workspace.to_string_lossy() }],
        "defaultChatMode": "yolo", "defaultProviderId": "p1", "defaultModelId": "synthetic",
    });
    std::fs::write(data.join("settings.json"), settings.to_string()).unwrap();
    // No gh: the PR is read from the loopback REST API, never from github.com.
    let d = start_with_env(
        Some(&data),
        json!({ "githubApiUrl": format!("http://127.0.0.1:{gh}") }),
        &[("NEKKO_GH_PATH", Some("nekko-no-such-gh"))],
    );
    let send = |id: &str, url: &str| {
        let text = format!("Watch CI for {url} and merge when passing.");
        json!([{ "sessionId": id, "providerId": "p1", "modelId": "synthetic", "text": text }])
    };
    let views = |id: &'static str| {
        let port = d.port;
        async move { post(port, "session:watches", json!([id]), Some(TOKEN)).await.1 }
    };
    let tool_out = |id: &str, call: &str| -> String {
        let saved: Value =
            serde_json::from_str(&std::fs::read_to_string(data.join(format!("sessions/{id}.json"))).unwrap()).unwrap();
        let m = saved["messages"].as_array().unwrap().iter().find(|m| m["toolResult"]["toolCallId"] == call).cloned();
        m.unwrap()["toolResult"]["output"].as_str().unwrap().to_string()
    };

    // A PR the host cannot read: the tool says so, nothing is armed, and the
    // UI keeps offering the button (no active watch to show).
    let (status, body) = post(d.port, "chat:send", send("s_bad", bad_url), Some(TOKEN)).await;
    assert_eq!(status, 200, "{body}");
    assert!(
        tool_out("s_bad", "c_bad").starts_with("Agent watch failed: PR catalog unavailable"),
        "{}",
        tool_out("s_bad", "c_bad")
    );
    assert_eq!(views("s_bad").await, json!([]));

    // A readable PR: armed, and listed as the active watch the UI renders.
    let (status, body) = post(d.port, "chat:send", send("s_ok", ok_url), Some(TOKEN)).await;
    assert_eq!(status, 200, "{body}");
    assert!(tool_out("s_ok", "c_ok").starts_with("Watch armed: "), "{}", tool_out("s_ok", "c_ok"));
    let listed = views("s_ok").await;
    assert_eq!(
        (
            listed[0]["kind"].clone(),
            listed[0]["url"].clone(),
            listed[0]["status"].clone(),
            listed[0]["pending"].clone()
        ),
        (json!("pr"), json!(ok_url), json!("active"), json!(false)),
        "{listed}"
    );

    // CI goes green. shortcut: the first poll is a minute out, so the test
    // moves it to now instead of waiting; the 15 s scheduler tick is real.
    *ci.lock().unwrap() = "success";
    let file = data.join("agent-watches.json");
    let mut armed: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    armed[0]["nextPollAt"] = json!(0);
    std::fs::write(&file, armed.to_string()).unwrap();
    until("the watch to wake the chat", Duration::from_secs(45), || async {
        (views("s_ok").await[0]["status"] == "done").then_some(())
    })
    .await;
    let requests = model.requests.lock().unwrap().clone();
    let wake = requests.iter().rev().find_map(|r| {
        let last = r["messages"].as_array()?.iter().rev().find(|m| m["role"] == "user")?;
        last["content"].as_str().filter(|c| c.starts_with("[Agent watch ")).map(str::to_string)
    });
    let wake = wake.expect("a continuation turn reached the model");
    assert!(wake.contains(&format!("PR state changed for {ok_url}")), "{wake}");
    assert!(wake.contains("\"checks\":\"passing\""), "{wake}");
    assert!(wake.contains("Merge it if CI passed"), "{wake}");
    assert!(wake.contains("grants no new permissions"), "{wake}");
    wait_for("the continuation reply", || {
        let saved: Value =
            serde_json::from_str(&std::fs::read_to_string(data.join("sessions/s_ok.json")).unwrap()).unwrap();
        saved["messages"].as_array().unwrap().last().unwrap()["content"] == "CI passed; merging."
    })
    .await;
    drop(d);
    std::fs::remove_dir_all(data).ok();
}
