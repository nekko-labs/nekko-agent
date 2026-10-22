//! One-shot completions beside a turn: a chat's title, the suggested
//! replies, a prompt part to fill in, a commit message, a spec or design
//! draft. The daemon's own services call `complete` (side.rs, turns.rs,
//! workspace.rs), and `provider:complete` serves the same call over the wire.
//! The caller builds the prompt and resolves the provider; the call and its
//! stream run here on the Rust providers.

use nekko_agent::{ChatRequest, Io, Provider, ProviderChunk, ProviderConfig, create_provider_with};
use serde_json::{Value, json};
use std::time::Duration;

/// Used when the request names no timeout; the host's own calls give up at 30 s.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// `provider:complete`: run `request` on `provider` and return the reply's text.
pub async fn complete(spec: &Value) -> Result<Value, String> {
    complete_with(spec, Io::default()).await
}

async fn complete_with(spec: &Value, io: Io) -> Result<Value, String> {
    let config: ProviderConfig = serde_json::from_value(spec.get("provider").cloned().unwrap_or(Value::Null))
        .map_err(|e| format!("provider: {e}"))?;
    let mut request: ChatRequest = serde_json::from_value(spec.get("request").cloned().unwrap_or(Value::Null))
        .map_err(|e| format!("request: {e}"))?;
    request.prompt_caching = Some(request.prompt_caching.unwrap_or(true));
    let timeout = spec.get("timeoutMs").and_then(Value::as_u64).map_or(DEFAULT_TIMEOUT, Duration::from_millis);
    let provider = create_provider_with(config, io);
    let mut stream = provider.chat(request);
    let mut text = String::new();
    // Keep every usage chunk, including zero counters, for host accounting.
    let mut usage = Vec::new();
    let read = async {
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(ProviderChunk::Text { delta }) => text.push_str(&delta),
                Ok(chunk @ ProviderChunk::Usage { .. }) => usage.push(serde_json::to_value(chunk).unwrap()),
                Ok(ProviderChunk::Done) => break,
                Ok(_) => {}
                Err(e) => return Err(e.message),
            }
        }
        Ok(())
    };
    let error = match tokio::time::timeout(timeout, read).await {
        Ok(Ok(())) => None,
        Ok(Err(e)) => Some(e),
        // Dropping the stream closes the connection. Only already observed usage is available.
        Err(_) => Some("The model took too long to answer.".into()),
    };
    // Opt-in v1 result contract: persist usage before throwing `error`. Legacy callers
    // still receive the same RPC error, never a successful partial completion.
    // This is best effort, not durable accounting across process/connection loss.
    if let Some(error) = &error
        && spec.get("usageOnFailure").and_then(Value::as_bool) != Some(true)
    {
        return Err(error.clone());
    }
    let mut out = json!({ "text": if error.is_some() { String::new() } else { text } });
    if !usage.is_empty() {
        out["usage"] = json!(usage);
    }
    if let Some(error) = error {
        out["error"] = json!(error);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nekko_agent::http::{BoxFuture, HttpRequest, HttpResponse, ResponseBody, Transport, TransportError};
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    struct Body(VecDeque<Vec<u8>>, bool);

    impl ResponseBody for Body {
        fn chunk(&mut self) -> BoxFuture<'_, Result<Option<Vec<u8>>, TransportError>> {
            let next = self.0.pop_front();
            let hang = self.1;
            Box::pin(async move {
                match next {
                    Some(c) if c == b"data: transport-error\n\n" => Err(TransportError::new("stream failed")),
                    Some(c) => Ok(Some(c)),
                    None if hang => std::future::pending().await,
                    None => Ok(None),
                }
            })
        }
    }

    /// One scripted reply (server-sent events, or a status), recording the request.
    struct Wire {
        events: Vec<&'static str>,
        status: u16,
        hang: bool,
        sent: Mutex<Vec<HttpRequest>>,
    }

    impl Transport for Wire {
        fn send<'a>(&'a self, req: &'a HttpRequest) -> BoxFuture<'a, Result<HttpResponse, TransportError>> {
            self.sent.lock().unwrap().push(req.clone());
            let chunks = self.events.iter().map(|e| format!("data: {e}\n\n").into_bytes()).collect();
            let (status, hang) = (self.status, self.hang);
            Box::pin(async move {
                Ok(HttpResponse {
                    status,
                    headers: vec![("content-type".into(), "text/event-stream".into())],
                    body: Box::new(Body(chunks, hang)),
                })
            })
        }
    }

    fn wire(events: Vec<&'static str>, status: u16, hang: bool) -> Arc<Wire> {
        Arc::new(Wire { events, status, hang, sent: Mutex::default() })
    }

    fn spec(timeout_ms: u64) -> Value {
        json!({
            "provider": { "id": "p", "kind": "llamacpp", "label": "P", "baseUrl": "http://127.0.0.1:1/v1", "enabled": true },
            "request": {
                "model": "gemma",
                "messages": [{ "id": "title", "role": "user", "content": "Name this chat", "createdAt": 1 }],
                "temperature": 0.2,
                "maxOutputTokens": 24,
                "think": false,
                "purpose": "title"
            },
            "timeoutMs": timeout_ms
        })
    }

    #[tokio::test]
    async fn returns_the_reply_text_and_sends_the_request_as_given() {
        let w = wire(
            vec![
                r#"{"choices":[{"delta":{"reasoning_content":"thinking"}}]}"#,
                r#"{"choices":[{"delta":{"content":"Fix the "}}]}"#,
                r#"{"choices":[{"delta":{"content":"parser"},"finish_reason":"stop"}]}"#,
                "[DONE]",
            ],
            200,
            false,
        );
        let out = complete_with(&spec(5_000), Io { transport: w.clone(), ..Io::default() }).await;
        assert_eq!(out, Ok(json!({ "text": "Fix the parser" })));
        let sent = w.sent.lock().unwrap();
        let body = sent[0].body.clone().unwrap_or_default();
        assert_eq!(body["model"], "gemma");
        assert_eq!(body["max_tokens"], 24);
        assert_eq!(body["messages"][0]["content"], "Name this chat");
    }

    #[tokio::test]
    async fn title_caching_policy_and_usage_are_forwarded() {
        for policy in [None, Some(true), Some(false)] {
            let w = wire(
                vec![
                    r#"{"choices":[{"delta":{"content":"Title"}}]}"#,
                    r#"{"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":60,"cache_write_tokens":10}}}"#,
                    "[DONE]",
                ],
                200,
                false,
            );
            let mut spec = spec(5000);
            spec["provider"]["managedCachePrompt"] = json!(true);
            if let Some(policy) = policy {
                spec["request"]["promptCaching"] = json!(policy);
            }
            let out = complete_with(&spec, Io { transport: w.clone(), ..Io::default() }).await.unwrap();
            assert_eq!(out["text"], "Title");
            assert_eq!(out["usage"][0]["inputTokens"], 30);
            assert_eq!(out["usage"][0]["cacheReadTokens"], 60);
            assert_eq!(out["usage"][0]["cacheWriteTokens"], 10);
            assert_eq!(w.sent.lock().unwrap()[0].body.as_ref().unwrap()["cache_prompt"], policy.unwrap_or(true));
        }
    }

    #[tokio::test]
    async fn opt_in_preserves_observed_usage_on_error_and_timeout() {
        for hang in [false, true] {
            let mut events = vec![
                r#"{"choices":[{"delta":{"content":"Partial"}}]}"#,
                r#"{"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":0,"prompt_tokens_details":{"cached_tokens":60,"cache_write_tokens":10}}}"#,
            ];
            if !hang {
                events.push("transport-error");
            }
            for opt_in in [false, true] {
                let mut request = spec(50);
                request["usageOnFailure"] = json!(opt_in);
                let out =
                    complete_with(&request, Io { transport: wire(events.clone(), 200, hang), ..Io::default() }).await;
                if opt_in {
                    let out = out.unwrap();
                    assert_eq!(out["text"], "");
                    assert_eq!(out["usage"][0]["inputTokens"], 30);
                    assert_eq!(out["usage"][0]["outputTokens"], 0);
                    assert_eq!(out["usage"][0]["cacheReadTokens"], 60);
                    assert_eq!(out["usage"][0]["cacheWriteTokens"], 10);
                    assert!(out["error"].as_str().is_some_and(|e| !e.is_empty()));
                } else {
                    assert!(out.is_err());
                }
            }
        }
    }

    #[tokio::test]
    async fn reports_a_failed_request_and_gives_up_at_the_timeout() {
        let failed = complete_with(&spec(5_000), Io { transport: wire(vec![], 500, false), ..Io::default() }).await;
        assert!(failed.is_err());
        let silent = complete_with(&spec(50), Io { transport: wire(vec![], 200, true), ..Io::default() }).await;
        assert_eq!(silent, Err("The model took too long to answer.".to_string()));
    }
}
