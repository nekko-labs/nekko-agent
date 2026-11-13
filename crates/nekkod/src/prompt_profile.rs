//! Which system prompt profile a model gets (decision 0095): the user's
//! override for the model, else their default for its provider, else the size
//! signal Auto already uses (`nekko_messaging::auto`) plus the context window.

use nekko_context::PromptProfile;
use nekko_messaging::auto;
use serde_json::{Value, json};

/// A window under this many tokens cannot spare room for the long prompt.
pub const SMALL_WINDOW: f64 = 16_000.0;

/// Providers whose models run on this machine, or whose size is unknown
/// (an OpenAI-compatible server), so the model's own name is the only signal.
const SELF_HOSTED: &[&str] = &["llamacpp", "ollama", "lmstudio", "vllm", "openai-compat"];

pub struct Choice {
    pub profile: PromptProfile,
    /// Why, for the Context Inspector ("Small: 8k context").
    pub reason: String,
}

impl Choice {
    pub fn to_json(&self) -> Value {
        json!({ "profile": self.profile.as_str(), "reason": self.reason })
    }
}

fn label(p: PromptProfile) -> &'static str {
    match p {
        PromptProfile::Small => "Small",
        PromptProfile::Medium => "Medium",
        PromptProfile::Large => "Large",
    }
}

fn window_label(w: f64) -> String {
    if w >= 1000.0 { format!("{}k", (w / 1000.0).round()) } else { format!("{w}") }
}

/// `settings.promptProfiles`: `{ "models": { "<providerId>::<modelId>": "small" }, "providers": { "<providerId>": "medium" } }`.
/// A value that is not small, medium or large (`auto`) counts as unset.
fn configured(settings: &Value, group: &str, key: &str) -> Option<PromptProfile> {
    settings
        .pointer(&format!("/promptProfiles/{group}"))
        .and_then(|g| g.get(key))
        .and_then(Value::as_str)
        .and_then(PromptProfile::parse)
}

pub fn resolve(
    settings: &Value,
    provider_id: &str,
    provider_kind: &str,
    model_id: &str,
    context_window: Option<f64>,
) -> Choice {
    if let Some(profile) = configured(settings, "models", &format!("{provider_id}::{model_id}")) {
        return Choice { profile, reason: format!("{}: set for this model", label(profile)) };
    }
    if let Some(profile) = configured(settings, "providers", provider_id) {
        return Choice { profile, reason: format!("{}: set for this provider", label(profile)) };
    }
    if model_id.is_empty() {
        return Choice { profile: PromptProfile::Large, reason: "Large: no model chosen yet".into() };
    }
    if let Some(w) = context_window.filter(|w| *w > 0.0 && *w < SMALL_WINDOW) {
        return Choice { profile: PromptProfile::Small, reason: format!("Small: {} context", window_label(w)) };
    }
    let model = json!({ "id": model_id, "name": model_id, "providerId": provider_id });
    let tier = auto::tier(&model);
    let capability = auto::capability(&model, None);
    let strong = tier >= 5 || matches!(capability.as_deref(), Some("large" | "frontier"));
    let self_hosted = provider_kind.is_empty() || SELF_HOSTED.contains(&provider_kind);
    if strong {
        return Choice { profile: PromptProfile::Large, reason: "Large: a large model".into() };
    }
    if self_hosted && (tier <= 2 || capability.as_deref() == Some("small")) {
        return Choice { profile: PromptProfile::Small, reason: "Small: a small local model".into() };
    }
    // Cloud models, even the quick ones, have the window and the skill for the working rules.
    let reason = if self_hosted { "Medium: a mid-size local model" } else { "Medium: a cloud model" };
    Choice { profile: PromptProfile::Medium, reason: reason.into() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn auto_pick(kind: &str, model: &str, window: Option<f64>) -> PromptProfile {
        resolve(&json!({}), "p", kind, model, window).profile
    }

    #[test]
    fn size_picks_the_profile() {
        assert_eq!(auto_pick("llamacpp", "qwen3-8b", Some(32_768.0)), PromptProfile::Small);
        assert_eq!(auto_pick("ollama", "gemma3:12b", Some(32_768.0)), PromptProfile::Small);
        assert_eq!(auto_pick("ollama", "qwen2.5-32b-instruct", Some(32_768.0)), PromptProfile::Medium);
        assert_eq!(auto_pick("llamacpp", "llama-3.3-70b", Some(32_768.0)), PromptProfile::Large);
        assert_eq!(auto_pick("anthropic", "claude-opus-4-5", Some(200_000.0)), PromptProfile::Large);
        assert_eq!(auto_pick("anthropic", "claude-sonnet-4-5", Some(200_000.0)), PromptProfile::Medium);
        assert_eq!(auto_pick("openai", "gpt-5", None), PromptProfile::Large);
    }

    #[test]
    fn quick_cloud_models_are_not_small() {
        assert_eq!(auto_pick("anthropic", "claude-haiku-4-5", Some(200_000.0)), PromptProfile::Medium);
        assert_eq!(auto_pick("openai", "gpt-4o-mini", Some(128_000.0)), PromptProfile::Medium);
    }

    #[test]
    fn a_small_window_is_small_whatever_the_model() {
        let c = resolve(&json!({}), "p", "llamacpp", "llama-3.3-70b", Some(8192.0));
        assert_eq!(c.profile, PromptProfile::Small);
        assert_eq!(c.reason, "Small: 8k context");
        assert_eq!(auto_pick("llamacpp", "llama-3.3-70b", Some(16_000.0)), PromptProfile::Large);
    }

    #[test]
    fn no_model_keeps_the_full_prompt() {
        assert_eq!(auto_pick("", "", None), PromptProfile::Large);
    }

    #[test]
    fn an_unknown_local_model_is_medium() {
        assert_eq!(auto_pick("openai-compat", "mystery-model", Some(32_768.0)), PromptProfile::Medium);
    }

    #[test]
    fn overrides_win_model_before_provider() {
        let settings = json!({ "promptProfiles": {
            "models": { "p::big": "small", "p::auto-one": "auto" },
            "providers": { "p": "large" },
        } });
        let c = resolve(&settings, "p", "anthropic", "big", Some(200_000.0));
        assert_eq!((c.profile, c.reason.as_str()), (PromptProfile::Small, "Small: set for this model"));
        let c = resolve(&settings, "p", "llamacpp", "qwen3-8b", Some(8192.0));
        assert_eq!((c.profile, c.reason.as_str()), (PromptProfile::Large, "Large: set for this provider"));
        // `auto` falls through to the provider default.
        assert_eq!(resolve(&settings, "p", "llamacpp", "auto-one", None).profile, PromptProfile::Large);
        // Another provider is untouched.
        assert_eq!(resolve(&settings, "q", "llamacpp", "qwen3-8b", Some(32_768.0)).profile, PromptProfile::Small);
    }
}
