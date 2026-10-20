//! gitops.rs against real repositories in a temp folder: diff, log, show,
//! branches, compare, stage, commit, push to a local bare remote, switch, a
//! conflicted merge backed out, and the paths and options it refuses. Plus
//! `pr:create` / `pr:checks` through a stand-in `gh`.

use nekko_workspace::gitops::{DiffOpts, GitOps, LogOpts, MAX_PATCH_LINES};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::Command;

struct Tmp(PathBuf);

impl Drop for Tmp {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).ok();
    }
}

fn tmp(name: &str) -> Tmp {
    let dir = std::env::temp_dir().join(format!("nekko-gitops-{name}-{}", std::process::id()));
    std::fs::remove_dir_all(&dir).ok();
    std::fs::create_dir_all(&dir).unwrap();
    Tmp(dir)
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").args(args).current_dir(dir).env("GIT_TERMINAL_PROMPT", "0").output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn init(dir: &Path) {
    git(dir, &["init", "-q", "-b", "main"]);
    for (k, v) in [
        ("user.name", "Test"),
        ("user.email", "t@example.com"),
        ("commit.gpgsign", "false"),
        ("core.autocrlf", "false"),
    ] {
        git(dir, &["config", k, v]);
    }
}

fn write(dir: &Path, rel: &str, text: &str) {
    let p = dir.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, text).unwrap();
}

fn s(p: &Path) -> &str {
    p.to_str().unwrap()
}

fn paths(v: &Value) -> Vec<String> {
    v["files"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap().to_string()).collect()
}

fn opts(v: Value) -> DiffOpts {
    DiffOpts::from_json(Some(&v)).unwrap()
}

#[tokio::test]
async fn diff_stage_commit_log_show_and_compare() {
    let t = tmp("flow");
    let d = t.0.as_path();
    init(d);
    let ops = GitOps::default();
    // No commits yet: history is empty, and unstaging still works.
    assert_eq!(ops.log(s(d), &LogOpts::from_json(None).unwrap()).await.unwrap(), json!([]));
    write(d, "a.txt", "one\ntwo\n");
    assert_eq!(ops.stage(s(d), &["a.txt".into()]).await.unwrap()["ok"], json!(true));
    assert_eq!(ops.unstage(s(d), &["a.txt".into()]).await.unwrap()["ok"], json!(true));
    assert_eq!(git(d, &["diff", "--cached", "--name-only"]), "");

    // A new file shows as an untracked addition with its lines.
    let diff = ops.diff(s(d), &DiffOpts::default()).await.unwrap();
    let f = &diff["files"][0];
    assert_eq!(
        (f["path"].clone(), f["status"].clone(), f["untracked"].clone()),
        (json!("a.txt"), json!("added"), json!(true))
    );
    assert_eq!((f["additions"].clone(), f["patch"].clone()), (json!(2), json!("@@ -0,0 +1,2 @@\n+one\n+two")));

    // Committing needs a message and something staged; amend and empty are refused.
    assert!(ops.commit(s(d), Some(&json!({ "message": "  " }))).await.is_err());
    assert!(ops.commit(s(d), Some(&json!({ "message": "x", "amend": true }))).await.is_err());
    assert!(ops.commit(s(d), Some(&json!({ "message": "x", "allowEmpty": true }))).await.is_err());
    let nothing = ops.commit(s(d), Some(&json!({ "message": "x" }))).await.unwrap();
    assert_eq!(nothing["ok"], json!(false));
    assert!(nothing["message"].as_str().unwrap().contains("Nothing is staged"));
    ops.stage(s(d), &[".".into()]).await.unwrap();
    let first = ops.commit(s(d), Some(&json!({ "message": "Add a\n\nThe first file." }))).await.unwrap();
    assert_eq!(first["ok"], json!(true), "{first}");
    assert_eq!((first["branch"].clone(), first["commit"]["subject"].clone()), (json!("main"), json!("Add a")));

    // Unstaged and staged changes are told apart.
    write(d, "a.txt", "one\nTWO\n");
    write(d, "src/b.rs", "fn b() {}\n");
    std::fs::write(d.join("pic.bin"), [0u8, 1, 2, 0, 255]).unwrap();
    let unstaged = ops.diff(s(d), &DiffOpts::default()).await.unwrap();
    assert_eq!(paths(&unstaged), ["a.txt", "pic.bin", "src/b.rs"]);
    let a = &unstaged["files"][0];
    assert_eq!(
        (a["status"].clone(), a["additions"].clone(), a["deletions"].clone()),
        (json!("modified"), json!(1), json!(1))
    );
    assert!(a["patch"].as_str().unwrap().contains("-two\n+TWO"));
    assert_eq!(unstaged["files"][1]["binary"], json!(true));
    ops.stage(s(d), &["src/b.rs".into(), "pic.bin".into()]).await.unwrap();
    // With a HEAD to go back to, unstaging keeps the file and drops it from the index.
    let back = ops.unstage(s(d), &["pic.bin".into()]).await.unwrap();
    assert_eq!(back["ok"], json!(true), "{back}");
    assert_eq!(paths(&ops.diff(s(d), &opts(json!({ "staged": true }))).await.unwrap()), ["src/b.rs"]);
    assert!(d.join("pic.bin").exists());
    ops.stage(s(d), &["pic.bin".into()]).await.unwrap();
    let staged = ops.diff(s(d), &opts(json!({ "staged": true }))).await.unwrap();
    assert_eq!(paths(&staged), ["pic.bin", "src/b.rs"]);
    let bin = &staged["files"][0];
    assert_eq!((bin["binary"].clone(), bin["patch"].clone()), (json!(true), json!("")));
    // One path only.
    assert_eq!(paths(&ops.diff(s(d), &opts(json!({ "path": "src" }))).await.unwrap()), Vec::<String>::new());
    assert_eq!(paths(&ops.diff(s(d), &opts(json!({ "path": "a.txt" }))).await.unwrap()), ["a.txt"]);
    ops.commit(s(d), Some(&json!({ "message": "Add b and a picture" }))).await.unwrap();
    git(d, &["checkout", "-q", "--", "a.txt"]);

    // A long file's patch is cut, and says so.
    let long: String = (0..MAX_PATCH_LINES + 50).map(|i| format!("line {i}\n")).collect();
    write(d, "long.txt", &long);
    ops.stage(s(d), &["long.txt".into()]).await.unwrap();
    let cut = ops.diff(s(d), &opts(json!({ "staged": true }))).await.unwrap();
    assert_eq!((cut["truncated"].clone(), cut["files"][0]["truncated"].clone()), (json!(true), json!(true)));
    assert_eq!(cut["files"][0]["patch"].as_str().unwrap().lines().count(), MAX_PATCH_LINES);
    assert_eq!(cut["files"][0]["additions"], json!(MAX_PATCH_LINES + 50));
    ops.commit(s(d), Some(&json!({ "message": "Add a long file" }))).await.unwrap();

    // History, paged and by path.
    let log = ops.log(s(d), &LogOpts::from_json(Some(&json!({ "limit": 2 }))).unwrap()).await.unwrap();
    let subjects: Vec<_> = log.as_array().unwrap().iter().map(|c| c["subject"].clone()).collect();
    assert_eq!(subjects, [json!("Add a long file"), json!("Add b and a picture")]);
    let c = &log[0];
    assert_eq!(c["sha"].as_str().unwrap().len(), 40);
    assert_eq!(c["parents"].as_array().unwrap().len(), 1);
    assert_eq!((c["author"].clone(), c["email"].clone()), (json!("Test"), json!("t@example.com")));
    let skipped = ops.log(s(d), &LogOpts::from_json(Some(&json!({ "skip": 2 }))).unwrap()).await.unwrap();
    assert_eq!(skipped[0]["subject"], json!("Add a"));
    let by_path = ops.log(s(d), &LogOpts::from_json(Some(&json!({ "path": "a.txt" }))).unwrap()).await.unwrap();
    assert_eq!(by_path.as_array().unwrap().len(), 1);

    // One commit.
    let shown = ops.show(s(d), first["commit"]["sha"].as_str().unwrap()).await.unwrap();
    assert_eq!(
        (shown["commit"]["subject"].clone(), shown["commit"]["body"].clone()),
        (json!("Add a"), json!("The first file."))
    );
    assert_eq!(paths(&shown), ["a.txt"]);
    assert!(shown["files"][0]["patch"].as_str().unwrap().contains("+one"));
    assert!(ops.show(s(d), "--output=/tmp/x").await.is_err());
    assert!(ops.show(s(d), "nope").await.is_err());

    // Branches and compare.
    git(d, &["branch", "feature"]);
    git(d, &["checkout", "-q", "feature"]);
    write(d, "f.txt", "f\n");
    git(d, &["add", "f.txt"]);
    git(d, &["commit", "-q", "-m", "Feature work"]);
    git(d, &["checkout", "-q", "main"]);
    write(d, "m.txt", "m\n");
    git(d, &["add", "m.txt"]);
    git(d, &["commit", "-q", "-m", "Main work"]);
    let cmp = ops.compare(s(d), "main", "feature").await.unwrap();
    assert_eq!((cmp["ahead"].clone(), cmp["behind"].clone()), (json!(1), json!(1)));
    assert_eq!(cmp["commits"][0]["subject"], json!("Feature work"));
    assert_eq!(paths(&cmp), ["f.txt"]);
    assert!(cmp["files"][0].get("patch").is_none());
    assert!(ops.compare(s(d), "main", "nope").await.unwrap_err().contains("nope"));
    assert!(ops.compare(s(d), "main..x", "feature").await.is_err());
    let br = ops.branches(s(d)).await.unwrap();
    assert_eq!((br["current"].clone(), br["detached"].clone()), (json!("main"), json!(false)));
    let names: Vec<_> = br["local"].as_array().unwrap().iter().map(|b| b["name"].clone()).collect();
    assert_eq!(names, [json!("feature"), json!("main")]);
    // Against a base: everything since `feature` split off.
    let since = ops.diff(s(d), &opts(json!({ "base": "feature" }))).await.unwrap();
    assert_eq!(paths(&since), ["f.txt", "m.txt"]);
}

#[tokio::test]
async fn refuses_paths_outside_the_workspace() {
    let t = tmp("escape");
    let d = t.0.join("repo");
    std::fs::create_dir_all(&d).unwrap();
    init(&d);
    write(&t.0, "outside.txt", "secret\n");
    let ops = GitOps::default();
    for bad in ["../outside.txt", "/etc/passwd", "a/../../outside.txt", ""] {
        assert!(ops.stage(s(&d), &[bad.into()]).await.is_err(), "{bad}");
        assert!(ops.unstage(s(&d), &[bad.into()]).await.is_err(), "{bad}");
    }
    assert!(DiffOpts::from_json(Some(&json!({ "path": "../outside.txt" }))).is_err());
    assert!(DiffOpts::from_json(Some(&json!({ "base": "--output=/tmp/x" }))).is_err());
    assert!(LogOpts::from_json(Some(&json!({ "path": "/etc" }))).is_err());
    assert!(ops.stage(s(&d), &[]).await.is_err());
    // A glob is a literal name, not a pattern.
    write(&d, "a.txt", "a\n");
    let star = ops.stage(s(&d), &["*.txt".into()]).await.unwrap();
    assert_eq!(star["ok"], json!(false), "{star}");
    assert_eq!(git(&d, &["diff", "--cached", "--name-only"]), "");
    // A link to a file outside is shown by its target, never read.
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(t.0.join("outside.txt"), d.join("link")).unwrap();
        let diff = ops.diff(s(&d), &DiffOpts::default()).await.unwrap();
        let link = diff["files"].as_array().unwrap().iter().find(|f| f["path"] == "link").unwrap().clone();
        assert!(!link["patch"].as_str().unwrap().contains("secret"), "{link}");
    }
}

#[tokio::test]
async fn switches_only_when_git_allows_and_backs_out_of_a_merge() {
    let t = tmp("switch");
    let d = t.0.as_path();
    init(d);
    write(d, "x.txt", "base\n");
    git(d, &["add", "."]);
    git(d, &["commit", "-q", "-m", "base"]);
    let ops = GitOps::default();
    let made = ops.switch(s(d), "other", Some(&json!({ "create": true }))).await.unwrap();
    assert_eq!((made["ok"].clone(), made["branch"].clone()), (json!(true), json!("other")));
    write(d, "x.txt", "other\n");
    git(d, &["commit", "-qam", "other"]);
    assert_eq!(ops.switch(s(d), "main", None).await.unwrap()["ok"], json!(true));
    write(d, "x.txt", "main\n");
    git(d, &["commit", "-qam", "main"]);
    // A local change git would overwrite: refused, with git's reason.
    write(d, "x.txt", "dirty\n");
    let refused = ops.switch(s(d), "other", None).await.unwrap();
    assert_eq!(refused["ok"], json!(false));
    assert!(refused["message"].as_str().unwrap().contains("x.txt"), "{refused}");
    assert_eq!(git(d, &["branch", "--show-current"]), "main");
    assert!(ops.switch(s(d), "-x", None).await.is_err());
    assert!(ops.switch(s(d), "bad name", None).await.is_err());
    git(d, &["checkout", "-q", "--", "x.txt"]);

    // No merge, nothing to abort.
    assert_eq!(ops.merge_abort(s(d)).await.unwrap()["ok"], json!(false));
    let merge = Command::new("git").args(["merge", "other"]).current_dir(d).output().unwrap();
    assert!(!merge.status.success(), "the merge conflicts");
    let conflicted = ops.diff(s(d), &DiffOpts::default()).await.unwrap();
    assert_eq!(conflicted["files"][0]["status"], json!("conflicted"));
    let aborted = ops.merge_abort(s(d)).await.unwrap();
    assert_eq!(aborted["ok"], json!(true), "{aborted}");
    assert!(!d.join(".git").join("MERGE_HEAD").exists());
    assert_eq!(std::fs::read_to_string(d.join("x.txt")).unwrap(), "main\n");
}

#[tokio::test]
async fn pushes_to_a_bare_remote_and_never_forces() {
    let t = tmp("push");
    let bare = t.0.join("remote.git");
    let d = t.0.join("work");
    std::fs::create_dir_all(&bare).unwrap();
    std::fs::create_dir_all(&d).unwrap();
    git(&bare, &["init", "-q", "--bare", "-b", "main"]);
    init(&d);
    git(&d, &["remote", "add", "origin", s(&bare)]);
    write(&d, "a.txt", "a\n");
    git(&d, &["add", "."]);
    git(&d, &["commit", "-q", "-m", "a"]);
    let ops = GitOps::default();
    // No upstream yet: asks for setUpstream.
    let first = ops.push(s(&d), None).await.unwrap();
    assert_eq!(first["ok"], json!(false));
    assert!(first["message"].as_str().unwrap().contains("setUpstream"), "{first}");
    let published = ops.push(s(&d), Some(&json!({ "setUpstream": true }))).await.unwrap();
    assert_eq!(published["ok"], json!(true), "{published}");
    assert_eq!(published["upstream"], json!("origin/main"));
    assert_eq!(git(&d, &["rev-parse", "--abbrev-ref", "main@{u}"]), "origin/main");
    write(&d, "a.txt", "b\n");
    git(&d, &["commit", "-qam", "b"]);
    let br = ops.branches(s(&d)).await.unwrap();
    assert_eq!((br["local"][0]["upstream"].clone(), br["local"][0]["ahead"].clone()), (json!("origin/main"), json!(1)));
    assert_eq!(br["remote"][0]["name"], json!("origin/main"));
    assert_eq!(ops.push(s(&d), None).await.unwrap()["ok"], json!(true));
    assert_eq!(git(&bare, &["log", "-1", "--format=%s", "main"]), "b");

    // Someone else moved the remote: a rewritten local branch is refused, not forced.
    git(&d, &["reset", "-q", "--hard", "HEAD~1"]);
    write(&d, "a.txt", "c\n");
    git(&d, &["commit", "-qam", "c"]);
    let rejected = ops.push(s(&d), None).await.unwrap();
    assert_eq!(rejected["ok"], json!(false), "{rejected}");
    assert_eq!(git(&bare, &["log", "-1", "--format=%s", "main"]), "b");

    // Detached: nothing to push.
    git(&d, &["checkout", "-q", "--detach"]);
    assert_eq!(ops.push(s(&d), None).await.unwrap()["ok"], json!(false));
    let br = ops.branches(s(&d)).await.unwrap();
    assert_eq!((br["current"].clone(), br["detached"].clone()), (Value::Null, json!(true)));
}

#[tokio::test]
async fn a_folder_that_is_not_a_repository_fails_reads_plainly() {
    let t = tmp("norepo");
    let ops = GitOps::default();
    let e = ops.log(s(&t.0), &LogOpts::from_json(None).unwrap()).await.unwrap_err();
    assert!(e.to_lowercase().contains("not a git repository"), "{e}");
    assert!(ops.branches(s(&t.0)).await.is_err());
    assert!(ops.diff(s(&t.0), &DiffOpts::default()).await.is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn creates_a_pr_and_reads_its_checks_through_gh() {
    use nekko_workspace::pr::Prs;
    use std::os::unix::fs::PermissionsExt;
    let t = tmp("gh");
    let log = t.0.join("gh.log");
    let gh = t.0.join("gh");
    let script = format!(
        r#"#!/bin/sh
printf '%s\n' "$*" >> '{log}'
case "$1 $2" in
  "pr create") echo "https://github.com/o/r/pull/7"; exit 0 ;;
  "pr checks") echo '[{{"name":"gate","state":"FAILURE","bucket":"fail","link":"https://x/1","workflow":"CI"}},{{"name":"lint","state":"SUCCESS","bucket":"pass"}}]'; exit 1 ;;
  "pr view") echo '{{"url":"https://github.com/o/r/pull/7","title":"T","state":"OPEN","number":7}}'; exit 0 ;;
  *) exit 0 ;;
esac
"#,
        log = log.display()
    );
    std::fs::write(&gh, script).unwrap();
    std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755)).unwrap();
    let prs = Prs::new(s(&gh), "http://127.0.0.1:9");
    let made = prs.create(s(&t.0), "feat/x", Some("o/r"), "T", "Body", Some("main"), true, None).await;
    assert_eq!(
        (made["ok"].clone(), made["url"].clone()),
        (json!(true), json!("https://github.com/o/r/pull/7")),
        "{made}"
    );
    let calls = std::fs::read_to_string(&log).unwrap();
    assert!(calls.contains("pr create --title T --body Body --head feat/x --base main --draft"), "{calls}");
    let checks = prs.checks("https://github.com/o/r/pull/7", None).await.unwrap();
    assert_eq!((checks["checks"].clone(), checks["source"].clone()), (json!("failing"), json!("gh")));
    assert_eq!(
        checks["items"][0],
        json!({ "name": "gate", "state": "fail", "workflow": "CI", "link": "https://x/1", "description": null, "startedAt": null, "completedAt": null })
    );
    assert!(prs.checks("not a url", None).await.is_err());
    // No gh and no token: a plain refusal.
    let none = Prs::new(s(&t.0.join("missing-gh")), "http://127.0.0.1:9");
    let refused = none.create(s(&t.0), "feat/x", Some("o/r"), "T", "", None, false, None).await;
    assert_eq!(refused["ok"], json!(false));
}
