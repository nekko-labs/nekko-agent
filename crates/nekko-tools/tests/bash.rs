//! The shell tool's limits, which the TS golden set cannot reach in a test's
//! time (its timeout is two minutes, its buffer ten megabytes). The expected
//! messages are what Node's `exec` produced for the same situations
//! (`timeout: 500` and `maxBuffer: 4`, run on Node 24), as the TS tool wraps
//! them: `Command failed: ${e.message}\n${stdout}${stderr}`.

use nekko_tools::{
    BashLimits, Cancel, ChatMode, CommandLog, SandboxMode, Severity, ToolCall, ToolContext, ToolResult, Workspace,
    approver_fn, execute,
};
use serde_json::json;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[cfg(windows)]
const SLEEP_30: &str = "ping -n 30 127.0.0.1 >nul";
#[cfg(not(windows))]
const SLEEP_30: &str = "sleep 30";

/// A grandchild that holds the pipes after its parent shell is killed.
#[cfg(windows)]
const NESTED_SLEEP: &str = "cmd /d /c ping -n 30 127.0.0.1";
#[cfg(not(windows))]
const NESTED_SLEEP: &str = "sh -c 'sleep 30; echo $((6*7))'";

fn context(limits: BashLimits) -> ToolContext {
    let mut ctx = ToolContext::new(approver_fn(|_c: ToolCall, _r: String, _s: Severity| async { true }));
    ctx.mode = ChatMode::Yolo;
    ctx.sandbox_mode = SandboxMode::Off;
    let dir = std::env::temp_dir();
    ctx.workspaces = vec![Workspace { id: "tmp".into(), path: dir.to_string_lossy().into_owned() }];
    ctx.limits = limits;
    ctx
}

async fn bash(ctx: &ToolContext, command: &str) -> ToolResult {
    execute(&ToolCall { id: "t".into(), name: "bash".into(), input: json!({ "command": command }) }, ctx).await
}

fn short(timeout_ms: u64) -> BashLimits {
    BashLimits { timeout: Duration::from_millis(timeout_ms), ..BashLimits::default() }
}

#[tokio::test]
async fn a_timeout_reads_as_nodes() {
    let ctx = context(short(500));
    let started = Instant::now();
    let res = bash(&ctx, SLEEP_30).await;
    assert!(res.is_error);
    assert_eq!(res.output, format!("Command failed: Command failed: {SLEEP_30}\n\n"));
    assert!(started.elapsed() < Duration::from_secs(10), "took {:?}", started.elapsed());
}

#[tokio::test]
async fn a_timeout_kills_the_whole_tree() {
    // Node would wait for the grandchild to let go of the pipes; killing the
    // tree returns well inside the 5 s grace.
    let ctx = context(short(500));
    let started = Instant::now();
    let res = bash(&ctx, NESTED_SLEEP).await;
    assert!(res.is_error);
    assert!(res.output.starts_with(&format!("Command failed: Command failed: {NESTED_SLEEP}\n")), "{}", res.output);
    // The grandchild died with its parent: it never got to print.
    #[cfg(not(windows))]
    assert!(!res.output.contains("42"), "{}", res.output);
    assert!(started.elapsed() < Duration::from_secs(4), "took {:?}", started.elapsed());
}

#[tokio::test]
async fn max_buffer_reads_as_nodes() {
    let ctx = context(BashLimits { max_buffer: 4, ..BashLimits::default() });
    let res = bash(&ctx, "echo 0123456789").await;
    assert!(res.is_error);
    assert_eq!(res.output, "Command failed: stdout maxBuffer length exceeded\n0123");
}

#[tokio::test]
async fn output_is_capped_in_code_units() {
    let ctx = context(BashLimits { output_cap: 10, ..BashLimits::default() });
    let res = bash(&ctx, "echo 0123456789abcdef").await;
    assert!(!res.is_error);
    assert_eq!(res.output, "0123456789");
}

#[tokio::test]
async fn a_large_output_fills_the_cap_and_is_mirrored_whole() {
    #[derive(Default)]
    struct Count(Mutex<usize>);
    impl CommandLog for Count {
        fn append(&self, _s: &str, _w: Option<&str>, data: &str) {
            *self.0.lock().unwrap() += data.len();
        }
    }
    #[cfg(windows)]
    let cmd = "for /L %i in (1,1,20000) do @echo 0123456789";
    #[cfg(not(windows))]
    let cmd = "i=0; while [ $i -lt 20000 ]; do echo 0123456789; i=$((i+1)); done";
    let mut ctx = context(BashLimits::default());
    let log = Arc::new(Count::default());
    ctx.session_id = Some("s".into());
    ctx.command_log = Some(log.clone());
    let res = bash(&ctx, cmd).await;
    assert!(!res.is_error, "{}", &res.output[..res.output.len().min(200)]);
    assert_eq!(res.output.encode_utf16().count(), 60_000);
    assert!(res.output.starts_with("0123456789"));
    // 20000 lines of 12 bytes as \r\n, plus the `$ ...` header.
    assert!(*log.0.lock().unwrap() >= 20_000 * 12);
}

/// #2594: a chat secret reaches the command as an environment variable, and
/// neither the result nor the Agent commands terminal shows its value.
#[tokio::test]
async fn a_chat_secret_is_in_the_environment_and_out_of_the_output() {
    #[derive(Default)]
    struct Log(Mutex<String>);
    impl CommandLog for Log {
        fn append(&self, _s: &str, _w: Option<&str>, data: &str) {
            self.0.lock().unwrap().push_str(data);
        }
    }
    let secrets = Arc::new(nekko_tools::Secrets::new());
    secrets.set("NEKKO_TEST_TOKEN", "sk-test-0123456789").unwrap();
    let mut ctx = context(BashLimits::default());
    let log = Arc::new(Log::default());
    ctx.session_id = Some("s".into());
    ctx.command_log = Some(log.clone());
    ctx.secrets = Some(secrets);
    #[cfg(windows)]
    let cmd = "echo key=%NEKKO_TEST_TOKEN% & echo len-ok";
    #[cfg(not(windows))]
    let cmd = "echo key=$NEKKO_TEST_TOKEN; echo len-ok";
    let res = bash(&ctx, cmd).await;
    assert!(!res.is_error, "{}", res.output);
    assert!(res.output.contains("key=[secret NEKKO_TEST_TOKEN]"), "{}", res.output);
    assert!(!res.output.contains("sk-test"), "{}", res.output);
    let shown = log.0.lock().unwrap().clone();
    assert!(shown.contains("[secret NEKKO_TEST_TOKEN]") && shown.contains("len-ok"), "{shown}");
    assert!(!shown.contains("sk-test"), "{shown}");
}

#[tokio::test]
async fn cancelling_stops_the_command() {
    let mut ctx = context(BashLimits::default());
    let cancel = Cancel::new();
    ctx.cancel = cancel.clone();
    let started = Instant::now();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        cancel.cancel();
    });
    let res = bash(&ctx, SLEEP_30).await;
    assert!(res.is_error);
    assert_eq!(res.output, "Command cancelled.\n");
    assert!(started.elapsed() < Duration::from_secs(10));
}

#[tokio::test]
async fn cancelling_an_open_approval_denies_it() {
    let mut ctx = context(BashLimits::default());
    ctx.mode = ChatMode::Guardrails;
    // An approval nobody answers.
    ctx.approver = approver_fn(|_c: ToolCall, _r: String, _s: Severity| std::future::pending::<bool>());
    let cancel = Cancel::new();
    ctx.cancel = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(200)).await;
        cancel.cancel();
    });
    let res = bash(&ctx, "rm -rf ./definitely-not-here").await;
    assert_eq!((res.output.as_str(), res.is_error), ("Command not approved by user.", true));
}

#[tokio::test]
async fn stdin_is_closed() {
    // A command that reads stdin ends at once instead of waiting for input.
    #[cfg(windows)]
    let cmd = "sort";
    #[cfg(not(windows))]
    let cmd = "cat";
    let ctx = context(short(20_000));
    let started = Instant::now();
    let res = bash(&ctx, cmd).await;
    assert_eq!((res.output.as_str(), res.is_error), ("(no output)", false));
    assert!(started.elapsed() < Duration::from_secs(10));
}

#[cfg(unix)]
#[tokio::test]
async fn invalid_utf8_output_decodes_like_node() {
    let ctx = context(BashLimits::default());
    let res = bash(&ctx, r"printf '\377ok\342\202'").await;
    assert_eq!(res.output, "\u{FFFD}ok\u{FFFD}");
}
