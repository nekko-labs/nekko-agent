//! Cancellation: what the golden recordings cannot show, because the TS side
//! gets it from `AbortSignal` and async-generator semantics rather than code.
//! A fired signal ends a chat with the error a cancelled fetch throws, and a
//! consumer that walks away stops the task and drops the response (which is
//! what closes the connection).

use nekko_agent::http::{BoxFuture, HttpRequest, HttpResponse, ResponseBody, Transport, TransportError};
use nekko_agent::*;
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;

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

/// The ChatGPT catalog is held to the same five seconds, then reports the
/// failure rather than guessing models.
#[tokio::test(start_paused = true)]
async fn a_stalled_chatgpt_catalog_reports_an_error_after_five_seconds() {
    let headers_never_come = chatgpt(Arc::new(NeverAnswers));
    let body_never_ends = chatgpt(Arc::new(Stalling {
        first: "{\"models\":[",
        dropped: Arc::new(AtomicBool::new(false)),
        sends: AtomicUsize::new(0),
    }));

    for p in [headers_never_come, body_never_ends] {
        let started = tokio::time::Instant::now();
        let error = p.list_models().await.unwrap_err();
        assert_eq!(started.elapsed(), Duration::from_secs(5));
        assert!(error.to_string().contains("model catalog is unavailable"));
    }
}

/// Ollama's `/api/show` never answers; the chat after it does.
struct StalledShow {
    chats: Mutex<Vec<HttpRequest>>,
    show_arrived: Notify,
}

impl Transport for StalledShow {
    fn send<'a>(&'a self, req: &'a HttpRequest) -> BoxFuture<'a, Result<HttpResponse, TransportError>> {
        if req.url.ends_with("/api/show") {
            self.show_arrived.notify_one();
            return Box::pin(std::future::pending());
        }
        self.chats.lock().unwrap().push(req.clone());
        let done = "{\"done\":true}\n".as_bytes().to_vec();
        let body = StallingBody { first: Some(done), dropped: Arc::default() };
        Box::pin(async move { Ok(HttpResponse { status: 200, headers: Vec::new(), body: Box::new(body) }) })
    }
}

fn ollama_on_stalled_show() -> (AnyProvider, Arc<StalledShow>) {
    let transport = Arc::new(StalledShow { chats: Mutex::default(), show_arrived: Notify::new() });
    let config: ProviderConfig = serde_json::from_value(json!({
        "id": "p", "kind": "ollama", "baseUrl": "http://127.0.0.1:1", "enabled": true,
    }))
    .unwrap();
    let io = Io { transport: transport.clone(), clock: nekko_agent::stream::system_clock() };
    (create_provider_with(config, io), transport)
}

#[tokio::test(start_paused = true)]
async fn a_stalled_ollama_show_costs_the_chat_its_think_field_not_the_reply() {
    let (p, t) = ollama_on_stalled_show();
    let asked = tokio::time::Instant::now();
    let (chunks, err) = p.chat(ChatRequest { think: Some(true), ..request(None) }).collect().await;
    assert_eq!(asked.elapsed(), Duration::from_secs(2));
    assert_eq!(err, None);
    assert_eq!(
        chunks,
        vec![
            ProviderChunk::Usage {
                cache_read_tokens: None,
                cache_write_tokens: None,
                input_tokens: 0,
                output_tokens: 0,
                output_ms: None,
            },
            ProviderChunk::Done
        ]
    );

    let chats = t.chats.lock().unwrap();
    assert_eq!(chats.len(), 1);
    assert_eq!(chats[0].body.as_ref().unwrap().get("think"), None);
}

#[tokio::test]
async fn an_abort_during_the_ollama_show_ends_the_chat() {
    let (p, t) = ollama_on_stalled_show();
    let ctl = AbortController::new();
    let mut s = p.chat(ChatRequest { think: Some(true), ..request(Some(ctl.signal())) });

    t.show_arrived.notified().await;
    ctl.abort();
    let end = tokio::time::timeout(Duration::from_secs(5), s.next()).await.expect("abort was not noticed");
    assert_eq!(end, Some(Err(ProviderError::new("This operation was aborted"))));
    assert!(t.chats.lock().unwrap().is_empty());
}

#[tokio::test(start_paused = true)]
async fn think_off_reaches_ollama_when_the_show_would_have_stalled() {
    let (p, t) = ollama_on_stalled_show();
    let asked = tokio::time::Instant::now();
    let (_, err) = p.chat(ChatRequest { think: Some(false), ..request(None) }).collect().await;
    assert_eq!(asked.elapsed(), Duration::ZERO);
    assert_eq!(err, None);

    let chats = t.chats.lock().unwrap();
    assert_eq!(chats.len(), 1);
    assert_eq!(chats[0].body.as_ref().unwrap().get("think"), Some(&json!(false)));
}

/// Ollama refuses the chat, then its `/api/show` never answers.
struct RefusedThenStalledShow {
    show_arrived: Notify,
}

impl Transport for RefusedThenStalledShow {
    fn send<'a>(&'a self, req: &'a HttpRequest) -> BoxFuture<'a, Result<HttpResponse, TransportError>> {
        if req.url.ends_with("/api/show") {
            self.show_arrived.notify_one();
            return Box::pin(std::future::pending());
        }

        let body = br#"{"error":"\"m\" does not support tools"}"#.to_vec();
        let body = OneChunk(Some(body));
        Box::pin(async move { Ok(HttpResponse { status: 400, headers: Vec::new(), body: Box::new(body) }) })
    }
}

struct OneChunk(Option<Vec<u8>>);

impl ResponseBody for OneChunk {
    fn chunk(&mut self) -> BoxFuture<'_, Result<Option<Vec<u8>>, TransportError>> {
        let chunk = self.0.take();
        Box::pin(async move { Ok(chunk) })
    }
}

fn ollama_refusing_tools() -> (AnyProvider, Arc<RefusedThenStalledShow>) {
    let transport = Arc::new(RefusedThenStalledShow { show_arrived: Notify::new() });
    let config: ProviderConfig = serde_json::from_value(json!({
        "id": "p", "kind": "ollama", "baseUrl": "http://127.0.0.1:1", "enabled": true,
    }))
    .unwrap();
    let io = Io { transport: transport.clone(), clock: nekko_agent::stream::system_clock() };
    (create_provider_with(config, io), transport)
}

fn with_a_tool(req: ChatRequest) -> ChatRequest {
    let tool = ToolSpec { name: "read".into(), description: "Read".into(), parameters: json!({}) };
    ChatRequest { tools: Some(vec![tool]), ..req }
}

#[tokio::test(start_paused = true)]
async fn a_stalled_ollama_show_leaves_a_refused_chat_with_ollamas_own_error() {
    let (p, _) = ollama_refusing_tools();
    let asked = tokio::time::Instant::now();
    let (_, err) = p.chat(with_a_tool(request(None))).collect().await;
    assert_eq!(asked.elapsed(), Duration::from_secs(2));
    assert_eq!(err.unwrap().message, r#"Ollama: "m" does not support tools (400)"#);
}

#[tokio::test]
async fn an_abort_during_the_ollama_show_ends_a_refused_chat_without_the_wait() {
    let (p, t) = ollama_refusing_tools();
    let ctl = AbortController::new();
    let mut s = p.chat(with_a_tool(request(Some(ctl.signal()))));

    let wait = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::select! {
            _ = t.show_arrived.notified() => {}
            _ = s.next() => panic!("the chat ended without asking /api/show"),
        }
    });
    wait.await.expect("/api/show was never asked");
    ctl.abort();

    // Under the show's 2 s timeout. The chat had already failed, so its error stands.
    let end = tokio::time::timeout(Duration::from_secs(1), s.next()).await.expect("abort was not noticed");
    assert_eq!(end.unwrap().unwrap_err().message, r#"Ollama: "m" does not support tools (400)"#);
}
