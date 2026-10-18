//! `chatEffort`, `chatMcpTools` and `chatConnectors` (shared/chat-scope.ts):
//! settings configured app-wide that a chat narrows for itself.

use serde_json::Value;

fn strings<'a>(session: &'a Value, key: &str) -> Vec<&'a str> {
    session.get(key).and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default()
}

/// `chatEffort(session, appEffort)`: the chat's own effort when set, else the
/// app-wide one; `None` when neither is.
pub fn chat_effort(session: &Value, app_effort: Option<&Value>) -> Option<Value> {
    session.get("effort").filter(|e| !e.is_null()).or(app_effort.filter(|e| !e.is_null())).cloned()
}

/// `chatMcpTools(tools, session)`: MCP tool specs (`mcp__<server>__<tool>`)
/// less those whose server the chat switched off (`disabledMcpServers`).
pub fn chat_mcp_tools(tools: Vec<Value>, session: &Value) -> Vec<Value> {
    let off: Vec<String> = strings(session, "disabledMcpServers").iter().map(|id| format!("mcp__{id}__")).collect();
    if off.is_empty() {
        return tools;
    }
    tools
        .into_iter()
        .filter(|t| {
            let name = t.get("name").and_then(Value::as_str).unwrap_or("");
            !off.iter().any(|prefix| name.starts_with(prefix.as_str()))
        })
        .collect()
}

/// `chatConnectors(connectors, session)`: connector configs less the kinds the
/// chat switched off (`disabledConnectors`).
pub fn chat_connectors(connectors: Vec<Value>, session: &Value) -> Vec<Value> {
    let off = strings(session, "disabledConnectors");
    if off.is_empty() {
        return connectors;
    }
    connectors
        .into_iter()
        .filter(|c| !c.get("kind").and_then(Value::as_str).is_some_and(|k| off.contains(&k)))
        .collect()
}
