//! Native filesystem evidence: no provider, UI, user workspace or app data.
use nekko_tools::{ChangeTracker, ChatMode, Severity, ToolCall, ToolContext, Workspace, approver_fn, execute};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Arc;

struct Rig(PathBuf);
impl Rig {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("nekko-review-{}", nekko_js::uuid()));
        std::fs::create_dir_all(&p).unwrap();
        std::fs::create_dir_all(p.join("sessions")).unwrap();
        std::fs::write(p.join("sessions/saved.json"), r#"{"id":"saved","messages":[]}"#).unwrap();
        std::fs::write(p.join("sessions/incognito.json"), r#"{"id":"incognito","incognito":true,"messages":[]}"#)
            .unwrap();
        Self(std::fs::canonicalize(p).unwrap())
    }
    fn file(&self) -> PathBuf {
        self.0.join("source.txt")
    }
    fn tracker(&self) -> Arc<ChangeTracker> {
        Arc::new(ChangeTracker::persistent(Arc::new(nekko_store::SessionStore::new(&self.0))))
    }
    fn context(&self, tracker: Arc<ChangeTracker>, allowed: bool) -> ToolContext {
        let mut ctx = ToolContext::new(approver_fn(move |_: ToolCall, _: String, _: Severity| async move { allowed }));
        ctx.workspaces = vec![Workspace { id: "w".into(), path: self.0.to_string_lossy().into_owned() }];
        ctx.session_id = Some("saved".into());
        ctx.changes = Some(tracker);
        ctx
    }
}
impl Drop for Rig {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
async fn edit(ctx: &ToolContext, input: Value) -> nekko_tools::ToolResult {
    execute(&ToolCall { id: "edit".into(), name: "edit_file".into(), input }, ctx).await
}

#[test]
fn originals_survive_restart_and_acceptance_does_not_resurrect_them() {
    let r = Rig::new();
    let path = r.file().to_string_lossy().into_owned();
    std::fs::write(&path, "original\r\nα").unwrap();
    let first = r.tracker();
    first.record_original("saved", &path).unwrap();
    std::fs::write(&path, "changed").unwrap();
    first.record_original("saved", &path).unwrap();
    drop(first);
    let next = r.tracker();
    let changes = next.list_changes("saved").unwrap();
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].original, "original\r\nα");
    assert_eq!(changes[0].current, "changed");
    next.accept_change("saved", &path).unwrap();
    assert!(!r.0.join("changes/saved.json").exists());
    assert!(r.tracker().list_changes("saved").unwrap().is_empty());
    next.record_original("saved", &path).unwrap();
    std::fs::write(&path, "again").unwrap();
    assert_eq!(r.tracker().list_changes("saved").unwrap()[0].original, "changed");
    next.accept_all("saved").unwrap();
    assert!(next.list_changes("saved").unwrap().is_empty());
    assert!(r.tracker().list_changes("saved").unwrap().is_empty());
}

#[test]
fn ephemeral_and_invalid_ids_never_write_or_load_sidecars() {
    let r = Rig::new();
    let path = r.file().to_string_lossy().into_owned();
    std::fs::write(&path, "private").unwrap();
    let t = r.tracker();
    t.record_original("incognito", &path).unwrap();
    for id in ["../escape", "", "missing"] {
        assert!(t.record_original(id, &path).is_err());
    }
    assert!(!r.0.join("changes").exists());
    std::fs::write(&path, "new").unwrap();
    assert_eq!(t.list_changes("incognito").unwrap()[0].original, "private");
    assert!(r.tracker().list_changes("incognito").unwrap().is_empty());
    t.clear_memory();
    assert!(t.list_changes("incognito").unwrap().is_empty());
}

#[test]
fn corrupted_snapshot_is_preserved_until_explicit_discard() {
    let r = Rig::new();
    std::fs::create_dir_all(r.0.join("changes")).unwrap();
    let sidecar = r.0.join("changes/saved.json");
    std::fs::write(&sidecar, "corrupt original").unwrap();
    let t = r.tracker();
    assert!(t.list_changes("saved").is_err());
    assert!(t.record_original("saved", &r.file().to_string_lossy()).is_err());
    assert_eq!(std::fs::read_to_string(&sidecar).unwrap(), "corrupt original");
    t.accept_all("saved").unwrap();
    assert!(!sidecar.exists());
}

#[tokio::test]
async fn snapshot_failure_refuses_file_mutation() {
    let r = Rig::new();
    std::fs::write(r.file(), "old").unwrap();
    std::fs::write(r.0.join("changes"), "not a directory").unwrap();
    let ctx = r.context(r.tracker(), true);
    let result = edit(&ctx, json!({"path":r.file(),"old_string":"old","new_string":"new"})).await;
    assert!(result.is_error, "{}", result.output);
    assert!(result.output.contains("snapshot"), "{}", result.output);
    assert_eq!(std::fs::read_to_string(r.file()).unwrap(), "old");
}

#[tokio::test]
async fn invalid_batch_leaves_disk_and_snapshots_untouched_then_valid_batch_commits_once() {
    let r = Rig::new();
    std::fs::write(r.file(), "one\r\ntwo").unwrap();
    let t = r.tracker();
    let ctx = r.context(t.clone(), true);
    let bad = edit(
        &ctx,
        json!({"path":r.file(),"edits":[
            {"old_string":"one","new_string":"three"}, {"old_string":"missing","new_string":"four"}
        ]}),
    )
    .await;
    assert!(bad.is_error && bad.output.contains("Edit 2"), "{}", bad.output);
    assert_eq!(std::fs::read_to_string(r.file()).unwrap(), "one\r\ntwo");
    assert!(!r.0.join("changes/saved.json").exists());
    let good = edit(
        &ctx,
        json!({"path":r.file(),"edits":[
            {"old_string":"one","new_string":"three"}, {"old_string":"three","new_string":"$& $$"}
        ]}),
    )
    .await;
    assert!(!good.is_error, "{}", good.output);
    assert_eq!(std::fs::read_to_string(r.file()).unwrap(), "$& $$\r\ntwo");
    assert_eq!(r.tracker().list_changes("saved").unwrap()[0].original, "one\r\ntwo");
}

#[tokio::test]
async fn batches_obey_approval_read_only_jail_and_git_config_gates() {
    let r = Rig::new();
    let outside = Rig::new();
    std::fs::write(r.file(), "old").unwrap();
    std::fs::write(outside.file(), "old").unwrap();
    let input = |p: PathBuf| json!({"path":p,"edits":[{"old_string":"old","new_string":"new"}]});
    let mut denied = r.context(r.tracker(), false);
    denied.mode = ChatMode::Ask;
    assert!(edit(&denied, input(r.file())).await.is_error);
    let mut ctx = r.context(r.tracker(), true);
    assert!(edit(&ctx, input(outside.file())).await.is_error);
    ctx.read_only_roots = vec![r.0.to_string_lossy().into_owned()];
    assert!(edit(&ctx, input(r.file())).await.is_error);
    std::fs::create_dir_all(r.0.join(".git")).unwrap();
    std::fs::write(r.0.join(".git/config"), "old").unwrap();
    let guard = r.context(r.tracker(), false);
    assert!(edit(&guard, input(r.0.join(".git/config"))).await.is_error);
    assert_eq!(std::fs::read_to_string(r.file()).unwrap(), "old");
    assert_eq!(std::fs::read_to_string(outside.file()).unwrap(), "old");
    assert_eq!(std::fs::read_to_string(r.0.join(".git/config")).unwrap(), "old");
    assert!(!r.0.join("changes/saved.json").exists());
}

#[test]
fn unreadable_session_never_overwrites_a_recovered_original() {
    let r = Rig::new();
    let path = r.file().to_string_lossy().into_owned();
    std::fs::write(&path, "A").unwrap();
    r.tracker().record_original("saved", &path).unwrap();
    std::fs::write(&path, "B").unwrap();
    let session = r.0.join("sessions/saved.json");
    let valid = std::fs::read(&session).unwrap();
    std::fs::write(&session, "corrupt").unwrap();
    let resumed = r.tracker();
    assert!(resumed.list_changes("saved").is_err());
    assert!(resumed.record_original("saved", &path).is_err());
    std::fs::write(session, valid).unwrap();
    resumed.record_original("saved", &path).unwrap();
    assert_eq!(resumed.list_changes("saved").unwrap()[0].original, "A");
}

#[test]
fn deletion_and_privacy_changes_never_resurrect_cached_originals() {
    let r = Rig::new();
    let path = r.file().to_string_lossy().into_owned();
    let store = Arc::new(nekko_store::SessionStore::new(&r.0));
    let tracker = ChangeTracker::persistent(store.clone());
    std::fs::write(&path, "before").unwrap();
    tracker.record_original("saved", &path).unwrap();
    std::fs::write(&path, "private").unwrap();
    store.set_options("saved", &json!({"incognito":true})).unwrap();
    store.set_options("saved", &json!({"incognito":false})).unwrap();
    tracker.record_original("saved", &path).unwrap();
    std::fs::write(&path, "after").unwrap();
    assert_eq!(tracker.list_changes("saved").unwrap()[0].original, "private");
    store.delete("saved").unwrap();
    assert!(tracker.list_changes("saved").unwrap().is_empty());
    assert!(tracker.record_original("saved", &path).is_err());
    assert!(!r.0.join("changes/saved.json").exists());
}

#[tokio::test]
async fn missing_single_replacement_never_writes_undefined() {
    let r = Rig::new();
    std::fs::write(r.file(), "old").unwrap();
    let result = edit(&r.context(r.tracker(), true), json!({"path":r.file(),"old_string":"old"})).await;
    assert!(result.is_error && result.output.contains("new_string is required"));
    assert_eq!(std::fs::read_to_string(r.file()).unwrap(), "old");
    assert!(!r.0.join("changes/saved.json").exists());
}

#[cfg(unix)]
#[test]
fn persisted_originals_are_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let r = Rig::new();
    std::fs::write(r.file(), "secret").unwrap();
    r.tracker().record_original("saved", &r.file().to_string_lossy()).unwrap();
    assert_eq!(std::fs::metadata(r.0.join("changes/saved.json")).unwrap().permissions().mode() & 0o777, 0o600);
}
