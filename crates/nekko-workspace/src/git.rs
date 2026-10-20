//! Where a workspace folder is in git, for the sidebar's workspace cards,
//! ported from `packages/host/src/git.ts` (`workspace:gitStatus`).
//!
//! One `git status --porcelain=v2 --branch` per read, cached for five
//! seconds and shared by concurrent callers, never an error: a missing git,
//! a folder that is not a repository and a timeout all answer `repo: false`.

use crate::pr::Prs;
use crate::proc::run;
use nekko_js as js;
use regress::Regex;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use crate::now_ms;

/// How long a read stays fresh.
const CACHE_MS: u64 = 5_000;
/// A repository that is slow to stat is not worth blocking a card for.
const TIMEOUT: Duration = Duration::from_secs(5);
/// How long a branch's PR lookup may hold a card's first read.
const PR_WAIT: Duration = Duration::from_secs(3);

/// The answer for a folder with no git position to report.
pub fn not_a_repo(workspace_id: &str) -> Value {
    json!({ "workspaceId": workspace_id, "repo": false, "dirtyCount": 0, "ahead": 0, "behind": 0, "updatedAt": now_ms() })
}

/// `parsePorcelainV2(workspaceId, stdout)`.
pub fn parse_porcelain_v2(workspace_id: &str, stdout: &str) -> Value {
    static AB: OnceLock<Regex> = OnceLock::new();
    let ab = AB.get_or_init(|| Regex::new(r"\+(\d+)\s+-(\d+)").expect("pattern compiles"));
    let mut s = Map::new();
    s.insert("workspaceId".into(), json!(workspace_id));
    s.insert("repo".into(), json!(true));
    s.insert("dirtyCount".into(), json!(0));
    s.insert("ahead".into(), json!(0));
    s.insert("behind".into(), json!(0));
    s.insert("updatedAt".into(), json!(now_ms()));
    let mut dirty = 0u64;
    for line in stdout.split('\n') {
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            let head = js::trim(rest);
            if !head.is_empty() && head != "(detached)" {
                s.insert("branch".into(), json!(head));
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("# branch.oid ") {
            let oid = js::trim(rest);
            if !oid.is_empty() && oid != "(initial)" {
                s.insert("head".into(), json!(js::slice16(oid, 7)));
            }
            continue;
        }
        if line.starts_with("# branch.ab ") {
            if let Some(m) = ab.find(line) {
                let int =
                    |i: usize| m.group(i).map_or(Value::Null, |r| crate::pr::js_num(js::string_to_number(&line[r])));
                s.insert("ahead".into(), int(1));
                s.insert("behind".into(), int(2));
            }
            continue;
        }
        if line.starts_with("# ") || line.starts_with("! ") {
            continue;
        }
        dirty += 1;
    }
    s.insert("dirtyCount".into(), json!(dirty));
    Value::Object(s)
}

/// `trimTrailingSlashes(s, backslash)`.
fn trim_trailing_slashes(s: &str, backslash: bool) -> &str {
    s.trim_end_matches(|c| c == '/' || (backslash && c == '\\'))
}

/// `parseWorktree(stdout, cwd)`: the linked worktree's name and path, or
/// `None` in a main checkout.
pub fn parse_worktree(stdout: &str, cwd: &str) -> Option<Value> {
    let lines: Vec<&str> = stdout.split('\n').map(|l| js::trim(l.strip_suffix('\r').unwrap_or(l))).collect();
    let (git_dir, common, top) = (*lines.first()?, *lines.get(1)?, *lines.get(2)?);
    if git_dir.is_empty() || common.is_empty() || top.is_empty() {
        return None;
    }
    let absolute = |p: &str| {
        let b = p.as_bytes();
        b.first().is_some_and(|c| *c == b'/' || *c == b'\\')
            || (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'/' || b[2] == b'\\'))
    };
    let norm = |p: &str| {
        let abs = if absolute(p) { p.to_string() } else { format!("{}/{p}", trim_trailing_slashes(cwd, true)) };
        trim_trailing_slashes(&abs.replace('\\', "/"), false).to_lowercase()
    };
    if norm(git_dir) == norm(common) {
        return None;
    }
    let path = top.replace('\\', "/");
    let name = path.split('/').rfind(|s| !s.is_empty()).map_or_else(|| path.clone(), str::to_string);
    Some(json!({ "name": name, "path": path }))
}

/// Git status reads, cached and coalesced per folder.
pub struct Git {
    cache: Mutex<HashMap<String, (Value, u64, u64)>>,
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    git_missing: AtomicBool,
    prs: Arc<Prs>,
    git: String,
}

impl Git {
    pub fn new(prs: Arc<Prs>) -> Self {
        Self::with_binary(prs, "git")
    }

    pub fn with_binary(prs: Arc<Prs>, git: &str) -> Self {
        Self {
            cache: Mutex::default(),
            locks: Mutex::default(),
            git_missing: AtomicBool::new(false),
            prs,
            git: git.into(),
        }
    }

    /// `getGitStatus` once the folder is known: `folder` is None for an id
    /// that names no folder (or a chat not provisioned yet).
    pub async fn status(&self, workspace_id: &str, folder: Option<&str>, force: bool) -> Value {
        let Some(path) = folder.filter(|p| !p.is_empty()) else { return not_a_repo(workspace_id) };
        let key = format!("{workspace_id}|{path}");
        let started = crate::read_seq();
        let fresh = |force: bool| {
            self.cache
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&key)
                .cloned()
                .and_then(|(v, at, seq)| ((!force && at + CACHE_MS > now_ms()) || seq > started).then_some(v))
        };
        if let Some(v) = fresh(force) {
            return v;
        }
        let lock = self.locks.lock().unwrap_or_else(|e| e.into_inner()).entry(key.clone()).or_default().clone();
        let _held = lock.lock().await;
        // A read that finished while this one waited is the one it would have joined.
        if let Some(v) = fresh(force) {
            return v;
        }
        let status = self.read(workspace_id, path).await;
        self.cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key, (status.clone(), now_ms(), crate::next_read()));
        status
    }

    /// Forget every cached read of `path` (under any workspace or chat id),
    /// after a commit, stage, switch or push changed it.
    pub fn invalidate(&self, path: &str) {
        let suffix = format!("|{path}");
        self.cache.lock().unwrap_or_else(|e| e.into_inner()).retain(|k, _| !k.ends_with(&suffix));
    }

    async fn read(&self, workspace_id: &str, path: &str) -> Value {
        if self.git_missing.load(Ordering::SeqCst) {
            return not_a_repo(workspace_id);
        }
        let res = run(&self.git, &["status", "--porcelain=v2", "--branch"], TIMEOUT, Some(path), 4 * 1024 * 1024).await;
        if res.missing {
            // A folder that is gone fails the spawn the same way; only a
            // missing binary should stop all further reads.
            if std::path::Path::new(path).is_dir() {
                self.git_missing.store(true, Ordering::SeqCst);
            }
            return not_a_repo(workspace_id);
        }
        if !res.ok {
            return not_a_repo(workspace_id);
        }
        let mut status = parse_porcelain_v2(workspace_id, &res.stdout);
        let wt = run(
            &self.git,
            &["rev-parse", "--git-dir", "--git-common-dir", "--show-toplevel"],
            TIMEOUT,
            Some(path),
            4 * 1024 * 1024,
        )
        .await;
        if wt.ok
            && let Some(w) = parse_worktree(&wt.stdout, path)
        {
            status["worktree"] = w;
        }
        if let Some(branch) = status.get("branch").and_then(Value::as_str).map(str::to_string) {
            // A slow lookup finishes in the background and shows on the next poll.
            let prs = self.prs.clone();
            let (cwd, b) = (path.to_string(), branch.clone());
            let lookup = tokio::spawn(async move { prs.branch_pr(&cwd, &b).await });
            if let Ok(Ok(pr)) = tokio::time::timeout(PR_WAIT, lookup).await
                && !pr.is_null()
            {
                status["pr"] = pr;
            }
        }
        status
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_headers_and_entries() {
        let s = parse_porcelain_v2(
            "w",
            "# branch.oid abcdef0123\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -3\n1 .M N... x\n? new.txt\n! ignored\n",
        );
        assert_eq!(
            (s["branch"].clone(), s["head"].clone(), s["ahead"].clone(), s["behind"].clone(), s["dirtyCount"].clone()),
            (json!("main"), json!("abcdef0"), json!(2), json!(3), json!(2))
        );
        let keys: Vec<_> = s.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, ["workspaceId", "repo", "dirtyCount", "ahead", "behind", "updatedAt", "head", "branch"]);
    }

    #[test]
    fn tells_a_linked_worktree_from_the_main_checkout() {
        assert_eq!(parse_worktree(".git\n.git\n/repo\n", "/repo"), None);
        assert_eq!(
            parse_worktree("C:/repo/.git/worktrees/feat\r\nC:/repo/.git\r\nC:/wt/feat\r\n", "C:\\wt\\feat"),
            Some(json!({ "name": "feat", "path": "C:/wt/feat" }))
        );
    }
}
