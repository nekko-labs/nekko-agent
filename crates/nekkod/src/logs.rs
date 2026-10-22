//! The computer's logs (IO-33 FA-5): the daemon's own rotating log file,
//! and `logs:list` / `logs:read` over it, the desktop app's log and each
//! chat's agent run log (agent_logs.rs's `sessions/<id>.commands.log`).
//!
//! Where they live: `<dataDir>/logs/nekkod.log` (this process's stderr,
//! teed: it still reaches the terminal or the app that started it) and
//! `<dataDir>/logs/app.log` (Electron main's console, apps/desktop
//! `appLog.ts`), each rotated at [`ROTATE_BYTES`] into `.1` .. `.{KEEP}`.
//!
//! Every line a read returns goes through [`redact`] first, and a search
//! matches the redacted line, so a search cannot confirm a secret either.

use serde_json::{Map, Value, json};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::UNIX_EPOCH;

pub const CHANNELS: &[&str] = &["logs:list", "logs:read"];

/// A log file is rotated when a write would take it past this.
pub const ROTATE_BYTES: u64 = 5 * 1024 * 1024;
/// Rotated files kept beside the live one (`.1` is the newest).
pub const KEEP: usize = 3;
/// What a read returns by default, and at most.
const TAIL_DEFAULT: u64 = 64 * 1024;
const TAIL_MAX: u64 = 1024 * 1024;
/// How far back a search looks by default, and at most.
const SEARCH_DEFAULT: u64 = 1024 * 1024;
const SEARCH_MAX: u64 = 8 * 1024 * 1024;
/// Matching lines a search returns by default, and at most.
const MATCHES_DEFAULT: usize = 200;
const MATCHES_MAX: usize = 1000;
/// A returned line is cut at this many characters.
const LINE_CHARS: usize = 2000;
/// Agent run logs listed, newest first.
const AGENT_LOGS: usize = 100;

pub const DAEMON_LOG: &str = "nekkod.log";
pub const APP_LOG: &str = "app.log";

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// An append-only log file that rotates itself: past `max` bytes the live
/// file becomes `.1`, `.1` becomes `.2`, and the oldest past `keep` goes.
pub struct RotatingLog {
    path: PathBuf,
    max: u64,
    keep: usize,
    file: Option<File>,
    size: u64,
}

impl RotatingLog {
    pub fn open(path: &Path, max: u64, keep: usize) -> std::io::Result<RotatingLog> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let file = open_append(path)?;
        let size = file.metadata().map(|m| m.len()).unwrap_or(0);
        Ok(RotatingLog { path: path.to_path_buf(), max, keep, file: Some(file), size })
    }

    pub fn append(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        if self.size > 0 && self.size + bytes.len() as u64 > self.max {
            self.rotate()?;
        }
        let file = match &mut self.file {
            Some(f) => f,
            None => self.file.insert(open_append(&self.path)?),
        };
        file.write_all(bytes)?;
        self.size += bytes.len() as u64;
        Ok(())
    }

    fn rotate(&mut self) -> std::io::Result<()> {
        self.file = None;
        let _ = std::fs::remove_file(rotated(&self.path, self.keep));
        for i in (1..self.keep).rev() {
            let _ = std::fs::rename(rotated(&self.path, i), rotated(&self.path, i + 1));
        }
        if self.keep > 0 {
            std::fs::rename(&self.path, rotated(&self.path, 1))?;
        } else {
            std::fs::remove_file(&self.path)?;
        }
        self.file = Some(open_append(&self.path)?);
        self.size = 0;
        Ok(())
    }
}

fn open_append(path: &Path) -> std::io::Result<File> {
    let mut opts = OpenOptions::new();
    opts.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)
}

/// `nekkod.log.2` for `(nekkod.log, 2)`.
fn rotated(path: &Path, i: usize) -> PathBuf {
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(format!(".{i}"));
    path.with_file_name(name)
}

fn stamp() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// Stamps each line start with the time, across writes that split lines.
#[cfg_attr(not(unix), allow(dead_code))]
struct Stamper {
    at_line_start: bool,
}

#[cfg_attr(not(unix), allow(dead_code))]
impl Stamper {
    fn stamp(&mut self, chunk: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(chunk.len() + 32);
        for line in chunk.split_inclusive(|b| *b == b'\n') {
            if self.at_line_start {
                out.extend_from_slice(stamp().as_bytes());
                out.push(b' ');
            }
            out.extend_from_slice(line);
            self.at_line_start = line.ends_with(b"\n");
        }
        out
    }
}

static DAEMON: OnceLock<Arc<Mutex<RotatingLog>>> = OnceLock::new();

/// Undoes the stderr tee on drop: stderr goes straight to where it went
/// before, and what is still in the pipe is copied out first (briefly), so a
/// last error line before exit is not lost.
pub struct DaemonLog {
    #[cfg(unix)]
    restore: Option<(i32, std::sync::mpsc::Receiver<()>)>,
}

impl Drop for DaemonLog {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some((saved, done)) = self.restore.take() {
            // SAFETY: plain fd calls on descriptors this module owns; fd 2 is
            // pointed back at the saved original, which closes the pipe's
            // write end held there.
            unsafe {
                libc::dup2(saved, 2);
                libc::close(saved);
            }
            // Children that inherited the pipe may keep it open; don't wait for them.
            let _ = done.recv_timeout(std::time::Duration::from_millis(500));
        }
    }
}

/// Start writing this process's stderr to `<dir>/nekkod.log` as well. On
/// Unix the descriptor itself is teed (every crate's output, panics and
/// inherited child stderr); elsewhere only [`note`] lines and panics reach the
/// file. None when the file cannot be opened (logging is never fatal).
pub fn start_daemon_log(dir: &Path) -> Option<DaemonLog> {
    let log = match RotatingLog::open(&dir.join(DAEMON_LOG), ROTATE_BYTES, KEEP) {
        Ok(l) => Arc::new(Mutex::new(l)),
        Err(e) => {
            eprintln!("nekkod: could not open the daemon log in {}: {e}", dir.display());
            return None;
        }
    };
    let _ = DAEMON.set(log.clone());
    #[cfg(unix)]
    {
        let restore = tee_stderr(log);
        Some(DaemonLog { restore })
    }
    #[cfg(not(unix))]
    {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            note(&format!("nekkod: {info}"));
            previous(info);
        }));
        Some(DaemonLog {})
    }
}

/// A line for the daemon log (and stderr).
pub fn note(line: &str) {
    eprintln!("{line}");
    #[cfg(not(unix))]
    if let Some(log) = DAEMON.get() {
        let _ = lock(log).append(format!("{} {line}\n", stamp()).as_bytes());
    }
}

#[cfg(unix)]
fn tee_stderr(log: Arc<Mutex<RotatingLog>>) -> Option<(i32, std::sync::mpsc::Receiver<()>)> {
    use std::os::fd::FromRawFd;
    let mut fds = [0i32; 2];
    // SAFETY: pipe/dup/dup2 on fresh descriptors; on any failure the
    // descriptors made so far are closed and stderr is left alone.
    let saved = unsafe {
        if libc::pipe(fds.as_mut_ptr()) != 0 {
            return None;
        }
        let saved = libc::dup(2);
        if saved < 0 || libc::dup2(fds[1], 2) < 0 {
            libc::close(fds[0]);
            libc::close(fds[1]);
            if saved >= 0 {
                libc::close(saved);
            }
            return None;
        }
        libc::close(fds[1]);
        // Children must not inherit the read end.
        libc::fcntl(fds[0], libc::F_SETFD, libc::FD_CLOEXEC);
        libc::fcntl(saved, libc::F_SETFD, libc::FD_CLOEXEC);
        saved
    };
    // SAFETY: both descriptors are owned here from now on.
    let (mut reader, writer_fd) = (unsafe { File::from_raw_fd(fds[0]) }, unsafe { libc::dup(saved) });
    let mut original = if writer_fd >= 0 { Some(unsafe { File::from_raw_fd(writer_fd) }) } else { None };
    let (tx, rx) = std::sync::mpsc::channel();
    let spawned = std::thread::Builder::new().name("nekkod-log".into()).spawn(move || {
        let mut stamper = Stamper { at_line_start: true };
        let mut buf = vec![0u8; 16 * 1024];
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            };
            if let Some(o) = original.as_mut() {
                let _ = o.write_all(&buf[..n]);
            }
            let _ = lock(&log).append(&stamper.stamp(&buf[..n]));
        }
        let _ = tx.send(());
    });
    if spawned.is_err() {
        // Nobody would drain the pipe: put stderr back.
        unsafe {
            libc::dup2(saved, 2);
            libc::close(saved);
        }
        return None;
    }
    Some((saved, rx))
}

// ---------------------------------------------------------------- redaction

/// What every redacted value becomes.
pub const REDACTED: &str = "[redacted]";

struct Rules {
    userinfo: regress::Regex,
    scheme: regress::Regex,
    query: regress::Regex,
    pairs: regress::Regex,
    tokens: regress::Regex,
    private_key: regress::Regex,
    hex: regress::Regex,
    run: regress::Regex,
}

fn rules() -> &'static Rules {
    static RULES: OnceLock<Rules> = OnceLock::new();
    RULES.get_or_init(|| {
        let re = |src: &str, flags: &str| regress::Regex::with_flags(src, flags).expect("redaction pattern compiles");
        Rules {
            // https://user:pass@host
            userinfo: re(r"([a-z][a-z0-9+.-]*://)[^/\s:@]+:[^/\s@]+@", "i"),
            // Authorization schemes.
            scheme: re(r"\b(bearer|basic|token)\s+([A-Za-z0-9._~+/=-]{8,})", "i"),
            // Query parameters that open something (the iOS Diagnostics.redact set and more).
            query: re(
                r"([?&](?:room|key|pair|code|token|access_token|refresh_token|id_token|sig|signature|auth|password|secret|apikey|api_key)=)[^&\s#]+",
                "i",
            ),
            // key=value, key: value, "key": "value", KEY=value in env style.
            pairs: re(
                r#"(?<![A-Za-z0-9])((?:api[_-]?key|access[_-]?key(?:[_-]?id)?|secret[_-]?access[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|session[_-]?token|token|secret|client[_-]?secret|password|passwd|pwd|passphrase|private[_-]?key|authorization|cookie|set-cookie|session[_-]?id|x-api-key|key)["']?\s*[:=]\s*["']?)([^\s"',;&}]+)"#,
                "i",
            ),
            // Known credential shapes.
            tokens: re(
                r"(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|hf_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{30,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})",
                "",
            ),
            private_key: re(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----", "i"),
            hex: re(r"(?<![A-Za-z0-9])[0-9a-fA-F]{32,}(?![A-Za-z0-9])", ""),
            run: re(r"[A-Za-z0-9+/_-]{40,}={0,2}", ""),
        }
    })
}

/// Replace each match of `re` in `text` by what `f` makes of it.
fn replace(re: &regress::Regex, text: &str, mut f: impl FnMut(&regress::Match, &str) -> String) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for m in re.find_iter(text) {
        let r = m.range();
        out.push_str(&text[last..r.start]);
        out.push_str(&f(&m, text));
        last = r.end;
    }
    out.push_str(&text[last..]);
    out
}

fn group<'a>(m: &regress::Match, text: &'a str, i: usize) -> &'a str {
    m.group(i).map(|r| &text[r]).unwrap_or("")
}

/// A long run of base64-ish characters that looks like a key rather than a
/// path or a word: upper, lower and digits, and no `/` part shorter than 24.
fn looks_like_key(run: &str) -> bool {
    let has = |f: fn(&char) -> bool| run.chars().any(|c| f(&c));
    if !(has(char::is_ascii_uppercase) && has(char::is_ascii_lowercase) && has(char::is_ascii_digit)) {
        return false;
    }
    !run.contains('/') || run.split('/').all(|part| part.len() >= 24 || part.is_empty())
}

/// One line with anything that looks like a secret replaced by
/// [`REDACTED`]: credentials in URLs, Bearer/Basic values, secret-named
/// keys' values, known token shapes (OpenAI, Anthropic, GitHub, Slack, AWS,
/// Google, Hugging Face, GitLab, npm, JWTs), private-key headers, hex runs
/// of 32+ and long base64-looking runs. In the spirit of the iPhone's
/// `Diagnostics.redact`, wider.
pub fn redact(line: &str) -> String {
    let r = rules();
    if r.private_key.find(line).is_some() {
        return format!("{REDACTED} private key");
    }
    let s = replace(&r.userinfo, line, |m, t| format!("{}{REDACTED}@", group(m, t, 1)));
    let s = replace(&r.scheme, &s, |m, t| format!("{} {REDACTED}", group(m, t, 1)));
    let s = replace(&r.query, &s, |m, t| format!("{}{REDACTED}", group(m, t, 1)));
    let s = replace(&r.pairs, &s, |m, t| {
        let value = group(m, t, 2);
        if value.starts_with(REDACTED) || value.eq_ignore_ascii_case("bearer") || value.eq_ignore_ascii_case("basic") {
            format!("{}{value}", group(m, t, 1))
        } else {
            format!("{}{REDACTED}", group(m, t, 1))
        }
    });
    let s = replace(&r.tokens, &s, |_, _| REDACTED.to_string());
    let s = replace(&r.hex, &s, |_, _| REDACTED.to_string());
    replace(&r.run, &s, |m, t| {
        let run = &t[m.range()];
        if looks_like_key(run) { REDACTED.to_string() } else { run.to_string() }
    })
}

// ---------------------------------------------------------------- the channels

/// A log: the files it spans, oldest first (rotated ones, then the live one).
struct Log {
    files: Vec<PathBuf>,
}

impl Log {
    fn rotating(path: PathBuf) -> Log {
        let mut files: Vec<PathBuf> = (1..=KEEP).rev().map(|i| rotated(&path, i)).filter(|p| p.is_file()).collect();
        if path.is_file() {
            files.push(path);
        }
        Log { files }
    }

    fn sizes(&self) -> Vec<u64> {
        self.files.iter().map(|p| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)).collect()
    }

    fn updated_at(&self) -> Option<u64> {
        self.files
            .iter()
            .filter_map(|p| std::fs::metadata(p).ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .max()
    }

    /// The last `n` bytes across the files, and the offset they start at.
    fn tail(&self, n: u64) -> std::io::Result<(Vec<u8>, u64, u64)> {
        let sizes = self.sizes();
        let total: u64 = sizes.iter().sum();
        let start = total.saturating_sub(n);
        let mut out = Vec::with_capacity((total - start) as usize);
        let mut offset = 0u64;
        for (path, size) in self.files.iter().zip(sizes) {
            let end = offset + size;
            if end > start {
                let mut f = File::open(path)?;
                let from = start.saturating_sub(offset);
                f.seek(SeekFrom::Start(from))?;
                f.take(size - from).read_to_end(&mut out)?;
            }
            offset = end;
        }
        Ok((out, start, total))
    }

    /// Newlines before `offset`, for line numbers.
    fn lines_before(&self, offset: u64) -> std::io::Result<u64> {
        let mut count = 0u64;
        let mut left = offset;
        let mut buf = vec![0u8; 64 * 1024];
        for path in &self.files {
            if left == 0 {
                break;
            }
            let mut f = File::open(path)?.take(left);
            loop {
                let n = f.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                count += buf[..n].iter().filter(|b| **b == b'\n').count() as u64;
                left -= n as u64;
            }
        }
        Ok(count)
    }
}

fn cut_line(line: &str) -> String {
    if line.chars().count() <= LINE_CHARS {
        return line.to_string();
    }
    let mut s: String = line.chars().take(LINE_CHARS).collect();
    s.push('…');
    s
}

/// The logs under a data directory.
pub struct Logs {
    dir: PathBuf,
}

impl Logs {
    pub fn new(data_dir: &Path) -> Logs {
        Logs { dir: data_dir.to_path_buf() }
    }

    fn logs_dir(&self) -> PathBuf {
        self.dir.join("logs")
    }

    fn sessions_dir(&self) -> PathBuf {
        self.dir.join("sessions")
    }

    fn find(&self, id: &str) -> Result<Log, String> {
        match id {
            "daemon" => Ok(Log::rotating(self.logs_dir().join(DAEMON_LOG))),
            "app" => Ok(Log::rotating(self.logs_dir().join(APP_LOG))),
            _ => {
                let sid = id.strip_prefix("agent:").ok_or_else(|| format!("not-found: no log {id}"))?;
                if !nekko_store::valid_id(sid) {
                    return Err(format!("not-found: no log {id}"));
                }
                let path = self.sessions_dir().join(format!("{sid}.commands.log"));
                Ok(Log { files: if path.is_file() { vec![path] } else { Vec::new() } })
            }
        }
    }

    /// `logs:list`: the app's and the daemon's logs (listed even when empty,
    /// so a caller can say so), then each chat's agent run log, newest first.
    /// `titles` names chats by id.
    pub fn list(&self, titles: &dyn Fn(&str) -> Option<String>) -> Value {
        let entry = |id: &str, title: String, kind: &str, log: &Log, extra: Option<(&str, Value)>| {
            let mut m = Map::new();
            m.insert("id".into(), json!(id));
            m.insert("title".into(), json!(title));
            m.insert("kind".into(), json!(kind));
            m.insert("size".into(), json!(log.sizes().iter().sum::<u64>()));
            m.insert("updatedAt".into(), json!(log.updated_at()));
            if let Some((k, v)) = extra {
                m.insert(k.into(), v);
            }
            Value::Object(m)
        };
        let mut out = vec![
            entry("app", "Desktop app".into(), "app", &Log::rotating(self.logs_dir().join(APP_LOG)), None),
            entry("daemon", "Engine (nekkod)".into(), "daemon", &Log::rotating(self.logs_dir().join(DAEMON_LOG)), None),
        ];
        let mut agent: Vec<(u64, String, PathBuf)> = std::fs::read_dir(self.sessions_dir())
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                let sid = name.strip_suffix(".commands.log")?.to_string();
                if !nekko_store::valid_id(&sid) {
                    return None;
                }
                let t = e.metadata().ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64;
                Some((t, sid, e.path()))
            })
            .collect();
        agent.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
        agent.truncate(AGENT_LOGS);
        for (_, sid, path) in agent {
            let title = titles(&sid).filter(|t| !t.is_empty()).unwrap_or_else(|| "Chat".into());
            let log = Log { files: vec![path] };
            out.push(entry(&format!("agent:{sid}"), title, "agent", &log, Some(("sessionId", json!(sid)))));
        }
        Value::Array(out)
    }

    /// `logs:read(id, { tailBytes, query, maxMatches })`: without `query`,
    /// the last `tailBytes` (from a line start) as redacted text; with it,
    /// the redacted lines in the last `tailBytes` (default 1 MB here, at most
    /// 8 MB) that hold `query`, case-insensitively, with line numbers.
    pub fn read(&self, id: &str, opts: &Value) -> Result<Value, String> {
        let log = self.find(id)?;
        let query = opts.get("query").and_then(Value::as_str).map(str::trim).filter(|q| !q.is_empty());
        let asked = opts.get("tailBytes").and_then(Value::as_u64);
        let n = match query {
            Some(_) => asked.unwrap_or(SEARCH_DEFAULT).clamp(1, SEARCH_MAX),
            None => asked.unwrap_or(TAIL_DEFAULT).clamp(1, TAIL_MAX),
        };
        let (bytes, mut start, total) = log.tail(n).map_err(|e| format!("io: {e}"))?;
        // Begin at a line start unless the window is the whole log.
        let mut body: &[u8] = &bytes;
        if start > 0 {
            match body.iter().position(|b| *b == b'\n') {
                Some(i) => {
                    body = &body[i + 1..];
                    start += i as u64 + 1;
                }
                None => body = &[],
            }
        }
        let text = String::from_utf8_lossy(body);
        let mut out = Map::new();
        out.insert("id".into(), json!(id));
        out.insert("size".into(), json!(total));
        out.insert("updatedAt".into(), json!(log.updated_at()));
        out.insert("truncated".into(), json!(start > 0));
        match query {
            None => {
                let lines: Vec<String> = text.lines().map(|l| cut_line(&redact(l))).collect();
                let mut joined = lines.join("\n");
                if text.ends_with('\n') && !joined.is_empty() {
                    joined.push('\n');
                }
                out.insert("text".into(), json!(joined));
            }
            Some(q) => {
                let cap = opts
                    .get("maxMatches")
                    .and_then(Value::as_u64)
                    .map(|m| m as usize)
                    .unwrap_or(MATCHES_DEFAULT)
                    .clamp(1, MATCHES_MAX);
                let first = log.lines_before(start).map_err(|e| format!("io: {e}"))? + 1;
                let needle = q.to_lowercase();
                let mut matches = Vec::new();
                let mut more = false;
                for (i, line) in text.lines().enumerate() {
                    let clean = redact(line);
                    if !clean.to_lowercase().contains(&needle) {
                        continue;
                    }
                    if matches.len() == cap {
                        more = true;
                        break;
                    }
                    matches.push(json!({ "line": first + i as u64, "text": cut_line(&clean) }));
                }
                out.insert("query".into(), json!(q));
                out.insert("matches".into(), Value::Array(matches));
                out.insert("moreMatches".into(), json!(more));
            }
        }
        Ok(Value::Object(out))
    }
}

pub async fn route(ctx: &crate::routes::Ctx, channel: &str, args: &[Value]) -> Result<Value, String> {
    let Some(dir) = ctx.workspace.data_dir().map(Path::to_path_buf) else {
        return Err(format!("{channel} needs the data directory"));
    };
    let logs = Logs::new(&dir);
    match channel {
        "logs:list" => {
            let store = ctx.sessions.clone();
            tokio::task::spawn_blocking(move || {
                let titles: std::collections::HashMap<String, String> = store
                    .map(|s| s.summaries())
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|s| {
                        Some((s.get("id")?.as_str()?.to_string(), s.get("title")?.as_str().unwrap_or("").to_string()))
                    })
                    .collect();
                logs.list(&|id| titles.get(id).cloned())
            })
            .await
            .map_err(|e| e.to_string())
        }
        "logs:read" => {
            let id = args.first().and_then(Value::as_str).unwrap_or_default().to_string();
            let opts = args.get(1).cloned().unwrap_or(Value::Null);
            tokio::task::spawn_blocking(move || logs.read(&id, &opts)).await.map_err(|e| e.to_string())?
        }
        _ => Err(format!("unknown channel {channel}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn rotates_at_the_cap_and_keeps_a_few() {
        let d = tmp();
        let path = d.path().join("logs").join("x.log");
        let mut log = RotatingLog::open(&path, 10, 2).unwrap();
        for chunk in ["aaaaaa\n", "bbbbbb\n", "cccccc\n", "dddddd\n"] {
            log.append(chunk.as_bytes()).unwrap();
        }
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "dddddd\n");
        assert_eq!(std::fs::read_to_string(rotated(&path, 1)).unwrap(), "cccccc\n");
        assert_eq!(std::fs::read_to_string(rotated(&path, 2)).unwrap(), "bbbbbb\n");
        assert!(!rotated(&path, 3).exists(), "only two rotated files are kept");
        // Reopening continues the live file's size.
        let mut log = RotatingLog::open(&path, 10, 2).unwrap();
        log.append(b"e\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "dddddd\ne\n");
        log.append(b"ff\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "ff\n");
        // A single write over the cap still lands whole.
        log.append(&[b'z'; 30]).unwrap();
        assert_eq!(std::fs::read(&path).unwrap().len(), 30);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn stamps_line_starts_across_split_writes() {
        let mut s = Stamper { at_line_start: true };
        let a = String::from_utf8(s.stamp(b"one\ntw")).unwrap();
        let b = String::from_utf8(s.stamp(b"o\nthree")).unwrap();
        let all = format!("{a}{b}");
        let lines: Vec<&str> = all.split('\n').collect();
        assert_eq!(lines.len(), 3);
        for (line, want) in lines.iter().zip(["one", "two", "three"]) {
            let (stamp, rest) = line.split_once(' ').unwrap();
            assert!(stamp.ends_with('Z') && stamp.len() == 24, "{stamp}");
            assert_eq!(rest, want);
        }
    }

    #[test]
    fn redacts_secrets() {
        // Shared with the iPhone's share button, which redacts again before a log leaves the phone.
        let golden: serde_json::Value = serde_json::from_str(include_str!("../tests/golden/log-redact.json")).unwrap();
        for case in golden["cases"].as_array().unwrap() {
            let (input, want) = (case[0].as_str().unwrap(), case[1].as_str().unwrap());
            assert_eq!(redact(input), want, "{input}");
        }
        // Ordinary lines are left alone.
        for keep in golden["keep"].as_array().unwrap() {
            let keep = keep.as_str().unwrap();
            assert_eq!(redact(keep), keep, "{keep}");
        }
        let ios: serde_json::Value = serde_json::from_str(include_str!(
            "../../../apps/ios/Protocol/Tests/NekkoProtocolTests/Fixtures/log-redact.json"
        ))
        .unwrap();
        assert_eq!(ios, golden, "the iPhone's copy of log-redact.json is stale");
    }

    fn logs_with(dir: &Path, daemon: &str) -> Logs {
        std::fs::create_dir_all(dir.join("logs")).unwrap();
        std::fs::write(dir.join("logs").join(DAEMON_LOG), daemon).unwrap();
        Logs::new(dir)
    }

    #[test]
    fn lists_app_daemon_and_agent_logs() {
        let d = tmp();
        let logs = logs_with(d.path(), "hello\n");
        std::fs::write(d.path().join("logs").join("nekkod.log.1"), "older\n").unwrap();
        std::fs::create_dir_all(d.path().join("sessions")).unwrap();
        std::fs::write(d.path().join("sessions").join("s1.commands.log"), "$ ls\n").unwrap();
        std::fs::write(d.path().join("sessions").join("s1.json"), "{}").unwrap();
        std::fs::write(d.path().join("sessions").join("..bad.commands.log"), "").unwrap();
        let list = logs.list(&|id| (id == "s1").then(|| "Fix the build".to_string()));
        let ids: Vec<_> = list.as_array().unwrap().iter().map(|e| e["id"].as_str().unwrap().to_string()).collect();
        assert_eq!(ids, ["app", "daemon", "agent:s1"]);
        assert_eq!(list[0]["size"], 0);
        assert_eq!(list[1]["size"], 12, "the live file and the rotated one");
        assert_eq!(list[2]["title"], "Fix the build");
        assert_eq!(list[2]["sessionId"], "s1");
        assert!(list[2]["updatedAt"].as_u64().unwrap() > 0);
    }

    #[test]
    fn reads_a_redacted_tail_from_a_line_start() {
        let d = tmp();
        let logs = logs_with(d.path(), "first line\nsecond token=abc\nthird\n");
        std::fs::write(d.path().join("logs").join("nekkod.log.1"), "rotated one\n").unwrap();
        let r = logs.read("daemon", &json!({})).unwrap();
        assert_eq!(r["text"], "rotated one\nfirst line\nsecond token=[redacted]\nthird\n");
        assert_eq!(r["truncated"], false);
        let r = logs.read("daemon", &json!({ "tailBytes": 25 })).unwrap();
        assert_eq!(r["text"], "second token=[redacted]\nthird\n", "the cut line is dropped");
        assert_eq!(r["truncated"], true);
        assert_eq!(r["size"], 12 + 34);
        assert!(logs.read("agent:../x", &json!({})).unwrap_err().starts_with("not-found"));
        assert!(logs.read("other", &json!({})).unwrap_err().starts_with("not-found"));
        // A missing log reads as empty.
        assert_eq!(logs.read("app", &json!({})).unwrap()["text"], "");
    }

    #[test]
    fn searches_redacted_lines_with_numbers_and_a_cap() {
        let d = tmp();
        let mut body = String::new();
        for i in 1..=50 {
            body.push_str(&format!("line {i} {}\n", if i % 10 == 0 { "ERROR boom" } else { "ok" }));
        }
        body.push_str("Authorization: Bearer supersecretvalue123\n");
        let logs = logs_with(d.path(), &body);
        let r = logs.read("daemon", &json!({ "query": "error" })).unwrap();
        let lines: Vec<u64> = r["matches"].as_array().unwrap().iter().map(|m| m["line"].as_u64().unwrap()).collect();
        assert_eq!(lines, [10, 20, 30, 40, 50]);
        assert_eq!(r["matches"][0]["text"], "line 10 ERROR boom");
        assert_eq!(r["moreMatches"], false);
        let r = logs.read("daemon", &json!({ "query": "error", "maxMatches": 2 })).unwrap();
        assert_eq!(r["matches"].as_array().unwrap().len(), 2);
        assert_eq!(r["moreMatches"], true);
        // A search cannot find a secret: it matches the redacted line.
        let r = logs.read("daemon", &json!({ "query": "supersecret" })).unwrap();
        assert_eq!(r["matches"], json!([]));
        // Line numbers count from the start of the log when the window is a tail.
        let r = logs.read("daemon", &json!({ "query": "line 50", "tailBytes": 80 })).unwrap();
        assert_eq!(r["matches"][0]["line"], 50);
        assert_eq!(r["truncated"], true);
    }

    #[cfg(unix)]
    #[test]
    fn the_daemon_log_tees_stderr() {
        // Runs in a child so the test harness's own stderr is left alone.
        if std::env::var("NEKKOD_LOG_TEE_CHILD").is_ok() {
            let dir = PathBuf::from(std::env::var("NEKKOD_LOG_TEE_DIR").unwrap());
            let guard = start_daemon_log(&dir).unwrap();
            eprintln!("hello from the tee");
            drop(guard);
            eprintln!("after the guard");
            return;
        }
        let d = tmp();
        let out = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "logs::tests::the_daemon_log_tees_stderr", "--nocapture"])
            .env("NEKKOD_LOG_TEE_CHILD", "1")
            .env("NEKKOD_LOG_TEE_DIR", d.path())
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(stderr.contains("hello from the tee"), "still on stderr: {stderr}");
        assert!(stderr.contains("after the guard"));
        let file = std::fs::read_to_string(d.path().join(DAEMON_LOG)).unwrap();
        assert!(file.contains("Z hello from the tee"), "{file}");
        assert!(!file.contains("after the guard"), "{file}");
    }
}
