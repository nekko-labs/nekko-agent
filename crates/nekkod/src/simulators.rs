//! Booted simulators and the chats using them (`simulators:*`, issue #2814).
//!
//! The probe is `nekko-machine`'s `simulators.rs`. This adds who is using
//! each device: every agent event of every chat type passes through
//! `turns.rs`'s `forward`, which hands tool calls and their results to
//! [`observe`]. A call that acts on a simulator (`simctl boot/install/launch`,
//! `xcodebuild -destination`, `adb -s`, `emulator -avd`, ...) is remembered
//! for ten minutes with its output. A booted device that call names (by UDID
//! or name, in the command or its output, as `simctl create` prints the new
//! UDID) is that chat's. A device that boots within two minutes of such a call
//! without being named is the newest call's. Listing, shutting down or
//! deleting devices is not using one.
//!
//! After an acting call the daemon samples every 4 s for 3 minutes so a
//! device that boots later is picked up; otherwise it samples only when the
//! window asks (`simulators:state`, cached 2 s), plus once a minute when
//! auto shutdown is on. Who used what (`simulators.json`) survives a restart,
//! so a device can read "idle 9 days".
//!
//! `simulators:updated` tells every window to read the state again; with
//! `used` it names the chat that just started on a device, so that chat can
//! open its Simulator panel.
//!
//! Desktop and Local Web UI only: none of these channels is in the phone's
//! allowlist. Screenshots are read on demand and never stored.

use crate::hub::Hub;
use base64::Engine as _;
use nekko_machine::simulators::{self as probe, Device, IosMeta, Kind};
use nekko_settings::SettingsStore;
use nekko_store::SessionStore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const CHANNELS: &[&str] =
    &["simulators:state", "simulators:shutdown", "simulators:boot", "simulators:open", "simulators:screenshot"];

/// How long an acting call is remembered.
const RECENT_MS: u64 = 10 * 60 * 1000;
/// A device that boots this long after an acting call is that call's.
const BOOT_WINDOW_MS: u64 = 2 * 60 * 1000;
/// Sampling after an acting call.
const WATCH_FOR: Duration = Duration::from_secs(180);
const WATCH_EVERY: Duration = Duration::from_secs(4);
/// The window's reads share one sample this fresh.
const STATE_TTL: Duration = Duration::from_secs(2);
/// Names and OS versions are read again this often while a device is booted.
const META_TTL: Duration = Duration::from_secs(60);
/// Auto shutdown never stops a device busier than this (percent of a core).
const AUTO_SHUTDOWN_MAX_CPU: f64 = 5.0;
/// What is kept of a call's text and output.
const TEXT_CAP: usize = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Use {
    pub session_id: String,
    /// Epoch ms.
    pub at: u64,
}

#[derive(Debug, Clone)]
struct Recent {
    session_id: String,
    call_id: String,
    at: u64,
    text: String,
}

#[derive(Default)]
struct State {
    devices: Vec<Device>,
    sampled: Option<Instant>,
    meta: HashMap<String, IosMeta>,
    meta_at: Option<Instant>,
    uses: HashMap<String, Use>,
    recent: VecDeque<Recent>,
    watch_until: Option<Instant>,
    watching: bool,
}

pub struct Simulators {
    state: Mutex<State>,
    /// One `ps` at a time.
    sampling: tokio::sync::Mutex<()>,
    hub: Hub,
    path: Option<PathBuf>,
    settings: Option<Arc<SettingsStore>>,
    sessions: Option<Arc<SessionStore>>,
}

static REGISTRY: OnceLock<Arc<Simulators>> = OnceLock::new();

/// Start the registry (main.rs), with what was recorded before.
pub fn init(data_dir: &std::path::Path, hub: Hub, settings: Arc<SettingsStore>, sessions: Arc<SessionStore>) {
    let path = data_dir.join("simulators.json");
    let uses = std::fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice::<HashMap<String, Use>>(&b).ok())
        .unwrap_or_default();
    let reg = Arc::new(Simulators {
        state: Mutex::new(State { uses, ..State::default() }),
        sampling: tokio::sync::Mutex::new(()),
        hub,
        path: Some(path),
        settings: Some(settings),
        sessions: Some(sessions),
    });
    if REGISTRY.set(reg.clone()).is_ok() {
        tokio::spawn(auto_shutdown_loop(reg));
    }
}

fn registry() -> Option<Arc<Simulators>> {
    REGISTRY.get().cloned()
}

fn now_ms() -> u64 {
    nekko_js::now_ms() as u64
}

fn lock(m: &Mutex<State>) -> std::sync::MutexGuard<'_, State> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Every string in `v`, joined, up to `cap` bytes.
fn strings(v: &Value, cap: usize, out: &mut String) {
    if out.len() >= cap {
        return;
    }
    match v {
        Value::String(s) => {
            let room = cap - out.len();
            let mut end = s.len().min(room);
            while !s.is_char_boundary(end) {
                end -= 1;
            }
            out.push_str(&s[..end]);
            out.push('\n');
        }
        Value::Array(a) => a.iter().for_each(|x| strings(x, cap, out)),
        Value::Object(o) => o.values().for_each(|x| strings(x, cap, out)),
        _ => {}
    }
}

/// `simctl` verbs that use a device. Not `list`, `shutdown`, `delete` or `erase`.
const SIMCTL_VERBS: &[&str] = &[
    "boot",
    "create",
    "clone",
    "install",
    "launch",
    "terminate",
    "io",
    "openurl",
    "spawn",
    "uninstall",
    "push",
    "privacy",
    "ui",
    "status_bar",
    "location",
    "addmedia",
    "keychain",
    "pbcopy",
    "pbpaste",
    "get_app_container",
    "listapps",
    "appinfo",
];

/// Whether a command acts on a simulator or emulator, rather than listing or
/// stopping them.
fn acts_on_simulator(command: &str) -> bool {
    let c = command.to_ascii_lowercase();
    let words: Vec<&str> = c.split(|ch: char| ch.is_whitespace() || ch == ';' || ch == '&' || ch == '|').collect();
    let simctl = words
        .windows(2)
        .any(|w| w[0].ends_with("simctl") && SIMCTL_VERBS.contains(&w[1].trim_matches(|ch| ch == '"' || ch == '\'')));
    let xcodebuild = c.contains("xcodebuild") && c.contains("-destination") && c.contains("simulator");
    let adb = words.iter().any(|w| w.ends_with("adb")) && !c.contains("emu kill") && !c.contains("adb devices");
    let emulator = words.iter().any(|w| w.ends_with("emulator")) && (c.contains("-avd") || c.contains(" @"));
    const RUNNERS: &[&str] = &[
        "open -a simulator",
        "flutter run",
        "flutter test integration",
        "expo run:ios",
        "expo run:android",
        "react-native run-ios",
        "react-native run-android",
        "maestro test",
        "detox test",
        "ios-evidence",
    ];
    simctl || xcodebuild || adb || emulator || RUNNERS.iter().any(|r| c.contains(r))
}

/// Whether `text` names `needle` as a whole word (not inside a longer name).
fn names(text: &str, needle: &str) -> bool {
    if needle.len() < 4 {
        return false;
    }
    let (t, n) = (text.to_ascii_lowercase(), needle.to_ascii_lowercase());
    let word = |c: Option<char>| c.is_some_and(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.');
    let mut from = 0;
    while let Some(i) = t[from..].find(&n) {
        let start = from + i;
        let end = start + n.len();
        if !word(t[..start].chars().next_back()) && !word(t[end..].chars().next()) {
            return true;
        }
        from = start + 1;
        while !t.is_char_boundary(from) {
            from += 1;
        }
    }
    false
}

/// Whether `text` names this device (its UDID, name, AVD or adb serial).
fn mentions(text: &str, d: &Device) -> bool {
    if d.kind == Kind::Ios && text.to_ascii_uppercase().contains(&d.id) {
        return true;
    }
    if names(text, &d.id) || (d.name != d.id && names(text, &d.name)) {
        return true;
    }
    d.serial.as_deref().is_some_and(|s| names(text, s))
}

/// `simctl <verb> booted`: simctl picks a booted device itself.
fn says_booted(text: &str) -> bool {
    let c = text.to_ascii_lowercase();
    c.contains("simctl") && c.split_whitespace().any(|w| w.trim_matches(|ch| ch == '"' || ch == '\'') == "booted")
}

/// Who started on which device since the last look: the devices now booted,
/// the ids booted at the last look, the acting calls remembered (oldest
/// first), and what was recorded. Changes `uses` and answers the new ones.
fn attribute(
    devices: &[Device],
    before: &HashSet<String>,
    recent: &VecDeque<Recent>,
    uses: &mut HashMap<String, Use>,
    now: u64,
) -> Vec<(String, Use)> {
    let mut fresh = Vec::new();
    let newest_ios = devices.iter().filter(|d| d.kind == Kind::Ios).min_by_key(|d| d.up_secs).map(|d| d.id.clone());
    for d in devices {
        let since = uses.get(&d.id).map_or(0, |u| u.at);
        let named =
            recent.iter().rev().filter(|r| r.at > since).find(|r| {
                mentions(&r.text, d) || (says_booted(&r.text) && newest_ios.as_deref() == Some(d.id.as_str()))
            });
        let booted_at = now.saturating_sub(d.up_secs * 1000);
        let unnamed = || {
            (since == 0 && !before.contains(&d.id) && d.up_secs * 1000 < RECENT_MS)
                .then(|| recent.iter().rev().find(|r| r.at <= booted_at + 5_000 && booted_at <= r.at + BOOT_WINDOW_MS))
                .flatten()
        };
        if let Some(r) = named.or_else(unnamed) {
            let u = Use { session_id: r.session_id.clone(), at: r.at.max(since + 1) };
            uses.insert(d.id.clone(), u.clone());
            fresh.push((d.id.clone(), u));
        }
    }
    fresh
}

impl Simulators {
    #[cfg(test)]
    fn bare() -> Simulators {
        Simulators {
            state: Mutex::new(State::default()),
            sampling: tokio::sync::Mutex::new(()),
            hub: Hub::new(),
            path: None,
            settings: None,
            sessions: None,
        }
    }

    /// The booted devices, sampled again when the last sample is older than `ttl`.
    async fn sample(&self, ttl: Duration) -> Vec<Device> {
        let _one = self.sampling.lock().await;
        {
            let s = lock(&self.state);
            if s.sampled.is_some_and(|t| t.elapsed() < ttl) {
                return s.devices.clone();
            }
        }
        let rows = probe::process_table().await;
        let ios: Vec<String> = rows
            .iter()
            .filter(|r| r.command.split_whitespace().next().is_some_and(|w| w.ends_with("launchd_sim")))
            .filter_map(|r| r.command.split_once("/Devices/").and_then(|(_, a)| a.get(..36)).map(str::to_uppercase))
            .collect();
        let stale = {
            let s = lock(&self.state);
            !ios.is_empty()
                && (ios.iter().any(|u| !s.meta.contains_key(u)) || s.meta_at.is_none_or(|t| t.elapsed() > META_TTL))
        };
        if stale {
            let meta = probe::ios_meta().await;
            let mut s = lock(&self.state);
            s.meta = meta;
            s.meta_at = Some(Instant::now());
        }
        let (devices, fresh) = {
            let mut s = lock(&self.state);
            let devices = probe::devices_from(&rows, &s.meta);
            let before: HashSet<String> = s.devices.iter().map(|d| d.id.clone()).collect();
            let now = now_ms();
            while s.recent.front().is_some_and(|r| r.at + RECENT_MS < now) {
                s.recent.pop_front();
            }
            let State { recent, uses, .. } = &mut *s;
            let fresh = attribute(&devices, &before, recent, uses, now);
            let gone = before.iter().any(|id| !devices.iter().any(|d| &d.id == id))
                || devices.iter().any(|d| !before.contains(&d.id));
            s.devices = devices.clone();
            s.sampled = Some(Instant::now());
            (devices, (fresh, gone))
        };
        let (fresh, changed) = fresh;
        if !fresh.is_empty() {
            self.save();
        }
        for (id, u) in &fresh {
            self.hub.publish(
                "simulators:updated",
                json!({ "used": { "deviceId": id, "sessionId": u.session_id, "at": u.at } }),
                false,
            );
        }
        if fresh.is_empty() && changed {
            self.hub.publish("simulators:updated", json!({}), false);
        }
        devices
    }

    fn save(&self) {
        let Some(path) = &self.path else { return };
        let uses = lock(&self.state).uses.clone();
        if let Ok(bytes) = serde_json::to_vec_pretty(&uses) {
            let tmp = path.with_extension("json.tmp");
            if std::fs::write(&tmp, bytes).is_ok() {
                let _ = std::fs::rename(&tmp, path);
            }
        }
    }

    /// A tool call or its result in chat `session_id`.
    fn observe(self: &Arc<Self>, session_id: &str, event: &Value) {
        let kind = event.get("type").and_then(Value::as_str);
        let now = now_ms();
        let mut fresh = Vec::new();
        let watch = {
            let mut s = lock(&self.state);
            match kind {
                Some("tool_call") => {
                    let call = event.get("call").unwrap_or(&Value::Null);
                    let mut text = String::new();
                    strings(call.get("input").unwrap_or(&Value::Null), TEXT_CAP, &mut text);
                    if !acts_on_simulator(&text) {
                        return;
                    }
                    let call_id = call.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
                    s.recent.push_back(Recent { session_id: session_id.into(), call_id, at: now, text: text.clone() });
                    while s.recent.len() > 64 {
                        s.recent.pop_front();
                    }
                    // A device already booted that the call names is this chat's now.
                    let State { devices, uses, .. } = &mut *s;
                    for d in devices.iter().filter(|d| mentions(&text, d)) {
                        let u = Use { session_id: session_id.into(), at: now };
                        uses.insert(d.id.clone(), u.clone());
                        fresh.push((d.id.clone(), u));
                    }
                }
                Some("tool_result") => {
                    let id = event.get("toolCallId").or_else(|| event.pointer("/result/toolCallId"));
                    let Some(id) = id.and_then(Value::as_str).filter(|i| !i.is_empty()) else { return };
                    let Some(r) = s.recent.iter_mut().rev().find(|r| r.call_id == id) else { return };
                    // The output can name the device (`simctl create` prints the new UDID).
                    let mut text = std::mem::take(&mut r.text);
                    strings(event, TEXT_CAP * 2, &mut text);
                    r.text = text;
                }
                _ => return,
            }
            let until = Instant::now() + WATCH_FOR;
            s.watch_until = Some(until);
            !std::mem::replace(&mut s.watching, true)
        };
        if !fresh.is_empty() {
            self.save();
            for (id, u) in fresh {
                self.hub.publish(
                    "simulators:updated",
                    json!({ "used": { "deviceId": id, "sessionId": u.session_id, "at": u.at } }),
                    false,
                );
            }
        }
        if watch {
            let me = self.clone();
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(WATCH_EVERY).await;
                    me.sample(Duration::ZERO).await;
                    let mut s = lock(&me.state);
                    if s.watch_until.is_none_or(|t| Instant::now() >= t) {
                        s.watching = false;
                        break;
                    }
                }
            });
        }
    }

    fn title(&self, session_id: &str) -> Option<String> {
        let meta = self.sessions.as_ref()?.meta(session_id)?;
        meta.get("title").and_then(Value::as_str).filter(|t| !t.trim().is_empty()).map(str::to_string)
    }

    fn auto_shutdown_minutes(&self) -> Option<u64> {
        let settings = self.settings.as_ref()?.shared();
        settings.get("simulatorAutoShutdownMinutes").and_then(Value::as_f64).filter(|m| *m >= 1.0).map(|m| m as u64)
    }

    async fn state(&self) -> Value {
        let devices = self.sample(STATE_TTL).await;
        let uses = lock(&self.state).uses.clone();
        let list: Vec<Value> = devices
            .iter()
            .map(|d| {
                let mut v = serde_json::to_value(d).unwrap_or(Value::Null);
                if let Some(u) = uses.get(&d.id) {
                    v["lastUse"] = json!({ "sessionId": u.session_id, "at": u.at, "title": self.title(&u.session_id) });
                }
                v["canOpen"] = json!(d.kind == Kind::Ios);
                v
            })
            .collect();
        json!({ "devices": list, "sampledAt": now_ms(), "autoShutdownMinutes": self.auto_shutdown_minutes() })
    }

    async fn find(&self, id: &str, ttl: Duration) -> Result<Device, String> {
        self.sample(ttl)
            .await
            .into_iter()
            .find(|d| d.id == id)
            .ok_or_else(|| "That simulator is not running any more".to_string())
    }

    fn forget_sample(&self) {
        lock(&self.state).sampled = None;
    }
}

/// From `turns.rs`'s `forward`: every agent event of chat `session_id`.
pub fn observe(session_id: &str, event: &Value) {
    if !matches!(event.get("type").and_then(Value::as_str), Some("tool_call" | "tool_result")) {
        return;
    }
    if let Some(reg) = registry() {
        reg.observe(session_id, event);
    }
}

/// Once a minute, when `simulatorAutoShutdownMinutes` is set: shut down a
/// device an agent used, that no agent has touched for that long and that is
/// nearly idle. Devices no agent used (one a person booted) are left alone.
async fn auto_shutdown_loop(reg: Arc<Simulators>) {
    loop {
        tokio::time::sleep(Duration::from_secs(60)).await;
        let Some(minutes) = reg.auto_shutdown_minutes() else { continue };
        let devices = reg.sample(STATE_TTL).await;
        let uses = lock(&reg.state).uses.clone();
        let now = now_ms();
        let mut stopped = false;
        for d in devices.iter().filter(|d| d.cpu_pct < AUTO_SHUTDOWN_MAX_CPU) {
            let Some(u) = uses.get(&d.id) else { continue };
            if now.saturating_sub(u.at) < minutes * 60_000 {
                continue;
            }
            match probe::shutdown(d).await {
                Ok(()) => {
                    eprintln!("nekkod: shut down idle simulator {} after {minutes} min", d.name);
                    stopped = true;
                }
                Err(e) => eprintln!("nekkod: auto shutdown of {} failed: {e}", d.name),
            }
        }
        if stopped {
            reg.forget_sample();
            reg.hub.publish("simulators:updated", json!({}), false);
        }
    }
}

/// The devices a quitting daemon stops: every booted one an agent used. A
/// device no agent touched (one a person booted) is left running, as auto
/// shutdown leaves it.
fn used_by_agents<'a>(devices: &'a [Device], uses: &HashMap<String, Use>) -> Vec<&'a Device> {
    devices.iter().filter(|d| uses.contains_key(&d.id)).collect()
}

/// On a graceful shutdown (main.rs): shut down every booted simulator and
/// emulator an agent used, all at once, waiting at most `within`. The agents
/// that booted them stop with the daemon, so nothing would shut them down
/// later and they would pile up (issue #2814). Returns how many stopped.
pub async fn shutdown_agent_devices(within: Duration) -> usize {
    let Some(reg) = registry() else { return 0 };
    let work = async {
        let devices = reg.sample(Duration::ZERO).await;
        let uses = lock(&reg.state).uses.clone();
        let stops = used_by_agents(&devices, &uses).into_iter().map(|d| async move {
            match probe::shutdown(d).await {
                Ok(()) => {
                    eprintln!("nekkod: shut down simulator {} on quit", d.name);
                    true
                }
                Err(e) => {
                    eprintln!("nekkod: could not shut down simulator {} on quit: {e}", d.name);
                    false
                }
            }
        });
        futures_util::future::join_all(stops).await.into_iter().filter(|ok| *ok).count()
    };
    match tokio::time::timeout(within, work).await {
        Ok(stopped) => stopped,
        Err(_) => {
            eprintln!("nekkod: simulators still shutting down after {}s; quitting anyway", within.as_secs());
            0
        }
    }
}

fn id_arg(args: &[Value]) -> Result<String, String> {
    args.first()
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "No simulator".into())
}

pub async fn route(channel: &str, args: &[Value]) -> Result<Value, String> {
    let reg = registry().ok_or("Simulators are not available")?;
    match channel {
        "simulators:state" => Ok(reg.state().await),
        "simulators:shutdown" => {
            let d = reg.find(&id_arg(args)?, STATE_TTL).await?;
            probe::shutdown(&d).await?;
            reg.forget_sample();
            reg.hub.publish("simulators:updated", json!({}), false);
            Ok(json!({ "ok": true, "canUndo": d.kind == Kind::Ios }))
        }
        "simulators:boot" => {
            probe::boot(&id_arg(args)?).await?;
            reg.forget_sample();
            reg.hub.publish("simulators:updated", json!({}), false);
            Ok(json!({ "ok": true }))
        }
        "simulators:open" => {
            let d = reg.find(&id_arg(args)?, Duration::from_secs(10)).await?;
            probe::open(&d).await?;
            Ok(json!({ "ok": true }))
        }
        "simulators:screenshot" => {
            let d = reg.find(&id_arg(args)?, Duration::from_secs(10)).await?;
            let (mime, bytes) = probe::screenshot(&d).await?;
            Ok(json!({ "mime": mime, "data": base64::engine::general_purpose::STANDARD.encode(bytes), "at": now_ms() }))
        }
        other => Err(format!("{other} is not a simulators channel")),
    }
}

#[cfg(test)]
#[path = "simulators_tests.rs"]
mod tests;
