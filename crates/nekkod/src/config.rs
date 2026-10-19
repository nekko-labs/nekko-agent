//! Launch configuration.
//!
//! Read from the `NEKKOD_CONFIG` environment variable (JSON) or from the file
//! named by `--config <path>`, never from ordinary arguments: the config holds
//! the bearer token, and a process's arguments are visible to every other user
//! on the machine.

use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// Address to bind. Loopback only; port 0 picks a free one.
    #[serde(default = "default_listen")]
    pub listen: String,
    /// Bearer token every request must carry.
    pub token: String,
    /// The UI origins allowed to open a socket. A packaged desktop page is a
    /// `file://` document: fetch reports it as the origin `null`, a WebSocket
    /// handshake as `file://`.
    #[serde(default = "default_origins")]
    pub allowed_origins: Vec<String>,
    /// The TS host that serves every channel not ported yet. Absent in tests
    /// and in a daemon run on its own.
    pub backend: Option<BackendCommand>,
    /// The user data directory, whose `sessions/` the daemon reads. Absent,
    /// the session channels stay with the backend.
    pub data_dir: Option<String>,
    /// Exit when stdin closes, so the daemon never outlives the app that
    /// started it (the parent holds our stdin open for its whole life).
    #[serde(default = "yes")]
    pub exit_on_stdin_close: bool,
    /// Whether the model server starts at launch when `engine.autoStart` says
    /// so. A one-shot CLI command passes `false`: it must not bring it up.
    #[serde(default = "yes")]
    pub auto_start_engine: bool,
    /// Whether subscription sign-in is offered (the desktop app). The web
    /// edition passes `false`: its browser is not on the machine whose
    /// loopback port receives the sign-in callback.
    #[serde(default = "yes")]
    pub sign_in: bool,
    /// Whether the host lets the agent drive a browser (the desktop app's
    /// does); what a turn the daemon admits offers.
    #[serde(default)]
    pub allow_browser_control: bool,
    /// The desktop app's bridge to its in-app browser and window capturer,
    /// for the agent's `browser` and `capture` tools. Kept in the config,
    /// never the environment, so the shells the agent starts never see it.
    pub browser_bridge: Option<BrowserBridge>,
    /// Where Hugging Face is (`https://huggingface.co`), for the model
    /// catalog and model downloads; tests point it at a loopback server.
    pub hugging_face_url: Option<String>,
    /// Where GitHub's API is (`https://api.github.com`), for the runtime
    /// installers; tests point it at a loopback server.
    pub github_api_url: Option<String>,
    /// Where the decision models' release assets are (the `decision-models-v1`
    /// release's download URL); tests point it at a loopback server.
    pub decision_models_url: Option<String>,
    /// The app's version for `app:info` (the desktop app's); absent, the
    /// Local Web UI's `NEKKO_VERSION`, else `0.0.0`.
    pub app_version: Option<String>,
    /// `desktop` or `web` for `app:info`; absent means `web`.
    pub edition: Option<String>,
    /// Where Telegram's Bot API is (`https://api.telegram.org`), for the
    /// messaging bridge; tests point it at a loopback fake. Without it,
    /// `NEKKO_TELEGRAM_API_URL` (a self-hosted Bot API server, or the web
    /// edition's live checks, whose server writes this config itself).
    pub telegram_api_url: Option<String>,
    /// The desktop app around the daemon, for the channels Electron main
    /// used to answer (native.rs): dialogs, opening paths, the microphone,
    /// the updater. Absent (the Local Web UI, Docker), they are not served.
    pub native: Option<NativeConfig>,
}

/// What the daemon needs to know about the desktop app it serves.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeConfig {
    /// A packaged app updates itself; a development checkout does not.
    #[serde(default)]
    pub is_packaged: bool,
    /// The app's executable (`process.execPath`), relaunched after an update.
    #[serde(default)]
    pub exe_path: String,
    /// Electron's `process.resourcesPath`: `app-update.yml`, `elevate.exe`, `package-type`.
    pub resources_path: Option<String>,
    /// Linux: `$APPIMAGE`, the AppImage the app runs from.
    pub app_image: Option<String>,
    /// Electron main's pid, which an update waits for before replacing files.
    pub app_pid: Option<u32>,
    /// A generic update feed (`<url>/latest.yml`) in place of `app-update.yml`'s
    /// (tests and sandboxes; also turns updates on in an unpackaged app).
    pub update_feed_url: Option<String>,
    /// Where downloads are kept; absent, electron-updater's cache folder.
    pub update_cache_dir: Option<String>,
    /// `bridge` has Electron main draw the dialogs (macOS always does; tests
    /// use it so no real dialog opens). Absent, the daemon draws them.
    pub dialogs: Option<String>,
    /// `app.getPath('userData')`: the CLI launcher goes in its `bin`.
    /// Absent, the data directory.
    pub user_data: Option<String>,
    /// `app.getAppPath()`, where a development checkout's CLI build is found.
    pub app_path: Option<String>,
    /// The bundled relay (`out/main/relay.js`) for "Relay on this computer",
    /// run with `exePath` as Node. Absent, the relay cannot start.
    pub relay_entry: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct BrowserBridge {
    pub url: String,
    pub token: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendCommand {
    pub exe: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub cwd: Option<String>,
}

fn default_listen() -> String {
    "127.0.0.1:0".into()
}

fn default_origins() -> Vec<String> {
    vec!["null".into(), "file://".into()]
}

fn yes() -> bool {
    true
}

pub fn load() -> anyhow::Result<Config> {
    let mut args = std::env::args().skip(1);
    let mut raw = None;
    while let Some(a) = args.next() {
        if a == "--config" {
            let path = args.next().ok_or_else(|| anyhow::anyhow!("--config needs a path"))?;
            raw = Some(std::fs::read_to_string(path)?);
        } else if a == "--version" {
            println!("nekkod {}", env!("CARGO_PKG_VERSION"));
            std::process::exit(0);
        }
    }
    let raw = match raw {
        Some(r) => r,
        None => std::env::var("NEKKOD_CONFIG").map_err(|_| anyhow::anyhow!("set NEKKOD_CONFIG or pass --config"))?,
    };
    let cfg: Config = serde_json::from_str(&raw)?;
    if cfg.token.len() < 16 {
        anyhow::bail!("token must be at least 16 characters");
    }
    let host = cfg.listen.rsplit_once(':').map(|(h, _)| h).unwrap_or("");
    if !matches!(host, "127.0.0.1" | "localhost" | "[::1]") {
        anyhow::bail!("nekkod binds loopback only, not {}", cfg.listen);
    }
    Ok(cfg)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_fill_in() {
        let cfg: Config = serde_json::from_str(r#"{"token":"0123456789abcdef"}"#).unwrap();
        assert_eq!(cfg.listen, "127.0.0.1:0");
        assert_eq!(cfg.allowed_origins, vec!["null".to_string(), "file://".to_string()]);
        assert!(cfg.exit_on_stdin_close);
        assert!(cfg.backend.is_none());
    }
}
