//! The installed `claude`, signed out, end to end: locate, `auth status`, a
//! session and a turn. Ignored by default because it runs the real binary.
//!
//! Run it only against an empty, throwaway config directory and with no API
//! key in the environment, so it can never touch a real sign-in:
//!
//! ```sh
//! CLAUDE_CONFIG_DIR=$(mktemp -d) ANTHROPIC_API_KEY= cargo test -p nekko-harness --test smoke -- --ignored
//! ```
//!
//! (The variable is set on the test command by the person running it. The
//! harness itself never sets `CLAUDE_CONFIG_DIR`.)

use nekko_harness::{
    LaunchSpec, Mapped, Mapper, PermissionMode, Session, SessionStart, TurnExit, TurnInput, auth_status, locate,
    new_session_id, run_turn,
};
use nekko_loop::{Cancel, Steering};
use serde_json::json;
use std::time::Duration;

fn isolated() -> std::path::PathBuf {
    let dir = std::env::var_os("CLAUDE_CONFIG_DIR").expect("set CLAUDE_CONFIG_DIR to an empty throwaway folder");
    let dir = std::path::PathBuf::from(dir);
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(std::path::PathBuf::from);
    assert!(home.is_none_or(|h| !dir.starts_with(h.join(".claude"))), "refusing to run against a real config dir");
    for key in ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] {
        assert!(std::env::var(key).unwrap_or_default().is_empty(), "unset {key} for the signed-out smoke test");
    }
    dir
}

#[tokio::test]
#[ignore = "runs the installed claude; see the module docs"]
async fn signed_out_end_to_end() {
    let config = isolated();
    let bin = locate(None).await.expect("claude on PATH");
    eprintln!("claude {} at {}", bin.version, bin.path.display());
    let status = auth_status(&bin).await.expect("auth status");
    assert!(!status.logged_in, "{status:?}");
    assert_eq!(status.auth_method, "none");

    let work = config.join("work");
    std::fs::create_dir_all(&work).unwrap();
    let id = new_session_id();
    let mut session = Session::spawn(LaunchSpec {
        bin,
        cwd: work,
        session: SessionStart::New(id.clone()),
        model: None,
        permission_mode: PermissionMode::Default,
        mcp_config: None,
        permission_prompt_tool: None,
        add_dirs: Vec::new(),
    })
    .expect("spawn");
    let (cancel, steering) = (Cancel::default(), Steering::default());
    let mut mapper = Mapper::new("smoke");
    let mut out = Vec::new();
    let input = TurnInput {
        content: Some(json!("Reply with the single word: hi")),
        cancel: &cancel,
        steering: &steering,
        interrupt_grace: Duration::from_secs(5),
        require_mcp: None,
    };
    let exit =
        tokio::time::timeout(Duration::from_secs(90), run_turn(&mut session, &mut mapper, input, &mut |m| out.push(m)))
            .await
            .expect("the turn ends");
    assert_eq!(exit, TurnExit::Failed);
    let init = out.iter().find_map(|m| if let Mapped::Init(i) = m { Some(i.clone()) } else { None }).expect("init");
    assert_eq!(init.session_id, id);
    let errors: Vec<String> = out
        .iter()
        .filter_map(|m| match m {
            Mapped::Event(e) if e["type"] == "error" => e["message"].as_str().map(str::to_string),
            _ => None,
        })
        .collect();
    assert_eq!(errors.len(), 1, "{errors:?}");
    assert!(errors[0].contains("/login"), "{}", errors[0]);
    assert!(session.alive(), "a failed turn leaves the process up for the next message");
    session.kill_tree();
}
