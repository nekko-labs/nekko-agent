//! The image builder (decision 0038): one job that turns Apple's restore image,
//! this Mac's Xcode and `scripts/runner-image` into `runners/images/default`.
//! It works in `images/default.new` and swaps the result in only after a test
//! boot passes, so a build never harms a working image. `build.json` there says
//! where it got to, so a quit or a failure resumes. Failures in the Xcode and
//! Lockdown stages go back to the checkpoint taken after first boot.
//!
//! [`BuildHost`] is every guest and host action, so the state machine is tested
//! with a fake; [`RealBuildHost`] does them with `nekko-vm`, `ssh` and `tar`.

use super::Runners;
use super::signals::MacState;
use super::updates::{os_major, write_atomic};
use super::vm::{BuildSpec, GITHUB_SEED, HelperVm, RunHandle, RunSpec, Stopped, Vm, output_within, xcode_source};
use nekko_cloud::vault::Vault;
use nekko_engine::download::{Downloads, HttpFetch, Request};
use nekko_runner::{MAX_MACOS_VMS, Pressure, Priority, RunnerSettings, SECURITY_GRACE_DAYS, Thermal};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::ffi::OsString;
use std::fs::File;
use std::future::Future;
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::task::JoinHandle;
use tokio::time::timeout;

pub const CHANNELS: &[&str] = &["runner:imageStatus", "runner:imageBuild", "runner:imageResume", "runner:imageCancel"];
/// Pushed with [`ImageView`] whenever it changes.
pub const EVENT: &str = "runner:imageChanged";

/// The vault item holding the build admin's password: useless after lockdown,
/// and deleted at Finish and Cancel.
const PASSWORD_ITEM: &str = "runner-build";
const GUEST_USER: &str = "nekko-build";
const DISK_GB: &str = "140";
/// The restore image, the 52 GB VM and the 25 GB floor, with a margin.
const NEEDS_GB: f64 = 110.0;
const MEMORY_MB: u32 = 8192;
const IPSW: &str = "restore.ipsw";
const PROOF_FILE: &str = "usr/local/share/nekko-runner-image.json";
const PROVISION_LOG: &str = "private/var/log/nekko-provision.log";
const UPDATE_MACOS: &str = "Update this Mac to macOS 27 to set it up here.";
const NO_XCODE: &str = "No Xcode on this Mac. Install Xcode, or choose macOS only.";
const NO_PASSWORD: &str = "This build's password is gone, so its VM cannot be reached. Cancel setup and start again.";
// The installer at a fixed commit, as `provision.sh` pins the runner.
const HOMEBREW_COMMIT: &str = "8c82c081753d4263da0cfe615ef8d9433425f22b";
const HOMEBREW_SHA256: &str = "5f333bbe53bc490e51e7ccb1df8779b3dd6ee73a1a7379efda216edb08ccb148";

const fn minutes(n: u64) -> Duration {
    Duration::from_secs(n * 60)
}
const INSTALL_LIMIT: Duration = minutes(30);
const SSH_UP_LIMIT: Duration = minutes(5);
const SHUTDOWN_LIMIT: Duration = minutes(3);
const XCODE_COPY_LIMIT: Duration = minutes(45);
const LOCKDOWN_LIMIT: Duration = minutes(15);
const TEST_BOOT_LIMIT: Duration = minutes(10);
/// No bytes for this long is a stalled download, which keeps its `.part`.
const DOWNLOAD_STALL_LIMIT: Duration = minutes(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    Check,
    Download,
    Install,
    Xcode,
    Lockdown,
    Test,
    Finish,
}

const STAGES: [Stage; 7] =
    [Stage::Check, Stage::Download, Stage::Install, Stage::Xcode, Stage::Lockdown, Stage::Test, Stage::Finish];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Xcode,
    MacosOnly,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ImageState {
    #[default]
    None,
    Ready,
    Building,
    Waiting,
    Failed,
}

/// What the image holds: `provision.sh`'s proof file, kept as `image.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInfo {
    pub macos: String,
    pub xcode: Option<String>,
    pub actions_runner: String,
    pub built: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageView {
    pub state: ImageState,
    pub stage: Option<Stage>,
    pub done_stages: Vec<Stage>,
    pub detail: String,
    /// (received, total) during Download.
    pub bytes: Option<(u64, u64)>,
    /// 0 to 1 during Install.
    pub fraction: Option<f64>,
    pub error: Option<String>,
    /// The end of the build log, for a failure.
    pub log: Option<String>,
    pub info: Option<ImageInfo>,
    pub can_resume: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildRequest {
    pub kind: Kind,
    /// The runner to turn on at Finish.
    #[serde(default)]
    pub runner_id: Option<String>,
    pub priority: Priority,
}

/// `build.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuildFile {
    kind: Kind,
    runner_id: Option<String>,
    priority: Priority,
    done: Vec<Stage>,
}

impl BuildFile {
    /// Lockdown runs once per image, so an unfinished one means the bundle cannot
    /// be reused: the Xcode stage starts over from the checkpoint.
    fn settled(mut self) -> BuildFile {
        if !self.done.contains(&Stage::Lockdown) {
            self.done.retain(|s| *s != Stage::Xcode);
        }
        self
    }

    fn next(&self) -> Option<Stage> {
        STAGES.into_iter().find(|s| !self.done.contains(s))
    }
}

/// The Mac right now, for the gates between stages.
#[derive(Debug, Clone, Copy, Default)]
pub struct Readings {
    pub vms: u8,
    pub memory_critical: bool,
    pub hot: bool,
    pub free_gb: f64,
    pub floor_gb: f64,
    pub on_battery: bool,
}

/// Why the next stage cannot start. The idle and priority modes do not apply:
/// the owner started this. Battery matters only from the first VM on.
fn waiting_reason(r: &Readings, stage: Stage) -> Option<String> {
    if r.vms >= MAX_MACOS_VMS {
        Some("Waiting for a free VM slot".into())
    } else if r.memory_critical {
        Some("Waiting for memory to free up".into())
    } else if r.hot {
        Some("Waiting for this Mac to cool down".into())
    } else if r.free_gb < r.floor_gb {
        Some(format!("Waiting for disk space: {:.0} GB free, {:.0} GB needed", r.free_gb, r.floor_gb))
    } else if stage >= Stage::Install && r.on_battery {
        Some("Waiting for power: plug this Mac in".into())
    } else {
        None
    }
}

fn no_room(free_gb: f64) -> String {
    format!("This Mac has {free_gb:.0} GB free. Free up {:.0} GB, then try again.", (NEEDS_GB - free_gb).ceil())
}

pub enum Progress {
    Bytes(u64, u64),
    Fraction(f64),
}

pub type Report<'a> = dyn Fn(Progress) + Send + Sync + 'a;

/// One command in the guest, with its limit: a hidden dialog once stalled a
/// build for four hours, so nothing here waits without one.
#[derive(Debug, Clone)]
pub struct Step {
    pub label: &'static str,
    pub command: String,
    pub root: bool,
    pub limit: Duration,
}

/// What the Xcode stage runs in the guest, after any Xcode copy.
fn xcode_steps(kind: Kind) -> Vec<Step> {
    let step = |label, command: &str, root, limit| Step { label, command: command.to_owned(), root, limit };
    let mut steps = Vec::new();
    if kind == Kind::Xcode {
        let as_user = format!("launchctl asuser \"$(id -u {GUEST_USER})\" sudo -u {GUEST_USER} -H");
        steps.extend([
            step(
                "Selecting Xcode",
                "chown -R root:wheel /Applications/Xcode.app && xcode-select -s /Applications/Xcode.app",
                true,
                minutes(10),
            ),
            step("Accepting the Xcode license", "xcodebuild -license accept", true, minutes(3)),
            step("Running Xcode's first launch", "xcodebuild -runFirstLaunch", true, minutes(20)),
            step(
                "Downloading the iOS simulator",
                &format!("{as_user} xcodebuild -downloadPlatform iOS"),
                true,
                minutes(60),
            ),
        ]);
    }
    let url = format!("https://raw.githubusercontent.com/Homebrew/install/{HOMEBREW_COMMIT}/install.sh");
    steps.extend([
        step(
            "Allowing the Homebrew installer",
            &format!(
                "printf '{GUEST_USER} ALL=(ALL) NOPASSWD: ALL\\n' > /etc/sudoers.d/build && chmod 440 /etc/sudoers.d/build"
            ),
            true,
            minutes(1),
        ),
        step(
            "Installing Homebrew",
            &format!(
                "curl -fsSL -o /tmp/brew-install.sh {url} && echo '{HOMEBREW_SHA256}  /tmp/brew-install.sh' | shasum -a 256 -c && NONINTERACTIVE=1 /bin/bash /tmp/brew-install.sh"
            ),
            false,
            minutes(20),
        ),
        step("Removing the Homebrew allowance", "rm -f /etc/sudoers.d/build", true, minutes(1)),
    ]);
    steps
}

/// Runs `provision.sh` as a one-off LaunchDaemon, because it turns SSH off
/// partway through. `launchctl submit` silently does nothing; a real daemon works.
fn lockdown_command() -> String {
    r#"cat > /tmp/prov-wrap.sh <<'EOS'
#!/bin/bash
exec > /var/log/nekko-provision.log 2>&1
bash /tmp/runner-image/provision.sh
echo "provision-rc=$?"
shutdown -h now
sleep 600
EOS
cat > /tmp/prov.plist <<'EOS'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>dev.nekkolabs.provision</string><key>ProgramArguments</key><array><string>/bin/bash</string><string>/tmp/prov-wrap.sh</string></array><key>RunAtLoad</key><true/></dict></plist>
EOS
chown root:wheel /tmp/prov.plist && chmod 644 /tmp/prov.plist && launchctl bootstrap system /tmp/prov.plist"#
        .to_owned()
}

/// What the guest left on its disk. No `image` means `provision.sh` did not
/// reach its end, however cleanly the guest stopped.
#[derive(Debug, Default)]
pub struct Proof {
    pub image: Option<String>,
    pub log: String,
}

/// Every guest and host action of a build.
pub trait BuildHost: Send + Sync + 'static {
    fn preflight(&self, kind: Kind) -> impl Future<Output = Result<(), String>> + Send;
    fn readings(&self) -> impl Future<Output = Readings> + Send;
    /// Apple's URL for the newest restore image this Mac supports.
    fn restore_image(&self) -> impl Future<Output = Result<String, String>> + Send;
    fn download(&self, url: &str, to: &Path, report: &Report<'_>) -> impl Future<Output = Result<(), String>> + Send;
    fn install(
        &self,
        ipsw: &Path,
        bundle: &Path,
        report: &Report<'_>,
    ) -> impl Future<Output = Result<(), String>> + Send;
    /// Boots with first-boot options until SSH answers, then shuts the guest down.
    fn first_boot(&self, bundle: &Path, password: &str) -> impl Future<Output = Result<(), String>> + Send;
    /// Boots until SSH answers.
    fn boot(&self, bundle: &Path, password: &str) -> impl Future<Output = Result<(), String>> + Send;
    fn guest(&self, password: &str, step: &Step) -> impl Future<Output = Result<(), String>> + Send;
    fn send_xcode(&self, password: &str) -> impl Future<Output = Result<(), String>> + Send;
    fn shutdown(&self, password: &str) -> impl Future<Output = Result<(), String>> + Send;
    /// Kills any VM still up.
    fn halt(&self) -> impl Future<Output = ()> + Send;
    /// Starts `provision.sh` and waits for the guest to stop.
    fn lockdown(&self, password: &str) -> impl Future<Output = Result<(), String>> + Send;
    fn read_proof(&self, bundle: &Path) -> impl Future<Output = Result<Proof, String>> + Send;
    /// A clone must boot, reject a bad seed and power itself off.
    fn test_boot(&self, bundle: &Path) -> impl Future<Output = Result<(), String>> + Send;
    fn clone_bundle(&self, from: &Path, to: &Path) -> impl Future<Output = Result<(), String>> + Send;
    fn swap(&self, bundle: &Path, default: &Path) -> impl Future<Output = Result<(), String>> + Send;
    fn enable_runner(&self, id: &str, priority: Priority) -> impl Future<Output = Result<(), String>> + Send;
}

/// Lets `default` be replaced by `bundle`. Safe to run again after a crash at
/// any point. Running job clones are unaffected: they share no file with it.
fn swap_bundle(bundle: &Path, default: &Path) -> std::io::Result<()> {
    let old = default.with_extension("old");
    if bundle.exists() {
        if default.exists() {
            remove_any_sync(&old)?;
            std::fs::rename(default, &old)?;
        }
        std::fs::rename(bundle, default)?;
    }
    remove_any_sync(&old)
}

fn remove_any_sync(path: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Off the runtime's threads: a VM bundle holds gigabytes of extents.
async fn remove_any(path: &Path) -> Result<(), String> {
    let p = path.to_path_buf();
    let done = tokio::task::spawn_blocking(move || remove_any_sync(&p)).await;
    done.map_err(|e| e.to_string())?.map_err(|e| format!("Cannot delete {}: {e}", path.display()))
}

/// Clears the keep-awake wish however the job ends, a cancel included.
struct Hold(Arc<AtomicBool>);

impl Drop for Hold {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

pub struct ImageJob<H: BuildHost> {
    images: PathBuf,
    host: H,
    vault: Arc<dyn Vault>,
    /// Read by the supervisor to keep the Mac awake.
    building: Arc<AtomicBool>,
    publish: Box<dyn Fn(&ImageView) + Send + Sync>,
    view: Mutex<ImageView>,
    task: Mutex<Option<JoinHandle<()>>>,
    /// How often a waiting job looks at the gates again.
    poll: Duration,
}

impl<H: BuildHost> ImageJob<H> {
    pub fn new(
        images: PathBuf,
        host: H,
        vault: Arc<dyn Vault>,
        building: Arc<AtomicBool>,
        publish: Box<dyn Fn(&ImageView) + Send + Sync>,
    ) -> Self {
        let job = ImageJob {
            images,
            host,
            vault,
            building,
            publish,
            view: Mutex::default(),
            task: Mutex::default(),
            poll: Duration::from_secs(5),
        };
        if let Ok(mut v) = job.view.lock() {
            *v = job.at_rest();
        }
        job
    }

    fn dir(&self) -> PathBuf {
        self.images.join("default.new")
    }

    fn read_build(&self) -> Option<BuildFile> {
        let raw = std::fs::read(self.dir().join("build.json")).ok()?;
        serde_json::from_slice::<BuildFile>(&raw).ok().map(BuildFile::settled)
    }

    fn save(&self, b: &BuildFile) -> Result<(), String> {
        let raw = serde_json::to_vec(b).map_err(|e| e.to_string())?;
        write_atomic(&self.dir().join("build.json"), &raw).map_err(|e| format!("Cannot save the build's progress: {e}"))
    }

    /// The view with no job running: the image there is, and any build to resume.
    fn at_rest(&self) -> ImageView {
        let default = self.images.join("default");
        let info = std::fs::read(default.join("image.json")).ok().and_then(|r| serde_json::from_slice(&r).ok());
        let build = self.read_build();
        ImageView {
            state: if default.is_dir() { ImageState::Ready } else { ImageState::None },
            stage: build.as_ref().and_then(BuildFile::next),
            done_stages: build.as_ref().map(|b| b.done.clone()).unwrap_or_default(),
            info,
            can_resume: build.is_some(),
            ..Default::default()
        }
    }

    pub fn status(&self) -> ImageView {
        self.view.lock().map(|v| v.clone()).unwrap_or_default()
    }

    fn update(&self, f: impl FnOnce(&mut ImageView)) {
        let Ok(mut v) = self.view.lock() else { return };
        f(&mut v);
        (self.publish)(&v);
    }

    pub fn build(self: &Arc<Self>, req: BuildRequest) -> Result<ImageView, String> {
        self.begin(Some(BuildFile { kind: req.kind, runner_id: req.runner_id, priority: req.priority, done: vec![] }))
    }

    pub fn resume(self: &Arc<Self>) -> Result<ImageView, String> {
        self.begin(None)
    }

    fn begin(self: &Arc<Self>, fresh: Option<BuildFile>) -> Result<ImageView, String> {
        let mut task = self.task.lock().map_err(|_| "The image job is unavailable.")?;
        if task.as_ref().is_some_and(|t| !t.is_finished()) {
            return Err("This Mac is already being set up.".into());
        }
        let build = match fresh {
            Some(b) => {
                // A finished restore image from an earlier try stays, and saves the download.
                std::fs::DirBuilder::new()
                    .recursive(true)
                    .mode(0o700)
                    .create(self.dir())
                    .map_err(|e| format!("Cannot make the build folder: {e}"))?;
                self.save(&b)?;
                b
            }
            None => self.read_build().ok_or("There is no setup to resume.")?,
        };
        self.building.store(true, Ordering::SeqCst);
        let hold = Hold(self.building.clone());
        self.update(|v| {
            *v = ImageView {
                state: ImageState::Building,
                stage: build.next(),
                done_stages: build.done.clone(),
                info: v.info.clone(),
                ..Default::default()
            }
        });
        *task = Some(tokio::spawn(self.clone().run(build, hold)));
        Ok(self.status())
    }

    /// Stops any job and removes what it made. The image in use is not touched.
    pub async fn cancel(&self) -> ImageView {
        let task = self.task.lock().ok().and_then(|mut t| t.take());
        if let Some(t) = task {
            t.abort();
            let _ = t.await;
        }
        self.host.halt().await;
        if let Err(e) = remove_any(&self.dir()).await {
            eprintln!("runner image: {e}");
        }
        self.vault.delete(PASSWORD_ITEM);
        let rest = self.at_rest();
        self.update(|v| *v = rest);
        self.status()
    }

    async fn run(self: Arc<Self>, mut build: BuildFile, _hold: Hold) {
        match self.stages(&mut build).await {
            Ok(()) => {
                let rest = self.at_rest();
                self.update(|v| *v = rest);
            }
            Err((stage, raw)) => {
                self.log(&raw);
                let r = self.host.readings().await;
                let error = if r.free_gb < r.floor_gb { no_room(r.free_gb) } else { raw };
                let log = self.log_tail();
                self.update(|v| {
                    *v = ImageView {
                        state: ImageState::Failed,
                        stage: Some(stage),
                        done_stages: build.done.clone(),
                        error: Some(error),
                        log,
                        info: v.info.clone(),
                        can_resume: true,
                        ..Default::default()
                    }
                });
            }
        }
    }

    async fn stages(&self, b: &mut BuildFile) -> Result<(), (Stage, String)> {
        *b = b.clone().settled();
        while let Some(stage) = b.next() {
            self.wait_for_host(stage).await;
            self.update(|v| {
                v.state = ImageState::Building;
                v.stage = Some(stage);
                v.done_stages = b.done.clone();
                v.detail = String::new();
                v.bytes = None;
                v.fraction = None;
            });
            let began = Instant::now();
            self.run_stage(stage, b).await.map_err(|e| (stage, e))?;
            eprintln!("runner image: {stage:?} took {} s", began.elapsed().as_secs());
            if stage == Stage::Finish {
                break;
            }
            b.done.push(stage);
            self.save(b).map_err(|e| (stage, e))?;
        }
        Ok(())
    }

    async fn wait_for_host(&self, stage: Stage) {
        loop {
            let r = self.host.readings().await;
            let Some(why) = waiting_reason(&r, stage) else { return };
            self.update(|v| {
                v.state = ImageState::Waiting;
                v.stage = Some(stage);
                v.detail = why;
            });
            tokio::time::sleep(self.poll).await;
        }
    }

    fn detail(&self, text: &str) {
        self.log(text);
        self.update(|v| v.detail = text.to_owned());
    }

    fn log(&self, text: &str) {
        let file = std::fs::OpenOptions::new().create(true).append(true).open(self.dir().join("build.log"));
        if let Ok(mut f) = file {
            let _ = writeln!(f, "{text}");
        }
    }

    fn log_tail(&self) -> Option<String> {
        const TAIL: u64 = 4000;
        let mut f = File::open(self.dir().join("build.log")).ok()?;
        let len = f.metadata().ok()?.len();
        f.seek(SeekFrom::Start(len.saturating_sub(TAIL))).ok()?;
        let mut raw = Vec::new();
        f.read_to_end(&mut raw).ok()?;
        Some(String::from_utf8_lossy(&raw).into_owned())
    }

    fn password(&self) -> Result<String, String> {
        self.vault.get(PASSWORD_ITEM).ok_or_else(|| NO_PASSWORD.to_owned())
    }

    async fn run_stage(&self, stage: Stage, b: &BuildFile) -> Result<(), String> {
        let dir = self.dir();
        let (ipsw, bundle, checkpoint) = (dir.join(IPSW), dir.join("bundle"), dir.join("checkpoint"));
        let report = |p: Progress| {
            self.update(|v| match p {
                Progress::Bytes(got, all) => v.bytes = Some((got, all)),
                Progress::Fraction(f) => v.fraction = Some(f),
            })
        };
        match stage {
            Stage::Check => self.host.preflight(b.kind).await,
            Stage::Download => {
                if ipsw.is_file() {
                    return Ok(());
                }
                let url = self.host.restore_image().await?;
                self.host.download(&url, &ipsw, &report).await
            }
            Stage::Install => {
                // Quit after the restore image went: the checkpoint is already whole.
                if checkpoint.is_dir() && !ipsw.exists() {
                    return Ok(());
                }
                remove_any(&bundle).await?;
                remove_any(&checkpoint).await?;
                let password = new_password()?;
                self.vault.set(PASSWORD_ITEM, &password)?;
                self.detail("Installing macOS");
                self.host.install(&ipsw, &bundle, &report).await?;
                self.detail("First boot");
                self.host.first_boot(&bundle, &password).await?;
                std::fs::rename(&bundle, &checkpoint).map_err(|e| format!("Cannot save the checkpoint: {e}"))?;
                remove_any(&ipsw).await
            }
            Stage::Xcode => {
                let password = self.password()?;
                remove_any(&bundle).await?;
                self.host.clone_bundle(&checkpoint, &bundle).await?;
                self.detail("Starting the VM");
                self.host.boot(&bundle, &password).await?;
                match self.add_tools(b.kind, &password).await {
                    Ok(()) => self.host.shutdown(&password).await,
                    Err(e) => {
                        self.host.halt().await;
                        Err(e)
                    }
                }
            }
            Stage::Lockdown => {
                let password = self.password()?;
                self.detail("Starting the VM");
                self.host.boot(&bundle, &password).await?;
                self.detail("Locking the VM down");
                if let Err(e) = self.host.lockdown(&password).await {
                    self.host.halt().await;
                    return Err(e);
                }
                let proof = self.host.read_proof(&bundle).await?;
                self.log(&proof.log);
                let image = proof.image.ok_or("The lockdown did not finish: the VM has no proof file.")?;
                serde_json::from_str::<ImageInfo>(&image).map_err(|e| format!("The proof file is not valid: {e}"))?;
                std::fs::write(dir.join("proof.json"), image).map_err(|e| format!("Cannot save the proof: {e}"))
            }
            Stage::Test => {
                self.detail("Booting a test clone");
                self.host.test_boot(&bundle).await
            }
            Stage::Finish => {
                let default = self.images.join("default");
                self.host.swap(&bundle, &default).await?;
                std::fs::copy(dir.join("proof.json"), default.join("image.json"))
                    .map_err(|e| format!("Cannot save image.json: {e}"))?;
                if let Some(id) = &b.runner_id {
                    self.host.enable_runner(id, b.priority).await?;
                }
                self.vault.delete(PASSWORD_ITEM);
                remove_any(&dir).await
            }
        }
    }

    async fn add_tools(&self, kind: Kind, password: &str) -> Result<(), String> {
        if kind == Kind::Xcode {
            self.detail("Copying Xcode");
            self.host.send_xcode(password).await?;
        }
        for step in xcode_steps(kind) {
            self.detail(step.label);
            self.host.guest(password, &step).await?;
        }
        Ok(())
    }
}

/// 24 random bytes in hex.
fn new_password() -> Result<String, String> {
    let mut raw = [0u8; 24];
    getrandom::fill(&mut raw).map_err(|e| format!("Cannot make a password: {e}"))?;
    Ok(raw.iter().map(|b| format!("{b:02x}")).collect())
}

/// `text` as one word for `/bin/sh`.
fn quoted(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

/// Reads the proof and the provision log from a disk's mounted volumes: the Data
/// volume holds both, under whichever `mountrandom` folder it landed.
fn proof_on(mounts: &Path) -> Proof {
    let mut proof = Proof::default();
    for root in std::fs::read_dir(mounts).into_iter().flatten().flatten().map(|e| e.path()) {
        if proof.image.is_none() {
            proof.image = std::fs::read(root.join(PROOF_FILE)).ok().map(|r| String::from_utf8_lossy(&r).into_owned());
        }
        if proof.log.is_empty() {
            let log = std::fs::read(root.join(PROVISION_LOG)).unwrap_or_default();
            proof.log = String::from_utf8_lossy(&log).into_owned();
        }
    }
    proof
}

/// The VM this build has up, and its forwarded SSH port.
struct Up {
    handle: RunHandle,
    port: u16,
}

pub struct RealBuildHost {
    pub vm: Result<HelperVm, String>,
    pub images: PathBuf,
    /// The Mac as the supervisor last read it.
    pub mac: Arc<Mutex<Option<MacState>>>,
    pub runners: Weak<Runners>,
    up: Mutex<Option<Up>>,
}

impl RealBuildHost {
    pub fn new(
        vm: Result<HelperVm, String>,
        images: PathBuf,
        mac: Arc<Mutex<Option<MacState>>>,
        runners: Weak<Runners>,
    ) -> Self {
        RealBuildHost { vm, images, mac, runners, up: Mutex::default() }
    }

    fn dir(&self) -> PathBuf {
        self.images.join("default.new")
    }

    fn vm(&self) -> Result<&HelperVm, String> {
        self.vm.as_ref().map_err(Clone::clone)
    }

    fn mac(&self) -> Option<MacState> {
        self.mac.lock().ok().and_then(|m| m.clone())
    }

    /// At most 8 GB, and 2 cores left free.
    fn cpus(&self) -> u8 {
        self.mac().map_or(4, |m| m.cores.saturating_sub(2).max(4))
    }

    /// `nekko-vm`'s folder, which holds `runner-image/` (stage-daemon.mjs).
    fn helper_dir(&self) -> Result<PathBuf, String> {
        let dir = self.vm()?.helper.parent().map(Path::to_path_buf);
        dir.ok_or_else(|| "The nekko-vm helper has no folder.".to_owned())
    }

    fn log_file(&self) -> Result<File, String> {
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.dir().join("build.log"))
            .map_err(|e| format!("Cannot open the build log: {e}"))
    }

    fn port(&self) -> Result<u16, String> {
        self.up.lock().ok().and_then(|u| u.as_ref().map(|u| u.port)).ok_or_else(|| "No VM is running.".to_owned())
    }

    /// `ssh` to the build admin. The password reaches it through `SSH_ASKPASS`
    /// and an environment variable set only on this child.
    fn ssh(&self, password: &str) -> Result<Command, String> {
        let port = self.port()?;
        let askpass = self.dir().join("askpass.sh");
        if !askpass.exists() {
            std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o700)
                .open(&askpass)
                .and_then(|mut f| f.write_all(b"#!/bin/sh\nprintf '%s\\n' \"$NEKKO_BUILD_PASSWORD\"\n"))
                .map_err(|e| format!("Cannot write the askpass script: {e}"))?;
        }
        let mut cmd = Command::new("/usr/bin/ssh");
        // -F: nothing from the owner's ssh config applies to a throwaway VM on loopback.
        cmd.args(["-F", "/dev/null", "-T", "-p", &port.to_string()])
            .args(["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null"])
            .args(["-o", "PubkeyAuthentication=no", "-o", "NumberOfPasswordPrompts=1"])
            .args(["-o", "ConnectTimeout=5", "-o", "ServerAliveInterval=30", "-o", "LogLevel=ERROR"])
            .arg(format!("{GUEST_USER}@127.0.0.1"))
            .env("SSH_ASKPASS", askpass)
            .env("SSH_ASKPASS_REQUIRE", "force")
            .env("NEKKO_BUILD_PASSWORD", password)
            .kill_on_drop(true);
        Ok(cmd)
    }

    /// `command` in the guest within `limit`, its output going to `output` (the
    /// log file, or nowhere). Root goes through `sudo -S`, which reads the
    /// password from stdin, so it is never on a command line.
    async fn remote(
        &self,
        password: &str,
        command: &str,
        root: bool,
        limit: Duration,
        output: Option<File>,
    ) -> Result<(), String> {
        let mut cmd = self.ssh(password)?;
        if root {
            cmd.arg(format!("sudo -S -p '' /bin/sh -c {}", quoted(command))).stdin(Stdio::piped());
        } else {
            cmd.arg(command).stdin(Stdio::null());
        }
        match output {
            Some(f) => {
                let err = f.try_clone().map_err(|e| e.to_string())?;
                cmd.stdout(f).stderr(err);
            }
            None => {
                cmd.stdout(Stdio::null()).stderr(Stdio::null());
            }
        }
        let mut child = cmd.spawn().map_err(|e| format!("Cannot run ssh: {e}"))?;
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(format!("{password}\n").as_bytes()).await;
        }
        match timeout(limit, child.wait()).await {
            Err(_) => Err(format!("did not finish within {} min", limit.as_secs().div_ceil(60))),
            Ok(Ok(s)) if s.success() => Ok(()),
            Ok(Ok(s)) => Err(format!("failed ({s})")),
            Ok(Err(e)) => Err(format!("cannot wait for ssh: {e}")),
        }
    }

    /// `tar <args>` on this Mac into `command` in the guest. Xcode's symlinks only
    /// survive this way: `virtio-fs` dropped all 11,204 of them.
    async fn send_tar(
        &self,
        password: &str,
        args: Vec<OsString>,
        command: &str,
        limit: Duration,
    ) -> Result<(), String> {
        let log = self.log_file()?;
        let copy = |f: &File| f.try_clone().map_err(|e| e.to_string());
        let mut tar = Command::new("/usr/bin/tar")
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(copy(&log)?)
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Cannot run tar: {e}"))?;
        let out: Stdio = tar.stdout.take().ok_or("tar has no output")?.try_into().map_err(|e| format!("tar: {e}"))?;
        let mut ssh = self
            .ssh(password)?
            .arg(command)
            .stdin(out)
            .stdout(copy(&log)?)
            .stderr(log)
            .spawn()
            .map_err(|e| format!("Cannot run ssh: {e}"))?;
        match timeout(limit, async { tokio::join!(tar.wait(), ssh.wait()) }).await {
            Err(_) => Err(format!("did not finish within {} min", limit.as_secs() / 60)),
            Ok((Ok(t), Ok(s))) if t.success() && s.success() => Ok(()),
            Ok((t, s)) => Err(format!("failed (tar: {t:?}, ssh: {s:?})")),
        }
    }

    /// Boots `bundle` with a forward to its SSH, then waits for SSH to answer.
    async fn start_vm(&self, bundle: &Path, password: &str, first_boot: bool) -> Result<(), String> {
        let vm = self.vm()?;
        let listener =
            std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| format!("Cannot open the SSH port: {e}"))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let mut boot = None;
        if first_boot {
            let file = self.dir().join("first-boot-password");
            std::fs::OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .mode(0o600)
                .open(&file)
                .and_then(|mut f| f.write_all(password.as_bytes()))
                .map_err(|e| format!("Cannot write the first-boot password: {e}"))?;
            boot = Some((GUEST_USER.to_owned(), file));
        }
        let spec = BuildSpec {
            bundle: bundle.to_path_buf(),
            cpus: self.cpus(),
            memory_mb: MEMORY_MB,
            first_boot: boot,
            ssh_port_listener: listener,
        };
        let handle = vm.start_build(spec).await?;
        if let Ok(mut up) = self.up.lock() {
            *up = Some(Up { handle, port });
        }
        let end = Instant::now() + SSH_UP_LIMIT;
        loop {
            if self.remote(password, "true", false, Duration::from_secs(20), None).await.is_ok() {
                return Ok(());
            }
            if Instant::now() > end {
                self.halt().await;
                return Err(format!("The VM did not answer within {} min.", SSH_UP_LIMIT.as_secs() / 60));
            }
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    }

    async fn wait_stop(&self, limit: Duration) -> Result<Stopped, String> {
        let up = self.up.lock().ok().and_then(|mut u| u.take());
        let Some(mut up) = up else { return Err("No VM is running.".into()) };
        match timeout(limit, &mut up.handle.done).await {
            Ok(r) => r.map_err(|_| "The VM helper went away.".to_owned()),
            Err(_) => {
                up.handle.kill();
                let _ = timeout(Duration::from_secs(10), &mut up.handle.done).await;
                Err(format!("The guest did not stop within {} min.", limit.as_secs() / 60))
            }
        }
    }
}

impl BuildHost for RealBuildHost {
    async fn preflight(&self, kind: Kind) -> Result<(), String> {
        self.vm()?;
        let version = super::signals::output("/usr/bin/sw_vers", &["-productVersion"], Duration::from_secs(5)).await;
        if version.as_deref().map_or(0, os_major) < 27 {
            return Err(UPDATE_MACOS.into());
        }
        if let Some(m) = self.mac() {
            if m.free_disk_gb < NEEDS_GB {
                return Err(no_room(m.free_disk_gb));
            }
            if m.security_update_overdue_days.is_some_and(|d| d > SECURITY_GRACE_DAYS) {
                return Err("Install this Mac's security update, then try again.".into());
            }
        }
        if !self.helper_dir()?.join("runner-image/provision.sh").is_file() {
            return Err("The VM setup scripts are not installed.".into());
        }
        if kind == Kind::Xcode {
            let dev = super::signals::output("/usr/bin/xcode-select", &["-p"], Duration::from_secs(5)).await;
            dev.as_deref().and_then(xcode_source).filter(|a| a.is_dir()).ok_or(NO_XCODE)?;
        }
        Ok(())
    }

    async fn readings(&self) -> Readings {
        let vms = match &self.vm {
            Ok(v) => v.count_vms().await.unwrap_or(0),
            Err(_) => 0,
        };
        let Some(m) = self.mac() else { return Readings { vms, ..Default::default() } };
        let host = m.host.as_ref();
        Readings {
            vms,
            memory_critical: host.is_some_and(|h| h.memory == Pressure::Critical),
            hot: host.is_some_and(|h| matches!(h.thermal, Thermal::Serious | Thermal::Critical)),
            free_gb: m.free_disk_gb,
            // shortcut: the default floor, not the runner's setting; read the record if anyone lowers it.
            floor_gb: f64::from(RunnerSettings::default().disk_floor_gb),
            on_battery: m.power.is_some_and(|p| p.on_battery),
        }
    }

    async fn restore_image(&self) -> Result<String, String> {
        let v = self.vm()?.call(&["restore-image".as_ref()], Duration::from_secs(60)).await?;
        match (v["url"].as_str(), v["error"].as_str()) {
            (Some(url), _) => Ok(url.to_owned()),
            (_, Some(e)) => Err(format!("Apple's restore image catalog: {e}")),
            _ => Err(format!("nekko-vm restore-image said: {v}")),
        }
    }

    async fn download(&self, url: &str, to: &Path, report: &Report<'_>) -> Result<(), String> {
        const ID: &str = "runner-restore-image";
        struct Dismiss(Downloads);
        impl Drop for Dismiss {
            fn drop(&mut self) {
                self.0.dismiss(ID);
            }
        }
        let (tx, mut rx) = tokio::sync::watch::channel(Value::Null);
        let queue = Downloads::new(
            Arc::new(HttpFetch(reqwest::Client::new())),
            Arc::new(nekko_js::now_ms_f64),
            move |mut jobs| drop(tx.send_replace(jobs.pop().unwrap_or(Value::Null))),
        );
        let _dismiss = Dismiss(queue.clone());
        queue.start(Request {
            id: ID.into(),
            kind: "runner-image".into(),
            label: "macOS restore image".into(),
            url: url.into(),
            dest: to.to_string_lossy().into_owned(),
            ..Default::default()
        });
        loop {
            match timeout(DOWNLOAD_STALL_LIMIT, rx.changed()).await {
                Ok(Ok(())) => {}
                Ok(Err(_)) => return Err("The download stopped.".into()),
                Err(_) => return Err("The download stalled. Try again to pick up where it left off.".into()),
            }
            let job = rx.borrow_and_update().clone();
            if let (Some(got), Some(all)) = (job["receivedBytes"].as_f64(), job["totalBytes"].as_f64()) {
                report(Progress::Bytes(got as u64, all as u64));
            }
            match job["state"].as_str() {
                Some("done") => return Ok(()),
                Some("failed" | "cancelled") => {
                    return Err(job["message"].as_str().unwrap_or("The download failed.").to_owned());
                }
                _ => {}
            }
        }
    }

    async fn install(&self, ipsw: &Path, bundle: &Path, report: &Report<'_>) -> Result<(), String> {
        let mut child = Command::new(&self.vm()?.helper)
            .arg("install")
            .arg("--ipsw")
            .arg(ipsw)
            .arg("--bundle")
            .arg(bundle)
            .args(["--disk-gb", DISK_GB])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(self.log_file()?)
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Cannot run nekko-vm: {e}"))?;
        let out = child.stdout.take().ok_or("nekko-vm has no output")?;
        let mut lines = BufReader::new(out).lines();
        let last = timeout(INSTALL_LIMIT, async {
            let mut last = Value::Null;
            while let Ok(Some(line)) = lines.next_line().await {
                let v: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
                match v["progress"].as_f64() {
                    Some(f) => report(Progress::Fraction(f)),
                    None => last = v,
                }
            }
            last
        })
        .await
        .map_err(|_| format!("Installing macOS did not finish within {} min.", INSTALL_LIMIT.as_secs() / 60))?;
        match last["error"].as_str() {
            _ if last["ok"] == true => Ok(()),
            Some(e) => Err(format!("Installing macOS failed: {e}")),
            None => Err("Installing macOS stopped with no result.".into()),
        }
    }

    async fn first_boot(&self, bundle: &Path, password: &str) -> Result<(), String> {
        self.start_vm(bundle, password, true).await?;
        self.shutdown(password).await
    }

    async fn boot(&self, bundle: &Path, password: &str) -> Result<(), String> {
        self.start_vm(bundle, password, false).await
    }

    async fn guest(&self, password: &str, step: &Step) -> Result<(), String> {
        let log = self.log_file()?;
        let done = self.remote(password, &step.command, step.root, step.limit, Some(log)).await;
        done.map_err(|e| format!("{}: {e}", step.label))
    }

    async fn send_xcode(&self, password: &str) -> Result<(), String> {
        let dev = super::signals::output("/usr/bin/xcode-select", &["-p"], Duration::from_secs(5)).await;
        let app = dev.as_deref().and_then(xcode_source).ok_or(NO_XCODE)?;
        let (Some(parent), Some(name)) = (app.parent(), app.file_name()) else { return Err(NO_XCODE.into()) };
        let mut args: Vec<OsString> = vec!["-C".into(), parent.into(), "--mac-metadata".into()];
        if let Some(rename) = super::vm::tar_rename_arg(&app) {
            args.extend(["-s".into(), rename.into()]);
        }
        args.extend(["-cf".into(), "-".into(), name.into()]);
        let sent = self.send_tar(password, args, "tar -C /Applications -xpf -", XCODE_COPY_LIMIT).await;
        sent.map_err(|e| format!("Copying Xcode: {e}"))
    }

    async fn shutdown(&self, password: &str) -> Result<(), String> {
        // ssh may fail as the guest goes down; what counts is that it stops.
        let _ = self.remote(password, "shutdown -h now", true, Duration::from_secs(30), Some(self.log_file()?)).await;
        match self.wait_stop(SHUTDOWN_LIMIT).await? {
            Stopped::Guest => Ok(()),
            other => Err(format!("The guest did not shut down cleanly: {other:?}")),
        }
    }

    async fn halt(&self) {
        let up = self.up.lock().ok().and_then(|mut u| u.take());
        if let Some(mut up) = up {
            up.handle.kill();
            let _ = timeout(Duration::from_secs(10), &mut up.handle.done).await;
        }
    }

    async fn lockdown(&self, password: &str) -> Result<(), String> {
        let args = vec!["-C".into(), self.helper_dir()?.into(), "-cf".into(), "-".into(), "runner-image".into()];
        let upload = "rm -rf /tmp/runner-image && tar -C /tmp -xf -";
        self.send_tar(password, args, upload, minutes(1)).await.map_err(|e| format!("Uploading the scripts: {e}"))?;
        self.remote(password, &lockdown_command(), true, minutes(1), Some(self.log_file()?))
            .await
            .map_err(|e| format!("Starting the lockdown: {e}"))?;
        match self.wait_stop(LOCKDOWN_LIMIT).await? {
            Stopped::Guest => Ok(()),
            other => Err(format!("The guest stopped during the lockdown: {other:?}")),
        }
    }

    async fn read_proof(&self, bundle: &Path) -> Result<Proof, String> {
        let mounts = self.dir().join("mnt");
        std::fs::create_dir_all(&mounts).map_err(|e| format!("Cannot make the mount folder: {e}"))?;
        let mut attach = Command::new("/usr/bin/hdiutil");
        attach
            .args(["attach", "-readonly", "-nobrowse", "-noverify", "-noautofsck", "-mountrandom"])
            .arg(&mounts)
            .args(["-imagekey", "diskimage-class=CRawDiskImage"])
            .arg(bundle.join("disk.img"));
        let out = output_within(attach, minutes(2), "hdiutil").await?;
        if !out.status.success() {
            return Err(format!("Cannot open the VM's disk: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let device = text.split_whitespace().next().ok_or("hdiutil named no device")?;
        let proof = proof_on(&mounts);
        for flags in [&[][..], &["-force"][..]] {
            let mut detach = Command::new("/usr/bin/hdiutil");
            detach.arg("detach").args(flags).arg(device);
            if output_within(detach, minutes(1), "hdiutil").await.is_ok_and(|o| o.status.success()) {
                break;
            }
        }
        Ok(proof)
    }

    async fn test_boot(&self, bundle: &Path) -> Result<(), String> {
        let vm = self.vm()?;
        let (clone, seed) = (self.dir().join("test"), self.dir().join("seed.iso"));
        remove_any(&clone).await?;
        remove_any(&seed).await?;
        vm.clone_bundle(bundle, &clone).await?;
        // The documented check: the runner rejects this and the guest powers off.
        vm.write_seed(&seed, GITHUB_SEED, "not-a-config").await?;
        let spec = RunSpec { bundle: clone.clone(), cpus: self.cpus(), memory_mb: MEMORY_MB, seed: seed.clone() };
        let mut handle = vm.start(spec).await?;
        let stopped = timeout(TEST_BOOT_LIMIT, &mut handle.done).await;
        if stopped.is_err() {
            handle.kill();
            let _ = timeout(Duration::from_secs(10), &mut handle.done).await;
        }
        remove_any(&clone).await?;
        remove_any(&seed).await?;
        match stopped {
            Ok(Ok(Stopped::Guest)) => Ok(()),
            Ok(other) => Err(format!("The test boot did not end cleanly: {other:?}")),
            Err(_) => Err(format!("The test boot did not power off within {} min.", TEST_BOOT_LIMIT.as_secs() / 60)),
        }
    }

    async fn clone_bundle(&self, from: &Path, to: &Path) -> Result<(), String> {
        self.vm()?.clone_bundle(from, to).await
    }

    async fn swap(&self, bundle: &Path, default: &Path) -> Result<(), String> {
        let (b, d) = (bundle.to_path_buf(), default.to_path_buf());
        let done = tokio::task::spawn_blocking(move || swap_bundle(&b, &d)).await;
        done.map_err(|e| e.to_string())?.map_err(|e| format!("Cannot swap the image in: {e}"))
    }

    async fn enable_runner(&self, id: &str, priority: Priority) -> Result<(), String> {
        let runners = self.runners.upgrade().ok_or("The runners are gone.")?;
        runners.enable_after_build(id, priority).await
    }
}

impl Runners {
    pub async fn image_route(&self, channel: &str, args: &[Value]) -> Result<Value, String> {
        let job = self.image.get().ok_or("Setting up this Mac is not available here.")?;
        let view = match channel {
            "runner:imageStatus" => job.status(),
            "runner:imageBuild" => {
                let req = args.first().cloned().unwrap_or(Value::Null);
                job.build(serde_json::from_value(req).map_err(|e| format!("That setup request is not valid: {e}"))?)?
            }
            "runner:imageResume" => job.resume()?,
            "runner:imageCancel" => job.cancel().await,
            _ => return Err(format!("unknown channel {channel}")),
        };
        Ok(json!(view))
    }
}

#[cfg(test)]
#[path = "image_tests.rs"]
mod tests;
