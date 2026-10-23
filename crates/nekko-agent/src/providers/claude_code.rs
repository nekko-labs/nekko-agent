//! The Claude Agent provider (`claude-code`): the user's own Claude Code
//! runs these chats (nekkod drives it through `nekko-harness`), so this
//! provider has no wire. It lists Claude Code's model aliases for the picker
//! and refuses a direct chat: Nekko never calls a model with credentials
//! that belong to Claude Code.

use crate::stream::{ChunkStream, Stop, spawn};
use crate::types::{ChatRequest, ModelInfo, ProviderConfig, ProviderError, TestResult};

/// Claude Code's model aliases (`--model`). The full id a session runs on
/// comes back in its `system/init`.
pub const MODEL_ALIASES: &[(&str, &str)] =
    &[("opus", "Claude Opus"), ("sonnet", "Claude Sonnet"), ("haiku", "Claude Haiku")];

/// What a direct chat on this provider answers.
pub const NOT_A_MODEL_API: &str =
    "Claude subscription chats run in your installed Claude Code, not through a model API.";

#[derive(Clone)]
pub struct ClaudeCodeProvider {
    config: ProviderConfig,
}

impl ClaudeCodeProvider {
    pub fn new(config: ProviderConfig) -> Self {
        Self { config }
    }

    pub fn config(&self) -> &ProviderConfig {
        &self.config
    }

    pub async fn list_models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        Ok(MODEL_ALIASES
            .iter()
            .map(|(id, name)| ModelInfo {
                id: (*id).into(),
                provider_id: self.config.id.clone(),
                name: (*name).into(),
                ..Default::default()
            })
            .collect())
    }

    pub fn chat(&self, req: ChatRequest) -> ChunkStream {
        spawn(req.signal, |_sink| async { Err(Stop::Failed(ProviderError::new(NOT_A_MODEL_API))) })
    }

    /// Whether Claude Code is installed and signed in is nekkod's check
    /// (`claude auth status`); there is no endpoint to test here.
    pub async fn test(&self) -> TestResult {
        TestResult::ok("Your Claude subscription runs through your installed Claude Code.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ProviderChunk;
    use serde_json::json;

    fn provider() -> ClaudeCodeProvider {
        ClaudeCodeProvider::new(
            serde_json::from_value(json!({ "id": "cc", "kind": "claude-code", "baseUrl": "", "enabled": true }))
                .unwrap(),
        )
    }

    #[tokio::test]
    async fn lists_the_aliases_and_never_chats() {
        let p = provider();
        let ids: Vec<String> = p.list_models().await.unwrap().into_iter().map(|m| m.id).collect();
        assert_eq!(ids, ["opus", "sonnet", "haiku"]);
        let req: ChatRequest = serde_json::from_value(json!({ "model": "opus", "messages": [] })).unwrap();
        let (chunks, err): (Vec<ProviderChunk>, _) = p.chat(req).collect().await;
        assert!(chunks.is_empty());
        assert_eq!(err.unwrap().message, NOT_A_MODEL_API);
    }
}
