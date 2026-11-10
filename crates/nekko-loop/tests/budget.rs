//! A long reply's cost (budget.rs, #2491): a checkpoint every
//! CHECKPOINT_EVERY steps (never a stop), and no second copy of a large
//! output the model already has.

use nekko_loop::budget::{CHECKPOINT_EVERY, REPEAT_MIN_CHARS};
use nekko_loop::{Cancel, ChatRequest, Chunk, ChunkStream, ModelClient, RunOptions, ToolRunner, run_agent};
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

struct Script(VecDeque<Result<Chunk, String>>);

impl ChunkStream for Script {
    async fn next(&mut self) -> Option<Result<Chunk, String>> {
        self.0.pop_front()
    }
}

/// Calls `read_file` on `path(n)` for its `n`th call while tools are offered
/// and it has calls left; answers otherwise. Records what each call was sent.
struct Caller {
    calls: Mutex<usize>,
    limit: usize,
    path: fn(usize) -> String,
    sent: Mutex<Vec<ChatRequest>>,
}

impl ModelClient for Caller {
    type Stream = Script;
    async fn chat(&self, req: ChatRequest, _cancel: Cancel) -> Result<Script, String> {
        let n = {
            let mut c = self.calls.lock().unwrap();
            *c += 1;
            *c
        };
        let offered = !req.tools.is_empty();
        self.sent.lock().unwrap().push(req);
        let chunks = if offered && n <= self.limit {
            vec![Ok(Chunk::ToolCall(
                json!({ "id": format!("c{n}"), "name": "read_file", "input": { "path": (self.path)(n) } }),
            ))]
        } else {
            vec![Ok(Chunk::Text("Summary of the work.".into())), Ok(Chunk::Done)]
        };
        Ok(Script(VecDeque::from(chunks)))
    }
}

/// Every read returns the same large text for the same path.
struct Files;

impl ToolRunner for Files {
    async fn run(&self, call: &Value) -> Result<Value, String> {
        let path = call["input"]["path"].as_str().unwrap_or_default();
        Ok(json!({ "toolCallId": call["id"], "output": format!("{path}:{}", "x".repeat(REPEAT_MIN_CHARS)) }))
    }
}

async fn run(client: &Caller) -> (Vec<Value>, Vec<Value>) {
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
            steering: Arc::default(),
        },
        client,
        &Files,
        &mut |e, _| events.push(e),
    )
    .await;
    (history, events)
}

fn sent_text(req: &ChatRequest) -> String {
    req.messages.iter().filter_map(|m| m["content"].as_str()).collect::<Vec<_>>().join("\n")
}

#[tokio::test]
async fn checkpoints_a_long_reply_without_stopping_it() {
    let steps = 2 * CHECKPOINT_EVERY + 5;
    let client = Caller { calls: Mutex::new(0), limit: steps, path: |n| format!("f{n}"), sent: Mutex::default() };
    let (history, events) = run(&client).await;
    let sent = client.sent.lock().unwrap();
    let has =
        |i: usize, n: usize| sent_text(&sent[i]).contains(&format!("Checkpoint: this reply has taken {n} tool steps"));
    // The call right after steps 40 and 80 carries the note; the others do not.
    assert!(!has(CHECKPOINT_EVERY - 1, CHECKPOINT_EVERY));
    assert!(has(CHECKPOINT_EVERY, CHECKPOINT_EVERY));
    assert!(has(2 * CHECKPOINT_EVERY, 2 * CHECKPOINT_EVERY));
    assert!(sent.iter().all(|r| !r.tools.is_empty()), "tools are never withheld");
    assert_eq!(sent.len(), steps + 1);
    assert_eq!(history.last().unwrap()["content"], "Summary of the work.");
    let done = events.iter().rev().find(|e| e["type"] == "done").unwrap();
    assert_eq!((done["stop"].clone(), done["steps"].clone()), (json!("complete"), json!(steps)));
}

#[tokio::test]
async fn a_repeated_large_read_is_sent_once() {
    let client = Caller { calls: Mutex::new(0), limit: 2, path: |_| "AGENTS.md".into(), sent: Mutex::default() };
    let (history, _) = run(&client).await;
    let outputs: Vec<&str> =
        history.iter().filter(|m| m["role"] == "tool").map(|m| m["toolResult"]["output"].as_str().unwrap()).collect();
    assert_eq!(outputs.len(), 2);
    assert!(outputs[0].starts_with("AGENTS.md:xxx"));
    assert!(outputs[1].starts_with("[Same output as this read_file call returned at step 1"), "{}", outputs[1]);
    let sent = client.sent.lock().unwrap();
    assert_eq!(sent_text(&sent[2]).matches(&"x".repeat(REPEAT_MIN_CHARS)).count(), 0, "tool text is not in content");
    let big = serde_json::to_string(&sent[2].messages).unwrap().matches(&"x".repeat(REPEAT_MIN_CHARS)).count();
    assert_eq!(big, 1, "the large output goes out once");
}
