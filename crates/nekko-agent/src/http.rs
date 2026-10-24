//! The wire under the providers, as a seam.
//!
//! A provider builds an [`HttpRequest`] and hands it to a [`Transport`]. In
//! the daemon that is [`ReqwestTransport`]; in the golden tests it is a fake
//! that records the request and plays back a recorded response, which is how
//! the port is held to the exact requests and chunk sequences the TS providers
//! produce.
//!
//! Errors keep the TS runtime's words. Node's `fetch` says `fetch failed` for
//! every network failure and `This operation was aborted` for a cancelled
//! request, and the providers branch on that text (`friendlyError`) or pass it
//! straight to the user, so the transport reports those same messages and
//! keeps reqwest's own description as `detail`.

use serde_json::Value;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, LazyLock};
use std::time::Duration;
use tokio::sync::watch;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// A request as a provider built it: what the golden tests compare.
#[derive(Debug, Clone, PartialEq)]
pub struct HttpRequest {
    pub method: &'static str,
    pub url: String,
    /// In the order the TS provider writes its header object.
    pub headers: Vec<(String, String)>,
    /// Sent as `JSON.stringify` would print it (see `js::stringify`).
    pub body: Option<Value>,
}

impl HttpRequest {
    pub(crate) fn get(url: String, headers: Vec<(String, String)>) -> Self {
        Self { method: "GET", url, headers, body: None }
    }

    pub(crate) fn post(url: String, headers: Vec<(String, String)>, body: Value) -> Self {
        Self { method: "POST", url, headers, body: Some(body) }
    }
}

pub(crate) fn headers(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

/// A response body, read chunk by chunk as it arrives.
pub trait ResponseBody: Send {
    /// The next piece of the body, or `None` at the end.
    fn chunk(&mut self) -> BoxFuture<'_, Result<Option<Vec<u8>>, TransportError>>;
}

pub struct HttpResponse {
    pub status: u16,
    /// Names lowercased, as `Headers` iterates them.
    pub headers: Vec<(String, String)>,
    pub body: Box<dyn ResponseBody>,
}

impl HttpResponse {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// `res.text().catch(() => '')`.
    pub async fn text(&mut self) -> String {
        let mut all = Vec::new();
        loop {
            match self.body.chunk().await {
                Ok(Some(c)) => all.extend_from_slice(&c),
                Ok(None) => return crate::js::decode_text(&all),
                Err(_) => return String::new(),
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportError {
    /// What Node's fetch would have said.
    pub message: String,
    /// The underlying cause, for logs.
    pub detail: Option<String>,
}

impl TransportError {
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into(), detail: None }
    }

    /// The `AbortError` a cancelled fetch rejects with.
    pub fn aborted() -> Self {
        Self::new("This operation was aborted")
    }
}

pub trait Transport: Send + Sync {
    fn send<'a>(&'a self, req: &'a HttpRequest) -> BoxFuture<'a, Result<HttpResponse, TransportError>>;
}

/// How long a connection may take to open. A provider that cannot be reached
/// should say so in seconds, not hang a reply on a SYN nobody answers.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// How long a response may stay silent before the read fails (`terminated`).
///
/// Five minutes, as Codex's `stream_idle_timeout_ms`: a local model can take
/// minutes to its first token on a cold prompt, and a cloud model given a
/// 200k-token context thinks for a long while before it says anything. A
/// stream the server silently abandoned used to wait here for ever;
/// `NEKKO_STREAM_IDLE_MS` overrides the limit (0 disables it).
pub fn stream_idle() -> Option<Duration> {
    match std::env::var("NEKKO_STREAM_IDLE_MS").ok().and_then(|v| v.trim().parse::<u64>().ok()) {
        Some(0) => None,
        Some(ms) => Some(Duration::from_millis(ms)),
        None => Some(Duration::from_secs(300)),
    }
}

/// The real wire. No overall timeout and no proxy from the environment, like
/// Node's fetch; only a connect limit and an idle limit on the body.
pub struct ReqwestTransport {
    client: reqwest::Client,
}

impl ReqwestTransport {
    pub fn new(client: reqwest::Client) -> Self {
        Self { client }
    }

    /// One shared client, so connections to a provider are reused across chats.
    pub fn shared() -> Arc<dyn Transport> {
        static SHARED: LazyLock<Arc<ReqwestTransport>> = LazyLock::new(|| {
            let mut builder = reqwest::Client::builder().no_proxy().connect_timeout(CONNECT_TIMEOUT);
            if let Some(idle) = stream_idle() {
                builder = builder.read_timeout(idle);
            }
            Arc::new(ReqwestTransport::new(builder.build().unwrap_or_default()))
        });
        SHARED.clone()
    }
}

/// reqwest's message and every cause under it: the cause says why
/// (`connection reset`, `dns error`), the top line only that sending failed.
fn causes(e: &dyn std::error::Error) -> String {
    let mut out = e.to_string();
    let mut next = e.source();
    while let Some(c) = next {
        out.push_str(": ");
        out.push_str(&c.to_string());
        next = c.source();
    }
    out
}

fn network(e: reqwest::Error, message: &str) -> TransportError {
    TransportError { message: message.into(), detail: Some(e.to_string()) }
}

impl Transport for ReqwestTransport {
    fn send<'a>(&'a self, req: &'a HttpRequest) -> BoxFuture<'a, Result<HttpResponse, TransportError>> {
        Box::pin(async move {
            let method = if req.method == "POST" { reqwest::Method::POST } else { reqwest::Method::GET };
            let mut b = self.client.request(method, &req.url);
            for (k, v) in &req.headers {
                b = b.header(k, v);
            }
            if let Some(body) = &req.body {
                b = b.body(crate::js::stringify(body));
            }
            let res = b.send().await.map_err(|e| {
                // The message the user sees is "Can't reach …"; this is why.
                eprintln!("nekkod: {} {} failed: {}", req.method, req.url, causes(&e));
                network(e, "fetch failed")
            })?;
            let headers = res
                .headers()
                .iter()
                .map(|(k, v)| (k.as_str().to_ascii_lowercase(), String::from_utf8_lossy(v.as_bytes()).into_owned()))
                .collect();
            Ok(HttpResponse { status: res.status().as_u16(), headers, body: Box::new(ReqwestBody(res)) })
        })
    }
}

struct ReqwestBody(reqwest::Response);

impl ResponseBody for ReqwestBody {
    fn chunk(&mut self) -> BoxFuture<'_, Result<Option<Vec<u8>>, TransportError>> {
        // `terminated` is what Node's reader rejects with when the connection
        // drops mid-body.
        Box::pin(
            async move { self.0.chunk().await.map(|c| c.map(|b| b.to_vec())).map_err(|e| network(e, "terminated")) },
        )
    }
}

/// Cancels a chat: the `AbortController` half.
#[derive(Debug)]
pub struct AbortController(watch::Sender<bool>);

impl Default for AbortController {
    fn default() -> Self {
        Self::new()
    }
}

impl AbortController {
    pub fn new() -> Self {
        Self(watch::channel(false).0)
    }

    pub fn signal(&self) -> AbortSignal {
        AbortSignal(Some(self.0.subscribe()))
    }

    pub fn abort(&self) {
        self.0.send_replace(true);
    }
}

/// The `AbortSignal` half: cheap to clone, and a chat watches it through the
/// request and the whole stream.
#[derive(Debug, Clone, Default)]
pub struct AbortSignal(Option<watch::Receiver<bool>>);

impl AbortSignal {
    /// A signal that never fires.
    pub fn never() -> Self {
        Self(None)
    }

    pub fn aborted(&self) -> bool {
        self.0.as_ref().is_some_and(|rx| *rx.borrow())
    }

    /// Resolves once aborted; never, if the controller is dropped unaborted.
    pub async fn fired(&self) {
        if let Some(rx) = &self.0 {
            let mut rx = rx.clone();
            if rx.wait_for(|v| *v).await.is_ok() {
                return;
            }
        }
        std::future::pending::<()>().await;
    }
}
