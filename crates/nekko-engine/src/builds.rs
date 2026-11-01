//! Which llama.cpp or stable-diffusion.cpp build a machine should run, and
//! which release file that is. Ports of `packages/host/src/engine/builds.ts`,
//! `diffusion.ts`'s build half and `runtime-releases.ts`, held to them by
//! `tests/golden/install.json`. Nothing is downloaded here.

use regress::Regex;
use serde_json::{Map, Value, json};
use std::sync::OnceLock;

/// How much faster CUDA is than Vulkan on NVIDIA, as the build picker says it.
pub const CUDA_FASTER: &str = "Roughly 15-20% faster";

/// The pinned releases (`RUNTIME_RELEASES`): `(repo, tag)`.
pub fn release_pin(runtime: &str) -> (&'static str, &'static str) {
    match runtime {
        "diffusion" => ("leejet/stable-diffusion.cpp", "master-1009-e6370bf"),
        _ => ("ggml-org/llama.cpp", "b11224"),
    }
}

/// `nvidia-smi`'s arguments for the CUDA check (`CUDA_QUERY`).
pub const CUDA_QUERY: [&str; 2] = ["--query-gpu=compute_cap,driver_version", "--format=csv,noheader"];

fn build(
    id: &str,
    platform: &str,
    arch: &str,
    backend: &str,
    pattern: &str,
    requires: String,
    companion: Option<&str>,
) -> Value {
    let mut m = Map::new();
    m.insert("id".into(), json!(id));
    m.insert("platform".into(), json!(platform));
    m.insert("arch".into(), json!(arch));
    m.insert("backend".into(), json!(backend));
    m.insert("assetPattern".into(), json!(pattern));
    m.insert("requires".into(), json!(requires));
    if let Some(c) = companion {
        m.insert("companionPattern".into(), json!(c));
    }
    Value::Object(m)
}

/// Every build we know about (`allBuilds`), in the TS table's order.
pub fn all_builds() -> &'static Vec<Value> {
    static B: OnceLock<Vec<Value>> = OnceLock::new();
    B.get_or_init(|| {
        let cuda_requires = format!(
            "An NVIDIA GPU from the GTX 16 or RTX 20 series on, with driver 580 or newer. {CUDA_FASTER} than Vulkan on NVIDIA, but a bigger download: it brings the CUDA libraries along."
        );
        let lower = CUDA_FASTER.to_lowercase();
        let s = |x: &str| x.to_string();
        vec![
            build("win-x64-cuda", "win32", "x64", "cuda", "bin-win-cuda", cuda_requires.clone(), Some("cudart-llama")),
            build(
                "win-x64-vulkan",
                "win32",
                "x64",
                "vulkan",
                "bin-win-vulkan",
                format!("Any GPU with Vulkan drivers (AMD, Intel, or NVIDIA). A small download; on a recent NVIDIA GPU, CUDA is {lower}."),
                None,
            ),
            build("win-x64-rocm", "win32", "x64", "hip", "bin-win-rocm", s("A recent AMD GPU with ROCm support."), None),
            build("win-x64-cpu", "win32", "x64", "cpu", "bin-win-cpu", s("Any x64 processor. Slower, but always works."), None),
            build(
                "win-arm64-cuda",
                "win32",
                "arm64",
                "cuda",
                "bin-win-cuda",
                s("A Windows on Arm machine with an NVIDIA GPU."),
                Some("cudart-llama"),
            ),
            build("win-arm64-cpu", "win32", "arm64", "cpu", "bin-win-cpu", s("A Windows on Arm machine."), None),
            build("macos-arm64-metal", "darwin", "arm64", "metal", "bin-macos", s("Apple Silicon. Uses the GPU through Metal."), None),
            build("linux-x64-cuda", "linux", "x64", "cuda", "bin-ubuntu-cuda", cuda_requires, Some("cudart-llama")),
            build("linux-x64-rocm", "linux", "x64", "hip", "bin-ubuntu-rocm", s("A recent AMD GPU with ROCm support."), None),
            build(
                "linux-x64-vulkan",
                "linux",
                "x64",
                "vulkan",
                "bin-ubuntu-vulkan",
                format!("A GPU with Vulkan drivers. On a recent NVIDIA GPU, CUDA is {lower}."),
                None,
            ),
            build("linux-x64-cpu", "linux", "x64", "cpu", "bin-ubuntu-x64", s("Any x64 Linux. Slower, but always works."), None),
            build(
                "linux-arm64-cuda",
                "linux",
                "arm64",
                "cuda",
                "bin-ubuntu-cuda",
                s("An arm64 Linux machine with an NVIDIA GPU."),
                Some("cudart-llama"),
            ),
            build(
                "linux-arm64-vulkan",
                "linux",
                "arm64",
                "vulkan",
                "bin-ubuntu-vulkan",
                s("An arm64 Linux machine with Vulkan drivers."),
                None,
            ),
            build("linux-arm64-cpu", "linux", "arm64", "cpu", "bin-ubuntu-arm64", s("An arm64 Linux machine."), None),
        ]
    })
}

fn field<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or_default()
}

/// Whether the GPU reading came from `nvidia-smi` with at least one device.
fn nvidia_reading(gpu: Option<&Value>) -> bool {
    gpu.is_some_and(|g| field(g, "source") == "nvidia-smi" && devices(g) > 0)
}

fn devices(g: &Value) -> usize {
    g.get("devices").and_then(Value::as_array).map_or(0, Vec::len)
}

fn cuda_unsupported(cuda: Option<&Value>) -> bool {
    cuda.and_then(|c| c.get("supported")) == Some(&Value::Bool(false))
}

/// The accelerators to try, best first (`preferenceOrder`).
fn preference_order(
    platform: &str,
    gpu: Option<&Value>,
    adapters: &[Value],
    cuda: Option<&Value>,
) -> [&'static str; 5] {
    if platform == "darwin" {
        return ["metal", "cpu", "vulkan", "cuda", "hip"];
    }
    if nvidia_reading(gpu) {
        return if cuda_unsupported(cuda) {
            ["vulkan", "cuda", "cpu", "hip", "metal"]
        } else {
            ["cuda", "vulkan", "cpu", "hip", "metal"]
        };
    }
    if gpu.is_some_and(|g| devices(g) > 0) {
        return ["vulkan", "cpu", "cuda", "hip", "metal"];
    }
    if adapters.iter().any(|a| field(a, "vendor") != "other") {
        return ["vulkan", "cpu", "cuda", "hip", "metal"];
    }
    ["cpu", "vulkan", "cuda", "hip", "metal"]
}

/// The builds that could run here, best first (`buildsFor`).
pub fn builds_for(
    platform: &str,
    arch: &str,
    gpu: Option<&Value>,
    adapters: &[Value],
    cuda: Option<&Value>,
) -> Vec<Value> {
    let rank = preference_order(platform, gpu, adapters, cuda);
    let index = |b: &Value| rank.iter().position(|r| *r == field(b, "backend")).map_or(-1, |i| i as i64);
    let mut out: Vec<Value> =
        all_builds().iter().filter(|b| field(b, "platform") == platform && field(b, "arch") == arch).cloned().collect();
    out.sort_by_key(index);
    let reason = cuda
        .filter(|_| cuda_unsupported(cuda))
        .and_then(|c| c.get("reason"))
        .and_then(Value::as_str)
        .filter(|r| !r.is_empty());
    if let Some(reason) = reason {
        for b in &mut out {
            if field(b, "backend") == "cuda" {
                let requires = format!("{} {reason}", field(b, "requires"));
                b["requires"] = json!(requires);
            }
        }
    }
    out
}

/// Read `nvidia-smi --query-gpu=compute_cap,driver_version` (`cudaSupportFrom`).
pub fn cuda_support_from(stdout: Option<&str>) -> Option<Value> {
    let rows: Vec<(f64, f64)> = nekko_js::trim(stdout.unwrap_or(""))
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .map(|line| line.split(',').map(nekko_js::trim).collect::<Vec<_>>())
        .filter(|cols| cols.len() >= 2)
        .map(|cols| {
            let cap = nekko_js::string_to_number(cols[0]);
            let driver = nekko_js::string_to_number(cols[1].split('.').next().unwrap_or(""));
            (cap, driver)
        })
        .filter(|(cap, driver)| cap.is_finite() && driver.is_finite() && *cap > 0.0 && *driver > 0.0)
        .collect();
    if rows.is_empty() {
        return None;
    }
    if rows.iter().any(|(cap, _)| *cap < 7.5) {
        return Some(json!({
            "supported": false,
            "reason": "This GPU is older than the GTX 16 / RTX 20 series, so the CUDA build cannot run on it; Vulkan can.",
        }));
    }
    if rows.iter().any(|(_, driver)| *driver < 580.0) {
        return Some(json!({
            "supported": false,
            "reason": "The NVIDIA driver here is older than 580; update it to run the CUDA build.",
        }));
    }
    Some(json!({ "supported": true }))
}

/// The CUDA build, for an NVIDIA machine on a managed build of something
/// else that can run it (`cudaUpgrade`).
pub fn cuda_upgrade(
    platform: &str,
    arch: &str,
    gpu: Option<&Value>,
    installed: Option<&str>,
    cuda: Option<&Value>,
) -> Option<Value> {
    let installed = installed?;
    if installed == "cuda" || installed == "metal" || !nvidia_reading(gpu) || cuda_unsupported(cuda) {
        return None;
    }
    all_builds()
        .iter()
        .find(|b| field(b, "platform") == platform && field(b, "arch") == arch && field(b, "backend") == "cuda")
        .cloned()
}

fn re(pattern: &str, flags: &str) -> Regex {
    Regex::with_flags(pattern, flags).expect("a valid built-in pattern")
}

fn archive_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| re(r"\.(zip|tar\.gz|tgz)$", "i"))
}

/// `name.replace(ARCHIVE_RE, '')`.
fn without_archive(name: &str) -> &str {
    match archive_re().find(name) {
        Some(m) => &name[..m.start()],
        None => name,
    }
}

fn is_archive(name: &str) -> bool {
    archive_re().find(name).is_some()
}

/// The CUDA toolkit version in an asset name, as a sortable number.
fn toolkit_version(name: &str) -> f64 {
    static R: OnceLock<Regex> = OnceLock::new();
    let r = R.get_or_init(|| re(r"cuda-(\d+)(?:\.(\d+))?", ""));
    match r.find(name) {
        Some(m) => {
            let major = m.group(1).map_or(0.0, |g| nekko_js::string_to_number(&name[g]));
            let minor = m.group(2).map_or(0.0, |g| nekko_js::string_to_number(&name[g]));
            major * 1000.0 + minor
        }
        None => 0.0,
    }
}

/// The release asset for a build (`matchAsset`): its pattern, an archive,
/// the architecture as the suffix, not a runtime-library companion; the
/// highest CUDA toolkit wins.
pub fn match_asset(build: &Value, names: &[String]) -> Option<String> {
    let pattern = field(build, "assetPattern");
    let arch = field(build, "arch");
    let mut hits: Vec<&String> = names
        .iter()
        .filter(|n| {
            n.contains(pattern)
                && is_archive(n)
                && without_archive(n).ends_with(&format!("-{arch}"))
                && !n.starts_with("cudart-")
        })
        .collect();
    hits.sort_by(|a, b| {
        toolkit_version(a)
            .partial_cmp(&toolkit_version(b))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| nekko_js::locale_compare(a, b))
    });
    hits.last().map(|s| s.to_string())
}

/// The runtime-library archive that belongs with a chosen asset (`matchCompanion`).
pub fn match_companion(build: &Value, asset: &str, names: &[String]) -> Option<String> {
    let companion = build.get("companionPattern").and_then(Value::as_str).filter(|c| !c.is_empty())?;
    static R: OnceLock<Regex> = OnceLock::new();
    let r = R.get_or_init(|| re(r"(bin-[a-z]+-cuda-[\d.]+-\w+)$", ""));
    let base = without_archive(asset);
    let variant = r.find(base).and_then(|m| m.group(1)).map(|g| base[g].to_string())?;
    names
        .iter()
        .find(|n| n.starts_with(companion) && is_archive(n) && without_archive(n).ends_with(&format!("-{variant}")))
        .cloned()
}

/// stable-diffusion.cpp's builds (`diffusionBuilds`).
pub fn diffusion_builds(platform: &str, arch: &str, gpu: Option<&Value>) -> Vec<Value> {
    builds_for(platform, arch, gpu, &[], None)
        .into_iter()
        .filter(|b| {
            (platform == "win32" && arch == "x64")
                || (platform == "linux" && arch == "x64" && field(b, "backend") != "cuda")
                || (platform == "darwin" && arch == "arm64")
        })
        .map(|mut b| {
            let backend = field(&b, "backend").to_string();
            let id = format!("sd-{}", field(&b, "id"));
            let o = b.as_object_mut().expect("a build is an object");
            o.insert("id".into(), json!(id));
            o.insert("assetPattern".into(), json!(backend));
            if backend == "cuda" {
                o.insert("companionPattern".into(), json!("cudart-sd"));
            } else {
                o.shift_remove("companionPattern");
            }
            b
        })
        .collect()
}

/// The release asset for a stable-diffusion.cpp build (`matchDiffusionAsset`).
pub fn match_diffusion_asset(build: &Value, names: &[String]) -> Option<String> {
    let backend = field(build, "backend");
    let pattern = match field(build, "platform") {
        "darwin" => r"bin-Darwin-.*-arm64\.zip$".to_string(),
        "linux" => {
            let tail = match backend {
                "cpu" => String::new(),
                "hip" => "-rocm-.*".into(),
                b => format!("-{b}"),
            };
            format!(r"bin-Linux-.*-x86_64{tail}\.zip$")
        }
        _ => {
            let b = match backend {
                "hip" => "rocm-.*",
                "cuda" => "cuda12",
                b => b,
            };
            format!(r"bin-win-{b}-x64\.zip$")
        }
    };
    let r = re(&pattern, "");
    names.iter().find(|n| n.starts_with("sd-") && r.find(n).is_some()).cloned()
}

/// The CUDA runtime stable-diffusion.cpp's CUDA build needs (`matchDiffusionCompanion`).
pub fn match_diffusion_companion(build: &Value, names: &[String]) -> Option<String> {
    (field(build, "backend") == "cuda")
        .then(|| names.iter().find(|n| *n == "cudart-sd-bin-win-cu12-x64.zip").cloned())
        .flatten()
}
