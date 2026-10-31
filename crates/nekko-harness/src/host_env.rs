//! A Claude Code session's environment, which Nekko must not pass on.
//!
//! A Nekko started from inside a Claude Code session (a terminal tab in
//! Claude Code, an agent that launched the dev build) inherits that
//! session's variables: `CLAUDECODE=1`, `CLAUDE_CODE_ENTRYPOINT`, host auth
//! hand-offs, `ANTHROPIC_BASE_URL` and the default-model overrides. A
//! `claude` started under them runs as a child of that session, on its
//! auth: the sign-in terminal shows "API Usage Billing" and a prompt instead
//! of the sign-in, and a subscription turn would bill the parent's account.
//! nekkod drops them once at startup so every child sees the user's own
//! environment, as a terminal opened from the desktop would.

/// `CLAUDE_CODE_*` variables that are the user's own Claude Code setup, not
/// a session's, so they stay.
const USER_SETTINGS: &[&str] =
    &["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_GIT_BASH_PATH"];

/// Of the variable names given, the ones a parent Claude Code session set.
/// Empty unless `CLAUDECODE` is among them: without it there is no parent
/// session and the user's own `ANTHROPIC_*` settings are left alone.
pub fn host_session_vars<I, S>(names: I) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let names: Vec<String> = names.into_iter().map(Into::into).collect();
    if !names.iter().any(|n| n == "CLAUDECODE") {
        return Vec::new();
    }
    names.into_iter().filter(|n| is_session_var(n)).collect()
}

fn is_session_var(name: &str) -> bool {
    if USER_SETTINGS.contains(&name) {
        return false;
    }
    matches!(name, "CLAUDECODE" | "CLAUDE_PID" | "CLAUDE_EFFORT" | "ANTHROPIC_BASE_URL")
        || name.starts_with("CLAUDE_CODE_")
        || name.starts_with("CLAUDE_AGENT_SDK_")
        || name.starts_with("CLAUDE_PREVIEW_")
        || (name.starts_with("ANTHROPIC_DEFAULT_") && name.ends_with("_MODEL"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_a_parent_sessions_variables() {
        let got = host_session_vars([
            "CLAUDECODE",
            "CLAUDE_CODE_ENTRYPOINT",
            "CLAUDE_CODE_OAUTH_SCOPES",
            "CLAUDE_AGENT_SDK_VERSION",
            "CLAUDE_PID",
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "PATH",
            "HOME",
        ]);
        assert_eq!(
            got,
            [
                "CLAUDECODE",
                "CLAUDE_CODE_ENTRYPOINT",
                "CLAUDE_CODE_OAUTH_SCOPES",
                "CLAUDE_AGENT_SDK_VERSION",
                "CLAUDE_PID",
                "ANTHROPIC_BASE_URL",
                "ANTHROPIC_DEFAULT_OPUS_MODEL",
            ]
        );
    }

    #[test]
    fn keeps_the_users_own_settings() {
        let got = host_session_vars([
            "CLAUDECODE",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_GIT_BASH_PATH",
            "ANTHROPIC_API_KEY",
        ]);
        assert_eq!(got, ["CLAUDECODE"]);
    }

    #[test]
    fn nothing_without_a_parent_session() {
        assert!(host_session_vars(["ANTHROPIC_BASE_URL", "CLAUDE_CODE_ENTRYPOINT", "PATH"]).is_empty());
    }
}
