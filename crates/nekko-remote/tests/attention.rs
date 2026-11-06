//! Authoritative attention comes only from a complete daemon pending read.
use nekko_remote::agent::{AgentCore, Host, activity_tag};
use nekko_remote::{e2e, hello, proof};
use serde_json::{Value, json};

fn core() -> AgentCore {
    AgentCore::new(
        e2e::derive_key("secret", "room"),
        Host { room: "room".into(), key: proof::new_key(&hello::os_random()) },
        Box::new(e2e::random_iv),
    )
}

fn value(frame: String) -> Value {
    serde_json::from_str(&frame).unwrap()
}

#[test]
fn snapshots_count_chats_not_requests_or_card_rows() {
    let core = core();
    let mut pending = serde_json::Map::new();
    for n in 0..20 {
        pending.insert(
            format!("s{n}"),
            json!({ "approval": { "call": { "id": "same" } }, "question": { "callId": "q" } }),
        );
    }
    let snapshot = value(core.attention_snapshot(&Value::Object(pending)));
    let tags = snapshot["tags"].as_array().unwrap();
    assert_eq!(snapshot["type"], "attention-snapshot");
    assert_eq!(tags.len(), 20, "not the eight Live Activity rows");
    assert!(tags.contains(&json!(activity_tag("s0"))));
    assert!(tags.iter().all(|t| t.as_str().unwrap().len() == 32));
    assert_eq!(value(core.attention_snapshot(&json!({}))), json!({ "type": "attention-snapshot", "tags": [] }));
}

#[test]
fn malformed_or_oversized_reads_are_unknown_never_clipped_or_zero() {
    let core = core();
    for bad in [Value::Null, json!([]), json!({ "s": null }), json!({ "s": {} }), json!({ "s": { "approval": false } })]
    {
        assert_eq!(value(core.attention_snapshot(&bad)), json!({ "type": "attention-unknown" }));
    }
    let mut pending = serde_json::Map::new();
    for n in 0..4096 {
        pending.insert(format!("s{n}"), json!({ "question": {} }));
    }
    assert_eq!(value(core.attention_snapshot(&json!(pending)))["tags"].as_array().unwrap().len(), 4096);
    pending.insert("overflow".into(), json!({ "question": {} }));
    assert_eq!(value(core.attention_snapshot(&json!(pending)))["type"], "attention-unknown");
}

#[test]
fn overlapping_input_never_gets_an_authoritative_removal_from_a_single_phase() {
    let mut core = core();
    let event = |core: &mut AgentCore, e| core.on_event("agent:event", &e).into_iter().map(value).collect::<Vec<_>>();
    let approval = json!({ "type": "tool_approval_required", "sessionId": "s", "call": { "id": "a" } });
    for _ in 0..2 {
        let frames = event(&mut core, approval.clone());
        assert_eq!(frames.iter().filter(|f| f["kind"] == "needs-you").count(), 1);
    }
    let question = event(&mut core, json!({ "type": "question", "sessionId": "s", "request": { "callId": "q" } }));
    assert!(!question.iter().any(|f| f["type"] == "dismiss"), "approval to question must not briefly clear the chat");
    for e in [
        json!({ "type": "tool_result", "sessionId": "s", "result": { "toolCallId": "a" } }),
        json!({ "type": "question_resolved", "sessionId": "s", "callId": "q" }),
        json!({ "type": "done", "sessionId": "s" }),
        json!({ "type": "error", "sessionId": "s" }),
    ] {
        let frames = event(&mut core, e);
        assert_eq!(frames[0]["type"], "attention-unknown", "withdraw before every removal: {frames:?}");
        let snapshot = value(core.attention_snapshot(&json!({ "s": { "question": { "callId": "other" } } })));
        assert_eq!(snapshot["tags"], json!([activity_tag("s")]));
    }
}

#[test]
fn first_running_activity_cannot_clear_a_preexisting_pending_chat() {
    let mut core = core();
    let snapshot = value(core.attention_snapshot(&json!({ "s": { "question": {} } })));
    assert_eq!(snapshot["tags"], json!([activity_tag("s")]));
    let frames: Vec<Value> = core
        .on_event("agent:event", &json!({ "type": "text", "sessionId": "s", "delta": "hi" }))
        .into_iter()
        .map(value)
        .collect();
    assert_eq!(frames[0]["type"], "attention-unknown");
    assert_eq!(frames[1]["phase"], "running");
}
