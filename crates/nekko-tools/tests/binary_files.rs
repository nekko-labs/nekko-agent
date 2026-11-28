//! `read_file` on a binary file (a picture here) returns a short note, not its raw bytes;
//! text files and UTF-16 files are still read, and long text is still capped.
use nekko_tools::{ChatMode, SandboxMode, Severity, ToolCall, ToolContext, Workspace, approver_fn, execute};
use serde_json::{Value, json};
use std::path::PathBuf;

async fn call(ctx: &ToolContext, name: &str, input: Value) -> nekko_tools::ToolResult {
    execute(&ToolCall { id: "t".into(), name: name.into(), input }, ctx).await
}

/// A fresh workspace folder holding `files`, and a context that may read it.
fn setup(tag: &str, files: &[(&str, Vec<u8>)]) -> (PathBuf, ToolContext) {
    let ws = std::env::temp_dir().join(format!("nekko-binary-files-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&ws);
    std::fs::create_dir_all(&ws).unwrap();
    let ws = std::fs::canonicalize(&ws).unwrap();
    for (name, bytes) in files {
        std::fs::write(ws.join(name), bytes).unwrap();
    }
    let mut ctx = ToolContext::new(approver_fn(|_c: ToolCall, _r: String, _s: Severity| async { true }));
    ctx.mode = ChatMode::Yolo;
    ctx.sandbox_mode = SandboxMode::Off;
    ctx.workspaces = vec![Workspace { id: "w".into(), path: ws.to_string_lossy().into_owned() }];
    (ws, ctx)
}

#[tokio::test]
async fn read_file_returns_a_note_for_a_binary_file_not_its_bytes() {
    // A PNG signature and IHDR header (NUL bytes included), then pixel-like bytes.
    let mut bytes = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR".to_vec();
    bytes.extend((0..20_000u32).map(|i| (i % 251) as u8));
    let (ws, ctx) = setup("png", &[("fox-reference.png", bytes)]);
    let path = ws.join("fox-reference.png");

    let read = call(&ctx, "read_file", json!({ "path": path.to_string_lossy() })).await;
    assert!(!read.is_error, "{}", read.output);
    assert!(
        read.output.starts_with("fox-reference.png is a binary file") && !read.output.contains('\0'),
        "read_file returned no note for a binary file: {:?}",
        read.output.chars().take(60).collect::<String>()
    );
    let _ = std::fs::remove_dir_all(&ws);
}

#[tokio::test]
async fn read_file_still_returns_the_contents_of_a_text_file() {
    let (ws, ctx) = setup("text", &[("notes.txt", b"first line\nsecond line\n".to_vec())]);
    let path = ws.join("notes.txt");

    let read = call(&ctx, "read_file", json!({ "path": path.to_string_lossy() })).await;
    assert!(!read.is_error, "{}", read.output);
    assert_eq!(read.output, "first line\nsecond line\n");
    let _ = std::fs::remove_dir_all(&ws);
}

#[tokio::test]
async fn read_file_still_reads_a_utf16_file_instead_of_a_note() {
    // UTF-16 LE with a byte-order mark: it has NUL bytes but is text.
    let mut bytes = vec![0xFF, 0xFE];
    for unit in "hello".encode_utf16() {
        bytes.extend(unit.to_le_bytes());
    }
    let (ws, ctx) = setup("utf16", &[("utf16.txt", bytes)]);
    let path = ws.join("utf16.txt");

    let read = call(&ctx, "read_file", json!({ "path": path.to_string_lossy() })).await;
    assert!(!read.is_error, "{}", read.output);
    assert!(!read.output.contains("is a binary file"), "UTF-16 file was refused: {:?}", read.output);
    let _ = std::fs::remove_dir_all(&ws);
}

#[tokio::test]
async fn read_file_caps_a_long_text_file_and_says_so() {
    // 70,000 characters in lines of 99 characters: over the 60,000-character cap.
    let line = format!("{}\n", "a".repeat(98));
    let text = line.repeat(700);
    let (ws, ctx) = setup("cap", &[("long.txt", text.into_bytes())]);
    let path = ws.join("long.txt");

    let read = call(&ctx, "read_file", json!({ "path": path.to_string_lossy() })).await;
    assert!(!read.is_error, "{}", read.output);
    assert!(
        read.output.contains("(truncated; use start_line and end_line to read later lines)"),
        "long text file was not marked as truncated: tail {:?}",
        read.output.chars().rev().take(80).collect::<String>()
    );
    let kept: usize = read.output.chars().filter(|c| *c == 'a').count();
    assert!(kept <= 60_000 && kept > 59_000, "kept {kept} characters, expected about 60,000");
    let _ = std::fs::remove_dir_all(&ws);
}
