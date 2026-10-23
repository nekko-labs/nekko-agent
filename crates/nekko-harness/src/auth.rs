//! Whether Claude Code is signed in, from `claude auth status` alone.
//!
//! Nekko never reads Claude Code's config directory or credentials: the CLI's
//! own status command is the supported check, and it says only whether the
//! user is signed in and with what kind of credential.

use crate::locate::{ClaudeBin, PROBE_TIMEOUT, command};
use serde_json::Value;
use std::path::Path;

/// `claude auth status`, as Nekko uses it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthStatus {
    pub logged_in: bool,
    /// `none`, `api_key`, a plan sign-in (`claude.ai`), or whatever a newer CLI
    /// reports; the policy table reads it (H5), unknown values fail closed.
    pub auth_method: String,
    /// `firstParty`, `bedrock`, `vertex`, `foundry`.
    pub api_provider: Option<String>,
    /// Where an API key came from (`ANTHROPIC_API_KEY`), when it is one.
    pub api_key_source: Option<String>,
}

/// Parse the status JSON. `exit_ok` is false when the command exited
/// non-zero, which it does when signed out; a missing or unreadable body is
/// an error rather than a guess.
pub fn parse_auth_status(stdout: &str, exit_ok: bool) -> Result<AuthStatus, String> {
    let v: Value = serde_json::from_str(stdout.trim())
        .map_err(|_| format!("`claude auth status` did not print JSON: {:?}", stdout.trim()))?;
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    let logged_in = v.get("loggedIn").and_then(Value::as_bool).unwrap_or(false) && exit_ok;
    Ok(AuthStatus {
        logged_in,
        auth_method: s("authMethod").unwrap_or_else(|| "unknown".into()),
        api_provider: s("apiProvider"),
        api_key_source: s("apiKeySource"),
    })
}

/// Run `claude auth status --json` with the user's environment as it is,
/// for the account whose config directory is `config_dir` (`None`: the
/// default login).
pub async fn auth_status(bin: &ClaudeBin, config_dir: Option<&Path>) -> Result<AuthStatus, String> {
    let mut cmd = command(&bin.path);
    if let Some(dir) = config_dir {
        cmd.env("CLAUDE_CONFIG_DIR", dir);
    }
    cmd.args(["auth", "status", "--json"]).stdin(std::process::Stdio::null());
    let out = tokio::time::timeout(PROBE_TIMEOUT, cmd.output())
        .await
        .map_err(|_| "`claude auth status` did not answer.".to_string())?
        .map_err(|e| format!("Could not run `claude auth status`: {e}"))?;
    parse_auth_status(&String::from_utf8_lossy(&out.stdout), out.status.success())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signed_out_and_api_key_fixtures() {
        let out = include_str!("../tests/fixtures/signed-out/auth-status.json");
        let s = parse_auth_status(out, false).unwrap();
        assert!(!s.logged_in);
        assert_eq!(s.auth_method, "none");
        assert_eq!(s.api_provider.as_deref(), Some("firstParty"));

        let out = include_str!("../tests/fixtures/api-key/auth-status.json");
        let s = parse_auth_status(out, true).unwrap();
        assert!(s.logged_in);
        assert_eq!(s.auth_method, "api_key");
        assert_eq!(s.api_key_source.as_deref(), Some("ANTHROPIC_API_KEY"));
    }

    #[test]
    fn a_failed_exit_is_never_signed_in() {
        let s = parse_auth_status(r#"{"loggedIn":true,"authMethod":"api_key"}"#, false).unwrap();
        assert!(!s.logged_in);
        assert!(parse_auth_status("Not logged in", false).is_err());
    }
}
