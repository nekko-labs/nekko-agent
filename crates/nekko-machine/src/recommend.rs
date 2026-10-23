//! Model recommendations (`machine:recommendations`): which model to run for
//! each task on this machine, with the speed to expect and the memory left
//! over, before anything is downloaded.
//!
//! The feed (`model-feed.json`) is built offline by `scripts/model-feed.mjs`
//! from an editorial list and the files' own headers; nothing here reaches
//! the network. For each task the candidates are tried best first, each at its
//! best quant first, and the pick is the first that fits the memory budget
//! with room to spare and is fast enough for the task.
//!
//! **Memory** is weights + KV cache + compute buffers, the planner's terms
//! (`nekko-engine`'s `capacity.rs`), with the KV cache counted layer by layer
//! as the feed records it: recurrent layers keep none, sliding-window layers
//! stop growing at their window.
//!
//! **Speed** is decode tokens/s at the start of a conversation. A figure
//! measured on this class of hardware with this file is used as is. Otherwise
//! it is estimated: decode is bound by memory bandwidth, so
//! `efficiency x bandwidth / bytes read per token`, with the efficiency
//! measured per backend and the bandwidth from the vendor's specification.
//! A backend whose efficiency is borrowed, or hardware not in the table, says
//! so; a GPU the table does not know gets no figure rather than a guess.

use crate::measured::{LocalSpeeds, machine_key};
use crate::profile::HardwareProfile;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const GIB: f64 = 1024.0 * 1024.0 * 1024.0;
const MIB: f64 = 1024.0 * 1024.0;

/// What the display, the driver and other programs keep on a discrete GPU.
const VRAM_RESERVE_BYTES: f64 = GIB;
/// What the OS and the user's normal apps keep of system RAM (as the readiness advisor holds back).
const RAM_RESERVE_BYTES: f64 = 4.0 * GIB;
/// A pick may use at most this share of the budget, leaving room for a longer conversation.
const PICK_SHARE: f64 = 0.9;
/// Up to this share the fit is comfortable; above it, tight.
const COMFORT_SHARE: f64 = 0.75;
/// llama.cpp's default micro-batch: a sliding-window layer holds its window plus one.
const UBATCH_TOKENS: f64 = 512.0;
/// The sequences `llama-server` serves when the engine starts a one-slot load
/// (no `--parallel`), each with its own window over one unified cache.
const AUTO_SEQUENCES: f64 = 4.0;
/// The planner's compute-buffer allowance (`estimate_overhead_bytes` in `nekko-engine`).
const OVERHEAD_FLOOR_BYTES: f64 = 256.0 * MIB;
const GRAPH_CONTEXT_CAP: f64 = 8192.0;

/* ------------------------------------------------------------------ feed */

/// The bundled feed, the one shipped with this build.
pub fn bundled_feed() -> &'static Feed {
    static F: std::sync::OnceLock<Feed> = std::sync::OnceLock::new();
    F.get_or_init(|| serde_json::from_str(include_str!("model-feed.json")).expect("the bundled model feed parses"))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Feed {
    pub format: u32,
    pub version: String,
    pub tasks: Vec<Task>,
    pub models: Vec<Model>,
    pub hardware: Hardware,
    pub calibration: BTreeMap<String, Calibration>,
    #[serde(default)]
    pub measured: Vec<Measured>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub label: String,
    pub context_tokens: f64,
    /// Below this a model is too slow for the task. Absent where decode speed
    /// is not what the task waits on (embeddings).
    pub min_tokens_per_second: Option<f64>,
    /// The task needs the model's image projector loaded beside it.
    #[serde(default)]
    pub projector: bool,
    pub candidates: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: String,
    pub repo: String,
    pub name: String,
    pub owner: String,
    pub max_context: Option<f64>,
    pub geometry: Geometry,
    pub kv: Kv,
    /// Present on a mixture-of-experts model.
    pub experts: Option<Experts>,
    pub quants: Vec<Quant>,
    pub projector: Option<Projector>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Geometry {
    pub layers: Option<f64>,
    pub head_dim: Option<f64>,
}

/// KV cache per token of context, f16, split by how the layers grow.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Kv {
    pub full_bytes_per_token: f64,
    #[serde(default)]
    pub swa_bytes_per_token: f64,
    #[serde(default)]
    pub sliding_window: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Experts {
    pub total: f64,
    pub used: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quant {
    pub label: String,
    pub files: Vec<String>,
    pub size_bytes: f64,
    /// Bytes one decoded token reads: the weights less lookup tables and unrouted experts.
    pub bytes_per_token: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Projector {
    pub file: String,
    pub size_bytes: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hardware {
    pub source: String,
    pub gpus: Vec<HardwareClass>,
    pub cpu: CpuClass,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareClass {
    pub id: String,
    #[serde(rename = "match")]
    pub matches: String,
    pub bandwidth_g_bps: f64,
    pub gpu_cores: Option<u32>,
    pub vram_gb: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuClass {
    pub id: String,
    pub bandwidth_g_bps: f64,
    pub note: String,
}

/// A backend's measured decode efficiency, or the backend it borrows one from.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Calibration {
    pub efficiency: Option<f64>,
    /// The same for mixture-of-experts models, which use bandwidth less well
    /// (routing, many small expert reads).
    pub moe_efficiency: Option<f64>,
    pub borrowed_from: Option<String>,
}

/// A decode speed measured on real hardware with the feed's own file.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Measured {
    pub hardware: String,
    pub model: String,
    pub quant: String,
    pub tokens_per_second: f64,
}

/* ---------------------------------------------------------------- answer */

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recommendations {
    pub feed_version: String,
    pub hardware: HardwareMatch,
    pub budget: Budget,
    pub tasks: Vec<TaskPick>,
}

/// Which row of the hardware table this machine is, and what it runs on.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareMatch {
    /// The device the budget is measured against (`None` on a CPU-only machine).
    pub device: Option<String>,
    /// The table row, `None` for a GPU the table does not list.
    pub class_id: Option<String>,
    pub bandwidth_g_bps: Option<f64>,
    pub backend: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Placement {
    Gpu,
    Unified,
    Cpu,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Budget {
    pub bytes: f64,
    pub placement: Placement,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Fit {
    Fits,
    Tight,
    TooBig,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SpeedBasis {
    /// The median of this machine's own recent replies with this file.
    MeasuredHere,
    /// Measured on this class of hardware with this file.
    Measured,
    /// From bandwidth, with this backend's measured efficiency.
    Estimated,
    /// From bandwidth, with an efficiency measured on another backend.
    EstimatedBorrowed,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Speed {
    pub tokens_per_second: f64,
    pub basis: SpeedBasis,
    /// How many replies a `measuredHere` figure is the median of.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub samples: Option<usize>,
}

/// This machine's own measurements, and which machine it is.
struct Local<'a> {
    speeds: &'a LocalSpeeds,
    machine: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Choice {
    pub model_id: String,
    pub name: String,
    pub owner: String,
    pub repo: String,
    pub quant: String,
    /// The label `engine:downloadModel` takes for this quant: the catalog's,
    /// which drops prefixes such as `UD-` (`...-UD-Q4_K_M.gguf` is `Q4_K_M`).
    pub download_label: String,
    /// Every file to download: the weights (all shards) and the projector when the task needs it.
    pub files: Vec<String>,
    pub download_bytes: f64,
    /// Weights + KV cache at the task's context + compute buffers.
    pub memory_bytes: f64,
    /// Budget left after loading it (negative when it does not fit).
    pub headroom_bytes: f64,
    pub context_tokens: f64,
    pub placement: Placement,
    pub fit: Fit,
    pub speed: Option<Speed>,
    /// Slower than the task's minimum.
    pub too_slow: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskPick {
    pub task: String,
    pub label: String,
    pub min_tokens_per_second: Option<f64>,
    pub pick: Option<Choice>,
    /// Nothing that fits is fast enough; the pick is the fastest that fits.
    pub below_target_speed: bool,
    /// Each candidate at the best quant that fits (or its smallest, when none does), best first.
    pub options: Vec<Choice>,
}

/* --------------------------------------------------------------- matching */

fn mobile(name: &str) -> bool {
    let n = name.to_lowercase();
    n.contains("laptop") || n.contains("mobile") || n.contains("max-q")
}

/// The table row a device is. A laptop part never matches a desktop row: same
/// name, narrower bus.
pub fn match_class<'a>(feed: &'a Feed, name: &str, vram_bytes: f64, cores: Option<u32>) -> Option<&'a HardwareClass> {
    if mobile(name) {
        return None;
    }
    let lower = name.to_lowercase();
    feed.hardware.gpus.iter().find(|c| {
        lower.contains(&c.matches.to_lowercase())
            && c.gpu_cores.is_none_or(|want| cores == Some(want))
            && c.vram_gb.is_none_or(|gb| (vram_bytes / GIB - gb).abs() < 1.0)
    })
}

/// The backend a recommendation runs on: the engine's when one is installed,
/// else the best this machine can run.
fn backend_of(profile: &HardwareProfile) -> String {
    if let Some(e) = &profile.engine {
        return e.backend.clone();
    }
    for b in ["cuda", "metal", "vulkan"] {
        if profile.backends.iter().any(|x| x == b) {
            return b.into();
        }
    }
    "cpu".into()
}

/// The efficiency for a backend and whether it is its own.
///
/// A mixture-of-experts model takes the backend's own MoE efficiency, else
/// its dense one scaled by the MoE-to-dense ratio measured on another backend
/// (and is then borrowed).
fn efficiency(feed: &Feed, backend: &str, moe: bool) -> Option<(f64, bool)> {
    let c = feed.calibration.get(backend)?;
    let dense = match c.efficiency {
        Some(e) => (e, true),
        None => (feed.calibration.get(c.borrowed_from.as_deref()?)?.efficiency?, false),
    };
    if !moe {
        return Some(dense);
    }
    if let (Some(e), true) = (c.moe_efficiency, dense.1) {
        return Some((e, true));
    }
    let ratio = feed.calibration.values().find_map(|o| Some(o.moe_efficiency? / o.efficiency?))?;
    Some((dense.0 * ratio, false))
}

/* ----------------------------------------------------------------- memory */

/// KV cache bytes at `context` tokens, as the engine loads a model (one slot:
/// `llama-server`'s four unified sequences), the same figure as the engine
/// planner's `kv_cache_bytes`.
pub fn kv_bytes(kv: &Kv, context: f64) -> f64 {
    let swa_tokens =
        if kv.sliding_window > 0.0 { context.min(AUTO_SEQUENCES * kv.sliding_window + UBATCH_TOKENS) } else { context };
    kv.full_bytes_per_token * context + kv.swa_bytes_per_token * swa_tokens
}

/// The planner's compute-buffer allowance.
pub fn overhead_bytes(g: &Geometry, context: f64) -> f64 {
    let per_token = g.layers.unwrap_or(32.0) * g.head_dim.unwrap_or(128.0) * 4.0;
    OVERHEAD_FLOOR_BYTES + per_token * context.min(GRAPH_CONTEXT_CAP)
}

/* -------------------------------------------------------------- evaluate */

struct Target {
    placement: Placement,
    budget: f64,
    class_id: Option<String>,
    bandwidth_g_bps: Option<f64>,
    /// The backend whose efficiency speeds are estimated with.
    backend: String,
}

fn cpu_target(feed: &Feed, profile: &HardwareProfile) -> Target {
    Target {
        placement: Placement::Cpu,
        budget: (profile.ram_bytes - RAM_RESERVE_BYTES).max(0.0),
        class_id: Some(feed.hardware.cpu.id.clone()),
        bandwidth_g_bps: Some(feed.hardware.cpu.bandwidth_g_bps),
        backend: "cpu".into(),
    }
}

/// What the GPU of this machine can give a model: the roomiest single device
/// (two cards are not pooled), or on Apple Silicon the share of the unified
/// pool macOS lets the GPU wire by default (about two thirds up to 36 GB,
/// three quarters above).
fn gpu_target(feed: &Feed, profile: &HardwareProfile, backend: &str) -> Option<(Target, String)> {
    let gpu = profile.gpus.iter().max_by(|a, b| a.vram_bytes.total_cmp(&b.vram_bytes))?;
    let class = match_class(feed, &gpu.name, gpu.vram_bytes, gpu.cores);
    let (placement, budget) = if profile.unified {
        let share = if profile.ram_bytes > 36.0 * GIB { 0.75 } else { 2.0 / 3.0 };
        (Placement::Unified, profile.ram_bytes * share)
    } else {
        (Placement::Gpu, (gpu.vram_bytes - VRAM_RESERVE_BYTES).max(0.0))
    };
    let target = Target {
        placement,
        budget,
        class_id: class.map(|c| c.id.clone()),
        bandwidth_g_bps: class.map(|c| c.bandwidth_g_bps),
        backend: backend.into(),
    };
    Some((target, gpu.name.clone()))
}

fn speed_for(feed: &Feed, target: &Target, model: &Model, quant: &Quant, local: &Local) -> Option<Speed> {
    if let Some(here) = quant.files.first().and_then(|f| local.speeds.speed(f, &local.machine)) {
        return Some(Speed {
            tokens_per_second: here.tokens_per_second,
            basis: SpeedBasis::MeasuredHere,
            samples: Some(here.samples),
        });
    }
    if let Some(class) = &target.class_id
        && let Some(m) =
            feed.measured.iter().find(|m| &m.hardware == class && m.model == model.id && m.quant == quant.label)
    {
        return Some(Speed { tokens_per_second: m.tokens_per_second, basis: SpeedBasis::Measured, samples: None });
    }
    let bandwidth = target.bandwidth_g_bps?;
    let (eff, own) = efficiency(feed, &target.backend, model.experts.is_some())?;
    if quant.bytes_per_token <= 0.0 {
        return None;
    }
    let tps = eff * bandwidth * 1e9 / quant.bytes_per_token;
    Some(Speed {
        tokens_per_second: tps.round(),
        basis: if own { SpeedBasis::Estimated } else { SpeedBasis::EstimatedBorrowed },
        samples: None,
    })
}

fn choice(feed: &Feed, task: &Task, model: &Model, quant: &Quant, target: &Target, local: &Local) -> Choice {
    let context = model.max_context.map_or(task.context_tokens, |m| m.min(task.context_tokens));
    let projector = model.projector.as_ref().filter(|_| task.projector);
    let weights = quant.size_bytes + projector.map_or(0.0, |p| p.size_bytes);
    let memory = weights + kv_bytes(&model.kv, context) + overhead_bytes(&model.geometry, context);
    let fit = if memory <= target.budget * COMFORT_SHARE {
        Fit::Fits
    } else if memory <= target.budget * PICK_SHARE {
        Fit::Tight
    } else {
        Fit::TooBig
    };
    let speed = if task.min_tokens_per_second.is_some() { speed_for(feed, target, model, quant, local) } else { None };
    let too_slow = match (&speed, task.min_tokens_per_second) {
        (Some(s), Some(min)) => s.tokens_per_second < min,
        _ => false,
    };
    let mut files = quant.files.clone();
    files.extend(projector.map(|p| p.file.clone()));
    Choice {
        model_id: model.id.clone(),
        name: model.name.clone(),
        owner: model.owner.clone(),
        repo: model.repo.clone(),
        quant: quant.label.clone(),
        download_label: download_label(&quant.files[0]),
        files,
        download_bytes: weights,
        memory_bytes: memory.round(),
        headroom_bytes: (target.budget - memory).round(),
        context_tokens: context,
        placement: target.placement,
        fit,
        speed,
        too_slow,
    }
}

/// The catalog's label for a quant file (`quant_label` in `nekko-engine`'s
/// `catalog.rs`): shard suffix dropped, then the quant name ending the file
/// name, upper-cased; the bare name when there is none.
pub fn download_label(file: &str) -> String {
    let base = file.rsplit('/').next().unwrap_or(file);
    let lower = base.to_lowercase();
    let mut stem = &base[..lower.rfind(".gguf").unwrap_or(base.len())];
    // `-00001-of-00003`
    let b = stem.as_bytes();
    if b.len() > 15 && b[b.len() - 15] == b'-' && stem[stem.len() - 9..].starts_with("-of-") {
        let digits = |s: &str| s.len() == 5 && s.bytes().all(|c| c.is_ascii_digit());
        if digits(&stem[stem.len() - 14..stem.len() - 9]) && digits(&stem[stem.len() - 5..]) {
            stem = &stem[..stem.len() - 15];
        }
    }
    // The last `-`, `_` or `.` segment that names a quant, with what follows it.
    let is_quant = |tail: &str| {
        let t = tail.to_uppercase();
        let numbered = |prefix: &str| {
            t.strip_prefix(prefix).is_some_and(|r| r.starts_with(|c: char| c.is_ascii_digit()))
                && t.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
        };
        numbered("IQ") || numbered("Q") || matches!(t.as_str(), "BF16" | "F16" | "F32") || t.starts_with("MXFP4")
    };
    for (i, c) in stem.char_indices() {
        if matches!(c, '-' | '_' | '.') && is_quant(&stem[i + 1..]) {
            return stem[i + 1..].to_uppercase();
        }
    }
    stem.to_string()
}

fn tokens_per_second(o: &Choice) -> f64 {
    o.speed.as_ref().map_or(0.0, |s| s.tokens_per_second)
}

/// The quant to offer of one model, quants being listed best first: the best
/// that fits comfortably and is fast enough, else the best that fits tightly
/// and is fast enough (a smaller quant with room to spare beats a bigger one
/// at the edge), else the fastest that fits, else the smallest.
fn best_quant(all: &[Choice]) -> Option<&Choice> {
    let fast = |fit: Fit| all.iter().find(|o| o.fit == fit && !o.too_slow);
    fast(Fit::Fits)
        .or_else(|| fast(Fit::Tight))
        .or_else(|| {
            all.iter()
                .filter(|o| o.fit != Fit::TooBig)
                .max_by(|a, b| tokens_per_second(a).total_cmp(&tokens_per_second(b)))
        })
        .or_else(|| all.iter().min_by(|a, b| a.memory_bytes.total_cmp(&b.memory_bytes)))
}

/// Each candidate at the quant to offer, in the task's order.
fn options(feed: &Feed, task: &Task, target: &Target, local: &Local) -> Vec<Choice> {
    task.candidates
        .iter()
        .filter_map(|id| feed.models.iter().find(|m| &m.id == id))
        .filter(|m| !task.projector || m.projector.is_some())
        .filter_map(|m| {
            let all: Vec<Choice> = m.quants.iter().map(|q| choice(feed, task, m, q, target, local)).collect();
            best_quant(&all).cloned()
        })
        .collect()
}

fn choose(options: &[Choice]) -> (Option<Choice>, bool) {
    let fitting = || options.iter().filter(|o| o.fit != Fit::TooBig);
    if let Some(o) = fitting().find(|o| !o.too_slow) {
        return (Some(o.clone()), false);
    }
    let fastest = fitting().max_by(|a, b| tokens_per_second(a).total_cmp(&tokens_per_second(b)));
    (fastest.cloned(), fastest.is_some())
}

/// `machine:recommendations`: a pick per task for this profile.
///
/// A quant this machine has run takes its own measured speed (`local`), in
/// what is shown and in whether it is fast enough for the task.
pub fn recommend(profile: &HardwareProfile, feed: &Feed, local: &LocalSpeeds) -> Recommendations {
    let local = Local { speeds: local, machine: machine_key(profile) };
    let backend = backend_of(profile);
    let gpu = if backend == "cpu" { None } else { gpu_target(feed, profile, &backend) };
    let cpu = cpu_target(feed, profile);
    let main = gpu.as_ref().map_or(&cpu, |(t, _)| t);

    let tasks = feed
        .tasks
        .iter()
        .map(|task| {
            let mut opts = options(feed, task, main, &local);
            let (mut pick, mut slow) = choose(&opts);
            // A discrete GPU too small for every candidate: what runs on the CPU instead.
            if pick.is_none() && main.placement == Placement::Gpu {
                opts = options(feed, task, &cpu, &local);
                (pick, slow) = choose(&opts);
            }
            TaskPick {
                task: task.id.clone(),
                label: task.label.clone(),
                min_tokens_per_second: task.min_tokens_per_second,
                pick,
                below_target_speed: slow,
                options: opts,
            }
        })
        .collect();

    Recommendations {
        feed_version: feed.version.clone(),
        hardware: HardwareMatch {
            device: gpu.as_ref().map(|(_, name)| name.clone()),
            class_id: main.class_id.clone(),
            bandwidth_g_bps: main.bandwidth_g_bps,
            backend: if main.placement == Placement::Cpu { "cpu".into() } else { backend },
        },
        budget: Budget { bytes: main.budget.round(), placement: main.placement },
        tasks,
    }
}
