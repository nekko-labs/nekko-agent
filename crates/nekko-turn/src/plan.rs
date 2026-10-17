//! `turnTools`, `turnSystemPrompt` and `routingPrompt` (turn-plan.ts), with
//! `getStrategy` and `orchestrationPromptHint` (shared/orchestration.ts).

use crate::catalog::{catalog, name};
use crate::truthy;
use nekko_context::{PromptContext, Workspace, build_system_prompt};
use nekko_js as js;
use serde_json::Value;
use std::collections::HashSet;

/// `getStrategy(id)`: the named strategy, else the second (balanced).
fn strategy(id: Option<&Value>) -> &'static Value {
    let all = &catalog().strategies;
    all.iter().find(|s| id.is_some_and(|id| s.get("id") == Some(id))).unwrap_or(&all[1])
}

fn allows_spawn(orchestration: Option<&Value>) -> bool {
    let o = match orchestration {
        Some(o) if !o.is_null() => o,
        _ => &catalog().default_orchestration,
    };
    strategy(o.get("strategy")).get("allowsSpawn") == Some(&Value::Bool(true))
}

/// `turnCanAsk`: nobody reads a sub-agent, an automation, or a goal run.
pub fn turn_can_ask(session: &Value) -> bool {
    !truthy(session, "parentSessionId") && !truthy(session, "taskId") && !truthy(session, "trainingRunId")
}

/// `turnTools(input)`: the tools a (non-sandbox) turn offers, in order. `input`
/// is the TS `TurnToolInput`: `session`, `offline`, `orchestration`,
/// `allowBrowserControl`, `mcpTools`, `decide`.
pub fn turn_tools(input: &Value) -> Vec<Value> {
    let offline = truthy(input, "offline");
    let c = catalog();
    let session = input.get("session").unwrap_or(&Value::Null);
    let allow_spawn = allows_spawn(input.get("orchestration"));
    let can_ask = turn_can_ask(session);
    let incognito = truthy(session, "incognito");
    let training = truthy(session, "trainingRunId");
    let parent = truthy(session, "parentSessionId");
    let mut disabled: HashSet<String> = session
        .get("disabledTools")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    if !allow_spawn || disabled.contains("spawn_agent") || incognito {
        disabled.insert("delegation_targets".into());
    }
    if !allow_spawn {
        disabled.insert("spawn_agent".into());
    }
    if !truthy(input, "allowBrowserControl") || !can_ask {
        disabled.insert("browser".into());
        disabled.insert("capture".into());
    }
    let mcp = crate::scope::chat_mcp_tools(
        input.get("mcpTools").and_then(Value::as_array).cloned().unwrap_or_default(),
        session,
    );
    let watch = (!incognito && !training).then(|| c.agent_watch.clone());
    // Blocking the internet keeps the local tools and drops those that reach a
    // network (`toolAllowedOffline`, shared/tool-categories.ts).
    let mut tools: Vec<Value> = c
        .builtin
        .iter()
        .cloned()
        .chain(mcp)
        .chain(watch)
        .filter(|t| !disabled.contains(name(t)))
        .filter(|t| !offline || tool_allowed_offline(name(t)))
        .collect();
    tools.push(c.update_plan.clone());
    if session.get("titleAuto") != Some(&Value::Bool(false)) && !parent {
        tools.push(c.set_chat_title.clone());
    }
    if !incognito && !parent && !training && !disabled.contains("complete_session") {
        tools.push(c.complete_session.clone());
    }
    if training {
        tools.push(c.report_experiment.clone());
        tools.push(c.report_artifact.clone());
    }
    if can_ask && !disabled.contains(name(&c.ask_user)) {
        tools.push(c.ask_user.clone());
    }
    if truthy(input, "decide") && !offline && !disabled.contains(name(&c.decide)) {
        tools.push(c.decide.clone());
    }
    tools
}

/// `toolAllowedOffline(name)`: not an online or MCP tool, and not an agent
/// tool that can route to a cloud provider. The table is the catalog's copy of
/// `TOOL_CATEGORY_OF` and `OFFLINE_BLOCKED_AGENT_TOOLS`.
fn tool_allowed_offline(tool: &str) -> bool {
    let c = catalog();
    if tool.starts_with("mcp__") {
        return false;
    }
    // Unclassified tools are refused offline, as in the TS.
    let Some(category) = c.tool_categories.get(tool).and_then(Value::as_str) else { return false };
    category != "online" && category != "mcp" && !c.offline_blocked.iter().any(|b| b == tool)
}

/// `value.replace(/https?:\/\/\S+/gi, '[redacted]')`.
fn redact_urls(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut out = String::with_capacity(value.len());
    let mut i = 0;
    let at = |i: usize, word: &str| -> bool {
        word.chars().enumerate().all(|(k, w)| chars.get(i + k).is_some_and(|c| c.eq_ignore_ascii_case(&w)))
    };
    while i < chars.len() {
        if at(i, "http") {
            let mut j = i + 4;
            if chars.get(j).is_some_and(|c| c.eq_ignore_ascii_case(&'s')) && at(j + 1, "://") {
                j += 1;
            }
            if at(j, "://") {
                let start = j + 3;
                let mut end = start;
                while end < chars.len() && !js::is_js_space(chars[end]) {
                    end += 1;
                }
                if end > start {
                    out.push_str("[redacted]");
                    i = end;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// `routingPrompt(providers, orchestration)`: ids and labels only, secrets and URLs redacted.
pub fn routing_prompt(providers: &[Value], orchestration: Option<&Value>) -> String {
    let secrets: Vec<&str> = providers
        .iter()
        .flat_map(|p| [p.get("apiKey"), p.get("baseUrl")])
        .filter_map(|v| v.and_then(Value::as_str))
        .filter(|s| !s.is_empty())
        .collect();
    let safe = |value: &str| -> String {
        let mut v = value.to_string();
        for secret in &secrets {
            v = v.replace(secret, "[redacted]");
        }
        redact_urls(&v)
    };
    let field = |p: &Value, k: &str| p.get(k).map(js::display).unwrap_or_else(|| "undefined".into());
    let enabled: Vec<Value> = providers
        .iter()
        .filter(|p| js::truthy(p.get("enabled")))
        .map(|p| serde_json::json!({ "id": safe(&field(p, "id")), "label": safe(&field(p, "label")) }))
        .collect();
    let route = orchestration.and_then(|o| o.get("delegationRoute")).filter(|v| !v.is_null()).unwrap_or(&Value::Null);
    [
        "Sub-agent routing: enabled configured providers (IDs and labels only):".to_string(),
        js::stringify(&Value::Array(enabled)),
        "Omit provider_id and model_id to inherit this chat's provider and model. An explicit provider change requires an explicit exact model ID for that provider.".into(),
        "Use delegation_targets to discover exact chat-model IDs on the intended provider before explicit delegation; never guess. If discovery fails, report the blocker or ask the user, not a different provider. Explicit and user-configured default routes are validated before creating a child.".into(),
        format!(
            "User-selected delegation default: {}. When set, omitted routing arguments use this route, not the parent. Explicit arguments override it.",
            safe(&js::stringify(route))
        ),
        "There is no fallback to another provider or model on failure. Keep sensitive work on the intended provider; do not switch to a cloud provider to bypass a local failure. Incognito delegation is unavailable because child sessions are persisted.".into(),
    ]
    .join("\n")
}

/// `orchestrationPromptHint(o)`.
fn orchestration_hint(o: &Value) -> String {
    let strat = strategy(o.get("strategy"));
    let hint = strat.get("promptHint").and_then(Value::as_str).unwrap_or_default();
    if strat.get("allowsSpawn") != Some(&Value::Bool(true)) || hint.is_empty() {
        return String::new();
    }
    let shown = |k: &str| o.get(k).map(js::display).unwrap_or_else(|| "undefined".into());
    let one = o.get("maxDepth").and_then(Value::as_f64) == Some(1.0);
    format!(
        "{hint} Keep concurrent sub-agents to about {} at a time, and don't nest deeper than {} level{}.",
        shown("maxParallel"),
        shown("maxDepth"),
        if one { "" } else { "s" }
    )
}

/// `turnSystemPrompt(input)`. `input` is the TS `TurnPromptInput`:
/// `workspaces`, `tools`, `settings`, `sandbox`, `executionMode`,
/// `worktreeNotices`, `contextBlock`, `platform`, `workMode`.
pub fn turn_system_prompt(input: &Value) -> String {
    let c = catalog();
    let settings = input.get("settings").unwrap_or(&Value::Null);
    let sandbox = truthy(input, "sandbox");
    let tool_names: Vec<&str> =
        input.get("tools").and_then(Value::as_array).map(|a| a.iter().map(name).collect()).unwrap_or_default();
    let has = |n: &str| tool_names.contains(&n);
    let workspaces: Vec<Workspace> = input
        .get("workspaces")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|w| Workspace {
                    name: w.get("name").map(js::display).unwrap_or_else(|| "undefined".into()),
                    path: w.get("path").map(js::display).unwrap_or_else(|| "undefined".into()),
                })
                .collect()
        })
        .unwrap_or_default();
    let str_of = |k: &str| settings.get(k).and_then(Value::as_str);
    let own = if sandbox { Some(c.sandbox_instructions.as_str()) } else { str_of("systemInstructions") };
    let watch = has("agent_watch").then_some(c.agent_watch_instructions.as_str());
    // `workModePrompt(input.workMode)`: an unknown or absent mode adds nothing.
    let work_mode = input
        .get("workMode")
        .and_then(Value::as_str)
        .and_then(|id| c.work_mode_prompts.get(id))
        .and_then(Value::as_str);
    let instructions =
        [own, watch, work_mode].into_iter().flatten().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n\n");
    let wrapper = if sandbox {
        c.default_turn_wrapper.as_str()
    } else {
        match settings.get("turnWrapper") {
            Some(Value::String(s)) => s.as_str(),
            _ => c.default_turn_wrapper.as_str(),
        }
    };
    let about = if sandbox { None } else { str_of("aboutUser") };
    let checkout = if sandbox {
        "This chat executes in an isolated container on copied folders, not a host checkout.".to_string()
    } else if input.get("executionMode").and_then(Value::as_str) == Some("unified") {
        "This chat uses the project\u{2019}s current Git branch, including local changes.".to_string()
    } else {
        input
            .get("worktreeNotices")
            .and_then(Value::as_array)
            .map(|a| a.iter().map(js::display).collect::<Vec<_>>().join("\n"))
            .unwrap_or_default()
    };
    let hint = if has("spawn_agent") {
        let orchestration = match settings.get("orchestration") {
            Some(o) if !o.is_null() => o,
            _ => &c.default_orchestration,
        };
        let providers = settings.get("providers").and_then(Value::as_array).cloned().unwrap_or_default();
        format!(
            "{}\n\n{}",
            orchestration_hint(orchestration),
            routing_prompt(&providers, settings.get("orchestration").filter(|v| !v.is_null()))
        )
    } else {
        String::new()
    };
    let block = input.get("contextBlock").and_then(Value::as_str).unwrap_or_default();
    let platform = input.get("platform").and_then(Value::as_str).unwrap_or_default();
    build_system_prompt(&PromptContext {
        workspaces: &workspaces,
        context_block: block,
        platform,
        orchestration_hint: &hint,
        can_ask: has(name(&c.ask_user)),
        can_plan: has(name(&c.update_plan)),
        system_instructions: Some(&instructions),
        turn_wrapper: Some(wrapper),
        about_user: about,
        checkout_notice: Some(&checkout),
    })
}

/// `hostToolApproval(name, mode, sandboxMode)`: whether a tool the turn runs
/// indirectly (a sub-agent, an MCP call) asks the user first, and the reason
/// the prompt shows. `None` when it runs without asking.
pub fn host_tool_approval(name: &str, mode: Option<&str>, sandbox_mode: Option<&str>) -> Option<String> {
    let indirect = name == "spawn_agent" || name.starts_with("mcp__");
    if !indirect || (mode != Some("ask") && sandbox_mode != Some("ask-everything")) {
        return None;
    }
    Some(if name == "spawn_agent" { "Delegate work to a sub-agent".into() } else { format!("Call {name}") })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_urls_like_the_regex() {
        assert_eq!(redact_urls("see https://a.b/c d"), "see [redacted] d");
        assert_eq!(redact_urls("HTTP://X and http:// alone"), "[redacted] and http:// alone");
        assert_eq!(redact_urls("httpss://x"), "httpss://x");
        assert_eq!(redact_urls("(http://x.y/z)"), "([redacted]");
    }
}
