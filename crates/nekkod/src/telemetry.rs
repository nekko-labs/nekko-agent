//! Opt-in usage and crash reports to PostHog (`settings.telemetry`), off
//! unless the person turns it on in onboarding or Settings.
//!
//! What a report may hold, and nothing else:
//! - a random install id (a new one each time it is turned on), the app
//!   version, edition, OS, OS version and CPU type;
//! - which features get used ([`EVENTS`]), with the few properties each allows;
//! - errors and crashes, with every string scrubbed ([`scrub`]): secrets,
//!   emails, phone numbers, card numbers, IP addresses and the user's name are
//!   replaced, and file paths are cut to their last part.
//!
//! Never chat text, prompts, file contents, folder names, model output or
//! account names. PostHog is told not to look up the IP's location and not to
//! build a person profile. Everything goes through Settings > Connections as
//! `telemetry`, so All connections off stops it and its log shows every send.

use crate::routes::Ctx;
use serde_json::{Map, Value, json};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

pub const CHANNELS: &[&str] = &["telemetry:capture", "telemetry:status"];

/// The Nekko Agent PostHog project's public ingest key (project 686111; a
/// write-only key that ships in every client). `NEKKO_POSTHOG_KEY` overrides
/// it (development, tests); set it empty to send nothing.
const PROJECT_KEY: &str = "phc_za3XdjQKQjDxbNgxDvmtfJXTMmtszrNX4q2D7QgcqSd9";
const HOST: &str = "https://us.i.posthog.com";
/// Events are sent in batches this often.
const FLUSH_EVERY: Duration = Duration::from_secs(60);
/// Events held at most; older ones are dropped first.
const QUEUE_MAX: usize = 500;
/// A string property is cut to this many characters.
const STRING_MAX: usize = 2000;

/// Each event the app may send, with the properties it may carry.
const EVENTS: &[(&str, &[&str])] = &[
    ("app_started", &[]),
    ("turn_started", &["provider", "local", "offline", "mode", "sandbox"]),
    ("screen_viewed", &["screen"]),
    ("feature_used", &["feature"]),
    ("error", &["source", "message", "stack"]),
];

#[derive(Default)]
struct State {
    enabled: bool,
    install_id: String,
    facts: Map<String, Value>,
    queue: Vec<Value>,
}

fn cell() -> &'static Mutex<State> {
    static S: OnceLock<Mutex<State>> = OnceLock::new();
    S.get_or_init(Default::default)
}

fn state() -> std::sync::MutexGuard<'static, State> {
    cell().lock().unwrap_or_else(|e| e.into_inner())
}

fn key() -> String {
    std::env::var("NEKKO_POSTHOG_KEY").unwrap_or_else(|_| PROJECT_KEY.to_string())
}

fn host() -> String {
    std::env::var("NEKKO_POSTHOG_HOST").ok().filter(|h| !h.is_empty()).unwrap_or_else(|| HOST.to_string())
}

/// Apply `settings.telemetry`. Turning it off empties the queue.
pub fn configure(settings: &Value) {
    let t = &settings["telemetry"];
    let id = t["installId"].as_str().unwrap_or_default().to_string();
    let mut s = state();
    s.enabled = t["enabled"].as_bool() == Some(true) && !id.is_empty();
    s.install_id = id;
    if !s.enabled {
        s.queue.clear();
    }
}

/// Queue an event if reports are on and `event` is one of [`EVENTS`]; other
/// properties are dropped and every string is scrubbed.
pub fn capture(event: &str, props: &Value) {
    push(event, props, state());
}

fn push(event: &str, props: &Value, mut s: std::sync::MutexGuard<'static, State>) {
    let Some((_, allowed)) = EVENTS.iter().find(|(e, _)| *e == event) else { return };
    if !s.enabled {
        return;
    }
    let mut p = s.facts.clone();
    for k in allowed.iter() {
        let v = match &props[*k] {
            Value::String(text) => json!(scrub(&text.chars().take(STRING_MAX).collect::<String>())),
            v @ (Value::Bool(_) | Value::Number(_)) => v.clone(),
            _ => continue,
        };
        p.insert((*k).into(), v);
    }
    p.insert("$process_person_profile".into(), json!(false));
    p.insert("$geoip_disable".into(), json!(true));
    let ev = json!({
        "event": event,
        "distinct_id": s.install_id,
        "timestamp": chrono::Utc::now().to_rfc3339(),
        "properties": p,
    });
    s.queue.push(ev);
    let over = s.queue.len().saturating_sub(QUEUE_MAX);
    s.queue.drain(..over);
}

fn rules() -> &'static (regress::Regex, regress::Regex) {
    static R: OnceLock<(regress::Regex, regress::Regex)> = OnceLock::new();
    R.get_or_init(|| {
        let re = |src: &str| regress::Regex::new(src).expect("scrub pattern compiles");
        // An absolute path's folders (`/Users/a/code/x/`, `C:\Users\a\`, `file:///…/`), kept: its last part.
        (re(r#"(?:file:\/\/)?(?:[A-Za-z]:[\\/]|\/)(?:[^\s\/\\:'"()<>]+[\\/])+"#), re(r"\[[A-Z_]+\]"))
    })
}

/// A string with secrets, personal values and folder names taken out.
pub fn scrub(text: &str) -> String {
    let s = crate::logs::redact(text);
    let users = nekko_privacy::local_usernames();
    let kinds = |k: nekko_privacy::Kind| !matches!(k, nekko_privacy::Kind::Term);
    let spans = nekko_privacy::scan(&s, &kinds, &users, &[]);
    let mut out = String::with_capacity(s.len());
    let mut at = 0;
    for sp in spans {
        out.push_str(&s[at..sp.start]);
        out.push_str(&format!("[{}]", sp.kind.label()));
        at = sp.end;
    }
    out.push_str(&s[at..]);
    let (paths, _) = rules();
    let mut cut = String::with_capacity(out.len());
    let mut at = 0;
    for m in paths.find_iter(&out) {
        cut.push_str(&out[at..m.range().start]);
        cut.push_str("…/");
        at = m.range().end;
    }
    cut.push_str(&out[at..]);
    cut
}

/// Send what is queued. Kept for the next try when the send fails.
async fn flush() {
    let key = key();
    let batch = {
        let mut s = state();
        if !s.enabled || key.is_empty() || s.queue.is_empty() {
            return;
        }
        std::mem::take(&mut s.queue)
    };
    let client = reqwest::Client::builder().timeout(Duration::from_secs(20)).build().unwrap_or_default();
    let rb = client.post(format!("{}/batch/", host())).json(&json!({ "api_key": key, "batch": batch }));
    let ok = matches!(nekko_net::send("telemetry", rb).await, Ok(r) if r.status().is_success());
    if !ok {
        let mut s = state();
        if s.enabled {
            let mut back = batch;
            back.append(&mut s.queue);
            let over = back.len().saturating_sub(QUEUE_MAX);
            back.drain(..over);
            s.queue = back;
        }
    }
}

/// Follow `settings.telemetry`, send every [`FLUSH_EVERY`], report crashes,
/// and record this start.
pub fn start(ctx: Ctx) {
    let app = crate::feedback::info(&crate::small_services::app_info(&ctx.app.facts));
    if let Value::Object(m) = app {
        state().facts = m;
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // A panic while the queue is locked must not wait on itself.
        if let Ok(s) = cell().try_lock() {
            push("error", &json!({ "source": "engine-panic", "message": info.to_string() }), s);
        }
        previous(info);
    }));
    tokio::spawn(async move {
        let Some(settings) = ctx.settings.clone() else { return };
        let mut changes = settings.store.subscribe();
        configure(&changes.borrow_and_update());
        capture("app_started", &Value::Null);
        let mut tick = tokio::time::interval(FLUSH_EVERY);
        loop {
            tokio::select! {
                changed = changes.changed() => {
                    if changed.is_err() { break }
                    configure(&changes.borrow_and_update());
                }
                _ = tick.tick() => flush().await,
            }
        }
    });
}

pub async fn route(channel: &str, args: &[Value]) -> Result<Value, String> {
    match channel {
        "telemetry:capture" => {
            let event = args.first().and_then(Value::as_str).unwrap_or_default();
            // The engine sends these itself; the UI cannot.
            if event == "app_started" || event == "turn_started" {
                return Err(format!("{event} is not a UI event"));
            }
            capture(event, args.get(1).unwrap_or(&Value::Null));
            Ok(Value::Null)
        }
        "telemetry:status" => {
            let s = state();
            Ok(json!({ "enabled": s.enabled, "configured": !key().is_empty(), "queued": s.queue.len() }))
        }
        _ => Err(format!("unknown channel {channel}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrub_takes_out_secrets_people_and_folders() {
        let s = scrub(
            "failed at /Users/philip/code/client-x/src/main.rs:12 for bob@example.com with sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
        );
        assert!(s.contains("…/main.rs:12"), "{s}");
        assert!(!s.contains("philip") && !s.contains("client-x"), "{s}");
        assert!(!s.contains("bob@example.com"), "{s}");
        assert!(!s.contains("abcdefghijklmnop"), "{s}");
        assert_eq!(scrub(r"at C:\Users\a\app\index.js:3"), "at …/index.js:3");
        assert_eq!(scrub("TypeError: x is undefined"), "TypeError: x is undefined");
    }

    // One test: the state is process-wide.
    #[test]
    fn off_unless_on_and_only_known_events_and_properties() {
        capture("error", &json!({ "message": "x" }));
        assert!(state().queue.is_empty(), "off by default");
        configure(&json!({ "telemetry": { "enabled": true } }));
        capture("error", &json!({ "message": "x" }));
        assert!(state().queue.is_empty(), "no install id, no reports");

        configure(&json!({ "telemetry": { "enabled": true, "installId": "i-1" } }));
        capture("made_up", &json!({}));
        capture("screen_viewed", &json!({ "screen": "settings", "path": "/Users/a/secret", "chat": "hello" }));
        let q = state().queue.clone();
        assert_eq!(q.len(), 1);
        let p = &q[0]["properties"];
        assert_eq!(q[0]["distinct_id"], "i-1");
        assert_eq!(p["screen"], "settings");
        assert!(p.get("path").is_none() && p.get("chat").is_none());
        assert_eq!(p["$process_person_profile"], false);
        assert_eq!(p["$geoip_disable"], true);

        for _ in 0..QUEUE_MAX + 10 {
            capture("feature_used", &json!({ "feature": "x" }));
        }
        assert_eq!(state().queue.len(), QUEUE_MAX);
        configure(&json!({ "telemetry": { "enabled": false, "installId": "i-1" } }));
        assert!(state().queue.is_empty(), "turning it off forgets what was queued");
    }
}
