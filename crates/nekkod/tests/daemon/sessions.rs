//! The real `nekkod` binary end to end: chats on disk: reads, writes, forks, purges, clears and wipes, files, memory and comments, and PR stacks.

use crate::common::*;

#[tokio::test(flavor = "multi_thread")]
async fn serves_session_reads_from_disk_when_it_knows_the_data_dir() {
    let data = std::env::temp_dir().join(format!("nekkod-sessions-{}", std::process::id()));
    let sessions = data.join("sessions");
    std::fs::create_dir_all(&sessions).unwrap();
    let chat = json!({ "id": "s_one", "title": "One", "updatedAt": 5, "messages": [
        { "id": "u", "role": "user", "content": "hello", "createdAt": 1 },
        { "id": "a", "role": "assistant", "content": "", "images": ["data:x"], "generated": { "width": 8, "height": 8, "seed": 3 }, "createdAt": 2 },
    ] });
    std::fs::write(sessions.join("s_one.json"), serde_json::to_vec_pretty(&chat).unwrap()).unwrap();
    let d = start_with(Some(&data));

    let (status, list) = post(d.port, "sessions:summaries", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    assert_eq!(list[0]["id"], "s_one");
    assert_eq!(list[0]["imageCount"], 1);
    assert!(list[0].get("messages").is_none(), "a summary carries no transcript");
    let (_, got) = post(d.port, "session:get", json!(["s_one"]), Some(TOKEN)).await;
    assert_eq!(got, chat);
    let (_, missing) = post(d.port, "session:get", json!(["../escape"]), Some(TOKEN)).await;
    assert_eq!(missing, Value::Null);
    let (_, images) = post(d.port, "session:images", json!(["s_one", 4]), Some(TOKEN)).await;
    assert_eq!(images, json!([{ "messageId": "a", "src": "data:x" }]));
    // The UI's own writes are the daemon's too, chat creation included: a
    // folder that is not one of the user's is refused, as the host refused it.
    let (status, refused) = post(d.port, "session:create", json!(["w1"]), Some(TOKEN)).await;
    assert_eq!(status, 400, "{refused}");
    assert!(refused.to_string().contains("Workspace not found"), "{refused}");
    post(
        d.port,
        "settings:update",
        json!([{ "workspaces": [{ "id": "w1", "name": "w1", "path": data.to_string_lossy() }] }]),
        Some(TOKEN),
    )
    .await;
    let (_, created) = post(d.port, "session:create", json!(["w1"]), Some(TOKEN)).await;
    let new_id = created["id"].as_str().unwrap().to_string();
    assert_eq!(created["workspaceId"], "w1");
    let (_, patched) =
        post(d.port, "session:setOptions", json!([new_id, { "title": "Named", "messages": [] }]), Some(TOKEN)).await;
    assert_eq!((patched["title"].clone(), patched["titleAuto"].clone()), (json!("Named"), json!(false)));
    let (_, queued) = post(d.port, "chat:queue", json!([new_id, "  later  "]), Some(TOKEN)).await;
    assert_eq!(queued["queue"], json!(["later"]));
    // A phone's queue editor: an edit lands only on the text it showed.
    let (_, edited) =
        post(d.port, "chat:editQueued", json!([new_id, 0, { "expect": "later", "text": " sooner " }]), Some(TOKEN))
            .await;
    assert_eq!(edited["queue"], json!(["sooner"]));
    let (status, stale) =
        post(d.port, "chat:editQueued", json!([new_id, 0, { "expect": "later", "text": "x" }]), Some(TOKEN)).await;
    assert_eq!(status, 400, "{stale}");
    assert!(stale.to_string().contains("already started or changed"), "{stale}");
    let (_, removed) = post(d.port, "chat:editQueued", json!([new_id, 0, { "expect": "sooner" }]), Some(TOKEN)).await;
    assert_eq!(removed["queue"], json!([]));
    let (_, list) = post(d.port, "sessions:summaries", json!([]), Some(TOKEN)).await;
    assert_eq!(list.as_array().unwrap().len(), 2);
    post(d.port, "session:delete", json!([new_id]), Some(TOKEN)).await;
    let (_, gone) = post(d.port, "session:get", json!([new_id]), Some(TOKEN)).await;
    assert_eq!(gone, Value::Null);
    let (_, fresh) = post(d.port, "session:create", json!([]), Some(TOKEN)).await;
    let (_, cleared) = post(d.port, "sessions:clear", json!(["today"]), Some(TOKEN)).await;
    assert_eq!(cleared, json!(1));
    assert!(!sessions.join(format!("{}.json", fresh["id"].as_str().unwrap())).exists());
    let (_, cleared) = post(d.port, "sessions:clear", json!(["all"]), Some(TOKEN)).await;
    assert_eq!(cleared, json!(1));
    assert!(!sessions.join("s_one.json").exists());
    drop(d);
    std::fs::remove_dir_all(data).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn forks_chats_and_purges_expired_archives_itself() {
    let data = std::env::temp_dir().join(format!("nekkod-fork-purge-{}", std::process::id()));
    let sessions = data.join("sessions");
    std::fs::create_dir_all(&sessions).unwrap();
    let chat = json!({ "id": "s_src", "title": "Source", "workspaceId": "w1", "providerId": "p1", "updatedAt": 5, "messages": [
        { "id": "u1", "role": "user", "content": "one", "createdAt": 1 },
        { "id": "u2", "role": "user", "content": "two", "createdAt": 2 },
    ] });
    let src_bytes = serde_json::to_vec_pretty(&chat).unwrap();
    std::fs::write(sessions.join("s_src.json"), &src_bytes).unwrap();
    // Archived long ago (gone), archived just now (kept), never archived (kept).
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
    for (id, archived) in [("s_old", json!(1)), ("s_recent", json!(now)), ("s_live", Value::Null)] {
        let s = json!({ "id": id, "title": id, "updatedAt": 1, "messages": [], "archivedAt": archived });
        std::fs::write(sessions.join(format!("{id}.json")), serde_json::to_vec(&s).unwrap()).unwrap();
    }
    let d = start_with(Some(&data));

    let (_, info) = post(d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    for channel in ["session:fork", "sessions:purgeArchived"] {
        assert!(info["owned"].as_array().unwrap().contains(&json!(channel)), "{channel} is not owned");
    }
    let (status, fork) = post(d.port, "session:fork", json!(["s_src", "u2"]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{fork}");
    assert_eq!(fork["title"], "Source (split)");
    assert_eq!((fork["workspaceId"].clone(), fork["providerId"].clone()), (json!("w1"), json!("p1")));
    assert_eq!(fork["messages"].as_array().unwrap().len(), 1);
    let fork_id = fork["id"].as_str().unwrap();
    assert_ne!(fork_id, "s_src");
    let (_, saved) = post(d.port, "session:get", json!([fork_id]), Some(TOKEN)).await;
    assert_eq!(saved, fork);
    assert_eq!(std::fs::read(sessions.join("s_src.json")).unwrap(), src_bytes, "the source is untouched");
    let (_, none) = post(d.port, "session:fork", json!(["s_absent"]), Some(TOKEN)).await;
    assert_eq!(none, Value::Null);

    let (status, purged) = post(d.port, "sessions:purgeArchived", json!([]), Some(TOKEN)).await;
    assert_eq!((status, purged), (200, json!(1)));
    assert!(!sessions.join("s_old.json").exists());
    assert!(sessions.join("s_recent.json").exists() && sessions.join("s_live.json").exists());
    drop(d);
    std::fs::remove_dir_all(data).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_command_log_that_cannot_be_removed_retains_json_for_delete_and_clear() {
    let data = std::env::temp_dir().join(format!("nekkod-retention-{}", std::process::id()));
    let sessions = data.join("sessions");
    std::fs::create_dir_all(&sessions).unwrap();
    // A command log that cannot be removed (a folder in its place): the chat must stay.
    std::fs::create_dir_all(sessions.join("callback_fail.commands.log/stuck")).unwrap();
    let path = sessions.join("callback_fail.json");
    let bytes = serde_json::to_vec_pretty(&json!({
        "id": "callback_fail", "title": "Keep me", "updatedAt": 5, "messages": []
    }))
    .unwrap();
    std::fs::write(&path, &bytes).unwrap();
    let d = start_with(Some(&data));
    for (channel, args) in [("session:delete", json!(["callback_fail"])), ("sessions:clear", json!(["all"]))] {
        let (status, body) = post(d.port, channel, args, Some(TOKEN)).await;
        assert_eq!(status, 400, "{channel}: {body}");
        assert_eq!(std::fs::read(&path).unwrap(), bytes, "{channel} must retain unchanged JSON");
        let (status, got) = post(d.port, "session:get", json!(["callback_fail"]), Some(TOKEN)).await;
        assert_eq!(status, 200);
        assert_eq!(got["title"], "Keep me");
    }
    drop(d);
    std::fs::remove_dir_all(data).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn serves_files_memory_and_comments_itself() {
    let data = std::env::temp_dir().join(format!("nekkod-workspace-{}", std::process::id()));
    let project = data.join("project");
    std::fs::create_dir_all(project.join("src")).unwrap();
    std::fs::write(project.join("src").join("a.ts"), "export function a() {}\n").unwrap();
    let d = start_with(Some(&data));

    let (_, info) = post(d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    for c in ["file:read", "dir:list", "workspace:search", "memory:save", "comment:add"] {
        assert!(info["owned"].as_array().unwrap().contains(&json!(c)), "{c} is not owned");
    }
    let file = project.join("src").join("a.ts").to_string_lossy().into_owned();
    let (status, read) = post(d.port, "file:read", json!([file]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    assert_eq!(read, json!({ "content": "export function a() {}\n", "truncated": false, "binary": false }));
    let written = project.join("new").join("b.txt").to_string_lossy().into_owned();
    post(d.port, "file:write", json!([written, "hi"]), Some(TOKEN)).await;
    assert_eq!(std::fs::read_to_string(&written).unwrap(), "hi");
    let (_, listed) = post(d.port, "dir:list", json!([project.to_string_lossy()]), Some(TOKEN)).await;
    assert_eq!(
        listed.as_array().unwrap().iter().map(|e| e["name"].clone()).collect::<Vec<_>>(),
        [json!("new"), json!("src")]
    );

    let (_, saved) = post(
        d.port,
        "memory:save",
        json!([{ "id": "m_1", "scope": "global", "title": "T", "body": "B", "tags": [], "createdAt": 1, "updatedAt": 1 }]),
        Some(TOKEN),
    )
    .await;
    assert_eq!(saved[0]["id"], "m_1");
    assert!(data.join("memory").join("m_1.md").exists());
    let (status, refused) = post(d.port, "memory:delete", json!(["../x"]), Some(TOKEN)).await;
    assert_ne!(status, 200, "{refused}");
    post(d.port, "memory:delete", json!(["m_1"]), Some(TOKEN)).await;
    assert!(!data.join("memory").join("m_1.md").exists());

    let (_, added) = post(d.port, "comment:add", json!(["/p.ts", 3, "x", "look"]), Some(TOKEN)).await;
    let id = added[0]["id"].clone();
    let (_, listed) = post(d.port, "comments:list", json!(["/p.ts"]), Some(TOKEN)).await;
    assert_eq!(listed, added);
    let (_, resolved) = post(d.port, "comment:resolve", json!(["/p.ts", id]), Some(TOKEN)).await;
    assert_eq!(resolved, json!([]));
    // A folder the settings do not list is not searched.
    let (_, hits) = post(d.port, "workspace:search", json!(["w_missing", "a"]), Some(TOKEN)).await;
    assert_eq!(hits, json!([]));
    // The folder list is the daemon's own settings.
    let folder =
        json!([{ "workspaces": [{ "id": "w1", "name": "project", "path": project.to_string_lossy(), "addedAt": 1 }] }]);
    post(d.port, "settings:update", folder, Some(TOKEN)).await;
    let (_, done) = post(d.port, "workspace:index", json!(["w1"]), Some(TOKEN)).await;
    assert_eq!(
        (done["state"].clone(), done["fileCount"].clone(), done["symbolCount"].clone()),
        (json!("ready"), json!(2), json!(1))
    );
    let (_, hits) = post(d.port, "workspace:search", json!(["w1", "FUNCTION A"]), Some(TOKEN)).await;
    assert_eq!(hits[0]["relPath"], json!("src/a.ts"));
    assert_eq!(hits[0]["line"], json!(1));
    let (_, listed) = post(d.port, "workspace:files", json!(["w1"]), Some(TOKEN)).await;
    assert_eq!(listed.as_array().unwrap().len(), 2);
    let (_, snippets) =
        post(d.port, "workspace:snippets", json!([["w1"], "where is function defined"]), Some(TOKEN)).await;
    assert_eq!(snippets[0]["body"], json!("1: export function a() {}"));
    let (_, status) = post(d.port, "workspace:indexStatus", json!(["w1"]), Some(TOKEN)).await;
    assert_eq!(status["state"], json!("ready"));
    // Skills (the nekko-agent target only: nothing is written outside the data dir).
    let (_, installed) =
        post(d.port, "skill:install", json!(["nekko-agent-review-council", "nekko-agent"]), Some(TOKEN)).await;
    assert_eq!(installed["ok"], json!(true));
    assert!(data.join("skills.json").exists());
    let (_, listed) = post(d.port, "skills:installed", json!([]), Some(TOKEN)).await;
    assert_eq!(listed[0]["skillId"], json!("nekko-agent-review-council"));
    // The install runs as a skill and as a workflow step, after the built-ins.
    let (_, defs) = post(d.port, "workflow:skillDefs", json!([]), Some(TOKEN)).await;
    let name = defs[0]["name"].clone();
    assert!(name.is_string(), "{defs}");
    let (_, runnable) = post(d.port, "skills:runnable", json!([]), Some(TOKEN)).await;
    let runnable = runnable.as_array().unwrap();
    assert_eq!(runnable[0]["source"], json!("builtin"));
    let installed = runnable.iter().find(|r| r["name"] == name).expect("the install is runnable");
    assert_eq!(installed["source"], json!("marketplace"));
    let (_, left) =
        post(d.port, "skill:uninstall", json!(["nekko-agent-review-council", "nekko-agent"]), Some(TOKEN)).await;
    assert_eq!(left, json!([]));
    let (_, catalog) = post(d.port, "vaizer:catalog", json!([]), Some(TOKEN)).await;
    assert_eq!(catalog["source"], json!("bundled"));
    drop(d);
    std::fs::remove_dir_all(data).ok();
}

fn git_in(dir: &std::path::Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@example.com",
            "-c",
            "init.defaultBranch=main",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .current_dir(dir)
        .output()
        .expect("git runs");
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// A loopback GitHub REST API with the pull and stack endpoints, recording what it was sent.
async fn fake_github_stacks(pulls: Value) -> (u16, std::sync::Arc<std::sync::Mutex<Vec<Value>>>) {
    use axum::extract::{Path as AxPath, RawQuery};
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let (log_get, log_post) = (seen.clone(), seen.clone());
    let app = axum::Router::new().route(
        "/repos/{owner}/{repo}/{*rest}",
        axum::routing::get(move |AxPath((o, r, rest)): AxPath<(String, String, String)>, RawQuery(q): RawQuery| {
            let (log, pulls) = (log_get.clone(), pulls.clone());
            async move {
                let path = format!("repos/{o}/{r}/{rest}{}", q.map(|q| format!("?{q}")).unwrap_or_default());
                log.lock().unwrap().push(json!(["GET", path]));
                match pulls.get(&path) {
                    Some(v) => (axum::http::StatusCode::OK, axum::Json(v.clone())),
                    None => (axum::http::StatusCode::NOT_FOUND, axum::Json(json!({ "message": "Not Found" }))),
                }
            }
        })
        .post(move |AxPath((o, r, rest)): AxPath<(String, String, String)>, body: axum::Json<Value>| {
            let log = log_post.clone();
            async move {
                log.lock().unwrap().push(json!(["POST", format!("repos/{o}/{r}/{rest}"), body.0]));
                (axum::http::StatusCode::CREATED, axum::Json(json!({ "number": 3 })))
            }
        }),
    );
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    (port, seen)
}

#[tokio::test(flavor = "multi_thread")]
async fn continues_and_links_pr_stacks_itself() {
    let data = std::env::temp_dir().join(format!("nekkod-stacks-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    // The parent PR's repository on GitHub, and the user's clone of it.
    let origin = data.join("origin.git");
    let clone = data.join("clone");
    std::fs::create_dir_all(&clone).unwrap();
    git_in(&data, &["init", "-q", "--bare", origin.to_str().unwrap()]);
    git_in(&clone, &["init", "-q"]);
    std::fs::write(clone.join("a.txt"), "a").unwrap();
    git_in(&clone, &["add", "."]);
    git_in(&clone, &["commit", "-q", "-m", "one"]);
    git_in(&clone, &["checkout", "-q", "-b", "parent"]);
    std::fs::write(clone.join("b.txt"), "b").unwrap();
    git_in(&clone, &["add", "."]);
    git_in(&clone, &["commit", "-q", "-m", "parent work"]);
    let sha = git_in(&clone, &["rev-parse", "HEAD"]);
    git_in(&clone, &["push", "-q", origin.to_str().unwrap(), "parent"]);
    git_in(&clone, &["checkout", "-q", "main"]);
    // A GitHub remote. Its fetch cannot be pointed at the bare repository
    // without changing what `remote get-url` prints (an `insteadOf` rewrite
    // applies to both), so the daemon's git may only use local transports:
    // the fetch fails at once, never touching the network, and the follow-up
    // half runs from a chat set up as continuing would have left it. The
    // successful fetch is covered by the golden replay (tests/stacks.rs).
    git_in(&clone, &["remote", "add", "origin", "https://github.com/owner/repo.git"]);

    let pr = |n: u64, head: &str, base: &str, sha: &str| {
        json!({
            "number": n, "state": "open", "title": format!("PR {n}"),
            "head": { "ref": head, "sha": sha, "repo": { "full_name": "owner/repo" } },
            "base": { "ref": base, "repo": { "full_name": "owner/repo" } },
        })
    };
    let (gh, seen) = fake_github_stacks(json!({
        "repos/owner/repo/pulls/12": pr(12, "parent", "main", &sha),
        "repos/owner/repo/pulls/13": pr(13, "nekko/child", "parent", &"b".repeat(40)),
        "repos/owner/repo/stacks?pull_request=12": [],
    }))
    .await;
    std::fs::create_dir_all(data.join("sessions")).unwrap();
    let source = json!({ "id": "s_src", "title": "Source", "workspaceId": "w1", "executionMode": "worktree", "gitIsolation": true,
        "providerId": "p", "modelId": "m", "mode": "ask", "disabledTools": ["browser"], "messages": [], "createdAt": 1, "updatedAt": 1 });
    std::fs::write(data.join("sessions/s_src.json"), source.to_string()).unwrap();
    let d = start_with_env(
        Some(&data),
        json!({ "githubApiUrl": format!("http://127.0.0.1:{gh}") }),
        &[
            ("NEKKO_GH_PATH", Some("nekko-no-such-gh")),
            ("GIT_ALLOW_PROTOCOL", Some("file")),
            ("GIT_TERMINAL_PROMPT", Some("0")),
        ],
    );
    let ws = json!([{ "id": "w1", "name": "clone", "path": clone, "addedAt": 1 }]);
    post(d.port, "settings:update", json!([{ "workspaces": ws }]), Some(TOKEN)).await;

    // Refusals come before any network or git work.
    let (status, bad) =
        post(d.port, "pr:continueStack", json!(["s_src", "https://gitlab.com/o/r/pull/1"]), Some(TOKEN)).await;
    assert_eq!((status, bad), (400, json!({ "error": "Use a GitHub PR URL." })));

    let url = "https://github.com/owner/repo/pull/12";
    // The PR read, the remote matched in the real clone and the branch name
    // checked; then the fetch, refused (local transports only): no chat made.
    let (status, made) = post(d.port, "pr:continueStack", json!(["s_src", url]), Some(TOKEN)).await;
    assert_eq!(
        (status, made),
        (
            400,
            json!({ "error": "Could not fetch the parent PR. Check Git authentication and repository access, then retry." })
        )
    );
    assert!(seen.lock().unwrap().contains(&json!(["GET", "repos/owner/repo/pulls/12"])));
    assert_eq!(std::fs::read_dir(data.join("sessions")).unwrap().count(), 1, "no follow-up chat");
    let _ = (&origin, &sha);

    // The dependent chat as continuing leaves it, once its worktree exists,
    // links its PR as a new stack.
    git_in(&clone, &["checkout", "-q", "-b", "nekko/child"]);
    let id = "s_dep";
    let dependent = json!({ "id": id, "title": "Follow-up to PR #12", "titleAuto": false, "workspaceId": "w1", "executionMode": "worktree",
        "gitIsolation": true, "gitStackParent": { "workspaceId": "w1", "url": url, "branch": "parent", "sha": sha },
        "gitWorktrees": { "w1": { "path": clone, "branch": "nekko/child" } }, "messages": [], "createdAt": 1, "updatedAt": 1 });
    std::fs::write(data.join(format!("sessions/{id}.json")), dependent.to_string()).unwrap();
    let (status, linked) =
        post(d.port, "pr:linkStack", json!([id, "https://github.com/owner/repo/pull/13"]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    assert_eq!(linked["ok"], json!(true), "{linked}");
    assert_eq!(linked["message"], "Linked as a GitHub PR stack.");
    assert!(
        seen.lock()
            .unwrap()
            .iter()
            .any(|c| c == &json!(["POST", "repos/owner/repo/stacks", { "pull_requests": [12, 13] }])),
        "{:?}",
        seen.lock().unwrap()
    );
    // A failure is an answer, not an error.
    let (status, refused) =
        post(d.port, "pr:linkStack", json!(["s_src", "https://github.com/owner/repo/pull/13"]), Some(TOKEN)).await;
    assert_eq!(
        (status, refused),
        (200, json!({ "ok": false, "message": "This chat was not started from a parent PR." }))
    );

    let (_, info) = post(d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    for c in [
        "pr:continueStack",
        "pr:linkStack",
        "data:wipe",
        "app:info",
        "updates:check",
        "workspace:add",
        "session:watches",
    ] {
        assert!(info["owned"].as_array().unwrap().contains(&json!(c)), "{c} not owned");
    }
    drop(d);
    let _ = std::fs::remove_dir_all(&data);
}

#[tokio::test(flavor = "multi_thread")]
async fn wipes_the_data_it_owns_and_answers_the_small_services() {
    let data = std::env::temp_dir().join(format!("nekkod-wipe-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    for (p, text) in [
        ("sessions/s_a.json", json!({ "id": "s_a", "title": "A", "messages": [], "createdAt": 1, "updatedAt": 1 }).to_string()),
        ("memory/m.md", "note".into()),
        ("usage.jsonl", "{}\n".into()),
        ("replies.jsonl", "{}\n".into()),
        ("tokens.json", "{}".into()),
        (
            "agent-watches.json",
            json!([{ "id": "w1", "sessionId": "s_a", "kind": "timer", "prompt": "secret", "nextPollAt": 4102444800000_u64, "intervalMs": 60000,
                     "deadlineAt": 4102444800000_u64, "status": "active", "failures": 0 }])
            .to_string(),
        ),
    ] {
        std::fs::create_dir_all(data.join(p).parent().unwrap()).unwrap();
        std::fs::write(data.join(p), text).unwrap();
    }
    let d = start_with_config(Some(&data), json!({ "appVersion": "9.8.7", "edition": "desktop" }));
    post(d.port, "settings:update", json!([{ "theme": "light" }]), Some(TOKEN)).await;

    // session:watches: what the transcript shows, never the prompt.
    let (_, views) = post(d.port, "session:watches", json!(["s_a"]), Some(TOKEN)).await;
    assert_eq!(
        views,
        json!([{ "id": "w1", "kind": "timer", "status": "active", "deadlineAt": 4102444800000_u64, "nextPollAt": 4102444800000_u64, "pending": false, "failures": 0 }])
    );

    let (_, info) = post(d.port, "app:info", json!([]), Some(TOKEN)).await;
    assert_eq!(info["version"], "9.8.7");
    assert_eq!(info["edition"], "desktop");
    // No bridge here: headless, `workspace:add` lists the saved folders.
    let (_, listed) = post(d.port, "workspace:add", json!([]), Some(TOKEN)).await;
    assert_eq!(listed, json!([]));
    let (status, _) = post(d.port, "updates:check", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 200);

    let (status, next) = post(d.port, "data:wipe", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{next}");
    assert_eq!(next["theme"], json!("system"), "the defaults come back");
    assert!(!data.join("sessions/s_a.json").exists());
    assert!(!data.join("memory/m.md").exists() && data.join("memory").is_dir());
    assert!(!data.join("usage.jsonl").exists() && !data.join("replies.jsonl").exists());
    assert!(data.join("tokens.json").exists(), "sign-ins are not part of a wipe");
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(data.join("settings.json")).unwrap()).unwrap();
    assert_eq!(saved["theme"], json!("system"));
    drop(d);
    let _ = std::fs::remove_dir_all(&data);
}

#[tokio::test(flavor = "multi_thread")]
async fn writes_other_agent_tools_mcp_entries_itself() {
    let root = std::env::temp_dir().join(format!("nekkod-integrations-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let (data, home) = (root.join("data"), root.join("home"));
    for d in [".claude", ".codex", ".cursor"] {
        std::fs::create_dir_all(home.join(d)).unwrap();
    }
    // Someone else's entry, which a refresh must leave alone.
    let hand = json!({ "mcpServers": { "nekko-agent": { "command": "node", "args": ["dist/index.js", "mcp"] } } });
    std::fs::write(home.join(".cursor/mcp.json"), hand.to_string()).unwrap();
    let h = home.to_string_lossy().to_string();
    let d = start_with_env(Some(&data), json!({}), &[("HOME", Some(&h)), ("USERPROFILE", Some(&h))]);

    let (_, info) = post(d.port, "daemon:info", json!([]), Some(TOKEN)).await;
    for c in ["integrations:detect", "integrations:install", "integrations:snippet", "integrations:refresh"] {
        assert!(info["owned"].as_array().unwrap().iter().any(|o| o == c), "{c} is owned: {info}");
    }
    let (_, tools) = post(d.port, "integrations:detect", json!([]), Some(TOKEN)).await;
    let ids: Vec<_> = tools
        .as_array()
        .unwrap()
        .iter()
        .map(|t| (t["id"].clone(), t["detected"].clone(), t["installed"].clone()))
        .collect();
    assert_eq!(
        ids,
        vec![
            (json!("claude"), json!(true), json!(false)),
            (json!("codex"), json!(true), json!(false)),
            (json!("cursor"), json!(true), json!(true)),
            (json!("windsurf"), json!(false), json!(false)),
        ]
    );

    // No target from the renderer and no desktop app: the portable `npx` form.
    let (status, res) = post(d.port, "integrations:install", json!(["claude"]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{res}");
    assert_eq!(res["ok"], json!(true));
    let written: Value = serde_json::from_str(&std::fs::read_to_string(home.join(".claude.json")).unwrap()).unwrap();
    assert_eq!(written["mcpServers"]["nekko-agent"], json!({ "command": "npx", "args": ["-y", "nekko-agent", "mcp"] }));
    // A target given is used as given.
    let (_, res) = post(
        d.port,
        "integrations:install",
        json!(["codex", { "url": "http://127.0.0.1:9", "token": "t9" }]),
        Some(TOKEN),
    )
    .await;
    assert_eq!(res["ok"], json!(true));
    let toml = std::fs::read_to_string(home.join(".codex/config.toml")).unwrap();
    assert!(toml.contains("NEKKO_TOKEN = \"t9\"") && toml.contains("command = \"npx\""), "{toml}");
    let (_, snip) = post(d.port, "integrations:snippet", json!(["cursor", null]), Some(TOKEN)).await;
    assert!(snip["snippet"].as_str().unwrap().contains("npx"), "{snip}");

    // A rolled token re-points the entries this app wrote, not the hand-written one.
    let target = json!({ "url": "http://127.0.0.1:1440", "token": "tok-new" });
    let (_, done) = post(d.port, "integrations:refresh", json!([target]), Some(TOKEN)).await;
    assert_eq!(done, json!(["claude", "codex"]));
    assert!(std::fs::read_to_string(home.join(".claude.json")).unwrap().contains("tok-new"));
    assert!(std::fs::read_to_string(home.join(".codex/config.toml")).unwrap().contains("tok-new"));
    let cursor: Value = serde_json::from_str(&std::fs::read_to_string(home.join(".cursor/mcp.json")).unwrap()).unwrap();
    assert_eq!(cursor, hand);
    drop(d);
    let _ = std::fs::remove_dir_all(&root);
}
