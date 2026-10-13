//! The GPUs the OS reports, found without any vendor tool: the video
//! controller list on Windows, the DRM devices on Linux. A port of
//! `packages/host/src/gpu-adapters.ts`, held to it by `tests/golden/install.json`.

use regress::Regex;
use serde_json::{Value, json};
use std::sync::OnceLock;

/// PCI vendor ids, as Windows (`VEN_xxxx`) and Linux (`0xxxxx`) spell them.
fn vendor_of(id: &str) -> Option<&'static str> {
    match id {
        "10de" => Some("nvidia"),
        "1002" | "1022" => Some("amd"),
        "8086" => Some("intel"),
        _ => None,
    }
}

fn not_a_gpu() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::with_flags(
            r"basic display|basic render|remote|virtual|hyper-v|parsec|displaylink|\bidd\b|spacedesk",
            "i",
        )
        .expect("a valid built-in pattern")
    })
}

/// `Name|PNPDeviceID` lines from `Win32_VideoController` (`parseWindowsAdapters`).
pub fn parse_windows_adapters(text: &str) -> Vec<Value> {
    static VEN: OnceLock<Regex> = OnceLock::new();
    let ven = VEN.get_or_init(|| Regex::with_flags(r"VEN_([0-9A-F]{4})", "i").expect("a valid built-in pattern"));
    let mut out = Vec::new();
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let mut parts = line.split('|');
        let name = parts.next().unwrap_or("");
        let pnp = parts.next().unwrap_or("");
        if nekko_js::trim(name).is_empty() || not_a_gpu().find(name).is_some() {
            continue;
        }
        let id = ven.find(pnp).and_then(|m| m.group(1)).map(|g| pnp[g].to_lowercase());
        let vendor = id.as_deref().and_then(vendor_of).unwrap_or("other");
        out.push(json!({ "vendor": vendor, "name": nekko_js::trim(name) }));
    }
    out
}

/// This machine's adapters (`detectGpuAdapters`, uncached).
pub async fn probe() -> Vec<Value> {
    if cfg!(windows) {
        let script = r#"Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name + "|" + $_.PNPDeviceID }"#;
        let mut cmd = tokio::process::Command::new("powershell.exe");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]).kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000);
        let out = tokio::time::timeout(std::time::Duration::from_secs(8), cmd.output()).await;
        return match out {
            Ok(Ok(o)) if o.status.success() => parse_windows_adapters(&String::from_utf8_lossy(&o.stdout)),
            _ => Vec::new(),
        };
    }
    if cfg!(target_os = "linux") {
        let Ok(entries) = std::fs::read_dir("/sys/class/drm") else { return Vec::new() };
        let mut cards: Vec<String> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.strip_prefix("card").is_some_and(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit())))
            .collect();
        cards.sort();
        let mut found = Vec::new();
        for card in cards {
            let id = std::fs::read_to_string(format!("/sys/class/drm/{card}/device/vendor")).unwrap_or_default();
            let id = id.trim();
            let id = id.strip_prefix("0x").or_else(|| id.strip_prefix("0X")).unwrap_or(id).to_lowercase();
            if let Some(vendor) = vendor_of(&id) {
                found.push(json!({ "vendor": vendor, "name": card }));
            }
        }
        return found;
    }
    Vec::new()
}
