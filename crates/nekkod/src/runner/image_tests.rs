use super::*;
use nekko_cloud::vault::Vault;
use nekko_runner::Priority;
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::sync::atomic::Ordering;

const PROOF: &str = r#"{"built":"2026-11-01T11:37:57Z","macos":"27.2","xcode":"Xcode 27.2","actionsRunner":"2.338.1","gitlabRunner":"19.5.1"}"#;

fn all_tools() -> Vec<String> {
    JOB_TOOLS.iter().map(|t| t.command.to_owned()).collect()
}

#[derive(Default)]
struct MemVault(Mutex<HashMap<String, String>>);

impl Vault for MemVault {
    fn get(&self, name: &str) -> Option<String> {
        self.0.lock().unwrap().get(name).cloned()
    }
    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        self.0.lock().unwrap().insert(name.into(), value.into());
        Ok(())
    }
    fn delete(&self, name: &str) {
        self.0.lock().unwrap().remove(name);
    }
    fn kind(&self) -> &'static str {
        "memory"
    }
}

/// Records every call. `fail` maps a call's name, or a guest step's command
/// fragment, to the error it returns once.
struct Fake {
    calls: Mutex<Vec<String>>,
    fail: Mutex<Vec<(String, String)>>,
    vms: Mutex<VecDeque<u8>>,
    proof: Mutex<Option<String>>,
    free_gb: Mutex<f64>,
    /// The Xcode copy fills the disk.
    fills_disk: Mutex<bool>,
    /// The job tools on the disk, at lockdown and after `add_tools`.
    tools: Mutex<Vec<String>>,
}

impl Default for Fake {
    fn default() -> Self {
        Fake {
            calls: Mutex::default(),
            fail: Mutex::default(),
            vms: Mutex::default(),
            proof: Mutex::new(Some(PROOF.into())),
            free_gb: Mutex::new(200.0),
            fills_disk: Mutex::new(false),
            tools: Mutex::new(all_tools()),
        }
    }
}

impl Fake {
    fn log(&self, call: impl Into<String>) {
        self.calls.lock().unwrap().push(call.into());
    }
    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
    fn called(&self, name: &str) -> bool {
        self.calls().iter().any(|c| c == name)
    }
    fn fails(&self, what: &str) -> Result<(), String> {
        let mut f = self.fail.lock().unwrap();
        match f.iter().position(|(k, _)| what.contains(k.as_str())) {
            Some(i) => Err(f.remove(i).1),
            None => Ok(()),
        }
    }
    fn on(&self, name: &str) -> Result<(), String> {
        self.log(name);
        self.fails(name)
    }
}

impl BuildHost for Fake {
    async fn preflight(&self, _kind: Kind) -> Result<(), String> {
        self.on("preflight")
    }
    async fn readings(&self) -> Readings {
        Readings {
            vms: self.vms.lock().unwrap().pop_front().unwrap_or(0),
            free_gb: *self.free_gb.lock().unwrap(),
            floor_gb: 25.0,
            ..Default::default()
        }
    }
    async fn restore_image(&self) -> Result<String, String> {
        self.on("restore_image").map(|()| "https://apple.example/restore.ipsw".into())
    }
    async fn download(&self, _url: &str, to: &Path, report: &Report<'_>) -> Result<(), String> {
        self.on("download")?;
        report(Progress::Bytes(5, 10));
        std::fs::write(to, "ipsw").map_err(|e| e.to_string())
    }
    async fn install(&self, ipsw: &Path, bundle: &Path, report: &Report<'_>) -> Result<(), String> {
        self.on("install")?;
        assert!(ipsw.is_file(), "install needs the restore image");
        assert!(!bundle.exists(), "install needs a fresh bundle");
        report(Progress::Fraction(0.5));
        std::fs::create_dir(bundle).map_err(|e| e.to_string())?;
        std::fs::write(bundle.join("disk.img"), "base").map_err(|e| e.to_string())
    }
    async fn first_boot(&self, _bundle: &Path, password: &str) -> Result<(), String> {
        self.log(format!("password {password}"));
        self.on("first_boot")
    }
    async fn boot(&self, _bundle: &Path, password: &str) -> Result<(), String> {
        self.log(format!("password {password}"));
        self.on("boot")
    }
    async fn guest(&self, _password: &str, step: &Step) -> Result<(), String> {
        self.log(format!("guest {}", step.label));
        self.fails(&step.command)
    }
    async fn send_xcode(&self, _password: &str) -> Result<(), String> {
        if *self.fills_disk.lock().unwrap() {
            *self.free_gb.lock().unwrap() = 18.0;
        }
        self.on("send_xcode")
    }
    async fn shutdown(&self, _password: &str) -> Result<(), String> {
        self.on("shutdown")
    }
    async fn halt(&self) {
        self.log("halt");
    }
    async fn lockdown(&self, _password: &str) -> Result<(), String> {
        self.on("lockdown")
    }
    async fn read_proof(&self, _bundle: &Path) -> Result<Proof, String> {
        self.on("read_proof")?;
        let tools = self.tools.lock().unwrap().clone();
        Ok(Proof { image: self.proof.lock().unwrap().clone(), log: "provision-rc=0".into(), tools })
    }
    async fn test_boot(&self, _bundle: &Path) -> Result<(), String> {
        self.on("test_boot")
    }
    async fn clone_bundle(&self, from: &Path, to: &Path) -> Result<(), String> {
        self.on("clone_bundle")?;
        std::fs::create_dir(to).map_err(|e| e.to_string())?;
        std::fs::copy(from.join("disk.img"), to.join("disk.img")).map_err(|e| e.to_string()).map(drop)
    }
    async fn write_scripts(&self, bundle: &Path) -> Result<(), String> {
        self.on("write_scripts")?;
        assert!(bundle.join("disk.img").is_file(), "scripts go into the copy");
        Ok(())
    }
    async fn add_tools(&self, bundle: &Path) -> Result<Vec<String>, String> {
        self.on("add_tools")?;
        assert!(bundle.join("disk.img").is_file(), "the tools go into the copy");
        Ok(self.tools.lock().unwrap().clone())
    }
    async fn swap(&self, bundle: &Path, default: &Path) -> Result<(), String> {
        self.log("swap");
        swap_bundle(bundle, default).map_err(|e| e.to_string())
    }
    async fn enable_runner(&self, id: &str, priority: Priority) -> Result<(), String> {
        self.log(format!("enable {id} {priority:?}"));
        Ok(())
    }
}

struct Rig {
    dir: tempfile::TempDir,
    vault: Arc<MemVault>,
    views: Arc<Mutex<Vec<ImageView>>>,
    building: Arc<AtomicBool>,
    slot: Arc<BuildSlot>,
    /// The keep-awake wish at each view that waits.
    awake_while_waiting: Arc<Mutex<Vec<bool>>>,
    /// Whether the build held a macOS place as each stage ran.
    wants_by_stage: Arc<Mutex<Vec<(Stage, bool)>>>,
}

impl Rig {
    fn new() -> Rig {
        Rig {
            dir: tempfile::tempdir().unwrap(),
            vault: Arc::default(),
            views: Arc::default(),
            building: Arc::default(),
            slot: Arc::default(),
            awake_while_waiting: Arc::default(),
            wants_by_stage: Arc::default(),
        }
    }
    fn images(&self) -> PathBuf {
        self.dir.path().join("images")
    }
    fn job(&self, fake: Fake) -> Arc<ImageJob<Fake>> {
        let views = self.views.clone();
        let (awake, building) = (self.awake_while_waiting.clone(), self.building.clone());
        let (wants, slot) = (self.wants_by_stage.clone(), self.slot.clone());
        let mut job = ImageJob::new(
            self.images(),
            fake,
            self.vault.clone(),
            self.building.clone(),
            self.slot.clone(),
            Box::new(move |v: &ImageView| {
                views.lock().unwrap().push(v.clone());
                if v.state == ImageState::Waiting {
                    awake.lock().unwrap().push(building.load(Ordering::SeqCst));
                }
                if let (ImageState::Building, Some(stage)) = (v.state, v.stage) {
                    wants.lock().unwrap().push((stage, slot.wants()));
                }
            }),
        );
        job.poll = Duration::from_millis(1);
        Arc::new(job)
    }
    fn stages_started(&self) -> Vec<Stage> {
        let mut out: Vec<Stage> = vec![];
        for v in self.views.lock().unwrap().iter() {
            if let (Some(s), ImageState::Building) = (v.stage, v.state)
                && out.last() != Some(&s)
            {
                out.push(s);
            }
        }
        out
    }
}

fn request(kind: Kind) -> BuildRequest {
    BuildRequest { kind, runner_id: Some("r1".into()), priority: Priority::RunnerFirst }
}

async fn finish(job: &Arc<ImageJob<Fake>>) {
    let task = job.task.lock().unwrap().take().expect("a running job");
    task.await.unwrap();
}

fn fail(job: &Arc<ImageJob<Fake>>, what: &str, error: &str) {
    job.host.fail.lock().unwrap().push((what.into(), error.into()));
}

/// A job stopped mid-build and resumed on a fresh daemon.
fn restarted(rig: &Rig) -> Arc<ImageJob<Fake>> {
    rig.job(Fake::default())
}

#[tokio::test]
async fn stages_run_in_order_and_report() {
    let rig = Rig::new();
    let job = rig.job(Fake::default());
    job.build(request(Kind::Xcode)).unwrap();
    assert!(rig.building.load(Ordering::SeqCst), "held awake while it builds");
    finish(&job).await;

    use Stage::*;
    assert_eq!(rig.stages_started(), vec![Check, Download, Install, Xcode, Lockdown, Test, Finish]);
    let calls = job.host.calls();
    let order =
        ["preflight", "restore_image", "download", "install", "first_boot", "send_xcode", "lockdown", "test_boot"];
    let at: Vec<usize> = order.iter().map(|o| calls.iter().position(|c| c == o).unwrap()).collect();
    assert!(at.windows(2).all(|w| w[0] < w[1]), "{calls:?}");

    let views = rig.views.lock().unwrap();
    assert!(views.iter().any(|v| v.bytes == Some((5, 10))), "download progress");
    assert!(views.iter().any(|v| v.fraction == Some(0.5)), "install progress");
    drop(views);
    let v = job.status();
    assert_eq!(v.state, ImageState::Ready);
    assert_eq!(v.info.unwrap().macos, "27.2");
    assert!(!v.can_resume);
    assert!(!rig.building.load(Ordering::SeqCst));
    assert!(rig.images().join("default/disk.img").is_file(), "the bundle is swapped in");
    assert!(rig.images().join("default/image.json").is_file());
    assert!(!rig.images().join("default.new").exists(), "the build folder goes");
    assert!(rig.vault.get(PASSWORD_ITEM).is_none(), "the password goes at Finish");
}

#[tokio::test]
async fn the_restore_image_goes_after_the_checkpoint() {
    let rig = Rig::new();
    let job = rig.job(Fake::default());
    fail(&job, "send_xcode", "stop here");
    job.build(request(Kind::Xcode)).unwrap();
    finish(&job).await;
    let dir = rig.images().join("default.new");
    assert!(dir.join("checkpoint/disk.img").is_file());
    assert!(!dir.join("restore.ipsw").exists());
}

#[tokio::test]
async fn a_finished_restore_image_is_not_downloaded_again() {
    let rig = Rig::new();
    let dir = rig.images().join("default.new");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("restore.ipsw"), "ipsw").unwrap();
    let job = rig.job(Fake::default());
    job.build(request(Kind::Xcode)).unwrap();
    finish(&job).await;
    assert!(!job.host.called("download"));
    assert!(!job.host.called("restore_image"));
    assert!(job.host.called("install"));
}

#[tokio::test]
async fn the_restore_image_is_kept_and_used_by_the_next_build() {
    let rig = Rig::new();
    let job = rig.job(Fake::default());
    job.build(request(Kind::Xcode)).unwrap();
    finish(&job).await;
    let kept = rig.images().join("cache/restore.ipsw");
    assert_eq!(std::fs::read_to_string(&kept).unwrap(), "ipsw", "kept after the build's own copy went");

    let job = rig.job(Fake::default());
    job.build(request(Kind::Xcode)).unwrap();
    finish(&job).await;
    assert!(job.host.called("restore_image"), "it still asks Apple which image is newest");
    assert!(!job.host.called("download"), "{:?}", job.host.calls());
    assert!(job.host.called("install"));
    assert!(kept.is_file(), "the kept image outlives a build that used it");
    assert_eq!(job.status().state, ImageState::Ready);
}

#[tokio::test]
async fn a_newer_restore_image_replaces_the_kept_one() {
    let rig = Rig::new();
    let cache = rig.images().join("cache");
    std::fs::create_dir_all(&cache).unwrap();
    std::fs::write(cache.join("UniversalMac_27.1_26A1_Restore.ipsw"), "old").unwrap();
    let job = rig.job(Fake::default());
    job.build(request(Kind::Xcode)).unwrap();
    finish(&job).await;
    assert!(job.host.called("download"));
    let names: Vec<_> = std::fs::read_dir(&cache).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(names, vec![std::ffi::OsString::from("restore.ipsw")]);
}

#[test]
fn scripts_go_to_the_attached_disks_data_volume_only() {
    // Trimmed from `diskutil apfs list -plist` on a guest disk, as JSON. The host's own Data
    // volume (disk3s5) is in the same list and must never be picked.
    let json = br#"{"Containers":[
        {"Volumes":[{"DeviceIdentifier":"disk3s5","Name":"Data","Roles":["Data"]}]},
        {"Volumes":[
            {"DeviceIdentifier":"disk15s1","Name":"Macintosh HD","Roles":["System"]},
            {"DeviceIdentifier":"disk15s5","Name":"Data","Roles":["Data"]}]}]}"#;
    let attached = ["/dev/disk10", "/dev/disk15", "/dev/disk15s1", "/dev/disk15s5"];
    assert_eq!(data_volume(json, &attached).as_deref(), Some("/dev/disk15s5"));
    assert_eq!(data_volume(json, &["/dev/disk10"]), None, "no Data volume of this disk");
    assert_eq!(data_volume(b"not json", &attached), None);
}

#[test]
fn only_a_plain_restore_file_name_is_kept_by_name() {
    assert_eq!(
        restore_name("https://updates.cdn-apple.com/x/UniversalMac_27.2_26B123_Restore.ipsw"),
        "UniversalMac_27.2_26B123_Restore.ipsw"
    );
    for odd in ["https://a/b/../x.ipsw?y", "https://a/b/.hidden.ipsw", "https://a/b/c.zip", "https://a/b/"] {
        assert_eq!(restore_name(odd), IPSW, "{odd}");
    }
}

#[tokio::test]
async fn a_refresh_copies_the_image_writes_the_scripts_and_tests_it() {
    let rig = Rig::new();
    let job = rig.job(Fake::default());
    job.build(request(Kind::Xcode)).unwrap();
    finish(&job).await;
    let info = std::fs::read_to_string(rig.images().join("default/image.json")).unwrap();

    let job = rig.job(Fake::default());
    let view = job.build(BuildRequest { kind: Kind::Refresh, runner_id: None, priority: Priority::Balanced }).unwrap();
    assert_eq!(view.kind, Some(Kind::Refresh));
    finish(&job).await;
    use Stage::*;
    assert_eq!(
        rig.stages_started(),
        vec![Check, Download, Install, Xcode, Lockdown, Test, Finish, Check, Scripts, Test, Finish]
    );
    let calls = job.host.calls();
    let order = ["preflight", "clone_bundle", "write_scripts", "test_boot", "swap"];
    let at: Vec<usize> = order.iter().map(|o| calls.iter().position(|c| c == o).unwrap()).collect();
    assert!(at.windows(2).all(|w| w[0] < w[1]), "{calls:?}");
    for none in ["restore_image", "download", "install", "send_xcode", "lockdown"] {
        assert!(!job.host.called(none), "{none}: {calls:?}");
    }
    assert!(!calls.iter().any(|c| c.starts_with("enable")), "a refresh keeps the runner as it is");
    assert_eq!(
        std::fs::read_to_string(rig.images().join("default/image.json")).unwrap(),
        info,
        "the proof carries over"
    );
    assert_eq!(job.status().state, ImageState::Ready);
}

#[tokio::test]
async fn a_refresh_without_an_image_stops_at_once() {
    let rig = Rig::new();
    let job = rig.job(Fake::default());
    job.build(BuildRequest { kind: Kind::Refresh, runner_id: None, priority: Priority::Balanced }).unwrap();
    finish(&job).await;
    let v = job.status();
    assert_eq!((v.state, v.stage), (ImageState::Failed, Some(Stage::Scripts)));
    assert_eq!(v.error.as_deref(), Some(NO_IMAGE_TO_UPDATE));
    assert!(!job.host.called("clone_bundle"));
}

#[tokio::test]
async fn macos_only_skips_xcode_and_the_simulator_but_not_homebrew() {
    let rig = Rig::new();
    let job = rig.job(Fake::default());
    job.build(request(Kind::MacosOnly)).unwrap();
    finish(&job).await;
    let calls = job.host.calls();
    assert!(!job.host.called("send_xcode"));
    assert!(!calls.iter().any(|c| c.contains("simulator") || c.contains("license")), "{calls:?}");
    assert!(calls.iter().any(|c| c.contains("Homebrew")), "{calls:?}");
    assert_eq!(job.status().state, ImageState::Ready);
}

#[test]
fn the_sudoers_file_for_homebrew_is_removed_after_it() {
    let steps = xcode_steps(Kind::MacosOnly);
    let add = steps.iter().position(|s| s.command.contains("/etc/sudoers.d/build") && s.command.contains("NOPASSWD"));
    let brew = steps.iter().position(|s| s.command.contains("NONINTERACTIVE=1"));
    let job_tools = steps.iter().position(|s| s.command.contains("brew install node gh jq zstd gnu-tar"));
    let rm = steps.iter().position(|s| s.command.contains("rm -f /etc/sudoers.d/build"));
    assert!(add < brew && brew < job_tools && job_tools < rm && add.is_some(), "{steps:?}");
    assert!(!steps[brew.unwrap()].root, "Homebrew refuses to run as root");
    assert!(!steps[job_tools.unwrap()].root, "Homebrew refuses to run as root");
}

#[test]
fn every_image_gets_the_tools_jobs_run_before_their_setup() {
    for kind in [Kind::Xcode, Kind::MacosOnly] {
        let steps = xcode_steps(kind);
        let step = steps.iter().find(|s| s.label == TOOLS_LABEL).expect("a job tools step");
        for t in JOB_TOOLS {
            assert!(step.command.split_whitespace().any(|w| w == t.formula), "{kind:?} installs {}", t.formula);
            assert!(TOOLS_LABEL.contains(t.command), "the label names {}", t.command);
        }
        assert_eq!(step.limit, Duration::from_secs(20 * 60));
    }
    // What ios-native.yml runs on the runner before setup-node, and in its batch report (#1845),
    // then what actions/cache needs to compress with zstd (#2701).
    let commands: Vec<_> = JOB_TOOLS.iter().map(|t| t.command).collect();
    assert_eq!(commands, ["node", "gh", "jq", "zstd", "gtar"]);
    assert_eq!(tool_formulas(), "node gh jq zstd gnu-tar");
}

fn info(macos: &str, tools: Option<&[&str]>) -> ImageInfo {
    ImageInfo {
        macos: macos.into(),
        xcode: None,
        actions_runner: "2.338.1".into(),
        built: "2026-11-01T11:37:57Z".into(),
        tools: tools.map(|t| t.iter().map(|s| (*s).to_owned()).collect()),
        missing_tools: vec![],
    }
}

#[test]
fn an_image_built_before_the_check_lacks_every_tool_macos_does_not_ship() {
    assert_eq!(missing_tools(&info("27.2", None)), ["node", "gh", "zstd", "gtar"], "macOS 15 and later ship jq");
    assert_eq!(missing_tools(&info("14.6", None)), ["node", "gh", "jq", "zstd", "gtar"]);
    assert_eq!(missing_tools(&info("", None)), ["node", "gh", "jq", "zstd", "gtar"], "an unreadable version ships nothing");
}

#[test]
fn a_recorded_image_lacks_only_what_its_disk_lacked() {
    assert!(missing_tools(&info("27.2", Some(&["node", "gh", "jq", "zstd", "gtar"]))).is_empty());
    assert_eq!(
        missing_tools(&info("27.2", Some(&["node"]))),
        ["gh", "jq", "zstd", "gtar"],
        "a record is believed over the macOS version"
    );
    assert_eq!(missing_tools(&info("27.2", Some(&[]))), ["node", "gh", "jq", "zstd", "gtar"]);
    // Recorded before zstd and gtar were checked (#2701): this Mac's image from 2026-11-03.
    assert_eq!(missing_tools(&info("27.2", Some(&["node", "gh", "jq"]))), ["zstd", "gtar"]);
}

#[test]
fn the_proof_keeps_its_fields_and_gains_the_tools() {
    let merged = with_tools(PROOF, &all_tools()).unwrap();
    let v: Value = serde_json::from_str(&merged).unwrap();
    assert_eq!(v["gitlabRunner"], "19.5.1", "what provision.sh wrote stays");
    assert_eq!(v["tools"], json!(["node", "gh", "jq", "zstd", "gtar"]));
    let info: ImageInfo = serde_json::from_str(&merged).unwrap();
    assert!(missing_tools(&info).is_empty());
    assert!(with_tools("[]", &[]).is_err());
}

#[test]
fn the_view_names_the_missing_tools_and_never_stores_them() {
    let mut i: ImageInfo = serde_json::from_str(PROOF).unwrap();
    assert_eq!(i.tools, None, "an image from before the check");
    i.missing_tools = missing_tools(&i);
    let v = serde_json::to_value(ImageView { info: Some(i), ..Default::default() }).unwrap();
    assert_eq!(v["info"]["missingTools"], json!(["node", "gh", "zstd", "gtar"]));
    let back: ImageInfo = serde_json::from_value(v["info"].clone()).unwrap();
    assert!(back.missing_tools.is_empty(), "worked out on each read, never read back");
}

#[test]
fn tools_are_found_where_a_jobs_path_looks_on_any_volume() {
    let dir = tempfile::tempdir().unwrap();
    assert!(tools_on(dir.path()).is_empty());
    let (system, data) = (dir.path().join("dmg.system"), dir.path().join("dmg.data"));
    std::fs::create_dir_all(system.join("usr/bin")).unwrap();
    std::fs::write(system.join("usr/bin/jq"), "").unwrap();
    std::fs::create_dir_all(data.join("opt/homebrew/bin")).unwrap();
    // Homebrew's link into its Cellar, dangling here, still counts.
    std::os::unix::fs::symlink("../Cellar/node/25.1.0/bin/node", data.join("opt/homebrew/bin/node")).unwrap();
    assert_eq!(tools_on(dir.path()), ["node", "jq"]);
    std::fs::write(data.join("opt/homebrew/bin/gh"), "").unwrap();
    std::fs::write(data.join("opt/homebrew/bin/zstd"), "").unwrap();
    assert_eq!(tools_on(dir.path()), ["node", "gh", "jq", "zstd"]);
    std::os::unix::fs::symlink("../Cellar/gnu-tar/1.35/bin/gtar", data.join("opt/homebrew/bin/gtar")).unwrap();
    assert_eq!(tools_on(dir.path()), all_tools());
    assert_eq!(proof_on(dir.path()).tools, all_tools());
}

#[test]
fn the_tools_script_installs_as_runner_and_always_powers_off() {
    let s = tools_script();
    assert!(s.starts_with("#!/bin/bash\n"));
    assert!(s.contains("trap 'echo \"add-tools: shutting down\"; shutdown -h now' EXIT"));
    assert!(s.contains("sudo -u runner -H"), "Homebrew refuses root, and runner owns it after provision.sh");
    assert!(s.contains(&format!("brew install {}", tool_formulas())));
    assert!(s.contains(&format!("PATH={RUNNER_PATH}")));
    assert!(s.contains(&format!(">>/{TOOLS_LOG}")));
    let boot = include_str!("../../../../scripts/runner-image/nekko-runner-boot.sh");
    assert!(boot.contains(&format!("RUNNER_PATH=\"{RUNNER_PATH}\"")), "the PATH jobs get");
}

#[tokio::test]
async fn a_new_image_records_its_tools_and_needs_none() {
    let rig = Rig::new();
    let job = rig.job(Fake::default());
    job.build(request(Kind::MacosOnly)).unwrap();
    finish(&job).await;
    let info = job.status().info.unwrap();
    assert_eq!(info.tools, Some(all_tools()));
    assert!(info.missing_tools.is_empty());
}

/// An image as one built before the tools check left it.
fn old_image(rig: &Rig) {
    let default = rig.images().join("default");
    std::fs::create_dir_all(&default).unwrap();
    std::fs::write(default.join("disk.img"), "pilot").unwrap();
    std::fs::write(default.join("image.json"), PROOF).unwrap();
}

#[tokio::test]
async fn an_old_image_shows_its_missing_tools_and_adding_them_clears_it() {
    let rig = Rig::new();
    old_image(&rig);
    let job = rig.job(Fake::default());
    assert_eq!(job.status().info.unwrap().missing_tools, ["node", "gh", "zstd", "gtar"]);

    let view = job.build(BuildRequest { kind: Kind::Tools, runner_id: None, priority: Priority::Balanced }).unwrap();
    assert_eq!(view.kind, Some(Kind::Tools));
    finish(&job).await;
    use Stage::*;
    assert_eq!(rig.stages_started(), vec![Check, Tools, Test, Finish]);
    let calls = job.host.calls();
    let order = ["preflight", "clone_bundle", "add_tools", "test_boot", "swap"];
    let at: Vec<usize> = order.iter().map(|o| calls.iter().position(|c| c == o).unwrap()).collect();
    assert!(at.windows(2).all(|w| w[0] < w[1]), "{calls:?}");
    for none in ["restore_image", "download", "install", "send_xcode", "lockdown"] {
        assert!(!job.host.called(none), "{none}: {calls:?}");
    }
    assert!(!calls.iter().any(|c| c.starts_with("enable")), "the runner stays as it is");
    let v = job.status();
    assert_eq!(v.state, ImageState::Ready);
    let info = v.info.unwrap();
    assert!(info.missing_tools.is_empty());
    assert_eq!((info.macos.as_str(), info.tools), ("27.2", Some(all_tools())), "the rest of the proof carries over");
    assert!(!rig.images().join("default.new").exists(), "the build folder goes");
}

#[tokio::test]
async fn an_install_that_leaves_a_tool_out_fails_and_keeps_the_image() {
    let rig = Rig::new();
    old_image(&rig);
    let fake = Fake::default();
    *fake.tools.lock().unwrap() = vec!["node".into(), "jq".into()];
    let job = rig.job(fake);
    job.build(BuildRequest { kind: Kind::Tools, runner_id: None, priority: Priority::Balanced }).unwrap();
    finish(&job).await;
    let v = job.status();
    assert_eq!((v.state, v.stage), (ImageState::Failed, Some(Stage::Tools)));
    assert_eq!(v.error.as_deref(), Some("Still missing after the install: gh, zstd, gtar. Show the log for why."));
    assert!(v.can_resume);
    assert!(!job.host.called("swap"));
    assert_eq!(std::fs::read_to_string(rig.images().join("default/image.json")).unwrap(), PROOF);
}

#[tokio::test]
async fn adding_tools_needs_an_image_with_a_record() {
    let rig = Rig::new();
    let job = rig.job(Fake::default());
    job.build(BuildRequest { kind: Kind::Tools, runner_id: None, priority: Priority::Balanced }).unwrap();
    finish(&job).await;
    assert_eq!(job.status().error.as_deref(), Some(NO_IMAGE_TO_UPDATE));

    let rig = Rig::new();
    old_image(&rig);
    std::fs::remove_file(rig.images().join("default/image.json")).unwrap();
    let job = rig.job(Fake::default());
    assert!(job.status().info.is_none(), "nothing to say about an image with no record");
    job.build(BuildRequest { kind: Kind::Tools, runner_id: None, priority: Priority::Balanced }).unwrap();
    finish(&job).await;
    assert_eq!(job.status().error.as_deref(), Some(NO_RECORD_TO_UPDATE));
    assert!(!job.host.called("clone_bundle"));
}

#[test]
fn every_guest_step_has_its_limit() {
    let steps = xcode_steps(Kind::Xcode);
    let limit = |needle: &str| steps.iter().find(|s| s.command.contains(needle)).unwrap().limit;
    assert_eq!(limit("-license accept"), Duration::from_secs(3 * 60));
    assert_eq!(limit("-runFirstLaunch"), Duration::from_secs(20 * 60));
    assert_eq!(limit("-downloadPlatform iOS"), Duration::from_secs(60 * 60));
    assert_eq!(limit("NONINTERACTIVE=1"), Duration::from_secs(20 * 60));
    assert_eq!(limit("brew install node gh jq zstd gnu-tar"), Duration::from_secs(20 * 60));
    let sim = steps.iter().find(|s| s.command.contains("-downloadPlatform iOS")).unwrap();
    assert!(sim.command.contains("launchctl asuser") && sim.command.contains("sudo -u nekko-build -H"));
}

#[tokio::test]
async fn failure_at_xcode_then_resume_reuses_the_checkpoint() {
    let rig = Rig::new();
    let job = rig.job(Fake::default());
    fail(&job, "-runFirstLaunch", "First launch: the limit tripped");
    job.build(request(Kind::Xcode)).unwrap();
    finish(&job).await;
    let v = job.status();
    assert_eq!(v.state, ImageState::Failed);
    assert_eq!(v.stage, Some(Stage::Xcode));
    assert!(v.can_resume);
    assert!(v.error.unwrap().contains("the limit tripped"));
    assert!(job.host.called("halt"), "a failed stage leaves no VM");
    let installs = job.host.calls().iter().filter(|c| *c == "install").count();
    assert_eq!(installs, 1);

    job.host.calls.lock().unwrap().clear();
    job.resume().unwrap();
    finish(&job).await;
    assert_eq!(job.status().state, ImageState::Ready);
    assert!(!job.host.called("install"), "the checkpoint saves reinstalling macOS");
    assert!(!job.host.called("download"));
    assert!(job.host.called("clone_bundle"));
    assert!(job.host.called("send_xcode"), "the Xcode stage restarts");
}

#[tokio::test]
async fn lockdown_failure_goes_back_to_the_checkpoint() {
    let rig = Rig::new();
    let job = rig.job(Fake::default());
    fail(&job, "lockdown", "the guest did not stop");
    job.build(request(Kind::Xcode)).unwrap();
    finish(&job).await;
    assert_eq!(job.status().stage, Some(Stage::Lockdown));
    job.host.calls.lock().unwrap().clear();
    job.resume().unwrap();
    finish(&job).await;
    assert_eq!(job.status().state, ImageState::Ready);
    assert!(job.host.called("send_xcode"), "lockdown runs once per image, so Xcode is redone");
    assert!(!job.host.called("install"));
}

#[tokio::test]
async fn a_lockdown_hang_still_reads_what_the_guest_logged() {
    let rig = Rig::new();
    let job = rig.job(Fake::default());
    fail(&job, "lockdown", "The guest did not stop within 15 min.");
    job.build(request(Kind::Xcode)).unwrap();
    finish(&job).await;
    let v = job.status();
    assert_eq!(v.error.as_deref(), Some("The guest did not stop within 15 min."));
    assert!(v.log.unwrap().contains("provision-rc=0"), "the only clue, and a resume deletes that disk");
    let calls = job.host.calls();
    let (halt, read) = (calls.iter().position(|c| c == "halt"), calls.iter().position(|c| c == "read_proof"));
    assert!(halt < read, "the disk is read with the VM down: {calls:?}");
}

#[tokio::test]
async fn any_failed_stage_leaves_no_vm_up() {
    let rig = Rig::new();
    let job = rig.job(Fake::default());
    fail(&job, "shutdown", "The guest did not shut down cleanly.");
    job.build(request(Kind::MacosOnly)).unwrap();
    finish(&job).await;
    assert_eq!(job.status().state, ImageState::Failed);
    assert!(job.host.called("halt"));
}

#[tokio::test]
async fn a_hang_fails_the_stage_and_leaves_the_image_alone() {
    let rig = Rig::new();
    let default = rig.images().join("default");
    std::fs::create_dir_all(&default).unwrap();
    std::fs::write(default.join("disk.img"), "pilot").unwrap();
    let job = rig.job(Fake::default());
    fail(&job, "-downloadPlatform", "The iOS simulator: did not finish within 60 min");
    job.build(request(Kind::Xcode)).unwrap();
    finish(&job).await;
    let v = job.status();
    assert_eq!(v.state, ImageState::Failed);
    assert_eq!(v.error.as_deref(), Some("The iOS simulator: did not finish within 60 min"));
    assert!(v.log.unwrap().contains("did not finish within 60 min"));
    assert_eq!(std::fs::read_to_string(default.join("disk.img")).unwrap(), "pilot");
}

#[tokio::test]
async fn a_full_disk_says_how_much_to_free() {
    let rig = Rig::new();
    let job = rig.job(Fake::default());
    *job.host.fills_disk.lock().unwrap() = true;
    fail(&job, "send_xcode", "tar: write error");
    job.build(request(Kind::Xcode)).unwrap();
    finish(&job).await;
    let v = job.status();
    assert_eq!(v.error.as_deref(), Some("This Mac has 18 GB free. Free up 92 GB, then try again."));
    assert!(v.log.unwrap().contains("tar: write error"), "the raw error stays in the log");
}

#[tokio::test]
async fn no_proof_fails_lockdown_even_after_a_clean_stop() {
    let rig = Rig::new();
    let fake = Fake::default();
    *fake.proof.lock().unwrap() = None;
    let job = rig.job(fake);
    job.build(request(Kind::Xcode)).unwrap();
    finish(&job).await;
    let v = job.status();
    assert_eq!(v.state, ImageState::Failed);
    assert_eq!(v.stage, Some(Stage::Lockdown));
    assert!(!job.host.called("test_boot"));
    assert!(!job.host.called("swap"));
    assert!(v.log.unwrap().contains("provision-rc=0"), "the provision log reaches the build log");
}

#[tokio::test]
async fn a_proof_that_does_not_parse_fails_lockdown() {
    let rig = Rig::new();
    let fake = Fake::default();
    *fake.proof.lock().unwrap() = Some("{}".into());
    let job = rig.job(fake);
    job.build(request(Kind::Xcode)).unwrap();
    finish(&job).await;
    assert_eq!(job.status().stage, Some(Stage::Lockdown));
    assert!(!job.host.called("test_boot"));
}

#[tokio::test]
async fn two_vms_wait_with_a_reason() {
    let rig = Rig::new();
    let fake = Fake::default();
    // Check and Download boot nothing and go ahead; Install waits.
    fake.vms.lock().unwrap().extend([2, 2, 2, 2, 0]);
    let job = rig.job(fake);
    job.build(request(Kind::Xcode)).unwrap();
    finish(&job).await;
    let views = rig.views.lock().unwrap();
    let waits: Vec<_> = views.iter().filter(|v| v.state == ImageState::Waiting).map(|v| v.stage).collect();
    assert_eq!(waits, vec![Some(Stage::Install), Some(Stage::Install)]);
    assert!(views.iter().any(|v| v.state == ImageState::Waiting && v.detail == "Waiting for a free VM slot"));
    assert_eq!(job.status().state, ImageState::Ready);
}

#[tokio::test]
async fn a_runner_vm_with_a_job_is_waited_for_by_name() {
    let rig = Rig::new();
    old_image(&rig);
    rig.slot.set_runner_vms(1);
    let fake = Fake::default();
    fake.vms.lock().unwrap().extend([2, 2]);
    let job = rig.job(fake);
    job.build(request(Kind::Tools)).unwrap();
    while !rig.views.lock().unwrap().iter().any(|v| v.state == ImageState::Waiting) {
        tokio::task::yield_now().await;
    }
    rig.slot.set_runner_vms(0);
    finish(&job).await;
    let views = rig.views.lock().unwrap();
    assert!(views.iter().any(|v| v.state == ImageState::Waiting && v.detail == "Waiting for a CI job to finish"));
    assert_eq!(job.status().state, ImageState::Ready);
}

#[tokio::test]
async fn the_build_holds_a_macos_place_from_its_first_vm_stage_to_its_end() {
    let rig = Rig::new();
    let job = rig.job(Fake::default());
    job.build(request(Kind::Xcode)).unwrap();
    finish(&job).await;
    let wants = rig.wants_by_stage.lock().unwrap().clone();
    let at = |s: Stage| wants.iter().filter(|(st, _)| *st == s).all(|(_, w)| *w);
    assert!(wants.iter().any(|(s, w)| *s == Stage::Check && !*w), "{wants:?}");
    assert!(wants.iter().any(|(s, w)| *s == Stage::Download && !*w), "{wants:?}");
    for s in [Stage::Install, Stage::Xcode, Stage::Lockdown, Stage::Test, Stage::Finish] {
        assert!(at(s), "held at {s:?}: {wants:?}");
    }
    assert!(!rig.slot.wants(), "given back once the build is done");

    // A failed build gives it back too.
    let rig = Rig::new();
    old_image(&rig);
    let job = rig.job(Fake::default());
    fail(&job, "add_tools", "no network");
    job.build(request(Kind::Tools)).unwrap();
    finish(&job).await;
    assert_eq!(job.status().state, ImageState::Failed);
    assert!(rig.wants_by_stage.lock().unwrap().contains(&(Stage::Tools, true)));
    assert!(!rig.slot.wants());
}

#[tokio::test]
async fn waiting_does_not_hold_the_mac_awake() {
    let rig = Rig::new();
    let fake = Fake::default();
    fake.vms.lock().unwrap().extend([0, 0, 0, 2, 0]);
    let job = rig.job(fake);
    fail(&job, "send_xcode", "stop here");
    job.build(request(Kind::Xcode)).unwrap();
    while !job.host.called("send_xcode") {
        assert!(rig.building.load(Ordering::SeqCst) || !rig.awake_while_waiting.lock().unwrap().is_empty());
        tokio::task::yield_now().await;
    }
    finish(&job).await;
    assert_eq!(*rig.awake_while_waiting.lock().unwrap(), vec![false], "a Mac unplugged mid-build may sleep");
}

#[test]
fn the_gates_wait_with_a_reason() {
    let ok = Readings { free_gb: 200.0, floor_gb: 25.0, ..Default::default() };
    assert_eq!(waiting_reason(&ok, Stage::Install), None);
    let hot = Readings { hot: true, ..ok };
    assert!(waiting_reason(&hot, Stage::Check).is_some());
    let memory = Readings { memory_critical: true, ..ok };
    assert!(waiting_reason(&memory, Stage::Check).is_some());
    let full = Readings { free_gb: 10.0, ..ok };
    assert!(waiting_reason(&full, Stage::Check).is_some());
    // A macOS place matters only to a stage that boots a VM.
    let two = Readings { vms: 2, ..ok };
    for stage in [Stage::Check, Stage::Download, Stage::Scripts, Stage::Finish] {
        assert_eq!(waiting_reason(&two, stage), None, "{stage:?}");
    }
    for stage in [Stage::Install, Stage::Xcode, Stage::Lockdown, Stage::Tools, Stage::Test] {
        assert_eq!(waiting_reason(&two, stage).as_deref(), Some("Waiting for a free VM slot"), "{stage:?}");
    }
    let job = Readings { vms: 2, runner_vms: 1, ..ok };
    assert_eq!(waiting_reason(&job, Stage::Tools).as_deref(), Some("Waiting for a CI job to finish"));
    // Runner VMs still booting are not in the helper's count yet.
    let booting = Readings { vms: 0, runner_vms: 2, ..ok };
    assert!(waiting_reason(&booting, Stage::Tools).is_some());
    let one = Readings { vms: 1, runner_vms: 1, ..ok };
    assert_eq!(waiting_reason(&one, Stage::Tools), None, "one place is enough");
    let battery = Readings { on_battery: true, ..ok };
    assert_eq!(waiting_reason(&battery, Stage::Download), None, "a download may run on battery");
    assert!(waiting_reason(&battery, Stage::Install).is_some());
    assert!(waiting_reason(&battery, Stage::Lockdown).is_some());
}

#[tokio::test]
async fn finish_enables_the_chosen_runner_with_the_chosen_priority() {
    let rig = Rig::new();
    let job = rig.job(Fake::default());
    job.build(request(Kind::Xcode)).unwrap();
    finish(&job).await;
    let calls = job.host.calls();
    assert!(calls.iter().any(|c| c == "enable r1 RunnerFirst"), "{calls:?}");
    let (swap, enable) = (calls.iter().position(|c| c == "swap"), calls.iter().position(|c| c.starts_with("enable")));
    assert!(swap < enable, "a runner turns on only with its image in place");
}

#[tokio::test]
async fn no_runner_yet_still_swaps_the_image() {
    let rig = Rig::new();
    let job = rig.job(Fake::default());
    job.build(BuildRequest { kind: Kind::MacosOnly, runner_id: None, priority: Priority::Balanced }).unwrap();
    finish(&job).await;
    assert_eq!(job.status().state, ImageState::Ready);
    assert!(!job.host.calls().iter().any(|c| c.starts_with("enable")));
}

#[tokio::test]
async fn cancel_removes_the_build_folder_and_the_password() {
    let rig = Rig::new();
    let fake = Fake::default();
    // Holds the job at a gate once Install has stored the password.
    fake.vms.lock().unwrap().extend([0, 0, 0, 2, 2, 2, 2, 2]);
    let job = rig.job(fake);
    job.build(request(Kind::Xcode)).unwrap();
    while !job.host.called("first_boot") {
        tokio::task::yield_now().await;
    }
    while job.vault.get(PASSWORD_ITEM).is_none() {
        tokio::task::yield_now().await;
    }
    let v = job.cancel().await;
    assert_eq!(v.state, ImageState::None);
    assert!(!rig.images().join("default.new").exists());
    assert!(rig.vault.get(PASSWORD_ITEM).is_none());
    assert!(job.host.called("halt"));
    assert!(!rig.building.load(Ordering::SeqCst));
    assert!(!rig.slot.wants(), "the macOS place is given back");
}

#[tokio::test]
async fn resume_after_restart_reads_the_password_from_the_vault() {
    let rig = Rig::new();
    let job = rig.job(Fake::default());
    fail(&job, "send_xcode", "the daemon stopped");
    job.build(request(Kind::Xcode)).unwrap();
    finish(&job).await;
    let password = rig.vault.get(PASSWORD_ITEM).expect("kept for the resume");
    assert_eq!(password.len(), 48, "24 random bytes in hex");
    drop(job);

    let job = restarted(&rig);
    let v = job.status();
    assert!(v.can_resume, "build.json exists at start");
    assert_eq!(v.state, ImageState::None);
    assert_eq!(v.stage, Some(Stage::Xcode));
    job.resume().unwrap();
    finish(&job).await;
    assert_eq!(job.status().state, ImageState::Ready);
    assert!(!job.host.called("install"));
    assert!(job.host.calls().contains(&format!("password {password}")));
}

#[tokio::test]
async fn a_lost_password_says_so() {
    let rig = Rig::new();
    let job = rig.job(Fake::default());
    fail(&job, "send_xcode", "stop");
    job.build(request(Kind::Xcode)).unwrap();
    finish(&job).await;
    rig.vault.delete(PASSWORD_ITEM);
    job.resume().unwrap();
    finish(&job).await;
    assert!(job.status().error.unwrap().contains("Cancel setup and start again"));
}

#[tokio::test]
async fn only_one_build_at_a_time() {
    let rig = Rig::new();
    let job = rig.job(Fake::default());
    job.build(request(Kind::Xcode)).unwrap();
    assert!(job.build(request(Kind::Xcode)).is_err());
    assert!(job.resume().is_err());
    finish(&job).await;
}

#[test]
fn resume_with_nothing_to_resume_is_refused() {
    let rig = Rig::new();
    let job = rig.job(Fake::default());
    assert!(job.resume().is_err());
}

#[test]
fn swap_replaces_the_image_and_survives_a_crash_at_each_step() {
    let dir = tempfile::tempdir().unwrap();
    let (bundle, default) = (dir.path().join("new"), dir.path().join("default"));
    let old = dir.path().join("default.old");
    let put = |p: &Path, text: &str| {
        std::fs::create_dir_all(p).unwrap();
        std::fs::write(p.join("disk.img"), text).unwrap();
    };
    let disk = || std::fs::read_to_string(default.join("disk.img")).unwrap();

    put(&bundle, "new");
    swap_bundle(&bundle, &default).unwrap();
    assert_eq!(disk(), "new", "no old image");

    put(&bundle, "newer");
    swap_bundle(&bundle, &default).unwrap();
    assert_eq!(disk(), "newer");
    assert!(!old.exists() && !bundle.exists());

    // Crashed after the first rename.
    std::fs::rename(&default, &old).unwrap();
    put(&bundle, "third");
    swap_bundle(&bundle, &default).unwrap();
    assert_eq!(disk(), "third");
    assert!(!old.exists());

    // Crashed after the second rename: a resumed Finish only tidies up.
    put(&old, "stale");
    swap_bundle(&bundle, &default).unwrap();
    assert_eq!(disk(), "third");
    assert!(!old.exists());
}

#[test]
fn the_build_file_survives_a_round_trip_in_camel_case() {
    let b = BuildFile {
        kind: Kind::MacosOnly,
        runner_id: Some("r".into()),
        priority: Priority::DoNotDisturb,
        done: vec![Stage::Check],
    };
    let v = serde_json::to_value(&b).unwrap();
    assert_eq!(
        v,
        serde_json::json!({ "kind": "macosOnly", "runnerId": "r", "priority": "doNotDisturb", "done": ["check"] })
    );
}

#[test]
fn the_view_is_camel_case() {
    let v = ImageView { state: ImageState::Waiting, stage: Some(Stage::Lockdown), ..Default::default() };
    let v = serde_json::to_value(&v).unwrap();
    assert_eq!(v["state"], "waiting");
    assert_eq!(v["stage"], "lockdown");
    assert_eq!(v["doneStages"], serde_json::json!([]));
    assert_eq!(v["canResume"], false);
}

#[test]
fn shell_quoting_survives_a_single_quote() {
    assert_eq!(quoted("it's"), r"'it'\''s'");
}

#[test]
fn the_proof_is_found_on_whichever_volume_holds_it() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("dmg.system")).unwrap();
    assert!(proof_on(dir.path()).image.is_none());
    let data = dir.path().join("dmg.data");
    std::fs::create_dir_all(data.join("private/var/log")).unwrap();
    std::fs::write(data.join(PROVISION_LOG), "provision: locking down\n").unwrap();
    let p = proof_on(dir.path());
    assert!(p.image.is_none(), "a log with no proof file is not a proof");
    assert!(p.log.contains("locking down"));
    std::fs::create_dir_all(data.join("usr/local/share")).unwrap();
    std::fs::write(data.join(PROOF_FILE), PROOF).unwrap();
    assert_eq!(proof_on(dir.path()).image.as_deref(), Some(PROOF));
}

/// A real disk, with `NEKKO_TEST_DISK` naming a stopped bundle that has a proof file.
#[tokio::test]
#[ignore]
async fn a_real_disk_gives_up_its_proof_and_detaches() {
    let bundle = PathBuf::from(std::env::var("NEKKO_TEST_DISK").unwrap());
    let dir = tempfile::tempdir().unwrap();
    let host = fake_helper_host(dir.path(), "exit 0");
    std::fs::create_dir_all(host.dir()).unwrap();
    let proof = host.read_proof(&bundle).await.unwrap();
    serde_json::from_str::<ImageInfo>(&proof.image.unwrap()).unwrap();
    assert!(proof.log.contains("provision-rc=0"));
    let left: Vec<_> = std::fs::read_dir(host.dir().join("mnt")).unwrap().flatten().collect();
    assert!(left.iter().all(|f| std::fs::read_dir(f.path()).unwrap().next().is_none()), "{left:?}");
}

/// A `RealBuildHost` over a fake `nekko-vm` with `body` as its script, and no network.
fn fake_helper_host(dir: &Path, body: &str) -> RealBuildHost {
    use std::os::unix::fs::PermissionsExt;
    let helper = dir.join("nekko-vm");
    std::fs::write(&helper, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o700)).unwrap();
    let vm = HelperVm::new(helper, Arc::default(), Arc::default());
    RealBuildHost::new(Ok(vm), dir.join("images"), Arc::default(), Weak::new())
}

#[tokio::test]
async fn a_helper_built_without_the_macos_27_sdk_is_refused_before_any_download() {
    let dir = tempfile::tempdir().unwrap();
    let old = fake_helper_host(dir.path(), "echo '{\"firstBoot\":false}'");
    assert_eq!(old.check_helper().await.unwrap_err(), NO_FIRST_BOOT);
    assert!(!NO_FIRST_BOOT.contains("Update this Mac"), "the Mac is not at fault");
    let new = fake_helper_host(dir.path(), "echo '{\"firstBoot\":true}'");
    new.check_helper().await.unwrap();
    // An older helper that has no such command at all.
    let older = fake_helper_host(dir.path(), "echo '{\"ok\":false,\"error\":\"usage\"}'; exit 1");
    assert_eq!(older.check_helper().await.unwrap_err(), NO_FIRST_BOOT);
}

#[tokio::test]
async fn the_first_boot_password_never_outlives_a_failed_start() {
    let dir = tempfile::tempdir().unwrap();
    let host = fake_helper_host(dir.path(), "exit 1");
    std::fs::create_dir_all(host.dir()).unwrap();
    // No physical interface: the start fails before the helper could read the file.
    let password = dir.path().display().to_string();
    assert!(host.first_boot(&dir.path().join("bundle"), &password).await.is_err());
    assert!(!host.dir().join("first-boot-password").exists());
}

#[test]
fn a_symlinked_xcode_resolves_to_the_real_app() {
    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("Xcode-27.2.app");
    std::fs::create_dir_all(real.join("Contents/Developer")).unwrap();
    let link = dir.path().join("Xcode.app");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let dev = format!("{}/Contents/Developer", link.display());
    let found = real_app(&dev).unwrap();
    assert_eq!(found.file_name().unwrap(), "Xcode-27.2.app", "tar would send the link itself");
    assert_eq!(real_app(&format!("{}/Nope.app/Contents/Developer", dir.path().display())), None);
    assert_eq!(real_app("/Library/Developer/CommandLineTools"), None);
}

#[test]
fn the_lockdown_wrapper_is_a_real_daemon_and_stops_the_guest() {
    let c = lockdown_command();
    assert!(c.contains("launchctl bootstrap system"));
    assert!(!c.contains("launchctl submit"), "submit silently does nothing");
    assert!(c.contains("provision.sh") && c.contains("shutdown -h now"));
    assert!(c.contains("/var/log/nekko-provision.log"));
}

#[test]
fn a_test_boot_passes_only_if_the_runner_ran() {
    let ran = "starting the GitHub Actions runner\nrunner exited with 0\nshutting down\n";
    assert_eq!(test_boot_verdict(Some(&Stopped::Guest), ran), Ok(()));
    // A guest also powers off when it cannot read its seed.
    let bad_seed = "unexpected seed contents\nshutting down\n";
    assert!(test_boot_verdict(Some(&Stopped::Guest), bad_seed).unwrap_err().contains("does not show the runner"));
    assert!(test_boot_verdict(Some(&Stopped::Guest), "").unwrap_err().contains("does not show the runner"));
    assert!(test_boot_verdict(Some(&Stopped::Signal), ran).unwrap_err().contains("did not end cleanly"));
    assert!(test_boot_verdict(None, ran).unwrap_err().contains("did not power off"));
}

#[test]
fn the_boot_script_logs_what_the_test_boot_looks_for() {
    assert!(include_str!("../../../../scripts/runner-image/nekko-runner-boot.sh").contains(RUNNER_RAN));
}

/// The real disk path, against a copy of a built image (`cp -c` costs nothing on APFS):
/// `NEKKO_TEST_BUNDLE=<folder holding disk.img> cargo test -p nekkod --bin nekkod real_disk -- --ignored`.
#[cfg(target_os = "macos")]
#[tokio::test]
#[ignore = "needs a copy of a real runner image in NEKKO_TEST_BUNDLE"]
async fn real_disk_takes_the_new_scripts_and_keeps_its_seal() {
    let bundle = PathBuf::from(std::env::var("NEKKO_TEST_BUNDLE").unwrap());
    let images = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(images.path().join("default.new")).unwrap();
    let host = RealBuildHost::new(Err("no helper".into()), images.path().to_path_buf(), Arc::default(), Weak::new());
    let probe = b"#!/bin/bash\n# written by real_disk_takes_the_new_scripts_and_keeps_its_seal\n";
    let at = SCRIPTS[0].1;
    host.with_data_volume(&bundle, |root| overwrite_in_place(&root.join(at), probe)).await.unwrap().unwrap();
    // Read back through a read-only mount, as the test boot does.
    let back = host.with_disk(&bundle, |m| read_on(m, at)).await.unwrap();
    assert_eq!(back.as_deref(), Some(std::str::from_utf8(probe).unwrap()));
}
