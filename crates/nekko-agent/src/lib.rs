//! Model providers for the engine daemon, ported from
//! `packages/core/src/providers`: the first half of moving the agent loop out
//! of the TS host (PF14, "providers + agent loop").
//!
//! Four wire protocols cover every provider kind: OpenAI-compatible chat
//! completions (OpenAI, OpenRouter, LM Studio, vLLM, the Nekko engine, generic
//! servers), the Anthropic Messages API, Ollama's native API, and the ChatGPT
//! subscription's Codex Responses API. Each builds the exact request its TS
//! counterpart sends and yields the exact chunk sequence it yields, which
//! `tests/golden.rs` checks against recordings the TS providers wrote
//! (`packages/core/src/providers/providers.golden.test.ts`).
//!
//! What is not here yet, on purpose: OAuth sign-in and token refresh (the
//! host passes a ready token in the config), connection tests, Ollama model
//! pulls and loads, and local-server discovery. Nothing calls this crate yet;
//! the agent loop port will.

pub mod claude;
pub mod http;
/// The JavaScript rules the providers follow, shared with the other ports.
pub use nekko_js as js;
pub mod providers;
mod sse;
pub mod stream;
pub mod types;

pub use http::{AbortController, AbortSignal};
pub use providers::Io;
pub use providers::anthropic::AnthropicProvider;
pub use providers::chatgpt::ChatGptProvider;
pub use providers::ollama::OllamaProvider;
pub use providers::openai_compat::OpenAiCompatProvider;
pub use stream::ChunkStream;
pub use types::*;

use std::future::Future;

/// A model provider: list what it serves, and stream a chat completion.
pub trait Provider: Send + Sync {
    fn config(&self) -> &ProviderConfig;

    fn list_models(&self) -> impl Future<Output = Result<Vec<ModelInfo>, ProviderError>> + Send;

    /// Start a chat. It runs on the tokio runtime and streams into the
    /// returned [`ChunkStream`] until `Done` or an error. Dropping the stream,
    /// or firing `req.signal`, cancels it and closes the connection.
    fn chat(&self, req: ChatRequest) -> ChunkStream;
}

macro_rules! provider {
    ($t:ty) => {
        impl Provider for $t {
            fn config(&self) -> &ProviderConfig {
                self.config()
            }

            fn list_models(&self) -> impl Future<Output = Result<Vec<ModelInfo>, ProviderError>> + Send {
                <$t>::list_models(self)
            }

            fn chat(&self, req: ChatRequest) -> ChunkStream {
                <$t>::chat(self, req)
            }
        }
    };
}

provider!(OpenAiCompatProvider);
provider!(AnthropicProvider);
provider!(OllamaProvider);
provider!(ChatGptProvider);

/// Any provider, picked by kind (`createProvider`).
#[derive(Clone)]
pub enum AnyProvider {
    OpenAiCompat(OpenAiCompatProvider),
    Anthropic(AnthropicProvider),
    Ollama(OllamaProvider),
    ChatGpt(ChatGptProvider),
}

impl Provider for AnyProvider {
    fn config(&self) -> &ProviderConfig {
        match self {
            Self::OpenAiCompat(p) => p.config(),
            Self::Anthropic(p) => p.config(),
            Self::Ollama(p) => p.config(),
            Self::ChatGpt(p) => p.config(),
        }
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        match self {
            Self::OpenAiCompat(p) => p.list_models().await,
            Self::Anthropic(p) => p.list_models().await,
            Self::Ollama(p) => p.list_models().await,
            Self::ChatGpt(p) => p.list_models().await,
        }
    }

    fn chat(&self, req: ChatRequest) -> ChunkStream {
        match self {
            Self::OpenAiCompat(p) => p.chat(req),
            Self::Anthropic(p) => p.chat(req),
            Self::Ollama(p) => p.chat(req),
            Self::ChatGpt(p) => p.chat(req),
        }
    }
}

impl AnyProvider {
    /// `test()`: the connection check the Providers settings run.
    pub async fn test(&self) -> TestResult {
        match self {
            Self::OpenAiCompat(p) => p.test().await,
            Self::Anthropic(p) => p.test().await,
            Self::Ollama(p) => p.test().await,
            Self::ChatGpt(p) => p.test().await,
        }
    }
}

/// Build a provider from its stored config, on the real wire.
pub fn create_provider(config: ProviderConfig) -> AnyProvider {
    create_provider_with(config, Io::default())
}

/// Build a provider from its stored config, on the given wire and clock.
pub fn create_provider_with(config: ProviderConfig, io: Io) -> AnyProvider {
    match config.kind {
        // The cloud platforms serve the same Messages API shape, so they are the same provider.
        ProviderKind::Anthropic | ProviderKind::Bedrock | ProviderKind::Vertex | ProviderKind::Foundry => {
            AnyProvider::Anthropic(AnthropicProvider::new(config, io))
        }
        ProviderKind::Ollama => AnyProvider::Ollama(OllamaProvider::new(config, io)),
        ProviderKind::Chatgpt => AnyProvider::ChatGpt(ChatGptProvider::new(config, io)),
        // The Nekko engine's router is OpenAI-compatible on purpose, so chat
        // needs no provider of its own.
        ProviderKind::Openai
        | ProviderKind::Openrouter
        | ProviderKind::Lmstudio
        | ProviderKind::Vllm
        | ProviderKind::Llamacpp
        | ProviderKind::OpenaiCompat => AnyProvider::OpenAiCompat(OpenAiCompatProvider::new(config, io)),
    }
}

/// `asSeenByChatModel` (agent/loop.ts): an image chat's picture-only reply,
/// as a chat model receives it. No provider sends assistant images and not
/// every one accepts an empty turn, so it becomes a line saying what was made.
pub fn as_seen_by_chat_model(m: &ChatMessage) -> ChatMessage {
    let Some(g) = &m.generated else { return m.clone() };
    if m.role != Role::Assistant || !js::trim(&m.content).is_empty() {
        return m.clone();
    }
    let field = |k: &str| g.get(k).map(js::display).unwrap_or_else(|| "undefined".into());
    let model = field("modelId");
    let model = model.rsplit('/').next().unwrap_or(&model);
    let mut seen = m.clone();
    seen.content =
        format!("[Generated a {}×{} image with {model}, seed {}.]", field("width"), field("height"), field("seed"));
    seen
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn describes_a_picture_only_reply() {
        let mut img = ChatMessage::new(Role::Assistant, "");
        img.generated =
            Some(json!({ "modelId": "lib/flux-2-klein-9b-Q8_0", "width": 1024, "height": 768, "seed": 42 }));
        assert_eq!(
            as_seen_by_chat_model(&img).content,
            "[Generated a 1024×768 image with flux-2-klein-9b-Q8_0, seed 42.]"
        );
        let text = ChatMessage::new(Role::Assistant, "hi");
        assert_eq!(as_seen_by_chat_model(&text), text);
    }

    #[test]
    fn picks_the_protocol_by_kind() {
        let config = |kind: &str| -> ProviderConfig {
            serde_json::from_value(json!({ "id": "p", "kind": kind, "baseUrl": "http://x", "enabled": true })).unwrap()
        };
        assert!(matches!(create_provider(config("llamacpp")), AnyProvider::OpenAiCompat(_)));
        assert!(matches!(create_provider(config("openai-compat")), AnyProvider::OpenAiCompat(_)));
        assert!(matches!(create_provider(config("anthropic")), AnyProvider::Anthropic(_)));
        assert!(matches!(create_provider(config("ollama")), AnyProvider::Ollama(_)));
        assert!(matches!(create_provider(config("chatgpt")), AnyProvider::ChatGpt(_)));
    }
}
