//! Cancellation: what the golden recordings cannot show, because the TS side
//! gets it from `AbortSignal` and async-generator semantics rather than code.
//! A fired signal ends a chat with the error a cancelled fetch throws, and a
//! consumer that walks away stops the task and drops the response (which is
//! what closes the connection).

use nekko_agent::http::{BoxFuture, HttpRequest, HttpResponse, ResponseBody, Transport, TransportError};
use nekko_agent::*;
use serde_json::json;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

/// Sends `first`, then never another byte, like a model that stalls.
struct StallingBody {
    first: Option<Vec<u8>>,
    dropped: Arc<AtomicBool>,
}

impl ResponseBody for StallingBody {
    fn chunk(&mut self) -> BoxFuture<'_, Result<Option<Vec<u8>>, TransportError>> {
        let first = self.first.take();
        Box::pin(async move {
            match first {
                Some(b) => Ok(Some(b)),
                None => std::future::pending().await,
            }
        })
    }
}

impl Drop for StallingBody {
    fn drop(&mut self) {
        self.dropped.store(true, Ordering::SeqCst);
    }
}

struct Stalling {
    first: &'static str,
    dropped: Arc<AtomicBool>,
    sends: AtomicUsize,
}

impl Transport for Stalling {
    fn send<'a>(&'a self, _req: &'a HttpRequest) -> BoxFuture<'a, Result<HttpResponse, TransportError>> {
        self.sends.fetch_add(1, Ordering::SeqCst);
        let body = StallingBody { first: Some(self.first.as_bytes().to_vec()), dropped: self.dropped.clone() };
        Box::pin(async move { Ok(HttpResponse { status: 200, headers: Vec::new(), body: Box::new(body) }) })
    }
}

fn setup(kind: &str, first: &'static str) -> (AnyProvider, Arc<Stalling>) {
    let transport = Arc::new(Stalling { first, dropped: Arc::new(AtomicBool::new(false)), sends: AtomicUsize::new(0) });
    let config: ProviderConfig = serde_json::from_value(json!({
        "id": "p", "kind": kind, "baseUrl": "http://127.0.0.1:1/v1", "apiKey": "k", "accountId": "a", "enabled": true,
    }))
    .unwrap();
    let io = Io { transport: transport.clone(), clock: nekko_agent::stream::system_clock() };
    (create_provider_with(config, io), transport)
}

fn request(signal: Option<AbortSignal>) -> ChatRequest {
    ChatRequest { model: "m".into(), messages: vec![ChatMessage::new(Role::User, "hi")], signal, ..Default::default() }
}

const OPENAI_FIRST: &str = "data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\n\n";

#[tokio::test]
async fn an_abort_mid_stream_ends_the_chat_with_the_abort_error() {
    let (p, t) = setup("openai-compat", OPENAI_FIRST);
    let ctl = AbortController::new();
    let mut s = p.chat(request(Some(ctl.signal())));
    assert_eq!(s.next().await, Some(Ok(ProviderChunk::Text { delta: "a".into() })));
    ctl.abort();
    let end = tokio::time::timeout(Duration::from_secs(5), s.next()).await.expect("abort was not noticed");
    assert_eq!(end, Some(Err(ProviderError::new("This operation was aborted"))));
    assert_eq!(s.next().await, None);
    assert!(t.dropped.load(Ordering::SeqCst), "the response outlived the chat");
}

#[tokio::test]
async fn an_abort_before_the_request_is_worded_per_provider() {
    let ctl = AbortController::new();
    ctl.abort();
    // openai-compat and chatgpt run fetch failures through friendlyError...
    for kind in ["openai-compat", "chatgpt"] {
        let (p, t) = setup(kind, "");
        let (chunks, err) = p.chat(request(Some(ctl.signal()))).collect().await;
        assert!(chunks.is_empty());
        assert_eq!(err.unwrap().message, "Request cancelled.", "{kind}");
        assert_eq!(t.sends.load(Ordering::SeqCst), 0);
    }
    // ...anthropic and ollama pass the runtime's own words through.
    for kind in ["anthropic", "ollama"] {
        let (p, _) = setup(kind, "");
        let (_, err) = p.chat(request(Some(ctl.signal()))).collect().await;
        assert_eq!(err.unwrap().message, "This operation was aborted", "{kind}");
    }
}

#[tokio::test]
async fn dropping_the_stream_stops_the_chat() {
    for (kind, first) in [
        ("openai-compat", OPENAI_FIRST),
        (
            "anthropic",
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"a\"}}\n\n",
        ),
        ("ollama", "{\"message\":{\"content\":\"a\"}}\n"),
        ("chatgpt", "data: {\"type\":\"response.output_text.delta\",\"delta\":\"a\"}\n\n"),
    ] {
        let (p, t) = setup(kind, first);
        let mut s = p.chat(request(None));
        assert_eq!(s.next().await, Some(Ok(ProviderChunk::Text { delta: "a".into() })), "{kind}");
        drop(s);
        let stopped = tokio::time::timeout(Duration::from_secs(5), async {
            while !t.dropped.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await;
        assert!(stopped.is_ok(), "{kind}: the chat kept reading after its consumer left");
    }
}

#[tokio::test]
async fn a_signal_whose_controller_is_gone_never_fires() {
    let signal = AbortController::new().signal();
    assert!(!signal.aborted());
    let fired = tokio::time::timeout(Duration::from_millis(50), signal.fired()).await;
    assert!(fired.is_err());
    assert!(!AbortSignal::never().aborted());
}

/// Accepts the request and never answers, not even with headers.
struct NeverAnswers;

impl Transport for NeverAnswers {
    fn send<'a>(&'a self, _req: &'a HttpRequest) -> BoxFuture<'a, Result<HttpResponse, TransportError>> {
        Box::pin(std::future::pending())
    }
}

fn anthropic(transport: Arc<dyn Transport>) -> AnyProvider {
    let config: ProviderConfig = serde_json::from_value(json!({
        "id": "p", "kind": "anthropic", "baseUrl": "https://api.anthropic.com", "apiKey": "k", "enabled": true,
    }))
    .unwrap();
    create_provider_with(config, Io { transport, clock: nekko_agent::stream::system_clock() })
}

/// Opening a chat waits on the model list, so a stalled catalog gives up after
/// five seconds and serves the shipped list.
#[tokio::test(start_paused = true)]
async fn a_stalled_anthropic_catalog_falls_back_after_five_seconds() {
    let headers_never_come = anthropic(Arc::new(NeverAnswers));
    let body_never_ends = anthropic(Arc::new(Stalling {
        first: "{\"data\":[",
        dropped: Arc::new(AtomicBool::new(false)),
        sends: AtomicUsize::new(0),
    }));

    for p in [headers_never_come, body_never_ends] {
        let started = tokio::time::Instant::now();
        let models = p.list_models().await.unwrap();
        assert_eq!(started.elapsed(), Duration::from_secs(5));
        assert!(models.iter().any(|m| m.id == "claude-opus-5-5"));
    }
}

fn chatgpt(transport: Arc<dyn Transport>) -> AnyProvider {
    let config: ProviderConfig = serde_json::from_value(json!({
        "id": "p", "kind": "chatgpt", "baseUrl": "https://chatgpt.com/backend-api", "apiKey": "k", "accountId": "a",
        "enabled": true,
    }))
    .unwrap();
    create_provider_with(config, Io { transport, clock: nekko_agent::stream::system_clock() })
}

/// The ChatGPT catalog is held to the same five seconds.
#[tokio::test(start_paused = true)]
async fn a_stalled_chatgpt_catalog_falls_back_after_five_seconds() {
    let headers_never_come = chatgpt(Arc::new(NeverAnswers));
    let body_never_ends = chatgpt(Arc::new(Stalling {
        first: "{\"models\":[",
        dropped: Arc::new(AtomicBool::new(false)),
        sends: AtomicUsize::new(0),
    }));

    for p in [headers_never_come, body_never_ends] {
        let started = tokio::time::Instant::now();
        let models = p.list_models().await.unwrap();
        assert_eq!(started.elapsed(), Duration::from_secs(5));
        assert!(models.iter().all(|m| m.fallback) && models.iter().any(|m| m.id == "gpt-6.1-sol"));
    }
}
