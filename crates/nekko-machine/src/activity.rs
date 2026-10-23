//! Whether someone is using this computer, for automations that run in the
//! background (`activity:state`): how long since the last keyboard, mouse or
//! touch input, whether it runs on battery, and how hot it is. Best-effort and
//! unprivileged:
//!
//! - macOS: `CGEventSourceSecondsSinceLastEventType` (HID input, no
//!   Accessibility permission) and IOKit's power-source summary.
//! - Windows: `GetLastInputInfo` and `GetSystemPowerStatus`, for the session
//!   the daemon runs in (the desktop app's).
//! - Linux: logind's idle hint for the user's graphical session (`loginctl
//!   show-session auto`), which the desktop sets after its own idle delay;
//!   batteries from `/sys/class/power_supply`.
//!
//! A machine with no input to read (Docker, a server, a Linux login without a
//! graphical session) is headless: nobody sits at it, so it counts as idle.
//! Temperatures come from `temps.rs` and the GPU probe.

use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Past this many seconds without input, the user is away (the default; the
/// automations' settings may say otherwise).
pub const IDLE_AFTER_SECS: f64 = 300.0;
/// At or below this charge, the battery is low.
pub const LOW_BATTERY_PCT: f64 = 20.0;
/// Hot enough that background work should wait: CPU dies run hotter than GPUs
/// under normal load (Apple Silicon P-cores sit near 100 °C under a build).
pub const HOT_CPU_C: f64 = 100.0;
pub const HOT_GPU_C: f64 = 90.0;

/// How the machine runs on power.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Power {
    pub on_battery: bool,
    /// Charge in percent, when the platform says.
    pub percent: Option<f64>,
    /// The system's low-battery warning, or a charge at or below `LOW_BATTERY_PCT`.
    pub low: bool,
}

/// The signals, as read.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Readings {
    /// Seconds since the last input; `None` when the machine is headless.
    pub idle_seconds: Option<f64>,
    /// `None` on a machine without a battery, or one the platform hides.
    pub power: Option<Power>,
    pub cpu_c: Option<f64>,
    pub gpu_c: Option<f64>,
}

/// Why the user counts as present.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Presence {
    /// Input within the idle threshold.
    Input,
    /// A chat the user started is replying.
    Chat,
}

/// What, besides the user, argues against heavy work now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Strain {
    Battery,
    LowBattery,
    Hot,
}

/// `activity:state`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    /// Someone is using the computer (`present` says how).
    pub user_active: bool,
    pub present: Vec<Presence>,
    pub strain: Vec<Strain>,
    pub idle_seconds: Option<f64>,
    /// No input to read: nobody sits at this machine.
    pub headless: bool,
    pub idle_after_seconds: f64,
    pub chat_active: bool,
    pub power: Option<Power>,
    pub cpu_c: Option<f64>,
    pub gpu_c: Option<f64>,
}

/// The readings judged: present when there was input within `idle_after`
/// seconds or a chat is replying; strained on battery or when hot.
pub fn assess(r: &Readings, chat_active: bool, idle_after: f64) -> Activity {
    let mut present = Vec::new();
    if r.idle_seconds.is_some_and(|s| s < idle_after) {
        present.push(Presence::Input);
    }
    if chat_active {
        present.push(Presence::Chat);
    }
    let mut strain = Vec::new();
    if let Some(p) = r.power.filter(|p| p.on_battery) {
        strain.push(Strain::Battery);
        if p.low {
            strain.push(Strain::LowBattery);
        }
    }
    if r.cpu_c.is_some_and(|c| c >= HOT_CPU_C) || r.gpu_c.is_some_and(|c| c >= HOT_GPU_C) {
        strain.push(Strain::Hot);
    }
    Activity {
        user_active: !present.is_empty(),
        present,
        strain,
        idle_seconds: r.idle_seconds.map(|s| (s * 10.0).round() / 10.0),
        headless: r.idle_seconds.is_none(),
        idle_after_seconds: idle_after,
        chat_active,
        power: r.power,
        cpu_c: r.cpu_c,
        gpu_c: r.gpu_c,
    }
}

/// Input is read often (a background reply has to yield within a second of
/// the user's return); power and heat change slowly and cost more to read.
const INPUT_TTL: Duration = Duration::from_millis(500);
const POWER_TTL: Duration = Duration::from_secs(30);
const TEMPS_TTL: Duration = Duration::from_secs(10);

/// A cached reading of one signal.
type Cache<T> = Mutex<Option<(Instant, T)>>;

/// The last reading of each signal, shared by every caller inside its TTL.
#[derive(Default)]
pub struct Sampler {
    input: Cache<Option<f64>>,
    power: Cache<Option<Power>>,
    temps: Cache<(Option<f64>, Option<f64>)>,
}

impl Sampler {
    /// The signals now (blocking: Linux spawns `loginctl`). The GPU's
    /// temperature is the sensors', which the GPU probe may better.
    pub fn read(&self) -> Readings {
        let (cpu_c, gpu_c) = cached(&self.temps, TEMPS_TTL, || {
            let t = crate::temps::read();
            let at = |k: &str| t.as_ref().and_then(|t| t.get(k)).and_then(serde_json::Value::as_f64);
            (at("cpuC"), at("gpuC"))
        });
        Readings {
            idle_seconds: cached(&self.input, INPUT_TTL, platform::idle_seconds),
            power: cached(&self.power, POWER_TTL, platform::power),
            cpu_c,
            gpu_c,
        }
    }
}

fn cached<T: Copy>(slot: &Cache<T>, ttl: Duration, read: impl FnOnce() -> T) -> T {
    let mut slot = slot.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, v)) = *slot
        && at.elapsed() < ttl
    {
        return v;
    }
    let v = read();
    *slot = Some((Instant::now(), v));
    v
}

/// `loginctl show-session auto -p Type -p IdleHint -p IdleSinceHintMonotonic`,
/// judged against `CLOCK_MONOTONIC` now (µs): seconds idle, `Some(0)` while
/// the desktop says active, `None` when the session is not a graphical one.
pub fn parse_logind(text: &str, now_us: u64) -> Option<f64> {
    let field = |k: &str| text.lines().find_map(|l| l.strip_prefix(k)?.strip_prefix('=')).map(str::trim);
    if !matches!(field("Type"), Some("x11" | "wayland" | "mir")) {
        return None;
    }
    if field("IdleHint") != Some("yes") {
        return Some(0.0);
    }
    let since: u64 = field("IdleSinceHintMonotonic").and_then(|v| v.parse().ok()).unwrap_or(0);
    // A hint with no time: idle, for at least as long as the desktop waits.
    if since == 0 || since > now_us {
        return Some(IDLE_AFTER_SECS);
    }
    Some((now_us - since) as f64 / 1e6)
}

/// One `/sys/class/power_supply/*` entry: `type`, `online`, `capacity`,
/// `status` and `capacity_level`, as their files read.
#[derive(Debug, Default, Clone)]
pub struct Supply {
    pub kind: String,
    pub online: Option<String>,
    pub capacity: Option<String>,
    pub status: Option<String>,
    pub capacity_level: Option<String>,
}

/// The supplies folded: on battery when a system battery discharges and no
/// mains adapter is online. Peripherals' batteries (`scope` Device) are left
/// out by the caller.
pub fn fold_supplies(supplies: &[Supply]) -> Option<Power> {
    let batteries: Vec<&Supply> = supplies.iter().filter(|s| s.kind.trim() == "Battery").collect();
    if batteries.is_empty() {
        return None;
    }
    let mains = supplies.iter().any(|s| s.kind.trim() == "Mains" && s.online.as_deref().map(str::trim) == Some("1"));
    let discharging = batteries.iter().any(|b| b.status.as_deref().map(str::trim) == Some("Discharging"));
    let percents: Vec<f64> = batteries.iter().filter_map(|b| b.capacity.as_deref()?.trim().parse().ok()).collect();
    let percent = (!percents.is_empty()).then(|| percents.iter().sum::<f64>() / percents.len() as f64);
    let warned =
        batteries.iter().any(|b| matches!(b.capacity_level.as_deref().map(str::trim), Some("Low" | "Critical")));
    Some(Power {
        on_battery: discharging || !mains,
        percent,
        low: warned || percent.is_some_and(|p| p <= LOW_BATTERY_PCT),
    })
}

/// `GetSystemPowerStatus`'s fields: `ACLineStatus`, `BatteryFlag`,
/// `BatteryLifePercent` (255 when unknown).
pub fn fold_windows_power(ac_line: u8, flag: u8, percent: u8) -> Option<Power> {
    // 128: no system battery; 255: the status is unknown.
    if flag & 128 != 0 || flag == 255 {
        return None;
    }
    let percent = (percent != 255).then_some(f64::from(percent));
    Some(Power {
        on_battery: ac_line == 0,
        percent,
        // 2: low, 4: critical.
        low: flag & 6 != 0 || percent.is_some_and(|p| p <= LOW_BATTERY_PCT),
    })
}

/// IOKit's summary: `IOPSGetTimeRemainingEstimate` (-2 on AC power) and
/// `IOPSGetBatteryWarningLevel` (1 none, 2 early, 3 final).
pub fn fold_mac_power(time_remaining: f64, warning: i32) -> Option<Power> {
    const UNLIMITED: f64 = -2.0;
    if time_remaining == UNLIMITED {
        // On AC, or a Mac with no battery: the same to background work.
        return Some(Power { on_battery: false, percent: None, low: false });
    }
    Some(Power { on_battery: true, percent: None, low: warning >= 2 })
}

#[cfg(target_os = "macos")]
mod platform {
    use super::Power;

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(source: i32, event_type: u32) -> f64;
    }

    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        fn IOPSGetTimeRemainingEstimate() -> f64;
        fn IOPSGetBatteryWarningLevel() -> i32;
    }

    /// `kCGEventSourceStateHIDSystemState`: input from every source, as the
    /// HID system saw it.
    const HID_SYSTEM_STATE: i32 = 1;
    /// `kCGAnyInputEventType`.
    const ANY_INPUT: u32 = !0;

    pub fn idle_seconds() -> Option<f64> {
        // SAFETY: a pure query with no pointers.
        let s = unsafe { CGEventSourceSecondsSinceLastEventType(HID_SYSTEM_STATE, ANY_INPUT) };
        s.is_finite().then_some(s.max(0.0))
    }

    pub fn power() -> Option<Power> {
        // SAFETY: pure queries with no pointers.
        let (remaining, warning) = unsafe { (IOPSGetTimeRemainingEstimate(), IOPSGetBatteryWarningLevel()) };
        super::fold_mac_power(remaining, warning)
    }
}

#[cfg(windows)]
mod platform {
    use super::Power;
    use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    pub fn idle_seconds() -> Option<f64> {
        let mut info = LASTINPUTINFO { cbSize: size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        // SAFETY: `info` is a valid, sized LASTINPUTINFO for the call.
        if unsafe { GetLastInputInfo(&mut info) } == 0 {
            // No input to read in this session (a service, say): headless.
            return None;
        }
        // SAFETY: no arguments. Both tick counts wrap at 49.7 days together.
        let now = unsafe { GetTickCount() };
        Some(f64::from(now.wrapping_sub(info.dwTime)) / 1000.0)
    }

    pub fn power() -> Option<Power> {
        // SAFETY: zeroed is a valid SYSTEM_POWER_STATUS, which the call fills.
        let mut s: SYSTEM_POWER_STATUS = unsafe { std::mem::zeroed() };
        // SAFETY: `s` is valid for the write.
        if unsafe { GetSystemPowerStatus(&mut s) } == 0 {
            return None;
        }
        super::fold_windows_power(s.ACLineStatus, s.BatteryFlag, s.BatteryLifePercent)
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::{Power, Supply};
    use std::path::Path;

    pub fn idle_seconds() -> Option<f64> {
        let out = std::process::Command::new("loginctl")
            .args(["show-session", "auto", "-p", "Type", "-p", "IdleHint", "-p", "IdleSinceHintMonotonic"])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        super::parse_logind(&String::from_utf8_lossy(&out.stdout), monotonic_us())
    }

    fn monotonic_us() -> u64 {
        let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
        // SAFETY: `ts` is valid for the write.
        unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut ts) };
        ts.tv_sec as u64 * 1_000_000 + ts.tv_nsec as u64 / 1000
    }

    pub fn power() -> Option<Power> {
        let read = |dir: &Path, f: &str| std::fs::read_to_string(dir.join(f)).ok();
        let supplies: Vec<Supply> = std::fs::read_dir("/sys/class/power_supply")
            .ok()?
            .flatten()
            .map(|e| e.path())
            // A mouse's or headset's battery is not the computer's.
            .filter(|d| read(d, "scope").is_none_or(|s| s.trim() != "Device"))
            .map(|d| Supply {
                kind: read(&d, "type").unwrap_or_default(),
                online: read(&d, "online"),
                capacity: read(&d, "capacity"),
                status: read(&d, "status"),
                capacity_level: read(&d, "capacity_level"),
            })
            .collect();
        super::fold_supplies(&supplies)
    }
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
mod platform {
    pub fn idle_seconds() -> Option<f64> {
        None
    }
    pub fn power() -> Option<super::Power> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logind_idle_hint() {
        let active = "Type=wayland\nIdleHint=no\nIdleSinceHintMonotonic=0\n";
        assert_eq!(parse_logind(active, 5_000_000_000), Some(0.0));
        let idle = "Type=x11\nIdleHint=yes\nIdleSinceHintMonotonic=4000000000\n";
        assert_eq!(parse_logind(idle, 4_420_000_000), Some(420.0));
        // A text console or an SSH login has no desktop to say.
        assert_eq!(parse_logind("Type=tty\nIdleHint=no\n", 1), None);
        assert_eq!(parse_logind("", 1), None);
    }

    fn supply(kind: &str, online: Option<&str>, capacity: Option<&str>, status: Option<&str>) -> Supply {
        Supply {
            kind: format!("{kind}\n"),
            online: online.map(|s| format!("{s}\n")),
            capacity: capacity.map(|s| format!("{s}\n")),
            status: status.map(|s| format!("{s}\n")),
            capacity_level: None,
        }
    }

    #[test]
    fn linux_supplies() {
        assert_eq!(fold_supplies(&[supply("Mains", Some("1"), None, None)]), None);
        let plugged = [supply("Mains", Some("1"), None, None), supply("Battery", None, Some("80"), Some("Charging"))];
        assert_eq!(fold_supplies(&plugged), Some(Power { on_battery: false, percent: Some(80.0), low: false }));
        let unplugged =
            [supply("Mains", Some("0"), None, None), supply("Battery", None, Some("18"), Some("Discharging"))];
        assert_eq!(fold_supplies(&unplugged), Some(Power { on_battery: true, percent: Some(18.0), low: true }));
        let mut critical = supply("Battery", None, None, Some("Discharging"));
        critical.capacity_level = Some("Critical\n".into());
        assert_eq!(fold_supplies(&[critical]), Some(Power { on_battery: true, percent: None, low: true }));
    }

    #[test]
    fn windows_power_status() {
        assert_eq!(fold_windows_power(1, 128, 255), None);
        assert_eq!(fold_windows_power(255, 255, 255), None);
        assert_eq!(fold_windows_power(1, 8, 64), Some(Power { on_battery: false, percent: Some(64.0), low: false }));
        assert_eq!(fold_windows_power(0, 2, 30), Some(Power { on_battery: true, percent: Some(30.0), low: true }));
        assert_eq!(fold_windows_power(0, 0, 12), Some(Power { on_battery: true, percent: Some(12.0), low: true }));
    }

    #[test]
    fn mac_power_summary() {
        assert_eq!(fold_mac_power(-2.0, 1), Some(Power { on_battery: false, percent: None, low: false }));
        assert_eq!(fold_mac_power(-1.0, 1), Some(Power { on_battery: true, percent: None, low: false }));
        assert_eq!(fold_mac_power(5400.0, 2), Some(Power { on_battery: true, percent: None, low: true }));
    }

    #[test]
    fn this_machine_reads() {
        let r = Sampler::default().read();
        assert!(r.idle_seconds.is_none_or(|s| s >= 0.0), "{r:?}");
        if cfg!(target_os = "macos") {
            assert!(r.idle_seconds.is_some(), "{r:?}");
        }
    }
}
