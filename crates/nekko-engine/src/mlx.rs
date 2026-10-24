//! MLX as a runtime on Apple Silicon: pinned `uv` (a tracked download job)
//! installing pinned `mlx-lm` into its own Python under the engine folder.
//! A port of the runtime half of `packages/host/src/engine/mlx.ts`, held to
//! it by `tests/golden/install.json`.

use crate::BoxFuture;
use crate::download::{After, Downloads, Request, Signal, Verify};
use crate::install::{InstallIo, sha256_file};
use nekko_tools::path::native as path;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Pinned so an install is reproducible (`MLX_LM_VERSION`, `UV_VERSION`).
pub const MLX_LM_VERSION: &str = "0.31.3";
pub const UV_VERSION: &str = "0.12.21";
const UV_ASSET: &str = "uv-aarch64-apple-darwin.tar.gz";
const APPROX_INSTALL_BYTES: u64 = 420 * 1024 * 1024;
const SERVER: &str = "mlx_lm.server";

/// What running a command and finding one on PATH need (scripted in tests).
pub trait MlxIo: InstallIo {
    /// Run to completion with extra environment; the combined output, or the
    /// last lines of it (or the error) when it failed.
    fn exec(&self, cmd: String, args: Vec<String>, env: Vec<(String, String)>) -> BoxFuture<Result<String, String>>;
    /// `which <name>`.
    fn which(&self, name: String) -> BoxFuture<Option<String>>;
}

impl MlxIo for crate::install::SystemIo {
    fn exec(&self, cmd: String, args: Vec<String>, env: Vec<(String, String)>) -> BoxFuture<Result<String, String>> {
        Box::pin(async move {
            let mut c = tokio::process::Command::new(&cmd);
            c.args(&args).envs(env).stdin(std::process::Stdio::null()).kill_on_drop(true);
            let out = tokio::time::timeout(Duration::from_secs(30 * 60), c.output())
                .await
                .map_err(|_| "timed out".to_string())?
                .map_err(|e| e.to_string())?;
            let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
            if out.status.success() {
                return Ok(text);
            }
            let tail: Vec<&str> = nekko_js::trim(&text).split('\n').collect();
            let tail = tail[tail.len().saturating_sub(3)..].join(" ");
            Err(if tail.is_empty() { format!("Command failed: {cmd}") } else { tail })
        })
    }

    fn which(&self, name: String) -> BoxFuture<Option<String>> {
        let run = self.run("/usr/bin/which".into(), vec![name], 3000);
        Box::pin(async move { run.await.map(|o| nekko_js::trim(&o).to_string()).filter(|o| !o.is_empty()) })
    }
}

/// The synthetic build MLX has (`MLX_BUILD`).
pub fn mlx_build() -> Value {
    json!({
        "id": "mlx-lm",
        "platform": "darwin",
        "arch": "arm64",
        "backend": "metal",
        "label": "MLX (Apple Silicon)",
        "requires": "An Apple Silicon Mac.",
        "assetPattern": "mlx-lm",
    })
}

/// The MLX runtime (`createMlxRuntime`).
pub struct MlxRuntime {
    /// `<engine>/mlx`.
    pub dir: String,
    pub platform: String,
    pub arch: String,
    pub io: Arc<dyn MlxIo>,
    pub downloads: Downloads,
    last_error: Mutex<Option<String>>,
}

fn is_file(p: &str) -> bool {
    std::fs::metadata(p).is_ok_and(|m| m.is_file())
}

impl MlxRuntime {
    pub fn new(dir: String, platform: String, arch: String, io: Arc<dyn MlxIo>, downloads: Downloads) -> Arc<Self> {
        Arc::new(Self { dir, platform, arch, io, downloads, last_error: Mutex::new(None) })
    }

    /// Apple Silicon only (`mlxSupported`).
    pub fn supported(&self) -> bool {
        self.platform == "darwin" && self.arch == "arm64"
    }

    fn managed_bin(&self) -> String {
        path::join(&[&self.dir, "bin", SERVER])
    }

    /// `mlx_lm.server`: ours, else one on PATH (`binPath`).
    pub async fn bin_path(&self) -> Option<String> {
        if !self.supported() {
            return None;
        }
        if is_file(&self.managed_bin()) {
            return Some(self.managed_bin());
        }
        self.io.which(SERVER.into()).await
    }

    pub async fn detect(&self) -> Value {
        if !self.supported() {
            return json!({ "available": [], "reason": "MLX runs on Apple Silicon Macs only." });
        }
        let build = mlx_build();
        if is_file(&self.managed_bin()) {
            return json!({
                "binPath": self.managed_bin(),
                "source": "managed",
                "version": format!("mlx-lm {MLX_LM_VERSION}"),
                "available": [build],
                "recommended": build,
            });
        }
        if let Some(external) = self.io.which(SERVER.into()).await {
            return json!({ "binPath": external, "source": "external", "available": [build], "recommended": build });
        }
        let reason = self.last_error.lock().unwrap().clone().unwrap_or_else(|| "MLX is not installed yet.".into());
        json!({ "available": [build], "recommended": build, "reason": reason })
    }

    pub fn preview(&self) -> Value {
        if !self.supported() {
            return Value::Null;
        }
        let uv = 17 * 1024 * 1024;
        json!({
            "runtime": "mlx",
            "version": format!("mlx-lm {MLX_LM_VERSION} (uv {UV_VERSION})"),
            "build": mlx_build(),
            "sizeBytes": APPROX_INSTALL_BYTES,
            "files": [
                { "name": UV_ASSET, "sizeBytes": uv },
                { "name": format!("Python + mlx-lm {MLX_LM_VERSION}"), "sizeBytes": APPROX_INSTALL_BYTES - uv },
            ],
        })
    }

    /// Download uv as a tracked job, then have it install `mlx-lm` (`install`).
    pub async fn install(self: &Arc<Self>) -> Value {
        if !self.supported() {
            return json!({ "ok": false, "message": "MLX runs on Apple Silicon Macs only." });
        }
        if is_file(&self.managed_bin()) {
            return json!({ "ok": true, "message": "MLX is already installed." });
        }
        let url = format!("https://api.github.com/repos/astral-sh/uv/releases/tags/{UV_VERSION}");
        // GitHub's API answers 403 to a request without a User-Agent.
        let headers =
            vec![("Accept".into(), "application/vnd.github+json".into()), ("User-Agent".into(), "nekko-agent".into())];
        let release = match self.io.get(url, headers, None).await {
            Ok((status, body)) if (200..300).contains(&status) => serde_json::from_slice::<Value>(&body).ok(),
            _ => None,
        };
        let asset = release
            .as_ref()
            .and_then(|r| r.get("assets"))
            .and_then(Value::as_array)
            .and_then(|a| a.iter().find(|x| x.get("name").and_then(Value::as_str) == Some(UV_ASSET)))
            .cloned();
        let Some(asset) = asset else {
            return json!({
                "ok": false,
                "message": format!("Could not read uv {UV_VERSION}'s release. Check the connection and try again."),
            });
        };
        let uv_dir = path::join(&[&self.dir, "uv"]);
        if let Err(e) = nekko_tools::nodefs::mkdir_p(&uv_dir) {
            return json!({ "ok": false, "message": e });
        }
        *self.last_error.lock().unwrap() = None;
        // Checked when the release publishes a digest; the job still passes through `verifying`.
        let digest = asset.get("digest").filter(|d| nekko_js::truthy(Some(d))).map(nekko_js::display);
        let verify: Verify = Arc::new(move |p: String| {
            let digest = digest.clone();
            Box::pin(async move {
                let want = strip_sha256(&digest?).to_lowercase();
                let got = tokio::task::spawn_blocking(move || sha256_file(&p)).await.ok().flatten();
                (got.as_deref() != Some(want.as_str())).then(|| "uv download checksum did not match.".to_string())
            })
        });
        let me = self.clone();
        let after: After = Arc::new(move |file: String, signal: Signal| {
            let me = me.clone();
            Box::pin(async move {
                match me.finish(&file, &signal).await {
                    Ok(problem) => problem,
                    Err(e) => {
                        let message = format!("MLX install failed: {e}");
                        *me.last_error.lock().unwrap() = Some(message.clone());
                        Some(message)
                    }
                }
            })
        });
        let job = self.downloads.start(Request {
            id: "engine:mlx:mlx-lm".into(),
            kind: "engine".into(),
            label: format!("MLX (mlx-lm {MLX_LM_VERSION})"),
            target: "mlx-lm".into(),
            url: asset.get("browser_download_url").map(nekko_js::display).unwrap_or_default(),
            dest: path::join(&[&uv_dir, UV_ASSET]),
            verify: Some(verify),
            after: Some(after),
            ..Request::default()
        });
        json!({ "ok": true, "message": "Installing MLX.", "jobId": job["id"] })
    }

    /// Unpack uv and have it install `mlx-lm` into the engine folder.
    async fn finish(&self, file: &str, signal: &Signal) -> Result<Option<String>, String> {
        if signal.aborted() {
            return Err("This operation was aborted".into());
        }
        let uv_dir = path::join(&[&self.dir, "uv"]);
        let s = |x: &str| x.to_string();
        self.io
            .exec(
                s("tar"),
                vec![s("-xzf"), s(file), s("-C"), uv_dir.clone(), s("--strip-components"), s("1")],
                Vec::new(),
            )
            .await?;
        let uv = path::join(&[&uv_dir, "uv"]);
        // Everything uv writes stays under the engine folder.
        let env: Vec<(String, String)> = [
            ("UV_TOOL_DIR", path::join(&[&self.dir, "tools"])),
            ("UV_TOOL_BIN_DIR", path::join(&[&self.dir, "bin"])),
            ("UV_PYTHON_INSTALL_DIR", path::join(&[&self.dir, "python"])),
            ("UV_CACHE_DIR", path::join(&[&self.dir, "cache"])),
            ("UV_NO_MODIFY_PATH", s("1")),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
        if signal.aborted() {
            return Err("This operation was aborted".into());
        }
        self.io
            .exec(uv, vec![s("tool"), s("install"), s("--python"), s("3.12"), format!("mlx-lm=={MLX_LM_VERSION}")], env)
            .await?;
        if !is_file(&self.managed_bin()) {
            return Ok(Some(format!("mlx-lm installed but {SERVER} was not where uv puts tools.")));
        }
        // The package cache is only for installing; it is most of the bytes.
        let _ = std::fs::remove_dir_all(path::join(&[&self.dir, "cache"]));
        Ok(None)
    }

    pub fn uninstall(&self) -> Value {
        if !is_file(&self.managed_bin()) {
            return json!({
                "ok": false,
                "message": "Only an MLX install made here can be removed here; one on your PATH is yours.",
            });
        }
        let _ = std::fs::remove_dir_all(&self.dir);
        json!({ "ok": true, "message": "Removed MLX. Models are kept." })
    }
}

/// `digest.replace(/^sha256:/i, '')`.
fn strip_sha256(d: &str) -> &str {
    match d.get(..7) {
        Some(p) if p.eq_ignore_ascii_case("sha256:") => &d[7..],
        _ => d,
    }
}
