//! The Rust loop driving a real provider implementation over a fake wire: a
//! streamed tool call, its result sent back, then the answer; and a Stop while
//! the model is still silent.

use nekko_agent::http::{BoxFuture, HttpRequest, HttpResponse, ResponseBody, Transport, TransportError};
use nekko_agent::{Io, ProviderConfig, create_provider_with};
use nekko_chat::ProviderClient;
use nekko_loop::{Cancel, RunOptions, ToolRunner, run_agent};
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

struct Body(VecDeque<Vec<u8>>, bool);

impl ResponseBody for Body {
    fn chunk(&mut self) -> BoxFuture<'_, Result<Option<Vec<u8>>, TransportError>> {
        let next = self.0.pop_front();
        let hang = self.1;
        Box::pin(async move {
            match next {
                Some(c) => Ok(Some(c)),
                // A model still reading a long prompt: nothing arrives.
                None if hang => std::future::pending().await,
                None => Ok(None),
            }
        })
    }
}

struct Wire {
    replies: Mutex<VecDeque<(Vec<&'static str>, bool)>>,
    sent: Mutex<Vec<HttpRequest>>,
}

impl Transport for Wire {
    fn send<'a>(&'a self, req: &'a HttpRequest) -> BoxFuture<'a, Result<HttpResponse, TransportError>> {
        self.sent.lock().unwrap().push(req.clone());
        let reply = self.replies.lock().unwrap().pop_front();
        Box::pin(async move {
            let (events, hang) = reply.ok_or_else(|| TransportError::new("fetch failed"))?;
            let chunks = events.into_iter().map(|e| format!("data: {e}\n\n").into_bytes()).collect();
            Ok(HttpResponse {
                status: 200,
                headers: vec![("content-type".into(), "text/event-stream".into())],
                body: Box::new(Body(chunks, hang)),
            })
        })
    }
}

struct Files;

impl ToolRunner for Files {
    async fn run(&self, call: &Value) -> Result<Value, String> {
        Ok(
            json!({ "toolCallId": call["id"], "output": format!("contents of {}", call["input"]["path"].as_str().unwrap_or("?")) }),
        )
    }
}

fn provider(wire: Arc<Wire>) -> ProviderClient {
    let config: ProviderConfig = serde_json::from_value(json!({
        "id": "engine", "kind": "llamacpp", "label": "Engine", "baseUrl": "http://127.0.0.1:18555/v1", "enabled": true, "managedCachePrompt": true
    }))
    .unwrap();
    ProviderClient::new(create_provider_with(config, Io { transport: wire, ..Io::default() }))
}

fn options<'a>(history: &'a mut Vec<Value>, cancel: Cancel) -> RunOptions<'a> {
    RunOptions {
        session_id: "s1".into(),
        model: "gemma".into(),
        system: "SYSTEM".into(),
        history,
        tools: vec![json!({ "name": "read_file", "description": "Read a file.", "parameters": { "type": "object" } })],
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

#[tokio::test]
async fn a_tool_round_trip_through_the_openai_compatible_provider() {
    let wire = Arc::new(Wire {
        replies: Mutex::new(VecDeque::from([
            (
                vec![
                    r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"read_file","arguments":"{\"pa"}}]}}]}"#,
                    r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\":\"src/app.ts\"}"}}]}}]}"#,
                    r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
                    "[DONE]",
                ],
                false,
            ),
            (
                vec![
                    r#"{"choices":[{"delta":{"content":"It exports start."}}]}"#,
                    r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#,
                    "[DONE]",
                ],
                false,
            ),
        ])),
        sent: Mutex::default(),
    });
    let mut history =
        vec![json!({ "id": "u1", "role": "user", "content": "What does app.ts export?", "createdAt": 1 })];
    let mut events = Vec::new();
    run_agent(options(&mut history, Cancel::default()), &provider(wire.clone()), &Files, &mut |e, _| events.push(e))
        .await;

    let kinds: Vec<&str> = events.iter().map(|e| e["type"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["tool_call", "step", "tool_result", "text", "done"], "{events:?}");
    assert_eq!(events[0]["call"]["input"], json!({ "path": "src/app.ts" }));
    assert_eq!(history.len(), 4);
    assert_eq!(history[3]["content"], "It exports start.");
    // The second request carries the tool result back to the model.
    let sent = wire.sent.lock().unwrap().clone();
    assert_eq!(sent.len(), 2);
    let body = sent[1].body.as_ref().unwrap();
    assert!(
        body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["role"] == "tool" && m["content"] == "contents of src/app.ts"),
        "{body}"
    );
}

#[tokio::test]
async fn stop_ends_a_silent_stream_at_once() {
    let wire = Arc::new(Wire { replies: Mutex::new(VecDeque::from([(vec![], true)])), sent: Mutex::default() });
    let mut history = vec![json!({ "id": "u1", "role": "user", "content": "hi", "createdAt": 1 })];
    let cancel = Cancel::default();
    let stopper = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        stopper.cancel();
    });
    let started = Instant::now();
    let mut events = Vec::new();
    run_agent(options(&mut history, cancel), &provider(wire), &Files, &mut |e, _| events.push(e)).await;
    assert!(started.elapsed() < Duration::from_secs(3), "took {:?}", started.elapsed());
    assert_eq!(events.last().unwrap(), &json!({ "type": "error", "sessionId": "s1", "message": "Stopped" }));
}

#[tokio::test]
async fn cache_policy_and_usage_survive_the_provider_loop_boundary() {
    for policy in [None, Some(true), Some(false)] {
        let wire = Arc::new(Wire {
            replies: Mutex::new(VecDeque::from([(
                vec![
                    r#"{"choices":[{"delta":{"content":"answer"}}]}"#,
                    r#"{"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":60,"cache_write_tokens":10}}}"#,
                    "[DONE]",
                ],
                false,
            )])),
            sent: Mutex::default(),
        });
        let mut history = vec![json!({ "id": "u", "role": "user", "content": "hi", "createdAt": 1 })];
        let mut opts = options(&mut history, Cancel::default());
        opts.prompt_caching = policy;
        let mut events = Vec::new();
        run_agent(opts, &provider(wire.clone()), &Files, &mut |e, _| events.push(e)).await;
        let usage = events.iter().find(|e| e["type"] == "usage").unwrap();
        assert_eq!(usage["inputTokens"], 30);
        assert_eq!(usage["cacheReadTokens"], 60);
        assert_eq!(usage["cacheWriteTokens"], 10);
        assert_eq!(usage["outputTokens"], 5);
        assert_eq!(wire.sent.lock().unwrap()[0].body.as_ref().unwrap()["cache_prompt"], policy.unwrap_or(true));
    }
}
