//! Small channels about the agent's tools, served here instead of the TS
//! host (PF14): `guardrails:classify` (the Settings page's command tester,
//! `classifyCommand` over the saved rules), `tools:list` (the built-in tools
//! and the MCP tools the daemon runs, as `listTools` lists them).

use crate::routes::Ctx;
use serde_json::{Value, json};

/// The channels served here.
pub const CHANNELS: &[&str] = &["guardrails:classify", "tools:list"];

pub async fn route(ctx: &Ctx, channel: &str, args: &[Value]) -> Result<Value, String> {
    match channel {
        "guardrails:classify" => {
            let settings = crate::settings::current(ctx).await;
            let rules: Vec<nekko_tools::GuardrailRule> = match settings.get("guardrails") {
                Some(v) if v.is_array() => serde_json::from_value(v.clone()).map_err(|e| e.to_string())?,
                _ => nekko_tools::default_guardrails(),
            };
            let command = args.first().map(nekko_js::display).unwrap_or_else(|| "undefined".into());
            serde_json::to_value(nekko_tools::classify_command(&command, &rules)).map_err(|e| e.to_string())
        }
        "tools:list" => {
            let mut out: Vec<Value> = nekko_turn::catalog::catalog()
                .builtin
                .iter()
                .map(|t| json!({ "name": t["name"], "description": t["description"] }))
                .collect();
            if let Some(specs) = ctx.mcp.snapshot()["specs"].as_array() {
                out.extend(specs.iter().map(|t| {
                    json!({ "name": t["name"], "description": t.get("description").filter(|d| !d.is_null()).cloned().unwrap_or(json!("")) })
                }));
            }
            Ok(Value::Array(out))
        }
        _ => Err(format!("unknown channel {channel}")),
    }
}
