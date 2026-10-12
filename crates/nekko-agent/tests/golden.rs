//! The Rust providers against the TS ones.
//!
//! `golden/requests.json`, `streams.json` and `models.json` are written by
//! the real TS providers (packages/core/src/providers/providers.golden.test.ts,
//! which also fails if they go stale), from the inputs in `golden/*-cases.json`
//! and `providers.json` (make-fixtures.mjs). Each provider here runs against a
//! fake transport that records what it sends and plays back the same
//! responses, and must match exactly:
//!
//! - requests: method, URL, headers in order, and the body as
//!   `JSON.stringify` prints it (key order and number format included);
//! - streams: every chunk in order, the error a chat ends on, every request
//!   it made on the way (the Anthropic retry ladder), and the headers handed
//!   to `on_headers`;
//! - model lists: the same models and fields (key order aside: the TS
//!   providers build them with a different order per kind and nothing reads
//!   the order).
//!
//! Time is frozen on both sides, so a decode clock reports exactly 1 ms once
//! started and nothing if never started.

use nekko_agent::claude::SamplingMemory;
use nekko_agent::http::{BoxFuture, HttpRequest, HttpResponse, ResponseBody, Transport, TransportError};
use nekko_agent::js::stringify;
use nekko_agent::providers::openai_compat::{OpenAiCompatProvider, ParamMemory};
use nekko_agent::stream::Clock;
use nekko_agent::*;
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

fn golden() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("golden")
}

fn read(name: &str) -> Value {
    let raw = std::fs::read_to_string(golden().join(name)).unwrap_or_else(|e| panic!("{name}: {e}"));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("{name}: {e}"))
}

// ------------------------------------------------------------ fake transport

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

/// A fixture response split into network chunks, as the TS recorder splits it.
fn parts(r: &Value) -> Vec<Vec<u8>> {
    if let Some(chunks) = r.get("chunks").and_then(Value::as_array) {
        return chunks.iter().map(|c| c.as_str().unwrap().as_bytes().to_vec()).collect();
    }
    let bytes = match r.get("bodyHex").and_then(Value::as_str) {
        Some(h) => unhex(h),
        None => r.get("body").and_then(Value::as_str).unwrap_or("").as_bytes().to_vec(),
    };
    let mut cuts: Vec<usize> = r
        .get("cuts")
        .and_then(Value::as_array)
        .map(|c| c.iter().filter_map(Value::as_u64).map(|c| c as usize).collect())
        .unwrap_or_default();
    cuts.retain(|c| *c > 0 && *c < bytes.len());
    cuts.sort_unstable();
    cuts.dedup();
    let mut out = Vec::new();
    let mut at = 0;
    for c in cuts.into_iter().chain([bytes.len()]) {
        out.push(bytes[at..c].to_vec());
        at = c;
    }
    out.retain(|p| !p.is_empty());
    out
}

struct FakeBody(VecDeque<Vec<u8>>);

impl ResponseBody for FakeBody {
    fn chunk(&mut self) -> BoxFuture<'_, Result<Option<Vec<u8>>, TransportError>> {
        let next = self.0.pop_front();
        Box::pin(async move { Ok(next) })
    }
}

enum Answers {
    Queue(Mutex<VecDeque<Value>>),
    ByUrl(Map<String, Value>),
}

struct FakeTransport {
    answers: Answers,
    sent: Mutex<Vec<HttpRequest>>,
}

impl FakeTransport {
    fn queue(responses: Vec<Value>) -> Arc<Self> {
        Arc::new(Self { answers: Answers::Queue(Mutex::new(responses.into())), sent: Mutex::default() })
    }

    fn by_url(responses: Map<String, Value>) -> Arc<Self> {
        Arc::new(Self { answers: Answers::ByUrl(responses), sent: Mutex::default() })
    }

    fn sent(&self) -> Vec<HttpRequest> {
        self.sent.lock().unwrap().clone()
    }

    fn unread(&self) -> usize {
        match &self.answers {
            Answers::Queue(q) => q.lock().unwrap().len(),
            Answers::ByUrl(_) => 0,
        }
    }
}

impl Transport for FakeTransport {
    fn send<'a>(&'a self, req: &'a HttpRequest) -> BoxFuture<'a, Result<HttpResponse, TransportError>> {
        self.sent.lock().unwrap().push(req.clone());
        let answer = match &self.answers {
            Answers::Queue(q) => q.lock().unwrap().pop_front(),
            Answers::ByUrl(m) => m.get(&req.url).cloned(),
        };
        Box::pin(async move {
            let Some(r) = answer else { return Err(TransportError::new("fetch failed")) };
            if let Some(e) = r.get("networkError").and_then(Value::as_str) {
                return Err(TransportError::new(e));
            }
            let headers = r
                .get("headers")
                .and_then(Value::as_object)
                .map(|h| h.iter().map(|(k, v)| (k.to_ascii_lowercase(), v.as_str().unwrap().to_string())).collect())
                .unwrap_or_default();
            Ok(HttpResponse {
                status: r.get("status").and_then(Value::as_u64).unwrap_or(200) as u16,
                headers,
                body: Box::new(FakeBody(parts(&r).into())),
            })
        })
    }
}

fn frozen() -> Clock {
    Arc::new(|| 1_790_000_000_000)
}

/// A provider on the fake wire, with its own learned-request memory (the TS
/// test resets the module-level ones before every case).
fn provider(config: &Value, transport: Arc<FakeTransport>) -> AnyProvider {
    let config: ProviderConfig = serde_json::from_value(config.clone()).unwrap();
    let io = Io { transport, clock: frozen() };
    match config.kind {
        ProviderKind::Anthropic => {
            AnyProvider::Anthropic(AnthropicProvider::with_memory(config, io, Arc::new(SamplingMemory::default())))
        }
        ProviderKind::Openai
        | ProviderKind::Openrouter
        | ProviderKind::Lmstudio
        | ProviderKind::Vllm
        | ProviderKind::Llamacpp
        | ProviderKind::OpenaiCompat => {
            AnyProvider::OpenAiCompat(OpenAiCompatProvider::with_memory(config, io, Arc::new(ParamMemory::default())))
        }
        _ => create_provider_with(config, io),
    }
}

// ----------------------------------------------------------------- compare

fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.char_indices().all(|(i, c)| if [8, 13, 18, 23].contains(&i) { c == '-' } else { c.is_ascii_hexdigit() })
}

/// A sent request in the recorder's shape, as a string that shows every
/// difference: header order, key order, number format.
fn recorded(req: &HttpRequest) -> String {
    let headers: Vec<Value> = req
        .headers
        .iter()
        .map(|(k, v)| {
            if k == "session_id" {
                assert!(is_uuid(v), "session_id {v} is not a UUID");
                json!([k, "<session>"])
            } else {
                json!([k, v])
            }
        })
        .collect();
    let body = req.body.as_ref().map(stringify).unwrap_or_else(|| "null".into());
    format!("{} {}\nheaders {}\nbody {body}", req.method, req.url, stringify(&Value::Array(headers)))
}

fn expected_request(v: &Value) -> String {
    let headers: Vec<Value> = v["headers"].as_object().unwrap().iter().map(|(k, v)| json!([k, v])).collect();
    format!(
        "{} {}\nheaders {}\nbody {}",
        v["method"].as_str().unwrap(),
        v["url"].as_str().unwrap(),
        stringify(&Value::Array(headers)),
        stringify(&v["body"])
    )
}

fn chunk_json(item: &Result<ProviderChunk, ProviderError>) -> String {
    match item {
        Ok(c) => stringify(&serde_json::to_value(c).unwrap()),
        Err(e) => stringify(&json!({ "type": "error", "message": e.message })),
    }
}

/// Numbers as numbers and objects unordered: equality as JSON means it.
fn canon(v: &Value) -> Value {
    match v {
        Value::Number(n) => json!(n.as_f64().unwrap()),
        Value::Array(a) => Value::Array(a.iter().map(canon).collect()),
        Value::Object(o) => {
            let sorted: BTreeMap<_, _> = o.iter().map(|(k, v)| (k.clone(), canon(v))).collect();
            Value::Object(sorted.into_iter().collect())
        }
        v => v.clone(),
    }
}

async fn run_chat(p: &AnyProvider, req: ChatRequest) -> Vec<Result<ProviderChunk, ProviderError>> {
    let mut stream = p.chat(req);
    let mut out = Vec::new();
    while let Some(item) = stream.next().await {
        out.push(item);
    }
    out
}

// ------------------------------------------------------------------- tests

#[tokio::test]
async fn every_request_is_built_exactly_as_the_ts_provider_builds_it() {
    let providers = read("providers.json");
    let cases = read("request-cases.json");
    let expected = read("requests.json");
    let mut count = 0;
    for p in cases["providers"].as_array().unwrap() {
        let p = p.as_str().unwrap();
        for (name, req) in cases["requests"].as_object().unwrap() {
            let transport = FakeTransport::queue(vec![json!({ "chunks": [] })]);
            let provider = provider(&providers[p], transport.clone());
            let req: ChatRequest = serde_json::from_value(req.clone()).unwrap();
            let chunks = run_chat(&provider, req).await;
            assert_eq!(chunks, vec![Ok(ProviderChunk::Done)], "{p}/{name}");
            let sent = transport.sent();
            assert_eq!(sent.len(), 1, "{p}/{name}");
            assert_eq!(recorded(&sent[0]), expected_request(&expected[p][name]), "{p}/{name}");
            count += 1;
        }
    }
    assert!(count >= 200, "the request golden set is too small to mean anything ({count})");
}

#[tokio::test]
async fn every_stream_yields_exactly_the_chunks_the_ts_provider_yields() {
    let providers = read("providers.json");
    let requests = read("request-cases.json")["requests"].clone();
    let expected = read("streams.json");
    let cases = read("stream-cases.json");
    let cases = cases.as_array().unwrap();
    assert!(cases.len() >= 50, "the stream golden set is too small to mean anything");
    for c in cases {
        let name = c["name"].as_str().unwrap();
        let want = &expected[name];
        let transport = FakeTransport::queue(c["responses"].as_array().unwrap().clone());
        let provider = provider(&providers[c["provider"].as_str().unwrap()], transport.clone());
        let seen: Arc<Mutex<Vec<Headers>>> = Arc::default();
        let req_name = c.get("request").and_then(Value::as_str).unwrap_or("minimal");
        let mut chats = Vec::new();
        for _ in 0..c.get("chats").and_then(Value::as_u64).unwrap_or(1) {
            let mut req: ChatRequest = serde_json::from_value(requests[req_name].clone()).unwrap();
            let seen = seen.clone();
            req.on_headers = Some(Arc::new(move |h: &Headers| seen.lock().unwrap().push(h.clone())));
            chats.push(run_chat(&provider, req).await.iter().map(chunk_json).collect::<Vec<_>>());
        }
        let want_chats: Vec<Vec<String>> = want["chunks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|chat| chat.as_array().unwrap().iter().map(stringify).collect())
            .collect();
        assert_eq!(chats, want_chats, "chunks of {name}");
        assert_eq!(transport.unread(), 0, "{name} left responses unread");

        let sent: Vec<String> = transport.sent().iter().map(recorded).collect();
        let want_sent: Vec<String> = want["requests"].as_array().unwrap().iter().map(expected_request).collect();
        assert_eq!(sent, want_sent, "requests of {name}");

        let mut got_headers: Vec<Vec<(String, String)>> = seen.lock().unwrap().clone();
        for h in &mut got_headers {
            h.sort();
        }
        let want_headers: Vec<Vec<(String, String)>> = want["onHeaders"]
            .as_array()
            .unwrap()
            .iter()
            .map(|h| {
                let mut h: Vec<_> =
                    h.as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string())).collect();
                h.sort();
                h
            })
            .collect();
        assert_eq!(got_headers, want_headers, "on_headers of {name}");
    }
}

#[tokio::test]
async fn every_model_list_maps_exactly_as_the_ts_provider_maps_it() {
    let providers = read("providers.json");
    let expected = read("models.json");
    let cases = read("model-cases.json");
    let cases = cases.as_array().unwrap();
    assert!(cases.len() >= 15, "the model golden set is too small to mean anything");
    for c in cases {
        let name = c["name"].as_str().unwrap();
        let want = &expected[name];
        let transport = FakeTransport::by_url(c["responses"].as_object().unwrap().clone());
        let provider = provider(&providers[c["provider"].as_str().unwrap()], transport.clone());
        let result = provider.list_models().await;
        let sent: Vec<String> = transport.sent().iter().map(recorded).collect();
        let want_sent: Vec<String> = want["requests"].as_array().unwrap().iter().map(expected_request).collect();
        assert_eq!(sent, want_sent, "requests of {name}");
        match (result, want.get("models"), want.get("error")) {
            (Ok(models), Some(w), None) => {
                assert_eq!(canon(&serde_json::to_value(&models).unwrap()), canon(w), "models of {name}");
            }
            (Err(e), None, Some(w)) => assert_eq!(e.message, w.as_str().unwrap(), "error of {name}"),
            (got, _, _) => panic!("{name}: got {got:?}, want {want}"),
        }
    }
}

#[tokio::test]
async fn every_connection_test_answers_exactly_as_the_ts_provider_does() {
    let providers = read("providers.json");
    let expected = read("tests.json");
    let cases = read("test-cases.json");
    let cases = cases.as_array().unwrap();
    assert_eq!(cases.len(), expected.as_object().unwrap().len(), "tests.json is stale");
    for c in cases {
        let name = c["name"].as_str().unwrap();
        let want = &expected[name];
        let mut config = providers[c["provider"].as_str().unwrap()].clone();
        for (k, v) in c.get("patch").and_then(Value::as_object).cloned().unwrap_or_default() {
            config[k] = v;
        }
        let transport = FakeTransport::by_url(c["responses"].as_object().unwrap().clone());
        let result = provider(&config, transport.clone()).test().await;
        let sent: Vec<String> = transport.sent().iter().map(recorded).collect();
        let want_sent: Vec<String> = want["requests"].as_array().unwrap().iter().map(expected_request).collect();
        assert_eq!(sent, want_sent, "requests of {name}");
        assert_eq!(serde_json::to_value(&result).unwrap(), want["result"], "result of {name}");
    }
}

/// Everything in the golden set is exercised, so a case added on the TS side
/// cannot be silently skipped here.
#[test]
fn the_golden_outputs_cover_every_input() {
    let cases = read("stream-cases.json");
    let names: Vec<&str> = cases.as_array().unwrap().iter().map(|c| c["name"].as_str().unwrap()).collect();
    let streams = read("streams.json");
    assert_eq!(streams.as_object().unwrap().keys().map(String::as_str).collect::<Vec<_>>(), names);
    let requests = read("requests.json");
    let rc = read("request-cases.json");
    let per: HashMap<&str, usize> =
        requests.as_object().unwrap().iter().map(|(k, v)| (k.as_str(), v.as_object().unwrap().len())).collect();
    for p in rc["providers"].as_array().unwrap() {
        assert_eq!(per[p.as_str().unwrap()], rc["requests"].as_object().unwrap().len());
    }
}
