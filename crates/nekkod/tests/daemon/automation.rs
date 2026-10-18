//! The real `nekkod` binary end to end: scheduled tasks, training and goal runs, and workflows.

use crate::common::*;

/// Settings whose provider `p1` is a scripted model (`m1`), written before the daemon starts.
fn scripted_p1(data: &std::path::Path, model: &ScriptedModel, extra: Value) -> Value {
    let mut settings = json!({
        "providers": [{ "id": "p1", "kind": "openai-compat", "label": "Scripted", "enabled": true, "baseUrl": format!("http://127.0.0.1:{}/v1", model.port) }],
        "defaultProviderId": "p1",
        "defaultModelId": "m1",
        "defaultChatMode": "yolo",
    });
    for (k, v) in extra.as_object().cloned().unwrap_or_default() {
        settings[k] = v;
    }
    std::fs::write(data.join("settings.json"), settings.to_string()).unwrap();
    settings
}

/// The assistant replies saved in a chat.
fn replies(data: &std::path::Path, id: &str) -> Vec<String> {
    let chat: Value = std::fs::read_to_string(data.join("sessions").join(format!("{id}.json")))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null);
    chat["messages"]
        .as_array()
        .map(|m| {
            m.iter()
                .filter(|m| m["role"] == "assistant")
                .filter_map(|m| m["content"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// The task list as the daemon wrote it.
fn read_tasks(data: &std::path::Path) -> Value {
    std::fs::read_to_string(data.join("tasks.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(json!([]))
}

#[tokio::test(flavor = "multi_thread")]
async fn the_daemon_runs_tasks_and_fires_them_on_time() {
    let data = std::env::temp_dir().join(format!("nekkod-tasks-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(data.join("sessions")).unwrap();
    let model = scripted_model(vec![say_text("Nightly summary.")]).await;
    scripted_p1(&data, &model, json!({}));
    let d = start_with(true, Some(&data));
    let (_, info) = post(d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    assert!(info["owned"].as_array().unwrap().contains(&json!("tasks:list")), "{info}");

    let input = json!({ "title": " Nightly ", "kind": "recurring", "prompt": "Summarize", "intervalMs": 3_600_000, "providerId": "p1", "modelId": "m1" });
    let (status, list) = post(d.port, "task:create", json!([input]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{list}");
    assert_eq!(list[0]["title"], "Nightly");
    // The daemon made the chat (with its defaults) and named it after the task.
    let made = list[0]["lastSessionId"].as_str().unwrap().to_string();
    assert!(made.starts_with("s_") && made != "s_created", "{list}");
    let (_, calls) = post(d.port, "test:completions", json!([]), Some(TOKEN)).await;
    assert!(!calls.as_array().unwrap().iter().any(|c| c[0] == "session:create"), "the host made no chat: {calls}");
    let chat: Value =
        serde_json::from_str(&std::fs::read_to_string(data.join(format!("sessions/{made}.json"))).unwrap()).unwrap();
    assert_eq!(chat["title"], "Nightly");
    assert_eq!(chat["taskId"], list[0]["id"]);
    // Due at once: fired without waiting for a tick, its turn admitted and run here.
    wait_for("the fire", || {
        read_tasks(&data)[0]["runCount"] == json!(1) && read_tasks(&data)[0]["nextRunAt"].is_number()
    })
    .await;
    let task = read_tasks(&data)[0].clone();
    wait_for("the task's reply", || replies(&data, &made) == ["Nightly summary."]).await;
    let (_, calls) = post(d.port, "test:completions", json!([]), Some(TOKEN)).await;
    assert!(!calls.as_array().unwrap().iter().any(|c| c[0] == "chat:send"), "the host ran no turn: {calls}");
    let asked = model.requests.lock().unwrap().iter().any(|r| {
        r["messages"].as_array().is_some_and(|m| m.iter().any(|m| m["role"] == "user" && m["content"] == "Summarize"))
    });
    assert!(asked, "the model was sent the task's prompt");
    let next = task["nextRunAt"].as_f64().unwrap() - task["lastRunAt"].as_f64().unwrap();
    assert!((3_600_000.0..3_601_000.0).contains(&next), "{task}");

    // Paused tasks never fire; deleting removes it.
    let id = task["id"].as_str().unwrap().to_string();
    let (_, list) = post(d.port, "task:update", json!([id, { "status": "paused" }]), Some(TOKEN)).await;
    assert_eq!(list[0]["status"], "paused");
    let (_, list) = post(d.port, "task:delete", json!([id]), Some(TOKEN)).await;
    assert_eq!(list, json!([]));
    drop(d);
    let _ = std::fs::remove_dir_all(&data);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_task_cut_short_by_a_restart_fires_again() {
    let data = std::env::temp_dir().join(format!("nekkod-tasks-restart-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(data.join("sessions")).unwrap();
    std::fs::write(data.join("sessions/s_old.json"), r#"{"id":"s_old","title":"Old","messages":[]}"#).unwrap();
    let model = scripted_model(vec![say_text("Again, done.")]).await;
    scripted_p1(&data, &model, json!({}));
    // Mid-fire when the last process stopped: active, no next run.
    std::fs::write(
        data.join("tasks.json"),
        r#"[{"id":"t1","title":"Cut short","kind":"recurring","prompt":"Again","providerId":"p1","modelId":"m1","status":"active","createdAt":5,"runCount":2,"lastRunAt":9,"lastSessionId":"s_old"}]"#,
    )
    .unwrap();
    let d = start_with(true, Some(&data));
    wait_for("the fire after restart", || read_tasks(&data)[0]["runCount"] == json!(3)).await;
    // runCount is saved before the asynchronous turn runs; its reply lands in the old chat.
    wait_for("the restarted task's reply", || replies(&data, "s_old") == ["Again, done."]).await;
    drop(d);
    let _ = std::fs::remove_dir_all(&data);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_scheduled_task_fires_when_it_is_due_not_a_tick_later() {
    let data = std::env::temp_dir().join(format!("nekkod-tasks-due-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(data.join("sessions")).unwrap();
    let d = start_with(true, Some(&data));
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as f64;
    let run_at = now + 2_000.0;
    let input = json!({ "title": "Soon", "kind": "scheduled", "prompt": "p", "runAt": run_at, "providerId": "p1", "modelId": "m1" });
    post(d.port, "task:create", json!([input]), Some(TOKEN)).await;
    wait_for("the scheduled fire", || read_tasks(&data)[0]["status"] == json!("done")).await;
    let late = read_tasks(&data)[0]["lastRunAt"].as_f64().unwrap() - run_at;
    // The TS scheduler looked every 15 s, so a task fired up to 15 s late.
    assert!((0.0..1_000.0).contains(&late), "fired {late} ms after it was due");
    eprintln!("scheduled task fired {late} ms after its runAt");
    drop(d);
    let _ = std::fs::remove_dir_all(&data);
}

/// The runs as the daemon wrote them.
fn read_runs(data: &std::path::Path) -> Value {
    std::fs::read_to_string(data.join("training.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(json!([]))
}

/// A goal run end to end in the daemon: created (its chat made by the host and
/// named here), started, its turns admitted and driven by the daemon, its plan,
/// experiment and artifact recorded by the daemon's own tools with no
/// `turn:tool`, finished on the done token, and `training:updated` published.
#[tokio::test(flavor = "multi_thread")]
async fn the_daemon_runs_training_and_goal_runs_and_their_tools_itself() {
    let rig = turn_rig("training", json!({ "id": "s_unused", "messages": [] }));
    let model = scripted_model(vec![
        call_tool(
            "c_plan",
            "update_plan",
            json!({ "replace": true, "steps": [{ "title": "Write the parser", "status": "active" }, { "title": "Add tests" }] }),
        ),
        call_tool("c_exp", "report_experiment", json!({ "title": "Fast path", "status": "succeeded", "score": 0.9 })),
        call_tool("c_art", "report_artifact", json!({ "path": "nekko-goal/csv/parser.ts", "kind": "code" })),
        say_text("Planned and started."),
        call_tool("c_done", "update_plan", json!({ "steps": [{ "id": "step_1", "status": "done", "note": "Parses" }, { "id": "step_2", "status": "done" }] })),
        say_text("Everything is verified. \u{27e6}RUN_DONE\u{27e7}"),
    ])
    .await;
    let provider = json!({
        "id": "p1", "kind": "openai-compat", "label": "Scripted", "enabled": true,
        "baseUrl": format!("http://127.0.0.1:{}/v1", model.port),
    });
    let settings = json!({
        "providers": [provider],
        "workspaces": [{ "id": "w1", "name": "project", "path": rig.workspace.to_string_lossy() }],
        "defaultChatMode": "yolo", "defaultProviderId": "p1", "defaultModelId": "synthetic",
    });
    std::fs::write(rig.data.join("settings.json"), settings.to_string()).unwrap();
    let mut events = ws(rig.d.port, &format!("/api/events?token={TOKEN}"), None).await.unwrap();

    let (_, info) = post(rig.d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    for c in ["training:list", "training:create", "training:start", "training:hint", "training:tool"] {
        assert!(info["owned"].as_array().unwrap().contains(&json!(c)), "{c} is not owned: {info}");
    }
    let input =
        json!({ "kind": "goal", "name": "  CSV importer  ", "goal": "Ship the CSV importer", "workspaceId": "w1" });
    let (status, run) = post(rig.d.port, "training:create", json!([input]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{run}");
    assert_eq!(run["name"], "CSV importer");
    assert_eq!(run["status"], "draft");
    let run_chat = run["sessionId"].as_str().unwrap().to_string();
    assert!(run_chat.starts_with("s_") && run_chat != "s_created", "the daemon made the run's chat: {run}");
    let id = run["id"].as_str().unwrap().to_string();
    let chat = saved_session(&rig, &run_chat);
    assert_eq!(chat["title"], "CSV importer");
    assert_eq!(chat["trainingRunId"], id.as_str());
    assert_eq!(chat["providerId"], "p1");

    let (_, list) = post(rig.d.port, "training:hint", json!([id, "  Keep it small  "]), Some(TOKEN)).await;
    assert_eq!(list[0]["hints"][0]["text"], "Keep it small");
    let (_, list) = post(rig.d.port, "training:start", json!([id]), Some(TOKEN)).await;
    assert_eq!(list[0]["status"], "running");
    // Two turns (the second after the 4 s pause), then finished on the token.
    wait_for("the run to complete", || read_runs(&rig.data)[0]["status"] == json!("completed")).await;
    let run = read_runs(&rig.data)[0].clone();
    assert_eq!(run["turns"], json!(2), "{run}");
    assert_eq!(run["plan"][0]["status"], "done", "{run}");
    assert_eq!(run["plan"][0]["note"], "Parses");
    assert_eq!(run["experiments"][0]["id"], "exp_1");
    assert_eq!(run["bestExperimentId"], "exp_1");
    assert_eq!(run["artifacts"][0]["title"], "parser.ts");
    assert!(run["hints"][0]["consumedAt"].is_number(), "{run}");
    let log: Vec<String> = run["log"].as_array().unwrap().iter().map(|l| l["text"].as_str().unwrap().into()).collect();
    assert!(log.contains(&"Plan created: 2 steps.".to_string()), "{log:?}");
    assert!(log.contains(&"Run completed: Everything is verified.".to_string()), "{log:?}");

    // The chat: the turns' transcript and the run's plan mirrored onto it.
    let chat = saved_session(&rig, &run_chat);
    assert_eq!(chat["agentPlan"], run["plan"]);
    let messages = chat["messages"].as_array().unwrap();
    let tool_out = |id: &str| -> String {
        let m = messages.iter().find(|m| m["role"] == "tool" && m["toolResult"]["toolCallId"] == id).unwrap();
        m["toolResult"]["output"].as_str().unwrap().to_string()
    };
    assert!(tool_out("c_plan").starts_with("Plan saved (0/2 done):"), "{}", tool_out("c_plan"));
    assert_eq!(tool_out("c_exp"), "Recorded exp_1. It is the new leader at 0.9.");
    assert_eq!(
        tool_out("c_art"),
        "Recorded artifact \"parser.ts\" at nekko-goal/csv/parser.ts. It now shows on the run's Artifacts card."
    );
    // The first turn's brief, with the hint folded in.
    let first = messages.iter().find(|m| m["role"] == "user").unwrap()["content"].as_str().unwrap().to_string();
    assert!(first.starts_with("You are Nekko Agent's goal agent."), "{first}");
    assert!(
        first.ends_with("USER GUIDANCE (fold these into your next experiments; acknowledge each):\n- Keep it small")
    );
    let (_, calls) = post(rig.d.port, "test:completions", json!([]), Some(TOKEN)).await;
    let calls = calls.as_array().unwrap();
    assert!(!calls.iter().any(|c| c[0] == "turn:tool" || c[0] == "chat:send"), "the host ran nothing: {calls:?}");
    // Its history window went with the turn.
    let requests = model.requests.lock().unwrap().clone();
    assert!(requests.len() >= 6, "{}", requests.len());

    let mut heard = false;
    while let Some(frame) = next_json(&mut events, Duration::from_secs(2)).await {
        if frame["channel"] == "training:updated" {
            heard = true;
            break;
        }
    }
    assert!(heard, "training:updated was published");

    // A turn the host runs sends its run tools here.
    let (_, out) = post(
        rig.d.port,
        "training:tool",
        json!([run_chat, "report_experiment", { "id": "exp_2", "status": "failed" }]),
        Some(TOKEN),
    )
    .await;
    assert_eq!(out["output"], "Recorded exp_2 (failed). Leader is exp_1 (Fast path) at 0.9.");
    let (_, out) =
        post(rig.d.port, "training:tool", json!([run_chat, "update_plan", { "steps": [null] }]), Some(TOKEN)).await;
    assert_eq!(out["error"], "Cannot read properties of null (reading 'title')");

    let (_, list) = post(rig.d.port, "training:stop", json!([id]), Some(TOKEN)).await;
    assert_eq!(list[0]["status"], "completed", "a completed run stays completed");
    let (_, list) = post(rig.d.port, "training:delete", json!([id]), Some(TOKEN)).await;
    assert_eq!(list, json!([]));
    assert_eq!(read_runs(&rig.data), json!([]));
}

/// A run that was mid-flight when the daemon stopped resumes when it starts.
#[tokio::test(flavor = "multi_thread")]
async fn a_running_training_run_resumes_when_the_daemon_starts() {
    let data = std::env::temp_dir().join(format!("nekkod-training-resume-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(data.join("sessions")).unwrap();
    // No model anywhere: its resumed turn fails the run at once.
    std::fs::write(data.join("sessions/s_run.json"), r#"{"id":"s_run","title":"Run","messages":[]}"#).unwrap();
    std::fs::write(
        data.join("training.json"),
        r#"[{"id":"r1","kind":"training","name":"Old","goal":"g","status":"running","config":{},"sessionId":"s_run","experiments":[],"hints":[],"log":[],"createdAt":1,"updatedAt":1,"startedAt":1,"turns":3}]"#,
    )
    .unwrap();
    let d = start_with(true, Some(&data));
    wait_for("the resumed run", || read_runs(&data)[0]["status"] == json!("failed")).await;
    let run = read_runs(&data)[0].clone();
    let log: Vec<&str> = run["log"].as_array().unwrap().iter().map(|l| l["text"].as_str().unwrap()).collect();
    assert_eq!(
        log,
        [
            "Host restarted; run resumed automatically.",
            "No model configured. Set a default provider/model in Models, then start the run again."
        ]
    );
    drop(d);
    let _ = std::fs::remove_dir_all(&data);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_daemon_runs_workflows_with_shell_prompt_and_webhook() {
    let data = std::env::temp_dir().join(format!("nekkod-workflows-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(data.join("sessions")).unwrap();
    let work = data.join("work");
    std::fs::create_dir_all(&work).unwrap();
    let model = scripted_model(vec![say_text("A short summary.")]).await;
    scripted_p1(&data, &model, json!({ "workspaces": [{ "id": "w1", "path": work }] }));
    // A run interrupted by the last shutdown is written off at startup.
    std::fs::write(
        data.join("workflow-runs.json"),
        r#"[{"id":"old","workflowId":"gone","status":"running","triggerKind":"manual","startedAt":1,"steps":[]}]"#,
    )
    .unwrap();
    let d = start_with(true, Some(&data));
    let (_, info) = post(d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    assert!(info["owned"].as_array().unwrap().contains(&json!("workflow:run")), "{info}");
    wait_for("the reconcile", || {
        std::fs::read_to_string(data.join("workflow-runs.json")).unwrap_or_default().contains("Interrupted")
    })
    .await;

    let input = json!({
        "name": "Echo Flow",
        "steps": [
            { "id": "a", "name": "Say", "kind": "shell", "run": "echo hello-{{run.workflowName}}" },
            { "id": "b", "name": "Ask", "kind": "prompt", "run": "Summarize {{steps.a.output}}" },
        ],
        "triggers": [{ "id": "t", "kind": "webhook", "webhookSecret": "sekret" }],
    });
    let (_, wf) = post(d.port, "workflow:create", json!([input]), Some(TOKEN)).await;
    assert_eq!(wf["workspaceId"], "w1", "{wf}");
    let (_, run) = post(d.port, "workflow:run", json!([wf["id"]]), Some(TOKEN)).await;
    // The shell step ran for real; the prompt step's turn ran here and answered.
    assert_eq!(run["steps"][0]["status"], "success", "{run}");
    assert!(run["steps"][0]["output"].as_str().unwrap().contains("hello-Echo Flow"), "{run}");
    assert_eq!(run["steps"][1]["status"], "success", "{run}");
    assert_eq!(run["status"], "success", "{run}");
    let asked = model.requests.lock().unwrap().iter().any(|r| {
        r["messages"].as_array().is_some_and(|m| {
            m.iter().any(|m| {
                m["role"] == "user" && m["content"].as_str().is_some_and(|c| c.contains("Summarize hello-Echo Flow"))
            })
        })
    });
    assert!(asked, "the model was sent the step's prompt");
    let (_, calls) = post(d.port, "test:completions", json!([]), Some(TOKEN)).await;
    assert!(!calls.as_array().unwrap().iter().any(|c| c[0] == "chat:send"), "the host ran no turn: {calls}");

    // Webhooks: the right secret starts a run, a wrong one is refused.
    let (status, bad) = post(d.port, "workflow:webhook", json!(["echo-flow", "nope", {}]), Some(TOKEN)).await;
    assert_ne!(status, 200, "{bad}");
    let (_, runs) =
        post(d.port, "workflow:webhook", json!(["echo-flow", "sekret", { "ref": "main" }]), Some(TOKEN)).await;
    assert_eq!(runs[0]["triggerKind"], "webhook", "{runs}");
    let (_, history) = post(d.port, "workflow:runs", json!([wf["id"]]), Some(TOKEN)).await;
    assert_eq!(history.as_array().unwrap().len(), 2);
    drop(d);
    let _ = std::fs::remove_dir_all(&data);
}
