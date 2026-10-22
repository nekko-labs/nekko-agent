//! Chat turns for the engine daemon (PF14): the Rust agent loop (`nekko-loop`)
//! run against the Rust providers (`nekko-agent`).
//!
//! This first part is the seam between them: [`ProviderClient`] makes any
//! provider a loop [`ModelClient`](nekko_loop::ModelClient). The loop speaks the
//! TS JSON shapes (`ChatMessage`, `ToolSpec`); the providers take typed
//! requests, so each call converts at the boundary. A run's [`Cancel`] fires the
//! provider's `AbortController`, which closes the request at once rather than
//! at the next chunk.

use nekko_agent::{
    AbortController, AnyProvider, ChatMessage, ChatRequest, EffortLevel, HeadersHook, Provider, ProviderChunk, ToolSpec,
};
use nekko_loop::{Cancel, Chunk, ChunkStream, ModelClient};
use serde_json::Value;

mod shielded;
pub use shielded::{ShieldedClient, ShieldedStream, redact_request};

/// A provider, as the agent loop's model client.
#[derive(Clone)]
pub struct ProviderClient {
    provider: AnyProvider,
    on_headers: Option<HeadersHook>,
}

impl ProviderClient {
    pub fn new(provider: AnyProvider) -> Self {
        Self { provider, on_headers: None }
    }

    /// Hand every response's headers to `hook` (an Anthropic subscription's rate limits).
    pub fn with_headers(provider: AnyProvider, hook: HeadersHook) -> Self {
        Self { provider, on_headers: Some(hook) }
    }
}

/// A provider's chunk stream, as the loop's.
pub struct ProviderStream(nekko_agent::ChunkStream);

impl ChunkStream for ProviderStream {
    async fn next(&mut self) -> Option<Result<Chunk, String>> {
        let item = self.0.next().await?;
        Some(item.map_err(|e| e.message).map(|chunk| match chunk {
            ProviderChunk::Phase { phase } => Chunk::Phase(phase),
            ProviderChunk::Text { delta } => Chunk::Text(delta),
            ProviderChunk::Reasoning { delta } => Chunk::Reasoning(delta),
            ProviderChunk::ToolCall { call } => Chunk::ToolCall(serde_json::to_value(call).unwrap_or(Value::Null)),
            ProviderChunk::Usage { input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, output_ms } => {
                Chunk::Usage {
                    input_tokens: input_tokens as f64,
                    cache_read_tokens: cache_read_tokens.map(|n| n as f64),
                    cache_write_tokens: cache_write_tokens.map(|n| n as f64),
                    output_tokens: output_tokens as f64,
                    output_ms: output_ms.map(|ms| ms as f64),
                }
            }
            ProviderChunk::Done => Chunk::Done,
        }))
    }
}

fn parse<T: serde::de::DeserializeOwned>(what: &str, values: Vec<Value>) -> Result<Vec<T>, String> {
    values.into_iter().map(|v| serde_json::from_value(v).map_err(|e| format!("{what}: {e}"))).collect()
}

impl ModelClient for ProviderClient {
    type Stream = ProviderStream;

    async fn chat(&self, req: nekko_loop::ChatRequest, cancel: Cancel) -> Result<ProviderStream, String> {
        let messages: Vec<ChatMessage> = parse("a message the provider cannot read", req.messages)?;
        let tools: Vec<ToolSpec> = parse("a tool spec the provider cannot read", req.tools)?;
        let effort = match req.effort {
            Some(e) => Some(
                serde_json::from_value::<EffortLevel>(Value::String(e.clone()))
                    .map_err(|_| format!("unknown effort {e}"))?,
            ),
            None => None,
        };
        let controller = AbortController::new();
        let signal = controller.signal();
        // The loop's Cancel holds the controller until the run ends, and fires it
        // the moment the user stops, even mid-prompt with no chunk in sight.
        cancel.on_cancel(move || controller.abort());
        let request = ChatRequest {
            model: req.model,
            messages,
            system: Some(req.system),
            // The TS loop always sends its tool list, empty on the wrap-up pass.
            tools: Some(tools),
            temperature: req.temperature,
            effort,
            think: req.think,
            prompt_caching: Some(req.prompt_caching.unwrap_or(true)),
            max_output_tokens: req.max_output_tokens,
            signal: Some(signal),
            on_headers: self.on_headers.clone(),
            ..Default::default()
        };
        Ok(ProviderStream(self.provider.chat(request)))
    }
}
