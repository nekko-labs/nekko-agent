//! The sub-agent model preference (`orchestration.subagentModel`): which
//! model a `spawn_agent` child runs on when the call names none and no
//! explicit delegation route is saved (#2487).
//!
//! Before, every such child ran on the parent's model, so a chat on the top
//! tier that fanned out four workers paid for five top-tier contexts. The
//! `auto` choices pick a lighter model instead:
//!
//! - `auto`: one step lighter on the chat's provider (Opus to Sonnet), or a
//!   local model already loaded in memory when the chat may route to local
//!   models anyway (Fusion only).
//! - `auto-same-provider`: one step lighter, never leaving the chat's provider.
//! - `auto-local`: a local chat model on this computer (loaded first), else the
//!   same-provider pick. It never grants provider switching permission.
//! - `inherit`: the chat's own model, as before.
//!
//! An auto pick never names a stronger model than the parent's, and when no
//! lighter model is listed the child simply inherits: there is no failure
//! and no move to another cloud provider.
//!
//! Claude Code chats run their own sub-agents; [`claude_code_env`] gives them
//! the same choice through `CLAUDE_CODE_SUBAGENT_MODEL`.

use nekko_messaging::auto::{capability, capability_rank, is_chat_model, tier_with_overrides};
use serde_json::{Value, json};

pub use nekko_turn::plan::subagent_preference as preference;

/// The configured default for a future spawn that omits overrides. Do not
/// query catalogs or pick an assignment's route just to annotate the transcript.
pub fn planned_default<'a>(orchestration: Option<&'a Value>, parent_model: Option<&'a str>) -> Option<&'a str> {
    if let Some(route) = orchestration.and_then(|o| o.get("delegationRoute")).filter(|r| !r.is_null()) {
        let exact = |value: &'a Value| value.as_str().filter(|id| !id.is_empty() && nekko_js::trim(id) == *id);
        exact(route.get("providerId")?)?;
        return exact(route.get("modelId")?).filter(|id| *id != "__auto__");
    }
    if preference(orchestration) == "inherit" { parent_model } else { None }
}

/// A model's tier for this choice: the Auto router's (`modelTier`), except
/// that a small variant of a top family (`gpt-5-mini`) is light, and Fable
/// is above Opus.
fn model_tier(m: &Value) -> i32 {
    tier_with_overrides(m, None)
}

/// The parent's model is the top tier: worth a lighter child.
pub fn is_top_tier(model_id: &str) -> bool {
    model_tier(&json!({ "id": model_id })) >= 4
}

/// Shared leading plus trailing characters, so `claude-opus-5-5` is closest
/// to `claude-sonnet-5-5` and `gpt-5` to `gpt-5-mini`.
fn likeness(a: &str, b: &str) -> usize {
    let prefix = a.chars().zip(b.chars()).take_while(|(x, y)| x == y).count();
    let suffix = a.chars().rev().zip(b.chars().rev()).take_while(|(x, y)| x == y).count();
    (prefix + suffix).min(a.chars().count().min(b.chars().count()))
}

/// How close a candidate is: likeness to the parent, tier, version.
type Rank = (usize, i32, Vec<u32>);

/// The numbers in an id, to prefer the newer of two otherwise equal models.
fn version(id: &str) -> Vec<u32> {
    id.split(|c: char| !c.is_ascii_digit())
        .filter(|d| !d.is_empty() && d.len() < 6)
        .filter_map(|d| d.parse().ok())
        .collect()
}

fn id_of(m: &Value) -> Option<&str> {
    m.get("id").and_then(Value::as_str)
}

/// A lighter chat model than `parent_id` from `models`: the closest relative
/// one tier or more below it (ties: the higher tier, then the newer version). `None`
/// when the parent is not top tier or nothing lighter is listed.
pub fn lighter_model(parent_id: &str, models: &[Value]) -> Option<String> {
    if !is_top_tier(parent_id) {
        return None;
    }
    let parent_tier = model_tier(&json!({ "id": parent_id }));
    let mut best: Option<(Rank, &str)> = None;
    for m in models {
        let Some(id) = id_of(m) else { continue };
        let t = model_tier(m);
        if id == parent_id
            || !is_chat_model(m)
            || m.pointer("/availability/status").and_then(Value::as_str).is_some_and(|s| s != "ready")
            || is_top_tier(id)
            || t >= parent_tier
            || t < 2
        {
            continue;
        }
        let key = (likeness(parent_id, id), t, version(id));
        if best.as_ref().is_none_or(|(b, _)| key > *b) {
            best = Some((key, id));
        }
    }
    best.map(|(_, id)| id.to_string())
}

/// Cap the resolved worker effort, not the saved slider value: a different
/// catalog can otherwise resolve the very same setting to a higher default.
/// Normal omits the effort on the wire; it does not promise a compute budget.
pub fn cap_effort(
    worker: nekko_agent::EffortLevel,
    parent: &str,
    model_id: &str,
    metadata: Option<&nekko_agent::ModelEffort>,
) -> Option<nekko_agent::EffortLevel> {
    use nekko_agent::{EffortLevel, claude::effective_effort_with_metadata};
    let rank = |level: &str| match level {
        "low" => Some(0),
        "normal" | "medium" => Some(1),
        "high" => Some(2),
        "xhigh" => Some(3),
        "max" => Some(4),
        _ => None,
    };
    if worker.as_str() == parent || worker == EffortLevel::Normal {
        return Some(worker);
    }
    let cap = rank(parent)?;
    if rank(worker.as_str()).is_some_and(|worker| worker <= cap) {
        return Some(worker);
    }
    [EffortLevel::Max, EffortLevel::Xhigh, EffortLevel::High, EffortLevel::Medium, EffortLevel::Low]
        .into_iter()
        .filter(|candidate| rank(candidate.as_str()).is_some_and(|rank| rank <= cap))
        .find(|candidate| {
            metadata.is_none_or(|m| m.levels.iter().any(|option| option.effort == candidate.as_str()))
                && effective_effort_with_metadata(Some(candidate.clone()), model_id, metadata) == *candidate
        })
}

/// The assignment may narrow the saved target, never raise it or the parent's tier.
/// Unlike legacy routing, an unclassified parent cannot act as a tier ceiling.
pub fn assignment_ceiling(requested: i32, parent_id: &str, parent_provider: &str, settings: &Value) -> Option<i32> {
    let parent = json!({"id": parent_id, "providerId": parent_provider});
    let parent = capability(&parent, settings.pointer("/fusion/modelTiers"))?;
    let parent = capability_rank(&parent)?;
    let saved = settings.pointer("/orchestration/subagentTier").and_then(Value::as_str);
    let ceiling = match saved {
        Some("smaller") => parent - 1,
        Some(tier) => capability_rank(tier).unwrap_or(parent),
        None => parent,
    };
    Some(requested.min(ceiling).min(parent))
}

/// Capability-targeted automatic selection, sharing suggestions with the UI.
/// Exact tier first, then nearest smaller; loaded status breaks ties only.
/// Unknown models do not participate in tier routing. Explicit picks bypass it.
pub fn tiered_model(
    parent_id: &str,
    parent_provider: &str,
    models: &[Value],
    settings: &Value,
    loaded_only: bool,
    local: bool,
    assignment_ceiling: Option<i32>,
) -> Option<String> {
    let overrides = settings.pointer("/fusion/modelTiers");
    let target = settings.pointer("/orchestration/subagentTier").and_then(Value::as_str);
    if assignment_ceiling.is_none() && !local && target.is_none_or(|t| t == "smaller") && overrides.is_none() {
        return lighter_model(parent_id, models);
    }
    let parent = json!({"id": parent_id, "providerId": parent_provider});
    let parent_tier = tier_with_overrides(&parent, overrides);
    let wanted = assignment_ceiling
        .unwrap_or_else(|| target.and_then(capability_rank).map(|t| t.min(parent_tier)).unwrap_or(parent_tier - 1));
    let mut best: Option<((i32, bool, usize), String)> = None;
    for model in models {
        let Some(id) = id_of(model) else { continue };
        let loaded = model.get("loaded") == Some(&Value::Bool(true));
        if !is_chat_model(model) || (loaded_only && !loaded) {
            continue;
        }
        if model.pointer("/availability/status").and_then(Value::as_str).is_some_and(|s| s != "ready") {
            continue;
        }
        let Some(rank) = capability(model, overrides).and_then(|t| capability_rank(&t)) else { continue };
        if rank > wanted {
            continue;
        }
        let key = (rank, loaded, likeness(parent_id, id));
        if best.as_ref().is_none_or(|(k, _)| key > *k) {
            best = Some((key, id.to_string()));
        }
    }
    best.map(|(_, id)| id)
}

/// `CLAUDE_CODE_SUBAGENT_MODEL` for a Claude Code chat on `model`: the saved
/// route's model when it is on a Claude Code provider, `sonnet` under an
/// auto choice when the chat runs the top tier, else nothing (Claude Code's
/// own default). Claude Code cannot run a local model, so `auto-local` is
/// the same-provider pick here.
pub fn claude_code_env(orchestration: Option<&Value>, providers: &[Value], model: Option<&str>) -> Option<String> {
    let route = orchestration.and_then(|o| o.get("delegationRoute")).filter(|r| r.is_object());
    if let Some(r) = route {
        let pid = r.get("providerId");
        let on_claude_code = providers
            .iter()
            .any(|p| p.get("id") == pid && p.get("kind").and_then(Value::as_str) == Some("claude-code"));
        return r
            .get("modelId")
            .and_then(Value::as_str)
            .filter(|m| on_claude_code && !m.is_empty())
            .map(str::to_string);
    }
    if preference(orchestration) == "inherit" {
        return None;
    }
    let model = model.unwrap_or_default();
    if let Some(target) = orchestration.and_then(|o| o.get("subagentTier")).and_then(Value::as_str) {
        let parent_tier = model_tier(&json!({"id": model}));
        let requested = nekko_messaging::auto::capability_rank(target);
        return requested
            .map(|t| {
                match t.min(parent_tier) {
                    2 => "haiku",
                    3 => "sonnet",
                    _ => "opus",
                }
                .to_string()
            })
            .or_else(|| is_top_tier(model).then(|| "sonnet".to_string()));
    }
    is_top_tier(model).then(|| "sonnet".to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn planned_default_does_not_resolve_automatic_or_invalid_routes() {
        assert_eq!(planned_default(None, Some("parent")), None);
        let mut orchestration = json!({"subagentModel": "inherit"});
        assert_eq!(planned_default(Some(&orchestration), Some("parent")), Some("parent"));
        orchestration["delegationRoute"] = json!({"providerId": "p", "modelId": "worker"});
        assert_eq!(planned_default(Some(&orchestration), Some("parent")), Some("worker"));
        orchestration["delegationRoute"]["providerId"] = json!(" ");
        assert_eq!(planned_default(Some(&orchestration), Some("parent")), None);
    }

    #[test]
    fn worker_effort_is_capped_after_a_catalog_default() {
        use nekko_agent::EffortLevel::{High, Low, Medium};
        let catalog: nekko_agent::ModelEffort = serde_json::from_value(json!({
            "levels":[{"effort":"low"},{"effort":"high"}], "default":"high"
        }))
        .unwrap();
        assert_eq!(cap_effort(High, "medium", "gpt-5", Some(&catalog)), Some(Low));
        assert_eq!(cap_effort(High, "medium", "gpt-5", None), Some(Medium));
        assert_eq!(cap_effort(High, "unranked", "gpt-5", Some(&catalog)), None);
        let high_only = nekko_agent::ModelEffort { levels: catalog.levels[1..].to_vec(), ..catalog };
        assert_eq!(cap_effort(High, "low", "gpt-5", Some(&high_only)), None);
    }

    use super::*;

    fn models(ids: &[&str]) -> Vec<Value> {
        ids.iter().map(|id| json!({ "id": id, "name": id })).collect()
    }

    #[test]
    fn steps_a_top_tier_parent_down_to_its_closest_relative() {
        let anthropic = models(&["claude-opus-5-5", "claude-sonnet-4-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
        assert_eq!(lighter_model("claude-opus-5-5", &anthropic).as_deref(), Some("claude-sonnet-5-5"));
        let openai = models(&["gpt-5", "gpt-4.1", "gpt-4o", "gpt-5-mini", "text-embedding-3-large"]);
        assert_eq!(lighter_model("gpt-5", &openai).as_deref(), Some("gpt-5-mini"));
        let claude_code = models(&["opus", "sonnet", "haiku"]);
        assert_eq!(lighter_model("opus", &claude_code).as_deref(), Some("sonnet"));
        assert_eq!(lighter_model("claude-fable-5-2", &anthropic).as_deref(), Some("claude-sonnet-5-5"));
    }

    #[test]
    fn leaves_lighter_parents_and_lone_models_alone() {
        let anthropic = models(&["claude-opus-5-5", "claude-sonnet-5-5"]);
        assert_eq!(lighter_model("claude-sonnet-5-5", &anthropic), None);
        assert_eq!(lighter_model("claude-opus-5-5", &models(&["claude-opus-5-5", "claude-opus-4-1"])), None);
        assert_eq!(lighter_model("claude-opus-5-5", &[]), None);
    }

    #[test]
    fn claude_code_subagents_follow_the_preference() {
        let providers = vec![json!({ "id": "cc", "kind": "claude-code" }), json!({ "id": "oa", "kind": "openai" })];
        assert_eq!(claude_code_env(None, &providers, Some("opus")).as_deref(), Some("sonnet"));
        assert_eq!(claude_code_env(None, &providers, Some("claude-opus-5-5")).as_deref(), Some("sonnet"));
        assert_eq!(claude_code_env(None, &providers, Some("sonnet")), None);
        let inherit = json!({ "subagentModel": "inherit" });
        assert_eq!(claude_code_env(Some(&inherit), &providers, Some("opus")), None);
        let route = json!({ "delegationRoute": { "providerId": "cc", "modelId": "haiku" } });
        assert_eq!(claude_code_env(Some(&route), &providers, Some("opus")).as_deref(), Some("haiku"));
        // A route on another provider is not something Claude Code can run.
        let elsewhere = json!({ "delegationRoute": { "providerId": "oa", "modelId": "gpt-5-mini" } });
        assert_eq!(claude_code_env(Some(&elsewhere), &providers, Some("opus")), None);
    }

    #[test]
    fn requested_tier_prefers_medium_over_loaded_small_and_never_exceeds_parent() {
        let models = vec![
            json!({"id":"qwen-8b", "providerId":"local", "loaded":true}),
            json!({"id":"qwen-32b", "providerId":"local"}),
            json!({"id":"llama-70b", "providerId":"local"}),
        ];
        let settings = json!({"orchestration":{"subagentTier":"medium"}});
        assert_eq!(tiered_model("gpt-5", "cloud", &models, &settings, false, true, None).as_deref(), Some("qwen-32b"));
        assert_eq!(tiered_model("gpt-5", "cloud", &models, &settings, true, true, None).as_deref(), Some("qwen-8b"));
        let stronger = json!({"orchestration":{"subagentTier":"frontier"}});
        assert_eq!(
            tiered_model("claude-sonnet", "cloud", &models, &stronger, false, true, None).as_deref(),
            Some("qwen-32b")
        );
    }

    #[test]
    fn assignment_can_narrow_but_not_raise_saved_or_parent_tiers() {
        let settings = json!({"orchestration":{"subagentTier":"medium"}});
        assert_eq!(assignment_ceiling(4, "gpt-5", "cloud", &settings), Some(3));
        assert_eq!(assignment_ceiling(2, "gpt-5", "cloud", &settings), Some(2));
        assert_eq!(assignment_ceiling(4, "gpt-5-mini", "cloud", &settings), Some(2));
        assert_eq!(assignment_ceiling(4, "custom", "cloud", &settings), None);
        let settings =
            json!({"orchestration":{"subagentTier":"smaller"}, "fusion":{"modelTiers":{"cloud::custom":"medium"}}});
        assert_eq!(assignment_ceiling(4, "custom", "cloud", &settings), Some(2));
        assert_eq!(assignment_ceiling(4, "custom", "other", &settings), None);
        assert_eq!(assignment_ceiling(4, "gpt-5-mini", "cloud", &settings), Some(1));
    }

    #[test]
    fn custom_classification_is_provider_scoped_and_non_chat_models_are_excluded() {
        let models =
            vec![json!({"id":"custom", "providerId":"local"}), json!({"id":"embedding-small", "providerId":"local"})];
        let settings = json!({"orchestration":{"subagentTier":"medium"}, "fusion":{"modelTiers":{"local::custom":"medium", "local::embedding-small":"medium"}}});
        assert_eq!(tiered_model("gpt-5", "cloud", &models, &settings, false, true, None).as_deref(), Some("custom"));
        assert_eq!(tiered_model("gpt-5", "cloud", &models, &json!({}), false, true, None), None);
        assert_eq!(
            claude_code_env(Some(&json!({"subagentTier":"small"})), &[], Some("opus")).as_deref(),
            Some("haiku")
        );
    }
}
