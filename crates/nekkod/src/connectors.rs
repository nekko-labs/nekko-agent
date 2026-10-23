//! Connectors owned by the daemon (PF14): `connectors:list`,
//! `connector:connect`, `connector:disconnect`, `connector:fetch`, and the
//! chat-context snippets a turn's admission gathers (`snippets`). The
//! connector configs live in `settings.json`, which the daemon writes
//! (crate::settings); the reads and posts are `nekko-connectors`'.

use crate::routes::Ctx;
use nekko_connectors::{Http, Net};
use serde_json::{Value, json};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const CHANNELS: &[&str] = &["connectors:list", "connector:connect", "connector:disconnect", "connector:fetch"];

/// How long a turn waits for the connectors' context before going without (TS: 2.5 s).
const SNIPPET_WAIT: Duration = Duration::from_millis(2500);

/// The network every connector call goes out on.
pub static NET: LazyLock<Arc<dyn Http>> = LazyLock::new(|| Arc::new(Net::default()));

fn connectors_of(settings: &Value) -> Vec<Value> {
    settings.get("connectors").and_then(Value::as_array).cloned().unwrap_or_default()
}

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

pub async fn route(ctx: &Ctx, channel: &str, args: &[Value]) -> Result<Value, String> {
    let arg = |i: usize| args.get(i).unwrap_or(&Value::Null);
    let kind = arg(0).clone();
    match channel {
        "connectors:list" => Ok(crate::settings::current(ctx).await.get("connectors").cloned().unwrap_or(json!([]))),
        "connector:connect" => {
            let mut connectors: Vec<Value> = connectors_of(&crate::settings::current(ctx).await)
                .into_iter()
                .filter(|c| c.get("kind") != Some(&kind))
                .collect();
            // `{ kind, connected: true, token, settings, connectedAt }`, absent fields left out.
            let mut entry = serde_json::Map::new();
            entry.insert("kind".into(), kind);
            entry.insert("connected".into(), json!(true));
            if let Some(t) = args.get(1) {
                entry.insert("token".into(), t.clone());
            }
            if let Some(s) = args.get(2) {
                entry.insert("settings".into(), s.clone());
            }
            entry.insert("connectedAt".into(), nekko_connectors::js::num(now_ms()));
            connectors.push(Value::Object(entry));
            let next = crate::settings::update(ctx, json!({ "connectors": connectors })).await?;
            Ok(next.get("connectors").cloned().unwrap_or(json!([])))
        }
        "connector:disconnect" => {
            let connectors: Vec<Value> = connectors_of(&crate::settings::current(ctx).await)
                .into_iter()
                .filter(|c| c.get("kind") != Some(&kind))
                .collect();
            let next = crate::settings::update(ctx, json!({ "connectors": connectors })).await?;
            Ok(next.get("connectors").cloned().unwrap_or(json!([])))
        }
        "connector:fetch" => {
            let cfg =
                connectors_of(&crate::settings::current(ctx).await).into_iter().find(|c| c.get("kind") == Some(&kind));
            // Connected-not-token is the gate: a Teams webhook lives in settings.
            let Some(cfg) = cfg.filter(|c| nekko_js::truthy(c.get("connected"))) else {
                return Err("Connector not connected".into());
            };
            let token = cfg.get("token").filter(|t| !t.is_null()).map(nekko_js::display).unwrap_or_default();
            let query = args.get(1).and_then(Value::as_str);
            let kind = kind.as_str().unwrap_or("");
            nekko_connectors::fetch(NET.as_ref(), kind, &token, query, cfg.get("settings")).await
        }
        other => Err(format!("unknown channel {other}")),
    }
}

/// `collectConnectorSnippets(text, session)`: up to five resources per
/// connected connector the chat has not switched off, as `{ label, origin,
/// body }` context snippets, or none if they take longer than 2.5 s.
pub async fn snippets(ctx: &Ctx, text: Option<&str>, session: &Value) -> Vec<Value> {
    let connectors = nekko_turn::chat_connectors(connectors_of(&crate::settings::current(ctx).await), session);
    nekko_connectors::snippets(NET.as_ref(), &connectors, text, SNIPPET_WAIT).await
}
