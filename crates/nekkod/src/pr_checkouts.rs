//! A workflow run's checkout of a pull request: a detached Git worktree of
//! the project's repository at the PR's head (`git fetch origin
//! pull/<n>/head`), under `<data>/workflow-checkouts/<run>`, removed when the
//! run ends. The user's checkout is never touched: the fetch lands on a ref of
//! the run's own (`refs/nekko-runs/<run>`), deleted with the worktree.
//!
//! The run chat gets the checkout as its `gitWorktrees` record for the folder,
//! the same record a worktree chat keeps, so its tools work in the checkout.

use crate::worktrees::{git, run};
use serde_json::{Value, json};
use std::path::Path;
use std::time::Duration;

/// A first fetch of a PR on a large repository can take a while.
const FETCH_TIMEOUT: Duration = Duration::from_secs(180);

fn checkouts_dir(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join("workflow-checkouts")
}

fn run_ref(run_id: &str) -> String {
    format!("refs/nekko-runs/{run_id}")
}

fn safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Make the checkout for run `run_id` of PR `number` from the repository
/// holding `folder`: the chat's `gitWorktrees` record.
pub fn make(data_dir: &Path, folder: &str, number: &str, run_id: &str) -> Result<Value, String> {
    if !safe_id(run_id) || number.is_empty() || !number.bytes().all(|b| b.is_ascii_digit()) {
        return Err("invalid pull request or run".into());
    }
    let root = git(folder, &["rev-parse", "--show-toplevel"]).map_err(|e| e.message)?;
    let reference = run_ref(run_id);
    let spec = format!("+pull/{number}/head:{reference}");
    let host = remote_host(&git(&root, &["remote", "get-url", "origin"]).unwrap_or_default());
    nekko_net::check("github", &host)?;
    let fetched = run("git", &["fetch", "--no-tags", "origin", &spec], &root, None, FETCH_TIMEOUT);
    let ev = nekko_net::Event::new("request").host(&host);
    let failure = match &fetched {
        Ok((0, _, _)) => None,
        Ok((_, _, err)) => {
            let err = String::from_utf8_lossy(err);
            Some(format!("git fetch origin pull/{number}/head failed: {}", err.trim()))
        }
        Err(e) => Some(e.clone()),
    };
    match failure {
        None => nekko_net::record("github", ev),
        Some(e) => {
            nekko_net::record("github", ev.error(&e));
            return Err(e);
        }
    }
    let base = checkouts_dir(data_dir);
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    let target = base.join(run_id).to_string_lossy().into_owned();
    if let Err(e) = git(&root, &["worktree", "add", "--detach", &target, &reference]) {
        let _ = git(&root, &["update-ref", "-d", &reference]);
        return Err(e.message);
    }
    let sha = git(&target, &["rev-parse", "HEAD"]).unwrap_or_default();
    // The folder may be a subfolder of its repository.
    let sub = Path::new(folder).strip_prefix(&root).map(Path::to_path_buf).unwrap_or_default();
    let path = Path::new(&target).join(sub).to_string_lossy().into_owned();
    let short: String = sha.chars().take(7).collect();
    Ok(json!({
        "path": path,
        "root": target,
        "sourceRoot": root,
        "branch": "",
        "ref": reference,
        "prNumber": number,
        "sha": sha,
        "notice": format!(
            "This run works in a checkout of pull request #{number} at {short}, made for this run and removed when it ends. The user's own checkout is not touched."
        ),
    }))
}

/// Remove a checkout [`make`] returned, and its ref. Best effort: a folder
/// Git no longer knows is deleted outright.
pub fn remove(checkout: &Value) {
    let s = |k: &str| checkout.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let (root, source, reference) = (s("root"), s("sourceRoot"), s("ref"));
    if root.is_empty() {
        return;
    }
    if !source.is_empty() {
        let _ = git(&source, &["worktree", "remove", "--force", &root]);
    }
    if Path::new(&root).exists() {
        let _ = std::fs::remove_dir_all(&root);
    }
    if !source.is_empty() {
        let _ = git(&source, &["worktree", "prune"]);
        if reference.starts_with("refs/nekko-runs/") {
            let _ = git(&source, &["update-ref", "-d", &reference]);
        }
    }
}

/// Checkouts a stopped daemon left behind: each is removed through the
/// repository its `.git` file names (no run is in flight at startup).
pub fn sweep(data_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(checkouts_dir(data_dir)) else { return };
    for e in entries.flatten() {
        let dir = e.path();
        let run_id = e.file_name().to_string_lossy().into_owned();
        // `gitdir: <common>/worktrees/<name>`.
        let common = std::fs::read_to_string(dir.join(".git")).ok().and_then(|t| {
            let gitdir = Path::new(t.trim().strip_prefix("gitdir:")?.trim()).to_path_buf();
            Some(gitdir.parent()?.parent()?.to_path_buf())
        });
        let _ = std::fs::remove_dir_all(&dir);
        if let Some(common) = common {
            let common = common.to_string_lossy().into_owned();
            let _ = git(&common, &["worktree", "prune"]);
            if safe_id(&run_id) {
                let _ = git(&common, &["update-ref", "-d", &run_ref(&run_id)]);
            }
        }
    }
}

/// Where a git remote URL goes: its host, or `localhost` for a path on this computer.
fn remote_host(url: &str) -> String {
    if let Ok(u) = url::Url::parse(url) {
        return u.host_str().unwrap_or("localhost").to_string();
    }
    // scp-like `git@github.com:owner/repo.git`
    match url.split_once(':') {
        Some((h, _)) if !h.is_empty() && !h.contains('/') => h.rsplit('@').next().unwrap_or(h).to_string(),
        _ => "localhost".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn sh(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"])
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn temp(tag: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("nekko-pr-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        let canonical = std::fs::canonicalize(p).unwrap().to_string_lossy().into_owned();
        // Windows canonical paths use a verbatim prefix (`\\?\C:\...`) that Git
        // reads as a network host and refuses to clone from.
        canonical.strip_prefix(r"\\?\").unwrap_or(&canonical).into()
    }

    /// A remote with a PR ref, and the user's clone of it on main.
    fn repos(tag: &str) -> (std::path::PathBuf, std::path::PathBuf, String) {
        let base = temp(tag);
        let (remote, user) = (base.join("remote"), base.join("user"));
        std::fs::create_dir_all(&remote).unwrap();
        sh(&remote, &["init", "-q", "-b", "main"]);
        std::fs::write(remote.join("a.txt"), "main").unwrap();
        sh(&remote, &["add", "."]);
        sh(&remote, &["commit", "-q", "-m", "main"]);
        sh(&remote, &["checkout", "-q", "-b", "feature"]);
        std::fs::write(remote.join("a.txt"), "pr").unwrap();
        sh(&remote, &["commit", "-q", "-am", "pr"]);
        let pr_sha = sh(&remote, &["rev-parse", "HEAD"]);
        sh(&remote, &["update-ref", "refs/pull/7/head", &pr_sha]);
        sh(&remote, &["checkout", "-q", "main"]);
        sh(&base, &["clone", "-q", &remote.to_string_lossy(), "user"]);
        (base, user, pr_sha)
    }

    #[test]
    fn a_checkout_holds_the_pr_head_and_leaves_the_users_checkout_alone() {
        let (base, user, pr_sha) = repos("make");
        let data = base.join("data");
        let c = make(&data, &user.to_string_lossy(), "7", "run-1").unwrap();
        let path = c["path"].as_str().unwrap();
        assert_eq!(std::fs::read_to_string(Path::new(path).join("a.txt")).unwrap(), "pr");
        assert_eq!(c["sha"], json!(pr_sha));
        // The user's checkout: same branch, same file, nothing dirty.
        assert_eq!(std::fs::read_to_string(user.join("a.txt")).unwrap(), "main");
        assert_eq!(sh(&user, &["rev-parse", "--abbrev-ref", "HEAD"]), "main");
        assert_eq!(sh(&user, &["status", "--porcelain"]), "");
        remove(&c);
        assert!(!Path::new(path).exists());
        assert!(!sh(&user, &["worktree", "list"]).contains("run-1"));
        assert!(sh(&user, &["for-each-ref", "refs/nekko-runs"]).is_empty());
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn a_missing_pr_fails_cleanly() {
        let (base, user, _) = repos("missing");
        let data = base.join("data");
        let err = make(&data, &user.to_string_lossy(), "999", "run-2").unwrap_err();
        assert!(err.contains("pull/999/head"), "{err}");
        assert!(make(&data, &user.to_string_lossy(), "7; rm -rf /", "run-3").is_err());
        assert!(make(&data, &user.to_string_lossy(), "7", "../escape").is_err());
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn a_left_over_checkout_is_swept() {
        let (base, user, _) = repos("sweep");
        let data = base.join("data");
        let c = make(&data, &user.to_string_lossy(), "7", "run-4").unwrap();
        sweep(&data);
        assert!(!Path::new(c["root"].as_str().unwrap()).exists());
        assert!(!sh(&user, &["worktree", "list"]).contains("run-4"));
        assert!(sh(&user, &["for-each-ref", "refs/nekko-runs"]).is_empty());
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn remote_host_reads_every_remote_form() {
        assert_eq!(remote_host("https://github.com/o/r.git"), "github.com");
        assert_eq!(remote_host("ssh://git@gitlab.example.com/o/r"), "gitlab.example.com");
        assert_eq!(remote_host("git@github.com:o/r.git"), "github.com");
        assert_eq!(remote_host("/tmp/remote"), "localhost");
        assert_eq!(remote_host(""), "localhost");
    }
}
