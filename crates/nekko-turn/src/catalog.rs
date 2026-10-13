//! What the TS sources define and a turn needs: every tool spec apart from
//! MCP's, the default turn wrapper, the orchestration strategies, and the
//! fixed instructions and answers. Written from the TS by
//! `packages/host/src/turn-plan.golden.test.ts` (which fails when it is stale).

use serde_json::Value;
use std::sync::OnceLock;

const RAW: &str = include_str!("catalog.json");

pub struct Catalog {
    pub builtin: Vec<Value>,
    pub agent_watch: Value,
    pub update_plan: Value,
    pub set_chat_title: Value,
    pub complete_session: Value,
    pub report_experiment: Value,
    pub report_artifact: Value,
    pub ask_user: Value,
    pub decide: Value,
    pub default_turn_wrapper: String,
    /// `{ id, allowsSpawn, promptHint }`, in `ORCHESTRATION_STRATEGIES` order.
    pub strategies: Vec<Value>,
    pub default_orchestration: Value,
    pub agent_watch_instructions: String,
    pub sandbox_instructions: String,
    pub ask_cancelled: String,
    pub ask_unattended: String,
}

fn text(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

/// The catalog, parsed once. It is compiled in, so a broken one fails every test.
pub fn catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    CATALOG.get_or_init(|| {
        let v: Value = serde_json::from_str(RAW).unwrap_or(Value::Null);
        let tools = &v["tools"];
        Catalog {
            builtin: tools["builtin"].as_array().cloned().unwrap_or_default(),
            agent_watch: tools["agentWatch"].clone(),
            update_plan: tools["updatePlan"].clone(),
            set_chat_title: tools["setChatTitle"].clone(),
            complete_session: tools["completeSession"].clone(),
            report_experiment: tools["reportExperiment"].clone(),
            report_artifact: tools["reportArtifact"].clone(),
            ask_user: tools["askUser"].clone(),
            decide: tools["decide"].clone(),
            default_turn_wrapper: text(&v, "defaultTurnWrapper"),
            strategies: v["strategies"].as_array().cloned().unwrap_or_default(),
            default_orchestration: v["defaultOrchestration"].clone(),
            agent_watch_instructions: text(&v, "agentWatchInstructions"),
            sandbox_instructions: text(&v, "sandboxInstructions"),
            ask_cancelled: text(&v, "askCancelled"),
            ask_unattended: text(&v, "askUnattended"),
        }
    })
}

/// A tool spec's name.
pub fn name(spec: &Value) -> &str {
    spec.get("name").and_then(Value::as_str).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_catalog_has_every_part() {
        let c = catalog();
        assert!(c.builtin.len() > 10);
        assert_eq!(name(&c.ask_user), "ask_user");
        assert_eq!(name(&c.update_plan), "update_plan");
        assert_eq!(name(&c.decide), "decide");
        assert_eq!(c.strategies.len(), 3);
        assert!(!c.default_turn_wrapper.is_empty() && !c.ask_cancelled.is_empty());
    }
}
