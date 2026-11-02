//! The self-updater, replacing electron-updater, over the same release feed
//! electron-builder publishes, so the releases already out there update to
//! the next one and the next one's daemon reads the same files.
//!
//! What electron-updater does, kept here:
//! - The feed: `latest.yml` (Windows), `latest-mac.yml`, `latest-linux.yml`
//!   (`latest-linux-arm64.yml` on arm64) from the latest GitHub release
//!   (`/releases/latest`, then `/releases/download/<tag>/<file>`), or from a
//!   generic base URL; `files` (else the legacy `path` and `sha512`), each
//!   needing a checksum; spaces in names turned into dashes for GitHub.
//!   Beyond electron-updater: once a real release key is built in
//!   (`release_key.rs`), the feed is refused unless `<feed>.sig` verifies
//!   over its exact bytes (`verify_feed`).
//! - The file: the installer `.exe` (Windows), the `.zip` (macOS, arm64 files
//!   first on an arm64 Mac), the `.AppImage` (or the `.deb` when the app was
//!   installed from one), preferring the one naming this machine's arch.
//! - The version check: offered only when strictly newer (node-semver, see
//!   `semver.rs`).
//! - The download: verified against the feed's base64 SHA-512 before it is
//!   kept, into `<cache>/<updaterCacheDirName>/pending`, and reused when an
//!   earlier download of the same file still verifies.
//! - The install: Windows runs the NSIS installer with `--updated /S
//!   --force-run` (elevate.exe when the feed says admin rights are needed),
//!   checking the Authenticode publisher first when `app-update.yml` names
//!   one; macOS and Linux run a small detached script that waits for the app
//!   to exit, swaps the `.app` bundle or the AppImage (or installs the
//!   `.deb` through pkexec) and relaunches it.
//!
//! Left out: differential (blockmap) downloads, staged rollouts and
//! `minimumSystemVersion` (this app's feeds have none), prerelease channels.

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha512};
use std::path::{Path, PathBuf};

/// Where the feed lives: electron-builder's `publish` config as written to
/// `app-update.yml`, or a plain base URL.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Feed {
    /// `https://github.com/<owner>/<repo>`; `host` replaces github.com (tests).
    GitHub { owner: String, repo: String, host: String },
    /// `<url>/latest.yml`, files relative to it (electron-updater's GenericProvider).
    Generic { url: String },
}

/// What `app-update.yml` says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppUpdateConfig {
    pub feed: Feed,
    /// `updaterCacheDirName`: the cache folder electron-updater used too.
    pub cache_dir_name: String,
    /// Windows: the Authenticode subject the installer must be signed by.
    pub publisher_names: Vec<String>,
}

/// Read `app-update.yml` (`resources/app-update.yml` in a packaged app).
pub fn read_app_update_config(text: &str) -> Result<AppUpdateConfig, String> {
    let v = yaml_to_json(text)?;
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    let feed = match s("provider").as_deref() {
        Some("github") => Feed::GitHub {
            owner: s("owner").ok_or("app-update.yml names no owner")?,
            repo: s("repo").ok_or("app-update.yml names no repo")?,
            host: s("host").map(|h| format!("https://{h}")).unwrap_or_else(|| "https://github.com".into()),
        },
        Some("generic") => Feed::Generic { url: s("url").ok_or("app-update.yml names no url")? },
        other => return Err(format!("Unsupported update provider: {}", other.unwrap_or("none"))),
    };
    let publisher_names = match v.get("publisherName") {
        Some(Value::String(n)) => vec![n.clone()],
        Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).map(str::to_string).collect(),
        _ => Vec::new(),
    };
    Ok(AppUpdateConfig {
        feed,
        cache_dir_name: s("updaterCacheDirName").unwrap_or_else(|| "nekko-agent-updater".into()),
        publisher_names,
    })
}

// ---- YAML ----

fn yaml_value(y: &yaml_rust2::Yaml) -> Value {
    use yaml_rust2::Yaml;
    match y {
        Yaml::Real(r) => {
            r.parse::<f64>().ok().and_then(serde_json::Number::from_f64).map_or(Value::Null, Value::Number)
        }
        Yaml::Integer(i) => json!(i),
        Yaml::String(s) => json!(s),
        Yaml::Boolean(b) => json!(b),
        Yaml::Array(a) => Value::Array(a.iter().map(yaml_value).collect()),
        Yaml::Hash(h) => {
            let mut m = Map::new();
            for (k, v) in h {
                let key = match k {
                    Yaml::String(s) => s.clone(),
                    Yaml::Integer(i) => i.to_string(),
                    Yaml::Real(r) => r.clone(),
                    Yaml::Boolean(b) => b.to_string(),
                    _ => continue,
                };
                m.insert(key, yaml_value(v));
            }
            Value::Object(m)
        }
        _ => Value::Null,
    }
}

/// js-yaml's `load` for the documents electron-builder writes.
pub fn yaml_to_json(text: &str) -> Result<Value, String> {
    let docs = yaml_rust2::YamlLoader::load_from_str(text).map_err(|e| e.to_string())?;
    Ok(docs.first().map(yaml_value).unwrap_or(Value::Null))
}

// ---- The feed ----

/// One downloadable file in a feed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub url: String,
    pub sha512: Option<String>,
    pub sha2: Option<String>,
    pub size: Option<u64>,
    #[serde(default)]
    pub is_admin_rights_required: bool,
}

/// A parsed `latest*.yml`.
#[derive(Clone, Debug, PartialEq)]
pub struct UpdateInfo {
    pub version: String,
    pub files: Vec<FileInfo>,
    pub release_date: Option<String>,
}

/// `parseUpdateInfo` + `getFileList`.
pub fn parse_update_info(text: &str, channel_file: &str) -> Result<UpdateInfo, String> {
    let v = yaml_to_json(text)
        .map_err(|e| format!("Cannot parse update info from {channel_file} in the latest release artifacts: {e}"))?;
    if !v.is_object() {
        return Err(format!("Cannot parse update info from {channel_file} in the latest release artifacts"));
    }
    let version = match v.get("version") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    };
    let file = |f: &Value| -> Option<FileInfo> {
        Some(FileInfo {
            url: f.get("url")?.as_str()?.to_string(),
            sha512: f.get("sha512").and_then(Value::as_str).map(str::to_string),
            sha2: f.get("sha2").and_then(Value::as_str).map(str::to_string),
            size: f.get("size").and_then(Value::as_u64),
            is_admin_rights_required: f.get("isAdminRightsRequired").and_then(Value::as_bool).unwrap_or(false),
        })
    };
    let mut files: Vec<FileInfo> =
        v.get("files").and_then(Value::as_array).map(|a| a.iter().filter_map(file).collect()).unwrap_or_default();
    if files.is_empty() {
        let Some(path) = v.get("path").and_then(Value::as_str) else {
            return Err(format!("No files provided: {v}"));
        };
        files.push(FileInfo {
            url: path.to_string(),
            sha512: v.get("sha512").and_then(Value::as_str).map(str::to_string),
            sha2: v.get("sha2").and_then(Value::as_str).map(str::to_string),
            size: None,
            is_admin_rights_required: false,
        });
    }
    if let Some(f) = files.iter().find(|f| f.sha512.is_none() && f.sha2.is_none()) {
        return Err(format!("Update info doesn't contain nor sha256 neither sha512 checksum: {}", f.url));
    }
    Ok(UpdateInfo { version, files, release_date: v.get("releaseDate").and_then(Value::as_str).map(str::to_string) })
}

/// The platform the feed is read for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Windows,
    Mac,
    Linux,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Mac
        } else {
            Self::Linux
        }
    }
}

/// Node's `process.arch` for this build.
pub fn current_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        other => other,
    }
}

/// `getChannelFilename(getDefaultChannelName())`.
pub fn channel_file(platform: Platform, arch: &str) -> String {
    match platform {
        Platform::Windows => "latest.yml".into(),
        Platform::Mac => "latest-mac.yml".into(),
        Platform::Linux if arch == "x64" => "latest-linux.yml".into(),
        Platform::Linux => format!("latest-linux-{arch}.yml"),
    }
}

/// How the app was installed on Linux (`resources/package-type`); an
/// AppImage has none.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinuxPackage {
    AppImage,
    Deb,
}

/// A file resolved against the feed's location.
#[derive(Clone, Debug, PartialEq)]
pub struct Resolved {
    pub url: url::Url,
    pub info: FileInfo,
}

/// `newUrlFromBase`: resolve and keep the base's query (electron-updater
/// copies `search` over when the path has none).
fn url_from_base(path: &str, base: &url::Url) -> Result<url::Url, String> {
    let mut u = base.join(path).map_err(|e| format!("{path}: {e}"))?;
    if u.query().is_none() && base.query().is_some() {
        u.set_query(base.query());
    }
    Ok(u)
}

/// `resolveFiles`: every file's URL, for a GitHub release at `tag` or a generic base.
pub fn resolve_files(feed: &Feed, tag: &str, info: &UpdateInfo) -> Result<Vec<Resolved>, String> {
    info.files
        .iter()
        .map(|f| {
            let url = match feed {
                Feed::GitHub { owner, repo, host } => {
                    let base = url::Url::parse(&format!("{host}/")).map_err(|e| e.to_string())?;
                    let path = format!("/{owner}/{repo}/releases/download/{tag}/{}", f.url.replace(' ', "-"));
                    url_from_base(&path, &base)?
                }
                Feed::Generic { url } => {
                    let base = url::Url::parse(&with_slash(url)).map_err(|e| e.to_string())?;
                    url_from_base(&f.url, &base)?
                }
            };
            Ok(Resolved { url, info: f.clone() })
        })
        .collect()
}

fn with_slash(u: &str) -> String {
    if u.ends_with('/') { u.to_string() } else { format!("{u}/") }
}

fn ends_with_ext(r: &Resolved, ext: &str) -> bool {
    r.url.path().to_ascii_lowercase().ends_with(&format!(".{}", ext.to_ascii_lowercase()))
}

/// `findFile(files, extension, not)`.
pub fn find_file(files: &[Resolved], ext: &str, not: Option<&[&str]>, arch: &str) -> Option<Resolved> {
    if files.is_empty() {
        return None;
    }
    let mut filtered: Vec<&Resolved> = files.iter().filter(|f| ends_with_ext(f, ext)).collect();
    let by_arch = filtered.iter().position(|f| f.url.path().contains(arch) || f.info.url.contains(arch));
    if let Some(i) = by_arch {
        return Some(filtered[i].clone());
    }
    if !filtered.is_empty() {
        return Some(filtered.remove(0).clone());
    }
    match not {
        None => Some(files[0].clone()),
        Some(not) => files.iter().find(|f| !not.iter().any(|e| ends_with_ext(f, e))).cloned(),
    }
}

/// `MacUpdater.filterFilesForArch`.
pub fn filter_mac_files(files: &[Resolved], arm64_mac: bool) -> Vec<Resolved> {
    let is_arm = |f: &Resolved| f.url.path().contains("arm64") || f.info.url.contains("arm64");
    if arm64_mac && files.iter().any(is_arm) {
        return files.iter().filter(|f| is_arm(f)).cloned().collect();
    }
    files.iter().filter(|f| !is_arm(f)).cloned().collect()
}

/// The file this machine downloads, as each electron-updater updater picks it.
pub fn pick_download(
    files: &[Resolved],
    platform: Platform,
    arch: &str,
    linux: LinuxPackage,
) -> Result<Resolved, String> {
    let picked = match platform {
        Platform::Windows => find_file(files, "exe", None, arch),
        Platform::Mac => {
            let files = filter_mac_files(files, arch == "arm64");
            let zip = find_file(&files, "zip", Some(&["pkg", "dmg"]), arch);
            return zip.ok_or_else(|| "ZIP file not provided".to_string());
        }
        Platform::Linux => match linux {
            LinuxPackage::AppImage => find_file(files, "AppImage", Some(&["rpm", "deb", "pacman"]), arch),
            LinuxPackage::Deb => find_file(files, "deb", Some(&["AppImage", "rpm", "pacman"]), arch),
        },
    };
    picked.ok_or_else(|| "No files provided".to_string())
}

// ---- The feed's signature ----

/// Where a feed file's signature is published: beside it, `<file>.sig` (the
/// base64 Ed25519 signature over the feed's exact bytes, written by
/// `scripts/sign-update-feed.mjs` in the release workflow).
pub fn signature_url(feed_url: &url::Url) -> url::Url {
    let mut u = feed_url.clone();
    u.set_path(&format!("{}.sig", feed_url.path()));
    u
}

/// Check the feed's bytes against its signature before anything in it is
/// trusted. `signature` is `None` when the release has no `.sig` for it (or
/// it could not be fetched). With the placeholder key (no release key yet)
/// nothing is checked, as before signing existed.
pub fn verify_feed(key: &[u8; 32], channel_file: &str, feed: &[u8], signature: Option<&[u8]>) -> Result<(), String> {
    if crate::release_key::is_placeholder(key) {
        return Ok(());
    }
    let Some(signature) = signature else {
        return Err(format!(
            "The update feed {channel_file} is not signed ({channel_file}.sig is missing from the release), so the update was refused."
        ));
    };
    crate::release_key::verify_detached(key, feed, signature).map_err(|e| {
        format!("The update feed {channel_file} did not pass its signature check ({e}), so the update was refused.")
    })
}

// ---- Checksums ----

/// electron-builder's checksum: base64 of the SHA-512 digest.
pub fn sha512_base64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(Sha512::digest(bytes))
}

/// A running SHA-512 over a download.
#[derive(Default)]
pub struct Checksum(Sha512);

impl Checksum {
    pub fn update(&mut self, chunk: &[u8]) {
        self.0.update(chunk);
    }
    pub fn base64(self) -> String {
        base64::engine::general_purpose::STANDARD.encode(self.0.finalize())
    }
}

/// The digest of a file on disk, read in chunks.
pub fn sha512_file(path: &Path) -> std::io::Result<String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path)?;
    let mut sum = Checksum::default();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        sum.update(&buf[..n]);
    }
    Ok(sum.base64())
}

/// The error electron-updater's downloader raises on a mismatch.
pub fn checksum_error(expected: &str, actual: &str) -> String {
    format!("sha512 checksum mismatch, expected {expected}, got {actual}")
}

// ---- Download ----

/// The file name a download is kept under (`getCacheUpdateFileName`).
pub fn cache_file_name(r: &Resolved, ext: &str) -> String {
    let path = r.url.path();
    let decoded = percent_decode(path);
    let base = decoded.rsplit('/').next().unwrap_or("update").to_string();
    if base.to_ascii_lowercase().ends_with(&format!(".{}", ext.to_ascii_lowercase())) {
        base
    } else {
        format!("update.{ext}")
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && let Some(v) = s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The extension each platform downloads.
pub fn download_ext(platform: Platform, linux: LinuxPackage) -> &'static str {
    match (platform, linux) {
        (Platform::Windows, _) => "exe",
        (Platform::Mac, _) => "zip",
        (Platform::Linux, LinuxPackage::AppImage) => "AppImage",
        (Platform::Linux, LinuxPackage::Deb) => "deb",
    }
}

/// Download `r` to `dest`, verifying its SHA-512, calling `progress` with
/// whole percents as they change. An earlier download at `dest` that still
/// verifies is kept without a request.
pub async fn download(
    client: &reqwest::Client,
    r: &Resolved,
    dest: &Path,
    mut progress: impl FnMut(u8) + Send,
) -> Result<(), String> {
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;
    let expected = r.info.sha512.clone();
    if let (Some(exp), true) = (&expected, dest.is_file()) {
        let path = dest.to_path_buf();
        let have = tokio::task::spawn_blocking(move || sha512_file(&path)).await.map_err(|e| e.to_string())?;
        if have.ok().as_deref() == Some(exp.as_str()) {
            progress(100);
            return Ok(());
        }
    }
    let dir = dest.parent().ok_or("no download folder")?;
    tokio::fs::create_dir_all(dir).await.map_err(|e| e.to_string())?;
    let temp = dir.join(format!("temp-{}", dest.file_name().and_then(|n| n.to_str()).unwrap_or("update")));
    let res = nekko_net::send("updates", client.get(r.url.clone())).await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("Cannot download \"{}\", status {}", r.url, res.status().as_u16()));
    }
    let total = res.content_length().or(r.info.size).filter(|t| *t > 0);
    let mut file = tokio::fs::File::create(&temp).await.map_err(|e| e.to_string())?;
    let mut sum = Checksum::default();
    let mut got: u64 = 0;
    let mut last: Option<u8> = None;
    let mut stream = res.bytes_stream();
    let result: Result<(), String> = async {
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| e.to_string())?;
            sum.update(&chunk);
            file.write_all(&chunk).await.map_err(|e| e.to_string())?;
            got += chunk.len() as u64;
            if let Some(t) = total {
                let pct = ((got.min(t) as f64 / t as f64) * 100.0).round() as u8;
                if last != Some(pct) {
                    last = Some(pct);
                    progress(pct);
                }
            }
        }
        file.flush().await.map_err(|e| e.to_string())?;
        Ok(())
    }
    .await;
    drop(file);
    if let Err(e) = result {
        let _ = tokio::fs::remove_file(&temp).await;
        return Err(e);
    }
    let actual = sum.base64();
    if let Some(exp) = &expected
        && exp != &actual
    {
        let _ = tokio::fs::remove_file(&temp).await;
        return Err(checksum_error(exp, &actual));
    }
    let _ = tokio::fs::remove_file(dest).await;
    tokio::fs::rename(&temp, dest).await.map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dest, std::fs::Permissions::from_mode(0o755));
    }
    Ok(())
}

// ---- Install ----

/// What the app is, for installing over it.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    /// The running app's executable (`process.execPath`).
    pub exe_path: String,
    /// Electron's `process.resourcesPath` (elevate.exe, app-update.yml, package-type).
    pub resources_path: Option<String>,
    /// Linux: `$APPIMAGE`, the AppImage the app runs from.
    pub app_image: Option<String>,
    /// The Electron main process to wait for before replacing files.
    pub app_pid: Option<u32>,
}

/// What installing the downloaded update runs.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum InstallPlan {
    /// Windows: the NSIS installer (or elevate.exe with it), detached.
    Run { program: String, args: Vec<String> },
    /// macOS and Linux: a `/bin/sh` script run detached after the app exits.
    Script { script: String },
}

/// Single-quote for `/bin/sh`.
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// The `.app` bundle an executable lives in (`.../X.app/Contents/MacOS/X`).
pub fn app_bundle(exe: &Path) -> Option<PathBuf> {
    exe.ancestors().find(|p| p.extension().is_some_and(|e| e == "app")).map(Path::to_path_buf)
}

/// Where an AppImage update lands (`AppImageUpdater.doInstall`): over the
/// old file when its name has no version (the user named it), else beside it
/// under the new name.
pub fn appimage_destination(old: &Path, downloaded: &Path) -> PathBuf {
    let old_name = old.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let new_name = downloaded.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let has_version = {
        // /\d+\.\d+\.\d+/
        let b = old_name.as_bytes();
        let mut found = false;
        for i in 0..b.len() {
            let mut j = i;
            let mut groups = 0;
            loop {
                let start = j;
                while j < b.len() && b[j].is_ascii_digit() {
                    j += 1;
                }
                if j == start {
                    break;
                }
                groups += 1;
                if groups == 3 {
                    found = true;
                    break;
                }
                if j < b.len() && b[j] == b'.' {
                    j += 1;
                } else {
                    break;
                }
            }
            if found {
                break;
            }
        }
        found
    };
    if new_name == old_name || !has_version { old.to_path_buf() } else { old.with_file_name(new_name) }
}

fn wait_for_pid(pid: Option<u32>) -> String {
    match pid {
        Some(pid) => format!("while kill -0 {pid} 2>/dev/null; do sleep 0.2; done\n"),
        None => "sleep 2\n".into(),
    }
}

/// macOS: before the swap, when the running app is signed by a Developer ID
/// team, the new bundle must pass a strict `codesign` check against a
/// requirement anchored to Apple naming that same team. Otherwise the staged
/// copy is removed, the running app is reopened unchanged, and the script
/// fails. A running app with no team (a local or ad-hoc build) skips the check.
fn mac_verify_snippet(bundle: &str, staging: &str) -> String {
    format!(
        "team=$(/usr/bin/codesign -dv {bundle} 2>&1 | sed -n 's/^TeamIdentifier=//p')\n\
         if [ -n \"$team\" ] && [ \"$team\" != \"not set\" ]; then\n\
         \x20 if ! /usr/bin/codesign --verify --deep --strict \
         -R=\"anchor apple generic and certificate leaf[subject.OU] = \\\"$team\\\"\" \"$new_app\"; then\n\
         \x20   rm -rf {staging}\n\x20   /usr/bin/open -n {bundle}\n\x20   exit 1\n\x20 fi\nfi\n"
    )
}

/// How to install `downloaded` over the running app.
pub fn install_plan(
    platform: Platform,
    linux: LinuxPackage,
    installed: &Installed,
    downloaded: &Path,
    admin: bool,
) -> Result<InstallPlan, String> {
    let file = downloaded.to_string_lossy().into_owned();
    match platform {
        Platform::Windows => {
            let args = vec!["--updated".to_string(), "/S".into(), "--force-run".into()];
            let elevate = installed.resources_path.as_ref().map(|r| Path::new(r).join("elevate.exe"));
            match elevate.filter(|e| admin && e.is_file()) {
                Some(e) => Ok(InstallPlan::Run {
                    program: e.to_string_lossy().into_owned(),
                    args: std::iter::once(file).chain(args).collect(),
                }),
                None => Ok(InstallPlan::Run { program: file, args }),
            }
        }
        Platform::Mac => {
            let bundle = app_bundle(Path::new(&installed.exe_path))
                .ok_or_else(|| format!("{} is not inside an .app bundle", installed.exe_path))?;
            let staging = downloaded.with_extension("staging");
            let (b, s, z) =
                (sh_quote(&bundle.to_string_lossy()), sh_quote(&staging.to_string_lossy()), sh_quote(&file));
            let old = sh_quote(&format!("{}.old", bundle.to_string_lossy()));
            // The zip's .app is taken whatever it is named and lands at the
            // installed path, as Squirrel.Mac does: the bundle was renamed
            // (NekkoAgent.app → Nekko Agent.app), so an older install's name
            // need not match the new zip's, and keeping the path keeps the
            // Dock tile and login item pointing at the app.
            let script = format!(
                "set -e\n{wait}rm -rf {s}\nmkdir -p {s}\n/usr/bin/ditto -x -k {z} {s}\n\
                 new_app=$(find {s} -mindepth 1 -maxdepth 1 -type d -name '*.app' | head -n 1)\n\
                 test -n \"$new_app\"\n{verify}rm -rf {old}\nmv {b} {old}\n\
                 if mv \"$new_app\" {b}; then rm -rf {old}; else mv {old} {b}; exit 1; fi\n\
                 rm -rf {s}\n/usr/bin/open -n {b}\n",
                wait = wait_for_pid(installed.app_pid),
                verify = mac_verify_snippet(&b, &s),
            );
            Ok(InstallPlan::Script { script })
        }
        Platform::Linux => match linux {
            LinuxPackage::AppImage => {
                let old = installed.app_image.clone().ok_or("APPIMAGE env is not defined")?;
                if !Path::new(&old).is_absolute() || old.contains('\0') {
                    return Err(format!("APPIMAGE env is not a valid absolute path: \"{old}\""));
                }
                let dest = appimage_destination(Path::new(&old), downloaded);
                let (o, d) = (sh_quote(&old), sh_quote(&dest.to_string_lossy()));
                let script = format!(
                    "set -e\n{wait}rm -f {o}\nmv -f {f} {d}\nchmod 755 {d}\nAPPIMAGE_SILENT_INSTALL=true nohup {d} >/dev/null 2>&1 &\n",
                    wait = wait_for_pid(installed.app_pid),
                    f = sh_quote(&file),
                );
                Ok(InstallPlan::Script { script })
            }
            LinuxPackage::Deb => {
                let exe = sh_quote(&installed.exe_path);
                let script = format!(
                    "{wait}if pkexec --disable-internal-agent dpkg -i {f}; then nohup {exe} >/dev/null 2>&1 & fi\n",
                    wait = wait_for_pid(installed.app_pid),
                    f = sh_quote(&file),
                );
                Ok(InstallPlan::Script { script })
            }
        },
    }
}

/// The Linux package type next to the resources (`package-type`), as
/// electron-updater reads it; an AppImage (no file, or `$APPIMAGE` set) otherwise.
pub fn linux_package(installed: &Installed) -> LinuxPackage {
    if installed.app_image.is_some() {
        return LinuxPackage::AppImage;
    }
    let kind = installed
        .resources_path
        .as_ref()
        .and_then(|r| std::fs::read_to_string(Path::new(r).join("package-type")).ok())
        .map(|s| s.trim().to_string());
    if kind.as_deref() == Some("deb") { LinuxPackage::Deb } else { LinuxPackage::AppImage }
}

/// Windows: the installer must be signed by one of `publishers` (electron-
/// updater's `verifySignature`, through the same PowerShell call). `Ok(())`
/// when none are configured.
pub fn verify_publisher(file: &Path, publishers: &[String]) -> Result<(), String> {
    if publishers.is_empty() || !cfg!(windows) {
        return Ok(());
    }
    let data = authenticode(file)?;
    if data.get("Status").and_then(Value::as_i64) == Some(0) {
        let subject = data.pointer("/SignerCertificate/Subject").and_then(Value::as_str).unwrap_or("");
        if publishers.iter().any(|p| dn_matches(p, subject)) {
            return Ok(());
        }
    }
    Err(format!("New version is not signed by the application owner: publisherNames: {}", publishers.join(" | ")))
}

/// Windows: when the running app is itself validly Authenticode-signed, the
/// installer must be validly signed with the same certificate subject. This
/// holds whether or not `app-update.yml` names publishers; an unsigned
/// running app (a local build) skips it.
pub fn verify_same_signer(file: &Path, running_exe: &Path) -> Result<(), String> {
    if !cfg!(windows) {
        return Ok(());
    }
    // Nothing to compare against when the running executable is not a file
    // whose signature can be read (a development run).
    if !running_exe.is_file() {
        return Ok(());
    }
    let Ok(running) = authenticode(running_exe) else { return Ok(()) };
    if running.get("Status").and_then(Value::as_i64) != Some(0) {
        return Ok(());
    }
    same_signer(&running, &authenticode(file)?)
}

/// The installer's signature is valid and its signer subject is the running app's.
pub fn same_signer(running: &Value, installer: &Value) -> Result<(), String> {
    let subject = |v: &Value| v.pointer("/SignerCertificate/Subject").and_then(Value::as_str).map(str::to_string);
    let valid = installer.get("Status").and_then(Value::as_i64) == Some(0);
    match (subject(running), subject(installer)) {
        (Some(a), Some(b)) if valid && !a.is_empty() && a == b => Ok(()),
        _ => Err("New version is not signed by the same publisher as the installed app".into()),
    }
}

/// `Get-AuthenticodeSignature` for one file, as JSON.
fn authenticode(file: &Path) -> Result<Value, String> {
    let literal = file.to_string_lossy().replace('\'', "''");
    let mut cmd = std::process::Command::new("powershell.exe");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-InputFormat",
        "None",
        "-Command",
        &format!("Get-AuthenticodeSignature -LiteralPath '{literal}' | ConvertTo-Json -Compress"),
    ])
    .env_remove("PSModulePath");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().map_err(|e| format!("Cannot verify the installer's signature: {e}"))?;
    serde_json::from_slice(&out.stdout).map_err(|e| format!("Cannot verify the installer's signature: {e}"))
}

/// `parseDn` comparison: every key of a full DN must match; a bare name is the CN.
pub fn dn_matches(name: &str, subject: &str) -> bool {
    let parse = |s: &str| -> Vec<(String, String)> {
        s.split(',')
            .filter_map(|p| p.split_once('='))
            .map(|(k, v)| (k.trim().to_string(), v.trim().trim_matches('"').to_string()))
            .collect()
    };
    let subj = parse(subject);
    let get = |k: &str| subj.iter().find(|(a, _)| a == k).map(|(_, v)| v.as_str());
    let dn = parse(name);
    if dn.is_empty() { get("CN") == Some(name) } else { dn.iter().all(|(k, v)| get(k) == Some(v.as_str())) }
}

/// Start the plan, detached from the daemon so it outlives the app.
pub fn launch(plan: &InstallPlan, work_dir: &Path) -> Result<(), String> {
    match plan {
        InstallPlan::Run { program, args } => {
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                const DETACHED_PROCESS: u32 = 0x0000_0008;
                const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
                const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
                let spawn = |flags: u32| {
                    std::process::Command::new(program)
                        .args(args)
                        .current_dir(work_dir)
                        .stdin(std::process::Stdio::null())
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .creation_flags(flags)
                        .spawn()
                };
                // Out of the daemon's kill-on-close job: the installer must outlive it.
                // A job above ours that forbids breaking away refuses the flag
                // outright; then start it inside (NSIS relaunches itself anyway).
                spawn(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB)
                    .or_else(|_| spawn(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP))
                    .map(|_| ())
                    .map_err(|e| format!("Cannot run installer: {e}"))
            }
            #[cfg(not(windows))]
            {
                std::process::Command::new(program)
                    .args(args)
                    .current_dir(work_dir)
                    .spawn()
                    .map(|_| ())
                    .map_err(|e| format!("Cannot run installer: {e}"))
            }
        }
        InstallPlan::Script { script } => {
            let file = work_dir.join("install.sh");
            std::fs::create_dir_all(work_dir).map_err(|e| e.to_string())?;
            std::fs::write(&file, script).map_err(|e| e.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                let mut cmd = std::process::Command::new("/bin/sh");
                cmd.arg(&file)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null());
                // A new session: not the daemon's process group, so it survives the app.
                // SAFETY: setsid is async-signal-safe.
                unsafe {
                    cmd.pre_exec(|| {
                        libc_setsid();
                        Ok(())
                    });
                }
                cmd.spawn().map(|_| ()).map_err(|e| format!("Cannot run the update: {e}"))
            }
            #[cfg(not(unix))]
            {
                Err(format!("A script install does not run here ({})", file.display()))
            }
        }
    }
}

#[cfg(unix)]
fn libc_setsid() {
    unsafe extern "C" {
        fn setsid() -> i32;
    }
    // SAFETY: no arguments; failure (already a leader) is harmless.
    unsafe {
        setsid();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appimage_keeps_a_user_chosen_name() {
        let d = Path::new("/c/NekkoAgent-0.9.0-x86_64.AppImage");
        assert_eq!(appimage_destination(Path::new("/apps/Nekko.AppImage"), d), PathBuf::from("/apps/Nekko.AppImage"));
        assert_eq!(
            appimage_destination(Path::new("/apps/NekkoAgent-0.8.1-x86_64.AppImage"), d),
            PathBuf::from("/apps/NekkoAgent-0.9.0-x86_64.AppImage")
        );
    }

    #[test]
    fn mac_update_installs_a_renamed_bundle_at_the_installed_path() {
        let installed = Installed {
            exe_path: "/Applications/NekkoAgent.app/Contents/MacOS/NekkoAgent".into(),
            app_pid: Some(42),
            ..Default::default()
        };
        let plan = install_plan(Platform::Mac, LinuxPackage::AppImage, &installed, Path::new("/c/p/update.zip"), false);
        let Ok(InstallPlan::Script { script }) = plan else { panic!("{plan:?}") };
        assert!(script.contains("find '/c/p/update.staging' -mindepth 1 -maxdepth 1 -type d -name '*.app'"));
        assert!(script.contains("if mv \"$new_app\" '/Applications/NekkoAgent.app'; then"));
        assert!(script.ends_with("/usr/bin/open -n '/Applications/NekkoAgent.app'\n"));
        // The new bundle is checked against the running app's team before the swap.
        let check = script.find("/usr/bin/codesign --verify --deep --strict").unwrap();
        assert!(script.contains("/usr/bin/codesign -dv '/Applications/NekkoAgent.app'"));
        assert!(script.contains("anchor apple generic and certificate leaf[subject.OU]"));
        assert!(check < script.find("mv '/Applications/NekkoAgent.app'").unwrap());
    }

    #[test]
    fn an_installer_must_share_the_running_app_signer() {
        let signed =
            |subject: &str, status: i64| json!({ "Status": status, "SignerCertificate": { "Subject": subject } });
        let ours = signed("CN=Nekko Labs, O=Nekko Labs, C=JP", 0);
        assert!(same_signer(&ours, &signed("CN=Nekko Labs, O=Nekko Labs, C=JP", 0)).is_ok());
        assert!(same_signer(&ours, &signed("CN=Someone Else", 0)).is_err());
        assert!(same_signer(&ours, &signed("CN=Nekko Labs, O=Nekko Labs, C=JP", 1)).is_err());
        assert!(same_signer(&ours, &json!({ "Status": 2, "SignerCertificate": null })).is_err());
        assert!(same_signer(&json!({ "Status": 0, "SignerCertificate": { "Subject": "" } }), &signed("", 0)).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_update_script_swaps_a_differently_named_bundle() {
        let root = std::env::temp_dir().join(format!("nekko-mac-swap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (apps, src) = (root.join("Applications"), root.join("src"));
        std::fs::create_dir_all(apps.join("NekkoAgent.app/Contents/MacOS")).unwrap();
        std::fs::write(apps.join("NekkoAgent.app/old"), "").unwrap();
        std::fs::create_dir_all(src.join("Nekko Agent.app/Contents/MacOS")).unwrap();
        std::fs::write(src.join("Nekko Agent.app/new"), "").unwrap();
        let zip = root.join("update.zip");
        let zipped = std::process::Command::new("/usr/bin/ditto")
            .args(["-c", "-k", "--keepParent"])
            .arg(src.join("Nekko Agent.app"))
            .arg(&zip)
            .status()
            .unwrap();
        assert!(zipped.success());
        let installed = Installed {
            exe_path: apps.join("NekkoAgent.app/Contents/MacOS/NekkoAgent").to_string_lossy().into_owned(),
            app_pid: Some(0x7fff_fff0),
            ..Default::default()
        };
        let Ok(InstallPlan::Script { script }) =
            install_plan(Platform::Mac, LinuxPackage::AppImage, &installed, &zip, false)
        else {
            panic!()
        };
        // Everything up to the relaunch.
        let script = script.replace("/usr/bin/open -n", "true");
        assert!(std::process::Command::new("/bin/sh").arg("-c").arg(&script).status().unwrap().success());
        assert!(apps.join("NekkoAgent.app/new").exists());
        assert!(!apps.join("NekkoAgent.app/old").exists());
        assert!(!apps.join("NekkoAgent.app.old").exists());
        std::fs::remove_dir_all(&root).unwrap();
    }

    mod feed_signature {
        use super::*;
        use ed25519_dalek::{Signer, SigningKey};

        const FEED: &[u8] = b"version: 9.9.9\nfiles:\n  - url: NekkoAgent-9.9.9-x64.exe\n    sha512: abc=\n";

        fn pair() -> (SigningKey, [u8; 32]) {
            let sk = SigningKey::from_bytes(&[11; 32]);
            let pk = sk.verifying_key().to_bytes();
            (sk, pk)
        }

        fn sig(sk: &SigningKey, bytes: &[u8]) -> Vec<u8> {
            format!("{}\n", base64::engine::general_purpose::STANDARD.encode(sk.sign(bytes).to_bytes())).into_bytes()
        }

        #[test]
        fn a_good_signature_passes() {
            let (sk, pk) = pair();
            assert_eq!(verify_feed(&pk, "latest.yml", FEED, Some(&sig(&sk, FEED))), Ok(()));
        }

        #[test]
        fn a_bad_signature_is_refused() {
            let (sk, pk) = pair();
            // Signed by another key.
            let other = SigningKey::from_bytes(&[12; 32]);
            let err = verify_feed(&pk, "latest.yml", FEED, Some(&sig(&other, FEED))).unwrap_err();
            assert!(err.contains("did not pass its signature check"), "{err}");
            // A feed changed after signing (a swapped checksum).
            let mut tampered = FEED.to_vec();
            let at = tampered.len() - 3;
            tampered[at] = b'X';
            assert!(verify_feed(&pk, "latest.yml", &tampered, Some(&sig(&sk, FEED))).is_err());
            // Not a signature at all.
            assert!(verify_feed(&pk, "latest.yml", FEED, Some(b"<html>Not Found</html>")).is_err());
        }

        #[test]
        fn a_missing_signature_is_refused() {
            let (_, pk) = pair();
            let err = verify_feed(&pk, "latest-mac.yml", FEED, None).unwrap_err();
            assert!(err.contains("latest-mac.yml.sig is missing"), "{err}");
        }

        #[test]
        fn the_placeholder_key_checks_nothing() {
            assert_eq!(verify_feed(&[0; 32], "latest.yml", FEED, None), Ok(()));
            assert_eq!(verify_feed(&[0; 32], "latest.yml", FEED, Some(b"garbage")), Ok(()));
        }

        #[test]
        fn a_feed_signed_by_the_release_script_verifies() {
            // scripts/sign-update-feed.mjs made this signature (a test key).
            let v: Value = serde_json::from_str(include_str!("../tests/golden/feed-signature.json")).unwrap();
            let b64 = base64::engine::general_purpose::STANDARD;
            let pk: [u8; 32] = b64.decode(v["publicKey"].as_str().unwrap()).unwrap().try_into().unwrap();
            let seed: [u8; 32] = b64.decode(v["seed"].as_str().unwrap()).unwrap().try_into().unwrap();
            assert_eq!(SigningKey::from_bytes(&seed).verifying_key().to_bytes(), pk);
            let feed = v["feed"].as_str().unwrap().as_bytes();
            let sig = v["signature"].as_str().unwrap().as_bytes();
            assert_eq!(verify_feed(&pk, "latest.yml", feed, Some(sig)), Ok(()));
            assert_eq!(parse_update_info(v["feed"].as_str().unwrap(), "latest.yml").unwrap().version, "1.2.3");
        }

        #[test]
        fn the_signature_sits_beside_the_feed() {
            let u = url::Url::parse("https://github.com/o/r/releases/download/v1.2.3/latest-linux.yml").unwrap();
            assert_eq!(
                signature_url(&u).as_str(),
                "https://github.com/o/r/releases/download/v1.2.3/latest-linux.yml.sig"
            );
            let q = url::Url::parse("https://cdn.example/feed/latest.yml?token=1").unwrap();
            assert_eq!(signature_url(&q).as_str(), "https://cdn.example/feed/latest.yml.sig?token=1");
        }
    }

    #[test]
    fn dn_matching_follows_electron_updater() {
        let subject = "CN=Nekko Labs, O=Nekko Labs, C=DE";
        assert!(dn_matches("Nekko Labs", subject));
        assert!(dn_matches("CN=Nekko Labs, C=DE", subject));
        assert!(!dn_matches("CN=Other", subject));
        assert!(!dn_matches("Other", subject));
    }

    #[test]
    fn cache_names_come_from_the_url() {
        let r = Resolved {
            url: url::Url::parse("https://x/a/NekkoAgent%20Setup-0.9.0-x64.exe").unwrap(),
            info: FileInfo {
                url: String::new(),
                sha512: None,
                sha2: None,
                size: None,
                is_admin_rights_required: false,
            },
        };
        assert_eq!(cache_file_name(&r, "exe"), "NekkoAgent Setup-0.9.0-x64.exe");
        assert_eq!(cache_file_name(&r, "zip"), "update.zip");
    }
}
