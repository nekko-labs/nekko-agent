//! Opt-in usage and crash reports to PostHog (`settings.telemetry`), off
//! unless the person turns it on in onboarding or Settings.
//!
//! What a report may hold, and nothing else:
//! - a random install id (a new one each time it is turned on), the app
//!   version, edition, OS, OS version and CPU type, the UTC occurrence time,
//!   and the local hour and weekday it happened (never the time zone);
//! - the machine at start ([`hardware`]): CPU model and cores, RAM, GPU name
//!   and VRAM, rounded to whole gigabytes;
//! - which features, models and modes get used ([`EVENTS`]), with the few
//!   properties each allows; a non-incognito turn's chat is only an install-scoped pseudonym;
//! - errors and crashes, with every string scrubbed ([`scrub`]): secrets,
//!   emails, phone numbers, card numbers, IP addresses and the user's name are
//!   replaced, and file paths are cut to their last part. An error carries
//!   only its class and the first line of its message, at most
//!   [`ERROR_CHARS`] characters ([`error_message`]), and stack frames as
//!   function and file names ([`error_stack`]): never the rest of a message,
//!   which could echo a prompt.
//!
//! Never chat text, prompts, file contents, folder names, model output or
//! account names. The one account-derived fact: an engine signed in to Nekko
//! Cloud with a Nekko team account marks its events `internal: true`, so the
//! team's own use can be filtered out ([`mark_internal`]). PostHog is told not to look up the IP's location and not to
//! build a person profile. Everything goes through Settings > Connections as
//! `telemetry`, so All connections off stops it and its log shows every send.

use crate::routes::Ctx;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const CHAT_PSEUDONYM_DOMAIN: &[u8] = b"nekko-turn-chat-v1\0";
const LOCAL_MODEL_FILE_EXTENSIONS: &[&str] = &[".gguf", ".safetensors", ".bin", ".pt", ".pth", ".ckpt"];

/// A stable pseudonym for one chat only inside one opt-in install identity.
/// The raw chat id never enters an event, and a new install id makes a new
/// pseudonym for the same synced chat.
fn chat_pseudonym(install_id: &str, session_id: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(CHAT_PSEUDONYM_DOMAIN);
    hash.update(install_id.as_bytes());
    hash.update([0]);
    hash.update(session_id.as_bytes());
    format!("{:x}", hash.finalize())
}

fn path_shaped_model_id(id: &str) -> bool {
    let id = id.trim();
    let lower = id.to_ascii_lowercase();
    id.starts_with('/')
        || id.starts_with('\\')
        || (id.as_bytes().first().is_some_and(u8::is_ascii_alphabetic) && id.as_bytes().get(1) == Some(&b':'))
        || lower.starts_with("file:")
        || id.contains('\\')
        || id.split('/').any(|part| part == "." || part == "..")
        || LOCAL_MODEL_FILE_EXTENSIONS.iter().any(|extension| lower.ends_with(extension))
}

/// Safe model attribution for the concrete route known at admission.
///
/// A Claude Agent alias becomes the exact id passed to `claude --model`; an
/// empty id passes no flag, so Claude Code chooses later. The managed Local
/// Model Server's ids and `sourceRepo` values are path-derived today, so neither
/// is model attribution. Other explicit API ids pass through unless path-shaped.
/// Missing reasons are fixed categories for aggregate charts, never guesses.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ModelAttribution {
    pub model: Option<String>,
    pub missing_reason: Option<&'static str>,
}

pub(crate) fn model_attribution(kind: &str, route_model_id: &str, managed_local: bool) -> ModelAttribution {
    let route_model_id = route_model_id.trim();
    if route_model_id.is_empty() {
        return ModelAttribution {
            model: None,
            missing_reason: Some(if kind == "claude-code" { "provider_default" } else { "unavailable" }),
        };
    }
    if managed_local || path_shaped_model_id(route_model_id) {
        return ModelAttribution { model: None, missing_reason: Some("withheld_path") };
    }
    let model = if kind == "claude-code" {
        nekko_agent::providers::claude_code::concrete_model_id(route_model_id)
    } else {
        route_model_id.to_string()
    };
    ModelAttribution { model: Some(model), missing_reason: None }
}

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
/// An error's message is cut to this many characters, after scrubbing.
pub const ERROR_CHARS: usize = 200;
/// Stack frames an error report keeps.
const FRAMES_MAX: usize = 30;

/// Each event the app may send, with the properties it may carry.
const EVENTS: &[(&str, &[&str])] = &[
    ("app_started", &["cpu", "cpu_cores", "ram_gb", "gpu", "gpu_count", "vram_gb", "unified", "backends"]),
    ("app_opened", &[]),
    ("app_closed", &["running_seconds"]),
    (
        "turn_started",
        &[
            "provider",
            "local",
            "actor",
            "chat_pseudonym",
            "offline",
            "mode",
            "sandbox",
            "model",
            "model_missing_reason",
            "permission",
            "subagent",
            "running_agents",
            "connectors",
            "mcp_servers",
        ],
    ),
    ("voice_used", &["engine"]),
    ("runner_job", &["result", "seconds"]),
    ("screen_viewed", &["screen"]),
    ("click", &["screen", "control"]),
    ("feature_used", &["feature"]),
    // The Send feedback sheet opened, and which way in (`rail`, `palette`,
    // `about`, `menu`, `tray`, `link`). Never what the note says.
    ("feedback_opened", &["source"]),
    ("error", &["source", "message", "stack"]),
];

/// Events only the engine sends; `telemetry:capture` refuses them from the UI.
const ENGINE_ONLY: &[&str] = &["app_started", "turn_started", "voice_used", "runner_job"];

#[derive(Default)]
struct State {
    enabled: bool,
    install_id: String,
    facts: Map<String, Value>,
    queue: Vec<Value>,
    /// Signed in to Nekko Cloud with a team account (decision 0092): every
    /// event sent carries `internal: true`.
    internal: bool,
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

/// Queue an event if reports are on and `event` is one of [`EVENTS`]. Other
/// properties are dropped and source strings are scrubbed. The engine-derived
/// chat pseudonym is accepted only in its fixed lowercase-hex shape.
pub fn capture(event: &str, props: &Value) {
    push(event, props, state());
}

/// Queue a turn event. A non-incognito chat gets a pseudonym derived from the
/// currently enabled install identity; an incognito turn passes no session id.
/// The raw session id is used only as hash input and never enters the event.
pub fn capture_turn(session_id: Option<&str>, props: &Value) {
    let s = state();
    if !s.enabled {
        return;
    }
    let mut props = props.as_object().cloned().unwrap_or_default();
    if let Some(session_id) = session_id {
        props.insert("chat_pseudonym".into(), json!(chat_pseudonym(&s.install_id, session_id)));
    }
    push("turn_started", &Value::Object(props), s);
}

fn push(event: &str, props: &Value, mut s: std::sync::MutexGuard<'static, State>) {
    let Some((_, allowed)) = EVENTS.iter().find(|(e, _)| *e == event) else { return };
    if !s.enabled {
        return;
    }
    let mut p = s.facts.clone();
    for k in allowed.iter() {
        let v = match &props[*k] {
            Value::String(text)
                if event == "turn_started"
                    && *k == "chat_pseudonym"
                    && text.len() == 64
                    && text.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) =>
            {
                json!(text)
            }
            Value::String(text) if event == "turn_started" && *k == "model_missing_reason" => match text.as_str() {
                "provider_default" | "withheld_path" | "unavailable" => json!(text),
                _ => continue,
            },
            Value::String(text) if event == "error" && *k == "message" => json!(error_message(text)),
            Value::String(text) if event == "error" && *k == "stack" => json!(error_stack(text)),
            Value::String(text) => json!(scrub(&text.chars().take(STRING_MAX).collect::<String>())),
            v @ (Value::Bool(_) | Value::Number(_)) => v.clone(),
            _ => continue,
        };
        p.insert((*k).into(), v);
    }
    // Time-of-day use: the local hour and weekday only, never the zone.
    let occurred_at = chrono::Utc::now();
    let local = occurred_at.with_timezone(&chrono::Local);
    p.insert("local_hour".into(), json!(chrono::Timelike::hour(&local)));
    p.insert("weekday".into(), json!(local.format("%a").to_string()));
    p.insert("$process_person_profile".into(), json!(false));
    p.insert("$geoip_disable".into(), json!(true));
    let ev = json!({
        "event": event,
        "distinct_id": s.install_id,
        // The occurrence time, set as the event is queued, never its later flush time.
        "timestamp": occurred_at.to_rfc3339(),
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

/// An error's message as a report carries it: the first non-empty line
/// (`TypeError: x is undefined`, the class first as JavaScript and the
/// callers put it), scrubbed, then cut to [`ERROR_CHARS`] characters.
pub fn error_message(text: &str) -> String {
    let first = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let first: String = first.chars().take(STRING_MAX).collect();
    scrub(&first).chars().take(ERROR_CHARS).collect()
}

/// A stack as a report carries it: only its frames (`at name (file:line:col)`),
/// each reduced to the function and the file's last part, one per line. The
/// message lines a JavaScript stack starts with are dropped.
pub fn error_stack(text: &str) -> String {
    let frames = text.lines().filter_map(|line| {
        let frame = line.trim().strip_prefix("at ")?;
        let (name, place) = match frame.strip_suffix(')').and_then(|f| f.split_once(" (")) {
            Some((name, place)) => (name.trim(), place),
            None => ("", frame),
        };
        let file = place.rsplit(['/', '\\']).next().unwrap_or(place);
        let out = if name.is_empty() { file.to_string() } else { format!("{name} ({file})") };
        Some(scrub(&out.chars().take(200).collect::<String>()))
    });
    frames.take(FRAMES_MAX).collect::<Vec<_>>().join("\n")
}

/// `app_started`'s properties from `machine:profile`: model names and counts,
/// memory in whole gigabytes. Never serial numbers, host names or paths.
pub fn hardware(profile: &Value) -> Value {
    let gb = |v: &Value| v.as_f64().map(|b| (b / 1_073_741_824.0).round() as u64);
    let gpus = profile["gpus"].as_array().cloned().unwrap_or_default();
    let backends: Vec<&str> = profile["backends"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    json!({
        "cpu": profile["cpu"]["model"],
        "cpu_cores": profile["cpu"]["cores"],
        "ram_gb": gb(&profile["ramBytes"]),
        "gpu": gpus.first().map_or(Value::Null, |g| g["name"].clone()),
        "gpu_count": gpus.len(),
        "vram_gb": gb(&json!(gpus.iter().filter_map(|g| g["vramBytes"].as_f64()).sum::<f64>())),
        "unified": profile["unified"],
        "backends": backends.join(","),
    })
}

/// Whether this engine is signed in to Nekko Cloud with a team account.
pub fn set_internal(on: bool) {
    state().internal = on;
}

/// Mark each event as the Nekko team's own use (`internal: true`), so the
/// PostHog project's internal-user filter leaves it out. Nobody else's
/// reports carry the property.
fn mark_internal(batch: &mut [Value]) {
    for ev in batch {
        if let Some(p) = ev["properties"].as_object_mut() {
            p.insert("internal".into(), json!(true));
        }
    }
}

/// Send what is queued. Kept for the next try when the send fails.
async fn flush() {
    let key = key();
    let batch = {
        let mut s = state();
        if !s.enabled || key.is_empty() || s.queue.is_empty() {
            return;
        }
        let mut batch = std::mem::take(&mut s.queue);
        if s.internal {
            mark_internal(&mut batch);
        }
        batch
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
            // The panic's own words and where it happened: its file, never a folder.
            let payload = info.payload();
            let what = payload
                .downcast_ref::<&str>()
                .copied()
                .or_else(|| payload.downcast_ref::<String>().map(String::as_str));
            let place = info.location().map(|l| format!("at {}:{}:{}", l.file(), l.line(), l.column()));
            let props = json!({ "source": "engine-panic", "message": format!("panic: {}", what.unwrap_or("")), "stack": place.unwrap_or_default() });
            push("error", &props, s);
        }
        previous(info);
    }));
    tokio::spawn(async move {
        let settings = ctx.settings.clone();
        let mut changes = settings.store.subscribe();
        configure(&changes.borrow_and_update());
        // Once per run, as soon as reports are on: at start, or when they are
        // turned on later (onboarding's step comes after the engine starts).
        let mut started = false;
        let mut tick = tokio::time::interval(FLUSH_EVERY);
        loop {
            if !started && state().enabled {
                started = true;
                let profile = serde_json::to_value(ctx.machine.profile(false).await).unwrap_or(Value::Null);
                capture("app_started", &hardware(&profile));
            }
            tokio::select! {
                changed = changes.changed() => {
                    if changed.is_err() { break }
                    configure(&changes.borrow_and_update());
                }
                _ = tick.tick() => {
                    set_internal(ctx.cloud.is_staff());
                    flush().await
                }
            }
        }
    });
}

pub async fn route(channel: &str, args: &[Value]) -> Result<Value, String> {
    match channel {
        "telemetry:capture" => {
            let event = args.first().and_then(Value::as_str).unwrap_or_default();
            if ENGINE_ONLY.contains(&event) {
                return Err(format!("{event} is not a UI event"));
            }
            capture(event, args.get(1).unwrap_or(&Value::Null));
            // The app is quitting: send now rather than at the next minute.
            if event == "app_closed" {
                flush().await;
            }
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

    #[test]
    fn an_error_keeps_its_class_and_first_line_only() {
        let echoed = "TypeError: cannot read 'x' of undefined\nwhile handling: please summarise my divorce papers for bob@example.com";
        assert_eq!(error_message(echoed), "TypeError: cannot read 'x' of undefined");
        let long = format!("Error: {}", "word ".repeat(100));
        assert_eq!(error_message(&long).chars().count(), ERROR_CHARS);
        // Scrubbed before it is cut, so a cut never leaves half a secret.
        assert_eq!(error_message("\n  Error: failed for bob@example.com\n"), "Error: failed for [EMAIL]");
        assert_eq!(error_message(""), "");
    }

    #[test]
    fn a_stack_keeps_frames_as_function_and_file_names() {
        let stack = "Error: my secret prompt text\n    more of the prompt\n    at Object.send (/Users/philip/code/client-x/src/send.ts:12:5)\n    at file:///Users/philip/app/index.js:3:1\n    at async run (C:\\Users\\a\\app\\main.js:9:2)";
        let out = error_stack(stack);
        assert_eq!(out, "Object.send (send.ts:12:5)\nindex.js:3:1\nasync run (main.js:9:2)");
        assert!(!out.contains("prompt") && !out.contains("philip"));
        assert_eq!(error_stack("panicked without frames"), "");
        assert_eq!(error_stack("at crates/nekkod/src/x.rs:4:9"), "x.rs:4:9");
    }

    #[test]
    fn turn_identity_and_model_attribution_are_private_and_observed() {
        let first = chat_pseudonym("install-a", "chat-secret");
        assert_eq!(first.len(), 64);
        assert_eq!(first, chat_pseudonym("install-a", "chat-secret"));
        assert_ne!(first, chat_pseudonym("install-a", "another-chat"));
        assert_ne!(first, chat_pseudonym("install-b", "chat-secret"));
        assert!(!first.contains("chat-secret"));

        let expect = |kind, id, managed, model: Option<&str>, missing_reason| {
            assert_eq!(
                model_attribution(kind, id, managed),
                ModelAttribution { model: model.map(str::to_string), missing_reason }
            );
        };
        expect("openrouter", "openai/gpt-5", false, Some("openai/gpt-5"), None);
        expect("chatgpt", "gpt-5.3-codex", false, Some("gpt-5.3-codex"), None);
        expect("chatgpt", "", false, None, Some("unavailable"));
        let concrete = nekko_agent::providers::claude_code::concrete_model_id("opus");
        assert_ne!(concrete, "opus");
        expect("claude-code", "opus", false, Some(&concrete), None);
        expect("claude-code", "  ", false, None, Some("provider_default"));

        // The managed library's ids and sourceRepo are path-derived; neither is
        // an authoritative model id. An external llama.cpp server's explicit
        // API id is authoritative unless it is itself path-shaped.
        expect("llamacpp", "chat/Qwen_Qwen3-8B-GGUF/model.gguf", true, None, Some("withheld_path"));
        expect("llamacpp", "qwen3.5:9b", false, Some("qwen3.5:9b"), None);
        for path in
            ["/Users/a/private/model.gguf", r"C:\Users\a\private\model.gguf", "file:///tmp/model", "folder/model.gguf"]
        {
            expect("lmstudio", path, false, None, Some("withheld_path"));
        }
    }

    #[test]
    fn hardware_keeps_models_and_whole_gigabytes_only() {
        let profile = json!({ "format": 1, "probedAt": 5, "hostname": "philips-mac", "cpu": { "model": "Apple M4 Max", "cores": 16 },
            "ramBytes": 137438953472.0, "unified": true, "backends": ["metal", "cpu"],
            "gpus": [{ "name": "Apple M4 Max", "vramBytes": 137438953472.0, "cores": 40, "serial": "X1" }] });
        assert_eq!(
            hardware(&profile),
            json!({ "cpu": "Apple M4 Max", "cpu_cores": 16, "ram_gb": 128, "gpu": "Apple M4 Max", "gpu_count": 1,
                "vram_gb": 128, "unified": true, "backends": "metal,cpu" })
        );
        assert_eq!(hardware(&Value::Null)["gpu_count"], 0);
        assert!(ENGINE_ONLY.iter().all(|e| EVENTS.iter().any(|(k, _)| k == e)));
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

        let before = chrono::Utc::now();
        capture_turn(
            Some("chat-secret"),
            &json!({ "provider": "openrouter", "model": "openai/gpt-5", "actor": "user", "session_id": "chat-secret" }),
        );
        let after = chrono::Utc::now();
        let turn = state().queue.pop().expect("turn queued");
        let turn_text = serde_json::to_string(&turn).unwrap();
        let occurred_at = chrono::DateTime::parse_from_rfc3339(turn["timestamp"].as_str().unwrap())
            .unwrap()
            .with_timezone(&chrono::Utc);
        assert!(occurred_at >= before && occurred_at <= after, "{turn}");
        assert_eq!(turn["properties"]["chat_pseudonym"], chat_pseudonym("i-1", "chat-secret"));
        assert_eq!(turn["properties"]["actor"], "user");
        assert_eq!(turn["properties"]["model"], "openai/gpt-5");
        assert!(turn["properties"].get("session_id").is_none());
        assert!(!turn_text.contains("chat-secret"), "{turn_text}");

        capture_turn(
            None,
            &json!({ "provider": "claude-code", "model_missing_reason": "provider_default", "offline": true }),
        );
        let incognito = state().queue.pop().expect("incognito turn queued");
        assert!(incognito["properties"].get("chat_pseudonym").is_none());
        assert_eq!(incognito["properties"]["model_missing_reason"], "provider_default");
        assert_eq!(incognito["properties"]["offline"], true);

        capture_turn(None, &json!({ "provider": "chatgpt", "model_missing_reason": "invented" }));
        let invalid = state().queue.pop().expect("turn queued");
        assert!(invalid["properties"].get("model_missing_reason").is_none());

        capture("screen_viewed", &json!({ "screen": "settings", "path": "/Users/a/secret", "chat": "hello" }));
        let q = state().queue.clone();
        assert_eq!(q.len(), 1);
        let p = &q[0]["properties"];
        assert_eq!(q[0]["distinct_id"], "i-1");
        assert_eq!(p["screen"], "settings");
        assert!(p.get("path").is_none() && p.get("chat").is_none());
        assert_eq!(p["$process_person_profile"], false);
        assert_eq!(p["$geoip_disable"], true);
        assert!(p["local_hour"].as_u64().is_some_and(|h| h < 24), "{p}");
        assert_eq!(p["weekday"].as_str().map(str::len), Some(3));

        capture(
            "error",
            &json!({ "source": "renderer", "message": "Error: boom\nmy prompt", "stack": "Error: boom\nmy prompt\n    at f (/a/b.js:1:2)" }),
        );
        let e = state().queue.pop().unwrap();
        assert_eq!(e["properties"]["message"], "Error: boom");
        assert_eq!(e["properties"]["stack"], "f (b.js:1:2)");

        capture("feedback_opened", &json!({ "source": "rail", "message": "my note" }));
        let f = state().queue.pop().unwrap();
        assert_eq!(f["event"], "feedback_opened");
        assert_eq!(f["properties"]["source"], "rail");
        assert!(f["properties"].get("message").is_none(), "only the way in, never the note");

        for _ in 0..QUEUE_MAX + 10 {
            capture("feature_used", &json!({ "feature": "x" }));
        }
        assert_eq!(state().queue.len(), QUEUE_MAX);
        configure(&json!({ "telemetry": { "enabled": false, "installId": "i-1" } }));
        assert!(state().queue.is_empty(), "turning it off forgets what was queued");
    }

    #[test]
    fn team_events_are_marked_internal_and_nobody_elses_are() {
        let ev = |props: Value| json!({ "event": "click", "distinct_id": "i-1", "properties": props });
        let mut batch = vec![ev(json!({ "screen": "chat" })), ev(json!({}))];
        mark_internal(&mut batch);
        assert!(batch.iter().all(|e| e["properties"]["internal"] == true));
        assert_eq!(batch[0]["properties"]["screen"], "chat");
    }
}
