//! A ChatGPT response that stalls server-side while the connection stays
//! alive: keep-alives keep arriving, so the transport's idle limit never fires,
//! and the provider has to notice that nothing moves on.

use nekko_agent::http::{BoxFuture, HttpRequest, HttpResponse, ResponseBody, Transport, TransportError};
use nekko_agent::*;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;

/// Sends `first`, then `ping` every `every` for ever (or nothing more, and ends).
struct Body {
    first: Option<&'static str>,
    ping: Option<&'static str>,
    every: Duration,
}

impl ResponseBody for Body {
    fn chunk(&mut self) -> BoxFuture<'_, Result<Option<Vec<u8>>, TransportError>> {
        let first = self.first.take();
        let ping = self.ping;
        let every = self.every;
        Box::pin(async move {
            if let Some(b) = first {
                return Ok(Some(b.as_bytes().to_vec()));
            }
            let Some(ping) = ping else { return Ok(None) };
            tokio::time::sleep(every).await;
            Ok(Some(ping.as_bytes().to_vec()))
        })
    }
}

struct Wire {
    first: &'static str,
    ping: Option<&'static str>,
}

impl Transport for Wire {
    fn send<'a>(&'a self, _req: &'a HttpRequest) -> BoxFuture<'a, Result<HttpResponse, TransportError>> {
        let body = Body { first: Some(self.first), ping: self.ping, every: Duration::from_secs(20) };
        Box::pin(async move { Ok(HttpResponse { status: 200, headers: Vec::new(), body: Box::new(body) }) })
    }
}

fn chatgpt(first: &'static str, ping: Option<&'static str>) -> AnyProvider {
    let config: ProviderConfig = serde_json::from_value(json!({
        "id": "p", "kind": "chatgpt", "baseUrl": "http://127.0.0.1:1/v1", "apiKey": "k", "accountId": "a", "enabled": true,
    }))
    .unwrap();
    let io = Io { transport: Arc::new(Wire { first, ping }), clock: nekko_agent::stream::system_clock() };
    create_provider_with(config, io)
}

fn request() -> ChatRequest {
    ChatRequest { model: "m".into(), messages: vec![ChatMessage::new(Role::User, "hi")], ..Default::default() }
}

const CREATED: &str = "data: {\"type\":\"response.created\",\"response\":{\"id\":\"r1\"}}\n\n";

#[tokio::test(start_paused = true)]
async fn keep_alives_alone_end_the_reply_with_a_retryable_stall() {
    for ping in [": keep-alive\n\n", "data: {\"type\":\"response.in_progress\"}\n\n"] {
        let started = tokio::time::Instant::now();
        let (chunks, err) = chatgpt(CREATED, Some(ping)).chat(request()).collect().await;
        assert!(chunks.is_empty(), "{ping:?}");
        let err = err.expect("a stalled reply must fail");
        assert!(err.message.contains("stopped sending"), "{}", err.message);
        let waited = started.elapsed();
        assert!(waited >= Duration::from_secs(180) && waited < Duration::from_secs(200), "{waited:?}");
    }
}

#[tokio::test(start_paused = true)]
async fn progress_resets_the_stall_clock() {
    // A reasoning summary every 20 s for ever is a model thinking, not a stall:
    // the reply is still running long after the stall limit.
    let ping = "data: {\"type\":\"response.reasoning_summary_text.delta\",\"delta\":\".\"}\n\n";
    let mut s = chatgpt(CREATED, Some(ping)).chat(request());
    let started = tokio::time::Instant::now();
    while started.elapsed() < Duration::from_secs(600) {
        match s.next().await {
            Some(Ok(ProviderChunk::Reasoning { .. })) => {}
            other => panic!("unexpected {other:?}"),
        }
    }
}

#[tokio::test(start_paused = true)]
async fn a_body_that_ends_before_completion_is_an_error() {
    let first = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"part\"}\n\n";
    let (chunks, err) = chatgpt(first, None).chat(request()).collect().await;
    assert_eq!(chunks, vec![ProviderChunk::Text { delta: "part".into() }]);
    assert!(err.expect("a truncated stream must fail").message.contains("stream ended unexpectedly"));
}
