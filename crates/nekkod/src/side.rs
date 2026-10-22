//! The suggested replies and the prompt-part fill (`chat:suggest`,
//! `chat:fillPrompt`), answered by the daemon (PF14): a port of
//! `suggestReplies` and `fillPromptPart` in chat.ts.
//!
//! Both are a small call on the chat's own provider and model, after the
//! same checks the host makes (the provider is enabled, an offline chat's
//! provider is local, the endpoint is one a turn may call), with the prompt
//! and the reading of the answer from `nekko_turn::side`. The provider is
//! resolved here with a fresh token (`providers.rs`), the call runs on the
//! Rust providers (`sideband.rs`) and its usage is written as the host wrote
//! it. Anything that goes wrong answers `null`, as the host's did, and the UI
//! falls back to no suggestions or its fixed snippet.

use crate::routes::Ctx;
use serde_json::{Value, json};
use std::time::{SystemTime, UNIX_EPOCH};

pub const CHANNELS: &[&str] = &["chat:suggest", "chat:fillPrompt"];

/// Served here only when the daemon owns the chats, the settings and turn
/// admission.
pub fn owned(ctx: &Ctx) -> bool {
    ctx.sessions.is_some() && ctx.settings.is_some() && ctx.admission.is_some()
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub async fn route(ctx: &Ctx, channel: &str, args: &[Value]) -> Result<Value, String> {
    let arg = |i: usize| args.get(i).and_then(Value::as_str).unwrap_or_default().to_string();
    let session_id = arg(0);
    let Some(store) = ctx.sessions.clone() else { return Ok(Value::Null) };
    let id = session_id.clone();
    let Some(session) = tokio::task::spawn_blocking(move || store.get(&id)).await.map_err(|e| e.to_string())? else {
        return Ok(Value::Null);
    };
    Ok(match channel {
        "chat:suggest" => {
            let Some(content) = nekko_turn::suggest_prompt(&session) else { return Ok(Value::Null) };
            match complete(ctx, &session, &session_id, "suggest", content, 220).await {
                Some(out) => nekko_turn::parse_reply_suggestions(&out),
                None => Value::Null,
            }
        }
        "chat:fillPrompt" => {
            let content = nekko_turn::fill_prompt(&arg(1), &arg(2));
            match complete(ctx, &session, &session_id, "fill", content, 120).await {
                Some(out) => nekko_turn::clean_fill(&out).map_or(Value::Null, Value::String),
                None => Value::Null,
            }
        }
        other => return Err(format!("{other} is not a side call")),
    })
}

/// `session.x ?? settings.y`.
fn or_default<'a>(session: &'a Value, key: &str, settings: &'a Value, fallback: &str) -> Option<&'a Value> {
    session.get(key).filter(|v| !v.is_null()).or_else(|| settings.get(fallback).filter(|v| !v.is_null()))
}

/// The call on the chat's provider and model; `None` when the host would
/// have answered `null` (no usable provider, a failed or timed-out call).
async fn complete(
    ctx: &Ctx,
    session: &Value,
    session_id: &str,
    purpose: &str,
    content: String,
    max_output_tokens: u32,
) -> Option<String> {
    let settings = crate::settings::current(ctx).await;
    let provider_id = or_default(session, "providerId", &settings, "defaultProviderId");
    let model_id = or_default(session, "modelId", &settings, "defaultModelId").cloned();
    let provider = provider_id.filter(|id| nekko_js::truthy(Some(id))).and_then(|id| {
        settings.get("providers").and_then(Value::as_array)?.iter().find(|p| p.get("id") == Some(id)).cloned()
    })?;
    if !nekko_js::truthy(provider.get("enabled")) || !nekko_js::truthy(model_id.as_ref()) {
        return None;
    }
    if nekko_js::truthy(session.get("offline")) && !crate::admission::offline_provider_allowed(&provider) {
        return None;
    }
    crate::admission::provider_endpoint(&provider)?;
    let resolved = crate::providers::resolve(ctx, &provider).await.ok()?;
    let resolved = crate::admission::host_provider_config(ctx, &resolved);
    let (content, shield) = crate::privacy::guard(session, &settings, &provider, &content);
    let request = json!({
        "provider": resolved,
        "request": {
            "model": model_id,
            "messages": [{ "id": purpose, "role": "user", "createdAt": now_ms(), "content": content }],
            "temperature": 0.4,
            "maxOutputTokens": max_output_tokens,
            "think": false,
            "purpose": purpose,
            "promptCaching": settings.get("promptCaching") != Some(&json!(false)),
        },
        "timeoutMs": 30_000,
        "usageOnFailure": true,
    });
    let out = crate::sideband::complete(&request).await.ok()?;
    // Usage is kept even when the call failed or timed out, as the host's sideband kept it.
    if let Some(usage) = out.get("usage").and_then(Value::as_array).filter(|u| !u.is_empty()) {
        let who = json!({ "id": resolved.get("id"), "kind": resolved.get("kind"), "auth": resolved.get("auth") });
        if ctx.accounts.enabled() {
            ctx.accounts.side_usage(&who, model_id.as_ref(), session_id, usage);
        }
    }
    if out.get("error").is_some() {
        return None;
    }
    Some(crate::privacy::unguard(&shield, out.get("text").and_then(Value::as_str).unwrap_or_default()))
}
