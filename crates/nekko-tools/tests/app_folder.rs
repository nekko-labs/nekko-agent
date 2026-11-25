//! Host Nekko roots are extra jail roots, not workspaces or shell defaults.
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
    std::fs::create_dir_all(root.join(".nekko/other-product")).unwrap();
    std::fs::create_dir_all(root.join("custom-agent-profile")).unwrap();
    let root = root.canonicalize().unwrap();
    let mut ctx = ToolContext::new(approver_fn(|_, _, _| async { true }));
    ctx.workspaces = vec![Workspace { id: "project".into(), path: root.join("project").to_string_lossy().into() }];
    ctx.app_data_root = Some(root.join("custom-agent-profile").to_string_lossy().into());
    ctx.shared_data_root = Some(root.join(".nekko").to_string_lossy().into());
    (root, ctx)
}

async fn call(ctx: &ToolContext, name: &str, input: Value) -> nekko_tools::ToolResult {
    execute(&ToolCall { id: "test".into(), name: name.into(), input }, ctx).await
}

#[tokio::test]
async fn app_folder_is_accessible_without_changing_the_project_or_opening_home() {
    let (root, ctx) = fixture("access");
    let file = root.join(".nekko/other-product/new.txt");
    let write = call(&ctx, "write_file", json!({"path": file, "content": "app log"})).await;
    assert!(!write.is_error, "{}", write.output);
    let read = call(&ctx, "read_file", json!({"path": file})).await;
    assert!(!read.is_error && read.output.contains("app log"), "{}", read.output);
    for name in ["list_dir", "glob", "grep"] {
        let result = call(
            &ctx,
            name,
            json!({"path": root.join(".nekko"), "pattern": if name == "glob" { "**/*.txt" } else { "app log" }}),
        )
        .await;
        assert!(!result.is_error, "{name}: {}", result.output);
    }
    let app_file = root.join("custom-agent-profile/logs/app.txt");
    let write = call(&ctx, "write_file", json!({"path": app_file, "content": "custom profile"})).await;
    assert!(!write.is_error, "{}", write.output);
    let relative = call(&ctx, "write_file", json!({"path": "relative.txt", "content": "project"})).await;
    assert!(!relative.is_error, "{}", relative.output);
    assert!(root.join("project/relative.txt").exists());
    for path in [root.clone(), root.join(".nekko-other"), root.join(".nekko/../private")] {
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
    let file = root.join(".nekko/other-product/new.txt");
    let result = call(&ctx, "write_file", json!({"path": file, "content": "no"})).await;
    assert!(result.is_error);
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert!(!file.exists());
    ctx.mode = ChatMode::Yolo;
    ctx.read_only_roots = vec![ctx.shared_data_root.clone().unwrap()];
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
    std::os::unix::fs::symlink(root.join("private"), root.join(".nekko/link")).unwrap();
    for (name, input) in [
        ("read_file", json!({"path": root.join(".nekko/link/secret.txt")})),
        ("write_file", json!({"path": root.join(".nekko/link/new.txt"), "content": "no"})),
    ] {
        let result = call(&ctx, name, input).await;
        assert!(result.is_error && result.output.contains("outside the workspace"), "{}", result.output);
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn shared_root_is_not_implicit_without_a_host_grant_or_a_scratch_delete_root() {
    let (root, mut ctx) = fixture("no-grant");
    let shared = root.join(".nekko/other-product");
    let file = shared.join("fixture.txt");
    std::fs::write(&file, "shared").unwrap();
    let roots = nekko_tools::delete_roots(ctx.workspaces.iter().map(|w| w.path.as_str()), ctx.app_data_root.as_deref());
    assert!(!roots.iter().any(|path| shared.starts_with(path)));
    ctx.shared_data_root = None;
    let read = call(&ctx, "read_file", json!({"path": file})).await;
    assert!(read.is_error && read.output.contains("outside the workspace"), "{}", read.output);
    std::fs::remove_dir_all(root).unwrap();
}
