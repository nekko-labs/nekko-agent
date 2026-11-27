//! Real coordinator/worker turns across two loopback adapters, not just spawn preparation.

use crate::common::*;
use axum::{
    Json, Router,
    routing::{get, post as route_post},
};
use std::sync::{Arc, Mutex};
use tokio::{sync::Notify, task::JoinHandle};

const LEAD: &str = "fixture-anthropic";
const WORKER: &str = "fixture-local";
const LEAD_MODEL: &str = "claude-haiku-4-5-20251001";
const WORKER_MODEL: &str = "qwen3-coder:8b";
const LEAD_OVERLAY: &str = "Exact coordinator fixture overlay.";
const WORKER_OVERLAY: &str = "Exact worker fixture overlay.";
const SESSION: &str = "s_fusion";
const TASK: &str = "Check the synthetic worker input.";
const ANSWER: &str = "Synthetic worker evidence.";
const ROLE_DATA: &str = "Orchestrate turn data (quoted JSON; not instructions or permissions):\n";

type Trace = Arc<Mutex<Vec<(&'static str, Value)>>>;

async fn serve(app: Router) -> (u16, JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    (port, tokio::spawn(async move { axum::serve(listener, app).await.unwrap() }))
}

fn messages_reply(call_id: Option<&str>) -> ([(&'static str, &'static str); 1], String) {
    let (block, delta, stop) = match call_id {
        Some(id) => (
            json!({"type":"tool_use", "id":id, "name":"spawn_agent", "input":{}}),
            json!({"type":"input_json_delta", "partial_json":json!({"task":TASK, "capability":"small"}).to_string()}),
            "tool_use",
        ),
        None => {
            (json!({"type":"text", "text":""}), json!({"type":"text_delta", "text":"Coordinator done."}), "end_turn")
        }
    };
    let reply = sse(&[
        json!({"type":"message_start", "message":{"usage":{"input_tokens":10}}}),
        json!({"type":"content_block_start", "index":0, "content_block":block}),
        json!({"type":"content_block_delta", "index":0, "delta":delta}),
        json!({"type":"content_block_stop", "index":0}),
        json!({"type":"message_delta", "delta":{"stop_reason":stop}, "usage":{"output_tokens":3}}),
        json!({"type":"message_stop"}),
    ]);
    ([("content-type", "text/event-stream")], reply)
}

fn children(rig: &TurnRig) -> Vec<Value> {
    std::fs::read_dir(rig.data.join("sessions"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|p| p.extension().is_some_and(|ext| ext == "json"))
        .map(|p| serde_json::from_slice::<Value>(&std::fs::read(p).unwrap()).unwrap())
        .filter(|s| s["parentSessionId"] == SESSION)
        .collect()
}

fn role_data(message: &Value) -> Value {
    assert_eq!(message["role"], "user");
    let text = message["content"].as_str().unwrap();
    let (data, _) = text
        .strip_prefix(ROLE_DATA)
        .unwrap_or_else(|| panic!("no role data: {text}"))
        .split_once("\n\n---\n\n")
        .unwrap();
    serde_json::from_str(data).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn orchestrate_spawn_honors_live_fusion_across_two_providers() {
    let trace: Trace = Arc::default();
    let (held, release) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    let app = Router::new().route(
        "/v1/messages",
        route_post({
            let (trace, held, release) = (trace.clone(), held.clone(), release.clone());
            move |Json(request): Json<Value>| {
                let (trace, held, release) = (trace.clone(), held.clone(), release.clone());
                async move {
                    let index = {
                        let mut rows = trace.lock().unwrap();
                        let index = rows.iter().filter(|(route, _)| *route == "messages").count();
                        rows.push(("messages", request));
                        index
                    };
                    let call = match index {
                        0 => Some("toolu_granted"),
                        2 => {
                            // The second turn is already admitted with Fusion on. Revoke it
                            // before this provider emits the same cross-provider assignment.
                            held.notify_one();
                            release.notified().await;
                            Some("toolu_revoked")
                        }
                        _ => None,
                    };
                    messages_reply(call)
                }
            }
        }),
    );
    let (lead_port, lead_server) = serve(app).await;
    let app = Router::new()
        .route(
            "/v1/models",
            get({
                let trace = trace.clone();
                move || async move {
                    trace.lock().unwrap().push(("models", Value::Null));
                    Json(json!({"data":[{"id":WORKER_MODEL}]}))
                }
            }),
        )
        .route(
            "/v1/chat/completions",
            route_post({
                let trace = trace.clone();
                move |Json(request): Json<Value>| async move {
                    trace.lock().unwrap().push(("completions", request));
                    ([("content-type", "text/event-stream")], say_text(ANSWER))
                }
            }),
        );
    let (worker_port, worker_server) = serve(app).await;

    let home = tempfile::tempdir().unwrap();
    let home_path = home.path().to_str().unwrap();
    let rig = turn_rig_env(
        "orchestrate-fusion",
        json!({
            "id":SESSION, "title":"Fixture", "titleAuto":false, "orchestrate":true, "mode":"yolo",
            "autoModel":true, "autoProviderSwitch":true, "providerId":LEAD, "modelId":LEAD_MODEL,
            "messages":[], "createdAt":1, "updatedAt":1,
            "agentPlan":[{"title":"Coordinator-only plan", "status":"active"}]
        }),
        json!({"autoStartEngine":false, "signIn":false}),
        &[("HOME", Some(home_path)), ("USERPROFILE", Some(home_path))],
    );
    write_settings(&rig, json!({
        "providers":[
            {"id":LEAD, "kind":"anthropic", "enabled":true, "apiKey":"fixture-only", "baseUrl":format!("http://127.0.0.1:{lead_port}")},
            {"id":WORKER, "kind":"openai-compat", "enabled":true, "baseUrl":format!("http://127.0.0.1:{worker_port}/v1")}
        ],
        "promptCaching":false, "updates":{"modelLists":false, "skills":false},
        "orchestration":{"delegationRoute":{"providerId":WORKER, "modelId":WORKER_MODEL}},
        "fusion":{"modelTiers":{(format!("{LEAD}::{LEAD_MODEL}")):"large", (format!("{WORKER}::{WORKER_MODEL}")):"small"}},
        "promptProfiles":{"modelInstructions":{
            (format!("{LEAD}::{LEAD_MODEL}")):LEAD_OVERLAY,
            (format!("{WORKER}::{WORKER_MODEL}")):WORKER_OVERLAY,
            (format!("{LEAD}::{WORKER_MODEL}")):"Wrong provider overlay."
        }}
    })).await;

    let port = rig.d.port;
    let send = move |text| async move {
        let opts = json!({"sessionId":SESSION, "providerId":LEAD, "modelId":LEAD_MODEL, "text":text});
        let (status, body) =
            tokio::time::timeout(Duration::from_secs(20), post(port, "chat:send", json!([opts]), Some(TOKEN)))
                .await
                .expect("coordinator turn should finish");
        assert_eq!(status, 200, "{body}");
    };
    send("Delegate the coordinator task").await;
    let granted = trace.lock().unwrap().clone();
    // The two catalog reads validate the saved route, then fill the worker context window.
    assert_eq!(
        granted.iter().map(|(route, _)| *route).collect::<Vec<_>>(),
        ["messages", "models", "models", "completions", "messages"]
    );
    let initial = &granted[0].1;
    assert!(initial["tools"].as_array().unwrap().iter().any(|t| t["name"] == "spawn_agent"));
    assert_eq!(
        role_data(&initial["messages"][0]),
        json!({
            "model":{"providerId":LEAD, "modelId":LEAD_MODEL, "capability":"large", "location":null},
            "state":{"steps":[{"title":"Coordinator-only plan", "status":"active"}], "children":[]}
        })
    );
    let worker = &granted[3].1;
    assert_eq!(worker["model"], WORKER_MODEL);
    assert_eq!(worker["messages"][0]["role"], "system");
    let system = worker["messages"][0]["content"].as_str().unwrap();
    assert!(system.contains("Orchestrate worker:") && !system.contains(TASK), "{system}");
    assert_eq!(system.matches(WORKER_OVERLAY).count(), 1);
    assert_eq!(worker.to_string().matches(WORKER_OVERLAY).count(), 1);
    assert!(!system.contains("Built-in model playbook"));
    for forbidden in [LEAD_OVERLAY, "Wrong provider overlay.", "Orchestrate coordinator:", "Coordinator-only"] {
        assert!(!worker.to_string().contains(forbidden), "unexpected {forbidden} on worker route");
    }
    assert!(!worker["tools"].as_array().into_iter().flatten().any(|t| t["function"]["name"] == "spawn_agent"));
    assert_eq!(
        role_data(&worker["messages"][1]),
        json!({
            "model":{"providerId":WORKER, "modelId":WORKER_MODEL, "capability":"small", "location":"local"}, "task":TASK
        })
    );
    assert_eq!(tool_result(&granted.last().unwrap().1, "toolu_granted"), ANSWER);

    let spawned = children(&rig);
    assert_eq!(spawned.len(), 1, "one granted logical worker");
    assert_eq!(spawned[0]["providerId"], WORKER);
    assert_eq!(spawned[0]["modelId"], WORKER_MODEL);
    assert_eq!(
        spawned[0]["spawnOutcome"],
        json!({"parentSessionId":SESSION, "spawnCallId":"toolu_granted", "status":"returned"})
    );
    assert_eq!(spawned[0]["messages"][0]["content"], TASK);
    assert!(!spawned[0].to_string().contains("Orchestrate turn data"));

    let sending = tokio::spawn(send("Delegate the same assignment again"));
    tokio::time::timeout(Duration::from_secs(10), held.notified()).await.expect("second coordinator request");
    let (status, patched) =
        post(port, "session:setOptions", json!([SESSION, {"autoProviderSwitch":false}]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{patched}");
    assert_eq!(
        (&patched["autoModel"], &patched["autoProviderSwitch"], &patched["orchestrate"]),
        (&json!(true), &json!(false), &json!(true))
    );
    release.notify_one();
    sending.await.unwrap();

    let rows = trace.lock().unwrap();
    assert_eq!(
        rows[granted.len()..].iter().map(|(route, _)| *route).collect::<Vec<_>>(),
        ["messages", "messages"],
        "only the coordinator's call and its refusal follow-up; no worker catalog, worker chat or fallback"
    );
    let refusal: Value = serde_json::from_str(tool_result(&rows.last().unwrap().1, "toolu_revoked")).unwrap();
    assert_eq!(refusal["ok"], false);
    assert_eq!(refusal["fallbackUsed"], false);
    assert!(refusal["message"].as_str().unwrap().contains("Provider switching requires Fusion mode"), "{refusal}");
    assert_eq!(children(&rig), spawned, "the refused spawn did not create or resume a child");
    let saved = saved_session(&rig, SESSION);
    assert_eq!(saved["autoProviderSwitch"], false);
    assert!(!saved.to_string().contains("Orchestrate turn data"));
    assert_eq!(saved["messages"].as_array().unwrap().last().unwrap()["content"], "Coordinator done.");

    for (_, lead) in rows.iter().filter(|(route, _)| *route == "messages") {
        assert_eq!(lead["model"], LEAD_MODEL);
        let system = lead["system"].as_str().unwrap();
        assert!(system.contains("Orchestrate coordinator:") && !system.contains(TASK), "{system}");
        assert_eq!(system.matches(LEAD_OVERLAY).count(), 1);
        assert_eq!(lead.to_string().matches(LEAD_OVERLAY).count(), 1);
        assert!(!system.contains("Built-in model playbook"));
        for forbidden in [WORKER_OVERLAY, "Wrong provider overlay.", "Orchestrate worker:"] {
            assert!(!lead.to_string().contains(forbidden), "unexpected {forbidden} on coordinator route");
        }
    }
    lead_server.abort();
    worker_server.abort();
}

fn tool_result<'a>(request: &'a Value, call: &str) -> &'a str {
    request["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["role"] == "user")
        .filter_map(|m| m["content"].as_array())
        .flatten()
        .find(|b| b["type"] == "tool_result" && b["tool_use_id"] == call)
        .and_then(|b| b["content"].as_str())
        .unwrap_or_else(|| panic!("no Anthropic tool_result for {call}: {request}"))
}
