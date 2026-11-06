//! The Claude Agent provider (`claude-code`): the user's own Claude Code
//! runs these chats (nekkod drives it through `nekko-harness`), so this
//! provider has no wire. It lists the concrete Claude models the user can
//! pin on `--model` (plus the generic family aliases), and refuses a direct
//! chat: Nekko never calls a model with credentials that belong to Claude
//! Code.

use crate::providers::anthropic::CLAUDE_MODELS;
use crate::stream::{ChunkStream, Stop, spawn};
use crate::types::{ChatRequest, ModelEffort, ModelEffortOption, ModelInfo, ProviderConfig, ProviderError, TestResult};

/// The generic family aliases Claude Code resolves to the user's current
/// plan default (`--model opus` -> whatever Opus the plan ships, which was
/// 4.7 for a while and will roll forward on its own). They sit first in the
/// picker so a user who does not want to pin a version keeps the plan's
/// current default. `MODELS` concatenates these with the frontier concrete
/// ids from [`CLAUDE_MODELS`] (the Anthropic provider's own list) so a
/// subscription chat offers Opus 5.5, Sonnet 5.5 and friends without any
/// id strings living in two places.
pub const MODEL_ALIASES: &[(&str, &str)] = &[
    ("opus", "Claude Opus (latest in plan)"),
    ("sonnet", "Claude Sonnet (latest in plan)"),
    ("haiku", "Claude Haiku (latest in plan)"),
];

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
        // Aliases first (what Claude Code resolves to the plan's default),
        // then the concrete frontier ids from the shared Anthropic catalog
        // (what Claude Code accepts verbatim on `--model`).
        Ok(MODEL_ALIASES
            .iter()
            .chain(CLAUDE_MODELS.iter())
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

    #[tokio::test]
    async fn lists_aliases_then_frontier_ids_and_never_chats() {
        let p = provider();
        let models = p.list_models().await.unwrap();
        assert!(models.iter().all(|m| m.effort == Some(effort_levels())));
        let ids: Vec<String> = models.into_iter().map(|m| m.id).collect();
        // Aliases first so "whatever my plan ships" stays one click away.
        assert_eq!(&ids[..3], &["opus", "sonnet", "haiku"]);
        // Concrete frontier ids follow (Opus 5.5 at the top), passed through
        // on `--model` so a chat gets exactly what the user picked.
        assert!(ids.contains(&"claude-opus-5-5".into()));
        assert!(ids.contains(&"claude-sonnet-5-5".into()));
        assert!(ids.contains(&"claude-haiku-5-5".into()));
        let req: ChatRequest = serde_json::from_value(json!({ "model": "opus", "messages": [] })).unwrap();
        let (chunks, err): (Vec<ProviderChunk>, _) = p.chat(req).collect().await;
        assert!(chunks.is_empty());
        assert_eq!(err.unwrap().message, NOT_A_MODEL_API);
    }
}
