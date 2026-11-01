//! Git configuration can name programs git runs, and guardrails mode auto-runs
//! read-only git commands. So in guardrails a write to git configuration asks,
//! and an auto-run git command gets an environment that overrides the
//! settings that execute (decision 0010).

use nekko_tools::{
    BoxFuture, ChatMode, CommandRunner, RunOutcome, RunRequest, SandboxMode, Severity, ToolCall, ToolContext,
    ToolResult, Workspace, approver_fn, execute,
};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

fn temp(tag: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("nekko-git-guard-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).unwrap();
    std::fs::canonicalize(p).unwrap()
}

type Asked = Arc<Mutex<Vec<(String, Severity)>>>;

fn context(ws: &Path, mode: ChatMode, approve: bool) -> (ToolContext, Asked) {
    let asked: Asked = Arc::default();
    let log = asked.clone();
    let mut ctx = ToolContext::new(approver_fn(move |_c: ToolCall, reason: String, severity: Severity| {
        log.lock().unwrap().push((reason, severity));
        async move { approve }
    }));
    ctx.mode = mode;
    ctx.sandbox_mode = SandboxMode::WorkspaceJail;
    ctx.workspaces = vec![Workspace { id: "w".into(), path: ws.to_string_lossy().into_owned() }];
    ctx.default_cwd = Some(ws.to_string_lossy().into_owned());
    (ctx, asked)
}

async fn call(ctx: &ToolContext, name: &str, input: Value) -> ToolResult {
    execute(&ToolCall { id: "t".into(), name: name.into(), input }, ctx).await
}

#[tokio::test]
async fn writing_git_config_asks_in_guardrails() {
    let ws = temp("write");
    std::fs::create_dir_all(ws.join(".git")).unwrap();
    std::fs::write(ws.join(".git").join("config"), "[core]\n").unwrap();
    let config = ws.join(".git").join("config").to_string_lossy().into_owned();
    let (ctx, asked) = context(&ws, ChatMode::Guardrails, false);

    let wrote = call(&ctx, "write_file", json!({ "path": config, "content": "[core]\n\tfsmonitor = ./x.sh\n" })).await;
    assert!(wrote.is_error && wrote.output == "Write not approved by user.", "{}", wrote.output);
    let edited = call(
        &ctx,
        "edit_file",
        json!({ "path": config, "old_string": "[core]", "new_string": "[core]\n\tpager = sh" }),
    )
    .await;
    assert!(edited.is_error && edited.output == "Edit not approved by user.", "{}", edited.output);
    let pointed = call(&ctx, "write_file", json!({ "path": "sub/.git", "content": "gitdir: ../evil\n" })).await;
    assert!(pointed.is_error, "{}", pointed.output);
    assert_eq!(std::fs::read_to_string(&config).unwrap(), "[core]\n");
    {
        let asked = asked.lock().unwrap();
        assert_eq!(asked.len(), 3, "{asked:?}");
        assert!(asked.iter().all(|(r, s)| r.contains("git configuration") && *s == Severity::High), "{asked:?}");
    }

    // Any other file in the workspace is written without asking, as before.
    let ok = call(&ctx, "write_file", json!({ "path": "src/main.rs", "content": "fn main() {}\n" })).await;
    assert!(!ok.is_error, "{}", ok.output);
    assert_eq!(asked.lock().unwrap().len(), 3);

    // YOLO does not ask.
    let (yolo, asked) = context(&ws, ChatMode::Yolo, false);
    let wrote = call(&yolo, "write_file", json!({ "path": config, "content": "[core]\n" })).await;
    assert!(!wrote.is_error, "{}", wrote.output);
    assert!(asked.lock().unwrap().is_empty());
    let _ = std::fs::remove_dir_all(ws);
}

/// A command and the environment changes it was given.
type Ran = (String, Vec<nekko_tools::gitguard::EnvChange>);

/// Records the environment each command would get.
#[derive(Default)]
struct Recorder(Mutex<Vec<Ran>>);

impl CommandRunner for Recorder {
    fn run<'a>(&'a self, req: RunRequest<'a>) -> BoxFuture<'a, RunOutcome> {
        self.0.lock().unwrap().push((req.command.to_string(), req.env.to_vec()));
        Box::pin(async { RunOutcome { stdout: "ok".into(), ..Default::default() } })
    }
}

#[tokio::test]
async fn auto_run_git_gets_the_hardened_environment() {
    let ws = temp("env");
    let rec = Arc::new(Recorder::default());
    for (mode, command, hardened) in [
        (ChatMode::Guardrails, "git status", true),
        (ChatMode::Guardrails, "ls && git -C x log --oneline", true),
        (ChatMode::Guardrails, "ls -la", false),
        // Approved, not auto-run: the user saw the command.
        (ChatMode::Guardrails, "git commit -m x", false),
        (ChatMode::Yolo, "git status", false),
        (ChatMode::Ask, "git status", false),
    ] {
        let (mut ctx, _) = context(&ws, mode, true);
        ctx.runner = rec.clone();
        let r = call(&ctx, "bash", json!({ "command": command })).await;
        assert!(!r.is_error, "{command}: {}", r.output);
        let (ran, env) = rec.0.lock().unwrap().pop().unwrap();
        let expected = if hardened {
            nekko_tools::gitguard::harden_git_command(command, nekko_tools::Dialect::host())
        } else {
            command.to_string()
        };
        assert_eq!(ran, expected);
        let has = |k: &str, v: &str| env.iter().any(|(n, x)| n == k && x.as_deref() == Some(v));
        let fsmonitor_off =
            env.iter().any(|(n, v)| n.starts_with("GIT_CONFIG_KEY_") && v.as_deref() == Some("core.fsmonitor"))
                && env.iter().any(|(n, v)| n.starts_with("GIT_CONFIG_VALUE_") && v.as_deref() == Some("false"));
        assert_eq!(fsmonitor_off, hardened, "{mode:?} {command}: {env:?}");
        assert_eq!(has("GIT_PAGER", "cat"), hardened, "{mode:?} {command}");
        assert_eq!(env.iter().any(|(n, v)| n == "GIT_EXTERNAL_DIFF" && v.is_none()), hardened);
    }
    let _ = std::fs::remove_dir_all(ws);
}

/// End to end with the real shell and git: a repository whose config names an
/// fsmonitor program; the auto-run `git status` must not run it.
#[cfg(unix)]
#[tokio::test]
async fn a_planted_fsmonitor_does_not_run_on_auto_run_git_status() {
    let has_git = std::process::Command::new("git").arg("--version").output().is_ok_and(|o| o.status.success());
    if !has_git {
        eprintln!("git not installed; skipped");
        return;
    }
    let ws = temp("e2e");
    let git = |args: &[&str]| {
        let ok = std::process::Command::new("git").args(args).current_dir(&ws).output().unwrap().status.success();
        assert!(ok, "git {args:?}");
    };
    git(&["init", "-q"]);
    std::fs::write(ws.join("f"), "a\n").unwrap();
    let marker = ws.join("pwned");
    let script = ws.join("fsm.sh");
    std::fs::write(&script, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    git(&["config", "core.fsmonitor", &script.to_string_lossy()]);

    let (ctx, asked) = context(&ws, ChatMode::Guardrails, false);
    let r = call(&ctx, "bash", json!({ "command": "git status --short" })).await;
    assert!(!r.is_error, "{}", r.output);
    assert!(asked.lock().unwrap().is_empty(), "git status is read-only: no prompt");
    assert!(!marker.exists(), "the planted fsmonitor ran");
    let _ = std::fs::remove_dir_all(ws);
}

/// End to end with the real shell and git: a bare repository in the workspace
/// whose config names an external diff program; an auto-run `git diff` from
/// inside it must not run that program.
#[tokio::test]
async fn a_bare_repository_diff_driver_does_not_run_on_auto_run_git_diff() {
    let has_git = std::process::Command::new("git").arg("--version").output().is_ok_and(|o| o.status.success());
    if !has_git {
        eprintln!("git not installed; skipped");
        return;
    }
    let ws = temp("bare");
    let marker = ws.join("ran");
    let script = ws.join("ext.sh");
    let marker_path = marker.to_string_lossy().replace(std::path::MAIN_SEPARATOR, "/");
    std::fs::write(&script, format!("#!/bin/sh\necho ran > '{marker_path}'\n")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let repo = ws.join("repo");
    for d in ["objects", "refs/heads"] {
        std::fs::create_dir_all(repo.join(d)).unwrap();
    }
    let script_path = script.to_string_lossy().replace(std::path::MAIN_SEPARATOR, "/");
    std::fs::write(repo.join("config"), format!("[core]\n\tbare = true\n[diff]\n\texternal = '{script_path}'\n"))
        .unwrap();
    std::fs::write(repo.join("HEAD"), "ref: refs/heads/main\n").unwrap();
    std::fs::write(ws.join("a.txt"), "a\n").unwrap();
    std::fs::write(ws.join("b.txt"), "b\n").unwrap();

    let (ctx, asked) = context(&ws, ChatMode::Guardrails, false);
    let r = call(&ctx, "bash", json!({ "command": "git -C repo diff --no-index ../a.txt ../b.txt" })).await;
    assert!(asked.lock().unwrap().is_empty(), "git diff is read-only: no prompt");
    assert!(r.output.contains("-a") && r.output.contains("+b"), "{}", r.output);
    assert!(!marker.exists(), "the configured external diff ran");
    let _ = std::fs::remove_dir_all(ws);
}
