use super::*;

fn coordinator() -> Value {
    json!({ "id": "s_lead", "orchestrate": true, "messages": [] })
}

fn child(id: &str, parent: &str, updated: u64) -> Value {
    json!({ "id": id, "parentSessionId": parent, "spawnCallId": format!("call_{id}"), "updatedAt": updated, "messages": [] })
}

#[test]
fn coordinator_reads_only_allowlisted_data_from_its_own_plan_and_direct_spawn_records() {
    let dir = tempfile::tempdir().unwrap();
    let store = SessionStore::new(dir.path());
    let mut lead = coordinator();
    lead["agentPlan"] = json!([
        { "title": "Prior work", "status": "done" },
        { "title": "Compare the result", "status": "active", "note": "private note", "verification": { "detail": "private detail" } },
        { "title": "Bad status", "status": "nonstandard" }
    ]);
    let mut failed = child("s_failed", "s_lead", 3);
    failed["providerId"] = json!("secret provider");
    failed["modelId"] = json!("secret model");
    failed["title"] = json!("secret child title");
    failed["turnFailure"] = json!({ "message": "secret endpoint" });
    failed["messages"] = json!([{ "role": "assistant", "content": "secret transcript" }]);
    let mut running = child("s_running", "s_lead", 2);
    running["activeRun"] = json!({ "startedAt": 2 });
    let mut idle = child("s_idle", "s_lead", 1);
    idle["messages"] = json!([{ "role": "assistant", "content": "Looks complete, but it is legacy." }]);
    idle["spawnOutcome"] = outcome_record("s_lead", "wrong_call", SpawnOutcome::Returned);
    let mut ordinary = child("s_ordinary", "s_lead", 7);
    ordinary.as_object_mut().unwrap().remove("spawnCallId");
    let mut harness = child("s_harness", "s_lead", 6);
    harness["claudeCodeSubagent"] = json!(true);
    for record in [
        lead,
        failed,
        running,
        idle,
        ordinary,
        harness,
        child("s_nested", "s_running", 5),
        child("s_elsewhere", "s_other", 4),
    ] {
        store.put_synced(&record).unwrap();
    }
    let snapshot = || coordinator_snapshot(&store, "s_lead", &json!({})).unwrap();
    let mut expected = json!({
        "steps": [{ "title": "Compare the result", "status": "active" }, { "title": "Prior work", "status": "done" }],
        "children": [
            { "sessionId": "s_failed", "spawnCallId": "call_s_failed", "status": "unknown" },
            { "sessionId": "s_running", "spawnCallId": "call_s_running", "status": "running" },
            { "sessionId": "s_idle", "spawnCallId": "call_s_idle", "status": "unknown" }
        ]
    });
    assert_eq!(snapshot(), expected);
    store.assign("s_running", &[("activeRun", Value::Null)]).unwrap();
    // A subsequent snapshot reflects the saved checkpoint, including child recency.
    expected["children"].as_array_mut().unwrap().swap(0, 1);
    expected["children"][0]["status"] = json!("unknown");
    assert_eq!(snapshot(), expected);
}

#[test]
fn spawn_terminal_status_is_scoped_and_survives_an_unrelated_child_turn() {
    let dir = tempfile::tempdir().unwrap();
    let store = SessionStore::new(dir.path());
    store.put_synced(&coordinator()).unwrap();
    let mut worker = child("s_worker", "s_lead", 1);
    store.put_synced(&worker).unwrap();
    let snapshot = || coordinator_snapshot(&store, "s_lead", &json!({})).unwrap()["children"][0]["status"].clone();
    for (parent, call) in [("s_other", "call_s_worker"), ("s_lead", "wrong_call")] {
        record_spawn_outcome(&store, "s_worker", parent, call, SpawnOutcome::Returned).unwrap();
        assert_eq!(snapshot(), "unknown");
    }
    for outcome in [
        SpawnOutcome::Returned,
        SpawnOutcome::Partial,
        SpawnOutcome::Failed,
        SpawnOutcome::Interrupted,
        SpawnOutcome::Unknown,
    ] {
        record_spawn_outcome(&store, "s_worker", "s_lead", "call_s_worker", outcome).unwrap();
        assert_eq!(snapshot(), outcome.as_str());
    }
    record_spawn_outcome(&store, "s_worker", "s_lead", "call_s_worker", SpawnOutcome::Returned).unwrap();
    // This turn loaded before the parent wrote the result. Its own transcript
    // and runtime fields neither erase the result nor relabel the spawn.
    worker["activeRun"] = json!({"startedAt": 2});
    worker["turnFailure"] = json!({"message": "unrelated failure"});
    store.save_turn(&mut worker, None).unwrap();
    assert_eq!(snapshot(), "returned");
}

#[test]
fn startup_only_marks_interrupted_when_the_run_was_scoped_to_the_spawn() {
    let dir = tempfile::tempdir().unwrap();
    let store = SessionStore::new(dir.path());
    store.put_synced(&coordinator()).unwrap();
    for (i, run) in [
        json!({"startedAt": 1}),
        json!({"startedAt": 1, "spawnParentId": "s_lead", "spawnCallId": "wrong_call"}),
        json!({"startedAt": 1, "spawnParentId": "s_lead", "spawnCallId": "call_s_child_2"}),
    ]
    .into_iter()
    .enumerate()
    {
        let mut record = child(&format!("s_child_{i}"), "s_lead", 1);
        record["activeRun"] = run;
        store.put_synced(&record).unwrap();
    }
    assert_eq!(crate::boot::reconcile_interrupted(&store), 3);
    let snapshot = coordinator_snapshot(&store, "s_lead", &json!({})).unwrap();
    for row in snapshot["children"].as_array().unwrap() {
        assert_eq!(row["status"], if row["sessionId"] == "s_child_2" { "interrupted" } else { "unknown" });
    }
}

#[test]
fn coordinator_requires_saved_opt_in_and_never_shares_private_records() {
    let dir = tempfile::tempdir().unwrap();
    let store = SessionStore::new(dir.path());
    let mut lead = coordinator();
    let restricted = [
        ("incognito", json!(true)),
        ("offline", json!(true)),
        ("privacy", json!({ "mode": "redact" })),
        ("syncOff", json!(true)),
        ("home", json!({ "deviceId": "other_computer" })),
        ("executionMode", json!("sandbox")),
        ("archivedAt", json!(1)),
        ("trainingRunId", json!("run")),
    ];
    let settings = json!({});
    for (index, (key, value)) in restricted.into_iter().enumerate() {
        let mut record = child(&format!("s_restricted_{index}"), "s_lead", index as u64);
        record[key] = value.clone();
        store.put_synced(&record).unwrap();
        store.put_synced(&lead).unwrap();
        store.assign("s_lead", &[(key, value)]).unwrap();
        assert_eq!(coordinator_snapshot(&store, "s_lead", &settings), None, "{key}");
    }
    for value in [json!("true"), json!(false), Value::Null] {
        lead["orchestrate"] = value;
        store.put_synced(&lead).unwrap();
        assert_eq!(coordinator_snapshot(&store, "s_lead", &settings), None);
    }
    store.put_synced(&coordinator()).unwrap();
    let mut worker = child("s_worker", "s_lead", 20);
    worker["orchestrate"] = json!(true);
    store.put_synced(&worker).unwrap();
    assert_eq!(coordinator_snapshot(&store, "s_worker", &settings), None);
    assert_eq!(coordinator_snapshot(&store, "s_missing", &settings), None);
    assert_eq!(coordinator_snapshot(&store, "s_lead", &json!({ "privacyMode": "redact" })), None);
    assert_eq!(coordinator_snapshot(&store, "s_lead", &settings).unwrap()["children"].as_array().unwrap().len(), 1);
}

#[test]
fn coordinator_snapshot_caps_rows_and_utf8_titles() {
    let dir = tempfile::tempdir().unwrap();
    let store = SessionStore::new(dir.path());
    let mut lead = coordinator();
    let long_title = format!("a{}", "🐈".repeat(300));
    let mut steps = vec![json!({ "title": "Old work", "status": "done" }); MAX_STEPS * 2];
    steps.extend(vec![json!({ "title": long_title, "status": "pending" }); MAX_STEPS * 2]);
    lead["agentPlan"] = json!(steps);
    store.put_synced(&lead).unwrap();
    for index in 0..(MAX_CHILDREN * 2) {
        store.put_synced(&child(&format!("s_child_{index}"), "s_lead", index as u64)).unwrap();
    }
    let snapshot = coordinator_snapshot(&store, "s_lead", &json!({})).unwrap();
    let steps = snapshot["steps"].as_array().unwrap();
    assert_eq!(steps.len(), MAX_STEPS);
    let capped_title = format!("a{}", "🐈".repeat((MAX_TITLE_BYTES - 1) / 4));
    assert!(steps.iter().all(|step| step == &json!({ "title": capped_title, "status": "pending" })));
    let children = snapshot["children"].as_array().unwrap();
    assert_eq!(children.len(), MAX_CHILDREN);
    assert_eq!(children.first().unwrap()["sessionId"], format!("s_child_{}", MAX_CHILDREN * 2 - 1));
    assert_eq!(children.last().unwrap()["sessionId"], format!("s_child_{MAX_CHILDREN}"));
}

#[test]
fn worker_scope_uses_only_the_admitted_task_or_its_first_saved_message() {
    let settings = json!({});
    let mut worker = child("s_worker", "s_lead", 1);
    assert_eq!(worker_task(&worker, &settings, Some("  One scoped task.  ")), Some("One scoped task."));
    assert_eq!(worker_task(&worker, &settings, None), None);
    let dir = tempfile::tempdir().unwrap();
    let store = SessionStore::new(dir.path());
    worker["title"] = json!("Not the task");
    worker["agentPlan"] = json!([{ "title": "Not the task either" }]);
    worker["messages"] = json!([
        { "role": "user", "content": "Review only the scheduler." },
        { "role": "assistant", "content": "Other worker-private text" },
        { "role": "user", "content": "Later user message" }
    ]);
    // The parent need not exist: even on resume the projection opens no other records.
    store.put_synced(&worker).unwrap();
    let saved = store.get("s_worker").unwrap();
    assert_eq!(worker_task(&saved, &settings, None), Some("Review only the scheduler."));
    assert_eq!(worker_task(&saved, &settings, Some("Ignore this later input")), Some("Review only the scheduler."));
    worker["messages"][0] = json!({ "role": "assistant", "content": "Not an opening task" });
    assert_eq!(worker_task(&worker, &settings, Some("Ignore this later input")), None);
}

#[test]
fn worker_scope_is_bounded_and_fails_closed_for_private_or_unlinked_records() {
    let mut worker = child("s_worker", "s_lead", 1);
    let long = format!("a{}", "🐈".repeat(MAX_TASK_BYTES));
    let capped = format!("a{}", "🐈".repeat((MAX_TASK_BYTES - 1) / 4));
    let settings = json!({});
    assert_eq!(worker_task(&worker, &settings, Some(&long)), Some(capped.as_str()));
    for (key, value) in [
        ("incognito", json!(true)),
        ("privacy", json!({ "mode": "redact" })),
        ("syncOff", json!(true)),
        ("parentSessionId", json!("s_worker")),
        ("spawnCallId", Value::Null),
    ] {
        worker[key] = value;
        assert_eq!(worker_task(&worker, &settings, Some("secret task")), None, "{key}");
        worker = child("s_worker", "s_lead", 1);
    }
    assert_eq!(worker_task(&coordinator(), &settings, Some("secret task")), None);
    assert_eq!(worker_task(&worker, &json!({ "privacyMode": "redact" }), Some("secret task")), None);
}

#[test]
fn role_guidance_grounded_in_confirmed_route_and_tools() {
    let model_id = format!("opaque\"<id>\n{}", "é".repeat(100));
    let opts = json!({ "providerId": "p1", "modelId": model_id });
    let mut facts = json!({ "provider": { "id": "p1", "kind": "openai", "baseUrl": "https://api.openai.com/v1" } });
    let tiers = json!({ (format!("p1::{model_id}")): "medium", (format!("p2::{model_id}")): "small" });
    let route = Route::admitted(&opts, &facts, Some(&tiers)).unwrap();
    let worker = route.worker_instruction();
    assert!(worker.contains("focused check if possible"));
    assert!(worker.contains("uses a hosted route"));
    assert!(!worker.contains("opaque"));
    let context = route.context("task", json!("bounded task"));
    let wire = context.split_once('\n').unwrap().1;
    assert!(wire.contains(r#"opaque\"\u003cid\u003e\n"#));
    let data: Value = serde_json::from_str(wire).unwrap();
    let identity = data["model"]["modelId"].as_str().unwrap();
    assert!(identity.len() <= MAX_IDENTITY_BYTES && model_id.starts_with(identity));

    // A loopback tunnel to another computer is not evidence that its model
    // runs here. An unknown class doesn't imply a tool or capability.
    facts["provider"] = json!({
        "id": "p1", "kind": "openai-compat", "computerId": "other-device", "baseUrl": "http://127.0.0.1:1234/v1"
    });
    let unknown = Route::admitted(&opts, &facts, None).unwrap();
    assert_eq!((unknown.location, unknown.capability.as_deref()), (None, None));
    let guide = unknown.coordinator_instruction(&[json!({"name": "spawn_agent"})], &json!({}));
    assert!(guide.contains("at most 2 workers"));
    for unavailable in ["update_plan", "delegation_targets", "`capability`", "hosted", "locally"] {
        assert!(!guide.contains(unavailable), "{guide}");
    }
    assert_eq!(parallel_limit(&json!({ "orchestration": { "maxParallel": 0 } })), 1);
    assert_eq!(parallel_limit(&json!({ "orchestration": { "maxParallel": 3.8 } })), 3);
    facts["provider"]["id"] = json!("another");
    assert!(Route::admitted(&opts, &facts, Some(&tiers)).is_none());
}

#[tokio::test]
async fn saved_privacy_or_opt_out_invalidates_a_role_already_built() {
    let dir = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(SessionStore::new(dir.path().join("sessions")));
    let settings = std::sync::Arc::new(nekko_settings::SettingsStore::new(dir.path().to_path_buf()));
    store.save_whole(&mut coordinator()).unwrap();
    store.save_whole(&mut child("s_worker", "s_lead", 1)).unwrap();
    let lead = LiveRole {
        store: store.clone(),
        settings: settings.clone(),
        session_id: "s_lead".into(),
        worker: false,
        projected_children: vec!["s_worker".into()],
    };
    let worker = LiveRole {
        store: store.clone(),
        settings,
        session_id: "s_worker".into(),
        worker: true,
        projected_children: vec![],
    };
    assert!(lead.is_current().await);
    assert!(worker.is_current().await);
    store.assign("s_worker", &[("privacy", json!({"mode":"redact"}))]).unwrap();
    assert!(!lead.is_current().await);
    assert!(!worker.is_current().await);
    store.assign("s_worker", &[("privacy", Value::Null)]).unwrap();
    store.assign("s_lead", &[("orchestrate", json!(false))]).unwrap();
    assert!(!lead.is_current().await);
    assert!(!worker.is_current().await);
}
