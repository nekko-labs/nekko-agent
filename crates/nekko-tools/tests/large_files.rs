//! A file too big to load whole: `read_file` streams a line range and shows
//! only the head of a whole read, so a multi-GB log or dump can never abort
//! the daemon out of memory; `edit_file` refuses past its limit.

use nekko_tools::{
    ChatMode, SandboxMode, Severity, ToolCall, ToolContext, ToolResult, Workspace, approver_fn, execute,
};
use serde_json::{Value, json};
use std::io::Write;
use std::path::PathBuf;

fn temp(tag: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("nekko-large-files-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).unwrap();
    std::fs::canonicalize(p).unwrap()
}

async fn call(ctx: &ToolContext, name: &str, input: Value) -> ToolResult {
    execute(&ToolCall { id: "t".into(), name: name.into(), input }, ctx).await
}

#[tokio::test]
async fn a_large_file_reads_a_range_as_a_stream_and_a_whole_read_as_its_head() {
    let ws = temp("read");
    let path = ws.join("big.log");
    {
        // 20 MB: past the 16 MB whole-read limit.
        let mut f = std::io::BufWriter::new(std::fs::File::create(&path).unwrap());
        for i in 1..=400_000u32 {
            writeln!(f, "line {i:06} {}", "x".repeat(40)).unwrap();
        }
    }
    let mut ctx = ToolContext::new(approver_fn(|_c: ToolCall, _r: String, _s: Severity| async { true }));
    ctx.mode = ChatMode::Yolo;
    ctx.sandbox_mode = SandboxMode::Off;
    ctx.workspaces = vec![Workspace { id: "w".into(), path: ws.to_string_lossy().into_owned() }];
    let file = path.to_string_lossy().into_owned();

    let range = call(&ctx, "read_file", json!({ "path": file, "start_line": 300_000, "end_line": 300_002 })).await;
    assert!(!range.is_error, "{}", range.output);
    let x = "x".repeat(40);
    assert_eq!(range.output, format!("300000: line 300000 {x}\n300001: line 300001 {x}\n300002: line 300002 {x}"));

    let past = call(&ctx, "read_file", json!({ "path": file, "start_line": 500_000, "end_line": 500_001 })).await;
    assert_eq!(past.output, "(no lines at or after 500000; 400000 total lines)");

    let whole = call(&ctx, "read_file", json!({ "path": file })).await;
    assert!(whole.output.starts_with("line 000001 "), "{}", &whole.output[..40]);
    assert!(whole.output.contains("truncated: the file is"), "{}", &whole.output[whole.output.len() - 120..]);
    let _ = std::fs::remove_dir_all(&ws);
}
