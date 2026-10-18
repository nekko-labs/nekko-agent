//! The real `nekkod` binary end to end: sandbox chats: admission and refusals, and (opt-in, with Docker) their container life and turns.

use crate::common::*;

/// A sandbox chat's whole container life through the daemon against a real
/// Docker engine (opt-in: `NEKKO_SANDBOX_TEST_IMAGE` names a locally
/// installed, digest-pinned Linux image with python3).
#[tokio::test(flavor = "multi_thread")]
async fn a_sandbox_chat_runs_its_tools_in_a_container_the_daemon_owns() {
    let Ok(image) = std::env::var("NEKKO_SANDBOX_TEST_IMAGE") else { return };
    let session =
        json!({ "id": "s_box", "title": "Box", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1 });
    let rig = turn_rig("sandbox", session);
    let ws = rig.workspace.to_string_lossy().to_string();
    let (status, _) = post(
        rig.d.port,
        "settings:update",
        json!([{ "workspaces": [{ "id": "w1", "name": "project", "path": ws, "addedAt": 1 }] }]),
        Some(TOKEN),
    )
    .await;
    assert_eq!(status, 200);
    let (status, configured) = post(rig.d.port, "sandbox:configure", json!(["s_box", image]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{configured}");
    assert_eq!(configured["phase"], "ready", "{configured}");
    assert_eq!(saved_session(&rig, "s_box")["executionMode"], "sandbox");
    let identity = configured["identity"].clone();
    // Always clean the container up, even when an assertion fails.
    let checks = std::panic::AssertUnwindSafe(async {
        let call = |id: &str, name: &str, input: Value| json!({ "id": id, "name": name, "input": input });
        let (_, read) = post(
            rig.d.port,
            "sandbox:tool",
            json!(["s_box", call("c1", "read_file", json!({ "path": "folder-0/app.ts" }))]),
            Some(TOKEN),
        )
        .await;
        assert!(read["output"].as_str().unwrap().contains("pineapple"), "{read}");
        let (_, wrote) = post(
            rig.d.port,
            "sandbox:tool",
            json!(["s_box", call("c2", "bash", json!({ "command": "printf hi > folder-0/new.txt; id -u" }))]),
            Some(TOKEN),
        )
        .await;
        let shell: Value = serde_json::from_str(wrote["output"].as_str().unwrap()).unwrap();
        assert_eq!(shell["stdout"].as_str().unwrap().trim(), "1000", "{wrote}");
        let (_, denied) =
            post(rig.d.port, "sandbox:tool", json!(["s_box", call("c3", "fetch_url", json!({}))]), Some(TOKEN)).await;
        assert_eq!(denied["isError"], true);
        let (_, diff) = post(rig.d.port, "sandbox:diff", json!(["s_box"]), Some(TOKEN)).await;
        assert_eq!(diff["changes"][0]["path"], "folder-0/new.txt", "{diff}");
        assert!(!rig.workspace.join("new.txt").exists(), "the host folder is untouched");
        // A Stop during a command stops the container itself, at once.
        let port = rig.d.port;
        let long = tokio::spawn(async move {
            post(
                port,
                "sandbox:tool",
                json!(["s_box", { "id": "c4", "name": "bash", "input": { "command": "sleep 30" } }]),
                Some(TOKEN),
            )
            .await
        });
        // Opt-in (Docker) only: no signal says `sleep 30` has started inside the
        // container, so give `docker exec` this long to get there. Elapsed time on purpose.
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let started = Instant::now();
        let (_, aborted) = post(rig.d.port, "sandbox:abort", json!(["s_box"]), Some(TOKEN)).await;
        assert_eq!(aborted, json!(true));
        let (_, stopped) = long.await.unwrap();
        assert_eq!(stopped["output"], "Sandbox execution cancelled", "{stopped}");
        assert!(started.elapsed() < Duration::from_secs(10));
        let (_, status) = post(rig.d.port, "sandbox:status", json!(["s_box"]), Some(TOKEN)).await;
        assert_eq!(
            status["error"], "Sandbox stopped by cancellation. Create a new sandbox chat to resume.",
            "{status}"
        );
    });
    let outcome = futures_util::FutureExt::catch_unwind(checks).await;
    let (status, _) = post(rig.d.port, "sandbox:cleanup", json!(["s_box", identity]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let (_, after) = post(rig.d.port, "sandbox:status", json!(["s_box"]), Some(TOKEN)).await;
    assert_eq!(after["phase"], "error", "{after}");
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}

/// The sandbox chat's turn is admitted and refused by the daemon itself; no
/// Docker needed for these.
#[tokio::test(flavor = "multi_thread")]
async fn the_daemon_admits_sandbox_chats_and_refuses_what_they_cannot_do() {
    let session = json!({
        "id": "s_boxed", "title": "Box", "workspaceId": "w1", "executionMode": "sandbox", "gitIsolation": false,
        "mode": "ask", "messages": [], "createdAt": 1, "updatedAt": 1
    });
    let rig = turn_rig("sandbox-admit", session);
    let model = scripted_model(vec![say_text("unused")]).await;
    std::fs::write(rig.data.join("settings.json"), scripted_settings(&rig, &model).to_string()).unwrap();
    // Not set up yet: refused with the host's words, nothing handed to the host.
    let opts = json!({ "sessionId": "s_boxed", "providerId": "p1", "modelId": "synthetic", "text": "hello" });
    let (status, _) = post(rig.d.port, "chat:send", json!([opts]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    let refused = |c: &Value| {
        c[0] == "turn:notify"
            && c[1][0]["message"] == "Sandbox requires explicit setup and supports text chat without host skills only."
    };
    let calls =
        until_host_call(rig.d.port, "the refusal to reach the host's listeners", Duration::from_secs(10), refused)
            .await;
    assert!(!calls.iter().any(|c| c[0] == "chat:send"), "the daemon kept it");
    assert!(model.requests.lock().unwrap().is_empty(), "no model call");
}

/// A sandbox chat's whole turn in the daemon against a real Docker engine
/// (opt-in: `NEKKO_SANDBOX_TEST_IMAGE` names a locally installed,
/// digest-pinned Linux image with python3): admitted here, its tools asked
/// for and run in the container the daemon owns, a host tool refused without
/// asking, the host folder untouched, and Stop during a command.
#[tokio::test(flavor = "multi_thread")]
async fn a_sandbox_chat_turn_runs_in_the_daemon_and_its_container() {
    let Ok(image) = std::env::var("NEKKO_SANDBOX_TEST_IMAGE") else { return };
    let session = json!({ "id": "s_boxturn", "title": "Box", "workspaceId": "w1", "messages": [], "createdAt": 1, "updatedAt": 1 });
    let rig = turn_rig("sandbox-turn", session);
    let model = scripted_model(vec![
        call_tool("c1", "read_file", json!({ "path": "folder-0/app.ts" })),
        call_tool("c2", "bash", json!({ "command": "printf hi > folder-0/new.txt; id -u" })),
        call_tool("c3", "fetch_url", json!({ "url": "https://example.com" })),
        say_text("done in the box"),
        call_tool("c4", "bash", json!({ "command": "sleep 30" })),
        say_text("(after stop)"),
    ])
    .await;
    std::fs::write(rig.data.join("settings.json"), scripted_settings(&rig, &model).to_string()).unwrap();
    let (status, configured) = post(rig.d.port, "sandbox:configure", json!(["s_boxturn", image]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{configured}");
    assert_eq!(configured["phase"], "ready", "{configured}");
    let identity = configured["identity"].clone();

    let checks = std::panic::AssertUnwindSafe(async {
        let port = rig.d.port;
        let opts =
            json!({ "sessionId": "s_boxturn", "providerId": "p1", "modelId": "synthetic", "text": "look in the box" });
        let send = tokio::spawn(async move { post(port, "chat:send", json!([opts]), Some(TOKEN)).await });
        // Every container call asks first (a sandbox chat is in ask mode), here in the daemon.
        for (call, reason, severity) in [
            ("c1", "Sandbox read_file: access only the copied workspace", "low"),
            ("c2", "Sandbox bash: access only the copied workspace", "high"),
        ] {
            let pending = wait_pending(port, "s_boxturn", "approval", call).await;
            assert_eq!((pending["reason"].clone(), pending["severity"].clone()), (json!(reason), json!(severity)));
            post(port, "tool:approve", json!(["s_boxturn", call, true]), Some(TOKEN)).await;
        }
        let (status, _) = send.await.unwrap();
        assert_eq!(status, 200);
        let saved = saved_session(&rig, "s_boxturn");
        let results: Vec<Value> =
            saved["messages"].as_array().unwrap().iter().filter_map(|m| m.get("toolResult").cloned()).collect();
        assert!(results[0]["output"].as_str().unwrap().contains("pineapple"), "{results:?}");
        let shell: Value = serde_json::from_str(results[1]["output"].as_str().unwrap()).unwrap();
        assert_eq!(shell["stdout"].as_str().unwrap().trim(), "1000", "{results:?}");
        assert_eq!(results[2]["isError"], true);
        assert!(results[2]["output"].as_str().unwrap().contains("No host fallback"), "{results:?}");
        assert_eq!(saved["messages"].as_array().unwrap().last().unwrap()["content"], "done in the box");
        assert!(!rig.workspace.join("new.txt").exists(), "the host folder is untouched");
        let (_, diff) = post(port, "sandbox:diff", json!(["s_boxturn"]), Some(TOKEN)).await;
        assert_eq!(diff["changes"][0]["path"], "folder-0/new.txt", "{diff}");

        // The model saw only the container's tools and folders, and no host context.
        let requests = model.requests.lock().unwrap().clone();
        let tools: Vec<String> = requests[0]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["function"]["name"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(tools, ["read_file", "write_file", "edit_file", "glob", "grep", "list_dir", "bash"]);
        let system = requests[0]["messages"][0]["content"].as_str().unwrap().to_string();
        assert!(system.contains("folder-0"), "{system}");
        assert!(!system.contains(&*rig.workspace.to_string_lossy()), "no host path: {system}");
        assert!(!system.contains("Always run the tests."), "no host guidelines: {system}");
        assert!(system.contains("isolated container on copied folders"), "{system}");

        // Stop during a command stops the container, at once.
        let opts = json!({ "sessionId": "s_boxturn", "providerId": "p1", "modelId": "synthetic", "text": "wait" });
        let send = tokio::spawn(async move { post(port, "chat:send", json!([opts]), Some(TOKEN)).await });
        wait_pending(port, "s_boxturn", "approval", "c4").await;
        post(port, "tool:approve", json!(["s_boxturn", "c4", true]), Some(TOKEN)).await;
        // As above: the command inside the container has no start signal. Elapsed time on purpose.
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let started = Instant::now();
        post(port, "chat:abort", json!(["s_boxturn"]), Some(TOKEN)).await;
        let (status, _) = send.await.unwrap();
        assert_eq!(status, 200);
        assert!(started.elapsed() < Duration::from_secs(10), "stopped in {:?}", started.elapsed());
        let (_, status) = post(port, "sandbox:status", json!(["s_boxturn"]), Some(TOKEN)).await;
        assert_eq!(
            status["error"], "Sandbox stopped by cancellation. Create a new sandbox chat to resume.",
            "{status}"
        );

        // Nothing went through the host's container route or its own turn.
        let calls = until_adopted(port, 2).await;
        assert!(!calls.iter().any(|c| c[0] == "chat:send" || c[0] == "turn:tool"), "{calls:?}");
        let adopt = calls.iter().find(|c| c[0] == "turn:adopt").expect("the host was handed the turn");
        assert_eq!(adopt[1][0]["mode"], "ask");
        assert_eq!(adopt[1][0]["workspaces"][0]["path"], "folder-0");
    });
    let outcome = futures_util::FutureExt::catch_unwind(checks).await;
    let (status, _) = post(rig.d.port, "sandbox:cleanup", json!(["s_boxturn", identity]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}
