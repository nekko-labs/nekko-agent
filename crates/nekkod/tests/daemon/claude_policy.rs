//! The Claude policy through the real daemon: the routes the renderer reads,
//! the unattended-runs gate at admission, and the dev-only preview being
//! absent from a build without the `dev-tools` feature.

use crate::common::*;

/// The error the next `agent:event` for `session` carries.
async fn next_error(events: &mut Socket, session: &str) -> Option<String> {
    while let Some(frame) = next_json(events, Duration::from_secs(10)).await {
        let p = &frame["payload"];
        if frame["channel"] == "agent:event" && p["sessionId"] == session && p["type"] == "error" {
            return p["message"].as_str().map(str::to_string);
        }
    }
    None
}

#[tokio::test(flavor = "multi_thread")]
async fn gates_unattended_claude_code_turns_and_reports_reasons() {
    let data = std::env::temp_dir().join(format!("nekkod-claude-policy-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    std::fs::create_dir_all(data.join("sessions")).unwrap();
    for id in ["s_plan", "s_key"] {
        let chat = json!({ "id": id, "title": id, "messages": [], "createdAt": 1, "updatedAt": 1 });
        std::fs::write(data.join(format!("sessions/{id}.json")), chat.to_string()).unwrap();
    }
    let settings = json!({
        "providers": [
            // Claude Code signed in some way nekkod has not seen yet: unknown, a plan's rows.
            { "id": "cc_plan", "kind": "claude-code", "label": "Claude Agent", "enabled": true, "claudeCode": { "authSource": "cli" } },
            // Claude Code on the user's own Anthropic key: every feature.
            { "id": "cc_key", "kind": "claude-code", "label": "Claude Agent", "enabled": true, "claudeCode": { "authSource": "nekko-anthropic-key" } },
            { "id": "p_openai", "kind": "openai", "label": "OpenAI", "enabled": true, "baseUrl": "https://api.openai.com/v1" },
        ],
    });
    std::fs::write(data.join("settings.json"), settings.to_string()).unwrap();
    // The preview is asked for, but this build has no `dev-tools`: it must not apply.
    let d = start_with_env(false, Some(&data), json!({}), &[("NEKKO_CLAUDE_POLICY_PREVIEW", Some("subscription"))]);
    let mut events = ws(d.port, &format!("/api/events?token={TOKEN}"), None).await.unwrap();

    let (status, policy) = post(d.port, "claude:policy", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{policy}");
    assert_eq!(policy["preview"], Value::Null, "{policy}");
    assert_eq!(policy["override"], Value::Null, "{policy}");
    assert_eq!(policy["policy"]["subscription"]["unattended_runs"]["state"], "awaiting_approval");

    // The reason a greyed control shows.
    let (_, row) = post(d.port, "claude:capability", json!(["cc_plan", "unattended_runs"]), Some(TOKEN)).await;
    assert_eq!(row["auth"], "unknown", "{row}");
    assert_eq!(row["state"], "awaiting_approval");
    assert_eq!(row["reason"], "unattended_needs_api_key");
    assert_eq!(row["message"], "Scheduled runs need Claude with an API key.");
    let (_, row) = post(d.port, "claude:capability", json!(["cc_key", "nekko_tools"]), Some(TOKEN)).await;
    assert_eq!((row["state"].clone(), row["message"].clone()), (json!("enabled"), Value::Null), "{row}");
    let (_, row) = post(d.port, "claude:capability", json!(["cc_key", "model_routing"]), Some(TOKEN)).await;
    assert_eq!(row["reason"], "claude_code_owns_loop", "{row}");
    let (_, row) = post(d.port, "claude:capability", json!(["p_openai", "unattended_runs"]), Some(TOKEN)).await;
    assert_eq!(row, json!({ "claude": false }));
    let (_, usage) = post(d.port, "claude:planUsage", json!(["cc_plan"]), Some(TOKEN)).await;
    assert_eq!(usage, json!({ "source": "none", "message": "Check your plan's usage in Claude Code." }));

    // An unattended turn on Claude Code with plan (or unknown) auth is refused with the reason.
    let opts = json!({ "sessionId": "s_plan", "providerId": "cc_plan", "modelId": "sonnet", "text": "nightly", "unattended": true });
    let (status, body) = post(d.port, "chat:send", json!([opts]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(next_error(&mut events, "s_plan").await.as_deref(), Some("Scheduled runs need Claude with an API key."));

    // On an API key the gate lets it through (to whatever comes next; the
    // harness itself is not wired up here, so admission stops further on).
    let opts = json!({ "sessionId": "s_key", "providerId": "cc_key", "modelId": "sonnet", "text": "nightly", "unattended": true });
    post(d.port, "chat:send", json!([opts]), Some(TOKEN)).await;
    let err = next_error(&mut events, "s_key").await.unwrap_or_default();
    assert_ne!(err, "Scheduled runs need Claude with an API key.");

    drop(d);
    let _ = std::fs::remove_dir_all(&data);
}
