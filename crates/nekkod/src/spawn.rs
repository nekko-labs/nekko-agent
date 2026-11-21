//! `spawn_agent`'s preparation here (PF14 step 5 prep): the checks a call
//! must pass, the child chat, and the child's turn admitted, all in this
//! daemon. Ports of `prepareSubAgent`, `sessionDepth`, `childSendOptions` and
//! the `spawn` callback of `hostTurnFor` (packages/host/src/chat.ts). The
//! parent turn (turns.rs `spawn_agent`) asks through the router
//! (`turn:spawnPrepare`) and drives the child itself.

use crate::routes::Ctx;
use nekko_js as js;
use serde_json::{Value, json};

/// A sub-agent's chat may be at most this deep unless the settings say otherwise.
const DEFAULT_MAX_DEPTH: f64 = 2.0;

fn s<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str)
}

/// `sessionDepth(id)`: how many parents up the chain goes (at most 16).
fn session_depth(store: &nekko_store::SessionStore, id: &str) -> usize {
    let mut depth = 0;
    let mut cur = store.meta(id).map(|m| m.into_value());
    while let Some(parent) = cur.as_ref().and_then(|c| s(c, "parentSessionId")).map(str::to_string) {
        if depth >= 16 {
            break;
        }
        depth += 1;
        cur = store.meta(&parent).map(|m| m.into_value());
    }
    depth
}

/// A child chat's title: the one it was given, else the start of its task.
pub fn child_title(title: Option<&str>, task: &str) -> String {
    let title = title.map(|t| js::trim(t).to_string()).filter(|t| !t.is_empty());
    let title = title.unwrap_or_else(|| js::slice16(js::trim(task), 40).to_string());
    if title.is_empty() { "Sub-agent".to_string() } else { title }
}

/// `getSessionWorkspaceIds(session)`: the folder, then the supporting ones, once each.
pub fn workspace_ids(session: &Value) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut push = |v: &Value| {
        if js::truthy(Some(v)) && !out.contains(v) {
            out.push(v.clone());
        }
    };
    if let Some(w) = session.get("workspaceId") {
        push(w);
    }
    for w in session.get("supportingWorkspaceIds").and_then(Value::as_array).into_iter().flatten() {
        push(w);
    }
    out
}

/// The child prepared: its chat, where it runs, and its task.
struct Child {
    id: String,
    provider_id: Value,
    model_id: Value,
    task: String,
    provider: Value,
}

/// An exact id: a nonblank string with no surrounding whitespace.
fn exact(v: &Value) -> bool {
    v.as_str().is_some_and(|t| !js::trim(t).is_empty() && js::trim(t) == t)
}

/// Auto changes models; only Fusion grants provider switching. Preferences,
/// caller snapshots and saved routes cannot override the persisted chat scope.
pub(crate) fn fusion_enabled(parent: &Value) -> bool {
    parent.get("autoModel") == Some(&Value::Bool(true))
        && parent.get("autoProviderSwitch") == Some(&Value::Bool(true))
        && !js::truthy(parent.get("offline"))
        && !js::truthy(parent.get("incognito"))
}

pub(crate) fn check_delegation_route(parent: &Value, source: Option<&Value>, target: &Value) -> Result<(), String> {
    if js::truthy(parent.get("cloudOnly")) && !crate::admission::cloud_provider_allowed(target) {
        return Err(
            "This chat runs on cloud models only, so a sub-agent cannot use a local model. No child was started."
                .into(),
        );
    }
    let same = source.is_some_and(|p| p == target || (p.get("id").is_some() && p.get("id") == target.get("id")));
    if source.is_none() || (!same && !fusion_enabled(parent)) {
        return Err("Provider switching requires Fusion mode, including local models and saved subagent routes. Auto stays on this provider. No child was started and no fallback was used.".into());
    }
    Ok(())
}

const MODEL_LIST_UNAVAILABLE: &str = "Could not verify the target provider model list. Check its availability; no child was created and no fallback was used.";

pub(crate) async fn delegation_models(ctx: &Ctx, provider: &Value, strict: bool) -> Result<Vec<Value>, String> {
    let pid = s(provider, "id").ok_or(MODEL_LIST_UNAVAILABLE)?;
    match crate::providers::list_saved(ctx, provider, pid, false).await {
        Ok(models) if !strict || !models.iter().any(|m| m.fallback) => Ok(models
            .into_iter()
            .filter(|m| m.provider_id == pid)
            .map(|m| serde_json::to_value(m).unwrap_or(Value::Null))
            .collect()),
        _ => Err(MODEL_LIST_UNAVAILABLE.into()),
    }
}

/// The sub-agent model preference's pick, `(provider, model)`, or `None` to
/// inherit the parent's. With an assignment capability, only the user's
/// explicit inherit preference can inherit; failed discovery never falls back.
async fn auto_target(
    ctx: &Ctx,
    parent: &Value,
    settings: &Value,
    provider_id: &Value,
    model_id: &Value,
    assignment: Option<i32>,
) -> Result<Option<(Value, Value)>, String> {
    use crate::subagent_model::{assignment_ceiling, preference, tiered_model};
    let preference = preference(settings.get("orchestration"));
    let strict = assignment.is_some();
    let no_parent = || {
        "The parent needs a known capability tier for automatic assignment routing. Choose or classify a parent model; no child was created.".to_string()
    };
    let Some((parent_model, pid)) = model_id.as_str().filter(|m| !m.is_empty()).zip(provider_id.as_str()) else {
        return if strict { Err(no_parent()) } else { Ok(None) };
    };
    // A parent on ✨ Auto already routes per message: its child inherits that,
    // except that Auto and prefer-local first look for a local model.
    let on_auto = parent_model == "__auto__";
    if strict && on_auto {
        return Err(no_parent());
    }
    if preference == "inherit" || (on_auto && preference == "auto-same-provider") {
        return Ok(None);
    }
    let ceiling = assignment
        .map(|tier| assignment_ceiling(tier, parent_model, pid, settings).ok_or_else(no_parent))
        .transpose()?;
    let providers = settings.get("providers").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    let source = providers.iter().find(|p| p.get("id") == Some(provider_id));
    // Claude Code runs its own sub-agents, not this tool.
    if source.is_none_or(|p| p.get("kind").and_then(Value::as_str) == Some("claude-code")) {
        return if strict {
            Err("Automatic assignment routing is unavailable on the parent provider.".into())
        } else {
            Ok(None)
        };
    }
    if strict && let Some(source) = source {
        if !js::truthy(source.get("enabled")) || crate::admission::provider_endpoint(source).is_none() {
            return Err("The parent provider is disabled or needs a valid HTTP(S) endpoint.".into());
        }
        check_delegation_route(parent, Some(source), source)?;
    }
    let source_is_local = source.is_some_and(nekko_turn::providers::offline_provider_allowed);
    if !source_is_local && fusion_enabled(parent) && matches!(preference, "auto" | "auto-local") {
        let loaded_only = preference == "auto";
        let mut best: Option<(i32, bool, Value, String)> = None;
        for p in providers.iter().filter(|p| {
            js::truthy(p.get("enabled"))
                && nekko_turn::providers::offline_provider_allowed(p)
                && check_delegation_route(parent, source, p).is_ok()
        }) {
            let Some(id) = s(p, "id") else { continue };
            if strict && crate::admission::provider_endpoint(p).is_none() {
                return Err("Target provider requires a valid HTTP(S) endpoint. No fallback was used.".into());
            }
            let models = match delegation_models(ctx, p, strict).await {
                Ok(models) => models,
                Err(e) if strict => return Err(e),
                Err(_) => continue,
            };
            if let Some(model_id) = tiered_model(parent_model, pid, &models, settings, loaded_only, true, ceiling)
                && let Some(model) = models.iter().find(|m| m.get("id").and_then(Value::as_str) == Some(&model_id))
            {
                let rank = nekko_messaging::auto::tier_with_overrides(model, settings.pointer("/fusion/modelTiers"));
                let loaded = model.get("loaded") == Some(&Value::Bool(true));
                if best.as_ref().is_none_or(|(r, l, _, _)| (rank, loaded) > (*r, *l)) {
                    best = Some((rank, loaded, json!(id), model_id));
                }
            }
        }
        if let Some((_, _, provider, model)) = best {
            return Ok(Some((provider, json!(model))));
        }
    }
    if on_auto {
        return Ok(None);
    }
    let Some(source) = source.filter(|p| js::truthy(p.get("enabled"))) else { return Ok(None) };
    let models = match delegation_models(ctx, source, strict).await {
        Ok(models) => models,
        Err(e) if strict => return Err(e),
        Err(_) => return Ok(None),
    };
    let target = tiered_model(parent_model, pid, &models, settings, false, false, ceiling)
        .map(|m| (provider_id.clone(), json!(m)));
    if strict && target.is_none() {
        return Err("No eligible model fits the assignment capability and saved routing constraints. No child was created and no fallback was used.".into());
    }
    Ok(target)
}

/// `prepareSubAgent(parent, providerId, modelId, input)`: refused with
/// nothing created, or the child chat made.
async fn prepare_sub_agent(
    ctx: &Ctx,
    parent: &Value,
    provider_id: &Value,
    model_id: &Value,
    input: &Value,
    call_id: Option<&str>,
    settings: &Value,
) -> Result<Child, String> {
    let store = ctx.sessions.clone();
    let parent_id = s(parent, "id").unwrap_or_default().to_string();
    let orchestration = settings.get("orchestration").filter(|o| !o.is_null());
    let max_depth = orchestration
        .and_then(|o| o.get("maxDepth"))
        .filter(|d| !d.is_null())
        .map(|d| js::to_number(Some(d)))
        .unwrap_or(DEFAULT_MAX_DEPTH);
    let depth = {
        let (st, id) = (store.clone(), parent_id.clone());
        tokio::task::spawn_blocking(move || session_depth(&st, &id)).await.map_err(|e| e.to_string())?
    };
    if max_depth.is_nan() || depth as f64 >= max_depth {
        return Err(
            "Sub-agent depth limit reached, handle this part of the task directly instead of delegating further."
                .into(),
        );
    }
    if js::truthy(parent.get("incognito")) {
        return Err("Delegation is unavailable in incognito chats because child sessions are persisted. Handle this task in the current chat.".into());
    }
    if crate::connections::offline(parent) {
        return Err("Offline chats cannot start sub-agents.".into());
    }
    let Some(inp) = input.as_object() else { return Err("Sub-agent input must be an object.".into()) };
    let task = inp.get("task").and_then(Value::as_str).filter(|t| !js::trim(t).is_empty());
    let Some(task) = task.map(str::to_string) else {
        return Err("A nonblank task is required for the sub-agent.".into());
    };
    let title = inp.get("title");
    if title.is_some_and(|t| !t.is_string()) {
        return Err("Sub-agent title must be a string.".into());
    }
    for key in ["provider_id", "model_id"] {
        if let Some(v) = inp.get(key)
            && !exact(v)
        {
            return Err(format!(
                "{key} must be a nonblank exact ID without surrounding whitespace. To inherit this chat's provider and model, omit provider_id and model_id entirely rather than sending them empty; to route elsewhere, call delegation_targets first and pass an exact ID it returns."
            ));
        }
    }
    let assignment = if let Some(value) = inp.get("capability") {
        if parent.get("orchestrate") != Some(&Value::Bool(true)) {
            return Err("Sub-agent capability is only available in Orchestrate chats.".into());
        }
        let rank = match value.as_str() {
            Some(tier @ ("small" | "medium" | "large")) => nekko_messaging::auto::capability_rank(tier),
            _ => return Err("Sub-agent capability must be small, medium, or large.".into()),
        };
        if inp.contains_key("provider_id") || inp.contains_key("model_id") {
            return Err("Omit provider_id and model_id when requesting a sub-agent capability.".into());
        }
        if !crate::orchestrate_state::can_coordinate(parent, settings) {
            return Err("Delegation is unavailable in this chat.".into());
        }
        rank
    } else {
        None
    };
    let explicit_model = inp.contains_key("model_id");
    let default_route = orchestration
        .and_then(|o| o.get("delegationRoute"))
        .filter(|r| !inp.contains_key("provider_id") && !explicit_model && !r.is_null());
    let route = |k: &str| default_route.and_then(|r| r.get(k)).filter(|v| !v.is_null()).cloned();
    if default_route.is_some() && ["providerId", "modelId"].iter().any(|key| route(key).is_none_or(|v| !exact(&v))) {
        return Err("The saved delegation route requires exact provider and model IDs. No fallback was used.".into());
    }
    // Nothing named and no saved route: the sub-agent model preference (#2487).
    let auto = if !inp.contains_key("provider_id") && !explicit_model && default_route.is_none() {
        auto_target(ctx, parent, settings, provider_id, model_id, assignment).await?
    } else {
        None
    };
    let target_provider = inp
        .get("provider_id")
        .cloned()
        .or_else(|| route("providerId"))
        .or_else(|| auto.as_ref().map(|a| a.0.clone()))
        .unwrap_or_else(|| provider_id.clone());
    let target_model = inp
        .get("model_id")
        .cloned()
        .or_else(|| route("modelId"))
        .or_else(|| auto.as_ref().map(|a| a.1.clone()))
        .unwrap_or_else(|| model_id.clone());
    if target_provider != *provider_id && !explicit_model && default_route.is_none() && auto.is_none() {
        return Err("Changing provider requires an explicit model_id known to belong to that provider. Ask the user for the exact model ID; never guess.".into());
    }
    if target_model.as_str().is_none_or(|m| js::trim(m).is_empty()) {
        return Err("A nonblank target model ID is required.".into());
    }
    let provider = settings
        .get("providers")
        .and_then(Value::as_array)
        .and_then(|ps| ps.iter().find(|p| p.get("id") == Some(&target_provider)).cloned());
    let Some(provider) = provider.filter(|p| js::truthy(p.get("enabled"))) else {
        return Err("Target provider is unknown or disabled.".into());
    };
    if crate::admission::provider_endpoint(&provider).is_none() {
        return Err("Target provider requires a valid HTTP(S) endpoint.".into());
    }
    let source = settings
        .get("providers")
        .and_then(Value::as_array)
        .and_then(|ps| ps.iter().find(|p| p.get("id") == Some(provider_id)));
    check_delegation_route(parent, source, &provider)?;
    if explicit_model || default_route.is_some() {
        let models = delegation_models(
            ctx,
            &provider,
            assignment.is_some() || crate::orchestrate_state::can_coordinate(parent, settings),
        )
        .await?;
        let model = models.iter().find(|m| m.get("id") == Some(&target_model));
        let Some(model) = model else {
            return Err("The exact model ID is not available from the target provider. Use delegation_targets on the intended provider to refresh exact IDs, or update the saved delegation route in Settings; no fallback was used.".into());
        };
        if !nekko_messaging::auto::is_chat_model(model) {
            return Err("The selected model is not a chat model. No child was created.".into());
        }
        if assignment.is_some()
            && model.pointer("/availability/status").and_then(Value::as_str).is_some_and(|s| s != "ready")
        {
            return Err(
                "The saved delegation model is not ready. No child was created and no fallback was used.".into()
            );
        }
    }
    // Listing may wait on a provider. Do not create or send a child on choices
    // that changed while it was in flight.
    let live_settings = crate::settings::current(ctx).await;
    let live_parent = store.meta(&parent_id).ok_or("Unknown parent session.")?.into_value();
    if !same_policy(parent, &live_parent, settings, &live_settings)
        || !same_provider(provider_id, settings, &live_settings)
        || !same_provider(&target_provider, settings, &live_settings)
    {
        return Err("Delegation settings changed while checking the route. Retry with the current settings.".into());
    }
    let supporting: Vec<Value> = workspace_ids(parent).into_iter().skip(1).collect();
    let made =
        crate::routes::create_session(ctx, s(parent, "workspaceId"), Some(&parent_id), Some(json!(supporting))).await?;
    let id = s(&made, "id").unwrap_or_default().to_string();
    let title = child_title(title.and_then(Value::as_str), &task);
    // What the child takes from its parent: its tool policy, nothing it switched
    // off, and its Privacy Shield (a shielded chat's sub-agents are shielded too).
    let mut fields: Vec<(&'static str, Value)> =
        vec![("title", json!(title)), ("providerId", target_provider.clone()), ("modelId", target_model.clone())];
    if let Some(call) = call_id {
        fields.push(("spawnCallId", json!(call)));
    }
    // Override global creation defaults, including when the parent has no flags.
    for key in ["autoModel", "autoProviderSwitch"] {
        fields.push((key, json!(js::truthy(parent.get(key)))));
    }
    for key in [
        "mode",
        "disabledTools",
        "disabledMcpServers",
        "disabledConnectors",
        "effort",
        "memory",
        "guidance",
        "toolApproach",
        "offline",
        "cloudOnly",
        "incognito",
        "syncOff",
        "privacy",
    ] {
        if let Some(v) = parent.get(key) {
            fields.push((key, v.clone()));
        }
    }
    let (st, cid) = (store.clone(), id.clone());
    tokio::task::spawn_blocking(move || st.assign(&cid, &fields)).await.map_err(|e| e.to_string())??;
    Ok(Child { id, provider_id: target_provider, model_id: target_model, task, provider })
}

/// Inputs to route selection, tool authorization and inherited privacy.
fn same_policy(parent: &Value, live: &Value, settings: &Value, current: &Value) -> bool {
    !crate::connections::offline(live)
        && [
            "id",
            "orchestrate",
            "mode",
            "providerId",
            "modelId",
            "executionMode",
            "autoModel",
            "autoProviderSwitch",
            "cloudOnly",
            "offline",
            "incognito",
            "syncOff",
            "privacy",
            "disabledTools",
            "disabledMcpServers",
            "disabledConnectors",
            "memory",
            "guidance",
            "toolApproach",
            "effort",
            "workspaceId",
            "supportingWorkspaceIds",
            "home",
            "archivedAt",
            "parentSessionId",
        ]
        .iter()
        .all(|k| parent.get(k) == live.get(k))
        && [
            "orchestration",
            "defaultChatMode",
            "sandboxMode",
            "privacyMode",
            "privacyTerms",
            "privacyDisabledKinds",
            "effort",
        ]
        .iter()
        .all(|k| settings.get(k) == current.get(k))
        && settings.pointer("/fusion/modelTiers") == current.pointer("/fusion/modelTiers")
}

fn same_provider(id: &Value, settings: &Value, current: &Value) -> bool {
    fn find<'a>(id: &Value, settings: &'a Value) -> Option<&'a Value> {
        settings.get("providers")?.as_array()?.iter().find(|provider| provider.get("id") == Some(id))
    }
    find(id, settings) == find(id, current)
}

// The internal RPC transports failures as strings. Keep these two fixed messages
// shared with the tool adapter so callers retain their actionable error codes.
pub(crate) const DISCOVERY_PROVIDER_UNAVAILABLE: &str =
    "Provider is unknown or disabled. Enable the intended provider in Models.";
pub(crate) const DISCOVERY_INVALID_ENDPOINT: &str = "Configure a valid HTTP(S) endpoint for the intended provider.";

/// Discovery also goes through the saved scope: it is a network request on
/// the chosen provider, not permission to enumerate other configured accounts.
pub(crate) async fn discover(ctx: &Ctx, req: &Value) -> Result<Vec<Value>, String> {
    let store = ctx.sessions.clone();
    let id = s(req, "sessionId").unwrap_or_default().to_owned();
    let parent = tokio::task::spawn_blocking(move || store.meta(&id))
        .await
        .ok()
        .flatten()
        .ok_or("Delegation discovery is unavailable in this chat.")?
        .into_value();
    let settings = crate::settings::current(ctx).await;
    if js::truthy(parent.get("incognito"))
        || crate::connections::offline(&parent)
        || !nekko_turn::plan::allows_spawn(settings.get("orchestration"))
        || js::truthy(parent.get("archivedAt"))
        || js::truthy(parent.pointer("/home/deviceId"))
        || crate::worktrees::execution_mode(&parent) == "sandbox"
        || parent
            .get("disabledTools")
            .and_then(Value::as_array)
            .is_some_and(|tools| tools.iter().any(|t| t == "spawn_agent" || t == "delegation_targets"))
    {
        return Err("Delegation discovery is unavailable in this chat.".into());
    }
    let find = |id| {
        settings.get("providers").and_then(Value::as_array).and_then(|ps| ps.iter().find(|p| s(p, "id") == Some(id)))
    };
    let source_id = if fusion_enabled(&parent) {
        s(req, "sourceId").or_else(|| s(&parent, "providerId"))
    } else {
        s(&parent, "providerId").or_else(|| s(req, "sourceId"))
    };
    let target = s(req, "providerId")
        .and_then(find)
        .filter(|p| js::truthy(p.get("enabled")))
        .ok_or(DISCOVERY_PROVIDER_UNAVAILABLE)?;
    check_delegation_route(&parent, source_id.and_then(find), target)?;
    if crate::admission::provider_endpoint(target).is_none() {
        return Err(DISCOVERY_INVALID_ENDPOINT.into());
    }
    let mut models = delegation_models(ctx, target, true).await?;
    models.retain(|m| nekko_messaging::auto::is_chat_model(m) && m.get("id").is_some_and(exact));
    let live_settings = crate::settings::current(ctx).await;
    let live = s(&parent, "id").and_then(|id| ctx.sessions.meta(id)).map(|m| m.into_value());
    if live.as_ref().is_none_or(|live| !same_policy(&parent, live, &settings, &live_settings))
        || !same_provider(&target["id"], &settings, &live_settings)
        || source_id.is_some_and(|id| !same_provider(&json!(id), &settings, &live_settings))
    {
        return Err("Delegation settings changed while listing models. Refresh before trying again.".into());
    }
    Ok(models.into_iter().map(|m| json!({"modelId": m["id"]})).collect())
}

/// `turn:spawnPrepare({ parent, providerId, modelId, input, attempt, childId })`:
/// `{ error }` when the call is refused, `{ childId, failure }` when the
/// child's turn could not start, else `{ childId, spec }` for the parent to drive.
pub async fn prepare(ctx: &Ctx, req: &Value) -> Value {
    // The turn snapshot may predate a user changing the routing/privacy mode.
    let snapshot = req.get("parent").cloned().unwrap_or(Value::Null);
    let Some(parent) = s(&snapshot, "id").and_then(|id| ctx.sessions.meta(id)).map(|m| m.into_value()) else {
        return json!({ "error": "Unknown parent session." });
    };
    if js::truthy(parent.get("incognito")) || crate::connections::offline(&parent) {
        return json!({ "error": "Offline or incognito chats cannot start or resume sub-agents." });
    }
    let settings = crate::settings::current(ctx).await;
    if !nekko_turn::plan::allows_spawn(settings.get("orchestration"))
        || js::truthy(parent.get("archivedAt"))
        || js::truthy(parent.pointer("/home/deviceId"))
        || crate::worktrees::execution_mode(&parent) == "sandbox"
        || parent
            .get("disabledTools")
            .and_then(Value::as_array)
            .is_some_and(|tools| tools.iter().any(|t| t == "spawn_agent"))
    {
        return json!({ "error": "Delegation is unavailable in this chat." });
    }
    if let Some(approved) = s(req, "approvedMode") {
        let live = s(&parent, "mode").or_else(|| s(&settings, "defaultChatMode")).unwrap_or("guardrails");
        let sandbox_mode = s(&settings, "sandboxMode");
        if approved != live || s(req, "approvedSandboxMode") != sandbox_mode {
            return json!({ "error": "Chat mode changed. Re-run delegation with the current approval mode." });
        }
    }
    // A stale or forged caller provider must not redefine a pinned chat's scope.
    // Fusion may legitimately execute this turn on a provider different from home.
    let current = |key: &str| {
        let caller = req.get(key).filter(|v| !v.is_null());
        let saved = parent.get(key).filter(|v| !v.is_null());
        if fusion_enabled(&parent) { caller.or(saved) } else { saved.or(caller) }.cloned().unwrap_or(Value::Null)
    };
    let (provider_id, model_id) = (current("providerId"), current("modelId"));
    if s(req, "approvedMode").is_some()
        && !fusion_enabled(&parent)
        && (req.get("providerId") != Some(&provider_id) || req.get("modelId") != Some(&model_id))
    {
        return json!({ "error": "The parent model route changed. Retry on the current route." });
    }
    let attempt = req.get("attempt").map(Value::as_u64).unwrap_or(Some(0));
    let resume = match (attempt, req.get("childId")) {
        (Some(0), None | Some(Value::Null)) => false,
        (Some(1), Some(Value::String(id))) if nekko_store::valid_id(id) => true,
        _ => return json!({ "error": "Invalid sub-agent start or resume request." }),
    };
    let call_id = s(req, "callId");
    if req.get("callId").is_some() && call_id.is_none_or(|id| js::trim(id).is_empty()) {
        return json!({ "error": "Invalid sub-agent call ID." });
    }
    let capability = req.pointer("/input/capability").is_some();
    if resume && capability && !crate::orchestrate_state::can_coordinate(&parent, &settings) {
        return json!({ "error": "Delegation capability is unavailable in this chat." });
    }
    let child = match s(req, "childId") {
        None => {
            let input = req.get("input").unwrap_or(&Value::Null);
            match prepare_sub_agent(ctx, &parent, &provider_id, &model_id, input, call_id, &settings).await {
                Ok(c) => c,
                Err(e) => return json!({ "error": e }),
            }
        }
        Some(child_id) => {
            let saved = ctx.sessions.get(child_id);
            let Some(saved) = saved.filter(|c| {
                s(c, "parentSessionId").is_some_and(|p| Some(p) == s(&parent, "id"))
                    && s(c, "spawnCallId") == call_id
                    && !js::truthy(c.get("incognito"))
                    && !js::truthy(c.get("archivedAt"))
                    && !js::truthy(c.pointer("/home/deviceId"))
            }) else {
                return json!({ "error": "Unknown child session." });
            };
            let or = |k: &str, d: &Value| saved.get(k).filter(|v| !v.is_null()).cloned().unwrap_or_else(|| d.clone());
            let target_id = or("providerId", &provider_id);
            let providers = settings.get("providers").and_then(Value::as_array);
            let find = |id: &Value| providers.and_then(|ps| ps.iter().find(|p| p.get("id") == Some(id)));
            let Some(target) = find(&target_id).filter(|p| js::truthy(p.get("enabled"))) else {
                return json!({ "error": "Target provider is unknown or disabled." });
            };
            if let Err(error) = check_delegation_route(&parent, find(&provider_id), target) {
                return json!({ "error": error });
            }
            // Revoke stale router permission, but never relax a child's privacy boundary.
            let fields = [
                ("autoModel", json!(js::truthy(parent.get("autoModel")))),
                ("autoProviderSwitch", json!(js::truthy(parent.get("autoProviderSwitch")))),
                ("cloudOnly", json!(js::truthy(parent.get("cloudOnly")) || js::truthy(saved.get("cloudOnly")))),
            ];
            if let Err(error) = ctx.sessions.assign(child_id, &fields) {
                return json!({ "error": error });
            }
            Child {
                id: child_id.to_string(),
                provider_id: target_id,
                model_id: or("modelId", &model_id),
                task: String::new(),
                provider: target.clone(),
            }
        }
    };
    // `childSendOptions`: the task first, then a resume after a recoverable failure.
    let mut opts = json!({
        "sessionId": child.id,
        "providerId": child.provider_id,
        "modelId": child.model_id,
        "text": if resume { String::new() } else { child.task.clone() },
    });
    if resume {
        opts["resume"] = json!(true);
    }
    let parent_effort =
        crate::orchestrate_state::can_coordinate(&parent, &settings).then(|| s(req, "parentEffort")).flatten();
    let mut spec: Option<Value> = None;
    let admitted = crate::automation::capture_turn_error(&ctx.hub, &opts, async {
        spec = crate::admission::admit_child(ctx, opts.clone(), &child.provider, parent_effort).await?;
        Ok(())
    })
    .await;
    match (admitted, spec) {
        (Ok(_), Some(mut spec)) => {
            // Derive the role from saved parent/child records, only after the
            // child's exact route is admitted. The worker projects its own
            // task from that turn's input or opening user message on resume.
            let live_settings = crate::settings::current(ctx).await;
            let live = s(&parent, "id").and_then(|id| ctx.sessions.meta(id)).map(|m| m.into_value());
            if live.as_ref().is_none_or(|live| !same_policy(&parent, live, &settings, &live_settings))
                || !same_provider(&provider_id, &settings, &live_settings)
                || !same_provider(&child.provider_id, &settings, &live_settings)
            {
                if !resume {
                    let _ = ctx.sessions.delete(&child.id);
                }
                return json!({"error": "Delegation settings changed during admission. Retry with the current settings."});
            }
            let settings = &spec["settings"];
            let store = ctx.sessions.clone();
            let (parent_id, child_id) = (s(&parent, "id").unwrap_or_default().to_owned(), child.id.clone());
            let records = tokio::task::spawn_blocking(move || {
                Some((store.meta(&parent_id)?.into_value(), store.get(&child_id)?))
            })
            .await
            .ok()
            .flatten();
            if let Some((parent, saved)) = records
                && crate::orchestrate_state::can_coordinate(&parent, settings)
                && saved.get("parentSessionId") == parent.get("id")
                && s(&saved, "spawnCallId") == s(req, "callId")
                && crate::orchestrate_state::worker_task(&saved, settings, s(&opts, "text")).is_some()
            {
                spec["facts"][crate::orchestrate_state::WORKER_FACT] = json!(true);
            }
            json!({ "childId": child.id, "spec": spec })
        }
        (Ok(failure), None) => {
            json!({ "childId": child.id, "failure": failure.unwrap_or_else(|| "The sub-agent could not start.".into()) })
        }
        (Err(e), _) => json!({ "childId": child.id, "failure": e }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delegation_guard_router_and_fusion_require_opt_in_and_cloud_only_wins() {
        let cloud = json!({"kind": "anthropic", "baseUrl": "https://api.anthropic.com"});
        let local = json!({"kind": "llamacpp", "baseUrl": "http://127.0.0.1:8080"});
        for auto in [false, true] {
            for switch in [false, true] {
                for cloud_only in [false, true] {
                    let parent = json!({"autoModel": auto, "autoProviderSwitch": switch, "cloudOnly": cloud_only});
                    assert_eq!(
                        check_delegation_route(&parent, Some(&cloud), &local).is_ok(),
                        auto && switch && !cloud_only
                    );
                    assert!(check_delegation_route(&parent, Some(&cloud), &cloud).is_ok());
                    assert_eq!(check_delegation_route(&parent, Some(&local), &local).is_ok(), !cloud_only);
                }
            }
        }
        assert!(check_delegation_route(&json!({}), Some(&cloud), &local).is_err());
        assert!(check_delegation_route(&json!({}), None, &local).is_err());
    }

    #[test]
    fn delegation_guard_uses_provider_classification_not_ids() {
        let cloud = json!({"id": "nekko-engine", "kind": "openai", "baseUrl": "https://api.example.com"});
        for local in [
            json!({"id": "anything", "kind": "ollama", "baseUrl": "http://10.0.0.2:11434"}),
            json!({"kind": "openai-compat", "baseUrl": "http://localhost:1234/v1"}),
            json!({"kind": "openai-compat", "baseUrl": "http://[::1]:1234/v1"}),
        ] {
            assert!(check_delegation_route(&json!({}), Some(&cloud), &local).is_err());
            assert!(check_delegation_route(&json!({}), Some(&local), &local).is_ok());
        }
        let connected = json!({"kind": "openai-compat", "baseUrl": "http://127.0.0.1:5000/v1", "computerId": "remote"});
        assert!(
            check_delegation_route(
                &json!({"cloudOnly": true, "autoModel": true, "autoProviderSwitch": true}),
                Some(&cloud),
                &connected
            )
            .is_ok()
        );
    }
}
