//! The host app folder is an extra jail root, not a workspace or a shell default.
use nekko_tools::{ChatMode, ToolCall, ToolContext, Workspace, approver_fn, execute};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

fn fixture(tag: &str) -> (std::path::PathBuf, ToolContext) {
    let root = std::env::temp_dir().join(format!("nekko-app-folder-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("project")).unwrap();
    std::fs::create_dir_all(root.join(".nekko-agent")).unwrap();
    let root = root.canonicalize().unwrap();
    let mut ctx = ToolContext::new(approver_fn(|_, _, _| async { true }));
    ctx.workspaces = vec![Workspace { id: "project".into(), path: root.join("project").to_string_lossy().into() }];
    ctx.app_data_root = Some(root.join(".nekko-agent").to_string_lossy().into());
    (root, ctx)
}

async fn call(ctx: &ToolContext, name: &str, input: Value) -> nekko_tools::ToolResult {
    execute(&ToolCall { id: "test".into(), name: name.into(), input }, ctx).await
}

#[tokio::test]
async fn app_folder_is_accessible_without_changing_the_project_or_opening_home() {
    let (root, ctx) = fixture("access");
    let file = root.join(".nekko-agent/logs/new.txt");
    let write = call(&ctx, "write_file", json!({"path": file, "content": "app log"})).await;
    assert!(!write.is_error, "{}", write.output);
    let read = call(&ctx, "read_file", json!({"path": file})).await;
    assert!(!read.is_error && read.output.contains("app log"), "{}", read.output);
    for name in ["list_dir", "glob", "grep"] {
        let result = call(
            &ctx,
            name,
            json!({"path": root.join(".nekko-agent"), "pattern": if name == "glob" { "**/*.txt" } else { "app log" }}),
        )
        .await;
        assert!(!result.is_error, "{name}: {}", result.output);
    }
    let relative = call(&ctx, "write_file", json!({"path": "relative.txt", "content": "project"})).await;
    assert!(!relative.is_error, "{}", relative.output);
    assert!(root.join("project/relative.txt").exists());
    for path in [root.clone(), root.join(".nekko-agent-other"), root.join(".nekko-agent/../private")] {
        let result = call(&ctx, "list_dir", json!({"path": path})).await;
        assert!(result.is_error && result.output.contains("outside the workspace"), "{}", result.output);
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn app_folder_keeps_write_approvals_and_read_only_precedence() {
    let (root, mut ctx) = fixture("approval");
    let count = Arc::new(AtomicUsize::new(0));
    let calls = count.clone();
    ctx.approver = approver_fn(move |_, _, _| {
        calls.fetch_add(1, Ordering::SeqCst);
        async { false }
    });
    ctx.mode = ChatMode::Ask;
    let file = root.join(".nekko-agent/new.txt");
    let result = call(&ctx, "write_file", json!({"path": file, "content": "no"})).await;
    assert!(result.is_error);
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert!(!file.exists());
    ctx.mode = ChatMode::Yolo;
    ctx.read_only_roots = vec![ctx.app_data_root.clone().unwrap()];
    let result = call(&ctx, "write_file", json!({"path": file, "content": "no"})).await;
    assert!(result.is_error && result.output.contains("Read-only"), "{}", result.output);
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn app_folder_links_cannot_escape_into_unshared_folders() {
    let (root, ctx) = fixture("symlink");
    std::fs::create_dir_all(root.join("private")).unwrap();
    std::fs::write(root.join("private/secret.txt"), "private").unwrap();
    std::os::unix::fs::symlink(root.join("private"), root.join(".nekko-agent/link")).unwrap();
    for (name, input) in [
        ("read_file", json!({"path": root.join(".nekko-agent/link/secret.txt")})),
        ("write_file", json!({"path": root.join(".nekko-agent/link/new.txt"), "content": "no"})),
    ] {
        let result = call(&ctx, name, input).await;
        assert!(result.is_error && result.output.contains("outside the workspace"), "{}", result.output);
    }
    std::fs::remove_dir_all(root).unwrap();
}
