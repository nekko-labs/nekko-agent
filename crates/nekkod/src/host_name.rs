//! The name people gave this computer, for showing it to them. A Mac's POSIX
//! hostname is its LocalHostName ("MacBookPro"), with the spaces and
//! apostrophes of "Philip's MacBook Pro" stripped; that one stays the network
//! name (mDNS host records, pairing addresses) and this one is display-only.

use std::sync::Mutex;
use std::time::{Duration, Instant};

/// The raw hostname without a trailing `.local`.
pub fn raw_host_name() -> String {
    gethostname::gethostname().to_string_lossy().trim_end_matches(".local").to_string()
}

/// The friendly name, re-read at most once a minute so a rename shows up
/// without a restart and callers on a hot path spawn no process.
pub fn friendly_host_name() -> String {
    static CACHE: Mutex<Option<(Instant, String)>> = Mutex::new(None);
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, name)) = cache.as_ref()
        && at.elapsed() < Duration::from_secs(60)
    {
        return name.clone();
    }
    let name = pick(pretty_name(), &raw_host_name());
    *cache = Some((Instant::now(), name.clone()));
    name
}

#[cfg(target_os = "macos")]
fn pretty_name() -> Option<String> {
    let out = std::process::Command::new("/usr/sbin/scutil").args(["--get", "ComputerName"]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    parse_scutil(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(target_os = "linux")]
fn pretty_name() -> Option<String> {
    parse_machine_info(&std::fs::read_to_string("/etc/machine-info").ok()?)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn pretty_name() -> Option<String> {
    None
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
/// `scutil --get ComputerName` prints the name and a newline.
pub(crate) fn parse_scutil(out: &str) -> Option<String> {
    clean(out)
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
/// `PRETTY_HOSTNAME=` from `/etc/machine-info` (what `hostnamectl --pretty`
/// reads): shell-style, optionally quoted, with backslash escapes.
pub(crate) fn parse_machine_info(contents: &str) -> Option<String> {
    let value = contents.lines().find_map(|l| l.trim().strip_prefix("PRETTY_HOSTNAME="))?;
    let value = value.trim();
    let unquoted = match value.chars().next() {
        Some(q @ ('"' | '\'')) if value.len() >= 2 && value.ends_with(q) => &value[1..value.len() - 1],
        _ => value,
    };
    let mut out = String::new();
    let mut chars = unquoted.chars();
    while let Some(c) = chars.next() {
        out.push(if c == '\\' { chars.next().unwrap_or('\\') } else { c });
    }
    clean(&out)
}

#[cfg_attr(not(any(target_os = "macos", target_os = "linux")), allow(dead_code))]
fn clean(s: &str) -> Option<String> {
    let name: String = s.chars().filter(|c| !c.is_control()).collect::<String>().trim().to_string();
    (!name.is_empty()).then_some(name)
}

/// The friendly name when there is one, else the hostname.
pub(crate) fn pick(pretty: Option<String>, raw: &str) -> String {
    pretty.unwrap_or_else(|| raw.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scutil_output_keeps_spaces_and_apostrophes() {
        assert_eq!(parse_scutil("Philip’s MacBook Pro\n").as_deref(), Some("Philip’s MacBook Pro"));
        assert_eq!(parse_scutil("  \n"), None);
        assert_eq!(parse_scutil(""), None);
    }

    #[test]
    fn machine_info_reads_quoted_unquoted_and_escaped_names() {
        assert_eq!(
            parse_machine_info("CHASSIS=laptop\nPRETTY_HOSTNAME=\"Ada's Laptop\"\n").as_deref(),
            Some("Ada's Laptop")
        );
        assert_eq!(parse_machine_info("PRETTY_HOSTNAME='Work box'").as_deref(), Some("Work box"));
        assert_eq!(parse_machine_info("PRETTY_HOSTNAME=Studio").as_deref(), Some("Studio"));
        assert_eq!(parse_machine_info("PRETTY_HOSTNAME=\"Say \\\"hi\\\"\"").as_deref(), Some("Say \"hi\""));
        assert_eq!(parse_machine_info("PRETTY_HOSTNAME=\"\""), None);
        assert_eq!(parse_machine_info("ICON_NAME=computer-laptop"), None);
    }

    #[test]
    fn falls_back_to_the_hostname() {
        assert_eq!(pick(None, "MacBookPro"), "MacBookPro");
        assert_eq!(pick(Some("Philip's MacBook Pro".into()), "MacBookPro"), "Philip's MacBook Pro");
    }
}
