//! ChatGPT-plan models through the Codex backend: the Responses API over SSE
//! at `{baseUrl}/codex/responses`. A port of `chatgpt.ts`.
//!
//! Only usable with a subscription token. The OAuth sign-in and refresh stay
//! in the TS host, which passes the fresh access token as `config.api_key`
//! and the ChatGPT account id as `config.account_id`.

use super::{CATALOG_TIMEOUT, Io, friendly_error};
use crate::http::HttpRequest;
use crate::js;
use crate::sse::SseParser;
use crate::stream::{ChunkStream, DecodeClock, Sink, Stop, spawn};
use crate::types::*;
use serde_json::{Map, Value, json};

/// Last-known subscription model set, used only when the live catalog cannot
/// be fetched (offline, unsigned, backend down). The Codex backend retired the
/// gpt-5/codex ids in 2026, so this mirrors the current picker generation.
const CHATGPT_MODELS: &[(&str, &str, u64)] = &[
    ("gpt-6.1-sol", "GPT-6.1 Sol", 0),
    ("gpt-6-sol", "GPT-6 Sol", 0),
    ("gpt-6-luna", "GPT-6 Luna", 0),
    ("gpt-6-astra", "GPT-6 Astra", 0),
    ("gpt-5.6-sol", "GPT-5.6 Sol", 272_000),
    ("gpt-5.6-terra", "GPT-5.6 Terra", 272_000),
    ("gpt-5.6-luna", "GPT-5.6 Luna", 272_000),
];

/// The backend filters the catalog by the Codex CLI version a client reports;
/// unversioned and stale versions get a truncated or empty list. Raise this
/// when the backend starts gating newer entries behind a higher line.
const CODEX_CLIENT_VERSION: &str = "0.160.0";

/// Required for Responses-API streaming on the Codex backend.
const RESPONSES_BETA: &str = "responses=experimental";
/// What the first-party Codex CLI sends.
const ORIGINATOR: &str = "codex_cli_rs";

const MISSING_ACCOUNT_ID: &str = "This ChatGPT sign-in is missing an account id. Sign out and sign in again so it can be captured (sessions signed in before this version may lack one).";

#[derive(Clone)]
pub struct ChatGptProvider {
    config: ProviderConfig,
    io: Io,
    /// One per provider instance (about one agent run): scopes a conversation
    /// for the backend's caching.
    session_id: String,
}

impl ChatGptProvider {
    pub fn new(config: ProviderConfig, io: Io) -> Self {
        Self { config, io, session_id: uuid_v4() }
    }

    pub fn config(&self) -> &ProviderConfig {
        &self.config
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    fn base(&self) -> &str {
        js::trim(&self.config.base_url).trim_end_matches('/')
    }

    /// Fails without an account id: the backend 401s without it, and a clear
    /// sign-in-again error beats a cryptic upstream rejection.
    fn headers(&self) -> Result<Vec<(String, String)>, ProviderError> {
        let account = self.config.account_id.as_deref().filter(|a| !a.is_empty());
        let account = account.ok_or_else(|| ProviderError::new(MISSING_ACCOUNT_ID))?;
        let key = self.config.api_key.as_deref().unwrap_or("");
        Ok(vec![
            ("Content-Type".into(), "application/json".into()),
            ("Authorization".into(), format!("Bearer {key}")),
            ("chatgpt-account-id".into(), account.into()),
            ("OpenAI-Beta".into(), RESPONSES_BETA.into()),
            ("originator".into(), ORIGINATOR.into()),
            ("session_id".into(), self.session_id.clone()),
        ])
    }

    /// The request `chat` sends.
    pub fn chat_request(&self, req: &ChatRequest) -> Result<HttpRequest, ProviderError> {
        let mut body = Map::new();
        body.insert("model".into(), json!(req.model));
        if let Some(system) = &req.system {
            body.insert("instructions".into(), json!(system));
        }
        body.insert("input".into(), Value::Array(to_response_items(req)));
        if let Some(tools) = &req.tools {
            let tools = tools
                .iter()
                .map(|t| json!({ "type": "function", "name": t.name, "description": t.description, "parameters": t.parameters }))
                .collect();
            body.insert("tools".into(), Value::Array(tools));
        }
        body.insert("stream".into(), json!(true));
        body.insert("store".into(), json!(false));
        // With `store: false` the reasoning is gone after each call unless it
        // comes back encrypted and is replayed (see `to_response_items`).
        body.insert("include".into(), json!(["reasoning.encrypted_content"]));
        // The Codex backend accepts only the Codex CLI's request shape:
        // `temperature` and `max_output_tokens` are not in it and fail the
        // whole request with a 400 ("Unsupported parameter"), so the effort
        // setting goes out as `reasoning.effort` instead and this provider
        // sends no output cap. `normal` means the model's own default, so no
        // rung is sent for it; the rungs above Codex's ladder clamp to high.
        let mut reasoning = Map::new();
        match crate::claude::effective_effort(req.effort, &req.model) {
            EffortLevel::Low => {
                reasoning.insert("effort".into(), json!("low"));
            }
            EffortLevel::Medium => {
                reasoning.insert("effort".into(), json!("medium"));
            }
            EffortLevel::High | EffortLevel::Xhigh | EffortLevel::Max => {
                reasoning.insert("effort".into(), json!("high"));
            }
            EffortLevel::Normal => {}
        }
        // Cloud reasoning stays on, including for callers carrying a legacy off flag.
        reasoning.insert("summary".into(), json!("auto"));
        if !reasoning.is_empty() {
            body.insert("reasoning".into(), Value::Object(reasoning));
        }
        Ok(HttpRequest::post(format!("{}/codex/responses", self.base()), self.headers()?, Value::Object(body)))
    }

    pub fn chat(&self, req: ChatRequest) -> ChunkStream {
        let me = self.clone();
        spawn(req.signal.clone(), move |sink| async move { me.run(req, sink).await })
    }

    async fn run(self, req: ChatRequest, sink: Sink) -> Result<(), Stop> {
        let http = self.chat_request(&req)?;
        let mut res = match sink.send(&*self.io.transport, &http).await? {
            Ok(res) => res,
            Err(e) => {
                let reach = || format!("Can't reach ChatGPT at {}. Check the network connection.", self.base());
                return Err(ProviderError::new(friendly_error(&e.message, reach)).into());
            }
        };
        // Before the status check: a 429's headers carry the limit that was hit.
        if let Some(hook) = &req.on_headers {
            hook(&res.headers);
        }
        if !res.ok() {
            let text = sink.text(&mut res).await?;
            let message = format!("chatgpt {}: {}", res.status, js::slice16(&text, 200));
            return Err(ProviderError::http(res.status, message).into());
        }

        // From the first generated delta to the event that reports usage.
        let mut decode = DecodeClock::new(self.io.clock.clone());
        let mut sse = SseParser::default();
        while let Some(bytes) = sink.read(&mut res).await? {
            let batch = sse.feed(&bytes);
            for data in &batch.data {
                let Ok(ev) = serde_json::from_str::<Value>(data) else { continue };
                match ev.get("type").and_then(Value::as_str) {
                    // The model has started generating an item (hidden
                    // reasoning, a tool call): time it from here, or a step
                    // with no visible text measures as instant.
                    Some("response.output_item.added" | "response.function_call_arguments.delta") => decode.mark(),
                    Some("response.output_text.delta") => {
                        if let Some(d) = js::truthy_str(ev.get("delta")) {
                            decode.mark();
                            sink.emit(ProviderChunk::Text { delta: d.to_string() }).await?;
                        }
                    }
                    Some("response.reasoning_summary_text.delta") => {
                        if let Some(d) = js::truthy_str(ev.get("delta")) {
                            decode.mark();
                            sink.emit(ProviderChunk::Reasoning { delta: d.to_string() }).await?;
                        }
                    }
                    Some("response.output_item.done") => {
                        let item = ev.get("item");
                        if item.and_then(|i| i.get("type")).and_then(Value::as_str) == Some("message")
                            && let Some(phase @ ("commentary" | "final_answer")) =
                                item.and_then(|i| i.get("phase")).and_then(Value::as_str)
                        {
                            sink.emit(ProviderChunk::Phase { phase: phase.to_string() }).await?;
                        }
                        if item.and_then(|i| i.get("type")).and_then(Value::as_str) == Some("reasoning")
                            && let Some(item) = item.filter(|i| i.get("encrypted_content").is_some())
                        {
                            sink.emit(ProviderChunk::Carry { item: item.clone() }).await?;
                        }
                        if item.and_then(|i| i.get("type")).and_then(Value::as_str) == Some("function_call") {
                            decode.mark();
                            let item = item.unwrap_or(&Value::Null);
                            let id = js::coalesce(item.get("call_id"), item.get("id")).map(js::display);
                            let args = item.get("arguments").and_then(Value::as_str).unwrap_or("");
                            let call = ToolCall {
                                id: id.unwrap_or_default(),
                                name: item.get("name").map(js::display).unwrap_or_default(),
                                input: js::safe_parse(args),
                            };
                            sink.emit(ProviderChunk::ToolCall { call }).await?;
                        }
                    }
                    // `incomplete`: hit the output cap (or another length
                    // stop). Keep what streamed, and end the same way.
                    Some("response.completed" | "response.incomplete") => {
                        decode.stop();
                        if let Some(usage) = ev.pointer("/response/usage").filter(|u| js::truthy(Some(u))) {
                            let (input_tokens, cache_read_tokens, cache_write_tokens) =
                                super::prompt_caching::usage(usage, "input_tokens");
                            sink.emit(ProviderChunk::Usage {
                                input_tokens,
                                cache_read_tokens,
                                cache_write_tokens,
                                output_tokens: usage.get("output_tokens").and_then(Value::as_u64).unwrap_or(0),
                                output_ms: decode.elapsed(),
                            })
                            .await?;
                        }
                        return sink.emit(ProviderChunk::Done).await;
                    }
                    Some("response.failed" | "error") => {
                        let message =
                            [ev.pointer("/response/error/message"), ev.pointer("/error/message"), ev.get("message")]
                                .into_iter()
                                .find(|v| !js::nullish(*v))
                                .flatten()
                                .map(js::display)
                                .unwrap_or_else(|| "unknown error".into());
                        return Err(ProviderError::new(format!("chatgpt response failed: {message}")).into());
                    }
                    _ => {}
                }
            }
            if batch.done {
                break;
            }
        }
        sink.emit(ProviderChunk::Done).await
    }

    /// Headers for the catalog GET: same subscription auth as chat, but no
    /// `OpenAI-Beta`/`session_id`, which are Responses-API concerns. None when
    /// the sign-in is incomplete, so the caller falls back to the curated list.
    fn catalog_headers(&self) -> Option<Vec<(String, String)>> {
        let key = self.config.api_key.as_deref().filter(|k| !k.is_empty())?;
        let account = self.config.account_id.as_deref().filter(|a| !a.is_empty())?;
        Some(vec![
            ("Accept".into(), "application/json".into()),
            ("Authorization".into(), format!("Bearer {key}")),
            ("chatgpt-account-id".into(), account.into()),
            ("originator".into(), ORIGINATOR.into()),
        ])
    }

    /// The request `fetch_catalog` sends: `GET {base}/codex/models`, the same
    /// route the Codex CLI's models manager reads.
    fn catalog_request(&self) -> Option<HttpRequest> {
        Some(HttpRequest::get(
            format!("{}/codex/models?client_version={CODEX_CLIENT_VERSION}", self.base()),
            self.catalog_headers()?,
        ))
    }

    /// The live subscription catalog. The backend filters it by the
    /// `client_version` we report, the account's plan, and active rollouts, so
    /// the answer is exactly the set this sign-in can run — including models
    /// that did not exist when this build shipped. None on any failure, or
    /// after `CATALOG_TIMEOUT`, so the caller falls back to the curated list.
    async fn fetch_catalog(&self) -> Option<Vec<ModelInfo>> {
        let req = self.catalog_request()?;
        let fetch = async {
            let mut res = self.io.transport.send(&req).await.ok()?;
            if !res.ok() {
                return None;
            }
            Some(res.text().await)
        };
        let text = tokio::time::timeout(CATALOG_TIMEOUT, fetch).await.ok()??;
        let json: Value = serde_json::from_str(&text).ok()?;
        let rows = json.get("models").and_then(Value::as_array)?;
        let mut scored: Vec<(i64, usize, ModelInfo)> = rows
            .iter()
            .enumerate()
            .filter_map(|(order, m)| {
                let id = js::coalesce(m.get("slug"), m.get("id")).filter(|v| js::truthy(Some(v))).map(js::display)?;
                // The picker list is authoritative for what this account may
                // run; hidden or unpicked entries stay out of ours.
                if m.get("visibility").and_then(Value::as_str).is_some_and(|v| v != "list") {
                    return None;
                }
                if m.get("show_in_picker").and_then(Value::as_bool) == Some(false) {
                    return None;
                }
                let name = js::coalesce(m.get("display_name"), m.get("name"))
                    .filter(|v| js::truthy(Some(v)))
                    .map(js::display)
                    .unwrap_or_else(|| id.clone());
                let ctx = js::coalesce(m.get("context_window"), m.get("max_context_window")).and_then(Value::as_u64);
                let priority = m.get("priority").and_then(Value::as_i64).unwrap_or(i64::MAX);
                Some((
                    priority,
                    order,
                    ModelInfo {
                        id,
                        provider_id: self.config.id.clone(),
                        name,
                        context_length: ctx,
                        ..Default::default()
                    },
                ))
            })
            .collect();
        scored.sort_by_key(|(priority, order, _)| (*priority, *order));
        let models: Vec<ModelInfo> = scored.into_iter().map(|(_, _, m)| m).collect();
        (!models.is_empty()).then_some(models)
    }

    /// `test()`: a real check, the catalog route, which needs the same auth
    /// and account as chat.
    pub async fn test(&self) -> TestResult {
        if self.config.api_key.as_deref().is_none_or(str::is_empty) {
            return TestResult::fail("Not signed in. Sign in with ChatGPT in the provider settings.");
        }
        let Some(req) = self.catalog_request() else { return TestResult::fail(MISSING_ACCOUNT_ID) };
        let mut res = match self.io.transport.send(&req).await {
            Ok(res) => res,
            Err(e) => {
                let reach = || format!("Can't reach ChatGPT at {}. Check the network connection.", self.base());
                return TestResult::fail(friendly_error(&e.message, reach));
            }
        };
        if !res.ok() {
            let text = res.text().await;
            return TestResult::fail(format!("chatgpt {}: {}", res.status, js::slice16(&text, 200)));
        }
        TestResult::ok("Signed in with a ChatGPT subscription")
    }

    pub async fn list_models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        let mut all = self.fetch_catalog().await.unwrap_or_else(|| {
            CHATGPT_MODELS
                .iter()
                .map(|(id, name, ctx)| ModelInfo {
                    id: id.to_string(),
                    provider_id: self.config.id.clone(),
                    name: name.to_string(),
                    context_length: (*ctx > 0).then_some(*ctx),
                    fallback: true,
                    ..Default::default()
                })
                .collect()
        });
        offer_latest_known_model(&mut all, &self.config.id);
        let custom = self.config.custom_model_id.as_deref().map(js::trim).filter(|c| !c.is_empty());
        if let Some(custom) = custom
            && !all.iter().any(|m| m.id == custom)
        {
            all.push(ModelInfo {
                id: custom.to_string(),
                provider_id: self.config.id.clone(),
                name: format!("{custom} (custom)"),
                // An arbitrary custom id has no known window; do not invent 128k.
                context_length: None,
                ..Default::default()
            });
        }
        Ok(all)
    }
}

// A live catalog can lag a backend rollout. Let the user try the latest known
// id, but do not present its absence from their account's catalog as access.
fn offer_latest_known_model(models: &mut Vec<ModelInfo>, provider_id: &str) {
    if models.iter().any(|m| m.id == "gpt-6.1-sol") {
        return;
    }
    models.push(ModelInfo {
        id: "gpt-6.1-sol".into(),
        provider_id: provider_id.into(),
        name: "GPT-6.1 Sol".into(),
        availability: Some(json!({
            "status": "ready",
            "detail": "Not listed for this account. You can try it, but the provider may reject it."
        })),
        ..Default::default()
    });
}

/// Map normalized chat history onto Responses API input items. A `system`
/// message in history is covered by `instructions` and dropped here.
fn to_response_items(req: &ChatRequest) -> Vec<Value> {
    let mut out = Vec::new();
    for m in &crate::types::with_tool_images(&req.messages) {
        if let (Role::Tool, Some(r)) = (m.role, &m.tool_result) {
            out.push(json!({ "type": "function_call_output", "call_id": r.tool_call_id, "output": r.output }));
        } else if m.role == Role::Assistant {
            // Encrypted reasoning comes back before the message it led to, and
            // only to the model that wrote it.
            if let Some(carry) =
                m.extra.get("carry").filter(|c| c.get("model").and_then(Value::as_str) == Some(req.model.as_str()))
            {
                out.extend(carry.get("items").and_then(Value::as_array).into_iter().flatten().cloned());
            }
            if !m.content.is_empty() {
                out.push(json!({
                    "type": "message",
                    "role": "assistant",
                    "phase": m.extra.get("phase").and_then(Value::as_str).unwrap_or(if m.tool_calls.as_ref().is_some_and(|c| !c.is_empty()) { "commentary" } else { "final_answer" }),
                    "content": [{ "type": "output_text", "text": m.content }],
                }));
            }
            for c in m.tool_calls.iter().flatten() {
                out.push(json!({
                    "type": "function_call",
                    "call_id": c.id,
                    "name": c.name,
                    "arguments": js::stringify(&c.input),
                }));
            }
        } else if m.role == Role::User {
            let mut content = vec![json!({ "type": "input_text", "text": m.content })];
            for url in m.images.iter().flatten() {
                content.push(json!({ "type": "input_image", "image_url": url }));
            }
            out.push(json!({ "type": "message", "role": "user", "content": content }));
        }
    }
    out
}

/// A random (version 4) UUID, as `crypto.randomUUID()` makes.
fn uuid_v4() -> String {
    let mut b = [0u8; 16];
    // Without entropy the id is still unique enough for a cache scope.
    if getrandom::fill(&mut b).is_err() {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
        b = nanos.to_le_bytes();
    }
    b[6] = (b[6] & 0x0F) | 0x40;
    b[8] = (b[8] & 0x3F) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    fn items(model: &str) -> Vec<serde_json::Value> {
        let req: crate::types::ChatRequest = serde_json::from_value(json!({
            "model": model,
            "messages": [
                { "id": "u", "role": "user", "content": "go", "createdAt": 1 },
                { "id": "a", "role": "assistant", "content": "", "createdAt": 2,
                  "toolCalls": [{ "id": "c", "name": "bash", "input": {} }],
                  "carry": { "model": "gpt-6.1-sol", "items": [{ "type": "reasoning", "encrypted_content": "x" }] } },
            ],
        }))
        .unwrap();
        super::to_response_items(&req)
    }

    #[test]
    fn offers_latest_id_without_overriding_live_catalog_or_promising_access() {
        let mut live = vec![super::ModelInfo { id: "gpt-6-sol".into(), name: "Live Sol".into(), ..Default::default() }];
        super::offer_latest_known_model(&mut live, "chatgpt");
        assert_eq!(live.len(), 2);
        assert_eq!(live[0].name, "Live Sol");
        assert_eq!(live[1].id, "gpt-6.1-sol");
        assert_eq!(live[1].provider_id, "chatgpt");
        assert!(live[1].availability.as_ref().unwrap()["detail"].as_str().unwrap().contains("may reject"));
        super::offer_latest_known_model(&mut live, "chatgpt");
        assert_eq!(live.len(), 2);
    }

    #[test]
    fn replays_encrypted_reasoning_before_the_call_it_led_to() {
        let kinds: Vec<_> = items("gpt-6.1-sol").iter().map(|i| i["type"].as_str().unwrap().to_string()).collect();
        assert_eq!(kinds, ["message", "reasoning", "function_call"]);
    }

    #[test]
    fn keeps_reasoning_from_another_model_out() {
        assert!(items("gpt-6-luna").iter().all(|i| i["type"] != "reasoning"));
    }

    #[test]
    fn makes_v4_uuids() {
        let id = super::uuid_v4();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
        assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"));
        assert_ne!(id, super::uuid_v4());
    }
}
