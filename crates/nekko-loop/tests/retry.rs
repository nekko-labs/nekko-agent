//! A model call that fails in a way worth trying again is sent again
//! (`stream_with_retry`), as the TS loop does in `streamWithRetry`.

use nekko_loop::{
    Cancel, ChatRequest, Chunk, ChunkStream, ModelClient, RunOptions, ToolRunner, is_transient_error, retry_delay,
    run_agent,
};
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::Duration;

struct Script(VecDeque<Result<Chunk, String>>);

impl ChunkStream for Script {
    async fn next(&mut self) -> Option<Result<Chunk, String>> {
        self.0.pop_front()
    }
}

/// Fails the first `failures` calls (after streaming a little), then answers.
struct Flaky {
    failures: Mutex<Vec<String>>,
    calls: Mutex<usize>,
}

impl ModelClient for Flaky {
    type Stream = Script;
    async fn chat(&self, _req: ChatRequest, _cancel: Cancel) -> Result<Script, String> {
        *self.calls.lock().unwrap() += 1;
        let mut failures = self.failures.lock().unwrap();
        if failures.is_empty() {
            return Ok(Script(VecDeque::from([Ok(Chunk::Text("Hello".into())), Ok(Chunk::Done)])));
        }
        let e = failures.remove(0);
        Ok(Script(VecDeque::from([Ok(Chunk::Text("partial ".into())), Err(e)])))
    }
}

struct NoTools;

impl ToolRunner for NoTools {
    async fn run(&self, _call: &Value) -> Result<Value, String> {
        Err("no tools".into())
    }
}

fn opts<'a>(history: &'a mut Vec<Value>, cancel: Cancel) -> RunOptions<'a> {
    RunOptions {
        session_id: "s1".into(),
        model: "m".into(),
        system: "sys".into(),
        history,
        tools: Vec::new(),
        temperature: None,
        effort: None,
        think: None,
        prompt_caching: None,
        max_history_turns: None,
        context_window: None,
        max_output_tokens: None,
        image_input: None,
        resume: false,
        cancel,
        steering: Default::default(),
    }
}

#[test]
fn tells_transient_failures_from_the_rest() {
    for m in [
        "anthropic 529: {\"type\":\"overloaded_error\"}",
        "chatgpt 429: slow down",
        "Model request failed (HTTP 503)",
        "terminated: error decoding response body",
        "fetch failed: connection reset by peer",
        "anthropic stream error: overloaded_error: Overloaded",
    ] {
        assert!(is_transient_error(m), "{m}");
    }
    for m in [
        "anthropic 401: invalid x-api-key",
        "This operation was aborted",
        "max_tokens: 64000 > 32000",
        "chatgpt 400: bad request",
    ] {
        assert!(!is_transient_error(m), "{m}");
    }
    assert!(retry_delay(1) >= Duration::from_secs(1) && retry_delay(1) < Duration::from_secs(3));
    assert!(retry_delay(9) >= Duration::from_secs(30) && retry_delay(9) < Duration::from_secs(32));
}

#[tokio::test(start_paused = true)]
async fn sends_an_overloaded_call_again_and_keeps_only_the_attempt_that_worked() {
    let client = Flaky {
        failures: Mutex::new(vec!["anthropic 529: overloaded".into(), "terminated".into()]),
        calls: Mutex::new(0),
    };
    let mut history = vec![json!({ "id": "u1", "role": "user", "content": "hi", "createdAt": 1 })];
    let mut events = Vec::new();
    run_agent(opts(&mut history, Cancel::default()), &client, &NoTools, &mut |e, _| events.push(e)).await;
    assert_eq!(*client.calls.lock().unwrap(), 3);
    let retries: Vec<&Value> = events.iter().filter(|e| e["type"] == "retry").collect();
    assert_eq!(retries.len(), 2);
    assert_eq!(retries[0]["attempt"], json!(1));
    assert_eq!(retries[0]["maxAttempts"], json!(5));
    assert_eq!(retries[0]["reason"], json!("anthropic 529: overloaded"));
    assert_eq!(retries[1]["attempt"], json!(2));
    assert_eq!(events.last().unwrap()["type"], "done");
    let replies: Vec<&Value> = history.iter().filter(|m| m["role"] == "assistant").collect();
    assert_eq!(replies.len(), 1);
    assert_eq!(replies[0]["content"], json!("Hello"));
}

#[tokio::test(start_paused = true)]
async fn ends_the_reply_when_the_failure_is_not_transient() {
    let client = Flaky { failures: Mutex::new(vec!["anthropic 401: invalid x-api-key".into()]), calls: Mutex::new(0) };
    let mut history = vec![json!({ "id": "u1", "role": "user", "content": "hi", "createdAt": 1 })];
    let mut events = Vec::new();
    run_agent(opts(&mut history, Cancel::default()), &client, &NoTools, &mut |e, _| events.push(e)).await;
    assert_eq!(*client.calls.lock().unwrap(), 1);
    assert!(events.iter().all(|e| e["type"] != "retry"));
    assert_eq!(events.last().unwrap()["type"], "error");
    assert_eq!(history.last().unwrap()["interrupted"], json!(true));
}

#[tokio::test(start_paused = true)]
async fn gives_up_after_the_last_attempt() {
    let client = Flaky { failures: Mutex::new(vec!["anthropic 529: overloaded".into(); 6]), calls: Mutex::new(0) };
    let mut history = vec![json!({ "id": "u1", "role": "user", "content": "hi", "createdAt": 1 })];
    let mut events = Vec::new();
    run_agent(opts(&mut history, Cancel::default()), &client, &NoTools, &mut |e, _| events.push(e)).await;
    assert_eq!(*client.calls.lock().unwrap(), 5);
    assert_eq!(events.iter().filter(|e| e["type"] == "retry").count(), 4);
    assert_eq!(events.last().unwrap()["type"], "error");
}

#[tokio::test]
async fn stop_does_not_sit_out_a_backoff() {
    let client = Flaky { failures: Mutex::new(vec!["anthropic 529: overloaded".into(); 6]), calls: Mutex::new(0) };
    let mut history = vec![json!({ "id": "u1", "role": "user", "content": "hi", "createdAt": 1 })];
    let cancel = Cancel::default();
    let stopper = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        stopper.cancel();
    });
    let started = std::time::Instant::now();
    let mut events = Vec::new();
    run_agent(opts(&mut history, cancel), &client, &NoTools, &mut |e, _| events.push(e)).await;
    assert!(started.elapsed() < Duration::from_secs(5), "waited {:?}", started.elapsed());
    assert_eq!(events.last().unwrap()["type"], "error");
    assert_eq!(events.last().unwrap()["message"], json!("Stopped"));
}
