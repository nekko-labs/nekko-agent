//! Privacy Shield in the daemon (`nekko-privacy`): which model calls get a
//! shield, and `privacy:preview`, which shows the user what a chat would hide
//! before they send.
//!
//! A shield goes on a call when the chat's (or the app's) privacy mode is
//! `redact` and the provider is off this computer. A local model on loopback
//! never gets one: nothing leaves the machine. A Claude Agent chat cannot get
//! one: the user's own Claude Code sends its requests, not this daemon.

use crate::routes::Ctx;
use nekko_privacy::{Policy, Shield};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

pub const CHANNELS: &[&str] = &["privacy:preview"];

/// Where a provider's requests go, as the shield sees it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reach {
    /// A model on this computer: nothing to hide from.
    Local,
    /// Claude Agent: Claude Code makes the calls, out of the shield's reach.
    External,
    /// A model off this computer.
    Cloud,
}

pub fn reach(provider: &Value) -> Reach {
    if provider.get("kind").and_then(Value::as_str) == Some("claude-code") {
        Reach::External
    } else if crate::admission::offline_provider_allowed(provider) {
        Reach::Local
    } else {
        Reach::Cloud
    }
}

/// The shield for a call on `provider` from `session`, or `None` when its
/// requests go out as they are.
pub fn shield_for(session: &Value, settings: &Value, provider: &Value) -> Option<Arc<Mutex<Shield>>> {
    if reach(provider) != Reach::Cloud {
        return None;
    }
    let policy = Policy::resolve(session, settings, nekko_privacy::local_usernames())?;
    Some(Arc::new(Mutex::new(Shield::new(policy))))
}

/// One prompt for a side call (a title, a suggestion, a summary) as it
/// should leave, and the shield that restores the answer.
pub fn guard(session: &Value, settings: &Value, provider: &Value, content: &str) -> (String, Option<Shield>) {
    match shield_for(session, settings, provider) {
        Some(shield) => {
            let mut shield =
                Arc::try_unwrap(shield).map(|m| m.into_inner().unwrap_or_else(|e| e.into_inner())).unwrap_or_default();
            shield.reserve(content);
            (shield.redact(content), Some(shield))
        }
        None => (content.to_string(), None),
    }
}

/// An answer to a guarded prompt, with its real values back.
pub fn unguard(shield: &Option<Shield>, answer: &str) -> String {
    match shield {
        Some(s) => s.restore(answer),
        None => answer.to_string(),
    }
}

/// The provider a chat's next turn would use: its own, else the app's default.
fn chat_provider<'a>(session: &Value, settings: &'a Value) -> Option<&'a Value> {
    let id = session
        .get("providerId")
        .filter(|v| !v.is_null())
        .or_else(|| settings.get("defaultProviderId").filter(|v| !v.is_null()))?;
    settings.get("providers")?.as_array()?.iter().find(|p| p.get("id") == Some(id))
}

/// `privacy:preview(sessionId, draft)`: what the shield would replace in
/// the draft and the chat so far, the draft as the model would read it, and
/// whether the shield is on and can reach this chat's model.
async fn preview(ctx: &Ctx, session_id: &str, draft: &str) -> Result<Value, String> {
    let settings = crate::settings::current(ctx).await;
    let session = if session_id.is_empty() {
        Value::Null
    } else {
        let (store, id) = (ctx.sessions.clone(), session_id.to_string());
        tokio::task::spawn_blocking(move || store.get(&id)).await.map_err(|e| e.to_string())?.unwrap_or(Value::Null)
    };
    let reach = chat_provider(&session, &settings).map(reach).unwrap_or(Reach::Cloud);
    let messages: Vec<Value> = session.get("messages").and_then(Value::as_array).cloned().unwrap_or_default();
    let policy = Policy::for_preview(&session, &settings, nekko_privacy::local_usernames());
    let disabled: Vec<&str> = policy.disabled.iter().map(|k| k.id()).collect();
    let terms = policy.terms.clone();
    let draft = draft.to_string();
    let mut out = tokio::task::spawn_blocking(move || nekko_privacy::preview(policy, &draft, &messages))
        .await
        .map_err(|e| e.to_string())?;
    let obj = out.as_object_mut().ok_or("preview")?;
    obj.insert("enabled".into(), json!(nekko_privacy::enabled(&session, &settings)));
    obj.insert(
        "reach".into(),
        json!(match reach {
            Reach::Local => "local",
            Reach::External => "external",
            Reach::Cloud => "cloud",
        }),
    );
    obj.insert("disabledKinds".into(), json!(disabled));
    obj.insert("terms".into(), json!(terms));
    obj.insert("kinds".into(), json!(nekko_privacy::Kind::ALL.iter().map(|k| k.id()).collect::<Vec<_>>()));
    Ok(out)
}

pub async fn route(ctx: &Ctx, channel: &str, args: &[Value]) -> Result<Value, String> {
    match channel {
        "privacy:preview" => {
            let session_id = args.first().and_then(Value::as_str).unwrap_or_default();
            let draft = args.get(1).and_then(Value::as_str).unwrap_or_default();
            preview(ctx, session_id, draft).await
        }
        _ => Err(format!("unknown channel {channel}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_cloud_providers_get_a_shield() {
        let on = json!({ "privacy": { "mode": "redact" } });
        let cloud = json!({ "kind": "anthropic", "baseUrl": "https://api.anthropic.com" });
        let local = json!({ "kind": "ollama", "baseUrl": "http://127.0.0.1:11434" });
        let lan = json!({ "kind": "ollama", "baseUrl": "http://10.0.0.2:11434" });
        let claude = json!({ "kind": "claude-code", "baseUrl": "" });
        assert!(shield_for(&on, &json!({}), &cloud).is_some());
        assert!(shield_for(&on, &json!({}), &lan).is_some(), "a LAN server is off this computer");
        assert!(shield_for(&on, &json!({}), &local).is_none());
        assert!(shield_for(&on, &json!({}), &claude).is_none());
        assert!(shield_for(&json!({}), &json!({}), &cloud).is_none(), "off by default");
    }

    #[test]
    fn a_guarded_side_prompt_round_trips() {
        let on = json!({ "privacy": { "mode": "redact" } });
        let cloud = json!({ "kind": "openai", "baseUrl": "https://api.openai.com/v1" });
        let (sent, shield) = guard(&on, &json!({}), &cloud, "Title for: email jane@example.com");
        assert_eq!(sent, "Title for: email [PII_EMAIL_1]");
        assert_eq!(unguard(&shield, "Emailing [PII_EMAIL_1]"), "Emailing jane@example.com");
    }
}
