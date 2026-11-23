//! An engine older than the pinned release is noticed, and updating it really
//! downloads the pinned release over the same build. The frozen install golden
//! (`install.rs`) holds the unchanged cases (a current record, a binary the
//! user pointed at, one on PATH); these are the ones it never had.

use futures_util::StreamExt;
use nekko_engine::BoxFuture;
use nekko_engine::builds;
use nekko_engine::download::{Downloads, Fetch, Reply};
use nekko_engine::install::{InstallIo, Installer, VcOptions};
use serde_json::{Value, json};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const PINNED: &str = "b12436";

/// GitHub and the archive tool, scripted: the pinned release has one CPU build.
struct Net {
    requests: Mutex<Vec<String>>,
    version_out: Option<String>,
}

impl Net {
    fn answer(&self, url: &str) -> Result<(u16, Vec<u8>), String> {
        self.requests.lock().unwrap().push(url.to_string());
        let release = json!({
            "tag_name": PINNED,
            "assets": [{
                "name": format!("llama-{PINNED}-bin-win-cpu-x64.zip"),
                "browser_download_url": "https://dl.test/cpu.zip",
                "size": 3,
            }],
        });
        if url.ends_with(&format!("/releases/tags/{PINNED}")) {
            Ok((200, release.to_string().into_bytes()))
        } else if url == "https://dl.test/cpu.zip" {
            Ok((200, b"zip".to_vec()))
        } else {
            Ok((404, Vec::new()))
        }
    }
}

impl InstallIo for Net {
    fn get(
        &self,
        url: String,
        _: Vec<(String, String)>,
        _: Option<Duration>,
    ) -> BoxFuture<Result<(u16, Vec<u8>), String>> {
        let r = self.answer(&url);
        Box::pin(async move { r })
    }

    fn run(&self, cmd: String, args: Vec<String>, _: u64) -> BoxFuture<Option<String>> {
        let out = if args.first().map(String::as_str) == Some("--version") {
            self.version_out.clone()
        } else if cmd == "tar" {
            // "Extracting" the archive leaves a server binary in the folder.
            let dest = &args[args.iter().position(|a| a == "-C").unwrap() + 1];
            std::fs::write(Path::new(dest).join("llama-server.exe"), "the new engine").unwrap();
            Some(String::new())
        } else {
            None
        };
        Box::pin(async move { out })
    }
}

impl Fetch for Net {
    fn get(&self, url: String, _: Vec<(String, String)>) -> BoxFuture<Result<Reply, String>> {
        let r = self.answer(&url);
        Box::pin(async move {
            let (status, body) = r?;
            Ok(Reply { status, content_length: None, body: Some(futures_util::stream::iter(vec![Ok(body)]).boxed()) })
        })
    }
}

struct Machine {
    root: String,
    net: Arc<Net>,
    installer: Arc<Installer>,
    downloads: Downloads,
    stops: Arc<Mutex<u32>>,
}

/// A Windows x64 machine whose engine folder holds `record` (None for no record),
/// with `external` as the binary the user pointed at, if any.
fn machine(
    name: &str,
    runtime: &'static str,
    record: Option<Value>,
    external: Option<&str>,
    version_out: Option<&str>,
) -> Machine {
    machine_with_gpu(name, runtime, record, external, version_out, None)
}

fn machine_with_gpu(
    name: &str,
    runtime: &'static str,
    record: Option<Value>,
    external: Option<&str>,
    version_out: Option<&str>,
    gpu: Option<Value>,
) -> Machine {
    let root = std::env::temp_dir().join(format!("nekko-outdated-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let engine = root.join("engine");
    std::fs::create_dir_all(engine.join("win-x64-cpu")).unwrap();
    std::fs::write(engine.join("win-x64-cpu").join("llama-server.exe"), "the old engine").unwrap();
    std::fs::write(root.join("mine.exe"), "x").unwrap();
    if let Some(mut record) = record {
        record["binPath"] = json!(engine.join("win-x64-cpu").join("llama-server.exe").to_string_lossy());
        std::fs::write(engine.join("engine.json"), record.to_string()).unwrap();
    }
    let root_s = root.to_string_lossy().into_owned();
    let net = Arc::new(Net { requests: Mutex::default(), version_out: version_out.map(str::to_string) });
    let downloads = Downloads::new(net.clone(), Arc::new(|| 1_700_000_000_000.0), |_| {});
    let external = external.map(|e| root.join(e).to_string_lossy().into_owned());
    let stops = Arc::new(Mutex::new(0));
    let s2 = stops.clone();
    let installer = Installer::new(
        runtime,
        engine.to_string_lossy().into_owned(),
        "win32".into(),
        "x64".into(),
        net.clone(),
        downloads.clone(),
        Arc::new(move || {
            let g = gpu.clone();
            Box::pin(async move { g })
        }),
        Arc::new(|| Box::pin(async { Vec::new() })),
        Arc::new(move || external.clone()),
        Arc::new(move || {
            *s2.lock().unwrap() += 1;
            Box::pin(async {})
        }),
        Arc::new(|| 1_700_000_000_000.0),
        VcOptions {
            system_dir: Some(root.join("no-system").to_string_lossy().into_owned()),
            runtime_dir: Some(root.join("no-runtime").to_string_lossy().into_owned()),
        },
    );
    Machine { root: root_s, net, installer, downloads, stops }
}

fn record(version: Option<&str>) -> Value {
    let mut r = json!({ "backend": "cpu", "buildId": "win-x64-cpu", "installedAt": 5 });
    if let Some(v) = version {
        r["version"] = json!(v);
    }
    r
}

impl Machine {
    async fn outdated(&self) -> Option<Value> {
        self.installer.detect().await.get("outdated").cloned()
    }
}

#[test]
fn compares_llama_build_numbers() {
    assert_eq!(builds::release_pin("llama").1, PINNED, "the pin moved: update PINNED here");
    assert_eq!(builds::outdated_llama("llama", "b11224"), Some(PINNED));
    assert_eq!(builds::outdated_llama("llama", "b12435"), Some(PINNED));
    assert_eq!(builds::outdated_llama("llama", "b999"), Some(PINNED), "numbers, not text: b999 < b12436");
    assert_eq!(builds::outdated_llama("llama", PINNED), None);
    assert_eq!(builds::outdated_llama("llama", "b12437"), None);
    assert_eq!(builds::outdated_llama("llama", "b99999"), None);
    for odd in ["", "b", "12", "4567", "bXYZ", "b12x", " b1", "b-1", "master-1-abc", "b99999999999999999999999"] {
        assert_eq!(builds::outdated_llama("llama", odd), None, "{odd:?}");
    }
}

#[test]
fn leaves_the_image_runtime_alone() {
    assert_eq!(builds::outdated_llama("diffusion", "master-1-abcdef0"), None);
    assert_eq!(builds::outdated_llama("diffusion", "b1"), None);
}

#[tokio::test]
async fn calls_an_older_managed_engine_out_of_date() {
    let m = machine("older", "llama", Some(record(Some("b11224"))), None, None);
    let d = m.installer.detect().await;
    assert_eq!(d["source"], "managed");
    assert_eq!(
        d["outdated"],
        json!({
            "buildId": "win-x64-cpu",
            "installed": "b11224",
            "pinned": PINNED,
            "message": "Your engine is b11224; this version of Nekko Agent expects b12436.",
        })
    );
    std::fs::remove_dir_all(&m.root).ok();
}

#[tokio::test]
async fn stays_quiet_when_current_newer_or_unknown() {
    for (name, version) in [
        ("equal", Some(PINNED)),
        ("newer", Some("b12437")),
        ("missing", None),
        ("unparseable", Some("custom-build")),
        ("empty", Some("")),
    ] {
        let m = machine(name, "llama", Some(record(version)), None, None);
        assert_eq!(m.outdated().await, None, "{name}");
        std::fs::remove_dir_all(&m.root).ok();
    }
}

#[tokio::test]
async fn never_flags_an_engine_the_user_owns() {
    // An old llama-server the user pointed at, with a managed record beside it.
    let m =
        machine("external", "llama", Some(record(Some("b11224"))), Some("mine.exe"), Some("version: 11224 (b11224)"));
    let d = m.installer.detect().await;
    assert_eq!(d["source"], "external");
    assert_eq!(d["version"], "b11224");
    assert!(d.get("outdated").is_none());
    std::fs::remove_dir_all(&m.root).ok();
}

#[tokio::test]
async fn skips_a_build_this_machine_no_longer_offers() {
    // Nothing to update *to* with the same backend: do not offer a button that would fail.
    let mut r = record(Some("b11224"));
    r["buildId"] = json!("linux-x64-cpu");
    let m = machine("unoffered", "llama", Some(r), None, None);
    assert_eq!(m.outdated().await, None);
    std::fs::remove_dir_all(&m.root).ok();
}

#[tokio::test]
async fn leaves_an_old_image_runtime_alone() {
    let mut r = record(Some("master-1-abcdef0"));
    r["buildId"] = json!("sd-win-x64-cpu");
    let m = machine("diffusion", "diffusion", Some(r), None, None);
    assert_eq!(m.outdated().await, None);
    std::fs::remove_dir_all(&m.root).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn installing_the_installed_build_again_downloads_the_pinned_release() {
    let m = machine("reinstall", "llama", Some(record(Some("b11224"))), None, None);
    let before = m.outdated().await.expect("old engine is called out");
    // What `Update` sends: the build already installed, nothing else.
    let res = m.installer.install(before["buildId"].as_str()).await;
    assert_eq!(res["ok"], true, "{res}");
    let id = res["jobId"].clone();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let job = loop {
        if let Some(j) = m.downloads.list().into_iter().find(|j| {
            j["id"] == id && j["state"] != "queued" && j["state"] != "downloading" && j["state"] != "verifying"
        }) {
            break j;
        }
        assert!(std::time::Instant::now() < deadline, "did not settle: {:?}", m.downloads.list());
        tokio::time::sleep(Duration::from_millis(5)).await;
    };
    assert_eq!(job["state"], "done", "{job}");
    // It went to GitHub for the pinned release, and the swap stopped the old server first.
    assert!(m.net.requests.lock().unwrap().iter().any(|u| u == "https://dl.test/cpu.zip"));
    assert_eq!(*m.stops.lock().unwrap(), 1);
    // The record says what is on disk now, so the notice goes away.
    let after = m.installer.detect().await;
    assert_eq!(after["version"], PINNED);
    assert_eq!(after["source"], "managed");
    assert!(after.get("outdated").is_none(), "{after}");
    let bin = after["binPath"].as_str().unwrap();
    assert_eq!(std::fs::read_to_string(bin).unwrap(), "the new engine");
    std::fs::remove_dir_all(&m.root).ok();
}

fn nvidia() -> Value {
    json!({
        "source": "nvidia-smi",
        "devices": [{ "name": "RTX 0", "memoryTotalMB": 24000, "memoryUsedMB": 1000, "memoryFreeMB": 23000 }],
        "totalMB": 24000, "usedMB": 1000, "freeMB": 23000,
    })
}

#[tokio::test]
async fn the_cuda_switch_says_it_also_updates_an_old_engine() {
    // Both are the pinned release, so the app shows one button; the CUDA one says it does both.
    let mut r = record(Some("b11224"));
    r["backend"] = json!("vulkan");
    let m = machine_with_gpu("cuda-old", "llama", Some(r), None, None, Some(nvidia()));
    let d = m.installer.detect().await;
    assert_eq!(d["upgrade"]["buildId"], "win-x64-cuda");
    assert!(d["upgrade"]["message"].as_str().unwrap().ends_with(" It also brings the engine up to date."), "{d}");
    assert_eq!(d["outdated"]["installed"], "b11224");
    std::fs::remove_dir_all(&m.root).ok();

    // A current engine gets the switch's usual words, unchanged.
    let mut r = record(Some(PINNED));
    r["backend"] = json!("vulkan");
    let m = machine_with_gpu("cuda-current", "llama", Some(r), None, None, Some(nvidia()));
    let d = m.installer.detect().await;
    assert!(!d["upgrade"]["message"].as_str().unwrap().contains("up to date"), "{d}");
    assert!(d.get("outdated").is_none());
    std::fs::remove_dir_all(&m.root).ok();
}

#[tokio::test]
async fn a_broken_engine_still_reports_its_age_beside_the_repair() {
    // The Repair downloads the pinned release too; the app shows only the Repair.
    let mut r = record(Some("b11224"));
    r["backend"] = json!("cuda");
    r["buildId"] = json!("win-x64-cuda");
    let m = machine("broken-old", "llama", Some(r), None, None);
    let d = m.installer.detect().await;
    assert_eq!(d["problem"]["repairBuildId"], "win-x64-cuda");
    assert!(d.get("upgrade").is_none());
    assert_eq!(d["outdated"]["buildId"], "win-x64-cuda");
    std::fs::remove_dir_all(&m.root).ok();
}
