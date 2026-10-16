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
    let res = client.get(r.url.clone()).send().await.map_err(|e| e.to_string())?;
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
            let name = bundle.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let (b, s, z) =
                (sh_quote(&bundle.to_string_lossy()), sh_quote(&staging.to_string_lossy()), sh_quote(&file));
            let new_app = sh_quote(&staging.join(&name).to_string_lossy());
            let old = sh_quote(&format!("{}.old", bundle.to_string_lossy()));
            let script = format!(
                "set -e\n{wait}rm -rf {s}\nmkdir -p {s}\n/usr/bin/ditto -x -k {z} {s}\n\
                 test -d {new_app}\nrm -rf {old}\nmv {b} {old}\n\
                 if mv {new_app} {b}; then rm -rf {old}; else mv {old} {b}; exit 1; fi\n\
                 rm -rf {s}\n/usr/bin/open -n {b}\n",
                wait = wait_for_pid(installed.app_pid),
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
    let data: Value =
        serde_json::from_slice(&out.stdout).map_err(|e| format!("Cannot verify the installer's signature: {e}"))?;
    if data.get("Status").and_then(Value::as_i64) == Some(0) {
        let subject = data.pointer("/SignerCertificate/Subject").and_then(Value::as_str).unwrap_or("");
        if publishers.iter().any(|p| dn_matches(p, subject)) {
            return Ok(());
        }
    }
    Err(format!("New version is not signed by the application owner: publisherNames: {}", publishers.join(" | ")))
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
