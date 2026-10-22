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
    let mut cur = store.get(id);
    while let Some(parent) = cur.as_ref().and_then(|c| s(c, "parentSessionId")).map(str::to_string) {
        if depth >= 16 {
            break;
        }
        depth += 1;
        cur = store.get(&parent);
    }
    depth
}

/// `getSessionWorkspaceIds(session)`: the folder, then the supporting ones, once each.
fn workspace_ids(session: &Value) -> Vec<Value> {
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
}

/// An exact id: a nonblank string with no surrounding whitespace.
fn exact(v: &Value) -> bool {
    v.as_str().is_some_and(|t| !js::trim(t).is_empty() && js::trim(t) == t)
}

/// `prepareSubAgent(parent, providerId, modelId, input)`: refused with
/// nothing created, or the child chat made.
async fn prepare_sub_agent(
    ctx: &Ctx,
    parent: &Value,
    provider_id: &Value,
    model_id: &Value,
    input: &Value,
) -> Result<Child, String> {
    let store = ctx.sessions.clone().ok_or("Sub-agents need the data directory.")?;
    let parent_id = s(parent, "id").unwrap_or_default().to_string();
    let settings = crate::settings::current(ctx).await;
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
    if depth as f64 >= max_depth {
        return Err(
            "Sub-agent depth limit reached, handle this part of the task directly instead of delegating further."
                .into(),
        );
    }
    if js::truthy(parent.get("incognito")) {
        return Err("Delegation is unavailable in incognito chats because child sessions are persisted. Handle this task in the current chat.".into());
    }
    if js::truthy(parent.get("offline")) {
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
    let explicit_model = inp.contains_key("model_id");
    let default_route = (!inp.contains_key("provider_id") && !explicit_model)
        .then(|| orchestration.and_then(|o| o.get("delegationRoute")).filter(|r| js::truthy(Some(r))).cloned())
        .flatten();
    let route = |k: &str| default_route.as_ref().and_then(|r| r.get(k)).filter(|v| !v.is_null()).cloned();
    let target_provider =
        inp.get("provider_id").cloned().or_else(|| route("providerId")).unwrap_or_else(|| provider_id.clone());
    let target_model = inp.get("model_id").cloned().or_else(|| route("modelId")).unwrap_or_else(|| model_id.clone());
    if target_provider != *provider_id && !explicit_model && default_route.is_none() {
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
    if js::truthy(parent.get("cloudOnly")) && !crate::admission::cloud_provider_allowed(&provider) {
        return Err(
            "This chat runs on cloud models only, so a sub-agent cannot use a local model. No child was created."
                .into(),
        );
    }
    if explicit_model || default_route.is_some() {
        let pid = target_provider.as_str().unwrap_or_default();
        let listed = crate::providers::list_models_status(ctx, pid).await;
        if listed.get("error").is_some_and(|e| !e.is_null()) {
            // The provider's message can quote an endpoint or a token: never passed on.
            eprintln!("nekkod: sub-agent model list for provider {pid} failed.");
            return Err("Could not verify the target provider model list. Check its availability; no child was created and no fallback was used.".into());
        }
        let model = listed.get("models").and_then(Value::as_array).and_then(|ms| {
            ms.iter()
                .find(|m| m.get("id") == Some(&target_model) && m.get("providerId") == Some(&target_provider))
                .cloned()
        });
        let Some(model) = model else {
            return Err("The exact model ID is not available from the target provider. Use delegation_targets on the intended provider to refresh exact IDs, or update the saved delegation route in Settings; no fallback was used.".into());
        };
        if !nekko_messaging::auto::is_chat_model(&model) {
            return Err("The selected model is not a chat model. No child was created.".into());
        }
    }
    let supporting: Vec<Value> = workspace_ids(parent).into_iter().skip(1).collect();
    let made =
        crate::routes::create_session(ctx, s(parent, "workspaceId"), Some(&parent_id), Some(json!(supporting))).await?;
    let id = s(&made, "id").unwrap_or_default().to_string();
    let title = title.and_then(Value::as_str).map(|t| js::trim(t).to_string()).filter(|t| !t.is_empty());
    let title = title.unwrap_or_else(|| js::slice16(js::trim(&task), 40).to_string());
    let title = if title.is_empty() { "Sub-agent".to_string() } else { title };
    // What the child takes from its parent: its tool policy, and nothing it switched off.
    let mut fields: Vec<(&'static str, Value)> =
        vec![("title", json!(title)), ("providerId", target_provider.clone()), ("modelId", target_model.clone())];
    for key in [
        "mode",
        "disabledTools",
        "disabledMcpServers",
        "disabledConnectors",
        "effort",
        "offline",
        "cloudOnly",
        "incognito",
    ] {
        if let Some(v) = parent.get(key) {
            fields.push((key, v.clone()));
        }
    }
    let (st, cid) = (store.clone(), id.clone());
    tokio::task::spawn_blocking(move || st.assign(&cid, &fields)).await.map_err(|e| e.to_string())??;
    Ok(Child { id, provider_id: target_provider, model_id: target_model, task })
}

/// `turn:spawnPrepare({ parent, providerId, modelId, input, attempt, childId })`:
/// `{ error }` when the call is refused, `{ childId, failure }` when the
/// child's turn could not start, else `{ childId, spec }` for the parent to drive.
pub async fn prepare(ctx: &Ctx, req: &Value) -> Value {
    let parent = req.get("parent").cloned().unwrap_or(Value::Null);
    let (provider_id, model_id) =
        (req.get("providerId").cloned().unwrap_or(Value::Null), req.get("modelId").cloned().unwrap_or(Value::Null));
    let attempt = req.get("attempt").and_then(Value::as_u64).unwrap_or(0);
    let child = match s(req, "childId") {
        None => {
            match prepare_sub_agent(ctx, &parent, &provider_id, &model_id, req.get("input").unwrap_or(&Value::Null))
                .await
            {
                Ok(c) => c,
                Err(e) => return json!({ "error": e }),
            }
        }
        Some(child_id) => {
            let saved = ctx.sessions.as_ref().and_then(|st| st.get(child_id));
            let Some(saved) = saved.filter(|c| s(c, "parentSessionId").is_some_and(|p| Some(p) == s(&parent, "id")))
            else {
                return json!({ "error": "Unknown child session." });
            };
            let or = |k: &str, d: &Value| saved.get(k).filter(|v| !v.is_null()).cloned().unwrap_or_else(|| d.clone());
            Child {
                id: child_id.to_string(),
                provider_id: or("providerId", &provider_id),
                model_id: or("modelId", &model_id),
                task: String::new(),
            }
        }
    };
    // `childSendOptions`: the task first, then a resume after a recoverable failure.
    let mut opts = json!({
        "sessionId": child.id,
        "providerId": child.provider_id,
        "modelId": child.model_id,
        "text": if attempt > 0 { String::new() } else { child.task.clone() },
    });
    if attempt > 0 {
        opts["resume"] = json!(true);
    }
    let mut spec: Option<Value> = None;
    let admitted = crate::automation::capture_turn_error(&ctx.hub, &opts, async {
        spec = crate::admission::admit_child(ctx, opts.clone()).await?;
        Ok(())
    })
    .await;
    match (admitted, spec) {
        (Ok(_), Some(spec)) => json!({ "childId": child.id, "spec": spec }),
        (Ok(failure), None) => {
            json!({ "childId": child.id, "failure": failure.unwrap_or_else(|| "The sub-agent could not start.".into()) })
        }
        (Err(e), _) => json!({ "childId": child.id, "failure": e }),
    }
}
