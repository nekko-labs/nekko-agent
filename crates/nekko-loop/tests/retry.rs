//! A model call that fails in a way worth trying again is sent again
//! (`stream_with_retry`), as the TS loop does in `streamWithRetry`.

use nekko_loop::{
    Cancel, ChatRequest, Chunk, ChunkStream, MAX_NETWORK_STREAM_ATTEMPTS, ModelClient, RunOptions, ToolRunner,
    is_network_error, is_transient_error, retry_delay, run_agent,
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

#[test]
fn tells_a_dropped_network_from_a_provider_that_answered() {
    for m in [
        "fetch failed",
        "getaddrinfo ENOTFOUND api.anthropic.com",
        "connect ENETUNREACH 10.0.0.1:443",
        "error sending request for url (https://api.openai.com/v1/chat/completions)",
        "dns error: failed to lookup address information",
        "terminated",
    ] {
        assert!(is_network_error(m), "{m}");
        assert!(is_transient_error(m), "{m}");
    }
    for m in [
        "anthropic 529: overloaded",
        "Model request failed (HTTP 503)",
        "The model stopped sending after 300 s of silence.",
        "This operation was aborted",
        "anthropic 401: invalid x-api-key",
    ] {
        assert!(!is_network_error(m), "{m}");
    }
}

#[tokio::test(start_paused = true)]
async fn keeps_retrying_a_dropped_network_past_the_usual_five() {
    let client = Flaky { failures: Mutex::new(vec!["fetch failed".into(); 8]), calls: Mutex::new(0) };
    let mut history = vec![json!({ "id": "u1", "role": "user", "content": "hi", "createdAt": 1 })];
    let mut events = Vec::new();
    run_agent(opts(&mut history, Cancel::default()), &client, &NoTools, &mut |e, _| events.push(e)).await;
    assert_eq!(*client.calls.lock().unwrap(), 9);
    let retries: Vec<&Value> = events.iter().filter(|e| e["type"] == "retry").collect();
    assert_eq!(retries.len(), 8);
    assert_eq!(retries[0]["maxAttempts"], json!(MAX_NETWORK_STREAM_ATTEMPTS));
    assert_eq!(events.last().unwrap()["type"], "done");
    assert_eq!(history.last().unwrap()["content"], json!("Hello"));
}

#[tokio::test(start_paused = true)]
async fn gives_up_on_the_network_after_the_long_window() {
    let client = Flaky { failures: Mutex::new(vec!["fetch failed".into(); 70]), calls: Mutex::new(0) };
    let mut history = vec![json!({ "id": "u1", "role": "user", "content": "hi", "createdAt": 1 })];
    let mut events = Vec::new();
    run_agent(opts(&mut history, Cancel::default()), &client, &NoTools, &mut |e, _| events.push(e)).await;
    assert_eq!(*client.calls.lock().unwrap(), MAX_NETWORK_STREAM_ATTEMPTS as usize);
    assert_eq!(events.last().unwrap()["type"], "error");
    assert_eq!(history.last().unwrap()["interrupted"], json!(true));
}

/// A local server whose loaded window cannot hold the system prompt and the
/// tool definitions (llama.cpp's and LM Studio's wording). `fits` says whether
/// the prompt fits once the tools are left out.
struct SmallWindow {
    fits: bool,
    tools_sent: Mutex<Vec<usize>>,
}

const SMALL_WINDOW: &str = r#"Model stream failed: Engine protocol predict request returned 400: {"error":{"code":400,"message":"request (10510 tokens) exceeds the available context size (8192 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":10510,"n_ctx":8192}}"#;

impl ModelClient for SmallWindow {
    type Stream = Script;
    async fn chat(&self, req: ChatRequest, _cancel: Cancel) -> Result<Script, String> {
        self.tools_sent.lock().unwrap().push(req.tools.len());
        if !req.tools.is_empty() || !self.fits {
            return Ok(Script(VecDeque::from([Err(SMALL_WINDOW.to_string())])));
        }
        Ok(Script(VecDeque::from([Ok(Chunk::Text("Hello".into())), Ok(Chunk::Done)])))
    }
}

fn with_tools<'a>(history: &'a mut Vec<Value>) -> RunOptions<'a> {
    let tool = json!({ "name": "read_file", "description": "Read a file.", "parameters": { "type": "object" } });
    RunOptions { tools: vec![tool; 20], ..opts(history, Cancel::default()) }
}

#[tokio::test]
async fn a_window_too_small_for_the_tools_answers_without_them() {
    let client = SmallWindow { fits: true, tools_sent: Mutex::new(Vec::new()) };
    let mut history = vec![json!({ "id": "u1", "role": "user", "content": "Hello", "createdAt": 1 })];
    let mut events = Vec::new();
    run_agent(with_tools(&mut history), &client, &NoTools, &mut |e, _| events.push(e)).await;
    assert_eq!(*client.tools_sent.lock().unwrap(), vec![20, 0]);
    assert_eq!(events.iter().filter(|e| e["type"] == "retry").count(), 1);
    assert_eq!(events.last().unwrap()["type"], "done");
    assert_eq!(history.last().unwrap()["content"], json!("Hello"));
}

#[tokio::test]
async fn a_window_too_small_even_without_tools_says_how_to_fix_it() {
    let client = SmallWindow { fits: false, tools_sent: Mutex::new(Vec::new()) };
    let mut history = vec![json!({ "id": "u1", "role": "user", "content": "Hello", "createdAt": 1 })];
    let mut events = Vec::new();
    run_agent(with_tools(&mut history), &client, &NoTools, &mut |e, _| events.push(e)).await;
    assert_eq!(*client.tools_sent.lock().unwrap(), vec![20, 0]);
    let error = events.iter().find(|e| e["type"] == "error").expect("an error event");
    let message = error["message"].as_str().unwrap();
    assert!(message.starts_with("The model is loaded with a 8192-token context window"), "{message}");
    assert!(!message.contains("{\"error\""), "{message}");
}
