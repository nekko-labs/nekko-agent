//! Which Claude Code login a Claude Agent provider runs on.
//!
//! Claude Code keeps each login in its config directory, and its documented
//! `CLAUDE_CONFIG_DIR` picks one. A provider with no account uses the user's
//! default login, exactly as a plain `claude` in a terminal does. A provider
//! with an account (`work`) runs Claude Code with `CLAUDE_CONFIG_DIR` set to
//! `~/.claude-work`, the same folder the user gets by typing
//! `CLAUDE_CONFIG_DIR=~/.claude-work claude` themselves. The user signs in
//! there through Claude Code's own `/login`; Nekko never opens the folder.
//!
//! The folder comes only from a short name checked here, never from a path
//! in settings, so a hand-edited settings file cannot point Claude Code at an
//! arbitrary directory.

use std::path::PathBuf;

/// Longest account name, in characters.
pub const MAX_ACCOUNT_LEN: usize = 32;

/// Whether `name` is a valid account name: 1 to 32 of `a-z`, `0-9` and `-`,
/// not starting or ending with `-`.
pub fn is_account_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_ACCOUNT_LEN
        && !name.starts_with('-')
        && !name.ends_with('-')
        && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn home() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var).filter(|h| !h.is_empty()).map(PathBuf::from)
}

/// The Claude Code config directory for an account: `None` for the default
/// login (no account), `~/.claude-<name>` otherwise. An invalid name is an
/// error, never a fallback to the default login, so a chat never runs on an
/// account the user did not pick.
pub fn account_config_dir(account: Option<&str>) -> Result<Option<PathBuf>, String> {
    let Some(name) = account.filter(|a| !a.is_empty()) else { return Ok(None) };
    if !is_account_name(name) {
        return Err(format!("\"{name}\" is not a valid Claude Code account name."));
    }
    let home = home().ok_or("Could not find your home folder for the Claude Code account.")?;
    Ok(Some(home.join(format!(".claude-{name}"))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        for ok in ["work", "a", "client-2", "x".repeat(32).as_str()] {
            assert!(is_account_name(ok), "{ok}");
        }
        for bad in ["", "Work", "-a", "a-", "a/b", "..", "a b", "ä", "x".repeat(33).as_str()] {
            assert!(!is_account_name(bad), "{bad}");
        }
    }

    #[test]
    fn dirs() {
        assert_eq!(account_config_dir(None).unwrap(), None);
        assert_eq!(account_config_dir(Some("")).unwrap(), None);
        let dir = account_config_dir(Some("work")).unwrap().unwrap();
        assert_eq!(dir.file_name().unwrap(), ".claude-work");
        assert_eq!(dir.parent(), home().as_deref());
        assert!(account_config_dir(Some("../etc")).is_err());
    }
}
