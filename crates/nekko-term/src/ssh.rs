//! SSH sessions as terminals (`ssh:hosts`, `ssh:open`).
//!
//! The hosts come from the computer's own `~/.ssh/config`: the `Host` aliases
//! that name one host (patterns such as `*` or `*.example.com` are skipped),
//! with `HostName`, `User` and `Port` for display. Nothing else is read out of
//! the config, and no key, `IdentityFile` or agent socket is ever touched or
//! returned: the session runs the system `ssh` binary in a pty, so the keys and
//! the agent stay on the computer and only terminal bytes leave it.
//!
//! `Include` is followed (relative paths from `~/.ssh`, `~` expanded, `*` and
//! `?` in the file name only, eight levels deep at most). `Match` blocks are
//! skipped: their conditions can only be judged by `ssh` itself.

use crate::shells::ShellOption;
use serde::Serialize;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// One host alias from the SSH config. The extra fields are for display only;
/// `ssh` resolves the alias itself when it connects.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHost {
    pub alias: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
}

/// Config files larger than this are not read (a config is a few kilobytes).
const MAX_CONFIG: u64 = 1024 * 1024;
const MAX_INCLUDE_DEPTH: usize = 8;

/// The hosts in `<home>/.ssh/config`, in file order; empty when there is none.
pub fn read_ssh_hosts(home: &Path) -> Vec<SshHost> {
    let path = home.join(".ssh").join("config");
    match read_config(&path) {
        Some(text) => parse_ssh_config(&text, home),
        None => Vec::new(),
    }
}

/// Parse a config's text; `home` resolves `~` and relative `Include` paths.
pub fn parse_ssh_config(text: &str, home: &Path) -> Vec<SshHost> {
    let mut hosts = Vec::new();
    let mut current = Vec::new();
    parse_into(text, home, 0, &mut hosts, &mut current);
    hosts
}

fn read_config(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_CONFIG {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

fn parse_into(text: &str, home: &Path, depth: usize, hosts: &mut Vec<SshHost>, current: &mut Vec<usize>) {
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (keyword, rest) = split_keyword(line);
        let args = split_args(rest);
        match keyword.to_ascii_lowercase().as_str() {
            "host" => {
                current.clear();
                for alias in args.iter().filter(|a| is_plain_alias(a)) {
                    let at = match hosts.iter().position(|h| &h.alias == alias) {
                        Some(i) => i,
                        None => {
                            hosts.push(SshHost { alias: alias.clone(), host_name: None, user: None, port: None });
                            hosts.len() - 1
                        }
                    };
                    if !current.contains(&at) {
                        current.push(at);
                    }
                }
            }
            "match" => current.clear(),
            // As in ssh, the first value obtained for a host wins.
            "hostname" => set_first(hosts, current, args.first(), |h| &mut h.host_name),
            "user" => set_first(hosts, current, args.first(), |h| &mut h.user),
            "port" => {
                if let Some(port) = args.first().and_then(|p| p.parse::<u16>().ok()) {
                    for &i in current.iter() {
                        hosts[i].port.get_or_insert(port);
                    }
                }
            }
            "include" if depth < MAX_INCLUDE_DEPTH => {
                for pattern in &args {
                    for file in include_files(pattern, home) {
                        if let Some(text) = read_config(&file) {
                            // An Include inside a Host block applies to that block;
                            // whatever block the included file ends in stays there.
                            let mut inner = current.clone();
                            parse_into(&text, home, depth + 1, hosts, &mut inner);
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

fn set_first(
    hosts: &mut [SshHost],
    current: &[usize],
    value: Option<&String>,
    field: fn(&mut SshHost) -> &mut Option<String>,
) {
    let Some(value) = value else { return };
    for &i in current {
        field(&mut hosts[i]).get_or_insert_with(|| value.clone());
    }
}

/// `Keyword args` or `Keyword=args`.
fn split_keyword(line: &str) -> (&str, &str) {
    let end = line.find(|c: char| c.is_whitespace() || c == '=').unwrap_or(line.len());
    let (keyword, rest) = line.split_at(end);
    let rest = rest.trim_start();
    let rest = rest.strip_prefix('=').unwrap_or(rest).trim_start();
    (keyword, rest)
}

/// Whitespace-separated arguments, double quotes grouping.
fn split_args(rest: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut any = false;
    for c in rest.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                any = true;
            }
            c if c.is_whitespace() && !quoted => {
                if any {
                    out.push(std::mem::take(&mut cur));
                    any = false;
                }
            }
            '#' if !quoted && !any => break,
            c => {
                cur.push(c);
                any = true;
            }
        }
    }
    if any {
        out.push(cur);
    }
    out
}

/// One host, usable as an `ssh` destination argument: no pattern characters,
/// no negation, nothing that reads as an option, no controls or spaces.
fn is_plain_alias(alias: &str) -> bool {
    !alias.is_empty()
        && !alias.starts_with('-')
        && !alias.chars().any(|c| matches!(c, '*' | '?' | '!' | ',') || c.is_whitespace() || c.is_control())
}

fn include_files(pattern: &str, home: &Path) -> Vec<PathBuf> {
    let path = if let Some(rest) = pattern.strip_prefix("~/") {
        home.join(rest)
    } else if Path::new(pattern).is_absolute() {
        PathBuf::from(pattern)
    } else {
        home.join(".ssh").join(pattern)
    };
    let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else { return Vec::new() };
    if !name.contains(['*', '?']) {
        return vec![path];
    }
    let Some(dir) = path.parent() else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut files: Vec<PathBuf> =
        entries.flatten().filter(|e| wildcard(&name, &e.file_name().to_string_lossy())).map(|e| e.path()).collect();
    files.sort();
    files
}

/// `*` and `?` matching, for `Include` file names.
fn wildcard(pattern: &str, name: &str) -> bool {
    let (p, n): (Vec<char>, Vec<char>) = (pattern.chars().collect(), name.chars().collect());
    let (mut pi, mut ni) = (0, 0);
    let (mut star, mut mark) = (None, 0);
    while ni < n.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == n[ni]) {
            pi += 1;
            ni += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ni;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ni = mark;
        } else {
            return false;
        }
    }
    p[pi..].iter().all(|&c| c == '*')
}

/// The system `ssh` binary: the first on `PATH`, else a usual install path.
/// `ssh.exe` (Windows' OpenSSH client) on Windows.
pub fn find_ssh() -> Option<PathBuf> {
    let fallbacks: Vec<PathBuf> = if cfg!(windows) {
        let sys = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        vec![PathBuf::from(format!(r"{sys}\System32\OpenSSH\ssh.exe"))]
    } else {
        ["/usr/bin/ssh", "/usr/local/bin/ssh", "/opt/homebrew/bin/ssh", "/bin/ssh"].iter().map(PathBuf::from).collect()
    };
    find_ssh_in(std::env::var_os("PATH"), if cfg!(windows) { "ssh.exe" } else { "ssh" }, &fallbacks)
}

fn find_ssh_in(path_var: Option<OsString>, name: &str, fallbacks: &[PathBuf]) -> Option<PathBuf> {
    let on_path = path_var.iter().flat_map(std::env::split_paths).map(|dir| dir.join(name));
    on_path.chain(fallbacks.iter().cloned()).find(|p| p.is_file())
}

/// What `ssh:open` runs: `ssh -o BatchMode=no -- <alias>`, the alias one argv
/// entry of its own (never a shell string), and only an alias the config
/// lists. `ssh` is `None` when the binary was not found.
pub fn ssh_shell(hosts: &[SshHost], alias: &str, ssh: Option<&Path>) -> Result<ShellOption, String> {
    if !hosts.iter().any(|h| h.alias == alias) || !is_plain_alias(alias) {
        return Err(format!("\"{alias}\" is not a host in this computer's SSH config (~/.ssh/config)."));
    }
    let Some(ssh) = ssh else {
        return Err("ssh is not installed on this computer: no ssh program was found on its PATH.".into());
    };
    Ok(ShellOption {
        id: "ssh".into(),
        label: format!("ssh {alias}"),
        path: ssh.to_string_lossy().into_owned(),
        args: Some(vec!["-o".into(), "BatchMode=no".into(), "--".into(), alias.into()]),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nekko-term-ssh-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join(".ssh")).unwrap();
        d
    }

    fn host(alias: &str, host_name: Option<&str>, user: Option<&str>, port: Option<u16>) -> SshHost {
        SshHost { alias: alias.into(), host_name: host_name.map(Into::into), user: user.map(Into::into), port }
    }

    const CONFIG: &str = r#"
# Global defaults
User fallback-nobody

Host devbox
    HostName 10.0.0.5
    User philip
    Port 2222
    IdentityFile ~/.ssh/id_devbox

Host *
    ServerAliveInterval 30

Host gpu gpu-2 *.internal !bad
  HostName=gpu.example.com
  User = ml

host   "quoted"   # trailing comment
    port 22

Match host devbox exec "true"
    User someone-else

Host -oProxyCommand=evil
    HostName evil

Host devbox
    User second-wins-not
"#;

    #[test]
    fn parses_host_aliases_and_display_fields_only() {
        let hosts = parse_ssh_config(CONFIG, Path::new("/nonexistent"));
        assert_eq!(
            hosts,
            vec![
                host("devbox", Some("10.0.0.5"), Some("philip"), Some(2222)),
                host("gpu", Some("gpu.example.com"), Some("ml"), None),
                host("gpu-2", Some("gpu.example.com"), Some("ml"), None),
                host("quoted", None, None, Some(22)),
            ]
        );
        // Nothing from IdentityFile, no patterns, no option-looking alias.
        let json = serde_json::to_string(&hosts).unwrap();
        assert!(!json.contains("id_devbox"), "{json}");
        assert!(!json.contains("evil") && !json.contains("internal"), "{json}");
        assert!(json.contains(r#""hostName":"10.0.0.5""#), "{json}");
    }

    #[test]
    fn follows_includes_relative_to_the_ssh_folder_with_globs() {
        let home = temp("include");
        let ssh = home.join(".ssh");
        std::fs::create_dir_all(ssh.join("conf.d")).unwrap();
        std::fs::write(ssh.join("conf.d/a.conf"), "Host alpha\n  HostName a.example\n").unwrap();
        std::fs::write(ssh.join("conf.d/b.conf"), "Host beta\n  User b\n").unwrap();
        std::fs::write(ssh.join("conf.d/notes.txt"), "Host never\n").unwrap();
        std::fs::write(home.join("extra"), "Host gamma\n").unwrap();
        // Includes itself: the depth limit stops it.
        std::fs::write(ssh.join("loop"), "Include loop\nHost looped\n").unwrap();
        std::fs::write(
            ssh.join("config"),
            "Include conf.d/*.conf ~/extra\nInclude loop\nInclude missing-file\nHost local\n",
        )
        .unwrap();
        let aliases: Vec<String> = read_ssh_hosts(&home).into_iter().map(|h| h.alias).collect();
        assert_eq!(aliases, ["alpha", "beta", "gamma", "looped", "local"]);
        assert_eq!(read_ssh_hosts(&home.join("nobody")), vec![]);
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn wildcards_match_file_names() {
        assert!(wildcard("*.conf", "a.conf"));
        assert!(wildcard("h?st", "host"));
        assert!(!wildcard("*.conf", "a.txt"));
        assert!(wildcard("*", ""));
    }

    #[test]
    fn the_command_passes_the_alias_as_its_own_argument() {
        let hosts = vec![host("devbox", None, None, None)];
        let shell = ssh_shell(&hosts, "devbox", Some(Path::new("/usr/bin/ssh"))).unwrap();
        assert_eq!(shell.path, "/usr/bin/ssh");
        assert_eq!(shell.label, "ssh devbox");
        assert_eq!(shell.args.unwrap(), ["-o", "BatchMode=no", "--", "devbox"]);
    }

    #[test]
    fn only_listed_aliases_are_accepted() {
        let hosts = vec![host("devbox", None, None, None)];
        let ssh = Some(Path::new("/usr/bin/ssh"));
        for bad in ["other", "devbox; rm -rf ~", "-oProxyCommand=x", "", "devbox "] {
            let err = ssh_shell(&hosts, bad, ssh).unwrap_err();
            assert!(err.contains("not a host"), "{bad}: {err}");
        }
        // Even a listed alias must be a plain one (a hand-built list could hold anything).
        let odd = vec![host("-x", None, None, None)];
        assert!(ssh_shell(&odd, "-x", ssh).is_err());
    }

    #[test]
    fn a_missing_ssh_binary_is_a_clear_error() {
        let hosts = vec![host("devbox", None, None, None)];
        let err = ssh_shell(&hosts, "devbox", None).unwrap_err();
        assert!(err.contains("ssh is not installed"), "{err}");
    }

    #[test]
    fn finds_ssh_on_the_path_then_the_fallbacks() {
        let dir = temp("find");
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("ssh"), "").unwrap();
        let path = std::env::join_paths([dir.join("empty"), bin.clone()]).unwrap();
        assert_eq!(find_ssh_in(Some(path), "ssh", &[]), Some(bin.join("ssh")));
        let fallback = bin.join("ssh");
        assert_eq!(find_ssh_in(None, "ssh", std::slice::from_ref(&fallback)), Some(fallback));
        assert_eq!(find_ssh_in(None, "ssh", &[dir.join("nope")]), None);
        let _ = std::fs::remove_dir_all(dir);
    }
}
