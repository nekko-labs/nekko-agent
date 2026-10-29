//! Git's own configuration can name programs for git to run: `core.fsmonitor`
//! on every `git status`, `diff.external` on `git diff`, textconv and filter
//! drivers, hooks, the pager. Guardrails mode auto-runs read-only git
//! commands, so a chat that could rewrite git's configuration without asking
//! could turn the next `git status` into any program (decision 0010).
//!
//! Two defences: writing anywhere git reads configuration from asks
//! ([`touches_git_config`]), and an auto-run command that runs git gets an
//! environment that overrides the settings that execute ([`hardened_git_env`]).

use crate::sandbox::real_location;
use std::path::{Component, Path, PathBuf};

/// One environment change for a command: set the variable, or remove it (`None`).
pub type EnvChange = (String, Option<String>);

fn lower(p: &Path) -> PathBuf {
    PathBuf::from(p.to_string_lossy().to_lowercase())
}

/// `p` is `dir` or inside it, compared without case (case-insensitive file
/// systems are the default on macOS and Windows, and asking too often is the
/// safe side).
fn under(p: &Path, dir: &Path) -> bool {
    !dir.as_os_str().is_empty() && lower(p).starts_with(lower(dir))
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from)
}

fn home() -> Option<PathBuf> {
    env_path("HOME").or_else(|| env_path("USERPROFILE"))
}

/// A directory git treats as a repository: `HEAD` beside `objects/` (a
/// repository or bare repository) or beside `commondir` (a worktree's gitdir).
fn is_git_dir(dir: &Path) -> bool {
    dir.join("HEAD").is_file() && (dir.join("objects").is_dir() || dir.join("commondir").is_file())
}

fn check(p: &Path) -> bool {
    // Anything in a `.git` directory, and a `.git` file itself (it names the
    // gitdir, so rewriting it points git at another configuration).
    let dot_git =
        p.components().any(|c| matches!(c, Component::Normal(n) if n.to_string_lossy().eq_ignore_ascii_case(".git")));
    let name = p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    if dot_git || name == ".gitconfig" {
        return true;
    }
    // Where this process's git would look: $GIT_DIR, $GIT_COMMON_DIR,
    // $GIT_CONFIG_GLOBAL, and the user's XDG git folder.
    let xdg = env_path("XDG_CONFIG_HOME").or_else(|| home().map(|h| h.join(".config"))).map(|c| c.join("git"));
    let named = [env_path("GIT_DIR"), env_path("GIT_COMMON_DIR"), env_path("GIT_CONFIG_GLOBAL"), xdg];
    if named.iter().flatten().any(|d| under(p, d)) {
        return true;
    }
    // A bare repository or a worktree's gitdir has no `.git` in its path.
    p.ancestors().skip(1).any(is_git_dir)
}

/// Whether writing, editing or deleting `path` could change what git runs:
/// a path inside a `.git` directory or a `.git` file, a path inside any other
/// git directory (bare repositories, worktree gitdirs, `$GIT_DIR`), or a
/// user-level git config (`~/.gitconfig`, `$XDG_CONFIG_HOME/git/`,
/// `$GIT_CONFIG_GLOBAL`). Checked as written and where the path really is,
/// links followed.
pub fn touches_git_config(path: &str) -> bool {
    check(Path::new(path)) || check(Path::new(&real_location(path)))
}

/// The null device git can read hooks from (none run).
fn null_device() -> &'static str {
    if cfg!(windows) { "NUL" } else { "/dev/null" }
}

/// The environment for an auto-run command that runs git: configuration
/// that would run a program is overridden with `GIT_CONFIG_COUNT` entries,
/// which take precedence over every config file, numbered after any the
/// daemon already has. `GIT_EXTERNAL_DIFF` is removed.
///
/// `diff.external` has no value that turns it off (an empty one makes
/// `git diff` fail with "cannot run", `true` prints an empty diff), and git
/// has no global switch for textconv or filter drivers, so those rely on
/// [`touches_git_config`]: the configuration that defines them cannot be
/// written without asking.
pub fn hardened_git_env() -> Vec<EnvChange> {
    let base: usize = std::env::var("GIT_CONFIG_COUNT").ok().and_then(|n| n.trim().parse().ok()).unwrap_or(0);
    let overrides = [("core.fsmonitor", "false"), ("core.hooksPath", null_device()), ("core.pager", "cat")];
    let mut env = Vec::new();
    for (i, (key, value)) in overrides.iter().enumerate() {
        env.push((format!("GIT_CONFIG_KEY_{}", base + i), Some((*key).to_string())));
        env.push((format!("GIT_CONFIG_VALUE_{}", base + i), Some((*value).to_string())));
    }
    env.push(("GIT_CONFIG_COUNT".into(), Some((base + overrides.len()).to_string())));
    env.push(("GIT_PAGER".into(), Some("cat".into())));
    env.push(("GIT_EXTERNAL_DIFF".into(), None));
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nekko-gitguard-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn writes_into_git_directories_are_caught() {
        let ws = temp("ws");
        let s = |p: PathBuf| p.to_string_lossy().into_owned();
        for p in [
            ws.join(".git").join("config"),
            ws.join(".git").join("hooks").join("pre-commit"),
            ws.join(".GIT").join("config"),
            ws.join("sub").join(".git"),
            ws.join(".git"),
            ws.join("x").join(".gitconfig"),
        ] {
            assert!(touches_git_config(&s(p.clone())), "{p:?}");
        }
        for p in [ws.join("src").join("main.rs"), ws.join(".gitignore"), ws.join(".github").join("ci.yml")] {
            assert!(!touches_git_config(&s(p.clone())), "{p:?}");
        }
        // A bare repository (or a worktree's gitdir) has no `.git` in its path.
        let bare = ws.join("repo.git-bare");
        std::fs::create_dir_all(bare.join("objects")).unwrap();
        std::fs::write(bare.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        assert!(touches_git_config(&s(bare.join("config"))));
        let wt = ws.join("wt-gitdir");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(wt.join("HEAD"), "x\n").unwrap();
        std::fs::write(wt.join("commondir"), "../..\n").unwrap();
        assert!(touches_git_config(&s(wt.join("config.worktree"))));
        let _ = std::fs::remove_dir_all(ws);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_into_git_is_followed() {
        let ws = temp("link");
        std::fs::create_dir_all(ws.join(".git")).unwrap();
        std::os::unix::fs::symlink(ws.join(".git"), ws.join("innocent")).unwrap();
        assert!(touches_git_config(&ws.join("innocent").join("config").to_string_lossy()));
        let _ = std::fs::remove_dir_all(ws);
    }

    #[test]
    fn the_hardened_env_overrides_what_runs() {
        let env = hardened_git_env();
        let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        let base: usize = std::env::var("GIT_CONFIG_COUNT").ok().and_then(|n| n.parse().ok()).unwrap_or(0);
        assert_eq!(get("GIT_CONFIG_COUNT"), Some(Some((base + 3).to_string())));
        let pairs: Vec<(String, String)> = (base..base + 3)
            .map(|i| {
                (
                    get(&format!("GIT_CONFIG_KEY_{i}")).flatten().unwrap(),
                    get(&format!("GIT_CONFIG_VALUE_{i}")).flatten().unwrap(),
                )
            })
            .collect();
        assert!(pairs.contains(&("core.fsmonitor".into(), "false".into())));
        assert!(pairs.contains(&("core.hooksPath".into(), null_device().into())));
        assert!(pairs.contains(&("core.pager".into(), "cat".into())));
        assert_eq!(get("GIT_EXTERNAL_DIFF"), Some(None));
    }
}
