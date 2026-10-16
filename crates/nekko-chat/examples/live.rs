//! Live smoke, not run in CI: the Rust agent loop on the Rust OpenAI-compatible
//! provider against a running llama-server, with one real tool.
//!
//! `LLAMA_URL=http://127.0.0.1:PORT/v1 cargo run -p nekko-chat --example live`

use nekko_agent::{ProviderConfig, create_provider};
use nekko_chat::ProviderClient;
use nekko_loop::{Cancel, RunOptions, ToolRunner, run_agent};
use serde_json::{Value, json};
use std::time::Instant;

struct Clock;

impl ToolRunner for Clock {
    async fn run(&self, call: &Value) -> Result<Value, String> {
        Ok(json!({ "toolCallId": call["id"], "output": "2026-10-01T09:30:00Z" }))
    }
}

#[tokio::main]
async fn main() {
    let url = std::env::var("LLAMA_URL").expect("set LLAMA_URL to the llama-server /v1 address");
    let config: ProviderConfig = serde_json::from_value(
        json!({ "id": "engine", "kind": "llamacpp", "label": "Engine", "baseUrl": url, "enabled": true }),
    )
    .unwrap();
    let client = ProviderClient::new(create_provider(config));
    let mut history = vec![
        json!({ "id": "u1", "role": "user", "content": "What time is it? Use the clock tool, then answer in one short sentence.", "createdAt": 1 }),
    ];
    let started = Instant::now();
    let mut first_token = None;
    let mut events = Vec::new();
    run_agent(
        RunOptions {
            session_id: "live".into(),
            model: "gemma".into(),
            system: "You are a helpful assistant. Use tools when they help.".into(),
            history: &mut history,
            tools: vec![json!({ "name": "clock", "description": "The current time, as ISO 8601.", "parameters": { "type": "object", "properties": {} } })],
            temperature: Some(0.0),
            effort: None,
            think: Some(false),
            prompt_caching: None,
            max_history_turns: None,
            context_window: None,
            max_output_tokens: Some(256),
            image_input: None,
            resume: false,
            cancel: Cancel::default(),
            steering: Default::default(),
        },
        &client,
        &Clock,
        &mut |e: Value, _: &[Value]| {
            if e["type"] == "text" && first_token.is_none() {
                first_token = Some(started.elapsed());
            }
            events.push(e);
        },
    )
    .await;
    let kinds: Vec<String> = events.iter().map(|e| e["type"].as_str().unwrap_or("").to_string()).collect();
    println!("events: {}", kinds.join(","));
    for m in &history[1..] {
        println!(
            "{}: {}",
            m["role"].as_str().unwrap_or(""),
            serde_json::to_string(m.get("toolCalls").unwrap_or(&m["content"])).unwrap()
        );
    }
    println!("first text after {:?}, total {:?}", first_token, started.elapsed());
}
