//! Chat worktrees, owned by the daemon (PF14): a worktree chat's own Git
//! checkout per repository, made on its first send, restored when it was
//! removed, listed and removed from Settings > Git management.
//!
//! A port of `chat-worktrees.ts`: `prepareChatWorktrees` (with
//! `restoreRemovedWorktrees`, `copyWorktreeIncludes` and the checkout names),
//! `chatWorkspaces`, `listChatWorktrees`, `removeChatWorktree` and
//! `runWorktreeSetup`, with Git run the same way (30-second limit, no console
//! window) and the same notices and errors. `chatWorktrees:list` and
//! `chatWorktrees:remove` are served here while the daemon knows the data
//! directory; chat admission uses [`prepare`] and [`chat_workspaces`].

use serde_json::{Map, Value, json};
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const CHANNELS: &[&str] = &["chatWorktrees:list", "chatWorktrees:remove"];

const WORD_A: [&str; 20] = [
    "brisk", "calm", "bold", "quiet", "swift", "keen", "bright", "gentle", "nimble", "steady", "lucky", "merry",
    "plucky", "clever", "sunny", "cosy", "eager", "witty", "mellow", "tidy",
];
const WORD_B: [&str; 20] = [
    "amber", "coral", "indigo", "jade", "olive", "rose", "sage", "teal", "violet", "copper", "silver", "golden",
    "ivory", "maple", "ochre", "pearl", "plum", "ruby", "slate", "cobalt",
];
const WORD_C: [&str; 20] = [
    "otter", "heron", "lynx", "badger", "falcon", "marten", "ibis", "puffin", "stoat", "wren", "tapir", "quokka",
    "gecko", "koala", "finch", "moth", "robin", "seal", "fox", "cat",
];

const GIT_TIMEOUT: Duration = Duration::from_secs(30);

// ------------------------------------------------------------------ paths

fn p_resolve(parts: &[&str]) -> String {
    if cfg!(windows) { nekko_tools::path::win32::resolve(parts) } else { nekko_tools::path::posix::resolve(parts) }
}

fn p_join(parts: &[&str]) -> String {
    if cfg!(windows) { nekko_tools::path::win32::join(parts) } else { nekko_tools::path::posix::join(parts) }
}

fn disk_path(p: &str) -> String {
    let resolved = p_resolve(&[p]);
    let canonical = std::fs::canonicalize(&resolved).map(|p| p.to_string_lossy().into_owned()).unwrap_or(resolved);
    // Windows canonical paths use a verbatim prefix that Git does not report.
    if let Some(unc) = canonical.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{unc}");
    }
    canonical.strip_prefix(r"\\?\").unwrap_or(&canonical).to_string()
}

fn p_relative(from: &str, to: &str) -> String {
    let (from, to) = (disk_path(from), disk_path(to));
    if cfg!(windows) {
        nekko_tools::path::win32::relative(&from, &to)
    } else {
        nekko_tools::path::posix::relative(&from, &to)
    }
}

/// Windows paths compare case-insensitively; Git reports them with forward slashes.
fn norm(p: &str) -> String {
    let r = disk_path(p);
    if cfg!(windows) { r.to_lowercase() } else { r }
}

fn exists(p: &str) -> bool {
    Path::new(p).exists()
}

// -------------------------------------------------------------------- git

/// A failed `execFileSync`, as `String(error)` and its `stderr` read.
#[derive(Debug)]
pub struct GitError {
    pub message: String,
    pub stderr: Option<String>,
}

impl GitError {
    /// `String(error.stderr ?? error)`.
    fn stderr_or_message(&self) -> String {
        self.stderr.clone().unwrap_or_else(|| self.message.clone())
    }
}

fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: never flash a console on the user's screen.
        cmd.creation_flags(0x0800_0000);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

/// Run a command to completion with a time limit, feeding `input` to stdin.
/// Git never asks for credentials here: nobody is at a terminal to answer.
pub(crate) fn run(
    program: &str,
    args: &[&str],
    cwd: &str,
    input: Option<&[u8]>,
    limit: Duration,
) -> Result<(i32, Vec<u8>, Vec<u8>), String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if program == "git" {
        cmd.env("GIT_TERMINAL_PROMPT", "0");
    }
    // Its own process group, so a timeout also ends what it started (a
    // fetch's `git remote-https`), which would otherwise hold the pipes open.
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    no_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!("Error: spawnSync {program} ENOENT")
        } else {
            format!("Error: spawnSync {program} {e}")
        }
    })?;
    if let (Some(data), Some(mut stdin)) = (input, child.stdin.take()) {
        let data = data.to_vec();
        std::thread::spawn(move || {
            let _ = std::io::Write::write_all(&mut stdin, &data);
        });
    }
    let read = |r: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut r) = r {
                let _ = r.read_to_end(&mut buf);
            }
            buf
        })
    };
    let out = read(child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
    let err = read(child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
    let deadline = Instant::now() + limit;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) if Instant::now() >= deadline => {
                #[cfg(unix)]
                // SAFETY: kill takes a process group id and a signal number, no pointers.
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGKILL);
                }
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(5)),
            Err(_) => break None,
        }
    };
    // Timed out: the readers are left behind rather than waited on, since
    // something the command started may still hold its pipes.
    let Some(status) = status else { return Err(format!("Error: spawnSync {program} ETIMEDOUT")) };
    let (stdout, stderr) = (out.join().unwrap_or_default(), err.join().unwrap_or_default());
    Ok((status.code().unwrap_or(-1), stdout, stderr))
}

/// `git(cwd, args)`: trimmed stdout, or the error `execFileSync` throws.
pub fn git(cwd: &str, args: &[&str]) -> Result<String, GitError> {
    match run("git", args, cwd, None, GIT_TIMEOUT) {
        Ok((0, out, _)) => Ok(nekko_js::trim(&String::from_utf8_lossy(&out)).to_string()),
        Ok((_, _, err)) => {
            let stderr = String::from_utf8_lossy(&err).into_owned();
            Err(GitError {
                message: format!("Error: Command failed: git {}\n{stderr}", args.join(" ")),
                stderr: Some(stderr),
            })
        }
        Err(message) => Err(GitError { message, stderr: None }),
    }
}

fn git_ok(cwd: &str, args: &[&str]) -> bool {
    git(cwd, args).is_ok()
}

// ------------------------------------------------------------------ names

/// `Math.random()`.
fn math_random() -> f64 {
    let mut b = [0u8; 8];
    let _ = getrandom::fill(&mut b);
    (u64::from_le_bytes(b) >> 11) as f64 / (1u64 << 53) as f64
}

/// `randomWorktreeName`: `adjective-colour-animal`.
pub fn random_worktree_name(random: &mut dyn FnMut() -> f64) -> String {
    let mut pick = |list: &[&'static str; 20]| list[((random() * 20.0).floor() as usize).min(19)];
    let a = pick(&WORD_A);
    let b = pick(&WORD_B);
    let c = pick(&WORD_C);
    format!("{a}-{b}-{c}")
}

/// `slugifyTitle`: lowercase ASCII words joined by dashes, at most 40 characters.
pub fn slugify_title(title: &str) -> String {
    use icu_normalizer::DecomposingNormalizerBorrowed;
    let decomposed = DecomposingNormalizerBorrowed::new_nfkd().normalize(title).to_lowercase();
    let mut out = String::new();
    let mut dash = false;
    for c in decomposed.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if dash && !out.is_empty() {
                out.push('-');
            }
            dash = false;
            out.push(c);
        } else {
            dash = true;
        }
    }
    // `.replace(/^-+|-+$/g, '')` is implied (no leading dash, none trailing),
    // then `.slice(0, 40)` and a trailing dash cut once more.
    let cut: String = out.chars().take(40).collect();
    cut.trim_end_matches('-').to_string()
}

/// `worktreeName`: a chosen title's slug (numbered if taken), else three
/// random words (redrawn if taken).
pub fn worktree_name(session: &Value, taken: &dyn Fn(&str) -> bool, random: &mut dyn FnMut() -> f64) -> String {
    let title = session.get("title").and_then(Value::as_str).unwrap_or_default();
    let chosen = if session.get("titleAuto") == Some(&json!(false)) && !title.is_empty() && title != "New chat" {
        slugify_title(title)
    } else {
        String::new()
    };
    if !chosen.is_empty() {
        if !taken(&chosen) {
            return chosen;
        }
        for n in 2..100 {
            let name = format!("{chosen}-{n}");
            if !taken(&name) {
                return name;
            }
        }
    }
    for _ in 0..50 {
        let name = random_worktree_name(random);
        if !taken(&name) {
            return name;
        }
    }
    format!("{}-{}", random_worktree_name(random), radix36(nekko_oauth::now_ms() as u64))
}

fn radix36(mut n: u64) -> String {
    const D: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(D[(n % 36) as usize]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

// ---------------------------------------------------------------- sessions

/// `getSessionWorkspaceIds`: the primary folder, then the supporting ones, each once.
pub fn session_workspace_ids(session: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut add = |v: &Value| {
        let s = match v {
            Value::String(s) if !s.is_empty() => s.clone(),
            _ => return,
        };
        if !out.contains(&s) {
            out.push(s);
        }
    };
    if let Some(w) = session.get("workspaceId") {
        add(w);
    }
    for w in session.get("supportingWorkspaceIds").and_then(Value::as_array).into_iter().flatten() {
        add(w);
    }
    out
}

/// `getExecutionMode`.
pub fn execution_mode(session: &Value) -> String {
    match session.get("executionMode").and_then(Value::as_str) {
        Some(m) => m.to_string(),
        None if session.get("gitIsolation") == Some(&json!(false)) => "unified".into(),
        None => "worktree".into(),
    }
}

fn workspaces_of(settings: &Value) -> Vec<Value> {
    settings.get("workspaces").and_then(Value::as_array).cloned().unwrap_or_default()
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or_default()
}

fn stack_notice(parent: &Value) -> String {
    format!(
        "This chat builds on {}, branch {}, committed snapshot {}. Create the dependent PR against {}; gh pr create uses this configured base. After publishing, use Link stack in the PR panel to register it with GitHub. Recheck the parent before publishing; if it changes or merges, explicitly rebase this branch when safe. Never automatically reset other worktrees or force push.",
        s(parent, "url"),
        s(parent, "branch"),
        s(parent, "sha"),
        s(parent, "branch")
    )
}

/// `chatWorkspaces`: a chat's folders, each Git project pointed at its own checkout.
pub fn chat_workspaces(session: Option<&Value>, settings: &Value) -> Vec<Value> {
    let workspaces = workspaces_of(settings);
    let Some(session) = session else { return workspaces };
    session_workspace_ids(session)
        .iter()
        .filter_map(|id| {
            let mut folder = workspaces.iter().find(|w| s(w, "id") == id)?.clone();
            if session.get("gitIsolation") != Some(&json!(false))
                && let Some(path) = session.pointer(&format!("/gitWorktrees/{}/path", escape_pointer(id)))
            {
                folder["path"] = path.clone();
            }
            Some(folder)
        })
        .collect()
}

fn escape_pointer(k: &str) -> String {
    k.replace('~', "~0").replace('/', "~1")
}

// ---------------------------------------------------------------- prepare

/// `prepareChatWorktrees`: provision a worktree chat's checkouts lazily (and
/// restore removed ones). Returns the checkouts made on this call, by folder
/// id, for the caller to run each project's setup command in.
pub fn prepare(session: &mut Value, settings: &Value) -> Result<Vec<(String, Value)>, String> {
    if !nekko_js::truthy(session.get("gitIsolation")) {
        return Ok(Vec::new());
    }
    if !session.get("gitWorktrees").is_some_and(Value::is_object) {
        session["gitWorktrees"] = json!({});
    }
    let mut created = restore_removed(session)?;
    let workspaces = workspaces_of(settings);
    for id in session_workspace_ids(session) {
        let Some(folder) = workspaces.iter().find(|w| s(w, "id") == id) else { continue };
        if let Some(saved) = session["gitWorktrees"].get(&id).filter(|w| nekko_js::truthy(Some(w))).cloned() {
            let sub = p_relative(s(&saved, "sourceRoot"), s(folder, "path"));
            if sub == ".."
                || sub.starts_with(&format!("..{}", std::path::MAIN_SEPARATOR))
                || Path::new(&sub).is_absolute()
            {
                return Err("The configured folder no longer belongs to this chat worktree.".into());
            }
            session["gitWorktrees"][&id]["path"] = json!(p_join(&[s(&saved, "root"), &sub]));
            continue;
        }
        let (folder_path, folder_name) = (s(folder, "path").to_string(), s(folder, "name").to_string());
        // Ordinary folders are skipped; a broken Git checkout must not silently run shared.
        let root = match git(&folder_path, &["rev-parse", "--show-toplevel"]) {
            Ok(r) => r,
            Err(e) => {
                let message = e.stderr_or_message();
                if message.to_lowercase().contains("not a git repository") {
                    continue;
                }
                return Err(format!("Could not inspect Git project {folder_name}: {message}"));
            }
        };
        let existing = session["gitWorktrees"]
            .as_object()
            .and_then(|m| m.values().find(|w| norm(s(w, "sourceRoot")) == norm(&root)).cloned());
        if let Some(mut existing) = existing {
            let path = p_join(&[s(&existing, "root"), &p_relative(&root, &folder_path)]);
            existing["path"] = json!(path);
            session["gitWorktrees"][&id] = existing;
            continue;
        }
        let checkout = make_checkout(session, settings, &root, &folder_path, &id).map_err(|e| {
            format!("Could not prepare isolated checkout for {folder_name}. No shared-checkout fallback was used: {e}")
        });
        let checkout = checkout?;
        session["gitWorktrees"][&id] = checkout.clone();
        created.push((id, checkout));
    }
    Ok(created)
}

fn make_checkout(
    session: &Value,
    settings: &Value,
    root: &str,
    folder_path: &str,
    workspace_id: &str,
) -> Result<Value, String> {
    let gm = |e: GitError| e.message;
    let parent = session.get("gitStackParent").filter(|p| s(p, "workspaceId") == workspace_id);
    if let Some(parent) = parent {
        let sha = s(parent, "sha");
        if ![40, 64].contains(&sha.len()) || !sha.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err("Invalid parent PR commit. Start the stacked chat again.".into());
        }
        git(root, &["check-ref-format", &format!("refs/heads/{}", s(parent, "branch"))]).map_err(gm)?;
    }
    let dirty = !git(root, &["status", "--porcelain"]).map_err(gm)?.is_empty();
    let common = p_resolve(&[root, &git(root, &["rev-parse", "--git-common-dir"]).map_err(gm)?]);
    let home = p_join(&[&common, "nekko-worktrees"]);
    let taken = |n: &str| {
        exists(&p_join(&[&home, n]))
            || git_ok(root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/nekko/{n}")])
    };
    let name = worktree_name(session, &taken, &mut math_random);
    let target = p_join(&[&home, &name]);
    let branch = format!("nekko/{name}");
    std::fs::create_dir_all(&home).map_err(|e| format!("Error: {e}"))?;
    git(root, &["worktree", "add", "-b", &branch, &target, parent.map(|p| s(p, "sha")).unwrap_or("HEAD")])
        .map_err(gm)?;
    if let Some(parent) = parent {
        git(&target, &["config", &format!("branch.{branch}.gh-merge-base"), s(parent, "branch")]).map_err(gm)?;
    }
    let local_changes = settings.pointer("/gitManagement/baseline").and_then(Value::as_str) == Some("local-changes");
    if parent.is_none() && dirty && local_changes {
        let (code, patch, err) = run("git", &["diff", "--binary", "HEAD"], root, None, GIT_TIMEOUT)?;
        if code != 0 {
            return Err(format!("Error: Command failed: git diff --binary HEAD\n{}", String::from_utf8_lossy(&err)));
        }
        if !patch.is_empty() {
            let patch_path = p_join(&[&common, "nekko-worktrees", &format!("{}.patch", s(session, "id"))]);
            std::fs::write(&patch_path, &patch).map_err(|e| format!("Error: {e}"))?;
            let applied = git(&target, &["apply", &patch_path]);
            let _ = std::fs::remove_file(&patch_path);
            applied.map_err(gm)?;
        }
        // Untracked files are not copied: they may include secrets or large build artifacts.
    }
    let copied = copy_worktree_includes(root, &target).map_err(|e| e.to_string())?;
    let parent_notice = parent.map(stack_notice);
    let base = if let Some(notice) = &parent_notice {
        notice.as_str()
    } else if dirty {
        if local_changes {
            "This chat uses an isolated worktree with tracked local edits copied in. Untracked files were not copied."
        } else {
            "This chat starts in an isolated worktree from committed HEAD. Existing local changes are not included."
        }
    } else {
        "This chat uses an isolated Git worktree from committed HEAD."
    };
    let notice = if copied.is_empty() {
        base.to_string()
    } else {
        format!("{base} Copied from .worktreeinclude: {}.", copied.join(", "))
    };
    Ok(json!({
        "sourceRoot": root,
        "root": target,
        "path": p_join(&[&target, &p_relative(root, folder_path)]),
        "branch": branch,
        "notice": notice,
    }))
}

/// `restoreRemovedWorktrees`: bring back a removed checkout from its branch
/// (or freshly from HEAD under the same name when the branch went too).
fn restore_removed(session: &mut Value) -> Result<Vec<(String, Value)>, String> {
    let entries: Vec<(String, Value)> = session["gitWorktrees"]
        .as_object()
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();
    let mut roots: Vec<String> = Vec::new();
    for (_, w) in &entries {
        let r = s(w, "root").to_string();
        if !roots.contains(&r) {
            roots.push(r);
        }
    }
    let mut restored = Vec::new();
    for root in roots {
        // A linked worktree has a `.git` file; a bare folder left behind is not a checkout.
        if exists(&p_join(&[&root, ".git"])) {
            continue;
        }
        let Some((first_id, first)) = entries.iter().find(|(_, w)| s(w, "root") == root).cloned() else { continue };
        let (source, branch) = (s(&first, "sourceRoot").to_string(), s(&first, "branch").to_string());
        let parent = session
            .get("gitStackParent")
            .filter(|p| session["gitWorktrees"].get(s(p, "workspaceId")).is_some_and(|w| s(w, "root") == root))
            .cloned();
        if parent.is_some() && !git_ok(&source, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")])
        {
            return Err(
                "This stacked chat's branch was deleted. Start a new stacked chat; it cannot safely resume from HEAD."
                    .into(),
            );
        }
        let attempt = (|| -> Result<String, GitError> {
            git_ok(&source, &["worktree", "prune"]);
            if git_ok(&source, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]) {
                git(&source, &["worktree", "add", &root, &branch])?;
                Ok(format!("This chat's worktree had been removed; it was restored from its branch {branch}."))
            } else {
                git(&source, &["worktree", "add", "-b", &branch, &root, "HEAD"])?;
                Ok(format!(
                    "This chat's worktree and branch had been removed; it continues on {branch}, freshly created from committed HEAD."
                ))
            }
        })();
        let mut notice = attempt.map_err(|e| {
            format!(
                "Could not restore this chat's worktree at {root}. No shared-checkout fallback was used: {}",
                e.message
            )
        })?;
        if let Some(parent) = parent {
            notice = format!("{} {notice}", stack_notice(&parent));
        }
        let copied = copy_worktree_includes(&source, &root).map_err(|e| e.to_string())?;
        if !copied.is_empty() {
            notice.push_str(&format!(" Copied from .worktreeinclude: {}.", copied.join(", ")));
        }
        if let Some(m) = session["gitWorktrees"].as_object_mut() {
            for w in m.values_mut() {
                if s(w, "root") == root {
                    w["notice"] = json!(notice);
                }
            }
        }
        let first_now = session["gitWorktrees"].get(&first_id).cloned().unwrap_or(first);
        restored.push((first_id, first_now));
    }
    Ok(restored)
}

/// `copyWorktreeIncludes`: the gitignored files `.worktreeinclude` lists,
/// copied into a new checkout, never over an existing file.
pub fn copy_worktree_includes(root: &str, target: &str) -> Result<Vec<String>, String> {
    let list = p_join(&[root, ".worktreeinclude"]);
    if !exists(&list) {
        return Ok(Vec::new());
    }
    let candidates = git(
        root,
        &["ls-files", "-z", "--others", "--ignored", "--directory", "--no-empty-directory", "--exclude-from", &list],
    )
    .map_err(|e| e.message)?;
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    // check-ignore applies the repository's own ignore rules; it exits 1 when nothing matches.
    let ignored = match run("git", &["check-ignore", "-z", "--stdin"], root, Some(candidates.as_bytes()), GIT_TIMEOUT) {
        Ok((0, out, _)) => {
            String::from_utf8_lossy(&out).split('\0').filter(|x| !x.is_empty()).map(str::to_string).collect::<Vec<_>>()
        }
        _ => return Ok(Vec::new()),
    };
    let mut copied = Vec::new();
    for rel in ignored {
        let to = p_join(&[target, &rel]);
        if exists(&to) {
            continue;
        }
        copy_recursive(Path::new(&p_join(&[root, &rel])), Path::new(&to)).map_err(|e| format!("Error: {e}"))?;
        copied.push(rel.trim_end_matches('/').to_string());
    }
    Ok(copied)
}

/// `cpSync(from, to, { recursive: true, force: false })`.
fn copy_recursive(from: &Path, to: &Path) -> std::io::Result<()> {
    if from.is_dir() {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &to.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        if to.exists() {
            return Ok(());
        }
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(from, to).map(|_| ())
    }
}

/// `runWorktreeSetup`: a project's setup command in a new checkout, its
/// output streamed to `on_output`. Never fails: `(ok, detail)`.
#[cfg(test)]
pub async fn run_setup(
    command: &str,
    cwd: &str,
    on_output: impl FnMut(String) + Send,
    limit: Duration,
) -> (bool, String) {
    run_setup_with_cancel(command, cwd, on_output, limit, None).await
}

pub async fn run_setup_with_cancel(
    command: &str,
    cwd: &str,
    mut on_output: impl FnMut(String) + Send,
    limit: Duration,
    cancel: Option<&nekko_loop::Cancel>,
) -> (bool, String) {
    use tokio::io::AsyncReadExt;
    let mut cmd = if cfg!(windows) {
        let mut c = tokio::process::Command::new(std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into()));
        c.args(["/d", "/s", "/c"]);
        #[cfg(windows)]
        c.raw_arg(format!("\"{command}\""));
        c
    } else {
        let mut c = tokio::process::Command::new("/bin/sh");
        c.args(["-c", command]);
        c
    };
    cmd.current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return (false, e.to_string()),
    };
    let pid = child.id();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let mut readers = Vec::new();
    for pipe in [
        child.stdout.take().map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
        child.stderr.take().map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let tx = tx.clone();
        readers.push(tokio::spawn(async move {
            let mut pipe = pipe;
            let mut buf = vec![0u8; 8192];
            while let Ok(n) = pipe.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                let _ = tx.send(String::from_utf8_lossy(&buf[..n]).into_owned());
            }
        }));
    }
    drop(tx);
    let deadline = tokio::time::sleep(limit);
    tokio::pin!(deadline);
    let mut status = loop {
        tokio::select! {
            Some(text) = rx.recv() => on_output(text),
            status = child.wait() => break Some(status),
            _ = &mut deadline => break None,
            _ = async { match cancel { Some(c) => c.cancelled().await, None => std::future::pending::<()>().await } } => break None,
        }
    };
    // Exit can win the select before the pipe tasks have published final output.
    // Wait for EOF within the original deadline, then stop any lingering readers.
    if status.is_some() {
        loop {
            tokio::select! {
                text = rx.recv() => match text {
                    Some(text) => on_output(text),
                    None => break,
                },
                _ = &mut deadline => break,
                _ = async { match cancel { Some(c) => c.cancelled().await, None => std::future::pending::<()>().await } } => { status = None; break; },
            }
        }
    }
    for reader in readers {
        reader.abort();
    }
    while let Ok(text) = rx.try_recv() {
        on_output(text);
    }
    match status {
        Some(Ok(s)) if s.success() => (true, String::new()),
        Some(Ok(s)) => (false, format!("exit code {}", s.code().map_or("null".to_string(), |c| c.to_string()))),
        Some(Err(e)) => (false, e.to_string()),
        None => {
            // A shell's children outlive it on Windows unless the whole tree is killed.
            if cfg!(windows)
                && let Some(pid) = pid
            {
                let mut k = Command::new("taskkill");
                k.args(["/pid", &pid.to_string(), "/T", "/F"]).stdout(Stdio::null()).stderr(Stdio::null());
                no_window(&mut k);
                let _ = k.status();
            }
            #[cfg(unix)]
            if let Some(pid) = pid {
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
            }
            let _ = child.kill().await;
            (
                false,
                if cancel.is_some_and(|c| c.is_cancelled()) {
                    "cancelled".into()
                } else {
                    format!("stopped after {} minutes", (limit.as_secs_f64() / 60.0).round())
                },
            )
        }
    }
}

// --------------------------------------------------------- list and remove

/// The chat that owns a checkout, for the list.
pub struct Owner {
    pub id: String,
    pub title: String,
    pub running: bool,
}

/// `listChatWorktrees`: every chat worktree in the configured projects'
/// repositories, found through Git, so deleted chats' checkouts show too.
pub fn list(settings: &Value, lookup: &dyn Fn(&str) -> Option<Owner>) -> Vec<Value> {
    let mut repos: Vec<(String, String)> = Vec::new();
    for folder in workspaces_of(settings) {
        let path = s(&folder, "path");
        if let Ok(c) = git(path, &["rev-parse", "--git-common-dir"]) {
            let common = p_resolve(&[path, &c]);
            let key = norm(&common);
            match repos.iter_mut().find(|(k, _)| *k == key) {
                Some(slot) => slot.1 = common,
                None => repos.push((key, common)),
            }
        }
    }
    let sep = if cfg!(windows) { "\\" } else { "/" };
    let mut out = Vec::new();
    for (_, common) in repos {
        let home = p_join(&[&common, "nekko-worktrees"]);
        let Ok(listing) = git(&common, &["worktree", "list", "--porcelain"]) else { continue };
        let blocks: Vec<Map<String, Value>> = split_blocks(&listing)
            .into_iter()
            .map(|b| {
                b.lines()
                    .map(|l| {
                        let l = l.trim_end_matches('\r');
                        let key = l.split(' ').next().unwrap_or_default().to_string();
                        // `l.slice(l.indexOf(' ') + 1)`: the whole line when there is no space.
                        let value = l.find(' ').map_or(l, |i| &l[i + 1..]).to_string();
                        (key, json!(value))
                    })
                    .collect()
            })
            .collect();
        let source_root =
            p_resolve(&[blocks.first().and_then(|b| b.get("worktree")).and_then(Value::as_str).unwrap_or("")]);
        for b in &blocks {
            let root = p_resolve(&[b.get("worktree").and_then(Value::as_str).unwrap_or("")]);
            if !norm(&root).starts_with(&format!("{}{sep}", norm(&home))) || !exists(&root) {
                continue;
            }
            let branch = b
                .get("branch")
                .and_then(Value::as_str)
                .map(|br| br.strip_prefix("refs/heads/").unwrap_or(br).to_string());
            let chat = lookup(&root);
            let session_id = chat.as_ref().map(|c| c.id.clone()).unwrap_or_else(|| {
                Path::new(&root).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
            });
            let dirty = git(&root, &["status", "--porcelain"])
                .map(|o| o.split('\n').filter(|l| !l.is_empty()).count())
                .unwrap_or(0);
            let unmerged = branch
                .as_ref()
                .and_then(|br| git(&source_root, &["rev-list", "--count", &format!("HEAD..{br}")]).ok())
                .map(|n| nekko_js::string_to_number(&n))
                .filter(|n| nekko_js::truthy_number(*n))
                .unwrap_or(0.0);
            let mut entry = Map::new();
            entry.insert("root".into(), json!(root));
            entry.insert("sourceRoot".into(), json!(source_root));
            if let Some(br) = &branch {
                entry.insert("branch".into(), json!(br));
            }
            entry.insert("sessionId".into(), json!(session_id));
            if let Some(c) = &chat {
                entry.insert("sessionTitle".into(), json!(c.title));
            }
            entry.insert("running".into(), json!(chat.as_ref().is_some_and(|c| c.running)));
            entry.insert("dirtyCount".into(), json!(dirty));
            entry.insert("unmergedCount".into(), nekko_oauth::num(unmerged));
            out.push(Value::Object(entry));
        }
    }
    out
}

/// `list.split(/\r?\n\r?\n/)`.
fn split_blocks(s: &str) -> Vec<String> {
    s.replace("\r\n", "\n").split("\n\n").map(str::to_string).collect()
}

/// `removeChatWorktree`: Git refuses a dirty worktree and the branch goes
/// only when merged, so no work is lost.
pub fn remove(settings: &Value, root: &str, lookup: &dyn Fn(&str) -> Option<Owner>) -> Result<Value, String> {
    let entry = list(settings, lookup)
        .into_iter()
        .find(|w| norm(s(w, "root")) == norm(root))
        .ok_or("That folder is not a chat worktree of a configured project.")?;
    if entry["running"] == json!(true) {
        return Err("This chat is running. Stop it before removing its worktree.".into());
    }
    let dirty = entry["dirtyCount"].as_u64().unwrap_or(0);
    if dirty > 0 {
        return Err(format!(
            "This worktree has {dirty} uncommitted change{}. Commit or discard them first.",
            if dirty == 1 { "" } else { "s" }
        ));
    }
    let (source, wt) = (s(&entry, "sourceRoot").to_string(), s(&entry, "root").to_string());
    if let Err(e) = git(&source, &["worktree", "remove", &wt]) {
        // Windows: Git deletes the files, then cannot delete a folder a terminal
        // still has open. Once Git has let go of it, the empty folder is harmless.
        git_ok(&source, &["worktree", "prune"]);
        let listing = git(&source, &["worktree", "list", "--porcelain"]).map_err(|e| e.message)?;
        let held = listing
            .lines()
            .any(|l| l.trim_end_matches('\r').strip_prefix("worktree ").is_some_and(|p| norm(p) == norm(&wt)));
        if held {
            return Err(format!("Git could not remove the worktree: {}", nekko_js::trim(&e.stderr_or_message())));
        }
    }
    let branch = entry.get("branch").and_then(Value::as_str).unwrap_or_default();
    let deleted = !branch.is_empty() && git_ok(&source, &["branch", "-d", branch]);
    Ok(json!({ "branchDeleted": deleted }))
}

/// The host's `chatOwner`: the chat whose checkout lives at `root`.
fn owner_in(sessions: &[Value], running: &[String], root: &str) -> Option<Owner> {
    let session = sessions.iter().find(|s| {
        s.get("gitWorktrees")
            .and_then(Value::as_object)
            .is_some_and(|m| m.values().any(|w| norm(self::s(w, "root")) == norm(root)))
    })?;
    let id = self::s(session, "id").to_string();
    Some(Owner { running: running.contains(&id), title: self::s(session, "title").to_string(), id })
}

/// `removeMergedChatWorktrees`: remove the chat worktrees whose branch's PR
/// has merged. Squash merges leave the branch "unmerged" to Git, so the PR
/// (from GitHub) says the work landed, and the branch is force-deleted. The
/// PR only counts when its head commit is the local branch tip; anything
/// dirty, a running chat, an unmerged PR or a failed lookup is left alone.
/// Never fails: one stuck worktree does not stop the others. `(root, branch)`
/// of each one removed.
pub async fn sweep_merged(ctx: &crate::routes::Ctx) -> Vec<(String, String)> {
    let settings = crate::settings::current(ctx).await;
    if settings.pointer("/gitManagement/removeMerged") == Some(&Value::Bool(false)) {
        return Vec::new();
    }
    let store = ctx.sessions.clone();
    let owners = |store: Arc<nekko_store::SessionStore>, running: Vec<String>| {
        let sessions = store.list();
        move |r: &str| owner_in(&sessions, &running, r)
    };
    let running = crate::routes::running_chats(ctx);
    let (s, st) = (settings.clone(), store.clone());
    let entries = tokio::task::spawn_blocking(move || list(&s, &owners(st, running))).await.unwrap_or_default();
    let mut removed = Vec::new();
    for w in entries {
        let (root, branch) = (self::s(&w, "root").to_string(), self::s(&w, "branch").to_string());
        if branch.is_empty() || w["running"] == true || w["dirtyCount"].as_u64().unwrap_or(0) > 0 {
            continue;
        }
        let Some((state, head)) = ctx.workspace.prs().branch_pr_head(&root, &branch).await else { continue };
        if state != "merged" {
            continue;
        }
        // Re-check right before removing: the chat may have started a turn,
        // edited a file or committed while GitHub was being asked.
        let running = crate::routes::running_chats(ctx);
        let (s, st, source) = (settings.clone(), store.clone(), self::s(&w, "sourceRoot").to_string());
        let (r, b) = (root.clone(), branch.clone());
        let done = tokio::task::spawn_blocking(move || {
            let lookup = owners(st, running);
            if lookup(&r).is_some_and(|o| o.running) {
                return false;
            }
            match (git(&r, &["status", "--porcelain"]), git(&r, &["rev-parse", "HEAD"])) {
                (Ok(dirty), Ok(tip)) if dirty.trim().is_empty() && tip.trim().eq_ignore_ascii_case(&head) => {}
                _ => return false,
            }
            if remove(&s, &r, &lookup).is_err() {
                return false;
            }
            let _ = git(&source, &["branch", "-D", &b]);
            true
        })
        .await
        .unwrap_or(false);
        if done {
            removed.push((root, branch));
        }
    }
    removed
}

pub async fn route(ctx: &crate::routes::Ctx, channel: &str, args: &[Value]) -> Result<Value, String> {
    let settings = crate::settings::current(ctx).await;
    let store = ctx.sessions.clone();
    let running = crate::routes::running_chats(ctx);
    let root = args.first().and_then(Value::as_str).unwrap_or_default().to_string();
    let channel = channel.to_string();
    tokio::task::spawn_blocking(move || {
        let sessions = store.list();
        let lookup = |r: &str| owner_in(&sessions, &running, r);
        match channel.as_str() {
            "chatWorktrees:list" => Ok(Value::Array(list(&settings, &lookup))),
            _ => remove(&settings, &root, &lookup),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A timed-out command returns on time even when something it started
    /// still holds its output, and that something is ended too.
    #[cfg(unix)]
    #[test]
    fn a_timeout_returns_and_ends_the_whole_group() {
        let marker = std::env::temp_dir().join(format!("nekkod-run-group-{}", std::process::id()));
        let _ = std::fs::remove_file(&marker);
        let script = format!("(sleep 2; touch {}) & sleep 30", marker.display());
        let started = Instant::now();
        let out =
            run("sh", &["-c", &script], &std::env::temp_dir().to_string_lossy(), None, Duration::from_millis(300));
        assert!(out.unwrap_err().contains("ETIMEDOUT"));
        assert!(started.elapsed() < Duration::from_secs(2), "took {:?}", started.elapsed());
        std::thread::sleep(Duration::from_secs(3));
        assert!(!marker.exists(), "the background child was left running");
    }

    struct Repo {
        root: String,
    }

    impl Repo {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("nekkod-wt-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let root = dir.to_string_lossy().into_owned();
            let r = Repo { root };
            r.git(&["init", "-q"]);
            r.git(&["config", "user.email", "test@example.com"]);
            r.git(&["config", "user.name", "Test"]);
            r.git(&["config", "commit.gpgsign", "false"]);
            // Fixture bytes must not depend on the runner's global Git defaults.
            r.git(&["config", "core.autocrlf", "false"]);
            r.write("file.txt", "committed\n");
            r.git(&["add", "."]);
            r.git(&["commit", "-q", "-m", "Initial"]);
            r
        }

        fn git(&self, args: &[&str]) -> String {
            git(&self.root, args).unwrap_or_else(|e| panic!("git {args:?}: {}", e.message))
        }

        fn write(&self, rel: &str, text: &str) {
            let p = Path::new(&self.root).join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        }

        fn settings(&self) -> Value {
            json!({ "workspaces": [{ "id": "repo", "name": "Repo", "path": self.root }] })
        }
    }

    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn session(id: &str) -> Value {
        json!({ "id": id, "title": "New chat", "workspaceId": "repo", "gitIsolation": true, "messages": [], "createdAt": 1, "updatedAt": 1 })
    }

    fn read(p: &str, rel: &str) -> String {
        std::fs::read_to_string(Path::new(p).join(rel)).unwrap()
    }

    #[test]
    fn stacked_checkout_uses_the_pinned_parent_and_preserves_source_edits() {
        let r = Repo::new("stack-parent");
        r.git(&["checkout", "-b", "parent-feature"]);
        r.write("file.txt", "parent PR code\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-m", "Parent feature"]);
        let sha = r.git(&["rev-parse", "HEAD"]);
        r.git(&["checkout", "-"]);
        r.write("file.txt", "user edits\n");
        let mut settings = r.settings();
        settings["gitManagement"] = json!({"baseline": "local-changes"});
        let mut chat = session("stack");
        chat["gitStackParent"] = json!({"workspaceId": "repo", "url": "https://github.com/owner/repo/pull/12", "branch": "parent-feature", "sha": sha.trim()});
        prepare(&mut chat, &settings).unwrap();
        let wt = &chat["gitWorktrees"]["repo"];
        assert_eq!(read(s(wt, "path"), "file.txt"), "parent PR code\n");
        assert_eq!(read(&r.root, "file.txt"), "user edits\n");
        assert_eq!(
            git(s(wt, "path"), &["config", &format!("branch.{}.gh-merge-base", s(wt, "branch"))]).unwrap().trim(),
            "parent-feature"
        );
        assert!(s(wt, "notice").contains("Link stack"));
        let checkout_root = s(wt, "root").to_string();
        let branch = s(wt, "branch").to_string();
        assert!(prepare(&mut chat, &settings).unwrap().is_empty());
        r.git(&["worktree", "remove", "--force", &checkout_root]);
        assert_eq!(prepare(&mut chat, &settings).unwrap().len(), 1);
        let restored = &chat["gitWorktrees"]["repo"];
        assert_eq!(read(s(restored, "path"), "file.txt"), "parent PR code\n");
        assert!(s(restored, "notice").contains("https://github.com/owner/repo/pull/12"));
        assert!(s(restored, "notice").contains("Link stack"));
        r.git(&["worktree", "remove", "--force", &checkout_root]);
        r.git(&["branch", "-D", &branch]);
        assert!(prepare(&mut chat, &settings).unwrap_err().contains("branch was deleted"));
        assert!(!exists(&checkout_root));
        assert_eq!(read(&r.root, "file.txt"), "user edits\n");
    }

    #[test]
    fn aliased_paths_stay_inside_the_isolated_checkout() {
        let repo = Repo::new("alias");
        #[cfg(windows)]
        let alias = {
            use std::os::windows::ffi::OsStrExt;
            let wide: Vec<u16> = std::ffi::OsStr::new(&repo.root).encode_wide().chain(Some(0)).collect();
            let mut buf = vec![0u16; 32768];
            // Only asks Windows for another spelling of this fixture's path.
            let n = unsafe {
                windows_sys::Win32::Storage::FileSystem::GetShortPathNameW(
                    wide.as_ptr(),
                    buf.as_mut_ptr(),
                    buf.len() as u32,
                )
            };
            if n == 0 || n as usize >= buf.len() {
                return;
            }
            String::from_utf16_lossy(&buf[..n as usize])
        };
        #[cfg(unix)]
        let alias = {
            let p = std::env::temp_dir().join(format!("nekkod-wt-alias-link-{}", std::process::id()));
            let _ = std::fs::remove_file(&p);
            std::os::unix::fs::symlink(&repo.root, &p).unwrap();
            p.to_string_lossy().into_owned()
        };
        let mut settings = repo.settings();
        settings["workspaces"][0]["path"] = json!(alias);
        repo.write("file.txt", "source only\n");
        let mut chat = session("s_alias");
        prepare(&mut chat, &settings).unwrap();
        let checkout = &chat["gitWorktrees"]["repo"];
        assert_eq!(norm(s(checkout, "path")), norm(s(checkout, "root")));
        assert_eq!(read(s(checkout, "path"), "file.txt"), "committed\n");
        assert_eq!(read(&repo.root, "file.txt"), "source only\n");
        assert_eq!(chat_workspaces(Some(&chat), &settings)[0]["path"], checkout["path"]);
        chat["gitWorktrees"]["repo"]["path"] = json!(alias);
        prepare(&mut chat, &settings).unwrap();
        assert_eq!(chat["gitWorktrees"]["repo"]["path"], chat["gitWorktrees"]["repo"]["root"]);
        settings["workspaces"][0]["path"] = json!(std::env::temp_dir().to_string_lossy());
        assert!(prepare(&mut chat, &settings).unwrap_err().contains("no longer belongs"));
        #[cfg(unix)]
        let _ = std::fs::remove_file(alias);
    }

    #[test]
    fn concurrent_chats_are_isolated_from_head() {
        let repo = Repo::new("iso");
        let settings = repo.settings();
        repo.write("file.txt", "local edits\n");
        let (mut a, mut b) = (session("s_a"), session("s_b"));
        assert_eq!(prepare(&mut a, &settings).unwrap().len(), 1);
        prepare(&mut b, &settings).unwrap();
        let (pa, pb) =
            (s(&a["gitWorktrees"]["repo"], "path").to_string(), s(&b["gitWorktrees"]["repo"], "path").to_string());
        assert_ne!(pa, pb);
        assert_eq!(read(&pa, "file.txt"), "committed\n");
        assert_eq!(read(&repo.root, "file.txt"), "local edits\n");
        assert!(s(&a["gitWorktrees"]["repo"], "notice").contains("Existing local changes are not included."));
        assert_eq!(chat_workspaces(Some(&a), &settings)[0]["path"], json!(pa));
        assert!(prepare(&mut a, &settings).unwrap().is_empty(), "idempotent");
        assert!(s(&a["gitWorktrees"]["repo"], "branch").starts_with("nekko/"));
    }

    #[test]
    fn tracked_edits_are_copied_only_when_configured() {
        let repo = Repo::new("copy");
        repo.write("file.txt", "local edits\n");
        repo.write("secret.txt", "not copied");
        let mut settings = repo.settings();
        settings["gitManagement"] = json!({ "baseline": "local-changes" });
        let mut a = session("s_copy");
        prepare(&mut a, &settings).unwrap();
        let p = s(&a["gitWorktrees"]["repo"], "path").to_string();
        assert_eq!(read(&p, "file.txt"), "local edits\n");
        assert!(!Path::new(&p).join("secret.txt").exists());
    }

    #[test]
    fn worktreeinclude_copies_only_ignored_listed_files() {
        let repo = Repo::new("incl");
        repo.write(".gitignore", ".env\nbuild/\n");
        repo.write(".worktreeinclude", ".env\nnotes.txt\n");
        repo.git(&["add", ".gitignore", ".worktreeinclude"]);
        repo.git(&["commit", "-q", "-m", "Ignore"]);
        repo.write(".env", "TOKEN=local\n");
        repo.write("notes.txt", "untracked but not ignored");
        repo.write("build/out.js", "not listed");
        let mut a = session("s_incl");
        prepare(&mut a, &repo.settings()).unwrap();
        let p = s(&a["gitWorktrees"]["repo"], "path").to_string();
        assert_eq!(read(&p, ".env"), "TOKEN=local\n");
        assert!(!Path::new(&p).join("notes.txt").exists());
        assert!(!Path::new(&p).join("build").exists());
        assert!(s(&a["gitWorktrees"]["repo"], "notice").contains(".worktreeinclude: .env"));
    }

    #[test]
    fn old_chats_without_isolation_are_left_alone() {
        let repo = Repo::new("old");
        let mut old = session("s_old");
        old.as_object_mut().unwrap().remove("gitIsolation");
        assert!(prepare(&mut old, &repo.settings()).unwrap().is_empty());
        assert!(old.get("gitWorktrees").is_none());
    }

    #[test]
    fn worktrees_are_listed_removed_and_restored_without_losing_work() {
        let repo = Repo::new("life");
        let settings = repo.settings();
        let mut a = session("s_life");
        prepare(&mut a, &settings).unwrap();
        let wt = s(&a["gitWorktrees"]["repo"], "root").to_string();
        let branch = s(&a["gitWorktrees"]["repo"], "branch").to_string();
        let owner = |r: &str| {
            (norm(r) == norm(&wt)).then(|| Owner { id: "s_life".into(), title: "Life".into(), running: false })
        };
        let listed = list(&settings, &owner);
        assert_eq!(listed.len(), 1);
        assert_eq!((listed[0]["sessionId"].clone(), listed[0]["dirtyCount"].clone()), (json!("s_life"), json!(0)));
        std::fs::write(Path::new(&wt).join("file.txt"), "work in progress\n").unwrap();
        assert!(remove(&settings, &wt, &owner).unwrap_err().contains("uncommitted"));
        git(&wt, &["-c", "user.email=t@e", "-c", "user.name=T", "commit", "-q", "-am", "Chat work"]).unwrap();
        let running = |_: &str| Some(Owner { id: "s_life".into(), title: "Life".into(), running: true });
        assert!(remove(&settings, &wt, &running).unwrap_err().contains("running"));
        assert_eq!(list(&settings, &owner)[0]["unmergedCount"], json!(1));
        assert_eq!(remove(&settings, &wt, &owner).unwrap(), json!({ "branchDeleted": false }));
        assert!(!Path::new(&wt).exists());
        std::fs::create_dir_all(&wt).unwrap();
        assert_eq!(prepare(&mut a, &settings).unwrap().len(), 1);
        assert_eq!(read(&wt, "file.txt"), "work in progress\n");
        assert!(s(&a["gitWorktrees"]["repo"], "notice").contains("restored from its branch"));
        repo.git(&["merge", "-q", "--ff-only", &branch]);
        assert_eq!(remove(&settings, &wt, &owner).unwrap(), json!({ "branchDeleted": true }));
        assert!(remove(&settings, &repo.root, &owner).unwrap_err().contains("not a chat worktree"));
    }

    #[tokio::test]
    async fn setup_commands_report_failures_without_failing() {
        let repo = Repo::new("setup");
        let mut out = String::new();
        for _ in 0..20 {
            out.clear();
            let ok = run_setup("echo setup-ran", &repo.root, |t| out.push_str(&t), Duration::from_secs(60)).await;
            assert_eq!(ok, (true, String::new()));
            assert!(out.contains("setup-ran"), "{out}");
        }
        let bad = run_setup("exit 3", &repo.root, |_| {}, Duration::from_secs(60)).await;
        assert_eq!(bad, (false, "exit code 3".to_string()));
    }

    #[test]
    fn checkouts_are_named_after_a_chosen_title_else_three_words() {
        assert_eq!(slugify_title("Fix the  Login/Bug! (round 2)"), "fix-the-login-bug-round-2");
        // As JavaScript has it: NFKD puts the accent after its letter, and the accent is a separator.
        assert_eq!(slugify_title("Caf\u{e9} cr\u{e8}me"), "cafe-cre-me");
        assert!(slugify_title(&"x".repeat(60)).len() <= 40);
        let titled = json!({ "title": "Fix login bug", "titleAuto": false });
        assert_eq!(worktree_name(&titled, &|_| false, &mut || 0.0), "fix-login-bug");
        assert_eq!(worktree_name(&titled, &|n| n == "fix-login-bug", &mut || 0.0), "fix-login-bug-2");
        let auto = json!({ "title": "write me a test", "titleAuto": true });
        assert_eq!(worktree_name(&auto, &|_| false, &mut || 0.0), "brisk-amber-otter");
        assert_eq!(worktree_name(&json!({ "title": "New chat" }), &|_| false, &mut || 0.999), "tidy-cobalt-cat");
    }
}
