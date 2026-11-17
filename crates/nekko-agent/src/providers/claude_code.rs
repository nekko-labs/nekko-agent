//! The Claude Agent provider (`claude-code`): the user's own Claude Code
//! runs these chats (nekkod drives it through `nekko-harness`), so this
//! provider has no wire. It lists the concrete Claude models the user can
//! pin on `--model` (newest first, never the family aliases), and refuses a direct
//! chat: Nekko never calls a model with credentials that belong to Claude
//! Code.

use crate::providers::anthropic::CLAUDE_MODELS;
use crate::stream::{ChunkStream, Stop, spawn};
use crate::types::{ChatRequest, ModelEffort, ModelEffortOption, ModelInfo, ProviderConfig, ProviderError, TestResult};

/// The generic family aliases Claude Code accepts on `--model`. They are not
/// offered any more: Claude Code resolves them to the plan's default, which
/// lags the newest release (an "Opus (latest in plan)" row ran an older Opus).
/// Chats saved on one still resolve through [`resolve_alias`].
const FAMILY_ALIASES: [&str; 3] = ["opus", "sonnet", "haiku"];

/// The newest concrete model of a family alias (`opus`, `sonnet`, `haiku`),
/// from the shared Anthropic catalog, which is listed newest first. `None`
/// for anything that is not a bare alias.
pub fn resolve_alias(id: &str) -> Option<&'static str> {
    let id = id.trim().to_ascii_lowercase();
    FAMILY_ALIASES.contains(&id.as_str()).then(|| {
        CLAUDE_MODELS
            .iter()
            .map(|(m, _)| *m)
            .find(|m| m.starts_with(&format!("claude-{id}-")))
    })?
}

/// The id to pass on `--model`: a saved alias becomes the newest concrete
/// model of its family, anything else passes through unchanged.
pub fn concrete_model_id(id: &str) -> String {
    resolve_alias(id).map(str::to_string).unwrap_or_else(|| id.to_string())
}

/// The levels `claude --effort` takes. Claude Code owns this ladder and steps a
/// level down itself on a model that lacks it, so every model offers all of them.
/// No default: an unset chat passes no flag and keeps the user's Claude Code setting.
pub fn effort_levels() -> ModelEffort {
    let levels = ["low", "medium", "high", "xhigh", "max"];
    ModelEffort {
        levels: levels.map(|e| ModelEffortOption { effort: e.into(), description: None }).to_vec(),
        default: None,
    }
}

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
        // The concrete ids from the shared Anthropic catalog, newest first
        // (what Claude Code accepts verbatim on `--model`).
        Ok(CLAUDE_MODELS
            .iter()
            .map(|(id, name)| ModelInfo {
                id: (*id).into(),
                provider_id: self.config.id.clone(),
                name: (*name).into(),
                effort: Some(effort_levels()),
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

    #[test]
    fn saved_aliases_resolve_to_the_newest_concrete_model() {
        assert_eq!(resolve_alias("opus"), Some("claude-opus-5-5"));
        assert_eq!(resolve_alias(" Sonnet "), Some("claude-sonnet-5-5"));
        assert_eq!(resolve_alias("haiku"), Some("claude-haiku-5-5"));
        assert_eq!(resolve_alias("claude-opus-5"), None);
        assert_eq!(concrete_model_id("opus"), "claude-opus-5-5");
        assert_eq!(concrete_model_id("claude-fable-5-1"), "claude-fable-5-1");
    }

    #[tokio::test]
    async fn lists_concrete_models_only_and_never_chats() {
        let p = provider();
        let models = p.list_models().await.unwrap();
        assert!(models.iter().all(|m| m.effort == Some(effort_levels())));
        let ids: Vec<String> = models.into_iter().map(|m| m.id).collect();
        assert!(ids.iter().all(|i| i.starts_with("claude-")), "no family aliases: {ids:?}");
        assert_eq!(ids[0], "claude-opus-5-5");
        for want in ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"] {
            assert!(ids.contains(&want.into()), "{want}");
        }
        let req: ChatRequest = serde_json::from_value(json!({ "model": "opus", "messages": [] })).unwrap();
        let (chunks, err): (Vec<ProviderChunk>, _) = p.chat(req).collect().await;
        assert!(chunks.is_empty());
        assert_eq!(err.unwrap().message, NOT_A_MODEL_API);
    }
}
