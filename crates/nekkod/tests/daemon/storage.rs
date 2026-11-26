//! Settings → Storage end to end: `storage:usage` answers at once and fills in
//! as the walk finishes; `storage:disk` reads the volume.

use crate::common::*;

#[tokio::test(flavor = "multi_thread")]
async fn measures_each_category_in_the_background() {
    let data = std::env::temp_dir().join(format!("nekkod-storage-{}", std::process::id()));
    std::fs::create_dir_all(data.join("desktop/Cache")).unwrap();
    std::fs::create_dir_all(data.join("sessions")).unwrap();
    std::fs::write(data.join("desktop/Cache/data_1"), vec![0u8; 4096]).unwrap();
    std::fs::write(data.join("sessions/s_a.json"), br#"{"id":"s_a","messages":[]}"#).unwrap();
    let d = start_with(&data);

    let (status, first) = post(d.port, "storage:usage", json!([{ "refresh": true }]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{first}");
    assert!(first["categories"].as_array().is_some_and(|c| c.len() == 6), "{first}");
    assert!(first["disk"]["total"].as_f64().is_some_and(|t| t > 0.0), "{first}");

    let mut usage = first;
    for _ in 0..100 {
        if usage["measuring"] == false && usage["measuredAt"].is_number() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        usage = post(d.port, "storage:usage", json!([]), Some(TOKEN)).await.1;
    }
    let bytes = |id: &str| {
        usage["categories"].as_array().unwrap().iter().find(|c| c["id"] == id).map(|c| c["bytes"].clone()).unwrap()
    };
    assert_eq!(bytes("caches"), json!(4096), "{usage}");
    assert_eq!(bytes("history"), json!(26), "{usage}");
    assert_eq!(bytes("worktrees"), json!(0), "{usage}");

    let (status, disk) = post(d.port, "storage:disk", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    assert!(disk["free"].as_f64().is_some_and(|f| f > 0.0), "{disk}");
    drop(d);
    std::fs::remove_dir_all(data).ok();
}

fn git(dir: &std::path::Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git").args(args).current_dir(dir).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
}

#[tokio::test(flavor = "multi_thread")]
async fn removes_idle_worktrees_and_keeps_their_branches() {
    let base = std::env::temp_dir().join(format!("nekkod-storage-wt-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let (data, repo) = (base.join("data"), base.join("repo"));
    std::fs::create_dir_all(&data).unwrap();
    std::fs::create_dir_all(&repo).unwrap();
    for args in [
        &["init", "-q"][..],
        &["config", "user.email", "t@example.com"],
        &["config", "user.name", "T"],
        &["config", "commit.gpgsign", "false"],
        &["commit", "-q", "--allow-empty", "-m", "init"],
    ] {
        git(&repo, args);
    }
    let (idle, busy) = (repo.join(".worktrees/idle"), repo.join(".worktrees/busy"));
    git(&repo, &["worktree", "add", "-q", "-b", "idle", idle.to_str().unwrap()]);
    git(&repo, &["worktree", "add", "-q", "-b", "busy", busy.to_str().unwrap()]);
    git(&repo, &["update-ref", "refs/remotes/origin/idle", "idle"]);
    git(&repo, &["update-ref", "refs/remotes/origin/busy", "busy"]);
    // Only `idle` has been quiet for 73 hours.
    let then = std::time::SystemTime::now() - std::time::Duration::from_secs(73 * 3600);
    let gitdir = git(&idle, &["rev-parse", "--absolute-git-dir"]);
    for p in ["HEAD", "index", "logs/HEAD"]
        .map(|f| std::path::Path::new(gitdir.trim()).join(f))
        .into_iter()
        .chain([idle.clone()])
    {
        std::fs::File::open(p).unwrap().set_modified(then).unwrap();
    }
    let d = start_with(&data);
    let ws = json!({ "workspaces": [{ "id": "w1", "name": "project", "path": repo.to_string_lossy(), "addedAt": 1 }] });
    assert_eq!(post(d.port, "settings:update", json!([ws]), Some(TOKEN)).await.0, 200);

    let (status, preview) = post(d.port, "storage:idleWorktrees", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{preview}");
    let roots: Vec<&str> = preview["idle"].as_array().unwrap().iter().filter_map(|w| w["root"].as_str()).collect();
    assert_eq!(roots.len(), 1, "{preview}");
    assert!(roots[0].ends_with("idle"), "{preview}");
    assert_eq!(preview["idle"][0]["reason"], "pushed");
    assert_eq!(preview["kept"]["recent"], 1, "{preview}");

    let busy_root = busy.to_string_lossy().into_owned();
    let (status, done) = post(d.port, "storage:removeWorktrees", json!([[roots[0], busy_root]]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{done}");
    assert_eq!(done["removed"].as_array().map(Vec::len), Some(1), "{done}");
    assert_eq!(done["failed"][0]["error"], "It was used in the last 3 days.", "{done}");
    assert!(!idle.exists() && busy.exists());
    assert_eq!(git(&repo, &["branch", "--list", "idle"]).trim(), "idle");
    drop(d);
    std::fs::remove_dir_all(base).ok();
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn lists_and_removes_a_leftover_runner_image() {
    let data = std::env::temp_dir().join(format!("nekkod-storage-runners-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&data);
    for (dir, bytes) in [("runners/images/default", 30usize), ("runners/old-image", 12)] {
        std::fs::create_dir_all(data.join(dir)).unwrap();
        std::fs::write(data.join(dir).join("disk.img"), vec![0u8; bytes]).unwrap();
    }
    let d = start_with(&data);
    let (status, list) = post(d.port, "storage:runnerImages", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{list}");
    let old = list.as_array().unwrap().iter().find(|i| i["name"] == "old-image").cloned().unwrap();
    assert_eq!((old["inUse"].clone(), old["bytes"].clone()), (json!(false), json!(12)));
    let (_, refused) = post(d.port, "storage:removeRunnerImage", json!(["images/default"]), Some(TOKEN)).await;
    assert!(refused.to_string().contains("in use"), "{refused}");
    let (status, done) = post(d.port, "storage:removeRunnerImage", json!(["old-image"]), Some(TOKEN)).await;
    assert_eq!((status, done), (200, json!({ "freed": 12 })));
    assert!(!data.join("runners/old-image").exists() && data.join("runners/images/default/disk.img").exists());
    drop(d);
    std::fs::remove_dir_all(data).ok();
}
