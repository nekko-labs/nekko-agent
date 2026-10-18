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
        say_text("wrote it"),
    ])
    .await;
    let settings = json!({
        "providers": [{ "id": "p1", "kind": "openai-compat", "label": "Scripted", "enabled": true, "baseUrl": format!("http://127.0.0.1:{}/v1", model.port) }],
        "workspaces": [{ "id": "w1", "name": "project", "path": workspace.to_string_lossy() }],
        "defaultChatMode": "yolo", "defaultProviderId": "p1", "defaultModelId": "synthetic",
    });
    std::fs::write(data.join("settings.json"), settings.to_string()).unwrap();
    let d = start_with(false, Some(&data));
    let mut events = ws(d.port, &format!("/api/events?token={TOKEN}"), None).await.unwrap();

    let (_, info) = post(d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    assert_eq!(info["backend"], "disabled", "{info}");
    for c in ["chat:send", "chat:compact", "chat:suggest", "chat:generateImage"] {
        assert!(info["owned"].as_array().unwrap().contains(&json!(c)), "{c} is owned: {info}");
    }

    // A whole turn, its tool included, admitted and run here.
    let opts = json!({ "sessionId": "s_solo", "providerId": "p1", "modelId": "synthetic", "text": "write a note" });
    let (status, body) = post(d.port, "chat:send", json!([opts]), Some(TOKEN)).await;
    assert_eq!((status, body.clone()), (200, Value::Null), "{body}");
    assert_eq!(std::fs::read_to_string(workspace.join("note.txt")).unwrap(), "hi");
    let saved: Value =
        serde_json::from_str(&std::fs::read_to_string(data.join("sessions/s_solo.json")).unwrap()).unwrap();
    assert_eq!(saved["messages"].as_array().unwrap().last().unwrap()["content"], "wrote it");

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
    // A folder with no chat running in it can be removed.
    let (status, folders) = post(d.port, "workspace:remove", json!(["w1"]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{folders}");
    assert_eq!(folders, json!([]));
    drop(d);
    let _ = std::fs::remove_dir_all(&data);
}
