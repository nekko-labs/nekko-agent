//! Which values a chat hides, from its own `privacy` options over the
//! app-wide settings.
//!
//! Session: `privacy: { mode?: "off" | "redact", disabledKinds?: string[], allow?: string[] }`.
//! Settings: `privacyMode`, `privacyDisabledKinds` (the defaults for every
//! chat) and `privacyTerms` (the user's own words, always hidden when on).

use crate::detect::Kind;
use serde_json::Value;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Policy {
    /// Kinds the user switched off.
    pub disabled: Vec<Kind>,
    /// Values the user chose to send as they are.
    pub allow: Vec<String>,
    /// The user's own words to hide (a client, a codename, a name).
    pub terms: Vec<String>,
    /// This computer's account names, hidden in home-folder paths.
    pub usernames: Vec<String>,
}

fn strings(v: Option<&Value>) -> Option<Vec<String>> {
    Some(v?.as_array()?.iter().filter_map(Value::as_str).map(str::to_string).collect())
}

/// Whether a chat's shield is on: its own mode, else the app's, else off.
pub fn enabled(session: &Value, settings: &Value) -> bool {
    let own = session.pointer("/privacy/mode").and_then(Value::as_str);
    let app = settings.get("privacyMode").and_then(Value::as_str);
    own.or(app) == Some("redact")
}

impl Policy {
    /// Every kind on, nothing allowed, no terms or usernames.
    pub fn all() -> Self {
        Self::default()
    }

    /// The policy a chat's requests go through, or `None` when its shield is off.
    pub fn resolve(session: &Value, settings: &Value, usernames: Vec<String>) -> Option<Policy> {
        enabled(session, settings).then(|| Policy::for_preview(session, settings, usernames))
    }

    /// The policy the chat would use if its shield were on (the panel shows
    /// what it would hide before the user turns it on).
    pub fn for_preview(session: &Value, settings: &Value, usernames: Vec<String>) -> Policy {
        let disabled = strings(session.pointer("/privacy/disabledKinds"))
            .or_else(|| strings(settings.get("privacyDisabledKinds")))
            .unwrap_or_default()
            .iter()
            .filter_map(|id| Kind::from_id(id))
            .collect();
        Policy {
            disabled,
            allow: strings(session.pointer("/privacy/allow")).unwrap_or_default(),
            terms: strings(settings.get("privacyTerms"))
                .unwrap_or_default()
                .into_iter()
                .map(|t| t.trim().to_string())
                .filter(|t| t.chars().count() >= 2)
                .collect(),
            usernames,
        }
    }

    pub fn covers(&self, kind: Kind) -> bool {
        !self.disabled.contains(&kind)
    }

    pub fn allows(&self, value: &str) -> bool {
        self.allow.iter().any(|a| a == value)
    }
}

/// This computer's account names: the last part of the home folder and the
/// login name, where they are long enough to find without false hits.
pub fn local_usernames() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for var in ["HOME", "USERPROFILE"] {
        if let Some(home) = std::env::var_os(var) {
            let path = std::path::PathBuf::from(home);
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                out.push(name.to_string());
            }
        }
    }
    for var in ["USER", "USERNAME", "LOGNAME"] {
        if let Ok(name) = std::env::var(var) {
            out.push(name);
        }
    }
    out.retain(|n| n.chars().count() >= 3 && n != "root");
    out.sort();
    out.dedup();
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_chat_wins_over_the_app() {
        let on = json!({ "privacyMode": "redact" });
        assert!(enabled(&json!({}), &on));
        assert!(!enabled(&json!({ "privacy": { "mode": "off" } }), &on));
        assert!(enabled(&json!({ "privacy": { "mode": "redact" } }), &json!({})));
        assert!(!enabled(&json!({}), &json!({})));
    }

    #[test]
    fn reads_kinds_allow_and_terms() {
        let session = json!({ "privacy": { "mode": "redact", "disabledKinds": ["ip", "nope"], "allow": ["a@b.io"] } });
        let settings = json!({ "privacyDisabledKinds": ["email"], "privacyTerms": [" Acme ", "x"] });
        let p = Policy::resolve(&session, &settings, vec!["philip".into()]).unwrap();
        assert_eq!(p.disabled, vec![Kind::Ip]);
        assert_eq!(p.allow, vec!["a@b.io".to_string()]);
        assert_eq!(p.terms, vec!["Acme".to_string()]);
        let p = Policy::resolve(&json!({ "privacy": { "mode": "redact" } }), &settings, vec![]).unwrap();
        assert_eq!(p.disabled, vec![Kind::Email]);
    }
}
