//! The Anthropic Messages API, streamed over SSE. A port of `anthropic.ts`.
//!
//! Only an API key is ever sent. A provider saved with `auth: subscription`
//! (a Claude plan sign-in from an older build) is refused with
//! `CLAUDE_PLAN_REMOVED`: Anthropic does not let third-party apps send
//! requests on Claude plan credentials.

use super::{CATALOG_TIMEOUT, Io};
use crate::claude::{
    Family, SamplingMemory, SamplingShape, anthropic_effort, claude_context_window, next_sampling_shape,
    parse_claude_model,
};
use crate::http::{HttpRequest, headers};
use crate::js;
use crate::sse::SseParser;
use crate::stream::{ChunkStream, DecodeClock, Sink, Stop, spawn};
use crate::types::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::io::Cursor;
use std::sync::Arc;

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

/// What Claude in Amazon Bedrock serves on its Messages endpoint. It has no
/// Models API, so this list is the catalog; ids carry Bedrock's provider prefix.
const BEDROCK_MODELS: &[(&str, &str)] = &[
    ("anthropic.claude-opus-5-5", "Claude Opus 5.5"),
    ("anthropic.claude-opus-5", "Claude Opus 5"),
    ("anthropic.claude-opus-4-8", "Claude Opus 4.8"),
    ("anthropic.claude-opus-4-7", "Claude Opus 4.7"),
    ("anthropic.claude-sonnet-5-5", "Claude Sonnet 5.5"),
    ("anthropic.claude-sonnet-5", "Claude Sonnet 5"),
    ("anthropic.claude-fable-5-1", "Claude Fable 5.1"),
    ("anthropic.claude-fable-5", "Claude Fable 5"),
    ("anthropic.claude-haiku-5-5", "Claude Haiku 5.5"),
    ("anthropic.claude-haiku-4-5", "Claude Haiku 4.5"),
];

/// What Vertex AI serves. Current models use the bare Claude id there; older
/// dated snapshots take an `@` before the date.
const VERTEX_MODELS: &[(&str, &str)] = &[
    ("claude-opus-5-5", "Claude Opus 5.5"),
    ("claude-opus-5", "Claude Opus 5"),
    ("claude-opus-4-8", "Claude Opus 4.8"),
    ("claude-sonnet-5-5", "Claude Sonnet 5.5"),
    ("claude-sonnet-5", "Claude Sonnet 5"),
    ("claude-sonnet-4-6", "Claude Sonnet 4.6"),
    ("claude-fable-5-1", "Claude Fable 5.1"),
    ("claude-haiku-5-5", "Claude Haiku 5.5"),
    ("claude-haiku-4-5@20251001", "Claude Haiku 4.5"),
];

/// Foundry's default deployment names, which are the model ids. A custom
/// deployment name is typed into the picker like any unlisted model.
const FOUNDRY_MODELS: &[(&str, &str)] = &[
    ("claude-opus-5-5", "Claude Opus 5.5"),
    ("claude-opus-5", "Claude Opus 5"),
    ("claude-opus-4-8", "Claude Opus 4.8"),
    ("claude-sonnet-5-5", "Claude Sonnet 5.5"),
    ("claude-sonnet-5", "Claude Sonnet 5"),
    ("claude-fable-5-1", "Claude Fable 5.1"),
    ("claude-haiku-5-5", "Claude Haiku 5.5"),
    ("claude-haiku-4-5", "Claude Haiku 4.5"),
];

/// Vertex AI takes the API version in the body rather than as a header.
const VERTEX_VERSION: &str = "vertex-2023-10-16";

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

/// What a provider saved with `auth: subscription` answers with.
pub const CLAUDE_PLAN_REMOVED: &str = "Claude plan sign-in is no longer available in Nekko Agent. Add an Anthropic API key to this provider, or choose Claude, then Subscription, to use your plan through Claude Code.";

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
        if self.config.vertex() {
            // A Google access token; the version rides in the body.
            let bearer = format!("Bearer {key}");
            return headers(&[("Content-Type", "application/json"), ("Authorization", &bearer)]);
        }
        let mut out =
            headers(&[("Content-Type", "application/json"), ("x-api-key", key), ("anthropic-version", "2023-06-01")]);
        if let Some(workspace) = self.workspace_id() {
            out.push(("anthropic-workspace-id".into(), workspace.into()));
        }
        out
    }

    /// The workspace an organization-level key bills to, when one is set.
    fn workspace_id(&self) -> Option<&str> {
        self.config.workspace_id.as_deref().map(js::trim).filter(|w| !w.is_empty())
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
        if let Some(system) = &req.system {
            body.insert("system".into(), json!(system));
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
        if self.config.vertex() {
            // The model is in the URL on Vertex AI, and the version in the body.
            body.shift_remove("model");
            body.insert("anthropic_version".into(), json!(VERTEX_VERSION));
            let url = format!("{}/publishers/anthropic/models/{}:streamRawPredict", self.config.base_url, req.model);
            return HttpRequest::post(url, self.headers(), Value::Object(body));
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
        if self.config.subscription() {
            return Err(ProviderError::new(CLAUDE_PLAN_REMOVED).into());
        }
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
                    let message = match workspace_error(res.status, &text) {
                        Some(hint) => hint.to_string(),
                        None => format!("anthropic {}: {}", res.status, js::slice16(&text, 200)),
                    };
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

    /// The live catalog: `GET {base}/v1/models`, every model this key can
    /// call, including ones released after this build. One page of up to 1000
    /// holds the whole list. None on any failure, or after `CATALOG_TIMEOUT`,
    /// so the caller falls back to the shipped list.
    async fn fetch_catalog(&self) -> Option<Vec<ModelInfo>> {
        self.config.api_key.as_deref().filter(|k| !k.is_empty() && !self.config.subscription())?;
        if self.config.cloud_platform() {
            return None;
        }
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
            return TestResult::fail(CLAUDE_PLAN_REMOVED);
        }
        if self.config.bedrock() {
            return if has_key {
                TestResult::ok("Bedrock token set")
            } else {
                TestResult::fail("Missing Bedrock bearer token")
            };
        }
        if self.config.vertex() {
            // The token is fetched from the user's Google credentials before this runs.
            return if has_key {
                TestResult::ok("Google Cloud credentials found")
            } else {
                TestResult::fail("No Google Cloud credentials. Run `gcloud auth application-default login`.")
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

        let shipped = match self.config.kind {
            ProviderKind::Bedrock => BEDROCK_MODELS,
            ProviderKind::Vertex => VERTEX_MODELS,
            ProviderKind::Foundry => FOUNDRY_MODELS,
            _ => CLAUDE_MODELS,
        };
        Ok(shipped
            .iter()
            .map(|(id, name)| ModelInfo {
                id: id.to_string(),
                provider_id: self.config.id.clone(),
                name: name.to_string(),
                context_length: Some(claude_context_window(id).unwrap_or(200_000)),
                fallback: true,
                ..Default::default()
            })
            .collect())
    }
}

/// What the user reads when an organization-level key is sent without a
/// workspace.
const WORKSPACE_HINT: &str = "This Anthropic API key belongs to your organization, not to a workspace, so Anthropic needs to know which workspace to use. Add the workspace's ID (Claude Console, Settings, Workspaces) in the Workspace ID field of the Anthropic provider, or use a key created inside a workspace.";

/// The hint above when a 400 says the key is not scoped to a workspace.
fn workspace_error(status: u16, body: &str) -> Option<&'static str> {
    (status == 400 && body.contains("not scoped to a workspace")).then_some(WORKSPACE_HINT)
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

/// Normalize only the outgoing copy, including evidence from old tool turns.
/// Above 20 images Anthropic caps each edge at 2000px; 1568 also avoids its
/// usual server-side downscale. Small images retain their original encoding.
fn resized_image(url: &str) -> Option<String> {
    let (media, data) = split_data_url(url)?;
    if !matches!(media, "image/png" | "image/jpeg" | "image/gif" | "image/webp") {
        return None;
    }
    let bytes = STANDARD.decode(data).ok()?;
    let reader = image::ImageReader::new(Cursor::new(&bytes)).with_guessed_format().ok()?;
    let (width, height) = reader.into_dimensions().ok()?;
    if width <= 1568 && height <= 1568 {
        return None;
    }
    // ImageReader applies its default allocation limits to untrusted input.
    let image = image::ImageReader::new(Cursor::new(&bytes)).with_guessed_format().ok()?.decode().ok()?;
    let resized = image.resize(1568, 1568, image::imageops::FilterType::Triangle);
    let mut output = Cursor::new(Vec::new());
    resized.write_to(&mut output, image::ImageFormat::Png).ok()?;
    Some(format!("data:image/png;base64,{}", STANDARD.encode(output.into_inner())))
}

fn to_anthropic_messages(req: &ChatRequest) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    // A screenshot can appear more than once in history. Decode it once per
    // request, without retaining a process-wide copy of sensitive image data.
    let mut normalized_images: HashMap<String, Option<String>> = HashMap::new();
    // Two user turns in a row (tool results, then a message the user sent
    // while the tools ran) are one turn to the API.
    fn push(out: &mut Vec<Value>, mut msg: Value) {
        // The API rejects empty text, and a saved turn is resent on every
        // retry and every later turn: one image pasted without words, or an
        // empty reply, would otherwise break the chat for good.
        match non_empty_content(&msg["content"]) {
            Some(content) => msg["content"] = content,
            None => return,
        }
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
                        let normalized = normalized_images.entry(url.clone()).or_insert_with(|| resized_image(url));
                        let url = normalized.as_deref().unwrap_or(url);
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

/// A turn's content without the text the API refuses (empty or
/// whitespace-only text blocks), or `None` when nothing is left to send.
fn non_empty_content(content: &Value) -> Option<Value> {
    match content {
        Value::String(text) => (!text.trim().is_empty()).then(|| content.clone()),
        Value::Array(blocks) => {
            let kept: Vec<Value> = blocks
                .iter()
                .filter(|b| b["type"] != "text" || b["text"].as_str().is_some_and(|t| !t.trim().is_empty()))
                .cloned()
                .collect();
            (!kept.is_empty()).then_some(Value::Array(kept))
        }
        _ => None,
    }
}

#[cfg(test)]
#[path = "anthropic_image_tests.rs"]
mod image_tests;

#[cfg(test)]
#[path = "anthropic_workspace_tests.rs"]
mod workspace_tests;

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
                if ev.pointer("/delta/stop_reason").and_then(Value::as_str) == Some("max_tokens") {
                    out.push(ProviderChunk::OutputLimit);
                }
            }
            Some("message_stop") => return (out, Some(End::Stop)),
            _ => {}
        }
        (out, None)
    }
}

#[cfg(test)]
mod platform_tests {
    use super::*;

    fn provider(kind: &str, base: &str) -> AnthropicProvider {
        let config: ProviderConfig = serde_json::from_value(json!({
            "id": "p", "kind": kind, "label": "p", "baseUrl": base, "apiKey": "secret", "enabled": true
        }))
        .unwrap();
        AnthropicProvider::with_memory(config, Io::default(), Arc::new(SamplingMemory::default()))
    }

    fn request(model: &str) -> ChatRequest {
        ChatRequest { model: model.into(), ..Default::default() }
    }

    #[test]
    fn a_reply_stopped_at_max_tokens_says_so() {
        let mut parser = EventParser::new(DecodeClock::new(Arc::new(|| 0)));
        let delta = |reason: &str| {
            format!(
                r#"{{"type":"message_delta","delta":{{"stop_reason":"{reason}"}},"usage":{{"output_tokens":128000}}}}"#
            )
        };
        let (chunks, _) = parser.event(&delta("max_tokens"));
        assert_eq!(chunks.last(), Some(&ProviderChunk::OutputLimit));
        let (chunks, _) = parser.event(&delta("end_turn"));
        assert!(!chunks.contains(&ProviderChunk::OutputLimit));
    }

    #[test]
    fn vertex_puts_the_model_in_the_url_and_the_version_in_the_body() {
        let base = "https://aiplatform.googleapis.com/v1/projects/proj/locations/global";
        let req = provider("vertex", base).chat_request(&request("claude-opus-5-5"), SamplingShape::Effort);
        assert_eq!(req.url, format!("{base}/publishers/anthropic/models/claude-opus-5-5:streamRawPredict"));
        let body = req.body.unwrap();
        assert_eq!(body.get("model"), None);
        assert_eq!(body["anthropic_version"], VERTEX_VERSION);
        assert_eq!(body["stream"], true);
        assert!(req.headers.contains(&("Authorization".into(), "Bearer secret".into())));
        assert!(!req.headers.iter().any(|(k, _)| k == "x-api-key" || k == "anthropic-version"));
    }

    #[test]
    fn bedrock_and_foundry_send_the_first_party_shape_to_their_own_host() {
        for (kind, base) in [
            ("bedrock", "https://bedrock-mantle.us-east-1.api.aws/anthropic"),
            ("foundry", "https://res.services.ai.azure.com/anthropic"),
        ] {
            let req = provider(kind, base).chat_request(&request("claude-opus-5-5"), SamplingShape::Effort);
            assert_eq!(req.url, format!("{base}/v1/messages"), "{kind}");
            assert_eq!(req.body.unwrap()["model"], "claude-opus-5-5", "{kind}");
            assert!(req.headers.contains(&("x-api-key".into(), "secret".into())), "{kind}");
            assert!(req.headers.contains(&("anthropic-version".into(), "2023-06-01".into())), "{kind}");
        }
    }

    #[tokio::test]
    async fn cloud_platforms_list_their_own_models_without_a_catalog_call() {
        async fn ids(kind: &str) -> Vec<String> {
            provider(kind, "https://unused.invalid").list_models().await.unwrap().into_iter().map(|m| m.id).collect()
        }
        assert!(ids("bedrock").await.iter().all(|id| id.starts_with("anthropic.claude-")));
        assert!(ids("vertex").await.contains(&"claude-haiku-4-5@20251001".to_string()));
        assert!(ids("foundry").await.contains(&"claude-haiku-4-5".to_string()));
    }
}
