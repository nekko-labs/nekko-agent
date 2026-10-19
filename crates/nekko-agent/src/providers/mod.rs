//! One module per wire protocol, as in `packages/core/src/providers`.

pub mod anthropic;
pub mod chatgpt;
pub mod claude_code;
pub mod ollama;
pub mod openai_compat;
mod prompt_caching;

use crate::http::{ReqwestTransport, Transport};
use crate::js;
use crate::stream::{Clock, system_clock};
use serde_json::Value;
use std::sync::Arc;

/// What a provider talks through: the wire and the clock. Swapped out in tests.
#[derive(Clone)]
pub struct Io {
    pub transport: Arc<dyn Transport>,
    pub clock: Clock,
}

impl Default for Io {
    fn default() -> Self {
        Self { transport: ReqwestTransport::shared(), clock: system_clock() }
    }
}

/// `friendlyError`: turn a fetch failure into guidance, by its message as
/// the TS side does. `unreachable` is the provider's own sentence.
pub(crate) fn friendly_error(message: &str, unreachable: impl FnOnce() -> String) -> String {
    let lower = message.to_lowercase();
    if lower.contains("abort") {
        return "Request cancelled.".into();
    }
    if ["econnrefused", "fetch failed", "failed to fetch", "enotfound", "etimedout", "network"]
        .iter()
        .any(|p| lower.contains(p))
    {
        return unreachable();
    }
    message.to_string()
}

/// `extractApiError`: an OpenAI-style `{ error: { message } }` body's message,
/// else the first 200 UTF-16 units of the raw text.
pub(crate) fn extract_api_error(text: &str) -> String {
    match js::safe_parse(text).pointer("/error/message") {
        Some(Value::String(m)) => m.clone(),
        _ => js::slice16(text, 200).to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_connection_failures_to_guidance() {
        let reach = || "can't reach".to_string();
        assert_eq!(friendly_error("ECONNREFUSED", reach), "can't reach");
        assert_eq!(friendly_error("The user aborted a request.", reach), "Request cancelled.");
        assert_eq!(friendly_error("This operation was aborted", reach), "Request cancelled.");
        assert_eq!(friendly_error("weird thing", reach), "weird thing");
    }

    #[test]
    fn extracts_the_api_message() {
        assert_eq!(extract_api_error(r#"{"error":{"message":"bad key"}}"#), "bad key");
        assert_eq!(extract_api_error(r#"{"error":{"message":5}}"#), r#"{"error":{"message":5}}"#);
        assert_eq!(extract_api_error(&"x".repeat(300)).len(), 200);
    }
}
