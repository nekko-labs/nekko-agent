//! Read-only roots: a workflow skill's own folder can be read from a jailed
//! chat, never written, even with the jail off.

use nekko_tools::{
    ChatMode, SandboxMode, Severity, ToolCall, ToolContext, ToolResult, Workspace, approver_fn, execute,
};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

fn temp(tag: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("nekko-read-only-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).unwrap();
    std::fs::canonicalize(p).unwrap()
}

fn context(workspace: &Path, skill: &Path, sandbox: SandboxMode) -> ToolContext {
    let mut ctx = ToolContext::new(approver_fn(|_c: ToolCall, _r: String, _s: Severity| async { true }));
    ctx.mode = ChatMode::Yolo;
    ctx.sandbox_mode = sandbox;
    ctx.workspaces = vec![Workspace { id: "w".into(), path: workspace.to_string_lossy().into_owned() }];
    ctx.read_only_roots = vec![skill.to_string_lossy().into_owned()];
    ctx
}

async fn call(ctx: &ToolContext, name: &str, input: Value) -> ToolResult {
    execute(&ToolCall { id: "t".into(), name: name.into(), input }, ctx).await
}

#[tokio::test]
async fn a_read_only_root_is_readable_but_never_writable() {
    let (ws, skill) = (temp("ws"), temp("skill"));
    std::fs::write(skill.join("rules.md"), "the rules").unwrap();
    let file = skill.join("rules.md").to_string_lossy().into_owned();
    for mode in [SandboxMode::WorkspaceJail, SandboxMode::Off] {
        let ctx = context(&ws, &skill, mode);
        let read = call(&ctx, "read_file", json!({ "path": file })).await;
        assert!(!read.is_error, "{mode:?}: {}", read.output);
        assert_eq!(read.output, "the rules");
        let listed = call(&ctx, "list_dir", json!({ "path": skill.to_string_lossy() })).await;
        assert!(!listed.is_error && listed.output.contains("rules.md"), "{}", listed.output);
        let found = call(&ctx, "grep", json!({ "path": skill.to_string_lossy(), "pattern": "rules" })).await;
        assert!(!found.is_error, "{}", found.output);
        let wrote = call(&ctx, "write_file", json!({ "path": file, "content": "x" })).await;
        assert!(wrote.is_error && wrote.output.contains("Read-only"), "{mode:?}: {}", wrote.output);
        let new_file = skill.join("new.md").to_string_lossy().into_owned();
        let created = call(&ctx, "write_file", json!({ "path": new_file, "content": "x" })).await;
        assert!(created.is_error, "{}", created.output);
        let edited = call(&ctx, "edit_file", json!({ "path": file, "old_string": "the", "new_string": "no" })).await;
        assert!(edited.is_error && edited.output.contains("Read-only"), "{}", edited.output);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "the rules");
        // The workspace itself is written as before.
        let ok = call(&ctx, "write_file", json!({ "path": ws.join("out.md").to_string_lossy(), "content": "y" })).await;
        assert!(!ok.is_error, "{}", ok.output);
    }
    // Outside both, the jail still refuses a read.
    let other = temp("other");
    std::fs::write(other.join("x"), "x").unwrap();
    let ctx = context(&ws, &skill, SandboxMode::WorkspaceJail);
    let read = call(&ctx, "read_file", json!({ "path": other.join("x").to_string_lossy() })).await;
    assert!(read.is_error && read.output.contains("outside the workspace"), "{}", read.output);
}

#[cfg(unix)]
#[tokio::test]
async fn a_link_into_a_read_only_root_cannot_write_there() {
    let (ws, skill) = (temp("ws-link"), temp("skill-link"));
    std::fs::write(skill.join("rules.md"), "the rules").unwrap();
    std::os::unix::fs::symlink(&skill, ws.join("skill")).unwrap();
    let ctx = context(&ws, &skill, SandboxMode::WorkspaceJail);
    let through = ws.join("skill").join("rules.md").to_string_lossy().into_owned();
    let wrote = call(&ctx, "write_file", json!({ "path": through, "content": "x" })).await;
    assert!(wrote.is_error, "{}", wrote.output);
    assert_eq!(std::fs::read_to_string(skill.join("rules.md")).unwrap(), "the rules");
}
