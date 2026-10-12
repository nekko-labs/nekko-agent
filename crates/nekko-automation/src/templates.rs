//! Step templates and the action catalog, for the workflow engine. The
//! template code is `nekko-connectors`' (held to `renderTemplate` there); the
//! catalog is `WORKFLOW_ACTIONS` and `CONNECTOR_CATALOG`, written by the
//! workflow golden test (`src/catalog.json`).

use serde_json::Value;
use std::sync::LazyLock;

pub use nekko_connectors::{render_template, template_context};

static CATALOG: LazyLock<Value> =
    LazyLock::new(|| serde_json::from_str(include_str!("catalog.json")).unwrap_or(Value::Null));

/// `findWorkflowAction(op)`: `None` for an unknown op, else the connector it needs (if any).
pub fn find_action(op: &str) -> Option<Option<&'static str>> {
    CATALOG["actions"]
        .as_array()?
        .iter()
        .find(|a| a.get("op").and_then(Value::as_str) == Some(op))
        .map(|a| a.get("connector").and_then(Value::as_str))
}

/// A connector's label (`CONNECTOR_CATALOG`), else its kind.
pub fn connector_label(kind: &str) -> String {
    CATALOG["connectors"]
        .as_array()
        .and_then(|cs| cs.iter().find(|c| c.get("kind").and_then(Value::as_str) == Some(kind)))
        .and_then(|c| c.get("label").and_then(Value::as_str))
        .unwrap_or(kind)
        .to_string()
}
