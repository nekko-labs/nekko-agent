//! The `bash` tool's process: Node's `child_process.exec`, rebuilt.
//!
//! The TS host runs a command with `exec(command, { cwd, timeout: 120000,
//! maxBuffer: 10 MiB })`: the platform shell (`%ComSpec% /d /s /c "<cmd>"` on
//! Windows, `/bin/sh -c <cmd>` elsewhere), output decoded as UTF-8, and on
//! failure an error whose message the tool result repeats. This keeps the
//! shell, the decoding and the messages, and changes three things on purpose:
//!
//! - A timeout or a cancel kills the whole process tree (a job object on
//!   Windows, the process group on Unix). Node signals only the shell, so a
//!   grandchild holding the pipes kept the call waiting.
//! - The call can be cancelled ([`crate::Cancel`]); the result says so.
//! - stdin is closed rather than an open pipe nobody writes, so a command
//!   that reads it gets end-of-file instead of hanging until the timeout.
//!
//! Only the first stretch of each stream is kept (enough to fill the tool
//! result, which is capped); the rest is still counted toward `maxBuffer` and
//! still mirrored to the command log.

use crate::context::{BoxFuture, Cancel};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc;

/// The TS host's `exec` options and result cap.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BashLimits {
    /// `timeout`: 120 s.
    pub timeout: Duration,
    /// `maxBuffer`, per stream: 10 MiB.
    pub max_buffer: usize,
    /// The tool result's length cap, in UTF-16 code units: 60 000.
    pub output_cap: usize,
}

impl Default for BashLimits {
    fn default() -> Self {
        Self { timeout: Duration::from_secs(120), max_buffer: 10 * 1024 * 1024, output_cap: 60_000 }
    }
}

/// One command to run.
pub struct RunRequest<'a> {
    pub command: &'a str,
    pub cwd: &'a str,
    pub limits: BashLimits,
    pub cancel: &'a Cancel,
    /// Every decoded chunk of stdout and stderr, as it arrives.
    pub on_output: &'a (dyn Fn(&str) + Send + Sync),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Failure {
    /// What Node's `exec` error would say in `e.message`.
    Error(String),
    Cancelled,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RunOutcome {
    pub stdout: String,
    pub stderr: String,
    pub failure: Option<Failure>,
}

/// Runs `bash` commands. [`ShellRunner`] is the real one; tests and, later,
/// other sandboxes can substitute their own.
pub trait CommandRunner: Send + Sync {
    fn run<'a>(&'a self, req: RunRequest<'a>) -> BoxFuture<'a, RunOutcome>;
}

/// The shell Node's `exec` uses: `%ComSpec%` (else `cmd.exe`) on Windows,
/// `/bin/sh` elsewhere.
pub fn shell() -> String {
    if cfg!(windows) { std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into()) } else { "/bin/sh".into() }
}

/// Runs commands in the platform shell.
pub struct ShellRunner;

impl CommandRunner for ShellRunner {
    fn run<'a>(&'a self, req: RunRequest<'a>) -> BoxFuture<'a, RunOutcome> {
        Box::pin(run_shell(req))
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stream {
    Out,
    Err,
}

/// Keeps the head of a stream and counts all of it.
struct Capture {
    kept: Vec<u8>,
    total: usize,
    keep: usize,
}

impl Capture {
    fn new(limits: &BashLimits) -> Self {
        // A UTF-16 code unit takes at most three bytes of UTF-8 (a lone
        // invalid byte decodes to one unit), so this always fills the cap.
        let keep = limits.output_cap.saturating_mul(4).max(16).min(limits.max_buffer);
        Self { kept: Vec::new(), total: 0, keep }
    }

    fn push(&mut self, chunk: &[u8]) {
        let room = self.keep.saturating_sub(self.kept.len());
        self.kept.extend_from_slice(&chunk[..chunk.len().min(room)]);
        self.total += chunk.len();
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.kept).into_owned()
    }
}

/// Chunk-boundary-safe UTF-8 decoding for the live mirror, so a character
/// split across two reads is not shown as two replacement characters.
#[derive(Default)]
pub(crate) struct Utf8Carry {
    pending: Vec<u8>,
}

impl Utf8Carry {
    pub(crate) fn decode(&mut self, chunk: &[u8]) -> String {
        let mut bytes = std::mem::take(&mut self.pending);
        bytes.extend_from_slice(chunk);
        let mut out = String::with_capacity(bytes.len());
        let mut rest: &[u8] = &bytes;
        loop {
            match std::str::from_utf8(rest) {
                Ok(s) => {
                    out.push_str(s);
                    break;
                }
                Err(e) => {
                    let (valid, after) = rest.split_at(e.valid_up_to());
                    out.push_str(std::str::from_utf8(valid).unwrap_or_default());
                    match e.error_len() {
                        None => {
                            self.pending = after.to_vec();
                            break;
                        }
                        Some(n) => {
                            out.push('\u{FFFD}');
                            rest = &after[n..];
                        }
                    }
                }
            }
        }
        out
    }

    pub(crate) fn finish(&mut self) -> String {
        if self.pending.is_empty() {
            String::new()
        } else {
            String::from_utf8_lossy(&std::mem::take(&mut self.pending)).into_owned()
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kill {
    Timeout,
    Cancel,
    MaxBuffer(Stream),
}

/// How long a killed tree gets to let go of its pipes before we stop reading.
const KILL_GRACE: Duration = Duration::from_secs(5);

fn command(req: &RunRequest<'_>, shell: &str) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(shell);
    #[cfg(windows)]
    {
        // Node passes `/d /s /c "<command>"` verbatim (windowsVerbatimArguments).
        cmd.raw_arg(format!("/d /s /c \"{}\"", req.command));
        // CREATE_NO_WINDOW: the daemon has no console, and a flashing one per
        // command would be worse than Node's default.
        cmd.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        cmd.arg("-c").arg(req.command);
        // Its own group, so a timeout can signal everything it started.
        cmd.process_group(0);
    }
    cmd.current_dir(req.cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    cmd
}

/// The error code Node's `spawn` reports. libuv on Windows resolves the shell
/// against the working directory first, so any unusable directory is ENOENT;
/// on Unix the child's `chdir` says ENOENT or ENOTDIR.
pub(crate) fn spawn_code(cwd: &str, e: &std::io::Error) -> &'static str {
    let meta = std::fs::metadata(cwd);
    if cfg!(windows) {
        if !meta.as_ref().is_ok_and(|m| m.is_dir()) {
            return "ENOENT";
        }
    } else {
        match &meta {
            Err(_) => return "ENOENT",
            Ok(m) if !m.is_dir() => return "ENOTDIR",
            _ => {}
        }
    }
    crate::nodefs::code_name(e)
}

async fn run_shell(req: RunRequest<'_>) -> RunOutcome {
    let shell = shell();
    let mut child = match command(&req, &shell).spawn() {
        Ok(c) => c,
        Err(e) => {
            return RunOutcome {
                failure: Some(Failure::Error(format!("spawn {shell} {}", spawn_code(req.cwd, &e)))),
                ..Default::default()
            };
        }
    };
    let tree = tree::Tree::attach(&child);

    let (tx, mut rx) = mpsc::channel::<(Stream, Vec<u8>)>(64);
    let mut readers = Vec::new();
    for (stream, pipe) in [
        (Stream::Out, child.stdout.take().map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Unpin + Send>)),
        (Stream::Err, child.stderr.take().map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Unpin + Send>)),
    ] {
        let Some(mut pipe) = pipe else { continue };
        let tx = tx.clone();
        readers.push(tokio::spawn(async move {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match pipe.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if tx.send((stream, buf[..n].to_vec())).await.is_err() {
                            break;
                        }
                    }
                }
            }
        }));
    }
    drop(tx);

    let mut out = Capture::new(&req.limits);
    let mut err = Capture::new(&req.limits);
    let (mut out_carry, mut err_carry) = (Utf8Carry::default(), Utf8Carry::default());
    let mut exit: Option<Option<std::process::ExitStatus>> = None;
    let mut streams_open = true;
    let mut killed: Option<Kill> = None;
    let timeout = tokio::time::sleep(req.limits.timeout);
    tokio::pin!(timeout);
    let mut grace: Option<std::pin::Pin<Box<tokio::time::Sleep>>> = None;

    let kill = |why: Kill, killed: &mut Option<Kill>, grace: &mut Option<_>| {
        if killed.is_none() {
            *killed = Some(why);
            tree.kill();
            *grace = Some(Box::pin(tokio::time::sleep(KILL_GRACE)));
        }
    };

    loop {
        if exit.is_some() && !streams_open {
            break;
        }
        tokio::select! {
            msg = rx.recv(), if streams_open => match msg {
                None => streams_open = false,
                Some((stream, chunk)) => {
                    let (cap, carry) = match stream {
                        Stream::Out => (&mut out, &mut out_carry),
                        Stream::Err => (&mut err, &mut err_carry),
                    };
                    let text = carry.decode(&chunk);
                    if !text.is_empty() {
                        (req.on_output)(&text);
                    }
                    cap.push(&chunk);
                    if cap.total > req.limits.max_buffer {
                        kill(Kill::MaxBuffer(stream), &mut killed, &mut grace);
                    }
                }
            },
            status = child.wait(), if exit.is_none() => exit = Some(status.ok()),
            _ = &mut timeout, if killed.is_none() => kill(Kill::Timeout, &mut killed, &mut grace),
            _ = req.cancel.cancelled(), if killed.is_none() => kill(Kill::Cancel, &mut killed, &mut grace),
            _ = async { if let Some(g) = grace.as_mut() { g.await } }, if grace.is_some() => break,
        }
    }
    for r in readers {
        r.abort();
    }
    for carry in [&mut out_carry, &mut err_carry] {
        let rest = carry.finish();
        if !rest.is_empty() {
            (req.on_output)(&rest);
        }
    }

    let stdout = out.text();
    let stderr = err.text();
    let success = exit.flatten().is_some_and(|s| s.success());
    let failure = match killed {
        Some(Kill::MaxBuffer(s)) => {
            let name = if s == Stream::Out { "stdout" } else { "stderr" };
            Some(Failure::Error(format!("{name} maxBuffer length exceeded")))
        }
        Some(Kill::Cancel) => Some(Failure::Cancelled),
        Some(Kill::Timeout) => Some(Failure::Error(format!("Command failed: {}\n{stderr}", req.command))),
        None if !success => Some(Failure::Error(format!("Command failed: {}\n{stderr}", req.command))),
        None => None,
    };
    RunOutcome { stdout, stderr, failure }
}

/// Killing everything a command started.
#[cfg(windows)]
pub(crate) mod tree {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW, TerminateJobObject};

    /// A job object holding the shell and, by inheritance, its descendants.
    /// Closing it does not kill them: a command may leave a server running,
    /// as it could under Node.
    pub struct Tree {
        job: HANDLE,
        pid: Option<u32>,
    }

    // SAFETY: a job handle is a kernel object handle, usable from any thread.
    unsafe impl Send for Tree {}
    unsafe impl Sync for Tree {}

    impl Tree {
        pub fn attach(child: &tokio::process::Child) -> Self {
            let pid = child.id();
            let Some(process) = child.raw_handle() else { return Self { job: std::ptr::null_mut(), pid } };
            // SAFETY: plain Win32 calls on handles we own or were given.
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return Self { job, pid };
                }
                if AssignProcessToJobObject(job, process as HANDLE) == 0 {
                    CloseHandle(job);
                    return Self { job: std::ptr::null_mut(), pid };
                }
                Self { job, pid }
            }
        }

        pub fn kill(&self) {
            if !self.job.is_null() {
                // SAFETY: the handle is open until drop.
                unsafe {
                    TerminateJobObject(self.job, 1);
                }
            } else if let Some(pid) = self.pid {
                // No job (assignment can fail inside some sandboxes): fall
                // back to taskkill's tree kill.
                let _ = std::process::Command::new("taskkill")
                    .args(["/T", "/F", "/PID", &pid.to_string()])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status();
            }
        }
    }

    impl Drop for Tree {
        fn drop(&mut self) {
            if !self.job.is_null() {
                // SAFETY: closing the handle we created, once.
                unsafe {
                    CloseHandle(self.job);
                }
            }
        }
    }
}

#[cfg(unix)]
pub(crate) mod tree {
    /// The command's process group (the shell leads it).
    pub struct Tree {
        pgid: Option<i32>,
    }

    impl Tree {
        pub fn attach(child: &tokio::process::Child) -> Self {
            Self { pgid: child.id().and_then(|p| i32::try_from(p).ok()) }
        }

        /// SIGTERM, as Node sends, to the whole group, then SIGKILL for
        /// anything still there a moment later.
        pub fn kill(&self) {
            let Some(pgid) = self.pgid else { return };
            // SAFETY: kill(2) with a negative pid signals a process group.
            unsafe {
                libc::kill(-pgid, libc::SIGTERM);
            }
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(1500));
                // SAFETY: as above; a group that is gone yields ESRCH.
                unsafe {
                    libc::kill(-pgid, libc::SIGKILL);
                }
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_split_characters_whole() {
        let mut c = Utf8Carry::default();
        let snowman = "\u{2603}".as_bytes();
        assert_eq!(c.decode(&snowman[..1]), "");
        assert_eq!(c.decode(&snowman[1..]), "\u{2603}");
        assert_eq!(c.decode(b"a\xffb"), "a\u{FFFD}b");
        assert_eq!(c.decode(&snowman[..2]), "");
        assert_eq!(c.finish(), "\u{FFFD}");
    }

    #[test]
    fn capture_keeps_enough_for_the_cap() {
        let limits = BashLimits { output_cap: 10, ..Default::default() };
        let mut c = Capture::new(&limits);
        c.push(&[b'x'; 100]);
        assert_eq!((c.kept.len(), c.total), (40, 100));
    }
}
