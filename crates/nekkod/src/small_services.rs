//! The small services the daemon took over last (PF14 A4): stacked pull
//! requests (`pr:continueStack`, `pr:linkStack`, `nekko-workspace`'s
//! `stacks`), wiping the user's data (`data:wipe`), the app's version
//! (`app:info`), the folder picker (`workspace:add`), and the catalog
//! refresh checks (`updates:check` and their scheduler, a port of
//! `packages/host/src/update-checks.ts`). `session:watches` is in
//! `watches.rs`.
//!
//! Served only with a data directory (the desktop app and the web edition);
//! the backend learns it must not run its own update-check scheduler from
//! `NEKKOD_OWNS=update-checks`.

use crate::routes::Ctx;
use futures_util::future::BoxFuture;
use nekko_workspace::stacks::{self, StackHost};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// What the backend is told the daemon owns (`NEKKOD_OWNS`): the update-check scheduler.
pub const OWNS: &str = "update-checks";

/// The channels served here when the daemon knows the data directory.
pub const CHANNELS: &[&str] =
    &["pr:continueStack", "pr:linkStack", "data:wipe", "app:info", "updates:check", "workspace:add"];

/// How often scheduled checks run (`INTERVAL_MS`).
const INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// Let startup settle before the first check (`START_DELAY_MS`).
const START_DELAY: Duration = Duration::from_secs(8);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn arg(args: &[Value], i: usize) -> &Value {
    args.get(i).unwrap_or(&Value::Null)
}

fn text(args: &[Value], i: usize) -> String {
    nekko_js::display(arg(args, i))
}

pub async fn route(ctx: &Ctx, channel: &str, args: &[Value]) -> Result<Value, String> {
    match channel {
        "pr:continueStack" => {
            let host = DaemonStacks::new(ctx).await;
            stacks::continue_stack(&host, &text(args, 0), &text(args, 1)).await
        }
        "pr:linkStack" => {
            let host = DaemonStacks::new(ctx).await;
            Ok(stacks::link_stack(&host, &text(args, 0), &text(args, 1)).await)
        }
        "data:wipe" => wipe(ctx).await,
        "app:info" => Ok(app_info(&ctx.app.facts)),
        "updates:check" => {
            ctx.update_checks.run(ctx, true).await;
            Ok(Value::Null)
        }
        "workspace:add" => add_folder(ctx).await,
        other => Err(format!("{other} is not a small-service channel")),
    }
}

// ---- app:info ----

/// The app facts `app:info` reports: the desktop app's version (its launch
/// config) or the web edition's (`NEKKO_VERSION`), and which edition.
#[derive(Clone, Debug, Default)]
pub struct AppFacts {
    pub version: Option<String>,
    pub edition: Option<String>,
}

/// `appInfo()`: `{ version, platform, edition }`, as Electron main (desktop)
/// or the web edition's host answered it.
pub fn app_info(facts: &AppFacts) -> Value {
    let version =
        facts.version.clone().or_else(|| std::env::var("NEKKO_VERSION").ok()).unwrap_or_else(|| "0.0.0".into());
    let edition = facts.edition.clone().unwrap_or_else(|| "web".into());
    json!({ "version": version, "platform": crate::admission::platform(), "edition": edition })
}

// ---- workspace:add ----

/// `workspace:add`: the native folder picker where there is one (the desktop
/// app, through Electron main), adding the chosen folder; headless (the web
/// edition, a cancelled picker) the saved folders.
async fn add_folder(ctx: &Ctx) -> Result<Value, String> {
    match pick_folder(ctx).await? {
        Some(path) => crate::workspace::add_folder(ctx, Some(&json!(path))).await,
        None => Ok(crate::settings::current(ctx).await.get("workspaces").cloned().unwrap_or(json!([]))),
    }
}

/// The native folder picker, or `None` without one. One function on purpose:
/// it asks Electron main through the agent browser bridge for now, and moves
/// to the daemon's own dialogs when those land.
pub async fn pick_folder(ctx: &Ctx) -> Result<Option<String>, String> {
    let Some(bridge) = &ctx.app.bridge else { return Ok(None) };
    // No time limit: the user may take a while to choose.
    let res = reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap_or_default()
        .post(&bridge.0)
        .header("Authorization", format!("Bearer {}", bridge.1))
        .header("Content-Type", "application/json")
        .body(r#"{"tool":"pickFolder"}"#)
        .send()
        .await
        .map_err(|_| "The folder picker is not available.".to_string())?;
    let ok = res.status().is_success();
    let body: Value = res.json().await.unwrap_or(Value::Null);
    if !ok {
        // An older desktop app's bridge does not know the request: no picker.
        return Ok(None);
    }
    Ok(body.get("path").and_then(Value::as_str).filter(|p| !p.is_empty()).map(str::to_string))
}

// ---- data:wipe ----

/// `wipeAllData()`: every chat (with its command log, through the host's log
/// queue as `sessions:clear` does), every memory note, the usage and reply
/// logs, the limit snapshots, and the settings back to their defaults. The
/// daemon's own services stop first so nothing writes back what was wiped:
/// its running turns, compactions, image turns and background processes.
/// Other files (tokens, tasks, remote access) stay, as in the TS host.
async fn wipe(ctx: &Ctx) -> Result<Value, String> {
    let Some(store) = ctx.sessions.clone() else { return Err("data:wipe needs the data directory".into()) };
    let data_dir = store.dir().parent().map(std::path::Path::to_path_buf).ok_or("no data directory")?;
    // Stop what could write a chat back: turns, their admission, compactions,
    // image turns, and the processes the agent started.
    for id in crate::routes::running_chats(ctx).await {
        let _ = crate::routes::stop_chat(ctx, &id).await;
        ctx.compactions.cancel(&id);
    }
    ctx.turns.processes.kill_all();
    // Chats, each command log first (a failure there keeps that chat).
    let backend = ctx.backend.clone();
    let runtime = tokio::runtime::Handle::current();
    let cleared = tokio::task::spawn_blocking(move || {
        store.clear_with("all", |id| runtime.block_on(backend.call("sessions:deleteAgentLog", json!([id]))).map(|_| ()))
    })
    .await
    .map_err(|e| e.to_string())?;
    let files = data_dir.clone();
    tokio::task::spawn_blocking(move || wipe_files(&files)).await.map_err(|e| e.to_string())??;
    ctx.accounts.clear(None);
    let settings = ctx.settings.as_ref().ok_or("data:wipe needs the settings store")?;
    let next = crate::settings::route(settings, "settings:reset", &[]).await?;
    cleared?;
    Ok(next)
}

/// The files `clearMemory` and `clearUsage` remove: `memory/*.md`,
/// `usage.jsonl` and `replies.jsonl`. `memory/` itself stays (created when
/// missing, as `memDir` does).
pub fn wipe_files(data_dir: &std::path::Path) -> Result<(), String> {
    let mem = data_dir.join("memory");
    std::fs::create_dir_all(&mem).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(&mem).map_err(|e| e.to_string())?.flatten() {
        if entry.file_name().to_string_lossy().ends_with(".md") {
            std::fs::remove_file(entry.path()).map_err(|e| e.to_string())?;
        }
    }
    for name in ["usage.jsonl", "replies.jsonl"] {
        match std::fs::remove_file(data_dir.join(name)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.to_string()),
            _ => {}
        }
    }
    Ok(())
}

// ---- the PR-stack host ----

/// The stack logic's outside world in the daemon: chats from the store,
/// folders from the settings, git without a window, GitHub through `gh` or the
/// REST API, new chats from the router (`session:create`, which keeps the
/// host's defaults).
struct DaemonStacks<'a> {
    ctx: &'a Ctx,
    settings: Value,
    token: Option<String>,
}

impl<'a> DaemonStacks<'a> {
    async fn new(ctx: &'a Ctx) -> Self {
        let settings = crate::settings::current(ctx).await;
        let token = crate::workspace::github_token(&settings);
        DaemonStacks { ctx, settings, token }
    }
}

/// `execFileSync`'s error message for a failed git: Node's "Command failed: ..." plus stderr.
fn git_error(args: &[String], stderr: &str) -> String {
    let mut msg = format!("Command failed: git {}", args.join(" "));
    if !stderr.is_empty() {
        msg.push('\n');
        msg.push_str(stderr);
    }
    msg
}

impl StackHost for DaemonStacks<'_> {
    fn session(&self, id: &str) -> Option<Value> {
        self.ctx.sessions.as_ref()?.get(id)
    }

    fn workspaces(&self) -> Vec<Value> {
        self.settings.get("workspaces").and_then(Value::as_array).cloned().unwrap_or_default()
    }

    fn git<'b>(&'b self, cwd: &'b str, args: &'b [String]) -> BoxFuture<'b, Result<String, String>> {
        Box::pin(async move {
            let refs: Vec<&str> = args.iter().map(String::as_str).collect();
            let out = nekko_workspace::proc::run("git", &refs, Duration::from_secs(30), Some(cwd), 1024 * 1024).await;
            if out.ok { Ok(out.stdout) } else { Err(git_error(args, &out.stderr)) }
        })
    }

    fn fetch<'b>(&'b self, cwd: &'b str, args: &'b [String]) -> BoxFuture<'b, bool> {
        Box::pin(async move {
            let refs: Vec<&str> = args.iter().map(String::as_str).collect();
            nekko_workspace::proc::run("git", &refs, Duration::from_secs(30), Some(cwd), 8 * 1024 * 1024).await.ok
        })
    }

    fn request<'b>(&'b self, path: &'b str, body: Option<&'b [Value]>) -> BoxFuture<'b, Result<Value, String>> {
        Box::pin(async move { self.ctx.workspace.prs().stack_request(path, body, self.token.as_deref()).await })
    }

    fn refresh<'b>(&'b self, url: &'b str) -> BoxFuture<'b, Value> {
        Box::pin(async move { self.ctx.workspace.prs().refresh_info(url, self.token.as_deref()).await })
    }

    fn create<'b>(&'b self, workspace_id: &'b str) -> BoxFuture<'b, Result<Value, String>> {
        // The host makes it (its defaults: execution mode, Git isolation), as `session:create` does.
        Box::pin(async move { self.ctx.backend.call("session:create", json!([workspace_id])).await })
    }

    fn save<'b>(&'b self, session: &'b mut Value) -> BoxFuture<'b, Result<(), String>> {
        Box::pin(async move {
            let store = self.ctx.sessions.clone().ok_or("PR stacks need the data directory")?;
            let mut s = session.clone();
            let saved = tokio::task::spawn_blocking(move || store.save_whole(&mut s).map(|()| s))
                .await
                .map_err(|e| e.to_string())??;
            *session = saved;
            Ok(())
        })
    }
}

// ---- updates:check ----

/// What the update checks need from outside: the settings, a provider's
/// model list, the skills catalog read live, and where changes are told.
/// [`DaemonSide`] is the real one; the golden replay scripts it.
pub trait UpdateHost: Send + Sync {
    fn settings<'a>(&'a self) -> BoxFuture<'a, Value>;
    /// `listModels(id)`: the model ids, or `None` when the call failed.
    fn list_models<'a>(&'a self, provider_id: &'a str) -> BoxFuture<'a, Option<Vec<String>>>;
    /// `refreshVaizerCatalog()`, or `None` when it failed.
    fn skills_catalog<'a>(&'a self) -> BoxFuture<'a, Option<Value>>;
    fn emit(&self, channel: &str, payload: Value);
}

/// The scheduler's memory: last-seen model ids per provider and the skills
/// shelf's signature. The first observation seeds without an event.
#[derive(Default)]
pub struct UpdateChecks {
    model_sigs: Mutex<HashMap<String, String>>,
    skills_sig: Mutex<Option<String>>,
}

/// `updateChecks(settings)`: the effective toggles `(modelLists, skills)`.
fn toggles(settings: &Value) -> (bool, bool) {
    let updates = settings.get("updates");
    let flag = |k: &str, d: bool| match updates.and_then(|u| u.get(k)) {
        None | Some(Value::Null) => d,
        Some(v) => nekko_js::truthy(Some(v)),
    };
    (flag("modelLists", true), flag("skills", false))
}

impl UpdateChecks {
    pub fn new() -> Arc<Self> {
        Arc::default()
    }

    /// `tick(manual)`: the checks the toggles leave on (all of them when
    /// manual), run together; one failing never stops the others.
    pub async fn tick(&self, host: &dyn UpdateHost, manual: bool) {
        let settings = host.settings().await;
        let (models, skills) = toggles(&settings);
        let model_check = async {
            if manual || models {
                self.check_models(host, &settings).await;
            }
        };
        let skill_check = async {
            if manual || skills {
                self.check_skills(host).await;
            }
        };
        // Both run together, as `Promise.allSettled` runs them. When both
        // answer at once the TS emits the skills change first (the model
        // check's `.catch` adds a turn of the microtask queue), so it is
        // polled first here too.
        futures_util::future::join(skill_check, model_check).await;
    }

    async fn check_models(&self, host: &dyn UpdateHost, settings: &Value) {
        let providers = settings.get("providers").and_then(Value::as_array).cloned().unwrap_or_default();
        for p in providers.iter().filter(|p| nekko_js::truthy(p.get("enabled"))) {
            let id = nekko_js::display(p.get("id").unwrap_or(&Value::Null));
            // An empty list reads as a failure: never snapshot it.
            let Some(mut ids) = host.list_models(&id).await.filter(|l| !l.is_empty()) else { continue };
            ids.sort();
            let sig = ids.join("\n");
            let prev = lock(&self.model_sigs).insert(id.clone(), sig.clone());
            if prev.is_some_and(|prev| prev != sig) {
                host.emit("models:updated", json!({ "providerId": p.get("id").cloned().unwrap_or(Value::Null) }));
            }
        }
    }

    async fn check_skills(&self, host: &dyn UpdateHost) {
        let Some(catalog) = host.skills_catalog().await else { return };
        let mut ids: Vec<String> = catalog
            .get("skills")
            .and_then(Value::as_array)
            .map(|s| s.iter().map(|s| nekko_js::display(s.get("id").unwrap_or(&Value::Null))).collect())
            .unwrap_or_default();
        ids.sort();
        let sig = ids.join("\n");
        let prev = lock(&self.skills_sig).replace(sig.clone());
        if prev.is_some_and(|prev| prev != sig) {
            host.emit("skills:updated", catalog);
        }
    }

    /// `updates:check` and the scheduled tick, in the daemon.
    pub async fn run(&self, ctx: &Ctx, manual: bool) {
        self.tick(&DaemonSide { ctx }, manual).await;
    }

    /// The scheduler: the first check 8 s after start, then every six hours.
    pub fn start(self: &Arc<Self>, ctx: Ctx) {
        let me = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(START_DELAY).await;
            let mut every = tokio::time::interval(INTERVAL);
            loop {
                every.tick().await;
                me.run(&ctx, false).await;
            }
        });
    }
}

/// The daemon's own: its settings, its providers, the Vaizer catalog it
/// keeps, and the UI's events (and the host's listeners, for the phone).
struct DaemonSide<'a> {
    ctx: &'a Ctx,
}

impl UpdateHost for DaemonSide<'_> {
    fn settings<'a>(&'a self) -> BoxFuture<'a, Value> {
        Box::pin(crate::settings::current(self.ctx))
    }

    fn list_models<'a>(&'a self, provider_id: &'a str) -> BoxFuture<'a, Option<Vec<String>>> {
        Box::pin(async move {
            let models = crate::providers::list_models(self.ctx, provider_id).await;
            let list = models.as_array()?;
            Some(list.iter().map(|m| nekko_js::display(m.get("id").unwrap_or(&Value::Null))).collect())
        })
    }

    fn skills_catalog<'a>(&'a self) -> BoxFuture<'a, Option<Value>> {
        Box::pin(async move { self.ctx.workspace.vaizer_catalog(true).await })
    }

    fn emit(&self, channel: &str, payload: Value) {
        self.ctx.hub.publish(channel, payload, false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn golden() -> Value {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/small-services.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn watch_views_match_the_ts_host() {
        let dir = std::env::temp_dir().join(format!("nekkod-watch-views-{}", std::process::id()));
        for case in golden()["watchViews"].as_array().unwrap() {
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            if let Some(file) = case["file"].as_str() {
                std::fs::write(dir.join("agent-watches.json"), file).unwrap();
            }
            let views = crate::watches::views_of(&dir.join("agent-watches.json"), case["sessionId"].as_str().unwrap());
            assert_eq!(nekko_js::stringify(&views), nekko_js::stringify(&case["views"]), "{}", case["name"]);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Every file under `dir` as the golden's tree records it.
    fn tree(dir: &Path) -> Value {
        fn walk(root: &Path, d: &Path, out: &mut Vec<(String, String)>) {
            let mut names: Vec<_> = std::fs::read_dir(d).unwrap().flatten().map(|e| e.path()).collect();
            names.sort();
            for p in names {
                let rel = p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
                if p.is_dir() {
                    out.push((format!("{rel}/"), String::new()));
                    walk(root, &p, out);
                } else {
                    let text =
                        if rel == "settings.json" { "<settings>".into() } else { std::fs::read_to_string(&p).unwrap() };
                    out.push((rel, text));
                }
            }
        }
        let mut out = Vec::new();
        walk(dir, dir, &mut out);
        // `readdirSync(...).sort()` in the TS is code-unit order per folder.
        Value::Object(out.into_iter().map(|(k, v)| (k, json!(v))).collect())
    }

    #[test]
    fn wipes_leave_what_the_ts_wipe_leaves() {
        for (i, case) in golden()["wipes"].as_array().unwrap().iter().enumerate() {
            let dir = std::env::temp_dir().join(format!("nekkod-wipe-{}-{i}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            for (p, text) in case["files"].as_object().unwrap() {
                let file = dir.join(p);
                std::fs::create_dir_all(file.parent().unwrap()).unwrap();
                std::fs::write(file, text.as_str().unwrap()).unwrap();
            }
            // The order `wipe` runs: chats (and their logs), memory and usage, settings.
            let store = nekko_store::SessionStore::new(&dir);
            store
                .clear_with("all", |id| {
                    let _ = std::fs::remove_file(dir.join("sessions").join(format!("{id}.commands.log")));
                    Ok(())
                })
                .unwrap();
            std::fs::create_dir_all(dir.join("sessions")).unwrap();
            wipe_files(&dir).unwrap();
            let next = nekko_settings::SettingsStore::new(&dir).reset().unwrap();
            assert_eq!(next, Value::Object(nekko_settings::defaults()));
            assert_eq!(tree(&dir), case["after"], "{}", case["name"]);
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// The update-check scripts: what each step lists and emits.
    struct Script {
        step: Mutex<Value>,
        listed: Mutex<Vec<String>>,
        emitted: Mutex<Vec<Value>>,
    }

    fn base_providers() -> Value {
        json!([
            { "id": "cg", "kind": "chatgpt", "label": "ChatGPT", "baseUrl": "https://chatgpt.com/backend-api", "enabled": true },
            { "id": "off", "kind": "openai", "label": "Off", "baseUrl": "https://api.openai.com/v1", "enabled": false },
            { "id": "lm", "kind": "lmstudio", "label": "LM", "baseUrl": "http://127.0.0.1:1234/v1", "enabled": true },
        ])
    }

    impl UpdateHost for Script {
        fn settings<'a>(&'a self) -> BoxFuture<'a, Value> {
            Box::pin(async move {
                let step = lock(&self.step).clone();
                let mut s = json!({ "providers": base_providers() });
                for (k, v) in step.get("settings").and_then(Value::as_object).cloned().unwrap_or_default() {
                    s[k] = v;
                }
                s
            })
        }
        fn list_models<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Option<Vec<String>>> {
            Box::pin(async move {
                lock(&self.listed).push(id.into());
                match lock(&self.step).get("models").and_then(|m| m.get(id)) {
                    Some(Value::Null) => None,
                    Some(Value::Array(ids)) => Some(ids.iter().map(nekko_js::display).collect()),
                    _ => Some(Vec::new()),
                }
            })
        }
        fn skills_catalog<'a>(&'a self) -> BoxFuture<'a, Option<Value>> {
            Box::pin(async move {
                let ids = match lock(&self.step).get("skills") {
                    Some(Value::Null) => return None,
                    Some(Value::Array(ids)) => ids.clone(),
                    _ => Vec::new(),
                };
                let skills: Vec<Value> = ids
                    .iter()
                    .map(|id| json!({ "id": id, "name": id, "slug": id, "category": "c", "description": id, "tier": "community", "author": "a" }))
                    .collect();
                Some(json!({ "marketplace": "vaizer", "skills": skills, "source": "live" }))
            })
        }
        fn emit(&self, channel: &str, payload: Value) {
            // The TS names the events by their IpcEvents key.
            let name = match channel {
                "models:updated" => "modelsUpdated",
                "skills:updated" => "skillsUpdated",
                other => other,
            };
            lock(&self.emitted).push(json!({ "channel": name, "payload": payload }));
        }
    }

    #[tokio::test]
    async fn update_checks_match_the_ts_service() {
        for script in golden()["updateChecks"].as_array().unwrap() {
            let checks = UpdateChecks::new();
            let host = Script { step: Mutex::new(Value::Null), listed: Mutex::default(), emitted: Mutex::default() };
            for want in script["steps"].as_array().unwrap() {
                *lock(&host.step) = want.clone();
                lock(&host.listed).clear();
                lock(&host.emitted).clear();
                checks.tick(&host, want["run"] == "now").await;
                let mut got = want.as_object().unwrap().clone();
                got.insert("listed".into(), json!(lock(&host.listed).clone()));
                got.insert("emitted".into(), json!(lock(&host.emitted).clone()));
                assert_eq!(
                    nekko_js::stringify(&Value::Object(got)),
                    nekko_js::stringify(want),
                    "{} / {}",
                    script["name"],
                    want
                );
            }
        }
    }

    #[test]
    fn app_info_names_the_edition_and_platform() {
        let desktop = app_info(&AppFacts { version: Some("1.2.3".into()), edition: Some("desktop".into()) });
        assert_eq!(
            desktop,
            json!({ "version": "1.2.3", "platform": crate::admission::platform(), "edition": "desktop" })
        );
        assert_eq!(app_info(&AppFacts::default())["edition"], "web");
    }
}
