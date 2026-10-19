//! The one-time cleanup after Claude plan sign-in was removed.
//!
//! Older builds signed users in to their Claude plan inside Nekko Agent and
//! kept the tokens in `tokens.json`. Anthropic does not let third-party apps
//! do that, so at startup the daemon deletes every Claude token it finds,
//! turns off each Anthropic provider that ran on one, and leaves the UI a
//! notice explaining what changed (`settings.notices`). It runs on every
//! start and does nothing once there is nothing left to clean up, so it
//! happens once in effect; the notice is added only if it is not there yet.

use nekko_oauth::TokenStore;
use nekko_settings::SettingsStore;
use serde_json::{Value, json};
use std::path::Path;

/// The notice's id; the renderer removes it from `notices` when dismissed.
pub const NOTICE_ID: &str = "claude-sign-in-changed";

/// What the cleanup did.
#[derive(Debug, Default, PartialEq)]
pub struct Migrated {
    /// tokens.json keys deleted.
    pub tokens: Vec<String>,
    /// Provider ids turned off.
    pub providers: Vec<String>,
}

impl Migrated {
    pub fn is_empty(&self) -> bool {
        self.tokens.is_empty() && self.providers.is_empty()
    }
}

/// A token key or token set that belongs to a Claude plan sign-in.
fn claude_token(key: &str, token: &Value) -> bool {
    key == "claude" || key.starts_with("claude:") || token.get("provider").and_then(Value::as_str) == Some("claude")
}

/// The notice the renderer shows once (the design's migration copy).
pub fn notice(now_ms: f64) -> Value {
    json!({
        "id": NOTICE_ID,
        "title": "Claude sign-in has changed",
        "body": "To follow Anthropic's terms, Nekko Agent no longer signs in to Claude plans directly, and we've deleted the saved Claude sign-in from this computer. Your chats are safe.",
        "points": [
            "Keep using your plan: connect Claude Agent (uses your Claude Code install).",
            "Get every feature: add an Anthropic API key or cloud account."
        ],
        "actions": [
            { "id": "connect-claude-agent", "label": "Connect Claude Agent" },
            { "id": "add-api-key", "label": "Add API key" },
            { "id": "what-changed", "label": "What changed?" }
        ],
        "createdAt": nekko_oauth::num(now_ms),
    })
}

/// Delete Claude tokens, turn off Claude plan providers, record the notice.
pub fn migrate(dir: &Path, settings: &SettingsStore, now_ms: f64) -> Result<Migrated, String> {
    let mut done = Migrated::default();

    let tokens = TokenStore::new(dir);
    if tokens.path().exists()
        && let Value::Object(all) = tokens.load()
    {
        done.tokens = all.iter().filter(|(k, v)| claude_token(k, v)).map(|(k, _)| k.clone()).collect();
        for key in &done.tokens {
            tokens.delete(key)?;
        }
    }

    // Read from disk, not through the store: a store read caches the file, and
    // a startup that finds nothing to change must not pin settings.json in
    // memory before anything else has looked at it.
    let current = match std::fs::read(settings.path()) {
        Ok(bytes) => Value::Object(nekko_settings::from_text(&String::from_utf8_lossy(&bytes))),
        Err(_) => Value::Object(nekko_settings::defaults()),
    };
    let mut providers = current.get("providers").and_then(Value::as_array).cloned().unwrap_or_default();
    for p in providers.iter_mut() {
        let plan = p.get("kind").and_then(Value::as_str) == Some("anthropic")
            && p.get("auth").and_then(Value::as_str) == Some("subscription");
        let Some(obj) = p.as_object_mut().filter(|_| plan) else { continue };
        let live = obj.get("enabled") != Some(&Value::Bool(false))
            || obj.contains_key("tokenKey")
            || obj.contains_key("accountId");
        if !live {
            continue;
        }
        // Kept, not removed: chats that point at it keep their history, and the
        // Models page turns the card into an API-key card when the user adds one.
        obj.insert("enabled".into(), Value::Bool(false));
        obj.shift_remove("tokenKey");
        obj.shift_remove("accountId");
        done.providers.push(obj.get("id").map(nekko_js::display).unwrap_or_default());
    }

    if done.is_empty() {
        return Ok(done);
    }
    let mut notices = current.get("notices").and_then(Value::as_array).cloned().unwrap_or_default();
    if !notices.iter().any(|n| n.get("id").and_then(Value::as_str) == Some(NOTICE_ID)) {
        notices.push(notice(now_ms));
    }
    let mut patch = json!({ "notices": notices });
    if !done.providers.is_empty() {
        patch["providers"] = Value::Array(providers);
    }
    settings.update(&patch)?;
    Ok(done)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("nekkod-claude-plan-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn write(d: &Path, name: &str, v: Value) {
        std::fs::write(d.join(name), v.to_string()).unwrap();
    }

    #[test]
    fn deletes_claude_tokens_disables_plan_providers_and_records_the_notice_once() {
        let d = dir("full");
        write(
            &d,
            "tokens.json",
            json!({
                "claude": { "provider": "claude", "accessToken": "a" },
                "claude:acct": { "provider": "claude", "accessToken": "b", "refreshToken": "r" },
                "legacy-key": { "provider": "claude", "accessToken": "c" },
                "chatgpt:x": { "provider": "chatgpt", "accessToken": "keep" },
                "openrouter:y": { "provider": "openrouter", "accessToken": "keep" }
            }),
        );
        write(
            &d,
            "settings.json",
            json!({
                "providers": [
                    { "id": "plan", "kind": "anthropic", "label": "Claude (subscription)", "auth": "subscription", "tokenKey": "claude:acct", "accountId": "acct", "enabled": true },
                    { "id": "key", "kind": "anthropic", "label": "Claude", "apiKey": "sk-ant", "enabled": true },
                    { "id": "gpt", "kind": "chatgpt", "auth": "subscription", "tokenKey": "chatgpt:x", "enabled": true }
                ]
            }),
        );
        let settings = SettingsStore::new(&d);

        let done = migrate(&d, &settings, 1_760_000_000_000.0).unwrap();
        assert_eq!(done.tokens, ["claude", "claude:acct", "legacy-key"]);
        assert_eq!(done.providers, ["plan"]);

        let tokens: Value = serde_json::from_str(&std::fs::read_to_string(d.join("tokens.json")).unwrap()).unwrap();
        let keys: Vec<&str> = tokens.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, ["chatgpt:x", "openrouter:y"]);

        let saved: Value = serde_json::from_str(&std::fs::read_to_string(d.join("settings.json")).unwrap()).unwrap();
        let providers = saved["providers"].as_array().unwrap();
        assert_eq!(providers[0]["enabled"], false);
        assert_eq!(providers[0]["auth"], "subscription", "kept so the Models page can offer an API key");
        assert!(providers[0].get("tokenKey").is_none() && providers[0].get("accountId").is_none());
        assert_eq!(
            providers[1],
            json!({ "id": "key", "kind": "anthropic", "label": "Claude", "apiKey": "sk-ant", "enabled": true })
        );
        assert_eq!(providers[2]["tokenKey"], "chatgpt:x");
        let notices = saved["notices"].as_array().unwrap();
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0]["id"], NOTICE_ID);
        assert_eq!(notices[0]["title"], "Claude sign-in has changed");
        assert_eq!(notices[0]["actions"][0]["id"], "connect-claude-agent");

        // The next start finds nothing to do and adds nothing.
        assert!(migrate(&d, &settings, 1_760_000_000_001.0).unwrap().is_empty());
        assert_eq!(settings.get()["notices"].as_array().unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_dismissed_notice_stays_dismissed_and_a_clean_install_is_untouched() {
        let d = dir("clean");
        let settings = SettingsStore::new(&d);
        assert!(migrate(&d, &settings, 1.0).unwrap().is_empty());
        assert!(!d.join("tokens.json").exists(), "no tokens.json is created");
        assert!(!d.join("settings.json").exists(), "no settings.json is written");
        // Nor is the store's cache filled: a settings.json written afterwards is what it reads.
        write(&d, "settings.json", json!({ "providers": [{ "id": "later", "kind": "openai" }] }));
        assert_eq!(settings.get()["providers"][0]["id"], "later");

        // A plan provider already turned off with no token: nothing to do, no notice.
        write(
            &d,
            "settings.json",
            json!({ "providers": [{ "id": "plan", "kind": "anthropic", "auth": "subscription", "enabled": false }], "notices": [] }),
        );
        let settings = SettingsStore::new(&d);
        assert!(migrate(&d, &settings, 1.0).unwrap().is_empty());
        assert_eq!(settings.get()["notices"], json!([]));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_leftover_token_alone_still_records_the_notice() {
        let d = dir("token-only");
        write(&d, "tokens.json", json!({ "claude:a": { "provider": "claude", "accessToken": "a" } }));
        let settings = SettingsStore::new(&d);
        let done = migrate(&d, &settings, 1.0).unwrap();
        assert_eq!(done.tokens, ["claude:a"]);
        assert_eq!(settings.get()["notices"][0]["id"], NOTICE_ID);
        let _ = std::fs::remove_dir_all(&d);
    }
}
