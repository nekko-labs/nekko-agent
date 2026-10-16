//! `shell:openPath` and revealing a file, as Electron main did them:
//! an `http(s)` URL goes to the default browser (`shell.openExternal`, whose
//! failure the caller hears), anything else to the system's default handler
//! (`shell.openPath`, which never threw: a missing file is ignored).

use std::path::Path;

/// `/^https?:\/\//i`.
pub fn is_web_url(target: &str) -> bool {
    let lower = target.get(..8).unwrap_or(target).to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// `shell.openExternal(url)`.
pub fn open_external(url: &str) -> Result<(), String> {
    opener::open(url).map_err(|e| format!("Failed to open: {e}"))
}

/// `shell:openPath`: the browser for a web URL (errors reported), the
/// default app for anything else (errors swallowed, as `openPath` did).
pub fn open_path(target: &str) -> Result<(), String> {
    if is_web_url(target) {
        return open_external(target);
    }
    if !target.is_empty() {
        let _ = opener::open(target);
    }
    Ok(())
}

/// `shell.showItemInFolder(path)`: the containing folder with the item
/// selected where the platform can (Explorer, Finder), else the folder.
pub fn reveal(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if !p.exists() {
        return Err(format!("{path} does not exist"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // explorer.exe exits 1 even when it worked; only a spawn failure counts.
        std::process::Command::new("explorer.exe")
            .raw_arg(format!("/select,\"{}\"", path.replace('"', "")))
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/open").arg("-R").arg(p).spawn().map(|_| ()).map_err(|e| e.to_string())
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let dir = if p.is_dir() { p } else { p.parent().unwrap_or(p) };
        opener::open(dir).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_urls_are_told_apart_like_the_ts_regex() {
        for yes in ["http://x", "HTTPS://x", "https://github.com/a/b"] {
            assert!(is_web_url(yes), "{yes}");
        }
        for no in ["C:\\x", "/tmp/x", "file:///x", "ms-settings:privacy", "httpx://y", "", "https:/x"] {
            assert!(!is_web_url(no), "{no}");
        }
    }

    #[test]
    fn an_empty_or_missing_path_is_not_an_error() {
        assert_eq!(open_path(""), Ok(()));
        assert!(reveal("/definitely/not/here/nekko").is_err());
    }
}
