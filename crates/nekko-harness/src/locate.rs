//! Finding the user's installed `claude` and its version.

use std::path::{Path, PathBuf};
use std::time::Duration;

/// The oldest Claude Code this harness drives. The stream-json interrupt and
/// the multi-turn stdin it relies on were verified on 2.1.284 (H0).
pub const MIN_VERSION: (u32, u32, u32) = (2, 1, 0);

/// How long `--version` and `auth status` may take before we give up.
pub(crate) const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

/// The `claude` binary Nekko will run, as installed by the user.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeBin {
    /// An absolute path. On Windows an npm install is a `claude.cmd` shim,
    /// which Rust spawns through `cmd.exe` itself (with its own escaping).
    pub path: PathBuf,
    /// `2.1.284`, from `claude --version`.
    pub version: String,
}

/// A `Command` for the binary that never opens a console window and starts
/// its own process group, so Stop can end the whole tree.
pub(crate) fn command(path: &Path) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(path);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        cmd.process_group(0);
    }
    cmd
}

/// `2.1.284 (Claude Code)` → `2.1.284`.
pub fn parse_version(out: &str) -> Option<(String, (u32, u32, u32))> {
    let word = out.split_whitespace().next()?;
    let mut parts = word.split('.').map(|p| p.parse::<u32>().ok());
    let triple = (parts.next()??, parts.next()??, parts.next().flatten().unwrap_or(0));
    Some((word.to_string(), triple))
}

/// Of `where.exe claude`'s answers, the one Windows can start: a native
/// `claude.exe` first, then npm's `claude.cmd`. The extensionless `claude`
/// npm also writes is a shell script for Git Bash and cannot be spawned.
pub fn pick_windows_candidate(where_output: &str) -> Option<PathBuf> {
    let lines: Vec<&str> = where_output.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let with = |ext: &str| lines.iter().find(|l| l.to_ascii_lowercase().ends_with(ext)).map(PathBuf::from);
    with(".exe").or_else(|| with(".cmd"))
}

/// Whether `path` is a regular file its owner, group or others may execute
/// (non-Windows).
#[cfg(not(windows))]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// Every `claude` on PATH, in PATH order (non-Windows).
#[cfg(not(windows))]
fn path_candidates() -> Vec<PathBuf> {
    let Some(path) = std::env::var_os("PATH") else { return Vec::new() };
    std::env::split_paths(&path).map(|dir| dir.join("claude")).filter(|p| is_executable(p)).collect()
}

/// Where Claude Code is usually installed, in the order they are tried, for
/// when PATH does not lead to it. On macOS an app started from the Dock or
/// Finder gets a minimal PATH that leaves out `~/.local/bin`, which is where
/// Anthropic's official installer puts `claude`, so a working install would
/// otherwise read as "not installed".
#[cfg(not(windows))]
fn install_candidates(home: &Path) -> Vec<PathBuf> {
    vec![
        // The official installer (`curl -fsSL https://claude.ai/install.sh | bash`).
        home.join(".local/bin/claude"),
        // Older local installs made by Claude Code itself.
        home.join(".claude/local/claude"),
        // Homebrew on Apple silicon, then Homebrew on Intel and manual installs.
        PathBuf::from("/opt/homebrew/bin/claude"),
        PathBuf::from("/usr/local/bin/claude"),
    ]
}

/// The first executable `claude` in the usual install folders (non-Windows).
#[cfg(not(windows))]
fn install_folder_candidate() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    install_candidates(Path::new(&home)).into_iter().find(|p| is_executable(p))
}

/// The user's `claude`: from PATH first, and on macOS and Linux from the usual
/// install folders when PATH does not lead to one.
async fn find_on_path() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let mut cmd = command(Path::new("where.exe"));
        cmd.arg("claude").stdin(std::process::Stdio::null());
        let out = tokio::time::timeout(PROBE_TIMEOUT, cmd.output()).await.ok()?.ok()?;
        pick_windows_candidate(&String::from_utf8_lossy(&out.stdout))
    }
    #[cfg(not(windows))]
    {
        path_candidates().into_iter().next().or_else(install_folder_candidate)
    }
}

/// Find the user's `claude` (`bin_path` when the user set one, else PATH, then
/// the usual install folders), read its version and check it is new enough.
/// The error is the sentence the setup screen shows.
pub async fn locate(bin_path: Option<&Path>) -> Result<ClaudeBin, String> {
    let path = match bin_path {
        Some(p) if p.is_file() => p.to_path_buf(),
        Some(p) => return Err(format!("Claude Code was not found at {}.", p.display())),
        None => find_on_path().await.ok_or("Claude Code is not installed, or `claude` is not on PATH.")?,
    };
    let mut cmd = command(&path);
    cmd.arg("--version").stdin(std::process::Stdio::null());
    let out = tokio::time::timeout(PROBE_TIMEOUT, cmd.output())
        .await
        .map_err(|_| "`claude --version` did not answer.".to_string())?
        .map_err(|e| format!("Could not run {}: {e}", path.display()))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let (version, triple) =
        parse_version(&text).ok_or_else(|| format!("Could not read Claude Code's version from {:?}.", text.trim()))?;
    if triple < MIN_VERSION {
        let (a, b, c) = MIN_VERSION;
        return Err(format!("Claude Code {version} is too old. Update it to {a}.{b}.{c} or newer (`claude update`)."));
    }
    Ok(ClaudeBin { path, version })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_version_line() {
        let (v, t) = parse_version("2.1.284 (Claude Code)\n").unwrap();
        assert_eq!((v.as_str(), t), ("2.1.284", (2, 1, 284)));
        assert!(t >= MIN_VERSION);
        assert_eq!(parse_version("1.0.3 (Claude Code)").unwrap().1, (1, 0, 3));
        assert!(parse_version("").is_none());
        assert!(parse_version("Claude Code").is_none());
    }

    #[test]
    fn picks_a_spawnable_windows_shim() {
        let out =
            "C:\\Users\\me\\AppData\\Roaming\\npm\\claude\r\nC:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd\r\n";
        assert_eq!(
            pick_windows_candidate(out),
            Some(PathBuf::from("C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd"))
        );
        let both = "C:\\a\\claude.cmd\nC:\\b\\claude.exe\n";
        assert_eq!(pick_windows_candidate(both), Some(PathBuf::from("C:\\b\\claude.exe")));
        assert_eq!(pick_windows_candidate("C:\\a\\claude\n"), None);
        assert_eq!(pick_windows_candidate(""), None);
    }

    #[cfg(not(windows))]
    #[test]
    fn tries_the_official_installer_folder_first() {
        let c = install_candidates(Path::new("/Users/me"));
        assert_eq!(c[0], PathBuf::from("/Users/me/.local/bin/claude"));
        assert!(c.contains(&PathBuf::from("/Users/me/.claude/local/claude")));
        assert!(c.contains(&PathBuf::from("/opt/homebrew/bin/claude")));
        assert!(c.contains(&PathBuf::from("/usr/local/bin/claude")));
    }

    #[cfg(not(windows))]
    #[test]
    fn only_an_executable_file_counts() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("nekko-locate-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("claude");
        std::fs::write(&file, "#!/bin/sh\n").unwrap();

        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(!is_executable(&file), "a file without an execute bit is not a candidate");

        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(is_executable(&file));

        assert!(!is_executable(&dir), "a directory is not a candidate");
        assert!(!is_executable(&dir.join("missing")));

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
