//! `settings.json`: the daemon is its single writer (`nekko-settings`).
//!
//! The UI's `settings:get/update/reset` are served here. Daemon services
//! read with [`current`] and write with [`update`].

use crate::routes::Ctx;
use nekko_settings::SettingsStore;
use serde_json::{Value, json};
use std::sync::Arc;

/// The channels served here.
pub const CHANNELS: &[&str] = &["settings:get", "settings:update", "settings:reset"];

/// The settings store, and the hub a change is announced on.
pub struct Settings {
    pub store: Arc<SettingsStore>,
    hub: crate::hub::Hub,
}

impl Settings {
    pub fn new(dir: std::path::PathBuf, hub: crate::hub::Hub) -> Arc<Self> {
        Arc::new(Settings { store: Arc::new(SettingsStore::new(dir)), hub })
    }

    fn changed(&self, settings: &Value, patch: &Value) {
        // A paired phone mirrors the desktop's look; it hears the public part only.
        if touches_appearance(patch) {
            self.hub.publish(APPEARANCE_UPDATED, appearance_of(settings), false);
        }
    }
}

/// The event a paired phone follows the desktop's theme by (`IpcEvents.appearanceUpdated`).
pub const APPEARANCE_UPDATED: &str = "appearance:updated";

const APPEARANCE_KEYS: [&str; 4] = ["theme", "themePreset", "accent", "accent2"];

/// Whether a settings patch can change [`appearance_of`] (a reset is `null`).
pub fn touches_appearance(patch: &Value) -> bool {
    match patch {
        Value::Null => true,
        Value::Object(o) => APPEARANCE_KEYS.iter().any(|k| o.contains_key(*k)),
        _ => false,
    }
}

/// The public look of the settings, field by field (`appearanceOf` in
/// packages/shared/src/themes.ts): nothing else in the settings reaches the
/// relay. The mode, anything unknown reading as `system`; a preset id shaped
/// like one; the accents as lowercase 6-digit hex.
pub fn appearance_of(settings: &Value) -> Value {
    let str_of = |k: &str| settings.get(k).and_then(Value::as_str);
    let theme = str_of("theme").filter(|t| matches!(*t, "light" | "dark")).unwrap_or("system");
    let mut out = serde_json::Map::new();
    out.insert("theme".into(), json!(theme));
    if let Some(p) = str_of("themePreset")
        && (1..=32).contains(&p.len())
        && p.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        out.insert("themePreset".into(), json!(p));
    }
    for k in ["accent", "accent2"] {
        if let Some(v) = str_of(k)
            && v.len() == 7
            && v.starts_with('#')
            && v[1..].bytes().all(|b| b.is_ascii_hexdigit())
        {
            out.insert(k.into(), json!(v.to_ascii_lowercase()));
        }
    }
    Value::Object(out)
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(f).await.map_err(|e| e.to_string())
}

pub async fn route(s: &Arc<Settings>, channel: &str, args: &[Value]) -> Result<Value, String> {
    let store = s.store.clone();
    let patch = args.first().cloned().unwrap_or(Value::Null);
    match channel {
        "settings:get" => blocking(move || store.get()).await,
        "settings:update" => {
            let p = patch.clone();
            let next = blocking(move || store.update(&p)).await??;
            s.changed(&next, &patch);
            Ok(next)
        }
        "settings:reset" => {
            let next = blocking(move || store.reset()).await??;
            s.changed(&next, &Value::Null);
            Ok(next)
        }
        _ => Err(format!("unknown channel {channel}")),
    }
}

/// The current settings.
pub async fn current(ctx: &Ctx) -> Value {
    let store = ctx.settings.store.clone();
    blocking(move || store.get()).await.unwrap_or(Value::Null)
}

/// Save a patch as `saveSettings` would, from a daemon service.
pub async fn update(ctx: &Ctx, patch: Value) -> Result<Value, String> {
    route(&ctx.settings, "settings:update", &[patch]).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appearance_keeps_only_the_public_look() {
        let a = appearance_of(&json!({
            "theme": "dark", "themePreset": "nebula", "accent": "#FB923C", "accent2": "red",
            "providers": [{ "apiKey": "sk-secret" }], "hfToken": "hf_x"
        }));
        assert_eq!(a, json!({ "theme": "dark", "themePreset": "nebula", "accent": "#fb923c" }));
        assert!(!a.to_string().contains("secret"));
        assert_eq!(appearance_of(&Value::Null), json!({ "theme": "system" }));
        assert_eq!(
            appearance_of(&json!({ "theme": "sepia", "themePreset": "<script>", "accent": "#12345" })),
            json!({ "theme": "system" })
        );
    }

    #[test]
    fn only_look_patches_and_resets_are_announced() {
        assert!(touches_appearance(&json!({ "theme": "light" })));
        assert!(touches_appearance(&json!({ "accent2": "#000000" })));
        assert!(touches_appearance(&Value::Null));
        assert!(!touches_appearance(&json!({ "providers": [] })));
    }

    #[tokio::test]
    async fn a_theme_change_reaches_the_hub_with_the_public_look_only() {
        let hub = crate::hub::Hub::new();
        let mut rx = hub.subscribe();
        let dir = std::env::temp_dir().join(format!("nekkod-appearance-{}", std::process::id()));
        let s = Settings::new(dir.clone(), hub);
        route(&s, "settings:update", &[json!({ "theme": "dark", "accent": "#FB923C" })]).await.unwrap();
        let ev = rx.recv().await.unwrap();
        let v: Value = serde_json::from_str(&ev.text).unwrap();
        assert_eq!(v["channel"], APPEARANCE_UPDATED);
        assert_eq!(v["payload"]["theme"], "dark");
        assert_eq!(v["payload"]["accent"], "#fb923c");
        assert_eq!(v["payload"].as_object().unwrap().len(), 2, "{v}");
        // Something that is not the look stays off the relay.
        route(&s, "settings:update", &[json!({ "mascotEnabled": false })]).await.unwrap();
        assert!(rx.try_recv().is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
