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

/// Whether the orchestration strategy offers sub-agents (`getStrategy(...).allowsSpawn`).
pub fn allows_spawn(orchestration: Option<&Value>) -> bool {
    let o = match orchestration {
        Some(o) if !o.is_null() => o,
        _ => &catalog().default_orchestration,
    };
    strategy(o.get("strategy")).get("allowsSpawn") == Some(&Value::Bool(true))
}

/// `turnCanAsk`: nobody reads a sub-agent, an automation, a workflow run or a goal run.
pub fn turn_can_ask(session: &Value) -> bool {
    !truthy(session, "parentSessionId")
        && !truthy(session, "taskId")
        && !truthy(session, "trainingRunId")
        && !truthy(session, "workflowRunId")
}

/// `turnTools(input)`: the tools a (non-sandbox) turn offers, in order. `input`
/// is the TS `TurnToolInput`: `session`, `offline`, `orchestration`,
/// `allowBrowserControl`, `mcpTools`, `decide`, `noTools`, and the daemon's
/// own `media` and `video` (this computer has a picture / video model ready).
pub fn turn_tools(input: &Value) -> Vec<Value> {
    let offline = truthy(input, "offline");
    let c = catalog();
    // A tools-off turn reads untrusted text: nothing that acts is offered.
    if truthy(input, "noTools") {
        return vec![c.update_plan.clone()];
    }
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
    if session.get("orchestrate") == Some(&Value::Bool(true))
        && !incognito
        && let Some(spawn) = tools.iter_mut().find(|t| name(t) == "spawn_agent")
    {
        spawn["parameters"]["properties"]["capability"] = serde_json::json!({
            "type": "string",
            "enum": ["small", "medium", "large"],
            "description": "Optional worker capability. Omit provider_id and model_id when using it. Saved routing choices take priority."
        });
    }
    tools.push(c.update_plan.clone());
    if session.get("titleAuto") != Some(&Value::Bool(false)) && !parent {
        tools.push(c.set_chat_title.clone());
    }
    if !incognito && !parent && !training && !disabled.contains("complete_session") {
        tools.push(c.complete_session.clone());
    }
    if !parent
        && !training
        && !disabled.contains("remember")
        && nekko_context::MemoryScope::of_session(session).global()
    {
        tools.push(remember_tool());
    }
    // Read-only, so offered wherever the chat reads memory at all; offered
    // whether or not notes exist yet, so the tool list (part of the cached
    // prompt prefix) does not change when the first note is saved.
    if !parent
        && !training
        && !disabled.contains(RECALL_MEMORY)
        && nekko_context::MemoryScope::of_session(session).project()
    {
        tools.push(recall_memory_tool());
    }
    if training {
        tools.push(c.report_experiment.clone());
        tools.push(c.report_artifact.clone());
    }
    if can_ask && !disabled.contains(name(&c.ask_user)) {
        tools.push(c.ask_user.clone());
    }
    // #2594: the user gives a secret the agent's commands use and it never sees.
    if can_ask && !disabled.contains(crate::secret::REQUEST_SECRET) {
        tools.push(crate::secret::request_secret_tool());
    }
    if truthy(input, "decide") && !offline && !disabled.contains(name(&c.decide)) {
        tools.push(c.decide.clone());
    }
    // Local picture models: nothing leaves the computer, so offline keeps them.
    if truthy(input, "media") && !training {
        tools.extend(c.media.iter().filter(|t| !disabled.contains(name(t))).cloned());
    }
    // A clip wakes the chat later through a watch, which an incognito or
    // offline chat cannot be woken by.
    if truthy(input, "video") && !training && !incognito && !offline && !disabled.contains(name(&c.video)) {
        tools.push(c.video.clone());
    }
    tools
}

/// The memory search tool's name.
pub const RECALL_MEMORY: &str = "recall_memory";

/// The `recall_memory` tool: the model searches the user's memory notes in
/// its own words, for what the automatic recall on the message missed (#3276).
fn recall_memory_tool() -> Value {
    serde_json::json!({
        "name": RECALL_MEMORY,
        "description": "Search the user's long-term memory notes. Notes about the topic of a message are usually added to it already (\"# Memory recalled: <title>\"); call this when you need something about the user that is not in your context, for example their setup, people, projects or past decisions. Search with a few distinctive keywords, and try the words a note would use (notes are often written in English, whatever language the user writes in). Returns at most a few notes; nothing found means there is no such note, so do not guess.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Keywords to search for, e.g. \"editor IDE\" or \"deploy staging\"." }
            },
            "required": ["query"],
            "additionalProperties": false
        }
    })
}

/// The `remember` tool: the agent saves what it learns about the user as a
/// global memory note. Offered only where the chat reads global memory, so
/// incognito and memory-off chats never write it.
fn remember_tool() -> Value {
    serde_json::json!({
        "name": "remember",
        "description": "Save something you learned about the user to long-term memory so future chats know it: who they are, their preferences, how they like to work, people and projects they mention. Save durable facts only, never secrets, credentials or things that only matter to this chat. One fact per note with a short title; to correct a note, reuse its exact title (shown as \"# Memory: <title>\" or \"# Memory recalled: <title>\" in your context) and it is replaced. Set always to true only for what applies to every conversation (their name, the language or tone they want, standing preferences): those stay in every chat. Other notes are recalled when a message is about them. The user sees a card each time you save.",
        "parameters": {
            "type": "object",
            "properties": {
                "title": { "type": "string", "description": "Short name for the fact, e.g. \"Preferred name\"." },
                "body": { "type": "string", "description": "The fact, in a sentence or two of plain language." },
                "always": { "type": "boolean", "description": "Keep this note in every chat (identity, language, standing preferences). Leave out for facts that matter only when their topic comes up." }
            },
            "required": ["title", "body"],
            "additionalProperties": false
        }
    })
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

/// The sub-agent model preference (`orchestration.subagentModel`), unset
/// being `auto`. Mirrors `SubagentModelChoice` in packages/shared.
pub fn subagent_preference(orchestration: Option<&Value>) -> &'static str {
    match orchestration.and_then(|o| o.get("subagentModel")).and_then(Value::as_str) {
        Some("auto-same-provider") => "auto-same-provider",
        Some("auto-local") => "auto-local",
        Some("inherit") => "inherit",
        _ => "auto",
    }
}

fn subagent_preference_text(orchestration: Option<&Value>) -> &'static str {
    match subagent_preference(orchestration) {
        "auto-same-provider" => "a lighter model than this chat's, on this chat's provider",
        "auto-local" => "in Fusion, a local model when set up; otherwise a lighter model on this chat's provider",
        "inherit" => "this chat's own provider and model",
        _ => "a lighter model than this chat's, chosen by Nekko",
    }
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
        format!(
            "Omit provider_id and model_id to use the user's sub-agent model preference: {}. An explicit provider change requires an explicit exact model ID for that provider.",
            subagent_preference_text(orchestration)
        ),
        "Use delegation_targets to discover exact chat-model IDs on the intended provider before explicit delegation; never guess. If discovery fails, report the blocker or ask the user, not a different provider. Explicit and user-configured default routes are validated before creating a child.".into(),
        format!("Subagent capability target: {}. Automatic picks never exceed the parent tier.", orchestration.and_then(|o| o.get("subagentTier")).and_then(Value::as_str).unwrap_or("smaller")),
        format!(
            "User-selected delegation default: {}. When set, omitted routing arguments use this route, not the parent. Explicit arguments override it.",
            safe(&js::stringify(route))
        ),
        "Only Fusion (both autoModel and autoProviderSwitch enabled on this chat) allows changing provider, including explicit targets and saved routes. Auto alone stays on the chat provider. There is no fallback to another provider or model on failure. Keep sensitive work on the intended provider; do not switch to a cloud provider to bypass a local failure. Incognito delegation is unavailable because child sessions are persisted.".into(),
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
/// ` (repository github:owner/name)` for a folder cloned from a git provider
/// (#2404), so the model can match "the app repo" to its folder; else empty.
pub fn repo_suffix(workspace: &Value) -> String {
    let repo = &workspace["repo"];
    match (repo["provider"].as_str(), repo["fullName"].as_str()) {
        (Some(p), Some(full)) if !full.is_empty() => format!(" (repository {p}:{full})"),
        _ => String::new(),
    }
}

/// Applies to the agent's use of tools, not to ordinary local git operations.
pub const HYPERGATE_GITHUB: &str = "GitHub access for this chat goes through Hypergate, starting with the first read. Use its GitHub tools if offered. Treat repository examples such as `gh issue list` as shorthand, not permission to run bare gh. For CLI access, use Hypergate's clis_list and credentials_list; run `hypergate run --agent nekko-agent --with <allowed-github-credential-id> -- <reported-gh-path> ...`. For a GitHub fetch or push, use HTTPS with the scoped gh credential helper, not the SSH remote or a cached login. Local git status, diff and commits need no gateway. If the gateway or grant is unavailable, report it and request access in Hypergate; do not try a direct API call, sign in separately, or retrieve a raw token.";

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
                    name: format!(
                        "{}{}",
                        w.get("name").map(js::display).unwrap_or_else(|| "undefined".into()),
                        repo_suffix(w)
                    ),
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
    let tracking = if sandbox { String::new() } else { work_tracking(settings) };
    let github = (!sandbox && settings["hypergateEnabled"].as_bool() == Some(true)).then_some(HYPERGATE_GITHUB);
    let instructions = [own, watch, work_mode, Some(tracking.as_str()), github]
        .into_iter()
        .flatten()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
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
        model_instructions: if sandbox { None } else { str_of("modelSystemInstructions") },
        turn_wrapper: Some(wrapper),
        about_user: about,
        checkout_notice: Some(&checkout),
        // Absent (or `auto`, unresolved): the full prompt, as before profiles.
        profile: input
            .get("promptProfile")
            .and_then(Value::as_str)
            .and_then(nekko_context::PromptProfile::parse)
            .unwrap_or_default(),
    })
}

/// The work tracking preferences from Settings > Project management and Pull
/// requests, one line per explicit choice. Unset choices add nothing, so the
/// prompt's defaults apply: file and link an issue, ask before including.
pub fn work_tracking(settings: &Value) -> String {
    let pick = |group: &str, key: &str, on: &str, off: &str| -> Option<String> {
        match settings.pointer(&format!("/{group}/{key}")) {
            Some(Value::Bool(true)) if !on.is_empty() => Some(format!("- {on}")),
            Some(Value::Bool(false)) => Some(format!("- {off}")),
            _ => None,
        }
    };
    let lines: Vec<String> = [
        pick(
            "projectManagement",
            "createIssue",
            "",
            "Do not file an issue for each change; link an existing issue only when the user names one.",
        ),
        pick(
            "projectManagement",
            "includePrompt",
            "Include the user's prompt in new issues.",
            "Leave the user's prompt out of issues.",
        ),
        pick(
            "projectManagement",
            "includeScreenshots",
            "Include relevant user-sent screenshots in new issues.",
            "Leave user-sent screenshots out of issues.",
        ),
        pick(
            "projectManagement",
            "includeContext",
            "Include other relevant chat context (attachments, logs, a short summary) in new issues.",
            "Leave other chat context out of issues.",
        ),
        pick("pullRequests", "linkIssue", "", "Do not link PRs to issues."),
        pick(
            "pullRequests",
            "includePrompt",
            "Include the user's prompt in PR descriptions.",
            "Leave the user's prompt out of PR descriptions.",
        ),
        pick(
            "pullRequests",
            "includeScreenshots",
            "Include relevant user-sent screenshots in PR descriptions.",
            "Leave user-sent screenshots out of PR descriptions.",
        ),
    ]
    .into_iter()
    .flatten()
    .collect();
    if lines.is_empty() {
        return String::new();
    }
    format!(
        "Work tracking preferences (Settings > Project management and Pull requests; they override the defaults):\n{}",
        lines.join("\n")
    )
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

    #[test]
    fn work_tracking_states_only_explicit_choices() {
        assert_eq!(work_tracking(&serde_json::json!({})), "");
        // Defaults spelled out add nothing: the prompt already files and links issues.
        let on =
            serde_json::json!({ "projectManagement": { "createIssue": true }, "pullRequests": { "linkIssue": true } });
        assert_eq!(work_tracking(&on), "");
        let t = work_tracking(&serde_json::json!({
            "projectManagement": { "createIssue": false, "includePrompt": true, "includeScreenshots": false },
            "pullRequests": { "includeScreenshots": true },
        }));
        assert!(t.starts_with("Work tracking preferences"));
        assert!(t.contains("- Do not file an issue for each change"));
        assert!(t.contains("- Include the user's prompt in new issues."));
        assert!(t.contains("- Leave user-sent screenshots out of issues."));
        assert!(t.contains("- Include relevant user-sent screenshots in PR descriptions."));
        assert!(!t.contains("chat context"));
        let turn = turn_system_prompt(&serde_json::json!({ "settings": { "pullRequests": { "linkIssue": false } } }));
        assert!(turn.contains("- Do not link PRs to issues."));
    }

    #[test]
    fn paired_github_guidance_precedes_any_tool_result() {
        for profile in ["small", "medium", "large"] {
            let mut input = serde_json::json!({ "promptProfile": profile, "tools": [], "settings": {} });
            assert!(!turn_system_prompt(&input).contains(HYPERGATE_GITHUB));
            input["settings"]["hypergateEnabled"] = serde_json::json!(true);
            let paired = turn_system_prompt(&input);
            assert!(paired.contains("hypergate run --agent nekko-agent --with <allowed-github-credential-id>"));
            assert!(!paired.contains("gh auth login"));
            input["sandbox"] = serde_json::json!(true);
            assert!(!turn_system_prompt(&input).contains(HYPERGATE_GITHUB));
        }
    }

    #[test]
    fn exact_model_guidance_adds_one_section_without_changing_any_other_directive() {
        let model_section = "Model-specific guidance (does not override other instructions):\nUse short headings.\n";
        let c = catalog();
        for profile in ["small", "medium", "large"] {
            let mut input = serde_json::json!({
                "promptProfile": profile,
                "workMode": "plan",
                "tools": [c.ask_user, c.update_plan, { "function": { "name": "agent_watch" } }],
                "settings": {
                    "systemInstructions": "Keep test reports.",
                    "turnWrapper": "Check the result.",
                    "pullRequests": { "linkIssue": false }
                },
                "contextBlock": "Always read the project guide."
            });
            let ordinary = turn_system_prompt(&input);
            input["settings"]["modelSystemInstructions"] = serde_json::json!(" Use short headings. ");
            let composed = turn_system_prompt(&input);
            assert_eq!(composed.matches(model_section).count(), 1);
            assert_eq!(composed.replace(model_section, ""), ordinary);
            assert!(composed.contains("Keep test reports."));
            assert!(composed.contains("Do not link PRs to issues."));
            assert!(composed.contains("Server instructions for this user turn:\nCheck the result."));
            assert!(composed.contains("Always read the project guide."));
            input["sandbox"] = serde_json::json!(true);
            assert!(!turn_system_prompt(&input).contains("Use short headings."));
        }
    }

    fn names(input: serde_json::Value) -> Vec<String> {
        turn_tools(&input).iter().map(|t| name(t).to_string()).collect()
    }

    #[test]
    fn spawn_capability_schema_is_optional_and_scoped_to_orchestrate() {
        let spawn = |input| turn_tools(&input).into_iter().find(|t| name(t) == "spawn_agent");
        let plain = spawn(serde_json::json!({})).unwrap();
        assert!(plain["parameters"]["properties"].get("capability").is_none());
        for flag in [serde_json::json!(false), serde_json::json!("true")] {
            assert_eq!(spawn(serde_json::json!({"session":{"orchestrate":flag}})), Some(plain.clone()));
        }
        let mut offered = spawn(serde_json::json!({"session":{"orchestrate":true}})).unwrap();
        let capability = offered["parameters"]["properties"].as_object_mut().unwrap().remove("capability").unwrap();
        assert_eq!(capability["enum"], serde_json::json!(["small", "medium", "large"]));
        assert_eq!(offered, plain, "nothing else about the spawn tool changes");
        assert!(spawn(serde_json::json!({"session":{"orchestrate":true}, "noTools":true})).is_none());
        assert!(spawn(serde_json::json!({"session":{"orchestrate":true}, "offline":true})).is_none());
        assert!(
            spawn(serde_json::json!({"session":{"orchestrate":true}, "orchestration":{"strategy":"solo"}})).is_none()
        );
    }

    #[test]
    fn picture_tools_come_only_with_a_ready_picture_model() {
        let session = serde_json::json!({ "id": "s" });
        let without = names(serde_json::json!({ "session": session }));
        assert!(!without.iter().any(|n| n == "generate_image"), "{without:?}");
        let with = names(serde_json::json!({ "session": session, "media": true }));
        for tool in ["generate_image", "edit_image", "media_models"] {
            assert!(with.iter().any(|n| n == tool), "{tool}: {with:?}");
        }
        // Local models: an offline chat keeps them.
        let offline = names(serde_json::json!({ "session": session, "media": true, "offline": true }));
        assert!(offline.iter().any(|n| n == "generate_image"), "{offline:?}");
        // The chat's own tool switches still apply.
        let off = serde_json::json!({ "id": "s", "disabledTools": ["edit_image"] });
        let some = names(serde_json::json!({ "session": off, "media": true }));
        assert!(some.iter().any(|n| n == "generate_image") && !some.iter().any(|n| n == "edit_image"), "{some:?}");
        // The clip tool comes with a ready video model, never in incognito.
        let clip = names(serde_json::json!({ "session": session, "video": true }));
        assert!(clip.iter().any(|n| n == "generate_video") && !clip.iter().any(|n| n == "generate_image"), "{clip:?}");
        let hidden = serde_json::json!({ "id": "s", "incognito": true });
        assert!(!names(serde_json::json!({ "session": hidden, "video": true })).iter().any(|n| n == "generate_video"));
        assert!(
            !names(serde_json::json!({ "session": session, "video": true, "offline": true }))
                .iter()
                .any(|n| n == "generate_video")
        );
        // A tools-off turn gets none.
        assert!(
            !names(serde_json::json!({ "session": session, "media": true, "noTools": true }))
                .iter()
                .any(|n| n == "generate_image")
        );
    }
}
