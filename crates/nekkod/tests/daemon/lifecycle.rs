//! The daemon's own life: what it started never outlives it (SIGTERM ends it
//! gracefully, and a SIGKILL'd daemon's leftovers are ended by the next one on
//! the same data directory), and one data directory takes one daemon.

use crate::common::*;

fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("nekkod-life-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Whether `pid` is still a running process (a zombie counts as gone).
#[cfg(unix)]
fn alive(pid: i32) -> bool {
    // SAFETY: kill with signal 0 only checks the pid.
    if unsafe { libc::kill(pid, 0) } != 0 {
        return false;
    }
    let out = Command::new("ps").args(["-o", "stat=", "-p", &pid.to_string()]).output().unwrap();
    let stat = String::from_utf8_lossy(&out.stdout);
    !stat.trim().is_empty() && !stat.trim_start().starts_with('Z')
}

/// A stdio MCP server in shell: it writes its pid and a background
/// grandchild's to `pids`, then answers every request with an empty result.
#[cfg(unix)]
fn shell_mcp(dir: &std::path::Path) -> (std::path::PathBuf, std::path::PathBuf) {
    let pids = dir.join("pids");
    let script = dir.join("mcp.sh");
    std::fs::write(
        &script,
        format!(
            r#"sleep 300 </dev/null >/dev/null 2>&1 &
echo "$$ $!" > '{pids}'
while read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  [ -n "$id" ] && printf '{{"jsonrpc":"2.0","id":%s,"result":{{"tools":[]}}}}\n' "$id"
done
"#,
            pids = pids.display()
        ),
    )
    .unwrap();
    (script, pids)
}

#[cfg(unix)]
async fn start_mcp(port: u16, script: &std::path::Path, pids: &std::path::Path) -> (i32, i32) {
    let configs = json!([{ "id": "sh", "name": "Shell", "enabled": true, "command": "/bin/sh", "args": [script] }]);
    let (status, snapshot) = post(port, "mcp:sync", json!([configs]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{snapshot}");
    let text = until("the MCP server to write its pids", Duration::from_secs(10), || async {
        std::fs::read_to_string(pids).ok().filter(|t| t.trim().split(' ').count() == 2)
    })
    .await;
    let mut it = text.split_whitespace().map(|p| p.parse::<i32>().unwrap());
    let (server, grandchild) = (it.next().unwrap(), it.next().unwrap());
    assert!(alive(server) && alive(grandchild), "the MCP server and its child run");
    (server, grandchild)
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn sigterm_shuts_down_gracefully_and_ends_children() {
    let data = scratch("sigterm");
    let (script, pids) = shell_mcp(&data);
    let mut d = start_with(&data);
    let (server, grandchild) = start_mcp(d.port, &script, &pids).await;

    // SAFETY: signalling our own child.
    unsafe { libc::kill(d.child.id() as i32, libc::SIGTERM) };
    let child = std::sync::Mutex::new(&mut d.child);
    let status = until("nekkod to exit on SIGTERM", Duration::from_secs(15), || async {
        child.lock().unwrap().try_wait().unwrap()
    })
    .await;
    assert!(status.success(), "a SIGTERM is a graceful shutdown, not a kill: {status}");
    until("the MCP server and its child to be gone", Duration::from_secs(10), || async {
        (!alive(server) && !alive(grandchild)).then_some(())
    })
    .await;
    assert!(!data.join("run").join("children.json").exists(), "a clean shutdown leaves no record");
    std::fs::remove_dir_all(data).ok();
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn the_next_daemon_ends_what_a_killed_one_left_running() {
    let data = scratch("sigkill");
    let (script, pids) = shell_mcp(&data);
    let mut d = start_with(&data);
    let (server, grandchild) = start_mcp(d.port, &script, &pids).await;
    let record = data.join("run").join("children.json");
    until("the child record to list the MCP server", Duration::from_secs(10), || async {
        let r: Value = serde_json::from_slice(&std::fs::read(&record).ok()?).ok()?;
        r["children"].as_array()?.iter().any(|c| c["pid"] == server).then_some(())
    })
    .await;

    // No cleanup runs on SIGKILL: the grandchild (at least) is orphaned.
    d.child.kill().unwrap();
    d.child.wait().unwrap();
    assert!(alive(grandchild), "a SIGKILL leaves the grandchild running");

    let next = start_with(&data);
    until("the leftovers to be ended", Duration::from_secs(10), || async {
        (!alive(server) && !alive(grandchild)).then_some(())
    })
    .await;
    drop(next);
    std::fs::remove_dir_all(data).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_second_daemon_on_the_same_data_directory_exits_with_code_3() {
    let data = scratch("lock");
    let first = start_with(&data);
    let config = json!({ "token": TOKEN, "allowedOrigins": ["null"], "dataDir": data });
    let mut second = Command::new(env!("CARGO_BIN_EXE_nekkod"))
        .arg("--config-stdin")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    std::io::Write::write_all(second.stdin.as_mut().unwrap(), format!("{config}\n").as_bytes()).unwrap();
    let out = tokio::task::spawn_blocking(move || second.wait_with_output().unwrap()).await.unwrap();
    assert_eq!(out.status.code(), Some(3), "{out:?}");
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("another nekkod"), "{err}");
    assert!(!String::from_utf8_lossy(&out.stdout).contains("NEKKOD_READY"));

    // Once the first is gone, the directory is free again.
    drop(first);
    let again = start_with(&data);
    let (status, _) = post(again.port, "daemon:info", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 200);
    std::fs::remove_dir_all(data).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn the_socket_answers_its_heartbeat_itself() {
    let d = start();
    let mut sock = ws(d.port, &format!("/api/ws?token={TOKEN}"), Some("null")).await.unwrap();
    sock.send(Message::Text(json!({ "id": 9, "channel": "daemon:ping", "args": [] }).to_string().into()))
        .await
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        let Some(v) = next_json(&mut sock, Duration::from_secs(10)).await else { break };
        if v["id"] == 9 {
            assert_eq!(v["result"], json!(true), "{v}");
            return;
        }
    }
    panic!("no reply to daemon:ping");
}
