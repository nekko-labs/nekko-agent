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
