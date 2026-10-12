//! The TS tests (container-sandbox.test.ts), one for one, on a scripted
//! Docker, plus the real-Docker lifecycle when `NEKKO_SANDBOX_TEST_IMAGE`
//! names a locally installed, digest-pinned image with python3.

use super::*;
use std::sync::Arc;

const IMAGE: &str = "example/sandbox@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const IMAGE_ID: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

#[derive(Default)]
struct State {
    calls: Vec<Vec<String>>,
    files: Vec<(String, Value)>,
    token: String,
    container: String,
    volume: String,
    bad_identity: bool,
    stopped: bool,
    fail: Option<(String, String)>,
    partial_volume_from: Option<PathBuf>,
    os: Option<String>,
    offline: bool,
    no_image: bool,
}

#[derive(Default)]
struct Fake(Mutex<State>);

fn file(p: &str, text: &str) -> Value {
    json!({ "path": p, "base64": B64.encode(text), "hash": sha256(text.as_bytes()) })
}

impl Runner for Fake {
    fn run<'a>(
        &'a self,
        _exe: &'a str,
        args: &'a [String],
        _t: Duration,
        _m: u64,
    ) -> BoxFuture<'a, Result<RunResult, String>> {
        Box::pin(async move {
            let mut s = self.0.lock().unwrap();
            s.calls.push(args.to_vec());
            let a0 = args.first().map(String::as_str).unwrap_or_default();
            let a1 = args.get(1).map(String::as_str).unwrap_or_default();
            if let Some((cmd, msg)) = &s.fail
                && cmd == a0
            {
                return Err(msg.clone());
            }
            let mut out: Value = json!("");
            match (a0, a1) {
                ("info", _) => {
                    if s.offline {
                        return Err("engine unavailable".into());
                    }
                    out = json!({ "OSType": s.os.clone().unwrap_or("linux".into()), "ServerVersion": "29.0.0" });
                }
                ("image", _) => {
                    if s.no_image {
                        return Err("image unavailable".into());
                    }
                    out = json!([{ "Os": "linux", "Id": IMAGE_ID }]);
                }
                ("create", _) => {
                    let name = args[args.iter().position(|a| a == "--name").unwrap() + 1].clone();
                    s.token = name[6..].to_string();
                    s.volume = format!("nekko-{}-workspace", s.token);
                    s.container = name;
                }
                ("container", "ls") => out = json!(serde_json::to_string(&s.container).unwrap()),
                ("volume", "ls") => {
                    if let Some(dir) = &s.partial_volume_from {
                        let m: Value =
                            serde_json::from_str(&std::fs::read_to_string(dir.join("session.sandbox.json")).unwrap())
                                .unwrap();
                        s.token = m["token"].as_str().unwrap().into();
                        out = m["volume"].clone();
                    } else {
                        out = json!(s.volume.clone());
                    }
                }
                ("inspect", _) => {
                    let label = if s.bad_identity { "other".to_string() } else { s.token.clone() };
                    out = json!([{
                        "Image": IMAGE_ID, "State": { "Running": !s.stopped },
                        "Config": { "User": "1000:1000", "Labels": { "dev.nekko.sandbox": label } },
                        "HostConfig": { "NetworkMode": "none", "ReadonlyRootfs": true, "CapDrop": ["ALL"], "SecurityOpt": ["no-new-privileges"],
                            "Memory": 536870912, "MemorySwap": 536870912, "Tmpfs": { "/tmp": "rw,noexec,nosuid,nodev,size=64m" }, "PidsLimit": 128, "NanoCpus": 1000000000 },
                        "Mounts": [{ "Type": "volume", "Name": s.volume, "Destination": "/workspace", "RW": true }],
                    }]);
                }
                ("volume", "inspect") => out = json!([{ "Labels": { "dev.nekko.sandbox": s.token } }]),
                ("exec", _) if args.iter().any(|a| a == "-c") && args.last().is_some_and(|l| l.starts_with('{')) => {
                    let q: Value = serde_json::from_str(args.last().unwrap()).unwrap();
                    let p = q["path"].as_str().unwrap_or_default().to_string();
                    match q["op"].as_str().unwrap() {
                        "write" => {
                            let b = B64.decode(q["base64"].as_str().unwrap()).unwrap();
                            s.files.retain(|(k, _)| k != &p);
                            s.files.push((p.clone(), json!({ "path": p, "base64": q["base64"], "hash": sha256(&b) })));
                            out = json!({ "written": p });
                        }
                        "snapshot" => out = Value::Array(s.files.iter().map(|(_, v)| v.clone()).collect()),
                        "read" => {
                            out = json!({ "base64": s.files.iter().find(|(k, _)| k == &p).map(|(_, v)| v["base64"].clone()) })
                        }
                        "list" => out = json!(s.files.iter().map(|(k, _)| k.clone()).collect::<Vec<_>>()),
                        _ => {}
                    }
                }
                _ => {}
            }
            let stdout = match out {
                Value::String(t) => t,
                v => v.to_string(),
            };
            Ok(RunResult { stdout, stderr: String::new() })
        })
    }
}

struct Fixture {
    dir: PathBuf,
    source: PathBuf,
    fake: Arc<Fake>,
    sandbox: ContainerSandbox,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn config(dir: &Path, source: &Path) -> Config {
    Config {
        session_id: "session".into(),
        state_directory: dir.join("state"),
        source_folders: vec![source.to_string_lossy().into_owned()],
        image: IMAGE.into(),
        docker_path: Some("docker".into()),
        limits: Limits::default(),
    }
}

fn fixture(name: &str) -> Fixture {
    let base = std::env::temp_dir().join(format!("nekko-sandbox-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(base.join("source")).unwrap();
    // The temp dir may sit behind a link (macOS /var): work under its real path.
    let dir = PathBuf::from(realpath(&base).unwrap());
    let source = dir.join("source");
    std::fs::write(source.join("a.txt"), "original").unwrap();
    let fake = Arc::new(Fake::default());
    let sandbox = ContainerSandbox::new(config(&dir, &source), fake.clone()).unwrap();
    Fixture { dir, source, fake, sandbox }
}

impl Fixture {
    fn calls(&self) -> Vec<Vec<String>> {
        self.fake.0.lock().unwrap().calls.clone()
    }
    fn called(&self, a: &str, b: Option<&str>) -> bool {
        self.calls().iter().any(|c| c[0] == a && b.is_none_or(|b| c.get(1).map(String::as_str) == Some(b)))
    }
    fn reopen(&self) -> ContainerSandbox {
        ContainerSandbox::new(config(&self.dir, &self.source), self.fake.clone()).unwrap()
    }
    fn with(&self, f: impl FnOnce(&mut State)) {
        f(&mut self.fake.0.lock().unwrap());
    }
}

#[test]
fn requires_explicit_digest_pinning() {
    let f = fixture("pin");
    let mut c = config(&f.dir, &f.source);
    c.image = "python:latest".into();
    assert!(ContainerSandbox::new(c, f.fake.clone()).err().unwrap().contains("digest"));
}

#[tokio::test]
async fn copies_only_selected_plain_files_and_reuses_identity_without_pulling() {
    let f = fixture("copy");
    std::fs::create_dir_all(f.source.join(".git")).unwrap();
    std::fs::write(f.source.join(".git/secret"), "secret").unwrap();
    std::fs::create_dir_all(f.source.join("node_modules")).unwrap();
    std::fs::write(f.source.join(".env.local"), "secret").unwrap();
    f.sandbox.initialize().await.unwrap();
    let keys: Vec<String> = f.fake.0.lock().unwrap().files.iter().map(|(k, _)| k.clone()).collect();
    assert_eq!(keys, ["folder-0/a.txt"]);
    let create = f.calls().into_iter().find(|c| c[0] == "create").unwrap();
    for arg in [
        "--pull=never",
        "--read-only",
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "no-new-privileges",
        "--tmpfs",
        "--memory",
        "--cpus",
        "--pids-limit",
    ] {
        assert!(create.iter().any(|a| a == arg), "{arg}");
    }
    assert!(!create.join(" ").contains(&*f.source.to_string_lossy()));
    let count = f.calls().len();
    let resumed = f.reopen();
    resumed.initialize().await.unwrap();
    assert!(!f.calls()[count..].iter().any(|c| c[0] == "create"));
    assert_eq!(resumed.execute("read_file", &json!({ "path": "folder-0/a.txt" })).await.unwrap(), json!("original"));
    assert!(f.calls().iter().all(|c| c[0] != "pull" && c[0] != "service"));
    resumed.destroy().await.unwrap();
    assert!(f.called("rm", None));
}

#[tokio::test]
async fn cleans_up_a_partial_creation_with_only_its_owned_volume() {
    let f = fixture("partial");
    f.with(|s| s.fail = Some(("create".into(), "creation interrupted".into())));
    assert!(f.sandbox.initialize().await.unwrap_err().contains("interrupted"));
    let state = f.dir.join("state");
    f.with(|s| {
        s.fail = None;
        s.container = String::new();
        s.partial_volume_from = Some(state);
    });
    f.reopen().destroy().await.unwrap();
    assert!(f.called("volume", Some("rm")));
    assert!(!f.called("rm", None));
}

#[tokio::test]
async fn cleans_up_stopped_resources_after_restart_without_touching_sources() {
    let f = fixture("stopped");
    f.sandbox.initialize().await.unwrap();
    f.with(|s| s.stopped = true);
    f.reopen().destroy().await.unwrap();
    assert!(f.called("rm", None));
    assert_eq!(std::fs::read_to_string(f.source.join("a.txt")).unwrap(), "original");
}

#[tokio::test]
async fn fails_closed_for_non_linux_unavailable_engine_and_missing_image() {
    for mode in ["windows", "offline", "missing"] {
        let f = fixture(&format!("closed-{mode}"));
        f.with(|s| match mode {
            "windows" => s.os = Some("windows".into()),
            "offline" => s.offline = true,
            _ => s.no_image = true,
        });
        assert!(f.sandbox.initialize().await.is_err(), "{mode}");
        assert!(!f.called("create", None), "{mode}");
    }
}

#[tokio::test]
async fn rejects_hardlinks_and_size_or_count_overflow_before_creating() {
    let f = fixture("links");
    std::fs::hard_link(f.source.join("a.txt"), f.source.join("alias.txt")).unwrap();
    assert!(f.sandbox.initialize().await.unwrap_err().contains("Links"));
    assert!(!f.called("create", None));
    std::fs::remove_file(f.source.join("alias.txt")).unwrap();
    let mut c = config(&f.dir, &f.source);
    c.limits.bytes = 2;
    assert!(ContainerSandbox::new(c, f.fake.clone()).unwrap().initialize().await.unwrap_err().contains("limit"));
    std::fs::write(f.source.join("b.txt"), "b").unwrap();
    let mut c = config(&f.dir, &f.source);
    c.limits.files = 1;
    assert!(ContainerSandbox::new(c, f.fake.clone()).unwrap().initialize().await.unwrap_err().contains("limit"));
}

#[tokio::test]
async fn rejects_unsupported_tools_and_traversal_without_host_execution() {
    let f = fixture("traversal");
    f.sandbox.initialize().await.unwrap();
    let count = f.calls().len();
    assert!(
        f.sandbox
            .execute("start_process", &json!({ "command": "echo host" }))
            .await
            .unwrap_err()
            .contains("Unsupported")
    );
    assert_eq!(f.calls().len(), count);
    for p in ["../outside", "/absolute", "folder-0/../x", "folder-0/.env", "C:\\x", "folder-0/NUL", "folder-0/x."] {
        let e = f.sandbox.execute("write_file", &json!({ "path": p, "content": "bad" })).await.unwrap_err();
        assert!(e.contains("Unsafe"), "{p}: {e}");
    }
    f.sandbox.execute("bash", &json!({ "command": "echo \"a & b\"" })).await.unwrap();
    let last = f.calls().last().unwrap().clone();
    assert_eq!(&last[..5], ["exec", "--user", "1000:1000", "--workdir", "/workspace"]);
    assert_eq!(&last[6..], ["/bin/sh", "-c", "echo \"a & b\""]);
}

#[tokio::test]
async fn rejects_container_identity_mismatch() {
    let f = fixture("identity");
    f.sandbox.initialize().await.unwrap();
    f.with(|s| s.bad_identity = true);
    assert!(f.sandbox.snapshot().await.unwrap_err().contains("isolation"));
    assert!(f.sandbox.destroy().await.unwrap_err().contains("identity"));
    assert!(!f.called("rm", None));
}

#[tokio::test]
async fn validates_hostile_exports_collisions_and_hashes() {
    let f = fixture("hostile");
    f.sandbox.initialize().await.unwrap();
    f.with(|s| s.files.push(("evil".into(), file("../outside", "bad"))));
    assert!(f.sandbox.snapshot().await.unwrap_err().contains("Unsafe"));
    f.with(|s| s.files.retain(|(k, _)| k != "evil"));
    f.with(|s| s.files.push(("collision".into(), file("folder-0/A.TXT", "bad"))));
    assert!(f.sandbox.snapshot().await.unwrap_err().contains("Invalid"));
    f.with(|s| s.files.retain(|(k, _)| k != "collision"));
    f.with(|s| {
        let mut v = file("folder-0/a.txt", "new");
        v["hash"] = json!("fake");
        s.files.retain(|(k, _)| k != "folder-0/a.txt");
        s.files.push(("folder-0/a.txt".into(), v));
    });
    assert!(f.sandbox.snapshot().await.unwrap_err().contains("hash"));
    assert_eq!(std::fs::read_to_string(f.source.join("a.txt")).unwrap(), "original");
}

#[tokio::test]
async fn denies_apply_back_without_touching_external_host_edits() {
    let f = fixture("apply");
    f.sandbox.initialize().await.unwrap();
    f.with(|s| {
        s.files.retain(|(k, _)| k != "folder-0/a.txt");
        s.files.push(("folder-0/a.txt".into(), file("folder-0/a.txt", "sandbox edit")));
        s.files.push(("folder-0/new.txt".into(), file("folder-0/new.txt", "new")));
    });
    let changes = f.sandbox.diff().await.unwrap();
    assert_eq!(changes.iter().map(|c| c.path.as_str()).collect::<Vec<_>>(), ["folder-0/a.txt", "folder-0/new.txt"]);
    std::fs::write(f.source.join("a.txt"), "external edit").unwrap();
    assert!(f.sandbox.apply_back(&changes).unwrap_err().contains("Apply-back is disabled"));
    assert_eq!(std::fs::read_to_string(f.source.join("a.txt")).unwrap(), "external edit");
    assert!(!f.source.join("new.txt").exists());
    f.with(|s| s.files.retain(|(k, _)| k != "folder-0/a.txt"));
    let changes = f.sandbox.diff().await.unwrap();
    assert!(changes.iter().any(|c| c.path == "folder-0/a.txt" && c.after.is_none()));
    assert!(f.sandbox.apply_back(&changes).is_err());
    f.sandbox.apply_back(&[]).unwrap();
}

#[test]
fn checks_paths_like_relative_file() {
    for ok in ["a", "folder-0/a.txt", "x/.envrc", "comx", "com0", "a b"] {
        assert!(relative_file(ok).is_ok(), "{ok}");
    }
    for bad in [
        "",
        "a\\b",
        "c:",
        "/a",
        "a//b",
        "./a",
        "a/..",
        "a/.git/x",
        ".env",
        ".env.prod",
        "a.",
        "a ",
        "CON",
        "lpt1.txt",
        "com9",
        "a\u{1}",
    ] {
        assert!(relative_file(bad).is_err(), "{bad:?}");
    }
    assert!(is_pinned_image(IMAGE));
    assert!(!is_pinned_image("x@sha256:ABCDEF"));
}

/// The lifecycle against a real Docker engine and image (opt-in).
#[tokio::test]
async fn real_preinstalled_docker_image_lifecycle() {
    let Ok(image) = std::env::var("NEKKO_SANDBOX_TEST_IMAGE") else { return };
    let f = fixture("real");
    let mut c = config(&f.dir, &f.source);
    c.session_id = "real-test".into();
    c.image = image;
    c.docker_path = None;
    let sandbox = ContainerSandbox::new(c, Arc::new(ProcessRunner)).unwrap();
    sandbox.initialize().await.unwrap();
    let outcome = async {
        assert_eq!(sandbox.execute("read_file", &json!({ "path": "folder-0/a.txt" })).await?, json!("original"));
        let big = "x".repeat(50_000);
        sandbox.execute("write_file", &json!({ "path": "folder-0/large.txt", "content": big })).await?;
        assert_eq!(sandbox.execute("read_file", &json!({ "path": "folder-0/large.txt" })).await?, json!(big));
        sandbox.execute("write_file", &json!({ "path": "folder-0/b.txt", "content": "hello" })).await?;
        sandbox
            .execute("edit_file", &json!({ "path": "folder-0/b.txt", "old_string": "hello", "new_string": "world" }))
            .await?;
        assert_eq!(sandbox.execute("read_file", &json!({ "path": "folder-0/b.txt" })).await?, json!("world"));
        assert!(sandbox.execute("list_dir", &json!({})).await?.as_array().unwrap().contains(&json!("folder-0/a.txt")));
        assert!(
            sandbox
                .execute("glob", &json!({ "pattern": "*.txt" }))
                .await?
                .as_array()
                .unwrap()
                .contains(&json!("folder-0/b.txt"))
        );
        assert_eq!(
            sandbox.execute("grep", &json!({ "pattern": "world" })).await?,
            json!([{ "path": "folder-0/b.txt", "line": 1, "text": "world" }])
        );
        let shell = sandbox.execute("bash", &json!({ "command": "id -u; printf shell > folder-0/a.txt" })).await?;
        assert_eq!(shell["stdout"].as_str().unwrap().trim(), "1000");
        assert!(sandbox.apply_back(&sandbox.diff().await?).is_err());
        assert_eq!(std::fs::read_to_string(f.source.join("a.txt")).unwrap(), "original");
        assert!(!f.source.join("b.txt").exists());
        sandbox.execute("bash", &json!({ "command": "ln -s /etc/passwd folder-0/alias" })).await?;
        assert!(sandbox.snapshot().await.is_err());
        sandbox.execute("bash", &json!({ "command": "rm folder-0/alias" })).await?;
        Ok::<(), String>(())
    }
    .await;
    sandbox.destroy().await.unwrap();
    outcome.unwrap();
}
