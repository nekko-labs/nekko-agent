//! The engine's one OpenAI-compatible address (`127.0.0.1:11500/v1` by
//! default), in front of every loaded model server.
//!
//! Requests and replies pass through untouched in both directions (streaming
//! included), so tool calls and any field a model server adds later keep
//! working without this file learning about them. A client that hangs up
//! mid-generation drops the upstream connection, which stops the generation.
//!
//! A request for a model that is not running is handed to the [`Policy`] (the
//! daemon's model server, which knows the library, the saved settings and
//! whether load-on-demand is on); once it reports the model loaded, the
//! request goes through.
//!
//! A [`Meter`], when given, hears how fast each text reply decoded: the
//! `timings` llama-server ends a reply with (the body, or the last streamed
//! chunk), read from the tail of what already passed through, so the bytes
//! the client gets are not touched or held back.
//!
//! Decisions (`/v1/decisions`, `/v1/systemone`) are the one exception to
//! proxying: the decision model runs inside the daemon, so those requests are
//! answered by the [`Decisions`] service behind the same auth and CORS.

use crate::supervisor::{ActiveGuard, Kind, Supervisor};
use axum::Router;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use http_body::{Body as HttpBody, Frame, SizeHint};
use serde::Deserialize;
use serde_json::{Value, json};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use tokio::sync::oneshot;

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// What the router asks the engine's policy layer.
pub trait Policy: Send + Sync + 'static {
    /// Load `model` (for the image endpoint when `image`), or say why not as
    /// an HTTP status and a sentence.
    fn load(&self, model: String, image: bool) -> BoxFuture<Result<(), (u16, String)>>;
    /// The body of `GET /v1/models`.
    fn models(&self) -> BoxFuture<Result<Value, String>>;
    /// One row of it, or `None` for an unknown id.
    fn model(&self, id: String) -> BoxFuture<Result<Option<Value>, String>>;
}

/// The engine's decision model (Laya, run natively by `nekko-decide` in the daemon), served on
/// `POST /v1/decisions` (TypeSafe Jev's path) and `POST /v1/systemone` (Laya's `laya-serve`).
///
/// A trait rather than a dependency so this crate stays free of ONNX Runtime: the router only
/// moves JSON, and the daemon decides what answers it.
pub trait Decisions: Send + Sync + 'static {
    /// Answer a Jev-shaped body (`{model?, state, questions}`), or say why not as an HTTP
    /// status and a sentence (409 when no decision model is loaded).
    fn decide(&self, body: Value) -> BoxFuture<Result<Value, (u16, String)>>;
}

/// How fast one reply decoded, from llama-server's `timings`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DecodeSample {
    /// Tokens generated.
    pub predicted_n: f64,
    pub predicted_ms: f64,
    /// Prompt tokens processed (not counting the cached prefix).
    pub prompt_n: f64,
    /// Requests in flight on the same model when it finished, this one included:
    /// more than one shares the GPU, so its speed is not the model's.
    pub concurrent: usize,
}

/// Hears each text reply's decode speed. Called once per reply that ended
/// with `timings`, after its last byte went to the client; never for one the
/// client hung up on.
pub trait Meter: Send + Sync + 'static {
    fn decoded(&self, model_id: String, sample: DecodeSample);
}

/// The tail of a reply kept for its `timings`: llama-server's last chunk is well under this.
const METER_TAIL: usize = 8 * 1024;

/// A decision request is JSON text plus a 50,000-character state; 2 MB is `laya-serve`'s cap.
const DECISION_BODY_LIMIT: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServeConfig {
    pub port: u16,
    /// `127.0.0.1`, or `0.0.0.0` when the user chose to serve the network.
    #[serde(default = "loopback")]
    pub host: String,
    #[serde(default)]
    pub api_key: Option<String>,
    /// Browser origins allowed to call the endpoint; `*` for any.
    #[serde(default)]
    pub cors_origins: Vec<String>,
}

fn loopback() -> String {
    "127.0.0.1".into()
}

struct Running {
    config: ServeConfig,
    stop: oneshot::Sender<()>,
}

/// Starts and stops the listener; the supervisor and policy are shared.
pub struct EngineRouter {
    supervisor: Arc<Supervisor>,
    policy: Arc<dyn Policy>,
    decisions: Option<Arc<dyn Decisions>>,
    meter: Option<Arc<dyn Meter>>,
    running: Mutex<Option<Running>>,
}

#[derive(Clone)]
struct Shared {
    supervisor: Arc<Supervisor>,
    policy: Arc<dyn Policy>,
    decisions: Option<Arc<dyn Decisions>>,
    meter: Option<Arc<dyn Meter>>,
    config: Arc<ServeConfig>,
    http: hyper_util::client::legacy::Client<hyper_util::client::legacy::connect::HttpConnector, Body>,
}

impl EngineRouter {
    pub fn new(supervisor: Arc<Supervisor>, policy: Arc<dyn Policy>) -> Self {
        Self { supervisor, policy, decisions: None, meter: None, running: Mutex::new(None) }
    }

    /// Tell `meter` how fast each text reply decoded.
    pub fn with_meter(mut self, meter: Arc<dyn Meter>) -> Self {
        self.meter = Some(meter);
        self
    }

    /// Serve decisions from `decisions` as well. Without it the decision routes answer 409.
    pub fn with_decisions(mut self, decisions: Arc<dyn Decisions>) -> Self {
        self.decisions = Some(decisions);
        self
    }

    pub fn serving(&self) -> Option<ServeConfig> {
        self.running.lock().unwrap().as_ref().map(|r| r.config.clone())
    }

    /// Listen with this configuration. Already listening with the same one is
    /// a no-op, so a repeated "start" is harmless.
    pub async fn serve(&self, config: ServeConfig) -> Result<String, String> {
        if self.serving().as_ref() == Some(&config) {
            return Ok(format!("The engine is serving on port {}.", config.port));
        }
        // Re-serving (a new key or CORS list on the same port) waits for the
        // listener it just stopped to let go of the port, which happens on its
        // own task a moment later.
        let replacing = self.serving().is_some();
        self.stop();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        let listener = loop {
            match tokio::net::TcpListener::bind((config.host.as_str(), config.port)).await {
                Ok(l) => break l,
                Err(e)
                    if e.kind() == std::io::ErrorKind::AddrInUse
                        && replacing
                        && std::time::Instant::now() < deadline =>
                {
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
                Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
                    return Err(format!("Port {} is already in use. Pick another port for the engine.", config.port));
                }
                Err(e) => return Err(e.to_string()),
            }
        };
        // Port zero requests an OS-assigned listener without a reserve/release race.
        let mut config = config;
        config.port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let shared = Shared {
            supervisor: self.supervisor.clone(),
            policy: self.policy.clone(),
            decisions: self.decisions.clone(),
            meter: self.meter.clone(),
            config: Arc::new(config.clone()),
            http: hyper_util::client::legacy::Client::builder(hyper_util::rt::TokioExecutor::new()).build_http(),
        };
        let app = Router::new().fallback(handle).with_state(shared);
        let (tx, rx) = oneshot::channel();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = rx.await;
                })
                .await;
        });
        let port = config.port;
        *self.running.lock().unwrap() = Some(Running { config, stop: tx });
        Ok(format!("The engine is serving on port {port}."))
    }

    pub fn stop(&self) {
        if let Some(r) = self.running.lock().unwrap().take() {
            let _ = r.stop.send(());
        }
    }
}

fn error(status: StatusCode, message: impl Into<String>) -> Response {
    let body = json!({ "error": { "message": message.into(), "type": "invalid_request_error" } });
    (status, axum::Json(body)).into_response()
}

fn cors(headers: &mut HeaderMap, config: &ServeConfig, origin: Option<&str>) {
    let Some(origin) = origin else { return };
    let value = if config.cors_origins.iter().any(|o| o == "*") {
        HeaderValue::from_static("*")
    } else if config.cors_origins.iter().any(|o| o == origin) {
        match HeaderValue::from_str(origin) {
            Ok(v) => v,
            Err(_) => return,
        }
    } else {
        return;
    };
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("authorization, content-type, x-api-key"),
    );
    headers.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, POST, OPTIONS"));
}

/// A bearer token or an `x-api-key` header, as OpenAI-style clients send one or the other.
fn authorized(headers: &HeaderMap, key: &str) -> bool {
    let eq = |got: &str| got.len() == key.len() && got.bytes().zip(key.bytes()).fold(0u8, |a, (x, y)| a | (x ^ y)) == 0;
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim);
    let api_key = headers.get("x-api-key").and_then(|v| v.to_str().ok());
    bearer.is_some_and(eq) || api_key.is_some_and(eq)
}

const INFERENCE: &[&str] = &["chat/completions", "completions", "embeddings", "rerank", "infill", "images/generations"];

async fn handle(State(s): State<Shared>, req: Request) -> Response {
    let origin = req.headers().get(header::ORIGIN).and_then(|v| v.to_str().ok()).map(str::to_string);
    let mut res = route(s.clone(), req).await;
    cors(res.headers_mut(), &s.config, origin.as_deref());
    res
}

async fn route(s: Shared, req: Request) -> Response {
    if req.method() == Method::OPTIONS {
        return StatusCode::NO_CONTENT.into_response();
    }
    let path = req.uri().path().trim_end_matches('/').to_string();
    let path = if path.is_empty() { "/".to_string() } else { path };

    // Health is deliberately unauthenticated: it carries nothing, and something
    // has to be able to tell whether the port is ours without a key.
    if path == "/health" || path == "/" {
        return axum::Json(json!({ "status": "ok", "service": "nekko-agent-engine", "models": s.supervisor.len() }))
            .into_response();
    }
    if let Some(key) = s.config.api_key.as_deref().filter(|k| !k.is_empty())
        && !authorized(req.headers(), key)
    {
        return (
            StatusCode::UNAUTHORIZED,
            axum::Json(json!({ "error": { "message": "Invalid API key.", "type": "invalid_request_error" } })),
        )
            .into_response();
    }

    let bare = path.strip_prefix("/v1").unwrap_or(&path).to_string();
    if bare == "/decisions" || bare == "/systemone" {
        return decide(&s, req).await;
    }
    if bare == "/models" {
        return match s.policy.models().await {
            Ok(v) => axum::Json(v).into_response(),
            Err(e) => error(StatusCode::SERVICE_UNAVAILABLE, e),
        };
    }
    if let Some(id) = bare.strip_prefix("/models/") {
        let id = percent_decode(id);
        return match s.policy.model(id.clone()).await {
            Ok(Some(row)) => axum::Json(row).into_response(),
            Ok(None) => error(StatusCode::NOT_FOUND, format!("No model named {id}.")),
            Err(e) => error(StatusCode::SERVICE_UNAVAILABLE, e),
        };
    }
    let Some(endpoint) = INFERENCE.iter().find(|e| bare == format!("/{e}")) else {
        return error(StatusCode::NOT_FOUND, format!("Unknown route {path}."));
    };
    let image = *endpoint == "images/generations";

    let (parts, body) = req.into_parts();
    let body = match axum::body::to_bytes(body, 25 * 1024 * 1024).await {
        Ok(b) => b,
        Err(_) => return error(StatusCode::PAYLOAD_TOO_LARGE, "Request body too large."),
    };
    let requested = pick_model(&body);
    let child = match resolve(&s, requested, image).await {
        Ok(c) => c,
        Err((status, message)) => {
            return error(StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY), message);
        }
    };
    let guard = child.begin();
    let meter = s.meter.clone().filter(|_| matches!(*endpoint, "chat/completions" | "completions"));
    let res = proxy(&s, child.port, format!("/v1{bare}"), &parts.method, &parts.headers, body, guard).await;
    match meter {
        Some(meter) => {
            let (parts, body) = res.into_parts();
            Response::from_parts(parts, Body::new(Metered { inner: body, tail: Vec::new(), meter, child: Some(child) }))
        }
        None => res,
    }
}

/// A decision request, answered in-process by the loaded decision model rather than proxied.
async fn decide(s: &Shared, req: Request) -> Response {
    if req.method() != Method::POST {
        return error(StatusCode::METHOD_NOT_ALLOWED, "Decisions are POST requests.");
    }
    let body = match axum::body::to_bytes(req.into_body(), DECISION_BODY_LIMIT).await {
        Ok(b) => b,
        Err(_) => return error(StatusCode::PAYLOAD_TOO_LARGE, "Request body too large."),
    };
    let body: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return error(StatusCode::BAD_REQUEST, "The request body must be JSON."),
    };
    let Some(decisions) = s.decisions.as_ref() else {
        return error(StatusCode::CONFLICT, "No decision model is loaded.");
    };
    match decisions.decide(body).await {
        Ok(v) => axum::Json(v).into_response(),
        Err((status, message)) => {
            error(StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR), message)
        }
    }
}

/// Which running model serves this request, loading it through the policy
/// when it is not running yet.
async fn resolve(
    s: &Shared,
    requested: Option<String>,
    image: bool,
) -> Result<Arc<crate::supervisor::Child>, (u16, String)> {
    let wanted = if image { Kind::Image } else { Kind::Chat };
    let Some(id) = requested else {
        // No model named: the most recently used one of the right kind is the
        // least surprising answer.
        return s
            .supervisor
            .most_recent(wanted)
            .ok_or((409, "No model is loaded and the request named none.".to_string()));
    };
    if let Some(child) = s.supervisor.get(&id) {
        if child.kind != wanted {
            return Err((
                400,
                if image {
                    "This endpoint needs an image-generation model.".into()
                } else {
                    "Image models use /v1/images/generations, not text inference.".into()
                },
            ));
        }
        return Ok(child);
    }
    s.policy.load(id.clone(), image).await?;
    s.supervisor.get(&id).ok_or((503, format!("Couldn't load {id}.")))
}

async fn proxy(
    s: &Shared,
    port: u16,
    path: String,
    method: &Method,
    headers: &HeaderMap,
    body: Bytes,
    guard: ActiveGuard,
) -> Response {
    let uri: hyper::Uri = match format!("http://127.0.0.1:{port}{path}").parse() {
        Ok(u) => u,
        Err(e) => return error(StatusCode::BAD_GATEWAY, e.to_string()),
    };
    let mut builder = hyper::Request::builder().method(method.clone()).uri(uri);
    let content_type =
        headers.get(header::CONTENT_TYPE).cloned().unwrap_or(HeaderValue::from_static("application/json"));
    let accept = headers.get(header::ACCEPT).cloned().unwrap_or(HeaderValue::from_static("*/*"));
    builder = builder.header(header::CONTENT_TYPE, content_type).header(header::ACCEPT, accept);
    let upstream = match builder.body(Body::from(body)) {
        Ok(r) => r,
        Err(e) => return error(StatusCode::BAD_GATEWAY, e.to_string()),
    };
    let reply = match s.http.request(upstream).await {
        Ok(r) => r,
        Err(e) => return error(StatusCode::BAD_GATEWAY, format!("The model server stopped responding: {e}")),
    };
    let (mut parts, incoming) = reply.into_parts();
    for h in ["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te", "trailer"] {
        parts.headers.remove(h);
    }
    // The guard rides the body: the request counts as in flight until the
    // last byte is sent or the client goes away.
    Response::from_parts(parts, Body::new(Guarded { inner: incoming, _guard: guard }))
}

struct Guarded<B> {
    inner: B,
    _guard: ActiveGuard,
}

impl<B> HttpBody for Guarded<B>
where
    B: HttpBody<Data = Bytes> + Unpin,
{
    type Data = Bytes;
    type Error = B::Error;

    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, B::Error>>> {
        Pin::new(&mut self.inner).poll_frame(cx)
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

/// A reply on its way to the client, keeping its last few KB to read `timings` from at the end.
struct Metered {
    inner: Body,
    tail: Vec<u8>,
    meter: Arc<dyn Meter>,
    /// Taken when the reply ends, so it is reported once.
    child: Option<Arc<crate::supervisor::Child>>,
}

impl HttpBody for Metered {
    type Data = Bytes;
    type Error = axum::Error;

    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, axum::Error>>> {
        let polled = Pin::new(&mut self.inner).poll_frame(cx);
        match &polled {
            Poll::Ready(Some(Ok(frame))) => {
                if let Some(data) = frame.data_ref() {
                    let keep = data.len().min(METER_TAIL);
                    self.tail.extend_from_slice(&data[data.len() - keep..]);
                    if self.tail.len() > METER_TAIL {
                        let cut = self.tail.len() - METER_TAIL;
                        self.tail.drain(..cut);
                    }
                }
            }
            Poll::Ready(None) => {
                if let Some(child) = self.child.take()
                    && let Some(mut sample) = timings(&self.tail)
                {
                    sample.concurrent = child.active_requests();
                    self.meter.decoded(child.model_id.clone(), sample);
                }
            }
            _ => {}
        }
        polled
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

/// The last `"timings":{...}` in a reply's tail.
fn timings(tail: &[u8]) -> Option<DecodeSample> {
    const KEY: &[u8] = b"\"timings\":";
    let at = tail.windows(KEY.len()).rposition(|w| w == KEY)? + KEY.len();
    let t: Value = serde_json::Deserializer::from_slice(&tail[at..]).into_iter::<Value>().next()?.ok()?;
    let n = |k: &str| t.get(k).and_then(Value::as_f64);
    let sample = DecodeSample {
        predicted_n: n("predicted_n")?,
        predicted_ms: n("predicted_ms")?,
        prompt_n: n("prompt_n").unwrap_or(0.0),
        concurrent: 0,
    };
    (sample.predicted_n > 0.0 && sample.predicted_ms > 0.0).then_some(sample)
}

fn pick_model(body: &[u8]) -> Option<String> {
    let v: Value = serde_json::from_slice(body).ok()?;
    v.get("model").and_then(Value::as_str).filter(|m| !m.is_empty()).map(str::to_string)
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(b) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16)
        {
            out.push(b);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_model_from_a_body() {
        assert_eq!(pick_model(br#"{"model":"qwen","messages":[]}"#).as_deref(), Some("qwen"));
        assert_eq!(pick_model(br#"{"model":""}"#), None);
        assert_eq!(pick_model(b"not json"), None);
    }

    #[test]
    fn decodes_percent_escapes_in_model_ids() {
        assert_eq!(percent_decode("lmstudio%3Agemma"), "lmstudio:gemma");
        assert_eq!(percent_decode("plain"), "plain");
    }

    #[test]
    fn checks_the_key_exactly() {
        let mut h = HeaderMap::new();
        h.insert(header::AUTHORIZATION, HeaderValue::from_static("Bearer secret-key"));
        assert!(authorized(&h, "secret-key"));
        assert!(!authorized(&h, "secret-kez"));
        assert!(!authorized(&HeaderMap::new(), "secret-key"));
        let mut x = HeaderMap::new();
        x.insert("x-api-key", HeaderValue::from_static("secret-key"));
        assert!(authorized(&x, "secret-key"));
    }
}

#[cfg(test)]
mod meter_tests {
    use super::timings;

    #[test]
    fn reads_the_last_timings_in_a_tail() {
        let sse = br#"data: {"choices":[{"delta":{"content":"a \"timings\": in text"}}]}

data: {"choices":[{"finish_reason":"length","index":0,"delta":{}}],"object":"chat.completion.chunk","timings":{"cache_n":10,"prompt_n":4,"prompt_ms":14.2,"predicted_n":64,"predicted_ms":485.4,"predicted_per_second":129.8}}

data: [DONE]

"#;
        let s = timings(sse).unwrap();
        assert_eq!((s.predicted_n, s.predicted_ms, s.prompt_n), (64.0, 485.4, 4.0));
        let plain = br#"{"choices":[],"timings":{"prompt_n":14,"predicted_n":64,"predicted_ms":480.2}}"#;
        assert_eq!(timings(plain).unwrap().predicted_n, 64.0);
        assert!(timings(b"data: [DONE]").is_none());
        assert!(timings(br#"{"timings":{"predicted_n":0,"predicted_ms":0}}"#).is_none());
        // Cut off mid-object: no sample rather than a wrong one.
        assert!(timings(br#"{"timings":{"predicted_n":64,"predicted_m"#).is_none());
    }
}
