//! Chat turns' model client (PF14): the Rust agent loop (`nekko-loop`) run
//! against the Rust providers (`nekko-agent`).
//!
//! [`ProviderClient`] is the seam between them: it makes any provider a loop
//! [`ModelClient`](nekko_loop::ModelClient). The loop speaks the
//! TS JSON shapes (`ChatMessage`, `ToolSpec`); the providers take typed
//! requests, so each call converts at the boundary. A run's [`Cancel`] fires the
//! provider's `AbortController`, which closes the request at once rather than
//! at the next chunk.

use nekko_agent::{
    AbortController, AnyProvider, ChatMessage, ChatRequest, EffortLevel, HeadersHook, Provider, ProviderChunk, ToolSpec,
};
use nekko_loop::{Cancel, Chunk, ChunkStream, ModelClient};
use nekko_privacy::{Restorer, SYSTEM_NOTE, Shield};
use serde_json::Value;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

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

// Privacy Shield on the agent loop: a `ModelClient` that sends its inner
// client every request with private values swapped for placeholders, and
// puts the real values back into what streams in (text, reasoning and tool
// call arguments) before the loop sees it. The loop, the tools and the
// transcript never meet a placeholder; only the provider does.
//
// One shield lives for a whole reply, so a value keeps its placeholder from
// the first request to the last, and the prompt prefix stays cacheable.

fn lock(shield: &Mutex<Shield>) -> std::sync::MutexGuard<'_, Shield> {
    shield.lock().unwrap_or_else(|e| e.into_inner())
}

/// A model client behind an optional shield: with none, it is the inner client.
pub struct ShieldedClient<C> {
    inner: C,
    shield: Option<Arc<Mutex<Shield>>>,
}

impl<C> ShieldedClient<C> {
    pub fn new(inner: C, shield: Option<Arc<Mutex<Shield>>>) -> Self {
        Self { inner, shield }
    }

    #[cfg(test)]
    pub fn inner(&self) -> &C {
        &self.inner
    }
}

/// `req` as the provider should see it.
pub fn redact_request(shield: &mut Shield, mut req: nekko_loop::ChatRequest) -> nekko_loop::ChatRequest {
    // Placeholder-shaped text already in the chat is reserved before any
    // value is handed one, so restoring can never rewrite it.
    shield.reserve(&req.system);
    for m in &req.messages {
        shield.reserve_message(m);
    }
    req.system = shield.redact(&req.system);
    req.system.push_str(SYSTEM_NOTE);
    for m in &mut req.messages {
        shield.redact_message(m);
    }
    req
}

impl<C: ModelClient> ModelClient for ShieldedClient<C> {
    type Stream = ShieldedStream<C::Stream>;

    async fn chat(&self, req: nekko_loop::ChatRequest, cancel: Cancel) -> Result<Self::Stream, String> {
        let req = match &self.shield {
            Some(shield) => redact_request(&mut lock(shield), req),
            None => req,
        };
        let inner = self.inner.chat(req, cancel).await?;
        Ok(ShieldedStream::new(inner, self.shield.clone()))
    }
}

/// The inner stream with its placeholders put back.
pub struct ShieldedStream<S> {
    inner: S,
    shield: Option<Arc<Mutex<Shield>>>,
    text: Restorer,
    reasoning: Restorer,
    /// Items ready to hand out: a held-back tail goes ahead of the chunk or
    /// error that ended it.
    ready: VecDeque<Result<Chunk, String>>,
    ended: bool,
}

impl<S> ShieldedStream<S> {
    fn new(inner: S, shield: Option<Arc<Mutex<Shield>>>) -> Self {
        Self {
            inner,
            shield,
            text: Restorer::default(),
            reasoning: Restorer::default(),
            ready: VecDeque::new(),
            ended: false,
        }
    }

    /// Text and reasoning still held back, as chunks.
    fn flush(&mut self, shield: &Shield) {
        let text = self.text.flush(shield);
        if !text.is_empty() {
            self.ready.push_back(Ok(Chunk::Text(text)));
        }
        let reasoning = self.reasoning.flush(shield);
        if !reasoning.is_empty() {
            self.ready.push_back(Ok(Chunk::Reasoning(reasoning)));
        }
    }
}

impl<S: ChunkStream> ChunkStream for ShieldedStream<S> {
    async fn next(&mut self) -> Option<Result<Chunk, String>> {
        let Some(shield) = self.shield.clone() else { return self.inner.next().await };
        loop {
            if let Some(item) = self.ready.pop_front() {
                return Some(item);
            }
            if self.ended {
                return None;
            }
            let item = self.inner.next().await;
            let shield = lock(&shield);
            match item {
                None => {
                    self.ended = true;
                    self.flush(&shield);
                }
                // An error ends the response; a provider may quote the request in it.
                Some(Err(e)) => {
                    self.ended = true;
                    self.flush(&shield);
                    self.ready.push_back(Err(shield.restore(&e)));
                }
                Some(Ok(Chunk::Text(delta))) => {
                    let out = self.text.push(&shield, &delta);
                    if !out.is_empty() {
                        return Some(Ok(Chunk::Text(out)));
                    }
                }
                Some(Ok(Chunk::Reasoning(delta))) => {
                    let out = self.reasoning.push(&shield, &delta);
                    if !out.is_empty() {
                        return Some(Ok(Chunk::Reasoning(out)));
                    }
                }
                Some(Ok(Chunk::ToolCall(mut call))) => {
                    self.flush(&shield);
                    if let Some(input) = call.get_mut("input") {
                        shield.restore_value(input);
                    }
                    self.ready.push_back(Ok(Chunk::ToolCall(call)));
                }
                Some(Ok(other)) => {
                    self.flush(&shield);
                    self.ready.push_back(Ok(other));
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "chat_client_tests.rs"]
mod tests;
