//! Temperature sensors for the Hardware monitor: CPU, memory and (where the
//! GPU probe has none of its own) GPU, in °C. Best-effort and unprivileged:
//!
//! - Linux: `/sys/class/hwmon` (k10temp/coretemp for the CPU, spd5118/jc42
//!   for DIMMs, amdgpu/nouveau/i915 for the GPU).
//! - macOS: the IOKit HID sensors sysinfo exposes (Apple Silicon die sensors).
//! - Windows: the ACPI thermal zone performance counter, read with PDH (no
//!   admin rights, no process spawn). Many desktops publish no zone at all;
//!   then there is simply no CPU reading. DIMM sensors need a kernel driver
//!   on Windows, so memory stays empty there.
//!
//! NVIDIA GPU (and VRAM) temperatures ride on the `nvidia-smi` query instead.

use serde_json::{Map, Value};

/// Which row a sensor belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SensorKind {
    Cpu,
    Memory,
    Gpu,
}

/// Sort a hwmon chip (`/sys/class/hwmon/*/name`) and one of its labels into a
/// row, or `None` for sensors that are not one of the three (NVMe, Wi-Fi, ACPI
/// board zones, chipset). Also used for macOS sensor labels (`chip` empty).
pub fn classify_sensor(chip: &str, label: &str) -> Option<SensorKind> {
    let chip = chip.to_ascii_lowercase();
    let label = label.to_ascii_lowercase();
    match chip.as_str() {
        "k10temp" | "k8temp" | "coretemp" | "zenpower" | "cpu_thermal" | "cpu-thermal" | "fam15h_power" => {
            return Some(SensorKind::Cpu);
        }
        "spd5118" | "jc42" => return Some(SensorKind::Memory),
        "amdgpu" | "radeon" | "nouveau" | "i915" | "xe" => {
            // amdgpu's `mem` is the VRAM; the GPU row wants the core.
            return if label == "mem" { None } else { Some(SensorKind::Gpu) };
        }
        "" => {}
        _ => return None,
    }
    // Labels without a chip (macOS): Apple Silicon die and GPU sensors.
    if label.contains("gpu") || label.starts_with("pmu tg") {
        Some(SensorKind::Gpu)
    } else if label.contains("tdie") || label.contains("cpu") || label.contains("tp") && label.starts_with("pmu") {
        Some(SensorKind::Cpu)
    } else if label.contains("dram") || label.contains("memory") {
        Some(SensorKind::Memory)
    } else {
        None
    }
}

/// Readings at or below freezing, or past 150 °C, are a missing sensor or a
/// bogus register, not a temperature.
fn plausible(c: f64) -> bool {
    c.is_finite() && c > 0.0 && c < 150.0
}

/// Fold classified readings into the hottest per row, as `{ cpuC, memoryC, gpuC }`
/// (rounded to whole degrees; rows without a reading are left out).
pub fn fold(readings: impl IntoIterator<Item = (SensorKind, f64)>) -> Option<Value> {
    let mut hot: [Option<f64>; 3] = [None; 3];
    for (kind, c) in readings {
        if !plausible(c) {
            continue;
        }
        let slot = &mut hot[kind as usize];
        *slot = Some(slot.map_or(c, |h| h.max(c)));
    }
    let mut o = Map::new();
    for (key, value) in ["cpuC", "memoryC", "gpuC"].iter().zip(hot) {
        if let Some(v) = value {
            o.insert((*key).into(), crate::num(crate::js_round(v)));
        }
    }
    (!o.is_empty()).then_some(Value::Object(o))
}

/// Kelvin (what the Windows thermal zone counter reports) to °C.
pub fn kelvin_to_c(k: f64) -> f64 {
    k - 273.15
}

/// The sensors now, folded. `None` when the machine exposes none.
pub fn read() -> Option<Value> {
    fold(platform::readings())
}

#[cfg(target_os = "linux")]
mod platform {
    use super::{SensorKind, classify_sensor};
    use std::fs;

    pub fn readings() -> Vec<(SensorKind, f64)> {
        let mut out = Vec::new();
        let Ok(dirs) = fs::read_dir("/sys/class/hwmon") else { return out };
        for dir in dirs.flatten() {
            let path = dir.path();
            let chip = fs::read_to_string(path.join("name")).unwrap_or_default();
            let chip = chip.trim();
            let Ok(files) = fs::read_dir(&path) else { continue };
            for file in files.flatten() {
                let name = file.file_name().to_string_lossy().into_owned();
                let Some(stem) = name.strip_suffix("_input").filter(|s| s.starts_with("temp")) else { continue };
                let label = fs::read_to_string(path.join(format!("{stem}_label"))).unwrap_or_default();
                let Some(kind) = classify_sensor(chip, label.trim()) else { continue };
                let Some(milli) = fs::read_to_string(file.path()).ok().and_then(|s| s.trim().parse::<f64>().ok())
                else {
                    continue;
                };
                out.push((kind, milli / 1000.0));
            }
        }
        out
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{SensorKind, classify_sensor};

    pub fn readings() -> Vec<(SensorKind, f64)> {
        sysinfo::Components::new_with_refreshed_list()
            .list()
            .iter()
            .filter_map(|c| Some((classify_sensor("", c.label())?, f64::from(c.temperature()?))))
            .collect()
    }
}

#[cfg(windows)]
mod platform {
    use super::{SensorKind, kelvin_to_c};
    use std::sync::atomic::{AtomicBool, Ordering};
    use windows_sys::Win32::System::Performance::{
        PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE, PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData,
        PdhGetFormattedCounterArrayW, PdhOpenQueryW,
    };

    /// Set once the machine has shown it publishes no thermal zone, so later
    /// polls skip the query entirely.
    static NONE: AtomicBool = AtomicBool::new(false);
    const PDH_MORE_DATA: u32 = 0x8000_07D2;

    pub fn readings() -> Vec<(SensorKind, f64)> {
        if NONE.load(Ordering::Relaxed) {
            return Vec::new();
        }
        let zones = thermal_zones_kelvin();
        if zones.is_none() {
            NONE.store(true, Ordering::Relaxed);
        }
        zones.unwrap_or_default().into_iter().map(|k| (SensorKind::Cpu, kelvin_to_c(k))).collect()
    }

    /// `\Thermal Zone Information(*)\Temperature`, in Kelvin, or `None` when
    /// the counter or its instances do not exist.
    fn thermal_zones_kelvin() -> Option<Vec<f64>> {
        let path: Vec<u16> = "\\Thermal Zone Information(*)\\Temperature\0".encode_utf16().collect();
        // SAFETY: PDH calls on a query handle we own and close; buffers are
        // sized by the first PdhGetFormattedCounterArrayW call.
        unsafe {
            let mut query: *mut core::ffi::c_void = std::ptr::null_mut();
            if PdhOpenQueryW(std::ptr::null(), 0, &mut query) != 0 {
                return None;
            }
            let mut counter: *mut core::ffi::c_void = std::ptr::null_mut();
            let result = (|| {
                if PdhAddEnglishCounterW(query, path.as_ptr(), 0, &mut counter) != 0 {
                    return None;
                }
                if PdhCollectQueryData(query) != 0 {
                    return None;
                }
                let (mut size, mut count) = (0u32, 0u32);
                let status =
                    PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut size, &mut count, std::ptr::null_mut());
                if status != PDH_MORE_DATA || size == 0 {
                    return None;
                }
                let items = (size as usize).div_ceil(std::mem::size_of::<PDH_FMT_COUNTERVALUE_ITEM_W>());
                let mut buf: Vec<PDH_FMT_COUNTERVALUE_ITEM_W> = Vec::with_capacity(items);
                if PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut size, &mut count, buf.as_mut_ptr()) != 0 {
                    return None;
                }
                buf.set_len(count as usize);
                let kelvin: Vec<f64> = buf.iter().map(|i| i.FmtValue.Anonymous.doubleValue).collect();
                (!kelvin.is_empty()).then_some(kelvin)
            })();
            PdhCloseQuery(query);
            result
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
mod platform {
    pub fn readings() -> Vec<(super::SensorKind, f64)> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sorts_linux_chips_into_rows() {
        assert_eq!(classify_sensor("k10temp", "Tctl"), Some(SensorKind::Cpu));
        assert_eq!(classify_sensor("coretemp", "Package id 0"), Some(SensorKind::Cpu));
        assert_eq!(classify_sensor("spd5118", ""), Some(SensorKind::Memory));
        assert_eq!(classify_sensor("amdgpu", "edge"), Some(SensorKind::Gpu));
        assert_eq!(classify_sensor("amdgpu", "mem"), None);
        assert_eq!(classify_sensor("nvme", "Composite"), None);
        assert_eq!(classify_sensor("acpitz", ""), None);
    }

    #[test]
    fn sorts_mac_labels_into_rows() {
        assert_eq!(classify_sensor("", "PMU tdie1"), Some(SensorKind::Cpu));
        assert_eq!(classify_sensor("", "GPU MTR Temp Sensor1"), Some(SensorKind::Gpu));
        assert_eq!(classify_sensor("", "NAND CH0 temp"), None);
    }

    #[test]
    fn folds_to_the_hottest_plausible_reading_per_row() {
        let v = fold([
            (SensorKind::Cpu, 48.4),
            (SensorKind::Cpu, 61.5),
            (SensorKind::Memory, 39.0),
            (SensorKind::Gpu, 0.0),
            (SensorKind::Gpu, f64::NAN),
        ]);
        assert_eq!(v, Some(json!({ "cpuC": 62, "memoryC": 39 })));
        assert_eq!(fold([(SensorKind::Cpu, 200.0)]), None);
        assert_eq!(fold(std::iter::empty()), None);
    }

    #[test]
    fn converts_thermal_zone_kelvin() {
        assert!((kelvin_to_c(323.15) - 50.0).abs() < 1e-9);
    }

    #[test]
    fn reading_the_machine_never_panics() {
        let _ = read();
    }
}
