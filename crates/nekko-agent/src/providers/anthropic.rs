//! The Anthropic Messages API, streamed over SSE. A port of `anthropic.ts`.
//!
//! Subscription (OAuth) sign-in stays in the TS host: it refreshes the token
//! and passes it in as `config.api_key` with `auth: subscription`, and this
//! provider only has to send it the way the endpoint requires.

use super::Io;
use crate::claude::{
    Family, SamplingMemory, SamplingShape, anthropic_effort, claude_context_window, next_sampling_shape,
    parse_claude_model,
};
use crate::http::{HttpRequest, headers};
use crate::js;
use crate::sse::SseParser;
use crate::stream::{ChunkStream, DecodeClock, Sink, Stop, spawn};
use crate::types::*;
use serde_json::{Map, Value, json};
use std::sync::Arc;
use std::time::Duration;

/// The shipped Claude catalog, served when `GET /v1/models` can't be reached.
/// Newest first within a family, the previous generation included so a chat
/// pinned to it still has a name for it.
const CLAUDE_MODELS: &[(&str, &str)] = &[
    ("claude-opus-5-5", "Claude Opus 5.5"),
    ("claude-opus-5", "Claude Opus 5"),
    ("claude-opus-4-8", "Claude Opus 4.8"),
    ("claude-sonnet-5-5", "Claude Sonnet 5.5"),
    ("claude-sonnet-5", "Claude Sonnet 5"),
    ("claude-sonnet-4-6", "Claude Sonnet 4.6"),
    ("claude-fable-5-1", "Claude Fable 5.1"),
    ("claude-haiku-5-5", "Claude Haiku 5.5"),
    ("claude-haiku-4-5-20251001", "Claude Haiku 4.5"),
];

/// How long the catalog may take, body included, before the shipped list is
/// served instead. Opening a chat waits on this list, so a stalled connection
/// must not hold it for the transport's minutes-long idle limit.
const CATALOG_TIMEOUT: Duration = Duration::from_secs(5);

/// Picker order by family, as the shipped list has it. The API lists newest
/// release first, which would put a new Haiku above Opus; the sort is stable,
/// so newest-first holds within each family. Ids that aren't a known family go
/// last.
fn family_rank(id: &str) -> usize {
    match parse_claude_model(id).map(|c| c.family) {
        Some(Family::Opus) => 0,
        Some(Family::Sonnet) => 1,
        Some(Family::Fable) => 2,
        Some(Family::Mythos) => 3,
        Some(Family::Haiku) => 4,
        None => 5,
    }
}

/// Subscription requests ride the Claude Code public client: the endpoint
/// requires this beta flag and a first system block that is the Claude Code
/// identity line, per the token's terms of use.
const OAUTH_BETA: &str = "oauth-2025-04-20";
const CLAUDE_CODE_SYSTEM_PREFIX: &str = "You are Claude Code, Anthropic's official CLI for Claude.";

#[derive(Clone)]
pub struct AnthropicProvider {
    config: ProviderConfig,
    io: Io,
    sampling: Arc<SamplingMemory>,
}

impl AnthropicProvider {
    /// Learns sampling shapes into the process-wide memory, as the TS module does.
    pub fn new(config: ProviderConfig, io: Io) -> Self {
        Self::with_memory(config, io, SamplingMemory::global())
    }

    pub fn with_memory(config: ProviderConfig, io: Io, sampling: Arc<SamplingMemory>) -> Self {
        Self { config, io, sampling }
    }

    pub fn config(&self) -> &ProviderConfig {
        &self.config
    }

    fn headers(&self) -> Vec<(String, String)> {
        let key = self.config.api_key.as_deref().unwrap_or("");
        if self.config.subscription() {
            let bearer = format!("Bearer {key}");
            return headers(&[
                ("Content-Type", "application/json"),
                ("Authorization", &bearer),
                ("anthropic-version", "2023-06-01"),
                ("anthropic-beta", OAUTH_BETA),
            ]);
        }
        headers(&[("Content-Type", "application/json"), ("x-api-key", key), ("anthropic-version", "2023-06-01")])
    }

    /// Subscription tokens only work for requests that identify as Claude
    /// Code, so the system prompt becomes blocks with that prefix first.
    fn system_param(&self, system: Option<&str>) -> Option<Value> {
        if !self.config.subscription() {
            return system.map(|s| json!(s));
        }
        let mut blocks = vec![json!({ "type": "text", "text": CLAUDE_CODE_SYSTEM_PREFIX })];
        if let Some(s) = system.filter(|s| !s.is_empty()) {
            blocks.push(json!({ "type": "text", "text": s }));
        }
        Some(Value::Array(blocks))
    }

    /// The request `chat` sends with a given sampling shape.
    pub fn chat_request(&self, req: &ChatRequest, shape: SamplingShape) -> HttpRequest {
        let mut body = Map::new();
        body.insert("model".into(), json!(req.model));
        // Required here, so a chat with no cap of its own runs to the model's
        // ceiling; a 400 naming a lower one is learned in `run` and the
        // request goes again.
        body.insert("max_tokens".into(), json!(self.sampling.output_cap_for(&req.model, req.max_output_tokens)));
        body.insert("stream".into(), json!(true));
        match shape {
            SamplingShape::Effort => {
                let effort = anthropic_effort(&req.model, req.effort);
                body.insert("output_config".into(), json!({ "effort": effort.as_str() }));
            }
            SamplingShape::Temperature => {
                body.insert("temperature".into(), json!(req.temperature.unwrap_or(0.7)));
            }
            SamplingShape::Neither => {}
        }
        if let Some(system) = self.system_param(req.system.as_deref()) {
            body.insert("system".into(), system);
        }
        body.insert("messages".into(), Value::Array(to_anthropic_messages(req)));
        if let Some(tools) = &req.tools {
            let tools = tools
                .iter()
                .map(|t| json!({ "name": t.name, "description": t.description, "input_schema": t.parameters }))
                .collect();
            body.insert("tools".into(), Value::Array(tools));
        }
        if req.prompt_caching != Some(false) {
            super::prompt_caching::anthropic_prefix(&mut body);
        }
        HttpRequest::post(format!("{}/v1/messages", self.config.base_url), self.headers(), Value::Object(body))
    }

    /// The shape the next request for `model` opens with.
    pub fn first_shape(&self, model: &str) -> SamplingShape {
        self.sampling.first_shape(model)
    }

    pub fn chat(&self, req: ChatRequest) -> ChunkStream {
        let me = self.clone();
        spawn(req.signal.clone(), move |sink| async move { me.run(req, sink).await })
    }

    async fn run(self, req: ChatRequest, sink: Sink) -> Result<(), Stop> {
        // A 400 about the sampling parameter means our guess about this model
        // was wrong, not that the turn should fail. Work through the shapes
        // until one is accepted (a model that rejects both named knobs still
        // gets its turn with neither), then remember the one that worked.
        let mut shape = self.sampling.first_shape(&req.model);
        let mut tried = Vec::new();
        let mut res = loop {
            tried.push(shape);
            // Not wrapped in friendlyError on this provider: a fetch failure
            // reaches the user as the runtime worded it.
            let mut res = sink
                .send(&*self.io.transport, &self.chat_request(&req, shape))
                .await?
                .map_err(|e| ProviderError::new(e.message))?;
            if res.ok() {
                break res;
            }
            let text = sink.text(&mut res).await?;
            // Our ceiling for this model was too high: the API names the real
            // one. Keep it and go again with the same shape.
            if let Some(limit) = crate::claude::output_limit_error(res.status, &text)
                && limit < self.sampling.output_cap_for(&req.model, req.max_output_tokens)
            {
                self.sampling.learn_output_limit(&req.model, limit);
                tried.pop();
                continue;
            }
            let next =
                crate::claude::sampling_param_error(res.status, &text).and_then(|_| next_sampling_shape(shape, &tried));
            match next {
                Some(n) => shape = n,
                None => {
                    let message = format!("anthropic {}: {}", res.status, js::slice16(&text, 200));
                    return Err(ProviderError::http(res.status, message).into());
                }
            }
        };
        self.sampling.learn(&req.model, shape);
        if let Some(hook) = &req.on_headers {
            hook(&res.headers);
        }

        let mut parser = EventParser::new(DecodeClock::new(self.io.clock.clone()));
        let mut sse = SseParser::default();
        while let Some(bytes) = sink.read(&mut res).await? {
            let batch = sse.feed(&bytes);
            for data in &batch.data {
                let (chunks, end) = parser.event(data);
                for chunk in chunks {
                    sink.emit(chunk).await?;
                }
                match end {
                    Some(End::Stop) => return sink.emit(ProviderChunk::Done).await,
                    Some(End::Error(e)) => return Err(e.into()),
                    None => {}
                }
            }
            if batch.done {
                break;
            }
        }
        sink.emit(ProviderChunk::Done).await
    }

    /// The live catalog: `GET {base}/v1/models`, every model this key or
    /// subscription can call, including ones released after this build. One
    /// page of up to 1000 holds the whole list. None on any failure, or after
    /// `CATALOG_TIMEOUT`, so the caller falls back to the shipped list.
    async fn fetch_catalog(&self) -> Option<Vec<ModelInfo>> {
        self.config.api_key.as_deref().filter(|k| !k.is_empty())?;
        let req = HttpRequest::get(format!("{}/v1/models?limit=1000", self.config.base_url), self.headers());
        let fetch = async {
            let mut res = self.io.transport.send(&req).await.ok()?;
            if !res.ok() {
                return None;
            }
            Some(res.text().await)
        };
        let text = tokio::time::timeout(CATALOG_TIMEOUT, fetch).await.ok()??;

        let json: Value = serde_json::from_str(&text).ok()?;
        let rows = json.get("data").and_then(Value::as_array)?;
        let mut models: Vec<ModelInfo> = rows
            .iter()
            .filter_map(|m| {
                let id = m.get("id").and_then(Value::as_str).filter(|id| !id.is_empty())?;
                let name = m.get("display_name").and_then(Value::as_str).filter(|n| !n.is_empty()).unwrap_or(id);
                let api_window = m.get("max_input_tokens").and_then(Value::as_u64).filter(|n| *n > 0);
                Some(ModelInfo {
                    id: id.to_string(),
                    provider_id: self.config.id.clone(),
                    name: name.to_string(),
                    context_length: Some(api_window.or_else(|| claude_context_window(id)).unwrap_or(200_000)),
                    ..Default::default()
                })
            })
            .collect();
        models.sort_by_key(|m| family_rank(&m.id));
        (!models.is_empty()).then_some(models)
    }

    /// `test()`: no request, only whether there is a credential to send.
    pub async fn test(&self) -> TestResult {
        let has_key = self.config.api_key.as_deref().is_some_and(|k| !k.is_empty());
        if self.config.subscription() {
            return if has_key {
                TestResult::ok("Signed in with a Claude subscription")
            } else {
                TestResult::fail("Not signed in. Sign in with Claude in the provider settings.")
            };
        }
        if !has_key {
            return TestResult::fail("Missing API key");
        }
        TestResult::ok("API key set")
    }

    pub async fn list_models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        if let Some(models) = self.fetch_catalog().await {
            return Ok(models);
        }

        Ok(CLAUDE_MODELS
            .iter()
            .map(|(id, name)| ModelInfo {
                id: id.to_string(),
                provider_id: self.config.id.clone(),
                name: name.to_string(),
                context_length: Some(claude_context_window(id).unwrap_or(200_000)),
                ..Default::default()
            })
            .collect())
    }
}

/// `data:[^;]+;base64,(.+)` split into media type and payload, or `None`
/// when the URL is not a base64 data URL (then the whole URL is sent as data).
fn split_data_url(url: &str) -> Option<(&str, &str)> {
    let rest = url.strip_prefix("data:")?;
    let semi = rest.find(';')?;
    let (media, after) = (&rest[..semi], &rest[semi..]);
    let data = after.strip_prefix(";base64,")?;
    // `(.+)$`: at least one character, and `.` never matches a line terminator.
    if media.is_empty() || data.is_empty() || data.contains(js::is_line_terminator) {
        return None;
    }
    Some((media, data))
}

fn to_anthropic_messages(req: &ChatRequest) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    // Two user turns in a row (tool results, then a message the user sent
    // while the tools ran) are one turn to the API.
    fn push(out: &mut Vec<Value>, msg: Value) {
        if let Some(last) = out.last_mut()
            && last["role"] == "user"
            && msg["role"] == "user"
        {
            let blocks = |v: &Value| -> Vec<Value> {
                match v {
                    Value::String(text) => vec![json!({ "type": "text", "text": text })],
                    Value::Array(items) => items.clone(),
                    other => vec![other.clone()],
                }
            };
            let mut merged = blocks(&last["content"]);
            merged.extend(blocks(&msg["content"]));
            last["content"] = Value::Array(merged);
            return;
        }
        out.push(msg);
    }
    for m in &crate::types::with_tool_images(&req.messages) {
        if let (Role::Tool, Some(r)) = (m.role, &m.tool_result) {
            push(
                &mut out,
                json!({
                    "role": "user",
                    "content": [{ "type": "tool_result", "tool_use_id": r.tool_call_id, "content": r.output }],
                }),
            );
        } else if let (Role::Assistant, Some(calls)) = (m.role, m.calls()) {
            let mut content = Vec::new();
            if !m.content.is_empty() {
                content.push(json!({ "type": "text", "text": m.content }));
            }
            for c in calls {
                content.push(json!({ "type": "tool_use", "id": c.id, "name": c.name, "input": c.input }));
            }
            push(&mut out, json!({ "role": "assistant", "content": content }));
        } else if matches!(m.role, Role::User | Role::Assistant) {
            let content = match m.user_images() {
                Some(images) => {
                    let mut parts = vec![json!({ "type": "text", "text": m.content })];
                    parts.extend(images.iter().map(|url| {
                        let (media, data) = split_data_url(url).unwrap_or(("application/octet-stream", url));
                        json!({ "type": "image", "source": { "type": "base64", "media_type": media, "data": data } })
                    }));
                    Value::Array(parts)
                }
                None => json!(m.content),
            };
            push(&mut out, json!({ "role": m.role, "content": content }));
        }
    }
    out
}

/// How an event ends the stream early.
enum End {
    Stop,
    Error(ProviderError),
}

struct OpenTool {
    id: String,
    name: String,
    json: String,
}

/// Turns Messages API stream events into chunks.
struct EventParser {
    tool: Option<OpenTool>,
    input_tokens: u64,
    cache_read_tokens: Option<u64>,
    cache_write_tokens: Option<u64>,
    /// From the first generated token to the `message_delta` that reports
    /// the output count.
    decode: DecodeClock,
}

impl EventParser {
    fn new(decode: DecodeClock) -> Self {
        Self { tool: None, input_tokens: 0, cache_read_tokens: None, cache_write_tokens: None, decode }
    }

    fn event(&mut self, data: &str) -> (Vec<ProviderChunk>, Option<End>) {
        let mut out = Vec::new();
        let Ok(ev) = serde_json::from_str::<Value>(data) else { return (out, None) };
        let str_of = |v: Option<&Value>| v.map(js::display).unwrap_or_default();
        match ev.get("type").and_then(Value::as_str) {
            // An accepted stream can still fail, and says so in-band. Without
            // this the turn just stopped mid-sentence with no reason given.
            Some("error") => {
                let message = js::coalesce(ev.pointer("/error/message"), None)
                    .map(js::display)
                    .unwrap_or_else(|| "unknown error".into());
                return (out, Some(End::Error(ProviderError::new(format!("anthropic stream error: {message}")))));
            }
            Some("message_start") => {
                self.cache_read_tokens =
                    ev.pointer("/message/usage/cache_read_input_tokens").and_then(super::prompt_caching::token_count);
                self.cache_write_tokens = ev
                    .pointer("/message/usage/cache_creation_input_tokens")
                    .and_then(super::prompt_caching::token_count);
                self.input_tokens = ev.pointer("/message/usage/input_tokens").and_then(Value::as_u64).unwrap_or(0);
            }
            Some("content_block_start") => {
                if ev.pointer("/content_block/type").and_then(Value::as_str) == Some("tool_use") {
                    self.tool = Some(OpenTool {
                        id: str_of(ev.pointer("/content_block/id")),
                        name: str_of(ev.pointer("/content_block/name")),
                        json: String::new(),
                    });
                }
            }
            Some("content_block_delta") => {
                // Tool arguments (and thinking) are generated tokens too, so
                // they start the clock even though nothing surfaces yet.
                self.decode.mark();
                match ev.pointer("/delta/type").and_then(Value::as_str) {
                    Some("text_delta") => out.push(ProviderChunk::Text { delta: str_of(ev.pointer("/delta/text")) }),
                    Some("input_json_delta") => {
                        if let Some(tool) = &mut self.tool {
                            // `json += partial_json`, `undefined` and all.
                            let part = ev.pointer("/delta/partial_json");
                            tool.json.push_str(&part.map(js::display).unwrap_or_else(|| "undefined".into()));
                        }
                    }
                    _ => {}
                }
            }
            Some("content_block_stop") => {
                if let Some(t) = self.tool.take() {
                    out.push(ProviderChunk::ToolCall {
                        call: ToolCall { id: t.id, name: t.name, input: js::safe_parse(&t.json) },
                    });
                }
            }
            Some("message_delta") => {
                if let Some(output) = ev.pointer("/usage/output_tokens").filter(|v| !v.is_null()) {
                    self.decode.stop();
                    out.push(ProviderChunk::Usage {
                        input_tokens: self.input_tokens,
                        cache_read_tokens: self.cache_read_tokens,
                        cache_write_tokens: self.cache_write_tokens,
                        output_tokens: output.as_u64().unwrap_or(0),
                        output_ms: self.decode.elapsed(),
                    });
                }
            }
            Some("message_stop") => return (out, Some(End::Stop)),
            _ => {}
        }
        (out, None)
    }
}
