//! Git for the user's own hands (IO-33 FA-2): diff, history, branches and
//! compare, then stage, commit, push, switch and abort a merge, in one
//! workspace folder. The desktop calls these now; the phone will, through
//! its access gate, later.
//!
//! Every call runs `git` directly with an argument vector (never a shell
//! string), in the workspace's folder, under a timeout, with
//! `GIT_TERMINAL_PROMPT=0` so a missing credential fails instead of waiting
//! for a terminal nobody sees. Paths are relative to the folder and may not
//! leave it; they are passed as literal pathspecs after `--`. Diffs are
//! capped per file and in total, and binary files are summarized. Nothing
//! here force-pushes, amends, or skips hooks.

use nekko_js as js;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};

/// Files a diff lists before it says it stopped.
pub const MAX_FILES: usize = 300;
/// Lines of one file's patch before it is cut.
pub const MAX_PATCH_LINES: usize = 500;
/// Bytes of patch text across a whole diff; later files list without one.
pub const MAX_PATCH_BYTES: usize = 512 * 1024;
/// Bytes read from `git diff` before the rest is dropped.
const MAX_READ: usize = 8 * 1024 * 1024;
/// Bytes of an untracked file read to show it as added.
const MAX_UNTRACKED_READ: usize = 256 * 1024;
/// Commits a log or compare returns at most.
pub const MAX_LOG: usize = 200;
/// Characters of staged diff a commit message is written from.
pub const MAX_MESSAGE_INPUT: usize = 24_000;
const MAX_COMMIT_MESSAGE: usize = 20_000;

const READ_TIMEOUT: Duration = Duration::from_secs(20);
const DIFF_TIMEOUT: Duration = Duration::from_secs(30);
const WRITE_TIMEOUT: Duration = Duration::from_secs(30);
/// Commit hooks (lint, tests) can take a while.
const COMMIT_TIMEOUT: Duration = Duration::from_secs(120);
const PUSH_TIMEOUT: Duration = Duration::from_secs(120);
const SWITCH_TIMEOUT: Duration = Duration::from_secs(60);

/// One finished `git` call.
#[derive(Debug, Default, Clone)]
pub struct Run {
    pub ok: bool,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub missing: bool,
    pub timed_out: bool,
    /// Stdout went past the read cap and the process was stopped.
    pub truncated: bool,
}

impl Run {
    /// What to tell the user when the call failed: git's own words, trimmed.
    pub fn error(&self, what: &str) -> String {
        if self.missing {
            return "Git is not installed on this computer.".into();
        }
        if self.timed_out {
            return format!("{what} took too long and was stopped.");
        }
        let text = if !js::trim(&self.stderr).is_empty() { &self.stderr } else { &self.stdout };
        let text = js::trim(text);
        if text.is_empty() {
            return format!("{what} failed.");
        }
        let lines: Vec<&str> = text.lines().map(str::trim_end).filter(|l| !l.is_empty()).take(8).collect();
        js::slice16(&lines.join("\n"), 800).to_string()
    }
}

async fn drain<R: AsyncRead + Unpin>(mut r: R, cap: usize, stop: bool) -> (Vec<u8>, bool) {
    let mut out = Vec::new();
    // On the heap: a buffer here would sit in every caller's future.
    let mut buf = vec![0u8; 16 * 1024];
    let mut over = false;
    loop {
        match r.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let room = cap.saturating_sub(out.len());
                out.extend_from_slice(&buf[..n.min(room)]);
                if n > room {
                    over = true;
                    if stop {
                        break;
                    }
                }
            }
        }
    }
    (out, over)
}

/// Run `git args` in `dir`: no shell, no window, no prompts, at most
/// `timeout`, at most `max` bytes of stdout (then the process is stopped and
/// the result marked truncated).
pub async fn exec(bin: &str, dir: &str, args: &[&str], env: &[(&str, &str)], timeout: Duration, max: usize) -> Run {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(["-c", "color.ui=never", "-c", "core.quotepath=off", "-c", "advice.detachedHead=false"])
        .args(args)
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("GIT_PAGER", "cat")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if std::env::var_os("GIT_SSH_COMMAND").is_none() && std::env::var_os("GIT_SSH").is_none() {
        // An SSH passphrase or host-key question would wait for a terminal.
        cmd.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let missing = e.kind() == std::io::ErrorKind::NotFound && std::path::Path::new(dir).is_dir();
            let stderr = if missing { String::new() } else { format!("Could not run git in {dir}: {e}") };
            return Run { missing, stderr, ..Default::default() };
        }
    };
    let (out, err) = (child.stdout.take(), child.stderr.take());
    let work = async {
        let read_o = async {
            match out {
                Some(s) => drain(s, max, true).await,
                None => (Vec::new(), false),
            }
        };
        let read_e = async {
            match err {
                Some(s) => drain(s, 64 * 1024, false).await.0,
                None => Vec::new(),
            }
        };
        let ((o, over), e) = tokio::join!(read_o, read_e);
        if over {
            let _ = child.start_kill();
        }
        let status = child.wait().await;
        (o, over, e, status)
    };
    match tokio::time::timeout(timeout, work).await {
        Ok((o, over, e, status)) => {
            let code = status.as_ref().ok().and_then(std::process::ExitStatus::code);
            Run {
                ok: !over && status.is_ok_and(|s| s.success()),
                code,
                stdout: String::from_utf8_lossy(&o).into_owned(),
                stderr: String::from_utf8_lossy(&e).into_owned(),
                missing: false,
                timed_out: false,
                truncated: over,
            }
        }
        Err(_) => Run { timed_out: true, ..Default::default() },
    }
}

/// A path the caller named, checked: relative to the workspace folder and
/// inside it. Absolute paths, drive letters and `..` are refused.
pub fn safe_path(p: &str) -> Result<String, String> {
    let bad = |why: &str| Err(format!("Refused path {p:?}: {why}."));
    if p.is_empty() {
        return bad("empty");
    }
    if p.contains('\0') || p.chars().any(|c| c.is_control()) {
        return bad("control characters");
    }
    let b = p.as_bytes();
    if b[0] == b'/' || b[0] == b'\\' {
        return bad("absolute paths are not allowed");
    }
    if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        return bad("absolute paths are not allowed");
    }
    if p.split(['/', '\\']).any(|seg| seg == "..") {
        return bad("it leaves the workspace");
    }
    Ok(p.to_string())
}

/// Check every path, refusing the whole call on the first bad one.
pub fn safe_paths(paths: &[String]) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Err("Name at least one file.".into());
    }
    if paths.len() > 1000 {
        return Err("Too many files in one call (at most 1000).".into());
    }
    paths.iter().map(|p| safe_path(p)).collect()
}

/// A revision the caller named (a branch, tag, sha or `HEAD~2`): never an
/// option, never a range.
pub fn safe_ref(r: &str) -> Result<String, String> {
    let t = r.trim();
    if t.is_empty() {
        return Err("Name a branch or commit.".into());
    }
    if t.starts_with('-') || t.contains("..") || t.chars().any(|c| c.is_control() || c.is_whitespace()) || t.len() > 256
    {
        return Err(format!("Refused revision {r:?}."));
    }
    Ok(t.to_string())
}

/// `{ path?, staged?, base? }` for `git:diff`.
#[derive(Debug, Default, Clone)]
pub struct DiffOpts {
    pub path: Option<String>,
    pub staged: bool,
    pub base: Option<String>,
}

impl DiffOpts {
    pub fn from_json(v: Option<&Value>) -> Result<Self, String> {
        let get = |k: &str| v.and_then(|o| o.get(k)).and_then(Value::as_str).filter(|s| !s.is_empty());
        Ok(Self {
            path: get("path").map(safe_path).transpose()?,
            staged: v.and_then(|o| o.get("staged")).and_then(Value::as_bool).unwrap_or(false),
            base: get("base").map(safe_ref).transpose()?,
        })
    }
}

/// `{ ref?, limit?, skip?, path? }` for `git:log`.
#[derive(Debug, Clone)]
pub struct LogOpts {
    pub rev: Option<String>,
    pub limit: usize,
    pub skip: usize,
    pub path: Option<String>,
}

impl LogOpts {
    pub fn from_json(v: Option<&Value>) -> Result<Self, String> {
        let get = |k: &str| v.and_then(|o| o.get(k)).and_then(Value::as_str).filter(|s| !s.is_empty());
        let num = |k: &str| v.and_then(|o| o.get(k)).and_then(Value::as_u64).map(|n| n as usize);
        Ok(Self {
            rev: get("ref").map(safe_ref).transpose()?,
            limit: num("limit").unwrap_or(50).clamp(1, MAX_LOG),
            skip: num("skip").unwrap_or(0).min(1_000_000),
            path: get("path").map(safe_path).transpose()?,
        })
    }
}

fn status_word(code: &str) -> &'static str {
    match code.as_bytes().first() {
        Some(b'A' | b'C') => "added",
        Some(b'D') => "removed",
        Some(b'R') => "renamed",
        Some(b'U') => "conflicted",
        _ => "modified",
    }
}

/// One file of a diff before its patch is attached.
#[derive(Debug, Clone, PartialEq)]
pub struct FileStat {
    pub path: String,
    pub old_path: Option<String>,
    pub status: &'static str,
    pub additions: u64,
    pub deletions: u64,
    pub binary: bool,
}

/// `--name-status -z` output: `M\0path\0`, `R100\0old\0new\0`.
pub fn parse_name_status(out: &str) -> Vec<FileStat> {
    let mut parts = out.split('\0').filter(|s| !s.is_empty());
    let mut files = Vec::new();
    while let Some(code) = parts.next() {
        let two = matches!(code.as_bytes().first(), Some(b'R' | b'C'));
        let Some(first) = parts.next() else { break };
        let (old_path, path) = if two {
            match parts.next() {
                Some(second) => (Some(first.to_string()), second.to_string()),
                None => break,
            }
        } else {
            (None, first.to_string())
        };
        files.push(FileStat { path, old_path, status: status_word(code), additions: 0, deletions: 0, binary: false });
    }
    files
}

/// `--numstat -z` output, in the same order: `a\td\tpath\0`, or for a
/// rename `a\td\t\0old\0new\0`; `-\t-` marks a binary file.
pub fn parse_numstat(out: &str) -> Vec<(u64, u64, bool, String)> {
    let mut parts = out.split('\0');
    let mut rows = Vec::new();
    while let Some(head) = parts.next() {
        if head.is_empty() {
            continue;
        }
        let mut cols = head.splitn(3, '\t');
        let (a, d, p) = (cols.next().unwrap_or(""), cols.next().unwrap_or(""), cols.next().unwrap_or(""));
        let path = if p.is_empty() {
            let _old = parts.next();
            parts.next().unwrap_or_default().to_string()
        } else {
            p.to_string()
        };
        let binary = a == "-" && d == "-";
        rows.push((a.parse().unwrap_or(0), d.parse().unwrap_or(0), binary, path));
    }
    rows
}

/// A patch split per file, in diff order: each block from its
/// `diff --git` line to the next.
pub fn split_patch(text: &str) -> Vec<&str> {
    let mut starts: Vec<usize> = Vec::new();
    let mut at = 0;
    for line in text.split_inclusive('\n') {
        if line.starts_with("diff --git ") || line.starts_with("diff --cc ") || line.starts_with("diff --combined ") {
            starts.push(at);
        }
        at += line.len();
    }
    let mut blocks = Vec::new();
    for (i, s) in starts.iter().enumerate() {
        let end = starts.get(i + 1).copied().unwrap_or(text.len());
        blocks.push(&text[*s..end]);
    }
    blocks
}

/// A block's hunks (from the first `@@`), cut to `max_lines`; whether it is
/// binary; whether it was cut.
pub fn block_patch(block: &str, max_lines: usize) -> (String, bool, bool) {
    let binary = block.lines().any(|l| l.starts_with("Binary files ") || l == "GIT binary patch");
    if binary {
        return (String::new(), true, false);
    }
    let lines: Vec<&str> = block.lines().collect();
    let Some(h) = lines.iter().position(|l| l.starts_with("@@")) else { return (String::new(), false, false) };
    let hunk = &lines[h..];
    let cut = hunk.len() > max_lines;
    (hunk[..hunk.len().min(max_lines)].join("\n"), false, cut)
}

fn file_json(f: &FileStat, patch: Option<(String, bool)>, untracked: bool) -> Value {
    let mut m = Map::new();
    m.insert("path".into(), json!(f.path));
    if let Some(o) = &f.old_path {
        m.insert("oldPath".into(), json!(o));
    }
    m.insert("status".into(), json!(f.status));
    m.insert("additions".into(), json!(f.additions));
    m.insert("deletions".into(), json!(f.deletions));
    if f.binary {
        m.insert("binary".into(), json!(true));
    }
    if let Some((patch, cut)) = patch {
        m.insert("patch".into(), json!(patch));
        if cut {
            m.insert("truncated".into(), json!(true));
        }
    }
    if untracked {
        m.insert("untracked".into(), json!(true));
    }
    Value::Object(m)
}

/// `{ sha, short, parents, author, email, date, subject }` from one
/// `%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s` record.
const LOG_FORMAT: &str = "--format=%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e";

pub fn parse_log(out: &str) -> Vec<Value> {
    out.split('\x1e')
        .map(|r| r.trim_start_matches(['\n', '\r']))
        .filter(|r| !r.is_empty())
        .filter_map(|r| {
            let f: Vec<&str> = r.split('\x1f').collect();
            if f.len() < 7 {
                return None;
            }
            let parents: Vec<&str> = f[2].split(' ').filter(|p| !p.is_empty()).collect();
            Some(json!({
                "sha": f[0], "short": f[1], "parents": parents, "author": f[3], "email": f[4],
                "date": f[5], "subject": f[6].trim_end(),
            }))
        })
        .collect()
}

/// `ahead N, behind M` (or `gone`) from `%(upstream:track,nobracket)`.
pub fn parse_track(track: &str) -> (u64, u64, bool) {
    let mut ahead = 0;
    let mut behind = 0;
    for part in track.split(',').map(str::trim) {
        if let Some(n) = part.strip_prefix("ahead ") {
            ahead = n.trim().parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            behind = n.trim().parse().unwrap_or(0);
        }
    }
    (ahead, behind, track.trim() == "gone")
}

/// What `git:commitMessage` asks the model.
pub fn commit_message_prompt(stat: &str, patch: &str, truncated: bool) -> String {
    let cut = if truncated { "\n(The diff was cut to fit; write from what is shown and the file list.)" } else { "" };
    format!(
        "Write a git commit message for the staged changes below.\n\
         Rules: a subject line in the imperative mood, at most 72 characters, no trailing period; \
         then, only if the change needs explaining, a blank line and a short body wrapped at 72 \
         characters saying what changed and why. Plain text only: no Markdown, no code fences, no \
         quotes around it, no trailers (no Co-Authored-By, Signed-off-by or similar), and nothing \
         about who or what wrote it. Reply with the message and nothing else.{cut}\n\n\
         Files:\n{stat}\n\nDiff:\n{patch}"
    )
}

/// The model's reply as a commit message: fences, quotes and trailers off.
pub fn clean_commit_message(raw: &str) -> String {
    let mut text = js::trim(raw).to_string();
    if text.starts_with("```") {
        let inner: Vec<&str> = text.lines().skip(1).collect();
        text = inner.join("\n");
        if let Some(i) = text.rfind("```") {
            text.truncate(i);
        }
    }
    let mut lines: Vec<String> = text
        .lines()
        .map(|l| l.trim_end().to_string())
        .filter(|l| {
            let lower = l.to_ascii_lowercase();
            !(lower.starts_with("co-authored-by:") || lower.starts_with("signed-off-by:"))
        })
        .collect();
    while lines.first().is_some_and(|l| l.trim().is_empty()) {
        lines.remove(0);
    }
    while lines.last().is_some_and(|l| l.trim().is_empty()) {
        lines.pop();
    }
    if let Some(first) = lines.first_mut() {
        let s = first.trim();
        let s = s.strip_prefix("Subject:").or_else(|| s.strip_prefix("subject:")).unwrap_or(s).trim();
        let unquoted = s
            .strip_prefix('"')
            .and_then(|x| x.strip_suffix('"'))
            .or_else(|| s.strip_prefix('`').and_then(|x| x.strip_suffix('`')))
            .unwrap_or(s);
        *first = unquoted.to_string();
    }
    lines.join("\n")
}

fn ok(message: impl Into<String>) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("ok".into(), json!(true));
    m.insert("message".into(), json!(message.into()));
    m
}

fn fail(message: impl Into<String>) -> Value {
    json!({ "ok": false, "message": message.into() })
}

/// The git calls, one mutation at a time per folder.
pub struct GitOps {
    git: String,
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl Default for GitOps {
    fn default() -> Self {
        Self::new("git")
    }
}

impl GitOps {
    pub fn new(git: &str) -> Self {
        Self { git: git.into(), locks: Mutex::default() }
    }

    fn lock(&self, dir: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.locks.lock().unwrap_or_else(|e| e.into_inner()).entry(dir.to_string()).or_default().clone()
    }

    async fn run(&self, dir: &str, args: &[&str], timeout: Duration) -> Run {
        exec(&self.git, dir, args, &[], timeout, 4 * 1024 * 1024).await
    }

    /// A read that must succeed: its stdout, or git's error.
    async fn read(&self, dir: &str, args: &[&str], what: &str) -> Result<String, String> {
        let r = exec(&self.git, dir, args, &[("GIT_OPTIONAL_LOCKS", "0")], READ_TIMEOUT, 4 * 1024 * 1024).await;
        if r.ok { Ok(r.stdout) } else { Err(r.error(what)) }
    }

    /// Paths as literal pathspecs (no globs, no `:(magic)`).
    async fn run_paths(&self, dir: &str, args: &[&str], timeout: Duration, max: usize) -> Run {
        exec(&self.git, dir, args, &[("GIT_LITERAL_PATHSPECS", "1"), ("GIT_OPTIONAL_LOCKS", "0")], timeout, max).await
    }

    async fn has_head(&self, dir: &str) -> bool {
        self.run(dir, &["rev-parse", "-q", "--verify", "HEAD^{commit}"], READ_TIMEOUT).await.ok
    }

    /// The checked-out branch, or None on a detached HEAD.
    pub async fn current_branch(&self, dir: &str) -> Result<Option<String>, String> {
        let r = self.run(dir, &["symbolic-ref", "-q", "--short", "HEAD"], READ_TIMEOUT).await;
        if r.ok {
            return Ok(Some(js::trim(&r.stdout).to_string()));
        }
        if r.code == Some(1) {
            return Ok(None);
        }
        Err(r.error("Reading the branch"))
    }

    /// The files of one diff (`prefix` is `diff …` or `show …`), with capped
    /// patches when `patches`.
    async fn diff_files(&self, dir: &str, prefix: &[&str], path: Option<&str>, patches: bool) -> Result<Value, String> {
        let common = ["--relative", "-M", "--no-ext-diff", "--no-textconv", "--no-color"];
        let tail: Vec<&str> = match path {
            Some(p) => vec!["--", p],
            None => vec!["--"],
        };
        fn join<'a>(parts: &[&[&'a str]]) -> Vec<&'a str> {
            parts.iter().flat_map(|p| p.iter().copied()).collect()
        }
        let args = |extra: &[&'static str]| join(&[prefix, &common, extra, &tail]);
        let names = self.run_paths(dir, &args(&["--name-status", "-z"]), DIFF_TIMEOUT, MAX_READ).await;
        if !names.ok {
            return Err(names.error("Reading the diff"));
        }
        let mut files = parse_name_status(&names.stdout);
        let counts = self.run_paths(dir, &args(&["--numstat", "-z"]), DIFF_TIMEOUT, MAX_READ).await;
        if counts.ok {
            let rows = parse_numstat(&counts.stdout);
            for (f, (a, d, binary, _)) in files.iter_mut().zip(rows) {
                (f.additions, f.deletions, f.binary) = (a, d, binary);
            }
        }
        let total = files.len();
        let mut truncated = total > MAX_FILES;
        files.truncate(MAX_FILES);
        if !patches {
            let list: Vec<Value> = files.iter().map(|f| file_json(f, None, false)).collect();
            return Ok(json!({ "files": list, "truncated": truncated }));
        }
        let text = self.run_paths(dir, &args(&["-U3"]), DIFF_TIMEOUT, MAX_READ).await;
        if !text.ok && !text.truncated {
            return Err(text.error("Reading the diff"));
        }
        let blocks = split_patch(&text.stdout);
        let mut budget = MAX_PATCH_BYTES;
        let mut list = Vec::new();
        for (i, f) in files.iter_mut().enumerate() {
            let last_partial = text.truncated && i + 1 >= blocks.len();
            let (patch, binary, mut cut) = match blocks.get(i) {
                Some(b) => block_patch(b, MAX_PATCH_LINES),
                None => (String::new(), false, text.truncated),
            };
            f.binary |= binary;
            cut |= last_partial;
            let patch = if patch.len() > budget {
                cut = true;
                String::new()
            } else {
                budget -= patch.len();
                patch
            };
            truncated |= cut;
            list.push(file_json(f, Some((patch, cut)), false));
        }
        Ok(json!({ "files": list, "truncated": truncated }))
    }

    /// Untracked files under `path`, shown as added files.
    async fn untracked(&self, dir: &str, path: Option<&str>, room: usize) -> Result<(Vec<Value>, bool), String> {
        let mut args = vec!["ls-files", "--others", "--exclude-standard", "-z", "--"];
        if let Some(p) = path {
            args.push(p);
        }
        let r = self.run_paths(dir, &args, READ_TIMEOUT, MAX_READ).await;
        if !r.ok {
            return Err(r.error("Listing new files"));
        }
        let names: Vec<&str> = r.stdout.split('\0').filter(|s| !s.is_empty()).collect();
        let over = names.len() > room;
        let mut out = Vec::new();
        for name in names.into_iter().take(room) {
            let full = std::path::Path::new(dir).join(name);
            let mut f = FileStat {
                path: name.to_string(),
                old_path: None,
                status: "added",
                additions: 0,
                deletions: 0,
                binary: false,
            };
            if std::fs::symlink_metadata(&full).is_ok_and(|m| m.file_type().is_symlink()) {
                // A link is shown as git stores it, by its target; never followed.
                let target = std::fs::read_link(&full).map(|t| t.to_string_lossy().into_owned()).unwrap_or_default();
                f.additions = 1;
                out.push(file_json(&f, Some((format!("@@ -0,0 +1 @@\n+{target}"), false)), true));
                continue;
            }
            let mut bytes = Vec::new();
            let read_all = std::fs::File::open(&full)
                .and_then(|file| {
                    std::io::Read::read_to_end(
                        &mut std::io::Read::take(file, MAX_UNTRACKED_READ as u64 + 1),
                        &mut bytes,
                    )
                })
                .is_ok();
            let mut cut = bytes.len() > MAX_UNTRACKED_READ;
            bytes.truncate(MAX_UNTRACKED_READ);
            let patch = if !read_all {
                String::new()
            } else if bytes[..bytes.len().min(8000)].contains(&0) {
                f.binary = true;
                String::new()
            } else {
                let text = String::from_utf8_lossy(&bytes);
                let lines: Vec<&str> = text.lines().collect();
                f.additions = lines.len() as u64;
                cut |= lines.len() > MAX_PATCH_LINES;
                let shown: Vec<String> = lines.iter().take(MAX_PATCH_LINES).map(|l| format!("+{l}")).collect();
                if lines.is_empty() {
                    String::new()
                } else {
                    format!("@@ -0,0 +1,{} @@\n{}", lines.len(), shown.join("\n"))
                }
            };
            out.push(file_json(&f, Some((patch, cut)), true));
        }
        Ok((out, over))
    }

    /// `git:diff`: unstaged changes (with new files), staged changes, or the
    /// working tree (or index, with `staged`) against `base`.
    pub async fn diff(&self, dir: &str, opts: &DiffOpts) -> Result<Value, String> {
        let mut prefix = vec!["diff"];
        if opts.staged {
            prefix.push("--cached");
        }
        if let Some(b) = &opts.base {
            prefix.push(b);
        }
        let mut out = self.diff_files(dir, &prefix, opts.path.as_deref(), true).await?;
        if !opts.staged && opts.base.is_none() {
            let have = out["files"].as_array().map_or(0, Vec::len);
            let (extra, over) = self.untracked(dir, opts.path.as_deref(), MAX_FILES.saturating_sub(have)).await?;
            if let Some(list) = out["files"].as_array_mut() {
                list.extend(extra);
                list.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
            }
            if over {
                out["truncated"] = json!(true);
            }
        }
        Ok(out)
    }

    /// `git:log`: newest first.
    pub async fn log(&self, dir: &str, opts: &LogOpts) -> Result<Value, String> {
        if opts.rev.is_none() && !self.has_head(dir).await {
            // A repository with no commits yet has no history, not an error.
            self.read(dir, &["rev-parse", "--git-dir"], "Reading history").await?;
            return Ok(json!([]));
        }
        let (n, skip) = (format!("-n{}", opts.limit), format!("--skip={}", opts.skip));
        let mut args = vec!["log", LOG_FORMAT, &n, &skip];
        if let Some(r) = &opts.rev {
            args.push(r);
        }
        args.push("--");
        if let Some(p) = &opts.path {
            args.push(p);
        }
        let r = self.run_paths(dir, &args, READ_TIMEOUT, MAX_READ).await;
        if !r.ok {
            return Err(r.error("Reading history"));
        }
        Ok(Value::Array(parse_log(&r.stdout)))
    }

    /// `git:show`: one commit, its message body and its files with capped
    /// patches (a merge against its first parent).
    pub async fn show(&self, dir: &str, rev: &str) -> Result<Value, String> {
        let rev = safe_ref(rev)?;
        let commit = format!("{rev}^{{commit}}");
        let sha = self.read(dir, &["rev-parse", "--verify", &commit], "Finding the commit").await?;
        let sha = js::trim(&sha).to_string();
        let meta = self.read(dir, &["log", "-1", LOG_FORMAT, &sha, "--"], "Reading the commit").await?;
        let mut c = parse_log(&meta).into_iter().next().ok_or("Commit not found.")?;
        let body = self.read(dir, &["log", "-1", "--format=%b", &sha, "--"], "Reading the commit").await?;
        c["body"] = json!(js::trim(&body));
        let diff = self.diff_files(dir, &["show", "--format=", "--diff-merges=first-parent", &sha], None, true).await?;
        Ok(json!({ "commit": c, "files": diff["files"], "truncated": diff["truncated"] }))
    }

    /// `git:branches`: local and remote branches, the current one, and each
    /// local branch's distance from its upstream.
    pub async fn branches(&self, dir: &str) -> Result<Value, String> {
        let format = "--format=%(refname)%1f%(refname:short)%1f%(objectname:short)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(HEAD)%1f%(committerdate:iso-strict)%1f%(contents:subject)%1f%(symref)";
        let r = exec(
            &self.git,
            dir,
            &["for-each-ref", format, "refs/heads", "refs/remotes"],
            &[("LC_ALL", "C"), ("GIT_OPTIONAL_LOCKS", "0")],
            READ_TIMEOUT,
            MAX_READ,
        )
        .await;
        if !r.ok {
            return Err(r.error("Listing branches"));
        }
        let (mut local, mut remote) = (Vec::new(), Vec::new());
        let mut current = Value::Null;
        let mut default_branch = Value::Null;
        for line in r.stdout.lines() {
            let f: Vec<&str> = line.split('\x1f').collect();
            if f.len() < 9 {
                continue;
            }
            let (refname, name, sha, upstream, track, head, date, subject, symref) =
                (f[0], f[1], f[2], f[3], f[4], f[5], f[6], f[7], f[8]);
            if !symref.is_empty() {
                // `origin/HEAD`: where the remote's default branch is.
                if refname.ends_with("/HEAD") && refname.starts_with("refs/remotes/") {
                    let target = symref.trim_start_matches("refs/remotes/");
                    if let Some((_, b)) = target.split_once('/') {
                        default_branch = json!(b);
                    }
                }
                continue;
            }
            let mut b = Map::new();
            b.insert("name".into(), json!(name));
            b.insert("sha".into(), json!(sha));
            b.insert("date".into(), json!(date));
            b.insert("subject".into(), json!(subject));
            if refname.starts_with("refs/heads/") {
                let is_current = head == "*";
                if is_current {
                    current = json!(name);
                }
                b.insert("current".into(), json!(is_current));
                if !upstream.is_empty() {
                    let (ahead, behind, gone) = parse_track(track);
                    b.insert("upstream".into(), json!(upstream));
                    b.insert("ahead".into(), json!(ahead));
                    b.insert("behind".into(), json!(behind));
                    if gone {
                        b.insert("gone".into(), json!(true));
                    }
                }
                local.push(Value::Object(b));
            } else {
                b.insert("remote".into(), json!(name.split('/').next().unwrap_or_default()));
                remote.push(Value::Object(b));
            }
        }
        let head = self.run(dir, &["rev-parse", "--short", "HEAD"], READ_TIMEOUT).await;
        let mut out = Map::new();
        out.insert("current".into(), current.clone());
        out.insert("detached".into(), json!(current.is_null() && head.ok));
        if head.ok {
            out.insert("head".into(), json!(js::trim(&head.stdout)));
        }
        out.insert("defaultBranch".into(), default_branch);
        out.insert("local".into(), Value::Array(local));
        out.insert("remote".into(), Value::Array(remote));
        Ok(Value::Object(out))
    }

    /// `git:compare`: how far `head` is from `base`, the commits on `head`
    /// only, and the files changed since they split (as a PR shows them).
    pub async fn compare(&self, dir: &str, base: &str, head: &str) -> Result<Value, String> {
        let (base, head) = (safe_ref(base)?, safe_ref(head)?);
        for r in [&base, &head] {
            let c = format!("{r}^{{commit}}");
            self.read(dir, &["rev-parse", "--verify", "--quiet", &c], &format!("Finding {r}"))
                .await
                .map_err(|_| format!("Unknown branch or commit: {r}"))?;
        }
        let sym = format!("{base}...{head}");
        let counts = self.read(dir, &["rev-list", "--left-right", "--count", &sym, "--"], "Comparing").await?;
        let mut nums = counts.split_whitespace().map(|n| n.parse::<u64>().unwrap_or(0));
        let (behind, ahead) = (nums.next().unwrap_or(0), nums.next().unwrap_or(0));
        let range = format!("{base}..{head}");
        let n = format!("-n{MAX_LOG}");
        let log = self.read(dir, &["log", LOG_FORMAT, &n, &range, "--"], "Reading commits").await?;
        let commits = parse_log(&log);
        let mb = self.run(dir, &["merge-base", &base, &head], READ_TIMEOUT).await;
        let diff = self.diff_files(dir, &["diff", &sym], None, false).await?;
        let mut out = Map::new();
        out.insert("base".into(), json!(base));
        out.insert("head".into(), json!(head));
        if mb.ok {
            out.insert("mergeBase".into(), json!(js::trim(&mb.stdout)));
        }
        out.insert("ahead".into(), json!(ahead));
        out.insert("behind".into(), json!(behind));
        out.insert("commits".into(), Value::Array(commits));
        out.insert("files".into(), diff["files"].clone());
        out.insert("truncated".into(), json!(diff["truncated"] == json!(true) || ahead as usize > MAX_LOG));
        Ok(Value::Object(out))
    }

    /// `git:stage`: add these paths (new, changed and deleted files) to the index.
    pub async fn stage(&self, dir: &str, paths: &[String]) -> Result<Value, String> {
        let paths = safe_paths(paths)?;
        let lock = self.lock(dir);
        let _held = lock.lock().await;
        let mut args = vec!["add", "--all", "--"];
        args.extend(paths.iter().map(String::as_str));
        let r = self.run_paths(dir, &args, WRITE_TIMEOUT, 1024 * 1024).await;
        if !r.ok {
            return Ok(fail(r.error("Staging")));
        }
        let n = paths.len();
        Ok(Value::Object(ok(format!("Staged {n} {}.", if n == 1 { "path" } else { "paths" }))))
    }

    /// `git:unstage`: take these paths out of the index, keeping the files.
    pub async fn unstage(&self, dir: &str, paths: &[String]) -> Result<Value, String> {
        let paths = safe_paths(paths)?;
        let lock = self.lock(dir);
        let _held = lock.lock().await;
        let mut args: Vec<&str> = if self.has_head(dir).await {
            vec!["reset", "-q", "HEAD", "--"]
        } else {
            // Nothing committed yet: there is no HEAD to reset to.
            vec!["rm", "--cached", "-r", "-q", "--ignore-unmatch", "--"]
        };
        args.extend(paths.iter().map(String::as_str));
        let r = self.run_paths(dir, &args, WRITE_TIMEOUT, 1024 * 1024).await;
        if !r.ok {
            return Ok(fail(r.error("Unstaging")));
        }
        let n = paths.len();
        Ok(Value::Object(ok(format!("Unstaged {n} {}.", if n == 1 { "path" } else { "paths" }))))
    }

    /// `git:commit`: commit what is staged. Hooks run; amending and empty
    /// commits are refused.
    pub async fn commit(&self, dir: &str, opts: Option<&Value>) -> Result<Value, String> {
        let get = |k: &str| opts.and_then(|o| o.get(k));
        let message = get("message").and_then(Value::as_str).unwrap_or_default();
        if js::trim(message).is_empty() {
            return Err("Write a commit message first.".into());
        }
        if message.len() > MAX_COMMIT_MESSAGE {
            return Err(format!("The commit message is too long (at most {MAX_COMMIT_MESSAGE} characters)."));
        }
        if js::truthy(get("amend")) {
            return Err("Amending a commit is not supported here.".into());
        }
        if js::truthy(get("allowEmpty")) {
            return Err("Empty commits are not supported here.".into());
        }
        let lock = self.lock(dir);
        let _held = lock.lock().await;
        let staged = self.run(dir, &["diff", "--cached", "--quiet", "--no-ext-diff"], READ_TIMEOUT).await;
        if staged.ok {
            return Ok(fail("Nothing is staged. Stage some changes first."));
        }
        if staged.code != Some(1) {
            return Ok(fail(staged.error("Checking staged changes")));
        }
        let r = self.run(dir, &["commit", "--quiet", "-m", message], COMMIT_TIMEOUT).await;
        if !r.ok {
            return Ok(fail(r.error("Committing")));
        }
        let meta = self.read(dir, &["log", "-1", LOG_FORMAT, "HEAD", "--"], "Reading the commit").await?;
        let commit = parse_log(&meta).into_iter().next().unwrap_or(Value::Null);
        let mut out = ok(format!("Committed {}.", commit["short"].as_str().unwrap_or_default()));
        out.insert("commit".into(), commit);
        if let Some(b) = self.current_branch(dir).await.ok().flatten() {
            out.insert("branch".into(), json!(b));
        }
        Ok(Value::Object(out))
    }

    /// The staged diff a commit message is written from: the file list and
    /// the patch, cut to [`MAX_MESSAGE_INPUT`] characters; whether it was cut.
    pub async fn staged_for_message(&self, dir: &str) -> Result<(String, String, bool), String> {
        let stat = self
            .read(
                dir,
                &["diff", "--cached", "--no-ext-diff", "--no-color", "--stat=120", "--"],
                "Reading staged changes",
            )
            .await?;
        if js::trim(&stat).is_empty() {
            return Err("Nothing is staged. Stage some changes first.".into());
        }
        let r = exec(
            &self.git,
            dir,
            &["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", "-M", "-U2", "--"],
            &[("GIT_OPTIONAL_LOCKS", "0")],
            DIFF_TIMEOUT,
            MAX_MESSAGE_INPUT * 4,
        )
        .await;
        if !r.ok && !r.truncated {
            return Err(r.error("Reading staged changes"));
        }
        let mut cut = r.truncated;
        let mut patch = r.stdout;
        if patch.chars().count() > MAX_MESSAGE_INPUT {
            patch = patch.chars().take(MAX_MESSAGE_INPUT).collect();
            cut = true;
        }
        Ok((js::trim(&stat).to_string(), patch, cut))
    }

    /// The remote a push would go to: the branch's upstream remote, else
    /// `origin`, else the only remote.
    pub async fn push_remote(&self, dir: &str, branch: &str) -> Option<String> {
        let key = format!("branch.{branch}.remote");
        let r = self.run(dir, &["config", "--get", &key], READ_TIMEOUT).await;
        if r.ok && !js::trim(&r.stdout).is_empty() && js::trim(&r.stdout) != "." {
            return Some(js::trim(&r.stdout).to_string());
        }
        let remotes = self.run(dir, &["remote"], READ_TIMEOUT).await;
        let list: Vec<&str> = remotes.stdout.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
        if list.contains(&"origin") {
            Some("origin".into())
        } else if list.len() == 1 {
            Some(list[0].to_string())
        } else {
            None
        }
    }

    /// `owner/repo` of a GitHub remote, for the REST fallback.
    pub async fn github_slug(&self, dir: &str, remote: &str) -> Option<String> {
        let r = self.run(dir, &["remote", "get-url", "--", remote], READ_TIMEOUT).await;
        r.ok.then(|| parse_github_slug(js::trim(&r.stdout))).flatten()
    }

    /// `git:push`: the current branch to its upstream, or with
    /// `setUpstream` to the push remote under the same name (and track it).
    /// Never forced.
    pub async fn push(&self, dir: &str, opts: Option<&Value>) -> Result<Value, String> {
        let set_upstream = opts.and_then(|o| o.get("setUpstream")).is_some_and(|v| js::truthy(Some(v)));
        let lock = self.lock(dir);
        let _held = lock.lock().await;
        let Some(branch) = self.current_branch(dir).await? else {
            return Ok(fail("Not on a branch (detached HEAD). Switch to a branch first."));
        };
        let merge_key = format!("branch.{branch}.merge");
        let merge = self.run(dir, &["config", "--get", &merge_key], READ_TIMEOUT).await;
        let upstream_ref = js::trim(&merge.stdout).to_string();
        let remote = self.push_remote(dir, &branch).await;
        if let Err(m) = nekko_net::check("github", remote.as_deref().unwrap_or("origin")) {
            return Ok(fail(m));
        }
        let local = format!("refs/heads/{branch}");
        let r = if merge.ok && upstream_ref.starts_with("refs/heads/") {
            let Some(remote) = remote else { return Ok(fail("This branch's upstream remote is missing.")) };
            // An explicit refspec without `+`: never a force push, whatever push.default says.
            let spec = format!("{local}:{upstream_ref}");
            let r = self.run(dir, &["push", "--porcelain", "--", &remote, &spec], PUSH_TIMEOUT).await;
            (r, remote, upstream_ref.trim_start_matches("refs/heads/").to_string())
        } else if set_upstream {
            let Some(remote) = remote else { return Ok(fail("No remote to push to. Add one named origin first.")) };
            let spec = format!("{local}:{local}");
            let r = self.run(dir, &["push", "--porcelain", "--set-upstream", "--", &remote, &spec], PUSH_TIMEOUT).await;
            (r, remote, branch.clone())
        } else {
            return Ok(fail(format!(
                "{branch} has no upstream yet. Push with setUpstream to publish it{}.",
                remote.map(|r| format!(" to {r}")).unwrap_or_default()
            )));
        };
        let (r, remote, target) = r;
        if !r.ok {
            return Ok(fail(r.error("Pushing")));
        }
        let mut out = ok(format!("Pushed {branch} to {remote}/{target}."));
        out.insert("branch".into(), json!(branch));
        out.insert("remote".into(), json!(remote));
        out.insert("upstream".into(), json!(format!("{remote}/{target}")));
        Ok(Value::Object(out))
    }

    /// `git:switch`: check out `branch` (or create it from HEAD). Git
    /// decides whether local changes allow it; its refusal is the answer.
    pub async fn switch(&self, dir: &str, branch: &str, opts: Option<&Value>) -> Result<Value, String> {
        let create = opts.and_then(|o| o.get("create")).is_some_and(|v| js::truthy(Some(v)));
        let name = safe_ref(branch)?;
        let check = self.run(dir, &["check-ref-format", "--branch", &name], READ_TIMEOUT).await;
        if !check.ok {
            return Err(format!("{name} is not a valid branch name."));
        }
        let lock = self.lock(dir);
        let _held = lock.lock().await;
        let args: Vec<&str> = if create { vec!["switch", "-c", &name] } else { vec!["switch", &name] };
        let r = self.run(dir, &args, SWITCH_TIMEOUT).await;
        if !r.ok {
            return Ok(fail(r.error("Switching branch")));
        }
        let mut out =
            ok(if create { format!("Created and switched to {name}.") } else { format!("Switched to {name}.") });
        out.insert("branch".into(), json!(name));
        Ok(Value::Object(out))
    }

    /// `git:mergeAbort`: back out of a conflicted merge, only while one is
    /// in progress.
    pub async fn merge_abort(&self, dir: &str) -> Result<Value, String> {
        let lock = self.lock(dir);
        let _held = lock.lock().await;
        let merging = self.run(dir, &["rev-parse", "-q", "--verify", "MERGE_HEAD"], READ_TIMEOUT).await;
        if !merging.ok {
            return Ok(fail("No merge is in progress."));
        }
        let r = self.run(dir, &["merge", "--abort"], WRITE_TIMEOUT).await;
        if !r.ok {
            return Ok(fail(r.error("Aborting the merge")));
        }
        Ok(Value::Object(ok("Merge aborted.")))
    }
}

/// `owner/repo` from a GitHub remote URL (https, ssh or scp-like).
pub fn parse_github_slug(url: &str) -> Option<String> {
    let rest = url
        .strip_prefix("https://github.com/")
        .or_else(|| url.strip_prefix("http://github.com/"))
        .or_else(|| url.strip_prefix("ssh://git@github.com/"))
        .or_else(|| url.strip_prefix("git@github.com:"))
        .or_else(|| url.split_once("@github.com/").map(|(_, r)| r))?;
    let rest = rest.trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let mut parts = rest.split('/');
    let (owner, repo) = (parts.next()?, parts.next()?);
    if owner.is_empty() || repo.is_empty() || parts.next().is_some() {
        return None;
    }
    Some(format!("{owner}/{repo}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_paths_that_leave_the_workspace() {
        for bad in ["", "/etc/passwd", "\\x", "C:\\x", "c:/x", "../x", "a/../../x", "a\\..\\x", "a/..", "x\0y"] {
            assert!(safe_path(bad).is_err(), "{bad:?}");
        }
        for good in ["a.txt", "src/main.rs", ".", "dir/", "a..b", "..x", ":odd"] {
            assert_eq!(safe_path(good).as_deref(), Ok(good));
        }
        assert!(safe_paths(&[]).is_err());
    }

    #[test]
    fn refuses_options_and_ranges_as_revisions() {
        for bad in ["", "-x", "--output=/tmp/x", "a..b", "a...b", "a b", "a\nb"] {
            assert!(safe_ref(bad).is_err(), "{bad:?}");
        }
        for good in ["main", "origin/main", "HEAD~2", "abc123", "v1.0", "main@{u}"] {
            assert!(safe_ref(good).is_ok(), "{good:?}");
        }
    }

    #[test]
    fn parses_name_status_and_numstat() {
        let names = parse_name_status("M\0a.rs\0R087\0old.rs\0new.rs\0A\0bin.png\0D\0gone\0U\0both\0");
        let words: Vec<_> = names.iter().map(|f| (f.path.as_str(), f.old_path.as_deref(), f.status)).collect();
        assert_eq!(
            words,
            [
                ("a.rs", None, "modified"),
                ("new.rs", Some("old.rs"), "renamed"),
                ("bin.png", None, "added"),
                ("gone", None, "removed"),
                ("both", None, "conflicted")
            ]
        );
        let nums = parse_numstat("3\t1\ta.rs\x002\t2\t\0old.rs\0new.rs\0-\t-\tbin.png\0");
        assert_eq!(
            nums,
            [
                (3, 1, false, "a.rs".to_string()),
                (2, 2, false, "new.rs".to_string()),
                (0, 0, true, "bin.png".to_string())
            ]
        );
    }

    #[test]
    fn splits_and_caps_patches() {
        let text = "diff --git a/a b/a\nindex 1..2\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/b b/b\nBinary files a/b and b/b differ\n";
        let blocks = split_patch(text);
        assert_eq!(blocks.len(), 2);
        assert_eq!(block_patch(blocks[0], 10), ("@@ -1 +1 @@\n-x\n+y".to_string(), false, false));
        assert_eq!(block_patch(blocks[0], 2), ("@@ -1 +1 @@\n-x".to_string(), false, true));
        assert_eq!(block_patch(blocks[1], 10), (String::new(), true, false));
    }

    #[test]
    fn reads_upstream_tracking() {
        assert_eq!(parse_track("ahead 2, behind 3"), (2, 3, false));
        assert_eq!(parse_track("behind 1"), (0, 1, false));
        assert_eq!(parse_track(""), (0, 0, false));
        assert_eq!(parse_track("gone"), (0, 0, true));
    }

    #[test]
    fn cleans_a_model_written_commit_message() {
        assert_eq!(clean_commit_message("```\nAdd x\n\nBody\n```"), "Add x\n\nBody");
        assert_eq!(clean_commit_message("\"Fix the thing\""), "Fix the thing");
        assert_eq!(clean_commit_message("Subject: Add y\n\nWhy.\n\nCo-Authored-By: Someone <a@b>\n"), "Add y\n\nWhy.");
        let prompt = commit_message_prompt("a | 1 +", "diff", true);
        assert!(prompt.contains("no trailers") && prompt.contains("cut to fit"));
    }

    #[test]
    fn reads_github_slugs() {
        for (url, slug) in [
            ("https://github.com/o/r.git", Some("o/r")),
            ("git@github.com:o/r.git", Some("o/r")),
            ("ssh://git@github.com/o/r", Some("o/r")),
            ("https://x-access-token:t@github.com/o/r.git", Some("o/r")),
            ("https://gitlab.com/o/r.git", None),
            ("/tmp/bare.git", None),
        ] {
            assert_eq!(parse_github_slug(url).as_deref(), slug, "{url}");
        }
    }
}
