//! Any OpenAI-compatible `/chat/completions` endpoint: OpenAI, OpenRouter,
//! LM Studio, vLLM, the Nekko engine's router (`llamacpp`) and generic
//! servers. They differ only in base URL, auth header and a few extras, which
//! come from the config. A port of `openai-compat.ts`.

use super::{Io, extract_api_error, friendly_error};
use crate::http::{HttpRequest, HttpResponse, headers};
use crate::js;
use crate::sse::SseParser;
use crate::stream::{ChunkStream, DecodeClock, Sink, Stop, spawn};
use crate::types::*;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

/// Body fields a server has refused, per provider and model: the field to its
/// replacement (None = dropped). The same "a rejection is information"
/// contract the Anthropic provider keeps for sampling shapes, covering every
/// OpenAI-compatible server whose validator is stricter than the wire format
/// suggests.
#[derive(Debug, Default)]
pub struct ParamMemory(Mutex<HashMap<String, HashMap<String, Option<String>>>>);

impl ParamMemory {
    /// The process-wide store; tests hold their own so a case can never teach
    /// the next.
    pub fn global() -> Arc<ParamMemory> {
        static GLOBAL: LazyLock<Arc<ParamMemory>> = LazyLock::new(|| Arc::new(ParamMemory::default()));
        GLOBAL.clone()
    }

    fn get(&self, provider: &str, model: &str) -> HashMap<String, Option<String>> {
        self.0.lock().unwrap().get(&format!("{provider}:{model}")).cloned().unwrap_or_default()
    }

    fn learn(&self, provider: &str, model: &str, field: &str, rename: Option<String>) {
        self.0.lock().unwrap().entry(format!("{provider}:{model}")).or_default().insert(field.to_string(), rename);
    }
}

#[derive(Clone)]
pub struct OpenAiCompatProvider {
    config: ProviderConfig,
    io: Io,
    params: Arc<ParamMemory>,
}

impl OpenAiCompatProvider {
    pub fn new(config: ProviderConfig, io: Io) -> Self {
        Self { config, io, params: ParamMemory::global() }
    }

    /// With its own field memory: the golden tests, where a case's learned
    /// adjustments must not leak into the next.
    pub fn with_memory(config: ProviderConfig, io: Io, params: Arc<ParamMemory>) -> Self {
        Self { config, io, params }
    }

    pub fn config(&self) -> &ProviderConfig {
        &self.config
    }

    /// The API base. Users often paste `http://host:port` for a server that
    /// serves the OpenAI routes under `/v1`, so a URL with no path gets `/v1`;
    /// one that has a path is left alone, as is anything that does not parse.
    pub fn base(&self) -> String {
        let url = js::trim(&self.config.base_url).trim_end_matches('/');
        match reqwest::Url::parse(url) {
            Ok(u) if u.path().is_empty() || u.path() == "/" => format!("{url}/v1"),
            _ => url.to_string(),
        }
    }

    fn headers(&self) -> Vec<(String, String)> {
        let mut h = headers(&[("Content-Type", "application/json")]);
        if let Some(key) = self.config.api_key.as_deref().filter(|k| !k.is_empty()) {
            h.push(("Authorization".into(), format!("Bearer {key}")));
        }
        if self.config.kind == ProviderKind::Openrouter {
            h.push(("HTTP-Referer".into(), "https://github.com/nekko-labs/nekko-agent".into()));
            h.push(("X-Title".into(), "Nekko Agent".into()));
        }
        h
    }

    /// The request `chat` sends, with the fields this model's server has
    /// refused removed or renamed.
    pub fn chat_request(&self, req: &ChatRequest) -> HttpRequest {
        let mut body = self.body(req);
        apply_learned(&mut body, &self.params.get(&self.config.id, &req.model));
        HttpRequest::post(format!("{}/chat/completions", self.base()), self.headers(), Value::Object(body))
    }

    fn body(&self, req: &ChatRequest) -> Map<String, Value> {
        // `chat_template_kwargs.enable_thinking` (Qwen3 and friends) only goes
        // to local kinds: cloud endpoints reject unknown body fields.
        let local = matches!(
            self.config.kind,
            ProviderKind::Lmstudio | ProviderKind::Vllm | ProviderKind::Llamacpp | ProviderKind::OpenaiCompat
        );
        // OpenAI's reasoning families (o-series, gpt-5 and newer, codex,
        // gpt-oss) refuse `temperature` and `max_tokens` outright, so the
        // request leaves without them rather than retrying after a 400.
        let knob = effort_knob(&self.config.kind, &req.model);
        let mut body = Map::new();
        body.insert("model".into(), json!(req.model));
        body.insert("stream".into(), json!(true));
        body.insert("stream_options".into(), json!({ "include_usage": true }));
        if self.config.kind == ProviderKind::Llamacpp && self.config.managed_cache_prompt == Some(true) {
            body.insert("cache_prompt".into(), json!(req.prompt_caching.unwrap_or(true)));
        }
        // OpenRouter Claude requires an opt-in directive, unlike implicit OpenAI caching.
        let model = req.model.strip_prefix('~').unwrap_or(&req.model);
        if self.config.kind == ProviderKind::Openrouter
            && model.strip_prefix("anthropic/claude-").is_some_and(|suffix| !suffix.is_empty())
            && req.prompt_caching != Some(false)
        {
            body.insert("cache_control".into(), json!({ "type": "ephemeral" }));
        }
        if knob.is_none() {
            body.insert("temperature".into(), json!(req.temperature.unwrap_or(0.7)));
        }
        // Output cap: without it a looping local model streams until its
        // context window fills. Zero means unset, as the TS truthiness test
        // reads it. On the OpenAI API reasoning models take
        // `max_completion_tokens` instead.
        if let Some(max) = req.max_output_tokens.filter(|m| *m > 0) {
            let field = if knob == Some(EffortKnob::ReasoningEffort) { "max_completion_tokens" } else { "max_tokens" };
            body.insert(field.into(), json!(max));
        }
        body.insert("messages".into(), Value::Array(to_openai_messages(req)));
        if self.config.kind == ProviderKind::Openrouter
            && super::prompt_caching::gemini_model(&req.model)
            && req.prompt_caching != Some(false)
        {
            super::prompt_caching::gemini_prefix(&mut body);
        }
        if let Some(tools) = &req.tools {
            body.insert("tools".into(), tools.iter().map(openai_tool).collect());
        }
        if let (Some(think), true) = (req.think, local) {
            body.insert("chat_template_kwargs".into(), json!({ "enable_thinking": think }));
        }
        if let Some(rung) = knob.and_then(|_| openai_effort(req)) {
            match knob.unwrap() {
                EffortKnob::ReasoningEffort => {
                    body.insert("reasoning_effort".into(), json!(rung));
                }
                EffortKnob::Reasoning => {
                    body.insert("reasoning".into(), json!({ "effort": rung }));
                }
            }
        }
        body
    }

    pub fn chat(&self, req: ChatRequest) -> ChunkStream {
        let me = self.clone();
        spawn(req.signal.clone(), move |sink| async move { me.run(req, sink).await })
    }

    async fn run(self, req: ChatRequest, sink: Sink) -> Result<(), Stop> {
        let mut attempts = 0;
        // A validator that still refuses the shape gets its way: drop or
        // rename the blamed field and send again, once per rejection, then
        // remember it.
        let mut res = loop {
            let http = self.chat_request(&req);
            let mut res = match sink.send(&*self.io.transport, &http).await? {
                Ok(res) => res,
                Err(e) => return Err(ProviderError::new(friendly_error(&e.message, || self.unreachable())).into()),
            };
            if res.ok() {
                break res;
            }
            let text = sink.text(&mut res).await?;
            let blame = if attempts < 4 {
                http.body.as_ref().and_then(Value::as_object).and_then(|body| blamed_param(res.status, &text, body))
            } else {
                None
            };
            match blame {
                Some((field, rename)) => {
                    self.params.learn(&self.config.id, &req.model, &field, rename);
                    attempts += 1;
                    continue;
                }
                // OpenAI-style bodies carry { error: { message } }: surface that
                // instead of raw JSON, so 401/402/429 replies read like sentences.
                None => {
                    let detail =
                        if text.is_empty() { String::new() } else { format!(": {}", extract_api_error(&text)) };
                    return Err(ProviderError::http(
                        res.status,
                        format!("Model request failed (HTTP {}){detail}", res.status),
                    )
                    .into());
                }
            }
        };
        let mut parser = ChatParser::new(DecodeClock::new(self.io.clock.clone()));
        let mut sse = SseParser::default();
        while let Some(bytes) = sink.read(&mut res).await? {
            let batch = sse.feed(&bytes);
            for data in &batch.data {
                if let Ok(value) = serde_json::from_str::<Value>(data)
                    && js::truthy(value.get("error"))
                {
                    return Err(ProviderError::new(format!("Model stream failed: {}", extract_api_error(data))).into());
                }
                for chunk in parser.event(data) {
                    sink.emit(chunk).await?;
                }
            }
            if batch.done {
                break;
            }
        }
        sink.emit(ProviderChunk::Done).await
    }

    fn unreachable(&self) -> String {
        format!("Can't reach the model server at {}. Is it running and reachable on the network?", self.base())
    }

    /// `test()`: OpenRouter's `/key` (a real auth check, with the credit
    /// left), else `/models`.
    pub async fn test(&self) -> TestResult {
        let reach =
            |e: &crate::http::TransportError| TestResult::fail(friendly_error(&e.message, || self.unreachable()));
        if self.config.kind == ProviderKind::Openrouter {
            if self.config.api_key.as_deref().is_none_or(str::is_empty) {
                return TestResult::fail("Paste an API key or sign in with OpenRouter first.");
            }
            let req = HttpRequest::get(format!("{}/key", self.base()), self.headers());
            let mut res = match self.io.transport.send(&req).await {
                Ok(res) => res,
                Err(e) => return reach(&e),
            };
            if res.status == 401 || res.status == 403 {
                return TestResult::fail("OpenRouter rejected this key. Check it or regenerate it.");
            }
            if !res.ok() {
                return TestResult::fail(format!("OpenRouter answered HTTP {}.", res.status));
            }
            let json: Value = serde_json::from_str(&res.text().await).unwrap_or(Value::Null);
            let d = json.get("data");
            let field = |k: &str| d.and_then(|d| d.get(k)).filter(|v| !v.is_null());
            // `d?.limit_remaining ?? (d?.limit != null && d?.usage != null ? d.limit - d.usage : null)`
            let remaining = match field("limit_remaining") {
                Some(v) => Some(js::to_number(Some(v))),
                None => match (field("limit"), field("usage")) {
                    (Some(l), Some(u)) => Some(js::to_number(Some(l)) - js::to_number(Some(u))),
                    _ => None,
                },
            };
            return TestResult::ok(match remaining {
                // `Math.max(0, NaN)` is NaN.
                Some(r) => format!("Connected, ${} left", js::to_fixed(if r.is_nan() { r } else { r.max(0.0) }, 2)),
                None => "Connected, unlimited".to_string(),
            });
        }
        let req = HttpRequest::get(format!("{}/models", self.base()), self.headers());
        let mut res = match self.io.transport.send(&req).await {
            Ok(res) => res,
            Err(e) => return reach(&e),
        };
        if res.ok() {
            return TestResult::ok("Connected");
        }
        let detail = extract_api_error(&res.text().await);
        let hint = if res.status == 401 { ", check your API key" } else { "" };
        let detail = if detail.is_empty() { String::new() } else { format!(": {detail}") };
        TestResult::fail(format!("HTTP {}{hint}{detail}", res.status))
    }

    pub async fn list_models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        // LM Studio's native REST API reports per-model load state, which
        // /v1/models does not. Prefer it there, falling back on any failure.
        if self.config.kind == ProviderKind::Lmstudio
            && let Some(models) = self.lm_studio_models().await
        {
            return Ok(models);
        }
        let req = HttpRequest::get(format!("{}/models", self.base()), self.headers());
        let mut res = self.io.transport.send(&req).await.map_err(|e| ProviderError::new(e.message))?;
        let text = res.text().await;
        if !res.ok() {
            return Err(ProviderError::http(
                res.status,
                format!("listModels {}: {}", res.status, extract_api_error(&text)),
            ));
        }
        let json: Value = serde_json::from_str(&text).map_err(|e| ProviderError::new(format!("listModels: {e}")))?;
        let openrouter = self.config.kind == ProviderKind::Openrouter;
        let data = json.get("data").and_then(Value::as_array).cloned().unwrap_or_default();
        Ok(data
            .iter()
            .map(|m| {
                let id = m.get("id").map(js::display).unwrap_or_default();
                let input = js::to_number(m.pointer("/pricing/prompt"));
                let output = js::to_number(m.pointer("/pricing/completion"));
                let priced = openrouter && input.is_finite() && output.is_finite();
                // A display name only from the servers that send a meaningful
                // one (`serverNamesModels`): OpenRouter's "OpenAI: GPT-5" and
                // the local engines' friendly model names.
                let name = match m.get("name") {
                    n if server_names_models(&self.config.kind) && js::truthy(n) => {
                        n.map(js::display).unwrap_or_default()
                    }
                    _ => id.clone(),
                };
                let context = js::coalesce(
                    js::coalesce(m.get("context_length"), m.pointer("/top_provider/context_length")),
                    m.get("max_context_length"),
                );
                let tools = openrouter && supports_tools(m.get("supported_parameters"));
                // The Nekko engine sends the file path and the folder it lives
                // in, so pickers lead with the name and group by location.
                let mut details = Map::new();
                if tools {
                    details.insert("tools".into(), json!("yes"));
                }
                // What the model takes as input (OpenRouter's catalog, the
                // Nekko engine's projector check), for the composer and turn.
                let inputs: Vec<String> = m
                    .pointer("/architecture/input_modalities")
                    .or_else(|| m.get("input_modalities"))
                    .and_then(Value::as_array)
                    .map(|a| a.iter().map(js::display).collect())
                    .unwrap_or_default();
                if !inputs.is_empty() {
                    details.insert("inputModalities".into(), json!(inputs.join(",")));
                }
                for key in ["path", "location"] {
                    if let Some(Value::String(s)) = m.get(key) {
                        details.insert(key.into(), json!(s));
                    }
                }
                let loaded = if self.config.kind == ProviderKind::Vllm {
                    // vLLM serves exactly the model(s) it was launched with.
                    Some(true)
                } else {
                    match m.get("state").and_then(Value::as_str) {
                        Some("loaded") => Some(true),
                        Some("not-loaded") => Some(false),
                        _ => None,
                    }
                };
                ModelInfo {
                    id,
                    provider_id: self.config.id.clone(),
                    name,
                    context_length: context.and_then(Value::as_u64),
                    input_price_per_m: priced.then_some(input * 1e6),
                    output_price_per_m: priced.then_some(output * 1e6),
                    details: (!details.is_empty()).then_some(details),
                    loaded,
                    ..Default::default()
                }
            })
            .collect())
    }

    /// LM Studio's model list with load state (`/api/v0/models`), or `None`
    /// on any failure, so the caller falls back to `/v1/models`.
    async fn lm_studio_models(&self) -> Option<Vec<ModelInfo>> {
        let base = self.base();
        let root = base.strip_suffix("/v1").unwrap_or(&base);
        let req = HttpRequest::get(format!("{root}/api/v0/models"), self.headers());
        let mut res: HttpResponse = self.io.transport.send(&req).await.ok()?;
        if !res.ok() {
            return None;
        }
        let text = res.text().await;
        let json: Value = serde_json::from_str(&text).ok()?;
        if json.is_null() {
            return None;
        }
        let data = json.get("data").and_then(Value::as_array).cloned().unwrap_or_default();
        Some(
            data.iter()
                .map(|m| {
                    let id = m.get("id").map(js::display).unwrap_or_default();
                    let context = js::coalesce(m.get("loaded_context_length"), m.get("max_context_length"));
                    ModelInfo {
                        name: id.clone(),
                        id,
                        provider_id: self.config.id.clone(),
                        context_length: context.and_then(Value::as_u64),
                        loaded: Some(m.get("state").and_then(Value::as_str) == Some("loaded")),
                        ..Default::default()
                    }
                })
                .collect(),
        )
    }
}

/// `serverNamesModels` (openai-compat.ts): kinds whose `/models` rows carry a
/// display name worth showing.
fn server_names_models(kind: &ProviderKind) -> bool {
    matches!(
        kind,
        ProviderKind::Openrouter
            | ProviderKind::Llamacpp
            | ProviderKind::OpenaiCompat
            | ProviderKind::Lmstudio
            | ProviderKind::Vllm
    )
}

/// The body field that carries the effort rung for this provider and model.
/// On the OpenAI API it is `reasoning_effort` (with `max_completion_tokens`
/// for the cap); OpenRouter normalizes the same rung as `reasoning.effort`.
/// Local servers keep the sampling fields whatever the id says.
#[derive(Clone, Copy, PartialEq, Eq)]
enum EffortKnob {
    ReasoningEffort,
    Reasoning,
}

fn effort_knob(kind: &ProviderKind, model: &str) -> Option<EffortKnob> {
    if !openai_reasoning_model(model) {
        return None;
    }
    match kind {
        ProviderKind::Openai => Some(EffortKnob::ReasoningEffort),
        ProviderKind::Openrouter => Some(EffortKnob::Reasoning),
        _ => None,
    }
}

/// `/(?:^|[-_/ .])(?:o\d+|gpt-?(?:[5-9]|\d{2,})|gpt-oss|codex)/i`, hand-rolled:
/// a boundary, then o + digits, gpt + a number of two digits or 5 and up,
/// gpt-oss, or codex.
fn openai_reasoning_model(model: &str) -> bool {
    let id = model.to_lowercase();
    let b = id.as_bytes();
    for i in 0..b.len() {
        if i > 0 && !matches!(b[i - 1], b'-' | b'_' | b'/' | b' ' | b'.') {
            continue;
        }
        let rest = &id[i..];
        if rest.starts_with("codex") || rest.starts_with("gpt-oss") {
            return true;
        }
        if let Some(d) = rest.strip_prefix('o')
            && d.bytes().next().is_some_and(|c| c.is_ascii_digit())
        {
            return true;
        }
        if let Some(r) = rest.strip_prefix("gpt") {
            let r = r.strip_prefix('-').unwrap_or(r);
            let digits = r.bytes().take_while(|c| c.is_ascii_digit()).count();
            if digits >= 2 || (digits == 1 && r.as_bytes()[0] >= b'5') {
                return true;
            }
        }
    }
    false
}

/// The rung as OpenAI's ladder speaks it; `normal` leaves the model's default.
fn openai_effort(req: &ChatRequest) -> Option<&'static str> {
    match crate::claude::effective_effort(req.effort, &req.model) {
        EffortLevel::Low => Some("low"),
        EffortLevel::Medium => Some("medium"),
        EffortLevel::Normal => None,
        _ => Some("high"),
    }
}

/// Optional body fields a request can survive losing. `model`, `messages` and
/// `stream` are never dropped: a server that refuses those cannot serve the
/// request at all, and its error belongs on screen.
const DROPPABLE: &[&str] = &[
    "temperature",
    "top_p",
    "top_k",
    "presence_penalty",
    "frequency_penalty",
    "max_tokens",
    "max_completion_tokens",
    "reasoning_effort",
    "reasoning",
    "stream_options",
    "chat_template_kwargs",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "logit_bias",
    "seed",
    "stop",
    "store",
    "n",
    "logprobs",
    "top_logprobs",
    "response_format",
    "user",
    "metadata",
];

/// How close a rejection word must sit to a field name to blame it.
const NEAR: usize = 80;
const REJECT_WORDS: &[&str] = &[
    "unsupported",
    "not supported",
    "does not support",
    "unexpected",
    "unknown",
    "unrecogni",
    "extra",
    "is not allowed",
    "deprecated",
];

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// The body field a rejection blames, plus the field it suggests instead. An
/// explicit name (`error.param`) that lands on a required field ends the
/// search: there is nothing to adjust. The looser near-match only ever
/// returns droppable fields, so "for this model" cannot blame `model`.
fn blamed_param(status: u16, text: &str, body: &Map<String, Value>) -> Option<(String, Option<String>)> {
    if status != 400 && status != 422 {
        return None;
    }
    if let Some(named) = named_param(text, body) {
        if !DROPPABLE.contains(&named.as_str()) {
            return None;
        }
        let rename = replacement_param(text, &named);
        return Some((named, rename));
    }
    let field = near_rejection(text, body)?;
    Some((field.clone(), replacement_param(text, &field)))
}

/// The field the error body names explicitly: OpenAI's `error.param`, a bare
/// `param`, or a FastAPI `detail[].loc[]` entry ("extra fields not permitted").
fn named_param(text: &str, body: &Map<String, Value>) -> Option<String> {
    let parsed = js::safe_parse(text);
    for v in [parsed.pointer("/error/param"), parsed.get("param")].into_iter().flatten() {
        if let Value::String(s) = v
            && body.contains_key(s)
        {
            return Some(s.clone());
        }
    }
    if let Some(detail) = parsed.get("detail").and_then(Value::as_array) {
        for d in detail {
            if let Some(loc) = d.get("loc").and_then(Value::as_array) {
                for l in loc {
                    if let Value::String(s) = l
                        && body.contains_key(s)
                    {
                        return Some(s.clone());
                    }
                }
            }
        }
    }
    None
}

/// The sent field whose name appears within `NEAR` chars of a rejection word,
/// in either order ("Unsupported parameter: temperature", "'max_tokens' is
/// not supported"). Word-bounded, so `tool` inside `tool_calls` never counts.
fn near_rejection(text: &str, body: &Map<String, Value>) -> Option<String> {
    let t = text.to_lowercase();
    for key in body.keys() {
        if !DROPPABLE.contains(&key.as_str()) {
            continue;
        }
        let mut at = 0;
        while let Some(i) = t[at..].find(key.as_str()).map(|x| at + x) {
            at = i + 1;
            let b = t.as_bytes();
            if (i > 0 && is_word_byte(b[i - 1])) || (i + key.len() < b.len() && is_word_byte(b[i + key.len()])) {
                continue;
            }
            let before: String = t[..i].chars().rev().take(NEAR).collect::<Vec<_>>().into_iter().rev().collect();
            let after: String = t[i + key.len()..].chars().take(NEAR).collect();
            if REJECT_WORDS.iter().any(|w| before.contains(w) || after.contains(w)) {
                return Some(key.clone());
            }
        }
    }
    None
}

/// The field named in a "use X instead" hint, when it is one we may send.
fn replacement_param(text: &str, field: &str) -> Option<String> {
    let t = text.to_lowercase();
    let b = t.as_bytes();
    let mut i = 0;
    while let Some(at) = t[i..].find(" instead").map(|x| i + x) {
        i = at + 8;
        let mut end = at;
        while end > 0 && (b[end - 1].is_ascii_whitespace() || matches!(b[end - 1], b'"' | b'\'' | b'`')) {
            end -= 1;
        }
        let mut start = end;
        while start > 0 && is_word_byte(b[start - 1]) {
            start -= 1;
        }
        let word = &t[start..end];
        if word.is_empty() {
            continue;
        }
        let mut q = start;
        while q > 0 && matches!(b[q - 1], b'"' | b'\'' | b'`') {
            q -= 1;
        }
        let head = t[..q].trim_end();
        let Some(before) = head.strip_suffix("use") else {
            continue;
        };
        if before.as_bytes().last().is_some_and(|c| is_word_byte(*c)) {
            continue;
        }
        if word != field && DROPPABLE.contains(&word) {
            return Some(word.to_string());
        }
    }
    None
}

/// Apply the remembered adjustments: drop the field, or move its value to the
/// field the server asked for instead.
fn apply_learned(body: &mut Map<String, Value>, learned: &HashMap<String, Option<String>>) {
    for (field, to) in learned {
        if let (Some(v), Some(to)) = (body.shift_remove(field), to) {
            body.insert(to.clone(), v);
        }
    }
}

/// `supported_parameters?.includes('tools')`, for an array or a string.
fn supports_tools(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Array(a)) => a.iter().any(|x| x == "tools"),
        Some(Value::String(s)) => s.contains("tools"),
        _ => false,
    }
}

fn openai_tool(t: &ToolSpec) -> Value {
    json!({ "type": "function", "function": { "name": t.name, "description": t.description, "parameters": t.parameters } })
}

fn to_openai_messages(req: &ChatRequest) -> Vec<Value> {
    let mut out = Vec::new();
    if let Some(system) = req.system.as_deref().filter(|s| !s.is_empty()) {
        out.push(json!({ "role": "system", "content": system }));
    }
    for m in &crate::types::with_tool_images(&req.messages) {
        if let (Role::Tool, Some(r)) = (m.role, &m.tool_result) {
            out.push(json!({ "role": "tool", "tool_call_id": r.tool_call_id, "content": r.output }));
        } else if let (Role::Assistant, Some(calls)) = (m.role, m.calls()) {
            let calls: Vec<Value> = calls
                .iter()
                .map(|c| {
                    json!({
                        "id": c.id,
                        "type": "function",
                        "function": { "name": c.name, "arguments": js::stringify(&c.input) },
                    })
                })
                .collect();
            let content = if m.content.is_empty() { Value::Null } else { json!(m.content) };
            out.push(json!({ "role": "assistant", "content": content, "tool_calls": calls }));
        } else {
            let content = match m.user_images() {
                Some(images) => {
                    let mut parts = vec![json!({ "type": "text", "text": m.content })];
                    parts.extend(images.iter().map(|url| json!({ "type": "image_url", "image_url": { "url": url } })));
                    Value::Array(parts)
                }
                None => json!(m.content),
            };
            out.push(json!({ "role": m.role, "content": content }));
        }
    }
    out
}

/// A tool call being assembled from streamed fragments.
struct PartialCall {
    id: String,
    name: String,
    args: String,
}

/// Turns `/chat/completions` stream events into chunks.
pub(crate) struct ChatParser {
    /// By `index`, in first-seen order (a JS `Map`).
    calls: Vec<(String, PartialCall)>,
    /// `include_usage` puts the usage event after the last content event, so
    /// the clock covers exactly the span its tokens were generated in.
    decode: DecodeClock,
}

impl ChatParser {
    pub(crate) fn new(decode: DecodeClock) -> Self {
        Self { calls: Vec::new(), decode }
    }

    pub(crate) fn event(&mut self, data: &str) -> Vec<ProviderChunk> {
        let mut out = Vec::new();
        let Ok(chunk) = serde_json::from_str::<Value>(data) else { return out };
        let choice = chunk.get("choices").and_then(|c| c.get(0));
        let delta = choice.and_then(|c| c.get("delta"));
        // Reasoning models stream their chain of thought as `reasoning_content`
        // (or `reasoning`). `??`, not `||`: an empty `reasoning_content` wins.
        let reasoning =
            js::coalesce(delta.and_then(|d| d.get("reasoning_content")), delta.and_then(|d| d.get("reasoning")));
        if let Some(r) = js::truthy_str(reasoning) {
            self.decode.mark();
            out.push(ProviderChunk::Reasoning { delta: r.to_string() });
        }
        if let Some(text) = js::truthy_str(delta.and_then(|d| d.get("content"))) {
            self.decode.mark();
            out.push(ProviderChunk::Text { delta: text.to_string() });
        }
        let tool_calls = delta.and_then(|d| d.get("tool_calls"));
        if js::truthy(tool_calls) {
            // Tool arguments are generated tokens too, so a response that only
            // calls a tool still has a decode rate.
            self.decode.mark();
            for tc in tool_calls.and_then(Value::as_array).into_iter().flatten().filter(|t| t.is_object()) {
                self.fragment(tc);
            }
        }
        if let Some(usage) = chunk.get("usage").filter(|u| js::truthy(Some(u))) {
            self.decode.stop();
            let (input_tokens, cache_read_tokens, cache_write_tokens) =
                super::prompt_caching::usage(usage, "prompt_tokens");
            out.push(ProviderChunk::Usage {
                input_tokens,
                cache_read_tokens,
                cache_write_tokens,
                output_tokens: usage.get("completion_tokens").and_then(Value::as_u64).unwrap_or(0),
                output_ms: self.decode.elapsed(),
            });
        }
        if js::truthy(choice.and_then(|c| c.get("finish_reason"))) {
            for (_, acc) in self.calls.drain(..) {
                out.push(ProviderChunk::ToolCall {
                    call: ToolCall { id: acc.id, name: acc.name, input: js::safe_parse(&acc.args) },
                });
            }
        }
        out
    }

    fn fragment(&mut self, tc: &Value) {
        let index = js::coalesce(tc.get("index"), None).cloned().unwrap_or(json!(0));
        let key = js::stringify(&index);
        let pos = match self.calls.iter().position(|(k, _)| *k == key) {
            Some(p) => p,
            None => {
                let id = match tc.get("id") {
                    Some(id) if !js::nullish(Some(id)) => js::display(id),
                    _ => format!("call_{}", js::display(&index)),
                };
                self.calls.push((key, PartialCall { id, name: String::new(), args: String::new() }));
                self.calls.len() - 1
            }
        };
        let cur = &mut self.calls[pos].1;
        if let Some(id) = tc.get("id").filter(|v| js::truthy(Some(v))) {
            cur.id = js::display(id);
        }
        if let Some(name) = tc.pointer("/function/name").filter(|v| js::truthy(Some(v))) {
            cur.name.push_str(&js::display(name));
        }
        if let Some(args) = tc.pointer("/function/arguments").filter(|v| js::truthy(Some(v))) {
            cur.args.push_str(&js::display(args));
        }
    }
}

#[cfg(test)]
mod cache_policy_tests {
    use super::*;

    #[test]
    fn routed_claude_cache_directive_is_gated_and_preserves_context() {
        let fixtures: Value = serde_json::from_str(include_str!("../../tests/golden/request-cases.json")).unwrap();
        for kind in ["openrouter", "openai", "openai-compat", "lmstudio", "vllm", "llamacpp"] {
            // Even a generic server pointing at OpenRouter must not receive the directive.
            let config = json!({ "id": "p", "kind": kind, "label": "P", "baseUrl": "https://openrouter.ai/api/v1", "enabled": true });
            let provider = OpenAiCompatProvider::new(serde_json::from_value(config).unwrap(), Io::default());
            for model in [
                "anthropic/claude-sonnet-4.5",
                "~anthropic/claude-sonnet-latest",
                "anthropic/claude-sonnet-4.5:thinking",
                "anthropic/claude-",
                "anthropic/not-claude",
                "claude-sonnet-4.5",
                "openai/gpt-5",
                "google/gemini-2.5-pro",
                "google/gemini-2.0-flash-001",
                "openrouter/auto",
            ] {
                let mut req: ChatRequest =
                    serde_json::from_value(fixtures["requests"]["cache-default"].clone()).unwrap();
                req.model = model.into();
                let mut bodies = Vec::new();
                for policy in [None, Some(true), Some(false)] {
                    req.prompt_caching = policy;
                    bodies.push(provider.chat_request(&req).body.unwrap());
                }
                assert_eq!(bodies[0], bodies[1]);
                let supported = kind == "openrouter"
                    && model.trim_start_matches('~').strip_prefix("anthropic/claude-").is_some_and(|s| !s.is_empty());
                if supported {
                    assert_eq!(bodies[0]["cache_control"], json!({ "type": "ephemeral" }));
                } else if kind == "openrouter" && super::super::prompt_caching::gemini_model(model) {
                    assert_eq!(bodies[0]["messages"][0]["content"][0]["cache_control"], json!({ "type": "ephemeral" }));
                    // Compare complete context after normalizing only marker-bearing text blocks.
                    for message in bodies[0]["messages"].as_array_mut().unwrap() {
                        if let Some(blocks) = message["content"].as_array_mut() {
                            for block in blocks.iter_mut() {
                                block.as_object_mut().unwrap().remove("cache_control");
                            }
                            if blocks.len() == 1 && blocks[0]["type"] == "text" {
                                message["content"] = blocks[0]["text"].clone();
                            }
                        }
                    }
                } else {
                    assert!(!bodies[0].to_string().contains("cache_control"), "{kind}/{model}");
                }
                assert!(!bodies[2].to_string().contains("cache_control"));
                bodies[0].as_object_mut().unwrap().remove("cache_control");
                assert_eq!(bodies[0], bodies[2], "{kind}/{model}");
            }
        }
    }

    #[test]
    fn only_managed_llama_gets_an_explicit_cache_policy_including_off() {
        for kind in ["llamacpp", "openai-compat", "lmstudio", "vllm", "openai", "openrouter"] {
            for managed in [None, Some(false), Some(true)] {
                let mut config = json!({ "id": "p", "kind": kind, "label": "P", "baseUrl": "http://localhost:1/v1", "enabled": true });
                if let Some(managed) = managed {
                    config["managedCachePrompt"] = json!(managed);
                }
                let provider = OpenAiCompatProvider::new(serde_json::from_value(config).unwrap(), Io::default());
                for policy in [None, Some(true), Some(false)] {
                    let request = ChatRequest { model: "gemma".into(), prompt_caching: policy, ..Default::default() };
                    let body = provider.chat_request(&request).body.unwrap();
                    if kind == "llamacpp" && managed == Some(true) {
                        assert_eq!(body["cache_prompt"], policy.unwrap_or(true));
                    } else {
                        assert!(body.get("cache_prompt").is_none(), "{kind}: {body}");
                    }
                }
            }
        }
    }
}
