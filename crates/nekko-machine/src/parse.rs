//! What the probes print, read the way the TS host reads it (`gpu.ts`,
//! `gpu-macos.ts`, `gpu-vulkan.ts`, `readiness.ts`, `system.ts`). Pure, so the
//! golden set in `tests/golden/machine.json` holds every one to its TS twin.

use crate::{js_round, num};
use regress::Regex;
use serde_json::{Map, Value, json};
use std::sync::OnceLock;

const BYTES_PER_MB: f64 = 1024.0 * 1024.0;

/// One GPU as the monitor surfaces read it (`GpuDevice`).
#[derive(Debug, Clone, PartialEq)]
pub struct GpuDevice {
    pub name: String,
    pub total_mb: f64,
    pub used_mb: f64,
    pub free_mb: f64,
    pub utilization_pct: Option<f64>,
    /// Core temperature in °C, when the probe reports one.
    pub temperature_c: Option<f64>,
}

/// `GpuStats`: the devices and their aggregate.
#[derive(Debug, Clone, PartialEq)]
pub struct GpuStats {
    pub source: &'static str,
    pub devices: Vec<GpuDevice>,
    pub unified: bool,
    pub total_mb: f64,
    pub used_mb: f64,
    pub free_mb: f64,
}

impl GpuStats {
    /// The object the TS host returns, key order included (`unified` and
    /// `utilizationPct` are left out when absent, as `undefined` is).
    pub fn to_value(&self) -> Value {
        let devices: Vec<Value> = self
            .devices
            .iter()
            .map(|d| {
                let mut o = Map::new();
                o.insert("name".into(), json!(d.name));
                o.insert("memoryTotalMB".into(), num(d.total_mb));
                o.insert("memoryUsedMB".into(), num(d.used_mb));
                o.insert("memoryFreeMB".into(), num(d.free_mb));
                if let Some(u) = d.utilization_pct {
                    o.insert("utilizationPct".into(), num(u));
                }
                if let Some(t) = d.temperature_c {
                    o.insert("temperatureC".into(), num(t));
                }
                Value::Object(o)
            })
            .collect();
        let mut o = Map::new();
        o.insert("source".into(), json!(self.source));
        o.insert("devices".into(), Value::Array(devices));
        if self.unified {
            o.insert("unified".into(), json!(true));
        }
        o.insert("totalMB".into(), num(self.total_mb));
        o.insert("usedMB".into(), num(self.used_mb));
        o.insert("freeMB".into(), num(self.free_mb));
        Value::Object(o)
    }
}

fn re(pattern: &str, flags: &str) -> Regex {
    Regex::with_flags(pattern, flags).expect("a valid built-in pattern")
}

macro_rules! regex {
    ($pattern:expr) => {
        regex!($pattern, "")
    };
    ($pattern:expr, $flags:expr) => {{
        static R: OnceLock<Regex> = OnceLock::new();
        R.get_or_init(|| re($pattern, $flags))
    }};
}

/// `s.split(regex)` for a pattern without groups (never matches empty here).
fn re_split<'a>(r: &Regex, s: &'a str) -> Vec<&'a str> {
    let mut out = Vec::new();
    let mut at = 0;
    for m in r.find_iter(s) {
        let range = m.range();
        if range.is_empty() {
            continue;
        }
        out.push(&s[at..range.start]);
        at = range.end;
    }
    out.push(&s[at..]);
    out
}

/// The first capture group of the first match, as `/.../.exec(s)?.[1]`.
fn group1<'a>(r: &Regex, s: &'a str) -> Option<&'a str> {
    r.find(s).and_then(|m| m.group(1)).map(|g| &s[g])
}

/// `aggregate` in gpu.ts: sum a device list, `null` when it is empty.
pub fn aggregate(source: &'static str, devices: Vec<GpuDevice>, unified: bool) -> Option<GpuStats> {
    let first_total = devices.first()?.total_mb;
    let used: f64 = devices.iter().fold(0.0, |s, d| s + d.used_mb);
    Some(GpuStats {
        source,
        unified,
        // Unified memory is one pool every accelerator draws from, so summing
        // the per-device totals would count the same RAM once per GPU.
        total_mb: if unified { first_total } else { devices.iter().fold(0.0, |s, d| s + d.total_mb) },
        used_mb: used,
        free_mb: if unified { (first_total - used).max(0.0) } else { devices.iter().fold(0.0, |s, d| s + d.free_mb) },
        devices,
    })
}

/// `Number(s) || 0`.
fn number_or_zero(s: &str) -> f64 {
    let n = nekko_js::string_to_number(s);
    if n.is_nan() || n == 0.0 { 0.0 } else { n }
}

/// `smiTemperature`: a reading in °C, `None` for a blank, `N/A` or `[N/A]` column.
fn smi_temperature(col: Option<&&str>) -> Option<f64> {
    let s = col?;
    if s.is_empty() {
        return None;
    }
    let n = nekko_js::string_to_number(s);
    n.is_finite().then_some(n)
}

/// `parseNvidiaSmi`: `nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu[,temperature.gpu] --format=csv,noheader,nounits`.
pub fn parse_nvidia_smi(stdout: &str) -> Option<GpuStats> {
    let devices = nekko_js::trim(stdout)
        .split('\n')
        .map(|line| line.split(',').map(nekko_js::trim).collect::<Vec<_>>())
        .filter(|cols| cols.len() >= 4)
        .map(|cols| GpuDevice {
            name: if cols[0].is_empty() { "GPU".into() } else { cols[0].to_string() },
            total_mb: number_or_zero(cols[1]),
            used_mb: number_or_zero(cols[2]),
            free_mb: number_or_zero(cols[3]),
            utilization_pct: cols
                .get(4)
                .filter(|u| !u.is_empty() && **u != "[N/A]")
                .map(|u| nekko_js::string_to_number(u)),
            temperature_c: smi_temperature(cols.get(5)),
        })
        .filter(|d| d.total_mb > 0.0)
        .collect();
    aggregate("nvidia-smi", devices, false)
}

/// One accelerator's registry entry (`MacGpuEntry`).
#[derive(Debug, Clone, PartialEq)]
pub struct MacGpuEntry {
    pub name: String,
    pub allocated_bytes: f64,
    pub utilization_pct: Option<f64>,
    pub cores: Option<f64>,
}

/// `num` in gpu-macos.ts: `"key"=26` as 26.
fn ioreg_num(blob: &str, key: &str) -> Option<f64> {
    let mut escaped = String::new();
    for c in key.chars() {
        if "%\\^$*+?.()|[]{}".contains(c) {
            escaped.push('\\');
        }
        escaped.push(c);
    }
    let r = re(&format!("\"{escaped}\"\\s*=\\s*(\\d+)"), "");
    let n: f64 = group1(&r, blob)?.parse().ok()?;
    n.is_finite().then_some(n)
}

/// `/^\+-o /m` split, first piece dropped: one chunk per registry entry.
fn ioreg_chunks(stdout: &str) -> Vec<&str> {
    let starts: Vec<usize> = regex!(r"^\+-o ", "m").find_iter(stdout).map(|m| m.range().start).collect();
    starts
        .iter()
        .enumerate()
        .map(|(i, &s)| &stdout[s + 4..starts.get(i + 1).copied().unwrap_or(stdout.len())])
        .collect()
}

/// `parseIoregAccelerators`.
pub fn parse_ioreg_accelerators(stdout: &str) -> Vec<MacGpuEntry> {
    let mut out = Vec::new();
    for chunk in ioreg_chunks(stdout) {
        let Some(stats) = group1(regex!(r#""PerformanceStatistics"\s*=\s*\{([^}]*)\}"#), chunk) else { continue };
        let Some(allocated_bytes) = ioreg_num(stats, "Alloc system memory")
            .or_else(|| ioreg_num(stats, "In use system memory"))
            .or_else(|| ioreg_num(stats, "In use system memory (driver)"))
        else {
            continue;
        };
        let model = group1(regex!(r#""model"\s*=\s*"([^"]+)""#), chunk).map(nekko_js::trim).unwrap_or_default();
        let name = if !model.is_empty() {
            model.to_string()
        } else {
            group1(regex!(r"^(\S+)"), chunk).filter(|s| !s.is_empty()).unwrap_or("GPU").to_string()
        };
        out.push(MacGpuEntry {
            name,
            allocated_bytes,
            utilization_pct: ioreg_num(stats, "Device Utilization %"),
            cores: ioreg_num(chunk, "gpu-core-count"),
        });
    }
    out
}

/// `toGpuDevices`: every accelerator measured against the one unified pool.
pub fn to_gpu_devices(entries: Vec<MacGpuEntry>, unified_total_mb: f64) -> Vec<GpuDevice> {
    entries
        .into_iter()
        .map(|e| {
            let used = unified_total_mb.min(js_round(e.allocated_bytes / BYTES_PER_MB));
            let name = match e.cores {
                // `0` is falsy: no core count.
                Some(c) if c != 0.0 => format!("{} ({}-core GPU)", e.name, nekko_js::number_to_string(c)),
                _ => e.name,
            };
            GpuDevice {
                name,
                total_mb: unified_total_mb,
                used_mb: used,
                free_mb: (unified_total_mb - used).max(0.0),
                utilization_pct: e.utilization_pct,
                temperature_c: None,
            }
        })
        .collect()
}

/// `ioregStats`.
pub fn ioreg_stats(stdout: &str, unified_total_mb: f64) -> Option<GpuStats> {
    if unified_total_mb <= 0.0 {
        return None;
    }
    aggregate("ioreg", to_gpu_devices(parse_ioreg_accelerators(stdout), unified_total_mb), true)
}

/// One line of `llama-server --list-devices` (`ListedDevice`).
#[derive(Debug, Clone, PartialEq)]
pub struct ListedDevice {
    pub id: String,
    pub name: String,
    pub total_mb: f64,
    pub free_mb: f64,
    pub integrated: bool,
}

/// `parseListDevices`.
pub fn parse_list_devices(text: &str) -> Vec<ListedDevice> {
    let line_re = regex!(r"^\s*([A-Za-z]+\d+):\s+(.+?)\s+\((\d+)\s*MiB,\s*(\d+)\s*MiB free\)\s*$");
    let integrated = regex!(
        r"intel.*(uhd|hd graphics|iris)|radeon\(tm\) graphics|radeon graphics|radeon(?:\(tm\))?\s+vega\s+(?:8|11)\s+graphics|apple|adreno|mali",
        "i"
    );
    let mut out = Vec::new();
    for line in re_split(regex!(r"\r?\n"), text) {
        let Some(m) = line_re.find(line) else { continue };
        let g = |i: usize| m.group(i).map(|r| &line[r]).unwrap_or_default();
        let total = nekko_js::string_to_number(g(3));
        let free = nekko_js::string_to_number(g(4));
        if !total.is_finite() || total <= 0.0 {
            continue;
        }
        let name = nekko_js::trim(g(2)).to_string();
        out.push(ListedDevice {
            id: g(1).to_string(),
            integrated: integrated.find(&name).is_some(),
            name,
            total_mb: total,
            free_mb: (if free.is_finite() { free } else { 0.0 }).min(total),
        });
    }
    out
}

/// `listedToStats`: the discrete cards only.
pub fn listed_to_stats(listed: &[ListedDevice]) -> Option<GpuStats> {
    let devices: Vec<GpuDevice> = listed
        .iter()
        .filter(|d| !d.integrated)
        .map(|d| GpuDevice {
            name: d.name.clone(),
            total_mb: d.total_mb,
            used_mb: (d.total_mb - d.free_mb).max(0.0),
            free_mb: d.free_mb,
            utilization_pct: None,
            temperature_c: None,
        })
        .collect();
    aggregate("llama-server", devices, false)
}

/// `cpuinfoFeatures`: the wanted flags in Linux's `/proc/cpuinfo`.
pub fn cpuinfo_features(text: &str) -> Option<Vec<String>> {
    let line = text.split('\n').find(|l| regex!(r"^(flags|Features)\s*:").find(l).is_some())?;
    let list = line.split(':').nth(1).unwrap_or_default();
    let lowered = nekko_js::trim(list).to_lowercase();
    let flags: Vec<&str> = re_split(regex!(r"\s+"), &lowered);
    Some(
        ["avx", "avx2", "avx512f", "fma", "f16c", "asimd", "neon", "sve"]
            .iter()
            .filter(|f| flags.contains(f))
            .map(|f| f.to_string())
            .collect(),
    )
}

/// `sysctlFeatures`: `hw.optional.*` keys that equal 1.
pub fn sysctl_features(out: &str) -> Vec<String> {
    out.split('\n')
        .filter_map(|l| group1(regex!(r"^hw\.optional\.([\w.]+):\s*1$"), l))
        .filter(|f| !f.is_empty())
        .map(str::to_lowercase)
        .collect()
}

/// `gpuBackends`: what `nvidia-smi -L` and `vulkaninfo --summary` prove, plus the CPU.
pub fn gpu_backends(smi: Option<&str>, vk: Option<&str>) -> Vec<String> {
    let mut out = Vec::new();
    if smi.is_some_and(|s| !s.is_empty() && regex!(r"GPU\s+\d+:").find(s).is_some()) {
        out.push("cuda".to_string());
    }
    if vk.is_some_and(|s| !s.is_empty() && regex!("apiVersion|deviceName", "i").find(s).is_some()) {
        out.push("vulkan".to_string());
    }
    out.push("cpu".to_string());
    out
}

/// `macMemoryUsedMB`: anonymous resident pages + wired + compressor, from `vm_stat`.
pub fn mac_memory_used_mb(output: &str) -> Option<f64> {
    let page_size = group1(regex!(r"page size of (\d+) bytes"), output).map_or(f64::NAN, nekko_js::string_to_number);
    let pages = |name: &str| {
        group1(&re(&format!(r"^{name}:\s+(\d+)\."), "m"), output).map_or(f64::NAN, nekko_js::string_to_number)
    };
    let anonymous = pages("Anonymous pages");
    let purgeable = pages("Pages purgeable");
    let wired = pages("Pages wired down");
    let compressed = pages("Pages occupied by compressor");
    if ![page_size, anonymous, purgeable, wired, compressed].iter().all(|n| n.is_finite()) || page_size <= 0.0 {
        return None;
    }
    Some(js_round(((anonymous - purgeable).max(0.0) + wired + compressed) * page_size / 1024.0 / 1024.0))
}
