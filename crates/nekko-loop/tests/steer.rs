//! A message the user sends while the reply runs (`loop:steer`) joins the
//! transcript at the next tool boundary, as `pullSteering` does in TS.

use nekko_loop::{Cancel, ChatRequest, Chunk, ChunkStream, ModelClient, RunOptions, Steering, ToolRunner, run_agent};
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

struct Script(VecDeque<Result<Chunk, String>>);

impl ChunkStream for Script {
    async fn next(&mut self) -> Option<Result<Chunk, String>> {
        self.0.pop_front()
    }
}

/// Two tool calls, then an answer; records what each call was sent.
struct Recorder {
    calls: Mutex<usize>,
    sent: Mutex<Vec<Vec<Value>>>,
}

impl ModelClient for Recorder {
    type Stream = Script;
    async fn chat(&self, req: ChatRequest, _cancel: Cancel) -> Result<Script, String> {
        let n = {
            let mut c = self.calls.lock().unwrap();
            *c += 1;
            *c
        };
        self.sent.lock().unwrap().push(req.messages.clone());
        let chunks = match n {
            1 => vec![Ok(Chunk::ToolCall(json!({ "id": "c1", "name": "read_file", "input": { "path": "a" } })))],
            2 => vec![Ok(Chunk::ToolCall(json!({ "id": "c2", "name": "read_file", "input": { "path": "b" } })))],
            _ => vec![Ok(Chunk::Text("done".into())), Ok(Chunk::Done)],
        };
        Ok(Script(VecDeque::from(chunks)))
    }
}

/// Steers while the first tool runs, the way the host does from `chat:steer`.
struct SteeringTools(Steering);

impl ToolRunner for SteeringTools {
    async fn run(&self, call: &Value) -> Result<Value, String> {
        if call["id"] == "c1" {
            self.0
                .lock()
                .unwrap()
                .push(json!({ "id": "steer_1", "role": "user", "content": "Also check the tests", "createdAt": 1 }));
        }
        Ok(json!({ "toolCallId": call["id"], "output": "ok" }))
    }
}

#[tokio::test]
async fn folds_a_steering_message_in_at_the_next_tool_boundary() {
    let steering: Steering = Arc::default();
    let client = Recorder { calls: Mutex::new(0), sent: Mutex::new(Vec::new()) };
    let mut history = vec![json!({ "id": "u1", "role": "user", "content": "go", "createdAt": 1 })];
    let mut events = Vec::new();
    run_agent(
        RunOptions {
            session_id: "s1".into(),
            model: "m".into(),
            system: "sys".into(),
            history: &mut history,
            tools: vec![json!({ "name": "read_file", "description": "", "parameters": {} })],
            temperature: None,
            effort: None,
            think: None,
            prompt_caching: None,
            max_history_turns: None,
            context_window: None,
            max_output_tokens: None,
            image_input: None,
            resume: false,
            cancel: Cancel::default(),
            steering: steering.clone(),
        },
        &client,
        &SteeringTools(steering),
        &mut |e, _| events.push(e),
    )
    .await;

    let roles: Vec<&str> = history.iter().map(|m| m["role"].as_str().unwrap()).collect();
    assert_eq!(roles, ["user", "assistant", "tool", "user", "assistant", "tool", "assistant"]);
    assert_eq!(history[3]["id"], "steer_1");
    let sent = client.sent.lock().unwrap();
    assert!(!sent[0].iter().any(|m| m["id"] == "steer_1"));
    assert!(sent[1].iter().any(|m| m["id"] == "steer_1"));
    let kinds: Vec<&str> = events.iter().map(|e| e["type"].as_str().unwrap()).collect();
    let steered = kinds.iter().position(|k| *k == "steered").expect("a steered event");
    let first_result = kinds.iter().position(|k| *k == "tool_result").unwrap();
    assert!(steered > first_result);
    assert_eq!(events[steered]["messageId"], "steer_1");
    assert_eq!(kinds.last(), Some(&"done"));
}
