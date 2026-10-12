//! Ollama's native API. Ollama also serves an OpenAI-compatible endpoint, but
//! the native one reports load state and VRAM, which the Models page shows.
//! It streams newline-delimited JSON, not SSE. A port of `ollama.ts`'s
//! `listModels` and `chat` (model pulls and loads stay in TS for now).

use super::Io;
use crate::http::HttpRequest;
use crate::js;
use crate::sse::LineParser;
use crate::stream::{ChunkStream, DecodeClock, Sink, Stop, spawn};
use crate::types::*;
use serde_json::{Map, Value, json};

#[derive(Clone)]
pub struct OllamaProvider {
    config: ProviderConfig,
    io: Io,
}

impl OllamaProvider {
    pub fn new(config: ProviderConfig, io: Io) -> Self {
        Self { config, io }
    }

    pub fn config(&self) -> &ProviderConfig {
        &self.config
    }

    /// The base URL without a trailing `/v1`, in case the user pasted the
    /// OpenAI-compatible one.
    pub fn base(&self) -> &str {
        let url = &self.config.base_url;
        url.strip_suffix("/v1/").or_else(|| url.strip_suffix("/v1")).unwrap_or(url)
    }

    /// The request `chat` sends. No headers at all, as in TS (Node's fetch
    /// then labels the string body `text/plain`; Ollama reads it either way).
    pub fn chat_request(&self, req: &ChatRequest) -> HttpRequest {
        let mut options = Map::new();
        options.insert("temperature".into(), json!(req.temperature.unwrap_or(0.7)));
        // `num_predict` is Ollama's output cap; without it a looping model
        // runs until it fills its context window.
        if let Some(max) = req.max_output_tokens.filter(|m| *m > 0) {
            options.insert("num_predict".into(), json!(max));
        }
        let mut body = Map::new();
        body.insert("model".into(), json!(req.model));
        body.insert("stream".into(), json!(true));
        body.insert("options".into(), Value::Object(options));
        // The native reasoning toggle, left off when unset so non-reasoning
        // models are unaffected.
        if let Some(think) = req.think {
            body.insert("think".into(), json!(think));
        }
        body.insert("messages".into(), Value::Array(to_ollama_messages(req)));
        if let Some(tools) = &req.tools {
            let tools = tools
                .iter()
                .map(|t| {
                    json!({
                        "type": "function",
                        "function": { "name": t.name, "description": t.description, "parameters": t.parameters },
                    })
                })
                .collect();
            body.insert("tools".into(), Value::Array(tools));
        }
        HttpRequest::post(format!("{}/api/chat", self.base()), Vec::new(), Value::Object(body))
    }

    pub fn chat(&self, req: ChatRequest) -> ChunkStream {
        let me = self.clone();
        spawn(req.signal.clone(), move |sink| async move { me.run(req, sink).await })
    }

    async fn run(self, req: ChatRequest, sink: Sink) -> Result<(), Stop> {
        let http = self.chat_request(&req);
        let mut res = sink.send(&*self.io.transport, &http).await?.map_err(|e| ProviderError::new(e.message))?;
        if !res.ok() {
            return Err(ProviderError::http(res.status, format!("chat {}", res.status)).into());
        }
        // A fallback, used only if the server leaves out `eval_duration`.
        let mut decode = DecodeClock::new(self.io.clock.clone());
        let mut lines = LineParser::default();
        while let Some(bytes) = sink.read(&mut res).await? {
            for line in lines.feed(&bytes) {
                let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
                if let Some(error) = msg.get("error").filter(|v| js::truthy(Some(v))) {
                    return Err(ProviderError::new(format!("Ollama stream failed: {}", js::display(error))).into());
                }
                let message = msg.get("message");
                if let Some(thinking) = js::truthy_str(message.and_then(|m| m.get("thinking"))) {
                    decode.mark();
                    sink.emit(ProviderChunk::Reasoning { delta: thinking.to_string() }).await?;
                }
                if let Some(content) = js::truthy_str(message.and_then(|m| m.get("content"))) {
                    decode.mark();
                    sink.emit(ProviderChunk::Text { delta: content.to_string() }).await?;
                }
                let calls = message.and_then(|m| m.get("tool_calls"));
                if js::truthy(calls) {
                    decode.mark();
                    for tc in calls.and_then(Value::as_array).into_iter().flatten() {
                        sink.emit(ProviderChunk::ToolCall { call: tool_call(tc) }).await?;
                    }
                }
                if js::truthy(msg.get("done")) {
                    decode.stop();
                    // Ollama times its own decode phase, in nanoseconds. That
                    // excludes transport as well as prompt processing and is
                    // what `ollama run --verbose` prints, so it wins.
                    let eval_ns = js::to_number(msg.get("eval_duration"));
                    let output_ms =
                        if eval_ns > 0.0 { Some(((eval_ns / 1e6).round() as u64).max(1)) } else { decode.elapsed() };
                    sink.emit(ProviderChunk::Usage {
                        cache_read_tokens: None,
                        cache_write_tokens: None,
                        input_tokens: msg.get("prompt_eval_count").and_then(Value::as_u64).unwrap_or(0),
                        output_tokens: msg.get("eval_count").and_then(Value::as_u64).unwrap_or(0),
                        output_ms,
                    })
                    .await?;
                    return sink.emit(ProviderChunk::Done).await;
                }
            }
        }
        sink.emit(ProviderChunk::Done).await
    }

    /// `test()`: whether `/api/tags` answers.
    pub async fn test(&self) -> TestResult {
        let req = HttpRequest::get(format!("{}/api/tags", self.base()), Vec::new());
        match self.io.transport.send(&req).await {
            Ok(res) if res.ok() => TestResult::ok("Connected"),
            Ok(res) => TestResult::fail(format!("HTTP {}", res.status)),
            Err(e) => TestResult::fail(e.message),
        }
    }

    pub async fn list_models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        let tags_req = HttpRequest::get(format!("{}/api/tags", self.base()), Vec::new());
        let ps_req = HttpRequest::get(format!("{}/api/ps", self.base()), Vec::new());
        let (tags, ps) = tokio::join!(self.get_json(&tags_req), self.get_json(&ps_req));
        let models = |v: &Value| v.get("models").and_then(Value::as_array).cloned().unwrap_or_default();
        let vram: Vec<(String, Value)> = models(&ps)
            .iter()
            .map(|m| {
                let size = js::coalesce(m.get("size_vram"), None).cloned().unwrap_or(json!(0));
                (m.get("name").map(js::display).unwrap_or_default(), size)
            })
            .collect();
        // A `Map` built from pairs: a repeated name keeps its last value.
        let vram_of = |name: &str| vram.iter().rev().find(|(n, _)| n == name).map(|(_, v)| v);
        Ok(models(&tags)
            .iter()
            .map(|m| {
                let name = m.get("name").map(js::display).unwrap_or_default();
                let vram = vram_of(&name);
                let details = m.get("details").filter(|d| js::truthy(Some(d))).map(|d| {
                    let mut out = Map::new();
                    for (key, from) in [("family", "family"), ("quant", "quantization_level")] {
                        // Passed through as the server wrote it; only an
                        // absent field is left out, as JSON.stringify does.
                        if let Some(v) = d.get(from) {
                            out.insert(key.into(), v.clone());
                        }
                    }
                    out
                });
                ModelInfo {
                    id: name.clone(),
                    provider_id: self.config.id.clone(),
                    name,
                    loaded: Some(vram.is_some()),
                    size_bytes: m.get("size").and_then(Value::as_u64),
                    // `get(name) || undefined`: a zero reads as unknown.
                    vram_bytes: vram.and_then(Value::as_u64).filter(|v| *v > 0),
                    details,
                    ..Default::default()
                }
            })
            .collect())
    }

    /// `fetch(url).then(r => r.json()).catch(() => ({ models: [] }))`: any
    /// failure reads as an empty list, and a non-OK status is still parsed.
    async fn get_json(&self, req: &HttpRequest) -> Value {
        let Ok(mut res) = self.io.transport.send(req).await else { return json!({ "models": [] }) };
        serde_json::from_str(&res.text().await).unwrap_or_else(|_| json!({ "models": [] }))
    }
}

/// A native tool call. Ollama sends no call id, so one is derived from the
/// call itself, exactly as the TS side hashes it, so ids agree across both.
fn tool_call(tc: &Value) -> ToolCall {
    ToolCall {
        id: format!("call_{}", (hash(&js::stringify(tc)) as i64).abs()),
        name: tc.pointer("/function/name").filter(|v| !v.is_null()).map(js::display).unwrap_or_default(),
        input: js::coalesce(tc.pointer("/function/arguments"), None).cloned().unwrap_or_else(|| json!({})),
    }
}

/// The TS `hash`: `h = Math.imul(31, h) + charCode | 0` over UTF-16 code units.
fn hash(s: &str) -> i32 {
    s.encode_utf16().fold(0i32, |h, c| h.wrapping_mul(31).wrapping_add(i32::from(c)))
}

fn to_ollama_messages(req: &ChatRequest) -> Vec<Value> {
    let mut out = Vec::new();
    if let Some(system) = req.system.as_deref().filter(|s| !s.is_empty()) {
        out.push(json!({ "role": "system", "content": system }));
    }
    for m in &crate::types::with_tool_images(&req.messages) {
        if let (Role::Tool, Some(r)) = (m.role, &m.tool_result) {
            out.push(json!({ "role": "tool", "content": r.output }));
        } else if let (Role::Assistant, Some(calls)) = (m.role, m.calls()) {
            let calls: Vec<Value> =
                calls.iter().map(|c| json!({ "function": { "name": c.name, "arguments": c.input } })).collect();
            out.push(json!({ "role": "assistant", "content": m.content, "tool_calls": calls }));
        } else {
            let mut msg = json!({ "role": m.role, "content": m.content });
            if let Some(images) = m.user_images() {
                msg["images"] = images.iter().map(|i| json!(strip_data_prefix(i))).collect();
            }
            out.push(msg);
        }
    }
    out
}

/// `image.replace(/^data:[^;]+;base64,/, '')`: Ollama wants bare base64.
fn strip_data_prefix(url: &str) -> &str {
    let Some(rest) = url.strip_prefix("data:") else { return url };
    match rest.find(';') {
        Some(semi) if semi > 0 => rest[semi..].strip_prefix(";base64,").unwrap_or(url),
        _ => url,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_like_the_ts_side() {
        // Values computed with the TS `hash`.
        assert_eq!(hash(""), 0);
        assert_eq!(hash("a"), 97);
        assert_eq!(hash("hello"), 99162322);
        // Overflow wraps as `| 0` does, and the id takes the absolute value
        // without overflowing on i32::MIN.
        assert_eq!((i32::MIN as i64).abs(), 2147483648);
    }

    #[test]
    fn strips_only_a_base64_data_prefix() {
        assert_eq!(strip_data_prefix("data:image/png;base64,AAAA"), "AAAA");
        assert_eq!(strip_data_prefix("data:;base64,AAAA"), "data:;base64,AAAA");
        assert_eq!(strip_data_prefix("https://x/y.png"), "https://x/y.png");
    }
}
