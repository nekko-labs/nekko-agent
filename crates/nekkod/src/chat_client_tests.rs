// The model client's tests: the Rust loop over a real provider, and Privacy Shield.

mod end_to_end {
    //! The Rust loop driving a real provider implementation over a fake wire: a
    //! streamed tool call, its result sent back, then the answer; and a Stop while
    //! the model is still silent.

    use crate::chat_client::ProviderClient;
    use nekko_agent::http::{BoxFuture, HttpRequest, HttpResponse, ResponseBody, Transport, TransportError};
    use nekko_agent::{Io, ProviderConfig, create_provider_with};
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
            tools: vec![
                json!({ "name": "read_file", "description": "Read a file.", "parameters": { "type": "object" } }),
            ],
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
        run_agent(options(&mut history, Cancel::default()), &provider(wire.clone()), &Files, &mut |e, _| {
            events.push(e)
        })
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
}

mod shielded {
    //! Privacy Shield on the loop's model client: the provider gets
    //! placeholders, the loop gets real values back.

    use crate::chat_client::ShieldedClient;
    use nekko_loop::{Cancel, ChatRequest, Chunk, ChunkStream, ModelClient};
    use nekko_privacy::{Policy, Shield};
    use serde_json::{Value, json};
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    struct Script(VecDeque<Result<Chunk, String>>);

    impl ChunkStream for Script {
        async fn next(&mut self) -> Option<Result<Chunk, String>> {
            self.0.pop_front()
        }
    }

    #[derive(Default)]
    struct Recorder {
        seen: Mutex<Vec<ChatRequest>>,
        reply: Vec<Result<Chunk, String>>,
    }

    impl ModelClient for Recorder {
        type Stream = Script;
        async fn chat(&self, req: ChatRequest, _cancel: Cancel) -> Result<Script, String> {
            self.seen.lock().unwrap().push(req);
            Ok(Script(self.reply.clone().into()))
        }
    }

    fn request() -> ChatRequest {
        ChatRequest {
            model: "m".into(),
            system: "Work in /Users/philip/app.".into(),
            messages: vec![json!({ "id": "1", "role": "user", "content": "Email jane@example.com the report" })],
            ..Default::default()
        }
    }

    async fn drain(stream: &mut impl ChunkStream) -> Vec<Result<Chunk, String>> {
        let mut out = Vec::new();
        while let Some(item) = stream.next().await {
            out.push(item);
        }
        out
    }

    fn shield() -> Arc<Mutex<Shield>> {
        Arc::new(Mutex::new(Shield::new(Policy { usernames: vec!["philip".into()], ..Policy::all() })))
    }

    #[tokio::test]
    async fn sends_placeholders_and_returns_real_values() {
        let recorder = Recorder {
            reply: vec![
                Ok(Chunk::Text("Sending to [PII_EM".into())),
                Ok(Chunk::Text("AIL_1] now".into())),
                Ok(Chunk::ToolCall(
                    json!({ "id": "c", "name": "write_file", "input": { "path": "/Users/[PII_USER_1]/app/to.txt", "content": "[PII_EMAIL_1]" } }),
                )),
                Ok(Chunk::Done),
            ],
            ..Default::default()
        };
        let client = ShieldedClient::new(recorder, Some(shield()));
        let mut stream = client.chat(request(), Cancel::default()).await.unwrap();
        let chunks = drain(&mut stream).await;

        let sent = &client_inner(&client)[0];
        assert!(sent.system.starts_with("Work in /Users/[PII_USER_1]/app."));
        assert!(sent.system.contains("## Private values"));
        assert_eq!(sent.messages[0]["content"], "Email [PII_EMAIL_1] the report");

        let text: String = chunks
            .iter()
            .filter_map(|c| match c {
                Ok(Chunk::Text(t)) => Some(t.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(text, "Sending to jane@example.com now");
        let call = chunks.iter().find_map(|c| match c {
            Ok(Chunk::ToolCall(v)) => Some(v.clone()),
            _ => None,
        });
        assert_eq!(
            call.unwrap()["input"],
            json!({ "path": "/Users/philip/app/to.txt", "content": "jane@example.com" })
        );
        assert!(matches!(chunks.last(), Some(Ok(Chunk::Done))));
    }

    #[tokio::test]
    async fn a_held_tail_goes_out_before_an_error() {
        let recorder = Recorder {
            reply: vec![Ok(Chunk::Text("to [PII_".into())), Err("anthropic 500: [PII_EMAIL_1] bad".into())],
            ..Default::default()
        };
        let client = ShieldedClient::new(recorder, Some(shield()));
        let mut stream = client.chat(request(), Cancel::default()).await.unwrap();
        let chunks = drain(&mut stream).await;
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[1], Ok(Chunk::Text("[PII_".into())));
        assert_eq!(chunks[2], Err("anthropic 500: jane@example.com bad".into()));
    }

    #[tokio::test]
    async fn without_a_shield_it_is_the_inner_client() {
        let recorder = Recorder { reply: vec![Ok(Chunk::Text("[PII_EMAIL_1]".into()))], ..Default::default() };
        let client = ShieldedClient::new(recorder, None);
        let mut stream = client.chat(request(), Cancel::default()).await.unwrap();
        assert_eq!(drain(&mut stream).await, vec![Ok(Chunk::Text("[PII_EMAIL_1]".into()))]);
        let sent = &client_inner(&client)[0];
        assert_eq!(sent.system, "Work in /Users/philip/app.");
        assert_eq!(sent.messages[0]["content"], Value::from("Email jane@example.com the report"));
    }

    fn client_inner(client: &ShieldedClient<Recorder>) -> Vec<ChatRequest> {
        client.inner().seen.lock().unwrap().clone()
    }
}

mod live {
    //! Live smoke, not run in CI: the Rust agent loop on the Rust OpenAI-compatible
    //! provider against a running llama-server, with one real tool.
    //!
    //! `LLAMA_URL=http://127.0.0.1:PORT/v1 cargo test -p nekkod a_live_tool_round_trip -- --ignored --nocapture`

    use crate::chat_client::ProviderClient;
    use nekko_agent::{ProviderConfig, create_provider};
    use nekko_loop::{Cancel, RunOptions, ToolRunner, run_agent};
    use serde_json::{Value, json};
    use std::time::Instant;

    struct Clock;

    impl ToolRunner for Clock {
        async fn run(&self, call: &Value) -> Result<Value, String> {
            Ok(json!({ "toolCallId": call["id"], "output": "2026-10-01T09:30:00Z" }))
        }
    }

    #[tokio::test]
    #[ignore = "needs a running llama-server at LLAMA_URL"]
    async fn a_live_tool_round_trip() {
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
}
