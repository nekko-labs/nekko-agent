//! `execFile` as git.ts and pr.ts call it: no shell, no window, a timeout
//! that kills the child, and an output cap past which the call fails.

use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;

/// What `run` resolves with in the TS host (it never rejects).
#[derive(Debug, Clone, Default)]
pub struct Output {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
    /// The binary is not installed (spawn failed with ENOENT).
    pub missing: bool,
}

/// Run `bin args` in `cwd`, at most `timeout`, with at most `max` bytes on
/// either stream.
pub async fn run(bin: &str, args: &[&str], timeout: Duration, cwd: Option<&str>, max: usize) -> Output {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            // A missing working directory also fails the spawn with ENOENT, and
            // Node reports that the same way.
            return Output { missing: e.kind() == std::io::ErrorKind::NotFound, ..Default::default() };
        }
    };
    let (mut out, mut err) = (child.stdout.take(), child.stderr.take());
    let read = async {
        let (mut o, mut e) = (Vec::new(), Vec::new());
        let read_o = async {
            if let Some(s) = out.as_mut() {
                let _ = s.take(max as u64 + 1).read_to_end(&mut o).await;
            }
        };
        let read_e = async {
            if let Some(s) = err.as_mut() {
                let _ = s.take(max as u64 + 1).read_to_end(&mut e).await;
            }
        };
        tokio::join!(read_o, read_e);
        let status = child.wait().await;
        (o, e, status)
    };
    match tokio::time::timeout(timeout, read).await {
        Ok((o, e, status)) => {
            let over = o.len() > max || e.len() > max;
            Output {
                ok: !over && status.is_ok_and(|s| s.success()),
                stdout: String::from_utf8_lossy(&o[..o.len().min(max)]).into_owned(),
                stderr: String::from_utf8_lossy(&e[..e.len().min(max)]).into_owned(),
                missing: false,
            }
        }
        // Dropping the future drops the child, which kills it.
        Err(_) => Output::default(),
    }
}
