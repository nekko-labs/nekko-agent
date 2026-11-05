//! Provider-owned catalog effort metadata. No id heuristics or synthetic defaults.
use crate::types::{ModelEffort, ModelEffortOption};
use serde_json::Value;

fn wire_value(value: &str) -> bool {
    !value.is_empty() && value.trim() == value && value != "normal"
}

/// Codex backend `/models`: preserve order, descriptions, and future wire values.
pub(super) fn codex(model: &Value) -> Option<ModelEffort> {
    let rows = model.get("supported_reasoning_levels")?.as_array()?;
    let mut levels: Vec<ModelEffortOption> = Vec::new();
    for row in rows {
        let Some(effort) = row.get("effort").and_then(Value::as_str).filter(|s| wire_value(s)) else { continue };
        if !levels.iter().any(|l| l.effort == effort) {
            levels.push(ModelEffortOption {
                effort: effort.into(),
                description: row.get("description").and_then(Value::as_str).map(str::to_string),
            });
        }
    }
    // Malformed nonempty metadata is unknown, not an assertion of no support.
    if !rows.is_empty() && levels.is_empty() {
        return None;
    }
    let default = model
        .get("default_reasoning_level")
        .and_then(Value::as_str)
        .filter(|s| levels.iter().any(|l| l.effort == *s))
        .map(str::to_string);
    Some(ModelEffort { levels, default })
}

/// Anthropic Models API publishes support flags, but no default effort.
pub(super) fn anthropic(model: &Value) -> Option<ModelEffort> {
    let capability = model.pointer("/capabilities/effort")?;
    let supported = capability.get("supported")?.as_bool()?;
    let mut levels = Vec::new();
    if supported {
        for effort in ["low", "medium", "high", "xhigh", "max"] {
            if capability.get(effort).and_then(|v| v.get("supported")).and_then(Value::as_bool) == Some(true) {
                levels.push(ModelEffortOption { effort: effort.into(), description: None });
            }
        }
        if levels.is_empty() {
            return None;
        }
    }
    Some(ModelEffort { levels, default: None })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn codex_preserves_api_values_without_inventing_rungs() {
        let metadata = codex(&json!({
            "supported_reasoning_levels": [
                {"effort":"high", "description":"More reasoning"},
                {"effort":"xhigh"}, {"effort":"ultra"}, {"effort":"future-level"},
                {"effort":"normal"}, {"effort":"high"}, {"effort":""}, {"effort":7}
            ], "default_reasoning_level":"ultra"
        }))
        .unwrap();
        assert_eq!(
            metadata.levels.iter().map(|l| l.effort.as_str()).collect::<Vec<_>>(),
            ["high", "xhigh", "ultra", "future-level"]
        );
        assert_eq!(metadata.levels[0].description.as_deref(), Some("More reasoning"));
        assert_eq!(metadata.default.as_deref(), Some("ultra"));
        assert_eq!(
            codex(&json!({"supported_reasoning_levels":[], "default_reasoning_level":"high"})).unwrap().default,
            None
        );
    }

    #[test]
    fn unknown_is_distinct_from_unsupported() {
        assert_eq!(codex(&json!({})), None);
        assert_eq!(codex(&json!({"supported_reasoning_levels":[null]})), None);
        assert!(codex(&json!({"supported_reasoning_levels":[]})).unwrap().levels.is_empty());
        assert_eq!(anthropic(&json!({"capabilities":null})), None);
        assert_eq!(anthropic(&json!({"capabilities":{"effort":{"supported":true}}})), None);
        assert!(anthropic(&json!({"capabilities":{"effort":{"supported":false}}})).unwrap().levels.is_empty());
    }

    #[test]
    fn anthropic_reads_individual_flags_and_does_not_guess_a_default() {
        let metadata = anthropic(&json!({"capabilities":{"effort":{
            "supported":true, "low":{"supported":true}, "medium":{"supported":true},
            "high":{"supported":true}, "xhigh":null, "max":{"supported":false}
        }}}))
        .unwrap();
        assert_eq!(metadata.levels.iter().map(|l| l.effort.as_str()).collect::<Vec<_>>(), ["low", "medium", "high"]);
        assert_eq!(metadata.default, None);
        let wire =
            serde_json::to_value(crate::types::ModelInfo { effort: Some(metadata), ..Default::default() }).unwrap();
        assert_eq!(wire["effort"]["levels"][0]["effort"], "low");
        assert!(wire["effort"].get("default").is_none());
        assert!(serde_json::to_value(crate::types::ModelInfo::default()).unwrap().get("effort").is_none());
    }
}
