//! What a paired phone may do on this computer: the daemon's copy of
//! `packages/shared/src/phone-access.ts`.
//!
//! The lists are not written here. `phone-access.json` is generated from the
//! TS constants by `packages/shared/src/phone-access.golden.test.ts`
//! (UPDATE_GOLDEN=1), which fails when it is stale. `tests/golden/phone.json`
//! is a frozen record of how the deleted TS gate decided a set of requests,
//! which this gate must
//! reproduce exactly: the same refusals with the same messages, the same
//! calls into the host and the same redacted replies.
//!
//! IO-33 adds who is calling: the gate gets the device the HELLO welcomed
//! (`PhoneCall`) and checks read-class and change-class channels against that
//! device's switches, a change-class call also against its signed proof
//! (`proof.rs`), and writes each change-class call to the device's activity.
//!
//! Since 2026-10-22 every channel a phone may call is classed: the chat
//! screens' reads are read-class, and everything that makes the agent act or
//! changes settings is agent-class (the Change switch, no proof per call,
//! logged), except that raising a chat's mode needs a proof (`mode_raise`).
//! A channel in no class is refused: the gate fails closed.

use crate::socket::{Dispatcher, PhoneCall, PhoneDispatcher};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

/// The phone access policy, as the TS wrote it.
pub struct Policy {
    pub channels: Vec<String>,
    pub denied_channels: Vec<String>,
    pub denied_prefixes: Vec<String>,
    pub denied_except: Vec<String>,
    pub settings_keys: Vec<String>,
    pub settings_view: Vec<String>,
    pub provider_view: Vec<String>,
    /// `session:watches`: the fields of a watch a phone receives (`PHONE_WATCH_VIEW`).
    pub watch_view: Vec<String>,
    /// `machine:summary`: its top-level keys and the resident model fields (`PHONE_MACHINE_VIEW`).
    pub machine_view: Vec<String>,
    pub machine_resident_view: Vec<String>,
    pub skill_view: Vec<String>,
    pub queue_keys: Vec<String>,
    pub session_option_keys: Vec<String>,
    pub chat_send_keys: Vec<String>,
    pub chat_modes: Vec<String>,
    pub effort_levels: Vec<String>,
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
    /// `PHONE_VIEWS` and the views beyond the chat (phone_views.rs).
    pub views: crate::phone_views::Views,
    pub queue_edit_keys: Vec<String>,
    /// `PHONE_READ_CHANNELS` / `PHONE_CHANGE_CHANNELS` (IO-33).
    pub read_channels: Vec<String>,
    pub change_channels: Vec<String>,
    /// `PHONE_AGENT_CHANNELS`: the Change switch, no proof per call.
    pub agent_channels: Vec<String>,
    /// `PHONE_OPEN_CHANNELS`: any paired phone.
    pub open_channels: Vec<String>,
    /// `PHONE_MODE_PROOF`: the channels that can raise a chat's mode, the
    /// modes from least to most permissive, and the mode when none is set.
    pub mode_channels: Vec<String>,
    pub mode_rank: Vec<String>,
    pub mode_fallback: String,
    /// `PHONE_CHANGE_PROOF`: how old, and how far ahead, a Change proof may be.
    pub proof_max_age_ms: f64,
    pub proof_max_ahead_ms: f64,
    /// `PHONE_KEY_CHANNEL`: the phone channel this gate answers itself.
    pub key_channel: String,
    /// `PHONE_ACTIVITY_LIMIT`: the newest activity entries kept per device.
    pub activity_limit: usize,
    /// `PHONE_TERMINAL` and the terminal channels (FA-3, FA-6; phone_terminal.rs).
    pub terminal: crate::phone_terminal::Limits,
    /// Files and logs from a phone (IO-33 FA-1, FA-5): limits and views (phone_files.rs).
    pub files: crate::phone_files::FilesPolicy,
    /// Git from a phone (IO-33 FA-2): limits, option keys and views (phone_git.rs).
    pub git: crate::phone_git::GitPolicy,
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
            watch_view: strings(&v["watchView"]),
            machine_view: strings(&v["machineView"]),
            machine_resident_view: strings(&v["machineResidentView"]),
            skill_view: strings(&v["skillView"]),
            queue_keys: strings(&v["queueKeys"]),
            session_option_keys: strings(&v["sessionOptionKeys"]),
            chat_send_keys: strings(&v["chatSendKeys"]),
            chat_modes: strings(&v["chatModes"]),
            effort_levels: strings(&v["effortLevels"]),
            // Missing numbers keep nothing rather than send a frame too large to arrive.
            session_messages: v["sessionView"]["messages"].as_u64().unwrap_or(0) as usize,
            session_text_chars: v["sessionView"]["textChars"].as_u64().unwrap_or(0) as usize,
            session_images: v["sessionView"]["images"].as_u64().unwrap_or(0) as usize,
            thumb_side: v["sessionView"]["thumbSide"].as_u64().unwrap_or(0) as u32,
            thumb_chars: v["sessionView"]["thumbChars"].as_u64().unwrap_or(0) as usize,
            max_frame_bytes: v["maxFrameBytes"].as_u64().unwrap_or(9 * 1024 * 1024) as usize,
            changes_view: crate::phone_changes::Limits::from_policy(&v["changesView"]),
            views: crate::phone_views::Views::from_policy(&v),
            queue_edit_keys: strings(&v["queueEditKeys"]),
            read_channels: strings(&v["readChannels"]),
            change_channels: strings(&v["changeChannels"]),
            agent_channels: strings(&v["agentChannels"]),
            open_channels: strings(&v["openChannels"]),
            mode_channels: strings(&v["modeProof"]["channels"]),
            mode_rank: strings(&v["modeProof"]["rank"]),
            // Missing: every mode counts as a raise, so each needs a proof.
            mode_fallback: v["modeProof"]["fallback"].as_str().unwrap_or("").to_string(),
            // Missing: no proof is fresh enough, so no Change action runs.
            proof_max_age_ms: v["changeProof"]["maxAgeMs"].as_f64().unwrap_or(0.0),
            proof_max_ahead_ms: v["changeProof"]["maxAheadMs"].as_f64().unwrap_or(0.0),
            key_channel: v["keyChannel"].as_str().unwrap_or("device:registerKey").to_string(),
            activity_limit: v["activityLimit"].as_u64().unwrap_or(200) as usize,
            terminal: crate::phone_terminal::Limits::from_policy(&v),
            files: crate::phone_files::FilesPolicy::from_policy(&v["files"]),
            git: crate::phone_git::GitPolicy::from_policy(&v["git"]),
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
    /// A git, files or logs call's arguments, rebuilt from the checked fields (phone_git.rs, phone_files.rs).
    pub args: Option<Vec<Value>>,
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
    if policy().terminal.is_terminal(channel) {
        return crate::phone_terminal::problem(channel, args).map_or(Ok(Screened::default()), Err);
    }
    if crate::phone_git::is_git(channel) {
        let args = crate::phone_git::screen(channel, args, &policy().git)?;
        return Ok(Screened { args: Some(args), ..Screened::default() });
    }
    if crate::phone_files::is_files(channel) {
        let args = crate::phone_files::screen(channel, args, &policy().files)?;
        return Ok(Screened { args: Some(args), ..Screened::default() });
    }
    let arg = |i: usize| args.get(i).unwrap_or(&Value::Null);
    let mut out = Screened::default();
    let id = |i: usize, what: &str| -> Result<(), Denied> {
        if arg(i).as_str().is_none_or(|s| s.is_empty()) { Err(denied("value-invalid", what)) } else { Ok(()) }
    };
    match channel {
        "changes:list" | "session:watches" => id(0, "chat id")?,
        "pr:sessionList" => {
            id(0, "chat id")?;
            if args.len() > 1 && !arg(1).is_boolean() {
                return Err(denied("value-invalid", "refresh"));
            }
        }
        "session:fork" => {
            id(0, "chat id")?;
            if args.len() > 1 && !arg(1).is_null() && arg(1).as_str().is_none_or(|s| s.is_empty()) {
                return Err(denied("value-invalid", "message id"));
            }
        }
        "chat:editQueued" => {
            id(0, "chat id")?;
            let index_ok = arg(1).as_f64().is_some_and(|i| i.fract() == 0.0 && i >= 0.0);
            if !index_ok {
                return Err(denied("value-invalid", "queue index"));
            }
            let edit = arg(2);
            keys_within(edit, &policy().queue_edit_keys, "queued prompt edit")?;
            if !edit.get("expect").is_some_and(Value::is_string) || edit.get("text").is_some_and(|t| !t.is_string()) {
                return Err(denied("value-invalid", "queued prompt edit"));
            }
        }
        "task:runNow" => id(0, "task id")?,
        "workflow:run" => id(0, "workflow id")?,
        "limits:get" => id(0, "provider id")?,
        "settings:update" => out.settings = Some(check_settings_patch(arg(0))?),
        "session:setOptions" => {
            keys_within(arg(1), &policy().session_option_keys, "chat options")?;
            if let Some(mode) = arg(1).get("mode") {
                chat_mode(mode, "mode")?;
            }
            if let Some(effort) = arg(1).get("effort")
                && !effort.as_str().is_some_and(|e| has(&policy().effort_levels, e))
            {
                return Err(denied("value-invalid", "effort"));
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
        "settings:get" | "settings:update" => {
            let mut view = pick(&result, &policy().settings_view);
            if let Some(o) = view.as_object_mut()
                && let Some(p) = o.get("prompts").cloned()
            {
                o.insert("prompts".into(), crate::phone_views::prompts(&p, &policy().views));
            }
            view
        }
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
        "chat:editQueued" => match &result {
            Value::Object(o) => json!({
                "id": o.get("id").cloned().unwrap_or(Value::Null),
                "queue": crate::phone_views::queue(o.get("queue").unwrap_or(&Value::Null)),
            }),
            _ => Value::Null,
        },
        "session:fork" => {
            if result.is_object() {
                pick(&result, &["id".into(), "title".into()])
            } else {
                Value::Null
            }
        }
        "tasks:list" => crate::phone_views::tasks(&result, &policy().views),
        "workflows:list" => crate::phone_views::workflows(&result, &policy().views),
        "workflow:run" => {
            if result.is_object() {
                pick(&result, &policy().views.workflow_run)
            } else {
                Value::Null
            }
        }
        "task:runNow" => Value::Null,
        "pr:sessionList" => crate::phone_views::prs(&result, &policy().views),
        "session:watches" => crate::phone_views::watches(&result, &policy().watch_view, policy().views.text_chars),
        "machine:summary" => {
            crate::phone_views::machine(&result, &policy().machine_view, &policy().machine_resident_view)
        }
        "usage:summary" => crate::phone_views::usage(&result, &policy().views),
        "limits:get" => crate::phone_views::limits(&result, &policy().views),
        c if policy().terminal.is_terminal(c) => crate::phone_terminal::result(c, &result),
        c if crate::phone_files::is_files(c) => crate::phone_files::view(c, &result, &policy().files),
        c if crate::phone_git::is_git(c) => crate::phone_git::view(c, &result, &policy().git, &policy().views.pr),
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
    if let Some(q) = s.get("queue") {
        let q = crate::phone_views::queue(q);
        s.insert("queue".into(), q);
    }
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
    let mut screened = screen(&channel, &args).map_err(|d| d.to_string())?;
    let args = screened.args.take().unwrap_or(args);
    if channel == "changes:list" {
        // The computer's setting (Settings → Remote access), on by default; the owner can turn it off.
        let settings = run("settings:get".to_string(), json!([])).await?;
        if settings.get("phoneChanges") != Some(&Value::Bool(true)) {
            return Err(denied("turned-off", "changes:list").to_string());
        }
    }
    if channel == "monitor:summary" {
        // Answered from what the computer already reads for its own Monitors dock; the phone's arguments are ignored.
        let mut sources = Map::new();
        for source in &policy().views.monitor_sources {
            sources.insert(source.clone(), run(source.clone(), json!([])).await?);
        }
        let now = crate::service::system_clock()();
        return Ok(crate::phone_views::monitor(&sources, now, &policy().views));
    }
    // Only what the computer's own call takes: an id, or nothing.
    let first = args.first().cloned().unwrap_or(Value::Null);
    let args: Vec<Value> = match channel.as_str() {
        "task:runNow" | "workflow:run" => vec![first.clone()],
        "tasks:list" | "workflows:list" | "usage:summary" => Vec::new(),
        "session:fork" => match args.get(1) {
            None | Some(Value::Null) => vec![first.clone()],
            Some(m) => vec![first.clone(), m.clone()],
        },
        "chat:editQueued" => vec![first.clone(), args[1].clone(), pick(&args[2], &policy().queue_edit_keys)],
        "pr:sessionList" => vec![first.clone(), json!(args.get(1) == Some(&Value::Bool(true)))],
        "limits:get" => {
            // The phone names a provider; the computer reads that provider's limits key itself.
            let providers = run("providers:list".to_string(), json!([])).await?;
            let Some(key) = crate::phone_views::limits_key(&providers, first.as_str().unwrap_or_default()) else {
                return Ok(Value::Null);
            };
            vec![json!(key), json!(false)]
        }
        c if policy().terminal.is_terminal(c) => {
            let mut out = crate::phone_terminal::call_args(c, &args);
            if c == "terminal:create" {
                // A new terminal starts in the chat's folder, as the desktop's does: the phone never names a path.
                let chat = run("session:get".to_string(), json!([out[0]["sessionId"]])).await?;
                if let (Some(w), Some(o)) = (chat.get("workspaceId").filter(|w| w.is_string()), out[0].as_object_mut())
                {
                    o.insert("workspaceId".into(), w.clone());
                }
            }
            out
        }
        _ => args,
    };
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

/// A paired phone's switches (`RemoteDevice.access`). Missing means on, so
/// phones paired before IO-33 keep working.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeviceAccess {
    pub read: bool,
    pub change: bool,
}

impl Default for DeviceAccess {
    fn default() -> Self {
        Self { read: true, change: true }
    }
}

impl DeviceAccess {
    /// A `remote.json` device record's switches.
    pub fn of(device: &Value) -> Self {
        let on = |k: &str| device.get("access").and_then(|a| a.get(k)) != Some(&Value::Bool(false));
        Self { read: on("read"), change: on("change") }
    }
}

/// What the gate knows of a paired, not revoked device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhoneDevice {
    pub access: DeviceAccess,
    /// The registered Change key (`changeKey`, base64 X9.63 P-256).
    pub key: Option<String>,
}

/// One change-class call from a phone, allowed or refused (`PhoneActivityEntry`).
#[derive(Debug, Clone, PartialEq)]
pub struct Activity {
    pub at: f64,
    pub channel: String,
    pub ok: bool,
    /// The refusal's code, or `failed` when the computer's call threw.
    pub reason: Option<String>,
}

impl Activity {
    pub fn value(&self) -> Value {
        let mut o = Map::new();
        o.insert("at".into(), crate::hello::nekko_num(self.at));
        o.insert("channel".into(), json!(self.channel));
        o.insert("ok".into(), json!(self.ok));
        if let Some(r) = &self.reason {
            o.insert("reason".into(), json!(r));
        }
        Value::Object(o)
    }
}

/// The paired-device registry as the gate sees it (`RemoteService` in the daemon).
pub trait Devices: Send + Sync {
    /// The device, unless it is unknown or revoked.
    fn device(&self, id: &str) -> Option<PhoneDevice>;
    /// Keep `key` as the device's Change key: `Ok(true)` when stored,
    /// `Ok(false)` when it already was, or the refusal's code
    /// (`device-unknown`, or `key-mismatch` when it holds another key: trust
    /// on first use, and pairing again is the only way to replace it).
    fn register_key(&self, id: &str, key: &str) -> Result<bool, &'static str>;
    /// Append to the device's activity list.
    fn record(&self, id: &str, entry: Activity);
    /// `Date.now()`.
    fn now(&self) -> f64;
    /// The device's name, for the desktop's *Phone attached* badge (FA-3).
    fn name(&self, _id: &str) -> Option<String> {
        None
    }
}

/// Which IO-33 class a channel is in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    /// The Read switch.
    Read,
    /// The Change switch and a signed proof per call.
    Change,
    /// The Change switch, no proof (except a mode raise).
    Agent,
    /// Any paired phone.
    Open,
}

/// The channels of each class; the policy's in production. A channel in
/// none is refused.
#[derive(Debug, Clone, Default)]
pub struct Classes {
    pub read: Vec<String>,
    pub change: Vec<String>,
    pub agent: Vec<String>,
    pub open: Vec<String>,
}

impl Classes {
    pub fn from_policy() -> Self {
        let p = policy();
        Self {
            read: p.read_channels.clone(),
            change: p.change_channels.clone(),
            agent: p.agent_channels.clone(),
            open: p.open_channels.clone(),
        }
    }

    pub fn of(&self, channel: &str) -> Option<Class> {
        if has(&self.change, channel) {
            Some(Class::Change)
        } else if has(&self.agent, channel) {
            Some(Class::Agent)
        } else if has(&self.read, channel) {
            Some(Class::Read)
        } else if has(&self.open, channel) {
            Some(Class::Open)
        } else {
            None
        }
    }
}

/// Where `mode` stands from least to most permissive; an unknown mode is
/// above them all (it needs a proof, and the screen refuses it anyway).
fn mode_rank(mode: &str) -> usize {
    let rank = &policy().mode_rank;
    rank.iter().position(|m| m == mode).unwrap_or(rank.len())
}

/// Whether setting `next` over `current` (a mode, or none set) raises the mode (`phoneRaisesMode`).
pub fn raises_mode(next: Option<&str>, current: Option<&str>) -> bool {
    let Some(next) = next else { return false };
    let was = current.unwrap_or(policy().mode_fallback.as_str());
    mode_rank(next) > mode_rank(was)
}

/// The code of a gate refusal's message, or `failed` for any other error.
pub(crate) fn reason_of(error: &str) -> String {
    error
        .strip_prefix("Not allowed from a paired phone (")
        .and_then(|rest| rest.split_once(')'))
        .map_or_else(|| "failed".to_string(), |(code, _)| code.to_string())
}

/// Per device: the timestamp and fingerprint of each accepted proof.
type Seen = HashMap<String, Vec<(i64, [u8; 32])>>;

pub(crate) struct Gate {
    pub(crate) run: Dispatcher,
    pub(crate) devices: Arc<dyn Devices>,
    classes: Classes,
    /// Each device's accepted Change proofs still inside the window, by the
    /// fingerprint of what they signed: a replayed request is refused. Memory
    /// only, so a restart forgets them (the window is five minutes).
    seen: Mutex<Seen>,
    /// Phones attached to terminals and their tokens, shared with the relay agent (FA-3).
    pub(crate) terminals: Arc<crate::phone_terminal::PhoneTerminals>,
}

impl Gate {
    async fn call(&self, who: PhoneCall, channel: String, args: Value) -> Result<Value, String> {
        if channel == policy().key_channel {
            return self.register_key(&who, &channel, &args);
        }
        if let Some(out) = self.terminal_call(&who, &channel, &args).await {
            return out;
        }
        // Fail closed: a channel in no class never reaches the computer.
        let Some(class) = self.classes.of(&channel) else { return Err(denied("channel-denied", channel).to_string()) };
        if !channel_allowed(&channel) {
            return Err(denied("channel-denied", channel).to_string());
        }
        match class {
            Class::Open => call(&self.run, channel, args).await,
            Class::Agent => {
                if let Err(d) = self.check_agent(&who, &channel, &args).await {
                    self.record(&who, &channel, Err(d.code.to_string()));
                    return Err(d.to_string());
                }
                let result = call(&self.run, channel.clone(), args).await;
                self.record(&who, &channel, result.as_ref().map(|_| ()).map_err(|e| reason_of(e)));
                result
            }
            Class::Read => {
                let device = self.devices.device(&who.device_id).ok_or_else(|| denied("device-unknown", &channel));
                if !device.map_err(|d| d.to_string())?.access.read {
                    return Err(denied("read-off", channel).to_string());
                }
                call(&self.run, channel, args).await
            }
            Class::Change => {
                if let Err(d) = self.check_change(&who, &channel, &args) {
                    self.record(&who, &channel, Err(d.code.to_string()));
                    return Err(d.to_string());
                }
                let result = call(&self.run, channel.clone(), args).await;
                self.record(&who, &channel, result.as_ref().map(|_| ()).map_err(|e| reason_of(e)));
                result
            }
        }
    }

    /// An agent-class call: a known device with Change on, a call the
    /// policy's screen accepts, and a signed proof when it raises a chat's mode.
    async fn check_agent(&self, who: &PhoneCall, channel: &str, args: &Value) -> Result<(), Denied> {
        let device = self.devices.device(&who.device_id).ok_or_else(|| denied("device-unknown", channel))?;
        if !device.access.change {
            return Err(denied("change-off", channel));
        }
        let list = args.as_array().cloned().unwrap_or_default();
        screen(channel, &list)?;
        if self.mode_raise(channel, &list).await {
            // Said first, so a phone without a registered key learns it must sign.
            if who.proof.is_none() {
                return Err(denied("proof-required", channel));
            }
            return self.check_change(who, channel, args);
        }
        Ok(())
    }

    /// Whether a phone's call raises a chat's mode (`PHONE_MODE_PROOF`):
    /// `session:setOptions` above the chat's mode (its own, else the default),
    /// `settings:update` above the default. A current mode the computer can't
    /// say counts as a raise.
    async fn mode_raise(&self, channel: &str, args: &[Value]) -> bool {
        if !has(&policy().mode_channels, channel) {
            return false;
        }
        let arg = |i: usize| args.get(i).unwrap_or(&Value::Null);
        let next = match channel {
            "session:setOptions" => arg(1).get("mode"),
            "settings:update" => arg(0).get("defaultChatMode"),
            _ => None,
        };
        let Some(next) = next.and_then(Value::as_str) else { return false };
        if !raises_mode(Some(next), policy().mode_rank.first().map(String::as_str)) {
            return false; // the least permissive mode is never a raise
        }
        let default = || async {
            let settings = (self.run)("settings:get".to_string(), json!([])).await.ok()?;
            Some(settings.get("defaultChatMode").and_then(Value::as_str).map(str::to_string))
        };
        let current = match channel {
            "session:setOptions" => {
                let Ok(chat) = (self.run)("session:get".to_string(), json!([arg(0)])).await else { return true };
                match chat.get("mode").and_then(Value::as_str) {
                    Some(m) => Some(m.to_string()),
                    None => match default().await {
                        Some(d) => d,
                        None => return true,
                    },
                }
            }
            _ => match default().await {
                Some(d) => d,
                None => return true,
            },
        };
        raises_mode(Some(next), current.as_deref())
    }

    pub(crate) fn record(&self, who: &PhoneCall, channel: &str, outcome: Result<(), String>) {
        let at = self.devices.now();
        let entry = Activity { at, channel: channel.to_string(), ok: outcome.is_ok(), reason: outcome.err() };
        self.devices.record(&who.device_id, entry);
    }

    /// The proof's timestamp, signature and signed text, checked for shape
    /// and freshness, or the refusal.
    fn fresh_proof(&self, who: &PhoneCall, channel: &str, args: &Value) -> Result<(Vec<u8>, String), Denied> {
        let Some(p) = &who.proof else { return Err(denied("proof-required", channel)) };
        let (ts, sig) = crate::proof::parse(p).ok_or_else(|| denied("proof-invalid", channel))?;
        let now = self.devices.now();
        let t = ts as f64;
        if t < now - policy().proof_max_age_ms || t > now + policy().proof_max_ahead_ms {
            return Err(denied("proof-stale", channel));
        }
        let text =
            crate::proof::payload(&who.device_id, channel, args, ts).ok_or_else(|| denied("proof-invalid", channel))?;
        Ok((sig, text))
    }

    /// Remember an accepted proof, or refuse one seen before.
    fn first_use(&self, who: &PhoneCall, channel: &str, text: &str) -> Result<(), Denied> {
        let ts = who.proof.as_ref().and_then(crate::proof::parse).map_or(0, |(t, _)| t);
        let oldest = self.devices.now() - policy().proof_max_age_ms;
        let print = crate::proof::fingerprint(text);
        let mut seen = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        let list = seen.entry(who.device_id.clone()).or_default();
        list.retain(|(t, _)| *t as f64 >= oldest);
        if list.iter().any(|(_, p)| *p == print) {
            return Err(denied("proof-replayed", channel));
        }
        list.push((ts, print));
        Ok(())
    }

    /// Everything a change-class call needs before it runs: a known device
    /// with Change on, a registered key, and a fresh, valid, unused proof.
    pub(crate) fn check_change(&self, who: &PhoneCall, channel: &str, args: &Value) -> Result<(), Denied> {
        let device = self.devices.device(&who.device_id).ok_or_else(|| denied("device-unknown", channel))?;
        if !device.access.change {
            return Err(denied("change-off", channel));
        }
        let key =
            device.key.as_deref().and_then(crate::proof::parse_key).ok_or_else(|| denied("key-missing", channel))?;
        let (sig, text) = self.fresh_proof(who, channel, args)?;
        if !crate::proof::verify(&key, &text, &sig) {
            return Err(denied("proof-invalid", channel));
        }
        self.first_use(who, channel, &text)
    }

    /// `device:registerKey [publicKey]`, signed with that key (so the phone
    /// shows it holds it, and on an iPhone the owner unlocked it): trust on
    /// first use. Answered here; the host never sees it.
    fn register_key(&self, who: &PhoneCall, channel: &str, args: &Value) -> Result<Value, String> {
        let outcome = (|| {
            let text = args.get(0).and_then(Value::as_str).filter(|_| args.as_array().is_some_and(|a| a.len() == 1));
            let key_text = text.ok_or_else(|| denied("key-invalid", channel))?;
            let key = crate::proof::parse_key(key_text).ok_or_else(|| denied("key-invalid", channel))?;
            self.devices.device(&who.device_id).ok_or_else(|| denied("device-unknown", channel))?;
            let (sig, signed) = self.fresh_proof(who, channel, args)?;
            if !crate::proof::verify(&key, &signed, &sig) {
                return Err(denied("proof-invalid", channel));
            }
            self.first_use(who, channel, &signed)?;
            self.devices.register_key(&who.device_id, key_text).map_err(|code| denied(code, channel))
        })();
        match outcome {
            Ok(stored) => {
                if stored {
                    self.record(who, channel, Ok(()));
                }
                Ok(json!({ "registered": true }))
            }
            Err(d) => {
                self.record(who, channel, Err(d.code.to_string()));
                Err(d.to_string())
            }
        }
    }
}

/// `run`, restricted to what a paired phone may do, knowing which phone calls.
pub fn gate(run: Dispatcher, devices: Arc<dyn Devices>) -> PhoneDispatcher {
    gate_with(run, devices, Classes::from_policy())
}

/// `gate` with the given classes (tests class channels the policy doesn't yet).
pub fn gate_with(run: Dispatcher, devices: Arc<dyn Devices>, classes: Classes) -> PhoneDispatcher {
    gate_full(run, devices, classes, crate::phone_terminal::PhoneTerminals::new())
}

/// `gate` sharing `terminals` with the relay agent (`Spawn::terminals`), so
/// output reaches only attached phones and a disconnect detaches the phone:
/// what the daemon runs.
pub fn gate_shared(
    run: Dispatcher,
    devices: Arc<dyn Devices>,
    terminals: Arc<crate::phone_terminal::PhoneTerminals>,
) -> PhoneDispatcher {
    gate_full(run, devices, Classes::from_policy(), terminals)
}

/// `gate_with` and `gate_shared` in one.
pub fn gate_full(
    run: Dispatcher,
    devices: Arc<dyn Devices>,
    classes: Classes,
    terminals: Arc<crate::phone_terminal::PhoneTerminals>,
) -> PhoneDispatcher {
    let detach = run.clone();
    terminals.on_device_gone(Arc::new(move |device: String| {
        // The computer forgets the phone as a viewer of every terminal.
        let run = detach.clone();
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            rt.spawn(async move {
                let _ = run("terminal:detach".to_string(), json!([null, device])).await;
            });
        }
    }));
    let gate = Arc::new(Gate { run, devices, classes, seen: Mutex::default(), terminals });
    Arc::new(move |who: PhoneCall, channel: String, args: Value| {
        let gate = gate.clone();
        Box::pin(async move { gate.call(who, channel, args).await })
    })
}

#[cfg(test)]
mod tests {

    /// `machine:summary` (2026-10-24): no arguments; the view pins the top-level
    /// keys and the resident model fields.
    #[test]
    fn redacts_a_machine_summary() {
        assert!(screen("machine:summary", &[]).is_ok());
        let raw = json!({ "version": "0.9.3", "platform": "darwin", "edition": "desktop", "uptimeMs": 5, "hardware": { "cpu": { "cores": 16 } },
            "live": { "cpuPct": 1 }, "gpu": { "usedMB": 1 },
            "engine": { "running": true, "startedAt": 1, "resident": [{ "id": "m", "name": "M", "contextTokens": 8, "path": "/Users/me/m.gguf" }, "junk"], "loading": 0, "memory": { "totalMB": 1 } },
            "extra": "dropped" });
        let want = json!({ "version": "0.9.3", "platform": "darwin", "edition": "desktop", "uptimeMs": 5, "hardware": { "cpu": { "cores": 16 } },
            "live": { "cpuPct": 1 }, "gpu": { "usedMB": 1 },
            "engine": { "running": true, "startedAt": 1, "resident": [{ "id": "m", "name": "M", "contextTokens": 8 }], "loading": 0, "memory": { "totalMB": 1 } } });
        assert_eq!(redact("machine:summary", raw), want);
        assert_eq!(redact("machine:summary", Value::Null), Value::Null);
    }

    /// `session:watches` (2026-10-24): a chat id is required; the view keeps the
    /// `PHONE_WATCH_VIEW` fields, never the continuation prompt, and cuts `lastError`.
    #[test]
    fn screens_and_redacts_a_chats_watches() {
        assert!(screen("session:watches", &[json!("s1")]).is_ok());
        assert_eq!(screen("session:watches", &[json!("")]).map(|_| ()), Err(denied("value-invalid", "chat id")));
        assert_eq!(screen("session:watches", &[]).map(|_| ()), Err(denied("value-invalid", "chat id")));
        let long = "x".repeat(700);
        let got = redact(
            "session:watches",
            json!([
                { "id": "w1", "kind": "pr", "url": "https://github.com/o/r/pull/5", "status": "active", "deadlineAt": 10, "nextPollAt": 5,
                  "pending": false, "failures": 1, "lastError": long, "prompt": "secret continuation", "sessionId": "s1" },
                "junk",
                null
            ]),
        );
        let want = json!([{ "id": "w1", "kind": "pr", "url": "https://github.com/o/r/pull/5", "status": "active", "deadlineAt": 10, "nextPollAt": 5,
                            "pending": false, "failures": 1, "lastError": "x".repeat(600) }]);
        assert_eq!(got, want);
        assert_eq!(redact("session:watches", Value::Null), json!([]));
    }
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

    /// A registry holding `phone-1` with Read and Change on and no Change key.
    fn paired() -> Arc<MemDevices> {
        let devices = Arc::new(MemDevices::default());
        devices
            .devices
            .lock()
            .unwrap()
            .insert("phone-1".into(), PhoneDevice { access: DeviceAccess::default(), key: None });
        devices
    }

    fn run(calls: &Arc<Mutex<Vec<(String, Value)>>>, channel: &str, args: Value) -> Result<Value, String> {
        let gated = gate(host(calls.clone(), secrets()), paired());
        let who = PhoneCall { device_id: "phone-1".into(), proof: None };
        tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(gated(who, channel.to_string(), args))
    }

    /// A registry in memory, with a clock the test moves.
    #[derive(Default)]
    struct MemDevices {
        devices: Mutex<HashMap<String, PhoneDevice>>,
        log: Mutex<Vec<(String, Activity)>>,
        now: Mutex<f64>,
    }

    impl Devices for MemDevices {
        fn device(&self, id: &str) -> Option<PhoneDevice> {
            self.devices.lock().unwrap().get(id).cloned()
        }
        fn register_key(&self, id: &str, key: &str) -> Result<bool, &'static str> {
            let mut all = self.devices.lock().unwrap();
            let d = all.get_mut(id).ok_or("device-unknown")?;
            match &d.key {
                Some(k) if k == key => Ok(false),
                Some(_) => Err("key-mismatch"),
                None => {
                    d.key = Some(key.to_string());
                    Ok(true)
                }
            }
        }
        fn record(&self, id: &str, entry: Activity) {
            self.log.lock().unwrap().push((id.to_string(), entry));
        }
        fn now(&self) -> f64 {
            *self.now.lock().unwrap()
        }
    }

    mod io33 {
        use super::*;
        use base64::Engine;
        use p256::ecdsa::signature::Signer;
        use p256::ecdsa::{Signature, SigningKey};

        const NOW: f64 = 1_760_000_000_000.0;

        fn b64(b: &[u8]) -> String {
            base64::engine::general_purpose::STANDARD.encode(b)
        }

        fn signer(seed: u8) -> SigningKey {
            SigningKey::from_slice(&[seed; 32]).unwrap()
        }

        fn public(k: &SigningKey) -> String {
            b64(k.verifying_key().to_encoded_point(false).as_bytes())
        }

        fn proof(k: &SigningKey, device: &str, channel: &str, args: &Value, ts: i64) -> Value {
            let text = crate::proof::payload(device, channel, args, ts).unwrap();
            let sig: Signature = k.sign(text.as_bytes());
            json!({ "ts": ts, "sig": b64(&sig.to_bytes()) })
        }

        struct Rig {
            devices: Arc<MemDevices>,
            calls: Arc<Mutex<Vec<(String, Value)>>>,
            gated: PhoneDispatcher,
            rt: tokio::runtime::Runtime,
        }

        /// `tasks:list` as a read-class channel and `task:runNow` as a
        /// change-class one: the policy's own lists are empty until FA-1.
        fn rig(access: DeviceAccess, key: Option<&SigningKey>) -> Rig {
            let devices = Arc::new(MemDevices::default());
            *devices.now.lock().unwrap() = NOW;
            devices.devices.lock().unwrap().insert("phone-1".into(), PhoneDevice { access, key: key.map(public) });
            let calls: Arc<Mutex<Vec<(String, Value)>>> = Arc::default();
            let classes =
                Classes { read: vec!["tasks:list".into()], change: vec!["task:runNow".into()], ..Classes::default() };
            let gated = gate_with(host(calls.clone(), secrets()), devices.clone(), classes);
            let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
            Rig { devices, calls, gated, rt }
        }

        impl Rig {
            fn ask(&self, channel: &str, args: Value, proof: Option<Value>) -> Result<Value, String> {
                let who = PhoneCall { device_id: "phone-1".into(), proof };
                self.rt.block_on((self.gated)(who, channel.to_string(), args))
            }
            fn log(&self) -> Vec<(bool, Option<String>)> {
                self.devices.log.lock().unwrap().iter().map(|(_, a)| (a.ok, a.reason.clone())).collect()
            }
        }

        fn refused(code: &str, channel: &str) -> Result<Value, String> {
            Err(format!("Not allowed from a paired phone ({code}): {channel}"))
        }

        const ON: DeviceAccess = DeviceAccess { read: true, change: true };

        #[test]
        fn read_off_refuses_read_class_calls_only() {
            let r = rig(DeviceAccess { read: false, change: true }, None);
            assert_eq!(r.ask("tasks:list", json!([]), None), refused("read-off", "tasks:list"));
            // A channel in no class is refused, whatever the switches (fail closed).
            assert_eq!(r.ask("sessions:summaries", json!([]), None), refused("channel-denied", "sessions:summaries"));
            assert!(r.calls.lock().unwrap().is_empty());
            assert!(r.log().is_empty(), "reads are not written to the activity list");
            let r = rig(ON, None);
            assert!(r.ask("tasks:list", json!([]), None).is_ok());
        }

        #[test]
        fn change_off_refuses_and_is_logged() {
            let k = signer(1);
            let r = rig(DeviceAccess { read: true, change: false }, Some(&k));
            let args = json!(["t1"]);
            let p = proof(&k, "phone-1", "task:runNow", &args, NOW as i64);
            assert_eq!(r.ask("task:runNow", args, Some(p)), refused("change-off", "task:runNow"));
            assert!(r.calls.lock().unwrap().is_empty());
            assert_eq!(r.log(), vec![(false, Some("change-off".into()))]);
            // Read stays on.
            assert!(r.ask("tasks:list", json!([]), None).is_ok());
        }

        #[test]
        fn a_valid_proof_runs_the_change_and_logs_it() {
            let k = signer(2);
            let r = rig(ON, Some(&k));
            let args = json!(["t1"]);
            let p = proof(&k, "phone-1", "task:runNow", &args, NOW as i64 - 1000);
            assert_eq!(r.ask("task:runNow", args, Some(p)), Ok(Value::Null));
            assert_eq!(*r.calls.lock().unwrap(), vec![("task:runNow".to_string(), json!(["t1"]))]);
            let log = r.devices.log.lock().unwrap().clone();
            assert_eq!(log.len(), 1);
            assert_eq!(log[0].0, "phone-1");
            assert_eq!(log[0].1.value(), json!({ "at": NOW as i64, "channel": "task:runNow", "ok": true }));
        }

        #[test]
        fn missing_bad_and_foreign_proofs_are_refused() {
            let k = signer(3);
            let r = rig(ON, Some(&k));
            let args = json!(["t1"]);
            assert_eq!(r.ask("task:runNow", args.clone(), None), refused("proof-required", "task:runNow"));
            let junk = json!({ "ts": NOW as i64, "sig": "bm9wZQ==" });
            assert_eq!(r.ask("task:runNow", args.clone(), Some(junk)), refused("proof-invalid", "task:runNow"));
            // Signed by another key, for other args, or for another channel.
            for p in [
                proof(&signer(4), "phone-1", "task:runNow", &args, NOW as i64),
                proof(&k, "phone-1", "task:runNow", &json!(["t2"]), NOW as i64),
                proof(&k, "phone-1", "workflow:run", &args, NOW as i64),
                proof(&k, "phone-2", "task:runNow", &args, NOW as i64),
            ] {
                assert_eq!(r.ask("task:runNow", args.clone(), Some(p)), refused("proof-invalid", "task:runNow"));
            }
            assert!(r.calls.lock().unwrap().is_empty(), "nothing reached the host");
            assert_eq!(r.log().len(), 6);
            assert!(r.log().iter().all(|(ok, _)| !ok));
        }

        #[test]
        fn stale_and_future_proofs_are_refused() {
            let k = signer(5);
            let r = rig(ON, Some(&k));
            let args = json!(["t1"]);
            let at = |ts: f64| Some(proof(&k, "phone-1", "task:runNow", &args, ts as i64));
            assert_eq!(r.ask("task:runNow", args.clone(), at(NOW - 300_001.0)), refused("proof-stale", "task:runNow"));
            assert_eq!(r.ask("task:runNow", args.clone(), at(NOW + 60_001.0)), refused("proof-stale", "task:runNow"));
            assert!(r.ask("task:runNow", args.clone(), at(NOW - 300_000.0)).is_ok(), "five minutes old is still fresh");
            assert!(r.ask("task:runNow", args.clone(), at(NOW + 60_000.0)).is_ok(), "a minute of clock skew");
        }

        #[test]
        fn a_replayed_proof_is_refused() {
            let k = signer(6);
            let r = rig(ON, Some(&k));
            let args = json!(["t1"]);
            let p = proof(&k, "phone-1", "task:runNow", &args, NOW as i64);
            assert!(r.ask("task:runNow", args.clone(), Some(p.clone())).is_ok());
            assert_eq!(r.ask("task:runNow", args.clone(), Some(p)), refused("proof-replayed", "task:runNow"));
            // The same call signed again a moment later is a new request.
            let again = proof(&k, "phone-1", "task:runNow", &args, NOW as i64 + 1);
            assert!(r.ask("task:runNow", args, Some(again)).is_ok());
            assert_eq!(r.calls.lock().unwrap().len(), 2);
            assert_eq!(r.log(), vec![(true, None), (false, Some("proof-replayed".into())), (true, None)]);
        }

        #[test]
        fn a_change_needs_a_registered_key_and_a_known_device() {
            let k = signer(7);
            let r = rig(ON, None);
            let args = json!(["t1"]);
            let p = proof(&k, "phone-1", "task:runNow", &args, NOW as i64);
            assert_eq!(r.ask("task:runNow", args.clone(), Some(p.clone())), refused("key-missing", "task:runNow"));
            r.devices.devices.lock().unwrap().clear(); // revoked
            assert_eq!(r.ask("task:runNow", args.clone(), Some(p)), refused("device-unknown", "task:runNow"));
            assert_eq!(r.ask("tasks:list", json!([]), None), refused("device-unknown", "tasks:list"));
        }

        #[test]
        fn a_classed_channel_off_the_allowlist_is_still_refused() {
            let devices = Arc::new(MemDevices::default());
            devices.devices.lock().unwrap().insert("phone-1".into(), PhoneDevice { access: ON, key: None });
            let calls: Arc<Mutex<Vec<(String, Value)>>> = Arc::default();
            let classes =
                Classes { read: vec!["file:read".into()], change: vec!["file:write".into()], ..Classes::default() };
            let gated = gate_with(host(calls.clone(), secrets()), devices.clone(), classes);
            let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
            for c in ["file:read", "file:write"] {
                let who = PhoneCall { device_id: "phone-1".into(), proof: None };
                assert_eq!(rt.block_on(gated(who, c.into(), json!([]))), refused("channel-denied", c));
            }
            assert!(calls.lock().unwrap().is_empty());
        }

        #[test]
        fn a_refused_screen_and_a_failed_call_are_logged_with_their_reason() {
            let k = signer(8);
            let r = rig(ON, Some(&k));
            // task:runNow needs a task id: the screen refuses an empty one.
            let args = json!([""]);
            let p = proof(&k, "phone-1", "task:runNow", &args, NOW as i64);
            assert!(r.ask("task:runNow", args, Some(p)).is_err());
            assert_eq!(r.log(), vec![(false, Some("value-invalid".into()))]);
            assert_eq!(reason_of("disk full"), "failed");
        }

        #[test]
        fn registers_a_key_once_signed_by_that_key() {
            let k = signer(9);
            let r = rig(ON, None);
            let key = public(&k);
            let args = json!([key]);
            let p = proof(&k, "phone-1", "device:registerKey", &args, NOW as i64);
            assert_eq!(r.ask("device:registerKey", args.clone(), Some(p)), Ok(json!({ "registered": true })));
            assert_eq!(r.devices.device("phone-1").unwrap().key, Some(key.clone()));
            assert!(r.calls.lock().unwrap().is_empty(), "answered by the gate, not the host");
            // The same key again is fine; a different one is refused until the phone pairs again.
            let p = proof(&k, "phone-1", "device:registerKey", &args, NOW as i64 + 1);
            assert!(r.ask("device:registerKey", args, Some(p)).is_ok());
            let other = signer(10);
            let args = json!([public(&other)]);
            let p = proof(&other, "phone-1", "device:registerKey", &args, NOW as i64);
            assert_eq!(r.ask("device:registerKey", args, Some(p)), refused("key-mismatch", "device:registerKey"));
            assert_eq!(r.log(), vec![(true, None), (false, Some("key-mismatch".into()))]);
        }

        #[test]
        fn refuses_a_key_the_phone_does_not_hold() {
            let r = rig(ON, None);
            let args = json!([public(&signer(11))]);
            let p = proof(&signer(12), "phone-1", "device:registerKey", &args, NOW as i64);
            assert_eq!(
                r.ask("device:registerKey", args.clone(), Some(p)),
                refused("proof-invalid", "device:registerKey")
            );
            assert_eq!(r.ask("device:registerKey", args, None), refused("proof-required", "device:registerKey"));
            assert_eq!(
                r.ask("device:registerKey", json!(["AAAA"]), None),
                refused("key-invalid", "device:registerKey")
            );
            assert_eq!(r.devices.device("phone-1").unwrap().key, None);
        }

        #[test]
        fn git_goes_through_the_policy_classes() {
            let k = signer(13);
            let devices = Arc::new(MemDevices::default());
            *devices.now.lock().unwrap() = NOW;
            let access = DeviceAccess { read: false, change: true };
            devices.devices.lock().unwrap().insert("phone-1".into(), PhoneDevice { access, key: Some(public(&k)) });
            let calls: Arc<Mutex<Vec<(String, Value)>>> = Arc::default();
            let gated = gate(host(calls.clone(), secrets()), devices.clone());
            let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
            let ask = |channel: &str, args: Value, proof: Option<Value>| {
                let who = PhoneCall { device_id: "phone-1".into(), proof };
                rt.block_on(gated(who, channel.to_string(), args))
            };
            // Read is off: a diff is refused before the computer runs anything.
            assert_eq!(ask("git:diff", json!(["session:s1"]), None), refused("read-off", "git:diff"));
            // Change is on: a signed push reaches the computer with only the checked fields.
            let args = json!(["session:s1", { "setUpstream": true }]);
            let p = proof(&k, "phone-1", "git:push", &args, NOW as i64);
            assert!(ask("git:push", args, Some(p)).is_ok());
            // The model-written message is a Change: no proof, no tokens spent.
            assert_eq!(
                ask("git:commitMessage", json!(["session:s1"]), None),
                refused("proof-required", "git:commitMessage")
            );
            // A saved folder's id, even signed, is refused by the screen.
            let args = json!(["w1", ["a.txt"]]);
            let p = proof(&k, "phone-1", "git:stage", &args, NOW as i64);
            assert_eq!(
                ask("git:stage", args, Some(p)),
                Err("Not allowed from a paired phone (value-invalid): chat folder".into())
            );
            assert_eq!(
                *calls.lock().unwrap(),
                vec![("git:push".to_string(), json!(["session:s1", { "setUpstream": true }]))]
            );
            assert_eq!(
                r_log(&devices),
                vec![(true, None), (false, Some("proof-required".into())), (false, Some("value-invalid".into()))]
            );
        }

        fn r_log(devices: &MemDevices) -> Vec<(bool, Option<String>)> {
            devices.log.lock().unwrap().iter().map(|(_, a)| (a.ok, a.reason.clone())).collect()
        }

        #[test]
        fn files_and_logs_go_through_the_policy_classes() {
            let k = signer(14);
            let devices = Arc::new(MemDevices::default());
            *devices.now.lock().unwrap() = NOW;
            let access = DeviceAccess { read: true, change: true };
            devices.devices.lock().unwrap().insert("phone-1".into(), PhoneDevice { access, key: Some(public(&k)) });
            let calls: Arc<Mutex<Vec<(String, Value)>>> = Arc::default();
            let gated = gate(host(calls.clone(), secrets()), devices.clone());
            let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
            let ask = |channel: &str, args: Value, proof: Option<Value>| {
                let who = PhoneCall { device_id: "phone-1".into(), proof };
                rt.block_on(gated(who, channel.to_string(), args))
            };
            let set = |read: bool, change: bool| {
                devices.devices.lock().unwrap().get_mut("phone-1").unwrap().access = DeviceAccess { read, change };
            };
            // A read reaches the computer with the phone's caps, not its own.
            assert!(ask("files:read", json!([{ "sessionId": "s1" }, "a.md", { "maxBytes": 1e9 }]), None).is_ok());
            // A secret file is refused before the computer is asked.
            assert_eq!(
                ask("files:read", json!([{ "sessionId": "s1" }, ".env"]), None),
                Err("Not allowed from a paired phone (value-invalid): secret file".into())
            );
            // A save needs a proof, and Change on.
            let hash = "e".repeat(64);
            let args = json!([{ "sessionId": "s1" }, "a.md", "new", { "expectHash": hash }]);
            assert_eq!(ask("files:write", args.clone(), None), refused("proof-required", "files:write"));
            let p = proof(&k, "phone-1", "files:write", &args, NOW as i64);
            assert_eq!(ask("files:write", args.clone(), Some(p)), Ok(json!({ "ok": "files:write" })));
            set(true, false);
            let p = proof(&k, "phone-1", "files:write", &args, NOW as i64 + 1);
            assert_eq!(ask("files:write", args.clone(), Some(p)), refused("change-off", "files:write"));
            // Read off refuses files and logs; Change alone does not open them.
            set(false, true);
            assert_eq!(ask("logs:list", json!([]), None), refused("read-off", "logs:list"));
            assert_eq!(ask("files:list", json!([{ "workspaceId": "w1" }]), None), refused("read-off", "files:list"));
            assert_eq!(
                *calls.lock().unwrap(),
                vec![
                    ("files:read".to_string(), json!([{ "sessionId": "s1" }, "a.md", { "maxBytes": 262_144 }])),
                    ("files:write".to_string(), json!([{ "sessionId": "s1" }, "a.md", "new", { "expectHash": hash }])),
                ]
            );
            let log: Vec<(bool, Option<String>)> =
                devices.log.lock().unwrap().iter().map(|(_, a)| (a.ok, a.reason.clone())).collect();
            assert_eq!(
                log,
                vec![(false, Some("proof-required".into())), (true, None), (false, Some("change-off".into()))]
            );
        }

        /// The policy's own classes, a session `s1` in `mode` and the computer's default `default`.
        fn policy_rig(access: DeviceAccess, key: Option<&SigningKey>, mode: Option<&str>, default: &str) -> Rig {
            let devices = Arc::new(MemDevices::default());
            *devices.now.lock().unwrap() = NOW;
            devices.devices.lock().unwrap().insert("phone-1".into(), PhoneDevice { access, key: key.map(public) });
            let calls: Arc<Mutex<Vec<(String, Value)>>> = Arc::default();
            let (seen, mode, default) = (calls.clone(), mode.map(str::to_string), default.to_string());
            let host: Dispatcher = Arc::new(move |channel: String, args: Value| {
                seen.lock().unwrap().push((channel.clone(), args));
                let out = match channel.as_str() {
                    "session:get" => match &mode {
                        Some(m) => json!({ "id": "s1", "mode": m, "messages": [] }),
                        None => json!({ "id": "s1", "messages": [] }),
                    },
                    "settings:get" | "settings:update" => json!({ "defaultChatMode": default }),
                    c => json!({ "ok": c }),
                };
                Box::pin(std::future::ready(Ok(out)))
            });
            let gated = gate(host, devices.clone());
            let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
            Rig { devices, calls, gated, rt }
        }

        fn ran(r: &Rig, channel: &str) -> usize {
            r.calls.lock().unwrap().iter().filter(|(c, _)| c == channel).count()
        }

        #[test]
        fn every_phone_channel_is_classed() {
            let classes = Classes::from_policy();
            let p = policy();
            for c in &p.channels {
                assert!(classes.of(c).is_some() || has(&p.terminal.token_channels, c), "{c} is in no class");
            }
            for c in ["chat:send", "chat:queue", "tool:approve", "chat:answer", "task:runNow", "workflow:run"] {
                assert_eq!(classes.of(c), Some(Class::Agent), "{c}");
            }
            for c in ["sessions:summaries", "session:get", "settings:get", "chat:pending", "monitor:summary"] {
                assert_eq!(classes.of(c), Some(Class::Read), "{c}");
            }
        }

        #[test]
        fn an_unclassed_channel_fails_closed() {
            // On the allowlist but in no class (a feature PR that forgot to class it): refused.
            let devices = Arc::new(MemDevices::default());
            devices.devices.lock().unwrap().insert("phone-1".into(), PhoneDevice { access: ON, key: None });
            let calls: Arc<Mutex<Vec<(String, Value)>>> = Arc::default();
            let gated = gate_with(host(calls.clone(), secrets()), devices, Classes::default());
            let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
            for c in ["chat:send", "sessions:summaries", "app:info", "settings:update"] {
                let who = PhoneCall { device_id: "phone-1".into(), proof: None };
                assert_eq!(rt.block_on(gated(who, c.into(), json!([{}]))), refused("channel-denied", c));
            }
            assert!(calls.lock().unwrap().is_empty());
        }

        #[test]
        fn change_off_stops_the_agent_and_read_off_hides_the_chats() {
            let send = json!([{ "sessionId": "s1", "text": "hi" }]);
            let r = policy_rig(DeviceAccess { read: true, change: false }, None, None, "ask");
            for (c, args) in [
                ("chat:send", send.clone()),
                ("chat:queue", json!(["s1", "hi"])),
                ("tool:approve", json!(["s1", "tc1", true])),
                ("chat:answer", json!(["s1", "q1", {}])),
                ("task:runNow", json!(["t1"])),
                ("workflow:run", json!(["w1"])),
                ("session:setOptions", json!(["s1", { "title": "x" }])),
                ("settings:update", json!([{ "chatPaneAction": "delete" }])),
            ] {
                assert_eq!(r.ask(c, args, None), refused("change-off", c));
            }
            assert!(r.calls.lock().unwrap().is_empty());
            assert_eq!(r.log().len(), 8);
            assert!(r.ask("session:get", json!(["s1"]), None).is_ok(), "Read stays on");
            assert!(r.ask("app:info", json!([]), None).is_ok());
            let r = policy_rig(DeviceAccess { read: false, change: true }, None, None, "ask");
            for c in ["sessions:summaries", "session:get", "settings:get", "chat:pending", "monitor:summary"] {
                assert_eq!(r.ask(c, json!(["s1"]), None), refused("read-off", c));
            }
            assert!(r.ask("app:info", json!([]), None).is_ok(), "open to any paired phone");
            assert!(r.ask("chat:send", send, None).is_ok(), "Change stays on");
            assert_eq!(r.log(), vec![(true, None)], "the send is in the activity, the reads are not");
        }

        #[test]
        fn raising_a_mode_needs_a_proof() {
            let k = signer(15);
            // The chat has no mode of its own; the computer's default is Guardrails.
            let r = policy_rig(ON, Some(&k), None, "guardrails");
            let yolo = json!(["s1", { "mode": "yolo" }]);
            assert_eq!(
                r.ask("session:setOptions", yolo.clone(), None),
                refused("proof-required", "session:setOptions")
            );
            assert_eq!(ran(&r, "session:setOptions"), 0);
            let p = proof(&k, "phone-1", "session:setOptions", &yolo, NOW as i64);
            assert!(r.ask("session:setOptions", yolo.clone(), Some(p.clone())).is_ok());
            assert_eq!(ran(&r, "session:setOptions"), 1);
            // The same proof again is a replay.
            assert_eq!(r.ask("session:setOptions", yolo, Some(p)), refused("proof-replayed", "session:setOptions"));
            // Keeping or lowering the mode needs none.
            for m in ["guardrails", "ask"] {
                assert!(r.ask("session:setOptions", json!(["s1", { "mode": m }]), None).is_ok(), "{m}");
            }
            // The default: Ask to Guardrails is a raise from a computer whose default is Ask.
            let r = policy_rig(ON, Some(&k), Some("yolo"), "ask");
            let raise = json!([{ "defaultChatMode": "guardrails" }]);
            assert_eq!(r.ask("settings:update", raise.clone(), None), refused("proof-required", "settings:update"));
            let p = proof(&k, "phone-1", "settings:update", &raise, NOW as i64);
            assert!(r.ask("settings:update", raise, Some(p)).is_ok());
            // A chat already in YOLO may be set to Guardrails with no proof.
            assert!(r.ask("session:setOptions", json!(["s1", { "mode": "guardrails" }]), None).is_ok());
            // A bad mode is refused by the screen, not asked to sign.
            assert_eq!(
                r.ask("session:setOptions", json!(["s1", { "mode": "turbo" }]), None),
                Err("Not allowed from a paired phone (value-invalid): mode".into())
            );
        }

        #[test]
        fn screens_a_chat_effort() {
            assert!(screen("session:setOptions", &[json!("s1"), json!({ "effort": "xhigh" })]).is_ok());
            for bad in [json!("ludicrous"), json!(3)] {
                assert_eq!(
                    screen("session:setOptions", &[json!("s1"), json!({ "effort": bad })]).err(),
                    Some(denied("value-invalid", "effort"))
                );
            }
        }

        #[test]
        fn reads_switches_from_a_device_record() {
            assert_eq!(DeviceAccess::of(&json!({ "id": "p" })), ON);
            assert_eq!(DeviceAccess::of(&json!({ "access": {} })), ON);
            assert_eq!(
                DeviceAccess::of(&json!({ "access": { "change": false } })),
                DeviceAccess { read: true, change: false }
            );
            assert_eq!(
                DeviceAccess::of(&json!({ "access": { "read": false, "change": "no" } })),
                DeviceAccess { read: false, change: true }
            );
        }

        #[test]
        fn the_policy_has_the_io33_pieces() {
            let p = policy();
            // FA-2 (git) was the first feature to class its channels; FA-3 / FA-6 (terminals) followed.
            assert!(p.read_channels.iter().any(|c| c == "git:diff"));
            assert!(p.change_channels.iter().any(|c| c == "git:commitMessage"), "it spends model tokens");
            for c in ["terminals:list", "terminal:tail", "ssh:hosts"] {
                assert!(p.read_channels.iter().any(|r| r == c), "{c}");
            }
            for c in ["terminal:create", "ssh:open", "terminal:signal", "terminal:close"] {
                assert!(p.change_channels.iter().any(|r| r == c), "{c}");
            }
            // FA-1 and FA-5 (files and logs): saving a file is the only Change among them.
            for c in ["files:list", "files:search", "files:read", "logs:list", "logs:read"] {
                assert!(has(&p.read_channels, c), "{c}");
            }
            assert!(has(&p.change_channels, "files:write"));
            for c in p.read_channels.iter().chain(&p.change_channels) {
                assert!(!has(&p.read_channels, c) || !has(&p.change_channels, c), "{c} is in both classes");
            }
            assert_eq!((p.proof_max_age_ms, p.proof_max_ahead_ms), (300_000.0, 60_000.0));
            assert_eq!(p.key_channel, "device:registerKey");
            assert_eq!(p.activity_limit, 200);
            for c in p.read_channels.iter().chain(&p.change_channels) {
                assert!(channel_allowed(c), "{c} is classed but a phone may not call it");
            }
        }
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
            "terminal:run",
            "terminal:snapshot",
            "terminals:list:native",
            "file:write",
            "workspace:addByPath",
            "workspace:remove",
            "voice:install",
            "connector:connect",
            "mcp:status",
            "task:create",
            "task:delete",
            "workflow:update",
            "pr:continueStack",
            "pr:linkStack",
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
    fn a_phone_may_pick_yolo_with_a_proof() {
        // The default is Ask here: YOLO is a raise, so a plain call is refused.
        let calls = Arc::default();
        assert_eq!(
            run(&calls, "settings:update", json!([{ "defaultChatMode": "yolo" }])),
            Err("Not allowed from a paired phone (proof-required): settings:update".into())
        );
        assert_eq!(
            run(&calls, "session:setOptions", json!(["s1", { "mode": "yolo" }])),
            Err("Not allowed from a paired phone (proof-required): session:setOptions".into())
        );
        // Lowering or keeping the mode needs none.
        assert!(run(&calls, "settings:update", json!([{ "defaultChatMode": "ask" }])).is_ok());
        assert!(run(&calls, "session:setOptions", json!(["s1", { "mode": "ask", "title": "t" }])).is_ok());
        let seen: Vec<String> = calls.lock().unwrap().iter().map(|(c, _)| c.clone()).collect();
        assert_eq!(seen.iter().filter(|c| *c == "session:setOptions").count(), 1, "{seen:?}");
        assert_eq!(seen.iter().filter(|c| *c == "settings:update").count(), 1, "{seen:?}");
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
