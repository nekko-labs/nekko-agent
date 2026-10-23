//! The real `nekkod` binary end to end: git in a saved folder (IO-33 FA-2):
//! stage, a model-written commit message, commit, history and branches, the
//! git status the sidebar reads dropping its cache after a change, and the
//! calls it refuses.

use crate::common::*;
use std::path::Path;
use std::process::Command;

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git").args(args).current_dir(dir).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

#[tokio::test(flavor = "multi_thread")]
async fn stages_writes_a_message_commits_and_reads_history_in_a_saved_folder() {
    let data = std::env::temp_dir().join(format!("nekkod-git-{}", std::process::id()));
    let repo = data.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    for (k, v) in [
        ("user.name", "Test"),
        ("user.email", "t@example.com"),
        ("commit.gpgsign", "false"),
        ("core.autocrlf", "false"),
    ] {
        git(&repo, &["config", k, v]);
    }
    std::fs::write(repo.join("a.txt"), "one\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "First"]);
    let model = scripted_model(vec![say_text("```\nSay two things\n\nThe file now has a second line.\n```")]).await;
    let d = start_with(&data);
    let (_, added) = post(d.port, "workspace:addByPath", json!([repo.to_string_lossy()]), Some(TOKEN)).await;
    let id = added[0]["id"].as_str().unwrap().to_string();
    // Both refuse before any git or network work: no such folder, no PR URL.
    assert_served(d.port, "pr:create", json!(["no-such-workspace"])).await;
    assert_served(d.port, "pr:checks", json!(["not a PR URL"])).await;

    std::fs::write(repo.join("a.txt"), "one\ntwo\n").unwrap();
    let (_, status) = post(d.port, "workspace:gitStatus", json!([id]), Some(TOKEN)).await;
    assert_eq!((status["branch"].clone(), status["dirtyCount"].clone()), (json!("main"), json!(1)));
    let (_, diff) = post(d.port, "git:diff", json!([id, {}]), Some(TOKEN)).await;
    assert_eq!(diff["files"][0]["path"], json!("a.txt"));
    assert_eq!(diff["files"][0]["patch"], json!("@@ -1 +1,2 @@\n one\n+two"));

    // Refused before git runs: a path out of the folder, an option as a revision.
    let (code, refused) = post(d.port, "git:stage", json!([id, ["../outside"]]), Some(TOKEN)).await;
    assert_ne!(code, 200);
    assert!(refused.to_string().contains("leaves the workspace"), "{refused}");
    let (code, _) = post(d.port, "git:show", json!([id, "--output=/tmp/x"]), Some(TOKEN)).await;
    assert_ne!(code, 200);
    let (code, _) = post(d.port, "git:log", json!(["no-such-workspace", {}]), Some(TOKEN)).await;
    assert_ne!(code, 200);

    // No default model yet: the message call says what is missing.
    let (_, staged) = post(d.port, "git:stage", json!([id, ["a.txt"]]), Some(TOKEN)).await;
    assert_eq!(staged["ok"], json!(true), "{staged}");
    let (code, missing) = post(d.port, "git:commitMessage", json!([id]), Some(TOKEN)).await;
    assert_ne!(code, 200);
    assert!(missing.to_string().contains("default provider"), "{missing}");
    let provider = json!({ "id": "p1", "kind": "openai-compat", "label": "Scripted", "enabled": true, "baseUrl": format!("http://127.0.0.1:{}/v1", model.port) });
    post(
        d.port,
        "settings:update",
        json!([{ "providers": [provider], "defaultProviderId": "p1", "defaultModelId": "synthetic" }]),
        Some(TOKEN),
    )
    .await;
    let (code, written) = post(d.port, "git:commitMessage", json!([id]), Some(TOKEN)).await;
    assert_eq!(code, 200, "{written}");
    assert_eq!(
        written,
        json!({ "message": "Say two things\n\nThe file now has a second line.", "inputTruncated": false })
    );
    let sent = model.requests.lock().unwrap().clone();
    let asked = sent[0]["messages"].as_array().unwrap().iter().find(|m| m["role"] == "user").unwrap().clone();
    assert!(asked["content"].as_str().unwrap().contains("+two"), "the staged diff is sent");

    let (_, committed) = post(d.port, "git:commit", json!([id, { "message": written["message"] }]), Some(TOKEN)).await;
    assert_eq!(committed["ok"], json!(true), "{committed}");
    assert_eq!(committed["commit"]["subject"], json!("Say two things"));
    // The status card is read afresh, not from its five-second cache.
    let (_, after) = post(d.port, "workspace:gitStatus", json!([id]), Some(TOKEN)).await;
    assert_eq!(after["dirtyCount"], json!(0));
    let (code, _) = post(d.port, "git:commit", json!([id, { "message": "x", "amend": true }]), Some(TOKEN)).await;
    assert_ne!(code, 200);

    let (_, log) = post(d.port, "git:log", json!([id, { "limit": 5 }]), Some(TOKEN)).await;
    let subjects: Vec<_> = log.as_array().unwrap().iter().map(|c| c["subject"].clone()).collect();
    assert_eq!(subjects, [json!("Say two things"), json!("First")]);
    let (_, shown) = post(d.port, "git:show", json!([id, log[0]["sha"]]), Some(TOKEN)).await;
    assert_eq!(shown["commit"]["body"], json!("The file now has a second line."));
    let (_, switched) = post(d.port, "git:switch", json!([id, "feature", { "create": true }]), Some(TOKEN)).await;
    assert_eq!(switched["ok"], json!(true), "{switched}");
    let (_, branches) = post(d.port, "git:branches", json!([id]), Some(TOKEN)).await;
    assert_eq!(branches["current"], json!("feature"));
    let (_, cmp) = post(d.port, "git:compare", json!([id, "main", "feature"]), Some(TOKEN)).await;
    assert_eq!((cmp["ahead"].clone(), cmp["behind"].clone()), (json!(0), json!(0)));
    let (_, none) = post(d.port, "git:mergeAbort", json!([id]), Some(TOKEN)).await;
    assert_eq!(none["ok"], json!(false));
    // Nowhere to push: refused by the engine, not by a prompt that waits.
    let (_, push) = post(d.port, "git:push", json!([id, { "setUpstream": true }]), Some(TOKEN)).await;
    assert_eq!(push["ok"], json!(false), "{push}");
    drop(d);
    std::fs::remove_dir_all(data).ok();
}
