//! The git status against a real repository, and the PR reads and actions
//! against a fake GitHub API (with gh absent, so the REST fallback runs).

use nekko_workspace::git::Git;
use nekko_workspace::pr::Prs;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn temp(tag: &str) -> std::path::PathBuf {
    let mut b = [0u8; 6];
    getrandom::fill(&mut b).unwrap();
    let p = std::env::temp_dir()
        .join(format!("nekko-ws-{tag}-{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>()));
    std::fs::create_dir_all(&p).unwrap();
    p
}

fn git(dir: &std::path::Path, args: &[&str]) -> bool {
    std::process::Command::new("git")
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
        .is_ok_and(|o| o.status.success())
}

#[tokio::test]
async fn reads_a_repository_and_a_plain_folder() {
    let dir = temp("git");
    // No gh here: the branch lookup must not hold the read.
    let g = Git::new(Arc::new(Prs::new("nekko-no-such-gh", "http://127.0.0.1:9")));
    let plain = g.status("w", Some(&dir.to_string_lossy()), false).await;
    assert_eq!(plain["repo"], json!(false));
    if !git(&dir, &["init", "-q"]) {
        eprintln!("git is not installed; skipping the repository half");
        return;
    }
    std::fs::write(dir.join("a.txt"), "a").unwrap();
    assert!(git(&dir, &["add", "."]) && git(&dir, &["commit", "-q", "-m", "one"]));
    std::fs::write(dir.join("b.txt"), "b").unwrap();
    let s = g.status("w2", Some(&dir.to_string_lossy()), false).await;
    assert_eq!(
        (s["repo"].clone(), s["branch"].clone(), s["dirtyCount"].clone()),
        (json!(true), json!("main"), json!(1))
    );
    assert_eq!(s["head"].as_str().map(str::len), Some(7));
    assert!(s.get("worktree").is_none() && s.get("pr").is_none());
    // Cached: a new file does not show until the cache ages out or a caller forces it.
    std::fs::write(dir.join("c.txt"), "c").unwrap();
    assert_eq!(g.status("w2", Some(&dir.to_string_lossy()), false).await["dirtyCount"], json!(1));
    assert_eq!(g.status("w2", Some(&dir.to_string_lossy()), true).await["dirtyCount"], json!(2));
    let _ = std::fs::remove_dir_all(dir);
}

/// A one-connection-at-a-time HTTP server answering from `answer(method, path)`.
async fn fake_api(answer: fn(&str, &str) -> (u16, Value)) -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            let mut buf = vec![0u8; 16 * 1024];
            let n = sock.read(&mut buf).await.unwrap_or(0);
            let head = String::from_utf8_lossy(&buf[..n]).to_string();
            let mut first = head.lines().next().unwrap_or_default().split(' ');
            let (method, path) =
                (first.next().unwrap_or_default().to_string(), first.next().unwrap_or_default().to_string());
            let auth = head.lines().any(|l| l.to_ascii_lowercase().starts_with("authorization: bearer tok"));
            log.lock().unwrap().push(format!("{method} {path}{}", if auth { " (token)" } else { "" }));
            let (status, body) = answer(&method, &path);
            let body = body.to_string();
            let reply = format!(
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = sock.write_all(reply.as_bytes()).await;
        }
    });
    (base, seen)
}

fn github(method: &str, path: &str) -> (u16, Value) {
    match (method, path) {
        ("GET", "/repos/o/r/pulls/5") => (
            200,
            json!({ "title": "Five", "state": "open", "head": { "ref": "f", "sha": "abc" }, "base": { "ref": "main" }, "additions": 3 }),
        ),
        ("GET", "/repos/o/r/commits/abc/status") => (200, json!({ "state": "success", "total_count": 1 })),
        ("GET", "/repos/o/r/pulls/5/files?per_page=100") => {
            (200, json!([{ "filename": "a.ts", "status": "added", "additions": 1, "patch": "@@ +1 @@" }]))
        }
        ("PATCH", "/repos/o/r/pulls/5") => (200, json!({})),
        _ => (404, json!({ "message": "Not Found" })),
    }
}

#[tokio::test]
async fn falls_back_to_the_rest_api_without_gh() {
    let (base, seen) = fake_api(github).await;
    let prs = Prs::new("nekko-no-such-gh", &base);
    let url = "https://github.com/o/r/pull/5";
    let info = prs.cached_info(url, Some("tok"), false).await;
    assert_eq!(
        (info["title"].clone(), info["checks"].clone(), info["source"].clone()),
        (json!("Five"), json!("passing"), json!("api"))
    );
    // Cached for a minute.
    prs.cached_info(url, Some("tok"), false).await;
    assert_eq!(seen.lock().unwrap().len(), 2);
    let diff = prs.diff(url, None).await;
    assert_eq!(diff["files"][0]["status"], json!("added"));
    assert_eq!(diff["truncated"], json!(false));
    let refused = prs.action(url, "close", None).await;
    assert_eq!(refused["ok"], json!(false));
    assert!(refused["message"].as_str().unwrap().starts_with("No gh CLI"));
    let closed = prs.action(url, "close", Some("tok")).await;
    assert_eq!((closed["ok"].clone(), closed["message"].clone()), (json!(true), json!("Closed.")));
    assert_eq!(closed["pr"]["number"], json!(5));
    let log = seen.lock().unwrap().clone();
    assert!(log.contains(&"PATCH /repos/o/r/pulls/5 (token)".to_string()), "{log:?}");
    assert_eq!(prs.cached_info("https://github.com/o/r/pull/404", None, false).await, Value::Null);
    assert_eq!(prs.action("not a url", "merge", None).await, json!({ "ok": false, "message": "Not a valid PR URL." }));
}

fn vaizer_api(method: &str, path: &str) -> (u16, Value) {
    match (method, path) {
        ("GET", "/catalog.json") => (
            200,
            json!({ "marketplace": "vaizer", "skills": [
            { "id": "a", "slug": "good-one", "description": "d", "tier": "community" },
            { "id": "b", "slug": "Bad Slug", "description": "d", "tier": "community" },
            { "id": "c", "slug": "c", "description": "d", "tier": "unknown" },
        ] }),
        ),
        ("GET", "/main/plugins/good-one/skills/good-one/SKILL.md") => (200, json!("legacy body")),
        _ => (404, json!({})),
    }
}

#[tokio::test]
async fn the_vaizer_catalog_is_offline_first_and_caches_a_refresh() {
    use nekko_workspace::skills::Vaizer;
    let (base, seen) = fake_api(vaizer_api).await;
    let data = temp("vaizer");
    let v = Vaizer::new(&format!("{base}/catalog.json"), &format!("{base}/main"));
    let bundled = v.catalog(&data, false).await;
    assert_eq!(bundled["source"], json!("bundled"));
    assert!(seen.lock().unwrap().is_empty(), "no network without a refresh");
    let live = v.catalog(&data, true).await;
    assert_eq!((live["source"].clone(), live["skills"].as_array().unwrap().len()), (json!("live"), 1));
    let cached = v.catalog(&data, false).await;
    assert_eq!((cached["source"].clone(), cached["skills"][0]["slug"].clone()), (json!("cached"), json!("good-one")));
    // The current plugin path 404s, the legacy one answers.
    assert_eq!(v.skill_md("good-one").await, json!("\"legacy body\""));
    assert_eq!(v.skill_md("../etc").await, Value::Null);
    let _ = std::fs::remove_dir_all(data);
}
