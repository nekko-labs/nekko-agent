//! Booted iOS simulators and Android emulators (`simulators:state`), what each
//! one costs in CPU, and the actions on one (shut down, open, a screenshot).
//!
//! A booted simulator is re-parented to CoreSimulatorService, so nothing ties
//! it back to the command that booted it; this reads it from the process
//! table instead. Each iOS device runs one `launchd_sim` whose argument holds
//! the device's folder (`.../CoreSimulator/Devices/<UDID>/data/...`); the
//! device's CPU is the sum over that process and everything under it. An
//! Android emulator is one `qemu-system-*` process carrying `-avd <name>`.
//!
//! One `ps` per sample (about 0.1 s for 2,500 processes). `simctl list` runs
//! only when an unknown device shows up, or once a minute while any is
//! booted, for the device's name and OS. Every probe is best-effort.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// One process as `ps -Ao pid=,ppid=,%cpu=,etime=,command=` prints it.
#[derive(Debug, Clone, PartialEq)]
pub struct PsRow {
    pub pid: u32,
    pub ppid: u32,
    pub cpu: f64,
    pub elapsed_secs: u64,
    pub command: String,
}

/// What a device is called and runs, from `simctl list devices -j`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct IosMeta {
    pub name: String,
    /// "iPhone 18 Pro", from the device type identifier.
    pub model: Option<String>,
    /// "iOS 27.0", from the runtime identifier.
    pub os: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Ios,
    Android,
}

/// A booted device.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    /// The UDID on iOS, the AVD name on Android.
    pub id: String,
    pub kind: Kind,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os: Option<String>,
    /// Percent of one core, summed over the device's processes (can pass 100).
    pub cpu_pct: f64,
    /// Seconds since it booted.
    pub up_secs: u64,
    pub processes: u32,
    /// Android: `emulator-<port>`, for adb.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub serial: Option<String>,
    /// The root process (launchd_sim or qemu).
    #[serde(skip)]
    pub pid: u32,
}

/// `[[dd-]hh:]mm:ss` in seconds.
pub fn parse_etime(s: &str) -> Option<u64> {
    let (days, rest) = match s.split_once('-') {
        Some((d, r)) => (d.parse::<u64>().ok()?, r),
        None => (0, s),
    };
    let parts: Vec<u64> = rest.split(':').map(|p| p.parse::<u64>().ok()).collect::<Option<_>>()?;
    let (h, m, sec) = match parts.as_slice() {
        [m, s] => (0, *m, *s),
        [h, m, s] => (*h, *m, *s),
        _ => return None,
    };
    Some(days * 86_400 + h * 3_600 + m * 60 + sec)
}

pub fn parse_ps(text: &str) -> Vec<PsRow> {
    text.lines()
        .filter_map(|line| {
            let mut it = line.split_whitespace();
            let pid = it.next()?.parse().ok()?;
            let ppid = it.next()?.parse().ok()?;
            let cpu = it.next()?.replace(',', ".").parse().ok()?;
            let elapsed_secs = parse_etime(it.next()?)?;
            let command = it.collect::<Vec<_>>().join(" ");
            (!command.is_empty()).then_some(PsRow { pid, ppid, cpu, elapsed_secs, command })
        })
        .collect()
}

fn is_udid(s: &str) -> bool {
    s.len() == 36
        && s.char_indices().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { c == '-' } else { c.is_ascii_hexdigit() })
}

/// The device a `launchd_sim` serves, from its bootstrap path.
fn launchd_sim_udid(command: &str) -> Option<String> {
    let first = command.split_whitespace().next()?;
    if !first.ends_with("launchd_sim") {
        return None;
    }
    let (_, after) = command.split_once("/Devices/")?;
    let udid = after.get(..36)?;
    is_udid(udid).then(|| udid.to_ascii_uppercase())
}

fn flag_value<'a>(command: &'a str, flag: &str) -> Option<&'a str> {
    let mut it = command.split_whitespace();
    while let Some(word) = it.next() {
        if word == flag {
            return it.next();
        }
    }
    None
}

/// The AVD and console port of an emulator's qemu process.
fn qemu_avd(command: &str) -> Option<(String, Option<u16>)> {
    let exe = command.split_whitespace().next()?;
    let base = exe.rsplit(['/', '\\']).next().unwrap_or(exe);
    if !base.starts_with("qemu-system-") {
        return None;
    }
    let avd = flag_value(command, "-avd").or_else(|| flag_value(command, "@"))?;
    let port = flag_value(command, "-port").and_then(|p| p.parse().ok());
    Some((avd.to_string(), port))
}

/// Each pid's children.
fn children(rows: &[PsRow]) -> HashMap<u32, Vec<usize>> {
    let mut kids: HashMap<u32, Vec<usize>> = HashMap::new();
    for (i, r) in rows.iter().enumerate() {
        kids.entry(r.ppid).or_default().push(i);
    }
    kids
}

/// CPU and process count of `root` and everything under it.
fn tree(rows: &[PsRow], kids: &HashMap<u32, Vec<usize>>, root: usize) -> (f64, u32) {
    let (mut cpu, mut n) = (0.0, 0);
    let mut seen = HashSet::new();
    let mut stack = vec![root];
    while let Some(i) = stack.pop() {
        if !seen.insert(rows[i].pid) {
            continue;
        }
        cpu += rows[i].cpu;
        n += 1;
        if let Some(k) = kids.get(&rows[i].pid) {
            stack.extend(k);
        }
    }
    (cpu, n)
}

/// The booted devices in a process table, iOS named from `meta` (the UDID
/// until it is known). Busiest first.
pub fn devices_from(rows: &[PsRow], meta: &HashMap<String, IosMeta>) -> Vec<Device> {
    let kids = children(rows);
    let mut out = Vec::new();
    for (i, r) in rows.iter().enumerate() {
        if let Some(udid) = launchd_sim_udid(&r.command) {
            let (cpu, processes) = tree(rows, &kids, i);
            let m = meta.get(&udid).cloned().unwrap_or_default();
            out.push(Device {
                name: if m.name.is_empty() { udid.clone() } else { m.name },
                id: udid,
                kind: Kind::Ios,
                model: m.model,
                os: m.os,
                cpu_pct: round1(cpu),
                up_secs: r.elapsed_secs,
                processes,
                serial: None,
                pid: r.pid,
            });
        } else if let Some((avd, port)) = qemu_avd(&r.command) {
            let (cpu, processes) = tree(rows, &kids, i);
            out.push(Device {
                id: avd.clone(),
                kind: Kind::Android,
                name: avd.replace('_', " "),
                model: None,
                os: Some("Android".into()),
                cpu_pct: round1(cpu),
                up_secs: r.elapsed_secs,
                processes,
                serial: Some(format!("emulator-{}", port.unwrap_or(5554))),
                pid: r.pid,
            });
        }
    }
    out.sort_by(|a, b| b.cpu_pct.total_cmp(&a.cpu_pct).then(a.name.cmp(&b.name)));
    out
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

/// `com.apple.CoreSimulator.SimRuntime.iOS-27-0` → `iOS 27.0`.
fn runtime_label(id: &str) -> Option<String> {
    let tail = id.rsplit('.').next()?;
    let (os, version) = tail.split_once('-')?;
    Some(format!("{os} {}", version.replace('-', ".")))
}

/// `com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro` → `iPhone 18 Pro`.
fn model_label(id: &str) -> Option<String> {
    let tail = id.rsplit('.').next()?;
    (!tail.is_empty()).then(|| tail.replace('-', " "))
}

/// UDID → name, model and OS from `simctl list devices -j`.
pub fn parse_simctl(json: &str) -> HashMap<String, IosMeta> {
    let mut out = HashMap::new();
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else { return out };
    let Some(runtimes) = v.get("devices").and_then(|d| d.as_object()) else { return out };
    for (runtime, list) in runtimes {
        for d in list.as_array().into_iter().flatten() {
            let Some(udid) = d.get("udid").and_then(|u| u.as_str()) else { continue };
            out.insert(
                udid.to_ascii_uppercase(),
                IosMeta {
                    name: d.get("name").and_then(|n| n.as_str()).unwrap_or_default().to_string(),
                    model: d.get("deviceTypeIdentifier").and_then(|t| t.as_str()).and_then(model_label),
                    os: runtime_label(runtime),
                },
            );
        }
    }
    out
}

/// Run a command hidden, with its stdout bytes on success.
async fn run(cmd: &Path, args: &[&str], timeout: Duration) -> Option<Vec<u8>> {
    let mut command = tokio::process::Command::new(cmd);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let child = command.spawn().ok()?;
    let out = tokio::time::timeout(timeout, child.wait_with_output()).await.ok()?.ok()?;
    out.status.success().then_some(out.stdout)
}

/// The process table, or nothing where `ps` does not exist (Windows: no
/// iOS simulators, and the Android emulator there is left to a later change).
pub async fn process_table() -> Vec<PsRow> {
    if cfg!(windows) {
        return Vec::new();
    }
    let out = run(Path::new("ps"), &["-Ao", "pid=,ppid=,%cpu=,etime=,command="], Duration::from_secs(5)).await;
    out.map(|b| parse_ps(&String::from_utf8_lossy(&b))).unwrap_or_default()
}

/// Every iOS device's name and OS, or nothing without Xcode.
pub async fn ios_meta() -> HashMap<String, IosMeta> {
    if !cfg!(target_os = "macos") {
        return HashMap::new();
    }
    let out = run(Path::new("xcrun"), &["simctl", "list", "devices", "-j"], Duration::from_secs(10)).await;
    out.map(|b| parse_simctl(&String::from_utf8_lossy(&b))).unwrap_or_default()
}

/// adb from the Android SDK, else the one on PATH.
fn adb() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let candidates = [
        std::env::var_os("ANDROID_HOME").map(PathBuf::from),
        std::env::var_os("ANDROID_SDK_ROOT").map(PathBuf::from),
        home.as_ref().map(|h| h.join("Library/Android/sdk")),
        home.as_ref().map(|h| h.join("Android/Sdk")),
    ];
    for sdk in candidates.into_iter().flatten() {
        let adb = sdk.join("platform-tools").join(if cfg!(windows) { "adb.exe" } else { "adb" });
        if adb.is_file() {
            return adb;
        }
    }
    PathBuf::from("adb")
}

/// Shut a device down. iOS through simctl; Android asks the emulator to
/// quit and, failing that, ends its process.
pub async fn shutdown(device: &Device) -> Result<(), String> {
    match device.kind {
        Kind::Ios => run(Path::new("xcrun"), &["simctl", "shutdown", &device.id], Duration::from_secs(60))
            .await
            .map(|_| ())
            .ok_or_else(|| format!("Could not shut down {}", device.name)),
        Kind::Android => {
            let serial = device.serial.clone().unwrap_or_default();
            if run(&adb(), &["-s", &serial, "emu", "kill"], Duration::from_secs(15)).await.is_some() {
                return Ok(());
            }
            #[cfg(unix)]
            {
                // SAFETY: kill(2) with a pid we read from the process table.
                if unsafe { libc::kill(device.pid as i32, libc::SIGTERM) } == 0 {
                    return Ok(());
                }
            }
            Err(format!("Could not shut down {}", device.name))
        }
    }
}

/// Boot an iOS device again (the Undo after a shutdown).
pub async fn boot(udid: &str) -> Result<(), String> {
    if !is_udid(udid) {
        return Err("Not a simulator".into());
    }
    run(Path::new("xcrun"), &["simctl", "boot", udid], Duration::from_secs(120))
        .await
        .map(|_| ())
        .ok_or_else(|| "Could not start the simulator again".into())
}

/// Bring Simulator.app forward on this device. iOS only: a headless Android
/// emulator has no window to show.
pub async fn open(device: &Device) -> Result<(), String> {
    if device.kind != Kind::Ios {
        return Err("Only an iOS simulator has a window to open".into());
    }
    run(Path::new("open"), &["-a", "Simulator", "--args", "-CurrentDeviceUDID", &device.id], Duration::from_secs(15))
        .await
        .map(|_| ())
        .ok_or_else(|| "Could not open Simulator".into())
}

/// A screenshot of the device's screen: (mime type, bytes).
pub async fn screenshot(device: &Device) -> Result<(&'static str, Vec<u8>), String> {
    match device.kind {
        Kind::Ios => {
            let file = std::env::temp_dir().join(format!("nekko-sim-{}-{}.jpg", device.id, std::process::id()));
            let path = file.to_string_lossy().into_owned();
            let ok = run(
                Path::new("xcrun"),
                &["simctl", "io", &device.id, "screenshot", "--type=jpeg", &path],
                Duration::from_secs(10),
            )
            .await;
            let bytes = tokio::fs::read(&file).await;
            let _ = tokio::fs::remove_file(&file).await;
            match (ok, bytes) {
                (Some(_), Ok(b)) if !b.is_empty() => Ok(("image/jpeg", b)),
                _ => Err("No screenshot".into()),
            }
        }
        Kind::Android => {
            let serial = device.serial.clone().unwrap_or_default();
            match run(&adb(), &["-s", &serial, "exec-out", "screencap", "-p"], Duration::from_secs(10)).await {
                Some(b) if b.starts_with(b"\x89PNG") => Ok(("image/png", b)),
                _ => Err("No screenshot".into()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PS: &str = "\
    1     0   0.0 11-18:11:22 /sbin/launchd
  500     1   0.3 09-01:45:52 launchd_sim /Users/me/Library/Developer/CoreSimulator/Devices/937C0078-69EC-4BEF-8C34-710DA0A4F98F/data/var/run/launchd_bootstrap.plist
  501   500  30.0 09-01:45:50 /Library/Developer/CoreSimulator/Volumes/iOS_23F77/.../backboardd
  502   501   4.6       12:01 /Users/me/Library/Developer/CoreSimulator/Devices/937C0078-69EC-4BEF-8C34-710DA0A4F98F/data/Containers/Bundle/Application/X/NekkoNative.app/NekkoNative
  600     1   0.6    23:56:23 launchd_sim /Users/me/Library/Developer/CoreSimulator/Devices/3c3a81d0-17cb-42d2-af34-1ba60842cb3b/data/var/run/launchd_bootstrap.plist
  700     1   6,2 01-00:37:21 /Users/me/Library/Android/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64-headless -avd agent2649_api36 -no-window -port 5594
  800     1  99.0       00:01 /bin/zsh -c xcrun simctl boot 937C0078-69EC-4BEF-8C34-710DA0A4F98F
";

    #[test]
    fn etime_parses_every_shape() {
        assert_eq!(parse_etime("00:01"), Some(1));
        assert_eq!(parse_etime("12:01"), Some(721));
        assert_eq!(parse_etime("23:56:23"), Some(86_183));
        assert_eq!(parse_etime("09-01:45:52"), Some(9 * 86_400 + 6_352));
        assert_eq!(parse_etime("x"), None);
    }

    #[test]
    fn devices_sum_their_process_trees() {
        let rows = parse_ps(PS);
        assert_eq!(rows.len(), 7);
        let mut meta = HashMap::new();
        meta.insert(
            "937C0078-69EC-4BEF-8C34-710DA0A4F98F".to_string(),
            IosMeta { name: "Nekko-1882".into(), model: Some("iPhone 18 Pro".into()), os: Some("iOS 26.5".into()) },
        );
        let d = devices_from(&rows, &meta);
        assert_eq!(d.len(), 3);
        assert_eq!(d[0].name, "Nekko-1882");
        assert_eq!(d[0].cpu_pct, 34.9);
        assert_eq!(d[0].processes, 3);
        assert_eq!(d[0].up_secs, 9 * 86_400 + 6_352);
        assert_eq!(d[1].kind, Kind::Android);
        assert_eq!(d[1].id, "agent2649_api36");
        assert_eq!(d[1].serial.as_deref(), Some("emulator-5594"));
        assert_eq!(d[1].cpu_pct, 6.2);
        // An unnamed device reads as its UDID, upper-cased.
        assert_eq!(d[2].name, "3C3A81D0-17CB-42D2-AF34-1BA60842CB3B");
        // A shell that names a UDID is not a device.
        assert!(d.iter().all(|x| x.pid != 800));
    }

    #[test]
    fn simctl_names_models_and_runtimes() {
        let json = r#"{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-27-0":[{"udid":"3c3a81d0-17cb-42d2-af34-1ba60842cb3b","name":"Nekko-Local-CI","deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro","state":"Booted"}]}}"#;
        let m = parse_simctl(json);
        let d = &m["3C3A81D0-17CB-42D2-AF34-1BA60842CB3B"];
        assert_eq!(d.name, "Nekko-Local-CI");
        assert_eq!(d.model.as_deref(), Some("iPhone 18 Pro"));
        assert_eq!(d.os.as_deref(), Some("iOS 27.0"));
        assert!(parse_simctl("not json").is_empty());
    }

    #[test]
    fn udids_are_checked() {
        assert!(is_udid("937C0078-69EC-4BEF-8C34-710DA0A4F98F"));
        assert!(!is_udid("937C0078-69EC-4BEF-8C34-710DA0A4F98"));
        assert!(!is_udid("937C0078x69EC-4BEF-8C34-710DA0A4F98F"));
    }
}
