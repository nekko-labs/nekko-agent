//! The channels Electron main used to answer, now the daemon's (PF14), so
//! main is a window shell: native dialogs (`dialog:openFiles`,
//! `dialog:pickFolder`, `dialog:saveFile`, `dialog:message`), the OS shell
//! (`shell:openPath`, `shell:reveal`), the microphone permission
//! (`voice:permission`) and the updater (`update:check`, `update:download`,
//! `update:install`, with `update:event` to the UI), over `nekko-native`.
//!
//! Served only for the desktop app (`config.native`). Dialogs are owned by
//! the app's window: main reports its native handle through the bridge
//! (`{ tool: 'nativeWindow' }`) and the daemon parents the dialog to it.
//! On macOS (AppKit panels belong to their own process) and when the config
//! says `dialogs: "bridge"`, main draws them instead (`{ tool: 'dialog' }`).
//! Installing an update ends with main quitting the app (`{ tool:
//! 'quitForUpdate' }`), the one step only main can take.

use crate::config::NativeConfig;
use crate::routes::Ctx;
use nekko_native::dialogs::{self, FileOptions, MessageOptions, Parent};
use nekko_native::update::{self, Feed, Installed, Platform};
use nekko_native::{mic, semver, shell};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

pub const CHANNELS: &[&str] = &[
    "dialog:openFiles",
    "dialog:pickFolder",
    "dialog:saveFile",
    "dialog:message",
    "shell:openPath",
    "shell:reveal",
    "voice:permission",
    "update:check",
    "update:download",
    "update:install",
    "update:state",
];

/// Where the release notes are (`RELEASE_NOTES_URL`).
const NOTES_URL: &str = "https://github.com/nekko-labs/nekko-agent/releases/latest";
/// Wait before the first automatic check, as main waited.
const AUTO_CHECK_DELAY: std::time::Duration = std::time::Duration::from_secs(4);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// What was found and downloaded, between the three update calls.
#[derive(Default)]
struct Found {
    file: Option<update::Resolved>,
    downloaded: Option<PathBuf>,
}

pub struct Native {
    cfg: NativeConfig,
    platform: Platform,
    version: String,
    /// The `UpdateInfo` the UI sees (`update:event`'s payload).
    state: Mutex<Value>,
    found: Mutex<Found>,
    /// One check or download at a time, as electron-updater's promises were.
    busy: tokio::sync::Mutex<()>,
    client: reqwest::Client,
}

impl Native {
    pub fn new(cfg: NativeConfig, version: Option<String>) -> Arc<Self> {
        let version = version.unwrap_or_else(|| "0.0.0".into());
        let state = json!({ "state": "idle", "currentVersion": version, "notesUrl": NOTES_URL, "edition": "desktop" });
        Arc::new(Self {
            cfg,
            platform: Platform::current(),
            version,
            state: Mutex::new(state),
            found: Mutex::default(),
            busy: tokio::sync::Mutex::new(()),
            client: reqwest::Client::builder()
                .user_agent("nekko-agent-updater")
                .connect_timeout(std::time::Duration::from_secs(20))
                .build()
                .unwrap_or_default(),
        })
    }

    /// Dialogs drawn by main (macOS, or a test asking for no real window).
    fn dialogs_by_bridge(&self) -> bool {
        !dialogs::supported() || self.cfg.dialogs.as_deref() == Some("bridge")
    }

    // ---- update state ----

    /// `set(patch)` in update.ts: merge, then tell every window.
    fn set(&self, ctx: &Ctx, patch: Value) -> Value {
        let next = {
            let mut s = lock(&self.state);
            if let (Some(obj), Some(p)) = (s.as_object_mut(), patch.as_object()) {
                for (k, v) in p {
                    if v.is_null() {
                        obj.remove(k);
                    } else {
                        obj.insert(k.clone(), v.clone());
                    }
                }
            }
            s.clone()
        };
        ctx.hub.publish("update:event", next.clone(), false);
        next
    }

    fn current(&self) -> Value {
        lock(&self.state).clone()
    }

    fn feed(&self) -> Result<(Feed, String, Vec<String>), String> {
        if let Some(url) = &self.cfg.update_feed_url {
            return Ok((Feed::Generic { url: url.clone() }, "nekko-agent-desktop-updater".into(), Vec::new()));
        }
        let res = self.cfg.resources_path.as_deref().ok_or("No app-update.yml: the app is not packaged.")?;
        let path = std::path::Path::new(res).join("app-update.yml");
        let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let cfg = update::read_app_update_config(&text)?;
        Ok((cfg.feed, cfg.cache_dir_name, cfg.publisher_names))
    }

    fn installed(&self) -> Installed {
        Installed {
            exe_path: self.cfg.exe_path.clone(),
            resources_path: self.cfg.resources_path.clone(),
            app_image: self.cfg.app_image.clone(),
            app_pid: self.cfg.app_pid,
        }
    }

    fn cache_dir(&self, name: &str) -> PathBuf {
        if let Some(d) = &self.cfg.update_cache_dir {
            return PathBuf::from(d);
        }
        // electron-updater's getAppCacheDir()/<updaterCacheDirName>.
        let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
        let base = if cfg!(windows) {
            std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .or_else(|| home.map(|h| h.join("AppData").join("Local")))
        } else if cfg!(target_os = "macos") {
            home.map(|h| h.join("Library").join("Caches"))
        } else {
            std::env::var_os("XDG_CACHE_HOME").map(PathBuf::from).or_else(|| home.map(|h| h.join(".cache")))
        };
        base.unwrap_or_else(std::env::temp_dir).join(name)
    }

    async fn fetch_text(&self, url: &url::Url, accept: &str) -> Result<String, String> {
        let res = self.client.get(url.clone()).header("Accept", accept).send().await.map_err(|e| e.to_string())?;
        let status = res.status();
        let body = res.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("HttpError: {} \"{url}\"", status.as_u16()));
        }
        Ok(body)
    }

    /// Find the latest release's feed and the file this machine would download,
    /// and the feed file's URL (the release's other files sit beside it).
    async fn latest(&self) -> Result<(update::UpdateInfo, update::Resolved, url::Url), String> {
        let (feed, _, _) = self.feed()?;
        let arch = update::current_arch();
        let channel = update::channel_file(self.platform, arch);
        let (tag, feed_url) = match &feed {
            Feed::GitHub { owner, repo, host } => {
                // GitHub answers /releases/latest with the tag as JSON (no API rate limit).
                let latest =
                    url::Url::parse(&format!("{host}/{owner}/{repo}/releases/latest")).map_err(|e| e.to_string())?;
                let body = self.fetch_text(&latest, "application/json").await.map_err(|e| {
                    format!("Unable to find latest version on GitHub ({latest}), please ensure a production release exists: {e}")
                })?;
                let tag = serde_json::from_str::<Value>(&body)
                    .ok()
                    .and_then(|v| v.get("tag_name").and_then(Value::as_str).map(str::to_string))
                    .ok_or("No published versions on GitHub")?;
                let url = url::Url::parse(&format!("{host}/{owner}/{repo}/releases/download/{tag}/{channel}"))
                    .map_err(|e| e.to_string())?;
                (tag, url)
            }
            Feed::Generic { url } => {
                let base = url::Url::parse(&if url.ends_with('/') { url.clone() } else { format!("{url}/") })
                    .map_err(|e| e.to_string())?;
                (String::new(), base.join(&channel).map_err(|e| e.to_string())?)
            }
        };
        let text = self.fetch_text(&feed_url, "*/*").await.map_err(|e| {
            if e.contains(" 404 ") {
                format!("Cannot find {channel} in the latest release artifacts ({feed_url}): {e}")
            } else {
                e
            }
        })?;
        let info = update::parse_update_info(&text, &channel)?;
        let files = update::resolve_files(&feed, &tag, &info)?;
        let file = update::pick_download(&files, self.platform, arch, update::linux_package(&self.installed()))?;
        Ok((info, file, feed_url))
    }

    /// `checkForUpdates()`.
    pub async fn check(&self, ctx: &Ctx) -> Value {
        if !self.cfg.is_packaged && self.cfg.update_feed_url.is_none() {
            return self.set(ctx, json!({ "state": "none", "message": "Updates are available in the installed app." }));
        }
        let Ok(_busy) = self.busy.try_lock() else { return self.current() };
        self.set(ctx, json!({ "state": "checking", "version": null, "percent": null, "message": null }));
        let result = async {
            let current = semver::parse(&self.version)
                .ok_or_else(|| format!("App version is not a valid semver version: \"{}\"", self.version))?;
            let (info, file, feed_url) = self.latest().await?;
            self.fetch_claude_policy(ctx, &feed_url).await;
            let available = semver::is_update_available(&current, &info.version)?;
            Ok::<_, String>((info, file, available))
        }
        .await;
        match result {
            Ok((info, file, true)) => {
                let mut found = lock(&self.found);
                if found.file.as_ref().map(|f| &f.url) != Some(&file.url) {
                    found.downloaded = None;
                }
                found.file = Some(file);
                drop(found);
                self.set(
                    ctx,
                    json!({ "state": "available", "version": info.version, "percent": null, "message": null }),
                )
            }
            Ok((_, _, false)) => {
                self.set(ctx, json!({ "state": "none", "version": null, "percent": null, "message": null }))
            }
            Err(e) => self.set(ctx, json!({ "state": "error", "message": e })),
        }
    }

    /// The release's signed `claude-policy.json`, beside its feed file, when it
    /// has one: nekkod verifies it with the release key and applies it
    /// (claude_policy.rs). Best effort: a release without one, or one that does
    /// not verify, leaves the policy as it is.
    async fn fetch_claude_policy(&self, ctx: &Ctx, feed_url: &url::Url) {
        let Ok(url) = feed_url.join(crate::claude_policy::FEED_FILE) else { return };
        let Ok(text) = self.fetch_text(&url, "application/json").await else { return };
        match serde_json::from_str::<Value>(&text) {
            Ok(doc) => {
                if let Err(e) = ctx.claude_policy.apply_signed(&doc) {
                    eprintln!("nekkod: claude policy from {url} not applied: {e}");
                }
            }
            Err(e) => eprintln!("nekkod: claude policy from {url} is not JSON: {e}"),
        }
    }

    /// `downloadUpdate()`: only once an update is available.
    pub async fn download(&self, ctx: &Ctx) -> Value {
        if self.current()["state"] != "available" {
            return self.current();
        }
        let Some(file) = lock(&self.found).file.clone() else { return self.current() };
        let Ok(_busy) = self.busy.try_lock() else { return self.current() };
        let version = self.current()["version"].clone();
        self.set(ctx, json!({ "state": "downloading", "percent": 0 }));
        let cache_name = self.feed().map(|f| f.1).unwrap_or_else(|_| "nekko-agent-desktop-updater".into());
        let ext = update::download_ext(self.platform, update::linux_package(&self.installed()));
        let dest = self.cache_dir(&cache_name).join("pending").join(update::cache_file_name(&file, ext));
        let progress = |pct: u8| {
            // Every whole percent, as electron-updater's `download-progress`.
            self.set(ctx, json!({ "state": "downloading", "percent": pct }));
        };
        match update::download(&self.client, &file, &dest, progress).await {
            Ok(()) => {
                lock(&self.found).downloaded = Some(dest);
                self.set(ctx, json!({ "state": "downloaded", "version": version, "percent": 100, "message": null }))
            }
            Err(e) => self.set(ctx, json!({ "state": "error", "message": e })),
        }
    }

    /// `quitAndInstall()`: start the installer (detached, outliving the app),
    /// then have main quit. Errors when nothing is downloaded.
    pub async fn install(&self, ctx: &Ctx) -> Result<Value, String> {
        let (file, downloaded) = {
            let f = lock(&self.found);
            (f.file.clone(), f.downloaded.clone())
        };
        let (Some(file), Some(downloaded)) = (file, downloaded) else {
            let e = "No update filepath provided, can't quit and install".to_string();
            self.set(ctx, json!({ "state": "error", "message": e }));
            return Err(e);
        };
        let installed = self.installed();
        let publishers = self.feed().map(|f| f.2).unwrap_or_default();
        let linux = update::linux_package(&installed);
        let plan =
            update::install_plan(self.platform, linux, &installed, &downloaded, file.info.is_admin_rights_required)?;
        let path = downloaded.clone();
        tokio::task::spawn_blocking(move || update::verify_publisher(&path, &publishers))
            .await
            .map_err(|e| e.to_string())??;
        let work = downloaded.parent().map(std::path::Path::to_path_buf).unwrap_or_else(std::env::temp_dir);
        update::launch(&plan, &work)?;
        // Main quits through its own path (stopping the engine cleanly); the
        // installer waits for the app's files to be free, as NSIS's does.
        let _ = crate::native::bridge(ctx, json!({ "tool": "quitForUpdate" })).await;
        Ok(json!({ "installing": true, "plan": plan }))
    }

    /// The automatic check main used to schedule: 4 s after start, when the
    /// user turned on app update checks.
    pub fn start(self: &Arc<Self>, ctx: Ctx) {
        let me = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(AUTO_CHECK_DELAY).await;
            let s = crate::settings::current(&ctx).await;
            let app = s
                .pointer("/updates/app")
                .and_then(Value::as_bool)
                .or_else(|| s.get("autoUpdate").and_then(Value::as_bool));
            if app == Some(true) {
                me.check(&ctx).await;
            }
        });
    }

    // ---- dialogs ----

    /// The app window to own a dialog, from main.
    async fn parent(&self, ctx: &Ctx) -> Option<Parent> {
        let v = bridge(ctx, json!({ "tool": "nativeWindow" })).await.ok()?;
        let handle = v.get("handle").and_then(Value::as_str)?;
        handle.parse::<u64>().ok().filter(|h| *h != 0).map(Parent)
    }

    async fn via_bridge(&self, ctx: &Ctx, kind: &str, options: &Value) -> Result<Value, String> {
        let v = bridge(ctx, json!({ "tool": "dialog", "kind": kind, "options": options })).await?;
        Ok(v.get("result").cloned().unwrap_or(Value::Null))
    }

    pub async fn open_files(&self, ctx: &Ctx, options: &Value) -> Result<Value, String> {
        let mut o = options.clone();
        if !o.is_object() {
            o = json!({ "multiple": true });
        }
        if self.dialogs_by_bridge() {
            return self.via_bridge(ctx, "openFiles", &o).await;
        }
        let parent = self.parent(ctx).await;
        Ok(json!(dialogs::open_files(parent, FileOptions::from_value(&o)).await?))
    }

    pub async fn pick_folder(&self, ctx: &Ctx, options: &Value) -> Result<Option<String>, String> {
        if self.dialogs_by_bridge() {
            let v = self.via_bridge(ctx, "pickFolder", options).await?;
            return Ok(v.as_str().filter(|p| !p.is_empty()).map(str::to_string));
        }
        let parent = self.parent(ctx).await;
        dialogs::pick_folder(parent, FileOptions::from_value(options)).await
    }

    async fn save_file(&self, ctx: &Ctx, options: &Value) -> Result<Value, String> {
        if self.dialogs_by_bridge() {
            return self.via_bridge(ctx, "saveFile", options).await;
        }
        let parent = self.parent(ctx).await;
        Ok(json!(dialogs::save_file(parent, FileOptions::from_value(options)).await?))
    }

    async fn message(&self, ctx: &Ctx, options: &Value) -> Result<Value, String> {
        let o = MessageOptions::from_value(options)?;
        if self.dialogs_by_bridge() {
            return self.via_bridge(ctx, "message", options).await;
        }
        let parent = self.parent(ctx).await;
        Ok(json!({ "response": dialogs::message(parent, o).await? }))
    }

    pub async fn route(&self, ctx: &Ctx, channel: &str, args: &[Value]) -> Result<Value, String> {
        let arg = |i: usize| args.get(i).cloned().unwrap_or(Value::Null);
        match channel {
            "dialog:openFiles" => self.open_files(ctx, &arg(0)).await,
            "dialog:pickFolder" => Ok(json!(self.pick_folder(ctx, &arg(0)).await?)),
            "dialog:saveFile" => self.save_file(ctx, &arg(0)).await,
            "dialog:message" => self.message(ctx, &arg(0)).await,
            "shell:openPath" => shell::open_path(&nekko_js::display(&arg(0))).map(|()| Value::Null),
            "shell:reveal" => shell::reveal(&nekko_js::display(&arg(0))).map(|()| Value::Null),
            "voice:permission" => {
                let action = mic::Action::parse(&arg(0))?;
                let platform = crate::admission::platform();
                // A prompt can wait on the user; keep it off the runtime threads.
                tokio::task::spawn_blocking(move || mic::permission(action, platform)).await.map_err(|e| e.to_string())
            }
            "update:check" => Ok(self.check(ctx).await),
            "update:download" => Ok(self.download(ctx).await),
            "update:install" => self.install(ctx).await,
            "update:state" => Ok(self.current()),
            other => Err(format!("{other} is not a native channel")),
        }
    }
}

/// One request to Electron main's bridge (the agent browser bridge, which
/// main serves with the same bearer token).
pub async fn bridge(ctx: &Ctx, body: Value) -> Result<Value, String> {
    let Some((url, token)) = &ctx.app.bridge else { return Err("The desktop app is not connected.".into()) };
    let res = reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap_or_default()
        .post(url)
        .header("Authorization", format!("Bearer {token}"))
        .json(&body)
        .send()
        .await
        .map_err(|_| "The desktop app is not connected.".to_string())?;
    let ok = res.status().is_success();
    let v: Value = res.json().await.unwrap_or(Value::Null);
    if !ok {
        return Err(v
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("The desktop app refused the request.")
            .to_string());
    }
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_channel_main_answered_is_listed() {
        for c in [
            "dialog:openFiles",
            "shell:openPath",
            "voice:permission",
            "update:check",
            "update:download",
            "update:install",
        ] {
            assert!(CHANNELS.contains(&c), "{c}");
        }
    }
}
