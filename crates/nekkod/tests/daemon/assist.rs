//! The real `nekkod` binary end to end: side calls on a chat's model: designs, reply suggestions, prompt parts and linked specs.

use crate::common::*;

#[tokio::test(flavor = "multi_thread")]
async fn generates_a_design_on_the_default_provider() {
    let data = std::env::temp_dir().join(format!("nekkod-design-{}", std::process::id()));
    std::fs::create_dir_all(&data).unwrap();
    let model = scripted_model(vec![say_text("```html\n<!DOCTYPE html><p>Pricing</p>\n```")]).await;
    let d = start_with(true, Some(&data));
    // No default provider yet: the host's answer is the error.
    let (status, refused) =
        post(d.port, "design:generate", json!(["w1", { "prompt": "A pricing page" }]), Some(TOKEN)).await;
    assert_ne!(status, 200);
    assert!(refused.to_string().contains("default provider"), "{refused}");
    let (status, _) = post(d.port, "design:generate", json!(["w1", { "prompt": "  " }]), Some(TOKEN)).await;
    assert_ne!(status, 200);
    let provider = json!({ "id": "p1", "kind": "openai-compat", "label": "Scripted", "enabled": true, "baseUrl": format!("http://127.0.0.1:{}/v1", model.port) });
    post(
        d.port,
        "test:designProvider",
        json!([{ "provider": provider, "model": "synthetic", "promptCaching": true }]),
        Some(TOKEN),
    )
    .await;
    let (status, board) =
        post(d.port, "design:generate", json!(["w1", { "prompt": "  A pricing page  " }]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{board}");
    let page = &board["pages"][0];
    assert_eq!(
        (page["kind"].clone(), page["label"].clone(), page["html"].clone()),
        (json!("concept"), json!("A pricing page"), json!("<!DOCTYPE html><p>Pricing</p>"))
    );
    let sent = model.requests.lock().unwrap().clone();
    let user = sent[0]["messages"].as_array().unwrap().iter().find(|m| m["role"] == "user").unwrap().clone();
    assert_eq!(user["content"], json!("Design this: A pricing page"));
    let (_, again) = post(d.port, "design:get", json!(["w1"]), Some(TOKEN)).await;
    assert_eq!(again, board);
    let (_, noted) = post(d.port, "design:addNote", json!(["w1", page["id"], " tighter "]), Some(TOKEN)).await;
    assert_eq!(noted["pages"][0]["notes"][0]["text"], json!("tighter"));
    drop(d);
    std::fs::remove_dir_all(data).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn suggests_replies_and_fills_prompt_parts_on_the_chats_model() {
    let data = std::env::temp_dir().join(format!("nekkod-side-{}", std::process::id()));
    let sessions = data.join("sessions");
    std::fs::create_dir_all(&sessions).unwrap();
    let model = scripted_model(vec![
        say_text("Sure: {\"options\":[\"Commit it\",\"commit IT\",\"Run the tests\"],\"next\":\"Commit it and push\"}"),
        say_text("  \"You are a careful code reviewer.\"  "),
    ])
    .await;
    let settings = json!({
        "providers": [
            { "id": "p1", "kind": "openai-compat", "label": "Scripted", "enabled": true, "baseUrl": format!("http://127.0.0.1:{}/v1", model.port) },
            { "id": "off", "kind": "openai", "label": "Off", "enabled": false, "baseUrl": "https://api.openai.com/v1" },
        ],
        "defaultProviderId": "p1",
        "defaultModelId": "synthetic",
    });
    std::fs::write(data.join("settings.json"), settings.to_string()).unwrap();
    let messages = json!([
        { "id": "u1", "role": "user", "content": "Fix the bug", "createdAt": 1 },
        { "id": "a1", "role": "assistant", "content": "Fixed. Want me to commit?", "createdAt": 2 },
    ]);
    let chats = [
        ("s_side", json!({})),
        ("s_task", json!({ "taskId": "t1" })),
        ("s_offline", json!({ "offline": true, "providerId": "remote" })),
        ("s_disabled", json!({ "providerId": "off" })),
    ];
    for (id, extra) in &chats {
        let mut s = json!({ "id": id, "title": "Side", "messages": messages, "createdAt": 1, "updatedAt": 2 });
        for (k, v) in extra.as_object().unwrap() {
            s[k] = v.clone();
        }
        std::fs::write(sessions.join(format!("{id}.json")), serde_json::to_vec_pretty(&s).unwrap()).unwrap();
    }
    let d = start_with(true, Some(&data));
    let (_, info) = post(d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    for channel in ["chat:suggest", "chat:fillPrompt"] {
        assert!(info["owned"].as_array().unwrap().contains(&json!(channel)), "{channel} is not owned");
    }

    let (status, suggested) = post(d.port, "chat:suggest", json!(["s_side"]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{suggested}");
    assert_eq!(suggested, json!({ "options": ["Commit it", "Run the tests"], "next": "Commit it and push" }));
    let (_, filled) = post(d.port, "chat:fillPrompt", json!(["s_side", "Role", "Review this PR"]), Some(TOKEN)).await;
    assert_eq!(filled, json!("You are a careful code reviewer."));
    // Both ran on the chat's provider and default model, with the ported prompts.
    let sent = model.requests.lock().unwrap().clone();
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[0]["model"], "synthetic");
    let content =
        |i: usize| sent[i]["messages"].as_array().unwrap().last().unwrap()["content"].as_str().unwrap().to_string();
    assert_eq!(content(0), nekko_turn::suggest_prompt(&json!({ "messages": messages })).unwrap());
    assert_eq!(content(1), nekko_turn::fill_prompt("Role", "Review this PR"));
    assert_eq!(sent[0]["max_tokens"].as_u64().or(sent[0]["max_completion_tokens"].as_u64()), Some(220), "{}", sent[0]);
    // Usage written by the daemon, as the host's sideband wrote it.
    let usage = std::fs::read_to_string(data.join("usage.jsonl")).unwrap();
    let lines: Vec<Value> = usage.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    assert_eq!(lines.len(), 2, "{usage}");
    assert!(lines.iter().all(|l| l["sessionId"] == "s_side" && l["providerId"] == "p1" && l["modelId"] == "synthetic"));

    // Nobody to suggest to, an offline chat without a local provider, a disabled
    // provider, a chat that does not exist: null, and no model call.
    for id in ["s_task", "s_offline", "s_disabled", "s_absent"] {
        let (status, none) = post(d.port, "chat:suggest", json!([id]), Some(TOKEN)).await;
        assert_eq!((status, none), (200, Value::Null), "{id}");
    }
    let (_, none) = post(d.port, "chat:fillPrompt", json!(["s_disabled", "Role", "x"]), Some(TOKEN)).await;
    assert_eq!(none, Value::Null);
    assert_eq!(model.requests.lock().unwrap().len(), 2);
    // A failed call is null too: the model is gone.
    drop(model);
    let (status, none) = post(d.port, "chat:suggest", json!(["s_side"]), Some(TOKEN)).await;
    assert_eq!((status, none), (200, Value::Null));
    drop(d);
    std::fs::remove_dir_all(data).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn builds_a_linked_spec_on_the_chats_provider() {
    let data = std::env::temp_dir().join(format!("nekkod-spec-{}", std::process::id()));
    let project = data.join("project");
    std::fs::create_dir_all(project.join("x")).unwrap();
    std::fs::create_dir_all(data.join("sessions")).unwrap();
    std::fs::write(
        project.join("tasks.md"),
        "- [ ] a
",
    )
    .unwrap();
    let chat = json!({ "id": "s_spec", "title": "t", "workspaceId": "w1", "providerId": "p1", "modelId": "synthetic", "messages": [
        { "id": "u", "role": "user", "content": "Make a todo app", "createdAt": 1 }
    ], "createdAt": 1, "updatedAt": 1 });
    std::fs::write(data.join("sessions").join("s_spec.json"), chat.to_string()).unwrap();
    let model = scripted_model(vec![say_text(
        "```markdown
# Todo spec
```",
    )])
    .await;
    let d = start_with(true, Some(&data));
    let provider = json!({ "id": "p1", "kind": "openai-compat", "label": "Scripted", "enabled": true, "baseUrl": format!("http://127.0.0.1:{}/v1", model.port) });
    let folder = json!([{ "workspaces": [{ "id": "w1", "name": "project", "path": project.to_string_lossy(), "addedAt": 1 }], "providers": [provider] }]);
    post(d.port, "settings:update", folder, Some(TOKEN)).await;
    post(d.port, "test:designProvider", json!([{ "provider": provider, "promptCaching": true }]), Some(TOKEN)).await;
    let (status, built) = post(d.port, "spec:build", json!(["s_spec"]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{built}");
    assert_eq!(built["ok"], json!(true), "{built}");
    assert_eq!(
        std::fs::read_to_string(project.join("spec.md")).unwrap(),
        "# Todo spec
"
    );
    let (_, toggled) = post(d.port, "spec:toggleTask", json!(["s_spec", 0]), Some(TOKEN)).await;
    assert_eq!(toggled, json!({ "ok": true }));
    assert_eq!(
        std::fs::read_to_string(project.join("tasks.md")).unwrap(),
        "- [x] a
"
    );
    let (_, docs) = post(d.port, "spec:readDocs", json!(["s_spec"]), Some(TOKEN)).await;
    assert_eq!(
        docs["docs"][0]["content"],
        json!(
            "# Todo spec
"
        )
    );
    post(d.port, "spec:setMethodology", json!(["s_spec", "kiro"]), Some(TOKEN)).await;
    let (_, saved) = post(d.port, "session:get", json!(["s_spec"]), Some(TOKEN)).await;
    assert_eq!(saved["specMethodology"], json!("kiro"));
    drop(d);
    std::fs::remove_dir_all(data).ok();
}
