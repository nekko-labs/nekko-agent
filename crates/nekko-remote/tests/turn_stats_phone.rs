//! Persisted reply measurements must survive the phone's transcript projection.
//! They are counts and identifiers, not an agent event or notification payload.
use nekko_remote::phone;
use serde_json::json;

#[test]
fn phone_session_preserves_turn_stats_and_interruption_metadata() {
    let stats = json!({
        "providerId": "used-provider", "modelId": "used-model", "effort": "high",
        "inputTokens": 1000, "outputTokens": 500, "cacheReadTokens": 200,
        "cacheWriteTokens": 100, "outputMs": 10000, "wallMs": 50000,
        "calls": 3, "stop": "complete"
    });
    let session = json!({
        "id": "s", "modelId": "currently-selected-model",
        "messages": [{ "id": "a", "role": "assistant", "content": "Partial reply",
            "interrupted": true, "turnStats": stats,
            "toolCalls": [{ "id": "c", "name": "read_file", "input": { "path": "a.swift" } }] },
            { "id": "r", "role": "tool", "toolResult": {
                "toolCallId": "c", "output": "x".repeat(100_000), "images": ["private-tool-image"]
            } }]
    });
    let phone = phone::redact("session:get", session.clone());
    assert_eq!(phone["messages"][0]["turnStats"], stats);
    assert_eq!(phone["messages"][0]["interrupted"], true);
    assert_eq!(phone["messages"][0]["id"], "a");
    assert_eq!(phone["messages"][1]["toolResult"]["truncated"], true);
    assert!(phone["messages"][1]["toolResult"].get("images").is_none());
    assert_eq!(phone["messages"][1]["toolResult"]["omittedImages"], 1);
    // Paired-computer fallback uses the same message projection.
    assert_eq!(phone::computer_session_view(session)["messages"][0]["turnStats"], stats);
}

#[test]
fn legacy_messages_do_not_gain_stats_or_a_success_stop() {
    let view = phone::session_view(json!({
        "id": "s", "messages": [{ "id": "a", "role": "assistant", "content": "Legacy reply" }]
    }));
    assert!(view["messages"][0].get("turnStats").is_none());
}
