use nekko_store::SessionStore;
use serde_json::json;

#[test]
fn new_windows_snapshot_latest_defaults_and_old_chats_keep_theirs() {
    let dir = std::env::temp_dir().join(format!("nekko-chat-defaults-{}", std::process::id()));
    let store = SessionStore::new(&dir);
    let first = store
        .create_with_mode_defaults(None, None, None, &json!({ "effort": "low", "defaultChatMode": "ask" }), true)
        .unwrap();
    let settings = json!({ "effort": "normal", "defaultChatMode": "guardrails", "defaultSavedModeId": "fusion",
        "defaultSessionOptions": { "effort": "max", "mode": "yolo", "executionMode": "unified", "gitIsolation": false,
            "autoModel": true, "autoProviderSwitch": true, "workMode": "design",
            "incognito": true, "offline": true, "cloudOnly": false, "memory": "off", "guidance": "root",
            "disabledTools": ["bash"], "disabledMcpServers": ["fs"], "disabledConnectors": ["github"], "toolApproach": "code",
            "title": "must not leak", "workspaceId": "must not leak" } });
    let next = store.create_with_mode_defaults(None, None, None, &settings, true).unwrap();
    for key in [
        "effort",
        "mode",
        "executionMode",
        "gitIsolation",
        "incognito",
        "offline",
        "cloudOnly",
        "memory",
        "guidance",
        "disabledTools",
        "disabledMcpServers",
        "disabledConnectors",
        "toolApproach",
        "autoModel",
        "autoProviderSwitch",
        "workMode",
    ] {
        assert_eq!(next[key], settings["defaultSessionOptions"][key], "{key}");
    }
    assert_eq!(next["title"], "New chat");
    assert!(next.get("workspaceId").is_none());
    let disk = store.get(first["id"].as_str().unwrap()).unwrap();
    assert_eq!(disk, first, "creating another chat must not rewrite an existing chat");
    assert_eq!(disk["effort"], "low");
    assert_eq!(disk["mode"], "ask");
    let reopened = SessionStore::new(&dir).get(next["id"].as_str().unwrap()).unwrap();
    assert_eq!(reopened["effort"], "max");
    let child = store.create_with_mode_defaults(None, first["id"].as_str(), None, &settings, true).unwrap();
    assert_ne!(child["effort"], "max");
    let sandbox = store
        .create_with_mode_defaults(
            None,
            None,
            None,
            &json!({ "defaultSessionOptions": { "executionMode": "sandbox", "mode": "yolo", "gitIsolation": true } }),
            true,
        )
        .unwrap();
    assert_eq!(sandbox["mode"], "ask");
    assert_eq!(sandbox["gitIsolation"], false);
    assert_eq!(sandbox["effort"], "normal");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn saved_mode_is_the_baseline_and_manual_choices_override_only_their_fields() {
    let dir = std::env::temp_dir().join(format!("nekko-chat-defaults-precedence-{}", std::process::id()));
    let store = SessionStore::new(&dir);
    let mut settings = json!({ "effort": "low", "defaultChatMode": "ask", "defaultSavedModeId": "custom",
        "savedModes": [{ "id": "custom", "options": { "executionMode": "unified", "mode": "yolo",
            "effort": "max", "memory": "project", "offline": false, "incognito": false } }] });
    let starred = store.create_with_mode_defaults(None, None, None, &settings, true).unwrap();
    assert_eq!(starred["effort"], "max");
    assert_eq!(starred["mode"], "yolo");
    settings["defaultSessionOptions"] = json!({ "effort": "low", "memory": "off" });
    let manual = store.create_with_mode_defaults(None, None, None, &settings, true).unwrap();
    assert_eq!(manual["effort"], "low");
    assert_eq!(manual["memory"], "off");
    assert_eq!(manual["mode"], "yolo");
    assert_eq!(manual["gitIsolation"], false);
    // Legacy non-UI creation is deliberately unaffected by last-used desktop choices.
    let legacy = store.create_with(None, None, None, &settings).unwrap();
    assert_eq!(legacy["effort"], "max");
    assert_eq!(legacy["memory"], "project");
    settings.as_object_mut().unwrap().remove("defaultSessionOptions");
    settings["defaultSavedModeId"] = json!(null);
    let unstarred = store.create_with_mode_defaults(None, None, None, &settings, true).unwrap();
    assert_eq!(unstarred["effort"], "low");
    assert_eq!(unstarred["mode"], "ask");
    assert!(unstarred.get("memory").is_none());
    assert_eq!(store.get(starred["id"].as_str().unwrap()).unwrap(), starred);
    std::fs::remove_dir_all(dir).unwrap();
}
