//! What a paired phone may do on this computer: the daemon's copy of
//! `packages/shared/src/phone-access.ts`.
//!
//! The lists are not written here. `phone-access.json` is generated from the
//! TS constants by `packages/host/src/remote.golden.test.ts` (UPDATE_GOLDEN=1),
//! which fails when it is stale, and the same test records how the TS decides
//! a set of requests (`tests/golden/phone.json`), which this gate must
//! reproduce exactly: the same refusals with the same messages, the same
//! calls into the host and the same redacted replies.

use crate::socket::Dispatcher;
use serde_json::{Map, Value, json};
use std::sync::{Arc, OnceLock};

/// The phone access policy, as the TS wrote it.
pub struct Policy {
    pub channels: Vec<String>,
    pub denied_channels: Vec<String>,
    pub denied_prefixes: Vec<String>,
    pub denied_except: Vec<String>,
    pub settings_keys: Vec<String>,
    pub settings_view: Vec<String>,
    pub provider_view: Vec<String>,
    pub skill_view: Vec<String>,
    pub queue_keys: Vec<String>,
    pub session_option_keys: Vec<String>,
    pub chat_send_keys: Vec<String>,
    pub chat_modes: Vec<String>,
    /// `PHONE_SESSION_VIEW`: newest messages kept, tool text cut to this many UTF-16 units.
    pub session_messages: usize,
    pub session_text_chars: usize,
    /// `PHONE_SESSION_VIEW`: newest user photos sent as thumbnails, their long side, their largest data URL.
    pub session_images: usize,
    pub thumb_side: u32,
    pub thumb_chars: usize,
    /// `PHONE_MAX_FRAME_BYTES`: the largest sealed reply frame sent to a phone.
    pub max_frame_bytes: usize,
    /// `PHONE_CHANGES_VIEW`: the limits of a phone's Changes view.
    pub changes_view: crate::phone_changes::Limits,
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect()).unwrap_or_default()
}

/// The policy in `phone-access.json`. An unreadable file yields an empty
/// allowlist, so every phone request is refused rather than allowed.
pub fn policy() -> &'static Policy {
    static POLICY: OnceLock<Policy> = OnceLock::new();
    POLICY.get_or_init(|| {
        let v: Value = serde_json::from_str(include_str!("phone-access.json")).unwrap_or(Value::Null);
        Policy {
            channels: strings(&v["channels"]),
            denied_channels: strings(&v["alwaysDenied"]["channels"]),
            denied_prefixes: strings(&v["alwaysDenied"]["prefixes"]),
            denied_except: strings(&v["alwaysDenied"]["except"]),
            settings_keys: strings(&v["settingsKeys"]),
            settings_view: strings(&v["settingsView"]),
            provider_view: strings(&v["providerView"]),
            skill_view: strings(&v["skillView"]),
            queue_keys: strings(&v["queueKeys"]),
            session_option_keys: strings(&v["sessionOptionKeys"]),
            chat_send_keys: strings(&v["chatSendKeys"]),
            chat_modes: strings(&v["chatModes"]),
            // Missing numbers keep nothing rather than send a frame too large to arrive.
            session_messages: v["sessionView"]["messages"].as_u64().unwrap_or(0) as usize,
            session_text_chars: v["sessionView"]["textChars"].as_u64().unwrap_or(0) as usize,
            session_images: v["sessionView"]["images"].as_u64().unwrap_or(0) as usize,
            thumb_side: v["sessionView"]["thumbSide"].as_u64().unwrap_or(0) as u32,
            thumb_chars: v["sessionView"]["thumbChars"].as_u64().unwrap_or(0) as usize,
            max_frame_bytes: v["maxFrameBytes"].as_u64().unwrap_or(9 * 1024 * 1024) as usize,
            changes_view: crate::phone_changes::Limits::from_policy(&v["changesView"]),
        }
    })
}

/// Why a phone's request was refused (`PhoneAccessError` in the TS).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Denied {
    pub code: &'static str,
    pub detail: String,
}

impl std::fmt::Display for Denied {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Not allowed from a paired phone ({}): {}", self.code, self.detail)
    }
}

fn denied(code: &'static str, detail: impl Into<String>) -> Denied {
    Denied { code, detail: detail.into() }
}

fn has(list: &[String], s: &str) -> bool {
    list.iter().any(|x| x == s)
}

/// Whether `channel` is refused regardless of the allowlist.
pub fn always_denied(channel: &str) -> bool {
    let p = policy();
    if has(&p.denied_except, channel) {
        return false;
    }
    has(&p.denied_channels, channel) || p.denied_prefixes.iter().any(|pre| channel.starts_with(pre.as_str()))
}

/// Whether a phone may call `channel` at all.
pub fn channel_allowed(channel: &str) -> bool {
    !always_denied(channel) && has(&policy().channels, channel)
}

fn chat_mode(value: &Value, what: &str) -> Result<(), Denied> {
    let Some(mode) = value.as_str() else { return Err(denied("value-invalid", what)) };
    if !has(&policy().chat_modes, mode) {
        return Err(denied("value-invalid", what));
    }
    Ok(())
}

fn language_ok(s: &str) -> bool {
    (1..=16).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn setting_value(path: &str, value: &Value) -> Result<(), Denied> {
    let ok = match path {
        "defaultChatMode" => return chat_mode(value, path),
        "chatPaneAction" => matches!(value.as_str(), Some("complete" | "delete")),
        "skipDeleteConfirmation" | "voice.enabled" => value.is_boolean(),
        "voice.language" => value.as_str().is_some_and(language_ok),
        _ => false,
    };
    if ok { Ok(()) } else { Err(denied("value-invalid", path)) }
}

/// A phone's settings patch, checked whole before anything is applied: the
/// dotted paths it sets, in order, or why it is refused.
pub fn check_settings_patch(patch: &Value) -> Result<Vec<(String, Value)>, Denied> {
    let Some(patch) = patch.as_object() else { return Err(denied("value-invalid", "settings patch")) };
    let mut sets = Vec::new();
    for (key, value) in patch {
        match value {
            Value::Object(inner) if key == "voice" => {
                for (sub, v) in inner {
                    sets.push((format!("voice.{sub}"), v.clone()));
                }
            }
            _ => sets.push((key.clone(), value.clone())),
        }
    }
    if let Some((path, _)) = sets.iter().find(|(p, _)| !has(&policy().settings_keys, p)) {
        return Err(denied("setting-denied", path.clone()));
    }
    for (path, value) in &sets {
        setting_value(path, value)?;
    }
    Ok(sets)
}

fn keys_within(v: &Value, allowed: &[String], what: &str) -> Result<(), Denied> {
    let Some(o) = v.as_object() else { return Err(denied("value-invalid", what)) };
    match o.keys().find(|k| !has(allowed, k)) {
        Some(k) => Err(denied("option-denied", k.clone())),
        None => Ok(()),
    }
}

/// A skill invocation from a phone: `{ name, input }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillCall {
    pub name: String,
    pub input: String,
}

/// What screening a phone's call found to act on: a `settings:update`'s
/// checked paths, or a skill turn the computer expands.
#[derive(Debug, Default)]
pub struct Screened {
    pub settings: Option<Vec<(String, Value)>>,
    pub skill: Option<SkillCall>,
}

/// `{ name, input }` from a phone, or why not (`phoneSkill`).
/// A phone's `clientMessageId`, when it sent one, must be a short id (a UUID): `clientMessageIdOf`.
fn client_message_id(o: &Value) -> Result<(), Denied> {
    match o.get("clientMessageId") {
        None => Ok(()),
        Some(Value::String(id))
            if (1..=64).contains(&id.len())
                && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') =>
        {
            Ok(())
        }
        Some(_) => Err(denied("value-invalid", "clientMessageId")),
    }
}

fn phone_skill(v: &Value) -> Result<SkillCall, Denied> {
    let bad = || denied("value-invalid", "skill");
    let o = v.as_object().ok_or_else(bad)?;
    let name = o.get("name").and_then(Value::as_str).filter(|n| !n.is_empty()).ok_or_else(bad)?;
    let input = match o.get("input") {
        None => "",
        Some(Value::String(s)) => s.as_str(),
        Some(_) => return Err(bad()),
    };
    if o.keys().any(|k| k != "name" && k != "input") {
        return Err(bad());
    }
    Ok(SkillCall { name: name.to_string(), input: input.to_string() })
}

/// A phone's call checked against the allowlist and the per-channel rules.
pub fn screen(channel: &str, args: &[Value]) -> Result<Screened, Denied> {
    if !channel_allowed(channel) {
        return Err(denied("channel-denied", channel));
    }
    let arg = |i: usize| args.get(i).unwrap_or(&Value::Null);
    let mut out = Screened::default();
    match channel {
        "changes:list" => {
            if arg(0).as_str().is_none_or(|s| s.is_empty()) {
                return Err(denied("value-invalid", "chat id"));
            }
        }
        "settings:update" => out.settings = Some(check_settings_patch(arg(0))?),
        "session:setOptions" => {
            keys_within(arg(1), &policy().session_option_keys, "chat options")?;
            if let Some(mode) = arg(1).get("mode") {
                chat_mode(mode, "mode")?;
            }
        }
        "chat:send" => {
            keys_within(arg(0), &policy().chat_send_keys, "chat:send options")?;
            client_message_id(arg(0))?;
            if let Some(skill) = arg(0).get("skill") {
                out.skill = Some(phone_skill(skill)?);
            }
        }
        "chat:queue" => {
            let item = arg(1);
            if !item.is_string() {
                if !item.is_object() {
                    return Err(denied("value-invalid", "chat:queue prompt"));
                }
                keys_within(item, &policy().queue_keys, "chat:queue prompt")?;
                client_message_id(item)?;
                if let Some(skill) = item.get("skill") {
                    out.skill = Some(phone_skill(skill)?);
                }
            }
        }
        _ => {}
    }
    Ok(out)
}

/// The text a skill turn sends: its template, then the input (`skillTurnText`).
pub fn skill_turn_text(template: &str, input: &str) -> String {
    [template.trim_end(), input.trim()].iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join("\n\n")
}

/// A phone's skill turn as the desktop sends it, expanded from the computer's
/// own runnable skills (`expandPhoneSkill`): the phone's `text` is replaced,
/// an unknown skill is refused.
fn expand_skill(skill: &SkillCall, runnable: &Value, base: &Value) -> Result<Value, Denied> {
    let template = runnable
        .as_array()
        .into_iter()
        .flatten()
        .find(|s| {
            s.get("name").and_then(Value::as_str) == Some(skill.name.as_str())
                && s.get("template").is_some_and(Value::is_string)
        })
        .and_then(|s| s["template"].as_str())
        .ok_or_else(|| denied("skill-unknown", skill.name.clone()))?;
    let mut out = base.as_object().cloned().unwrap_or_default();
    out.insert("text".into(), Value::String(skill_turn_text(template, &skill.input)));
    out.insert("skill".into(), json!({ "name": skill.name, "input": skill.input }));
    Ok(Value::Object(out))
}

/// The patch to save for checked phone settings, given the current settings.
/// `voice` is saved whole (settings merge one level deep), so the rest of it is
/// kept. Paths that are not phone-settable are dropped here too.
pub fn settings_update(sets: &[(String, Value)], current: &Value) -> Value {
    let mut patch = Map::new();
    for (path, value) in sets.iter().filter(|(p, _)| has(&policy().settings_keys, p)) {
        match path.split_once('.') {
            None => {
                patch.insert(path.clone(), value.clone());
            }
            Some((head, sub)) => {
                if !patch.get(head).is_some_and(Value::is_object) {
                    let was = current.get(head).filter(|v| v.is_object()).cloned().unwrap_or_else(|| json!({}));
                    patch.insert(head.to_string(), was);
                }
                if let Some(Value::Object(o)) = patch.get_mut(head) {
                    o.insert(sub.to_string(), value.clone());
                }
            }
        }
    }
    Value::Object(patch)
}

/// Copy only `paths` (dotted, one level of nesting) out of `value`.
fn pick(value: &Value, paths: &[String]) -> Value {
    let mut out = Map::new();
    let Some(o) = value.as_object() else { return Value::Object(out) };
    for path in paths {
        match path.split_once('.') {
            None => {
                if let Some(v) = o.get(path) {
                    out.insert(path.clone(), v.clone());
                }
            }
            Some((head, sub)) => {
                let Some(v) = o.get(head).and_then(Value::as_object).and_then(|inner| inner.get(sub)) else { continue };
                if !out.get(head).is_some_and(Value::is_object) {
                    out.insert(head.to_string(), json!({}));
                }
                if let Some(Value::Object(m)) = out.get_mut(head) {
                    m.insert(sub.to_string(), v.clone());
                }
            }
        }
    }
    Value::Object(out)
}

/// What a phone receives for a channel's result: secrets never leave the computer.
pub fn redact(channel: &str, result: Value) -> Value {
    match channel {
        "settings:get" | "settings:update" => pick(&result, &policy().settings_view),
        "providers:list" => match result {
            Value::Array(list) => Value::Array(list.iter().map(|p| pick(p, &policy().provider_view)).collect()),
            _ => json!([]),
        },
        "skills:runnable" => match result {
            Value::Array(list) => Value::Array(list.iter().map(|s| pick(s, &policy().skill_view)).collect()),
            _ => json!([]),
        },
        "session:get" => session_view(result),
        "changes:list" => crate::phone_changes::view(&result, &policy().changes_view),
        _ => result,
    }
}

/// `phoneFrameTooLarge`: the error a phone gets instead of a reply too large for the relay.
pub fn frame_too_large(bytes: usize) -> String {
    let mb = bytes as f64 / (1024.0 * 1024.0);
    format!("This reply is too large to send to a phone ({mb:.1} MB). Open it on the computer.")
}

/// `cutText`: `s` cut to `n` UTF-16 units, dropping a surrogate pair cut in half.
fn cut_text(s: &str, n: usize) -> String {
    crate::hello::cut16(s, n).to_string()
}

/// Length in UTF-16 units, as JavaScript's `s.length`.
fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `cutInput`: a tool call's input with long string values cut.
fn cut_input(input: &Value, n: usize) -> (Value, bool) {
    match input {
        Value::String(s) if len16(s) > n => (json!(cut_text(s, n)), true),
        Value::Object(m) => {
            let mut cut = false;
            let mut out = Map::new();
            for (k, v) in m {
                match v {
                    Value::String(s) if len16(s) > n => {
                        out.insert(k.clone(), json!(cut_text(s, n)));
                        cut = true;
                    }
                    v => {
                        out.insert(k.clone(), v.clone());
                    }
                }
            }
            (Value::Object(out), cut)
        }
        v => (v.clone(), false),
    }
}

/// `phoneMessage`: one message as the phone receives it.
fn phone_message(m: &Value, n: usize) -> Value {
    let Value::Object(m) = m else { return m.clone() };
    let mut out = m.clone();
    if let Some(Value::Object(r)) = m.get("toolResult") {
        let mut r = r.clone();
        if let Some(Value::Array(images)) = r.get("images") {
            let count = images.len();
            r.remove("images");
            if count > 0 {
                r.insert("omittedImages".into(), json!(count));
            }
        }
        if let Some(Value::String(o)) = r.get("output")
            && len16(o) > n
        {
            let full = len16(o);
            let cut = cut_text(o, n);
            r.insert("outputChars".into(), json!(full));
            r.insert("output".into(), json!(cut));
            r.insert("truncated".into(), json!(true));
        }
        out.insert("toolResult".into(), Value::Object(r));
    }
    if let Some(Value::Array(calls)) = m.get("toolCalls") {
        let calls = calls
            .iter()
            .map(|c| match c {
                Value::Object(cm) if cm.contains_key("input") => {
                    let (input, cut) = cut_input(&cm["input"], n);
                    if !cut {
                        return c.clone();
                    }
                    let mut cm = cm.clone();
                    cm.insert("input".into(), input);
                    cm.insert("truncated".into(), json!(true));
                    Value::Object(cm)
                }
                c => c.clone(),
            })
            .collect();
        out.insert("toolCalls".into(), Value::Array(calls));
    }
    Value::Object(out)
}

/// `phoneSessionView`: the newest messages, tool images dropped, long tool
/// text cut (`PHONE_SESSION_VIEW`). Not a session object: unchanged.
pub fn session_view(session: Value) -> Value {
    let Value::Object(mut s) = session else { return session };
    let Some(Value::Array(all)) = s.get("messages") else { return Value::Object(s) };
    let (keep_n, n) = (policy().session_messages, policy().session_text_chars);
    let start = all.len().saturating_sub(keep_n);
    let omitted = start;
    let mut kept: Vec<Value> = all[start..].iter().map(|m| phone_message(m, n)).collect();
    // Newest first: the last `images` photos small enough to be thumbnails stay.
    let mut room = policy().session_images;
    for m in kept.iter_mut().rev() {
        let Some(Value::Array(imgs)) = m.get("images") else { continue };
        let mut imgs: Vec<Value> = imgs.iter().map(|v| json!(v.as_str().unwrap_or(""))).collect();
        for v in imgs.iter_mut().rev() {
            let fits = matches!(v.as_str(), Some(t) if !t.is_empty() && len16(t) <= policy().thumb_chars) && room > 0;
            if fits {
                room -= 1;
            } else {
                *v = json!("");
            }
        }
        if let Value::Object(o) = m {
            o.insert("images".into(), Value::Array(imgs));
        }
    }
    s.insert("messages".into(), Value::Array(kept));
    if omitted > 0 {
        s.insert("omittedMessages".into(), json!(omitted));
    }
    Value::Object(s)
}

/// Run a phone's request through the policy: refuse it, or call `run` with
/// the checked arguments and return the redacted result (`callFromPhone`).
pub async fn call(run: &Dispatcher, channel: String, args: Value) -> Result<Value, String> {
    // A non-list `args` is no arguments, as the TS relay reads it.
    let args = match args {
        Value::Array(a) => a,
        _ => Vec::new(),
    };
    let screened = screen(&channel, &args).map_err(|d| d.to_string())?;
    if channel == "changes:list" {
        // Off unless the computer's owner turned it on (Settings → Remote access).
        let settings = run("settings:get".to_string(), json!([])).await?;
        if settings.get("phoneChanges") != Some(&Value::Bool(true)) {
            return Err(denied("turned-off", "changes:list").to_string());
        }
    }
    let mut args = match screened.settings {
        Some(sets) => {
            let current = if sets.iter().any(|(p, _)| p.contains('.')) {
                run("settings:get".to_string(), json!([])).await?
            } else {
                Value::Null
            };
            vec![settings_update(&sets, &current)]
        }
        None => args,
    };
    if let Some(skill) = screened.skill {
        let runnable = run("skills:runnable".to_string(), json!([])).await?;
        let at = if channel == "chat:send" { 0 } else { 1 };
        args[at] = expand_skill(&skill, &runnable, &args[at]).map_err(|d| d.to_string())?;
    }
    let mut result = run(channel.clone(), Value::Array(args)).await?;
    if channel == "session:get" {
        result = crate::phone_thumbs::thumbnail_images(result).await;
    }
    Ok(redact(&channel, result))
}

/// `run`, restricted to what a paired phone may do.
pub fn gate(run: Dispatcher) -> Dispatcher {
    Arc::new(move |channel: String, args: Value| {
        let run = run.clone();
        Box::pin(async move { call(&run, channel, args).await })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn host(calls: Arc<Mutex<Vec<(String, Value)>>>, settings: Value) -> Dispatcher {
        Arc::new(move |channel: String, args: Value| {
            calls.lock().unwrap().push((channel.clone(), args));
            let out = match channel.as_str() {
                "settings:get" | "settings:update" => Ok(settings.clone()),
                _ => Ok(json!({ "ok": channel })),
            };
            Box::pin(std::future::ready(out))
        })
    }

    fn secrets() -> Value {
        json!({
            "theme": "dark", "defaultModelId": "m1", "defaultChatMode": "ask", "sandboxMode": "workspace",
            "providers": [{ "id": "p", "apiKey": "sk-secret" }], "hfToken": "hf_secret",
            "guardrails": [], "hooks": [{ "command": "curl" }],
            "voice": { "enabled": true, "language": "en", "modelPath": "/m.bin" },
        })
    }

    fn run(calls: &Arc<Mutex<Vec<(String, Value)>>>, channel: &str, args: Value) -> Result<Value, String> {
        let gated = gate(host(calls.clone(), secrets()));
        tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(gated(channel.to_string(), args))
    }

    #[test]
    fn the_policy_loaded() {
        assert!(policy().channels.len() >= 15);
        assert!(has(&policy().chat_modes, "yolo"), "a phone may pick YOLO");
        for c in &policy().channels {
            assert!(!always_denied(c), "{c} is allowed and always denied");
            assert!(crate::is_public(c), "{c} is not a public channel");
        }
    }

    #[test]
    fn refuses_dangerous_and_unlisted_channels_before_the_host() {
        let calls = Arc::default();
        for c in [
            "data:wipe",
            "settings:reset",
            "remote:revoke",
            "remote:rotate",
            "terminal:create",
            "file:write",
            "workspace:addByPath",
            "workspace:remove",
            "voice:install",
            "connector:connect",
            "mcp:status",
            "tasks:list",
            "turn:pending",
        ] {
            let err = run(&calls, c, json!([])).unwrap_err();
            assert_eq!(err, format!("Not allowed from a paired phone (channel-denied): {c}"));
        }
        assert!(calls.lock().unwrap().is_empty());
    }

    #[test]
    fn an_allowed_channel_still_works() {
        let calls = Arc::default();
        assert_eq!(run(&calls, "sessions:summaries", json!([])).unwrap(), json!({ "ok": "sessions:summaries" }));
        assert_eq!(calls.lock().unwrap().len(), 1);
    }

    #[test]
    fn refuses_other_settings_and_applies_nothing() {
        let calls = Arc::default();
        let err = run(&calls, "settings:update", json!([{ "chatPaneAction": "delete", "sandboxMode": "off" }]));
        assert_eq!(err.unwrap_err(), "Not allowed from a paired phone (setting-denied): sandboxMode");
        let err = run(&calls, "settings:update", json!([{ "chatPaneAction": "delete", "defaultChatMode": "turbo" }]));
        assert_eq!(err.unwrap_err(), "Not allowed from a paired phone (value-invalid): defaultChatMode");
        assert!(calls.lock().unwrap().is_empty(), "nothing reached the host");
    }

    #[test]
    fn a_phone_may_pick_yolo() {
        let calls = Arc::default();
        assert!(run(&calls, "settings:update", json!([{ "defaultChatMode": "yolo" }])).is_ok());
        assert!(run(&calls, "session:setOptions", json!(["s1", { "mode": "yolo" }])).is_ok());
        assert_eq!(calls.lock().unwrap().len(), 2);
    }

    #[test]
    fn never_writes_a_key_that_is_not_phone_settable() {
        let sets = vec![
            ("__proto__.polluted".to_string(), json!(true)),
            ("sandboxMode".to_string(), json!("off")),
            ("chatPaneAction".to_string(), json!("delete")),
        ];
        assert_eq!(settings_update(&sets, &json!({})), json!({ "chatPaneAction": "delete" }));
    }

    #[test]
    fn settings_reach_a_phone_without_secrets() {
        let calls = Arc::default();
        for (channel, args) in
            [("settings:get", json!([])), ("settings:update", json!([{ "voice": { "language": "it" } }]))]
        {
            let view = run(&calls, channel, args).unwrap();
            let text = view.to_string();
            for hidden in ["secret", "providers", "hooks", "guardrails", "sandboxMode", "modelPath"] {
                assert!(!text.contains(hidden), "{channel} returned a field the phone must not see: {hidden}");
            }
            assert_eq!(view["voice"], json!({ "enabled": true, "language": "en" }));
        }
        // The voice change kept the rest of voice.
        let calls = calls.lock().unwrap();
        assert_eq!(
            calls.last().unwrap().1,
            json!([{ "voice": { "enabled": true, "language": "it", "modelPath": "/m.bin" } }])
        );
    }
}
