//! Where every byte of a load lands: graphics memory, system memory or the
//! SSD. The load drawer's meter and its "Use recommended settings" button both
//! read from here.
//!
//! [`crate::capacity::compute_fit`] answers "does it fit on the GPU" with one
//! pool and a spill. That cannot describe the setups people actually use to run
//! a big mixture-of-experts model on a small card: the experts (most of the
//! bytes, a few reads per token) in RAM, the core and the KV cache on the GPU,
//! and a lookup table paged from the file. This planner places weights by kind
//! (see [`crate::capacity::WeightLayout`]) under the same KV and overhead math, so the two agree
//! on everything they both describe. It is a separate function so every
//! recorded `compute_fit` answer stays exactly as it was.
//!
//! Like the rest of the planner it is pure: facts in, placement out.

use crate::capacity::{FitRequest, Hardware, ModelFacts, estimate_overhead_bytes, jmax, kv_cache_bytes};
use crate::{js_round, num, to_fixed};
use serde_json::{Map, Value, json};

const GB: f64 = 1024.0 * 1024.0 * 1024.0;
const MB: f64 = 1024.0 * 1024.0;
/// Kept free on the GPU, as `compute_fit` keeps it (`HEADROOM_MARGIN_BYTES`).
const VRAM_MARGIN: f64 = 768.0 * MB;
/// Left to the OS and every other app, as `compute_fit` leaves it.
const OS_RESERVE: f64 = 2.0 * GB;
/// Less slack than this in RAM reads as "just fits".
const RAM_MARGIN: f64 = GB;
/// A compute buffer for whatever runs on the CPU (experts, FFN, layers).
const CPU_BUFFER: f64 = 512.0 * MB;
/// Context stops the recommender tries, largest first.
const STOPS: [f64; 8] = [262144.0, 131072.0, 65536.0, 32768.0, 16384.0, 8192.0, 4096.0, 2048.0];
/// Context a split is first sized for before it grows: enough for real coding work.
const USEFUL_CONTEXT: f64 = 32768.0;
/// A model that does not say how much context it supports is offered this much.
const UNKNOWN_MAX_CONTEXT: f64 = 32768.0;

/// Where the layers run (`runOn`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RunOn {
    Gpu,
    Hybrid,
    Cpu,
}

/// One load, in the drawer's terms (`PlacementRequest`).
#[derive(Clone, Debug, PartialEq)]
pub struct Request {
    pub run_on: RunOn,
    /// Context each session gets; the launch asks for `context x sessions`.
    pub context_per_session: f64,
    pub sessions: f64,
    pub kv_cache_dtype: String,
    /// Layers on the GPU in Hybrid (llama.cpp offloads the last ones).
    pub gpu_layers: f64,
    /// The first N layers keep their experts in RAM (`--n-cpu-moe`).
    pub cpu_moe_layers: f64,
    /// The first N layers run their feed-forward from RAM (`--n-cpu-ffn`).
    pub cpu_ffn_layers: f64,
    /// `false` keeps the KV cache in RAM (`-nkvo`).
    pub kv_on_gpu: bool,
    /// Map the file rather than read it in. Required for paging from disk.
    pub mmap: bool,
    /// Lock the mapped file in RAM (`--load-mode mmap+mlock`).
    pub pin: bool,
    /// Lookup tables read row by row from the file (`--lazy-mode on`).
    pub tables_on_disk: bool,
    /// Spare VRAM given to llama.cpp's expert cache (`--moe-cache-mib`).
    pub moe_cache_bytes: f64,
}

impl Request {
    pub fn base(layers: f64) -> Self {
        Self {
            run_on: RunOn::Gpu,
            context_per_session: 8192.0,
            sessions: 1.0,
            kv_cache_dtype: "f16".into(),
            gpu_layers: layers,
            cpu_moe_layers: 0.0,
            cpu_ffn_layers: 0.0,
            kv_on_gpu: true,
            mmap: true,
            pin: false,
            tables_on_disk: true,
            moe_cache_bytes: 0.0,
        }
    }

    pub fn from_value(v: &Value, layers: f64) -> Self {
        let d = Self::base(layers);
        let n = |k: &str, or: f64| v.get(k).and_then(Value::as_f64).filter(|x| x.is_finite()).unwrap_or(or);
        let b = |k: &str, or: bool| v.get(k).and_then(Value::as_bool).unwrap_or(or);
        Self {
            run_on: match v.get("runOn").and_then(Value::as_str) {
                Some("hybrid") => RunOn::Hybrid,
                Some("cpu") => RunOn::Cpu,
                _ => RunOn::Gpu,
            },
            context_per_session: n("contextTokens", d.context_per_session).max(256.0),
            sessions: n("sessions", 1.0).clamp(1.0, 64.0).floor(),
            kv_cache_dtype: v.get("kvCacheDtype").and_then(Value::as_str).unwrap_or("f16").to_string(),
            gpu_layers: n("gpuLayers", layers).clamp(0.0, layers.max(0.0)),
            cpu_moe_layers: n("cpuMoeLayers", 0.0).clamp(0.0, layers.max(0.0)),
            cpu_ffn_layers: n("cpuFfnLayers", 0.0).clamp(0.0, layers.max(0.0)),
            kv_on_gpu: b("kvOnGpu", true),
            mmap: b("mmap", true),
            pin: b("pin", false),
            tables_on_disk: b("tablesOnDisk", true),
            moe_cache_bytes: n("moeCacheBytes", 0.0).max(0.0),
        }
    }

    pub fn to_value(&self) -> Value {
        json!({
            "runOn": match self.run_on { RunOn::Gpu => "gpu", RunOn::Hybrid => "hybrid", RunOn::Cpu => "cpu" },
            "contextTokens": num(self.context_per_session),
            "sessions": num(self.sessions),
            "kvCacheDtype": self.kv_cache_dtype,
            "gpuLayers": num(self.gpu_layers),
            "cpuMoeLayers": num(self.cpu_moe_layers),
            "cpuFfnLayers": num(self.cpu_ffn_layers),
            "kvOnGpu": self.kv_on_gpu,
            "mmap": self.mmap,
            "pin": self.pin,
            "tablesOnDisk": self.tables_on_disk,
            "moeCacheBytes": num(self.moe_cache_bytes),
        })
    }
}

/// Bytes in one place, by what they are for.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Share {
    pub weights: f64,
    pub kv: f64,
    pub overhead: f64,
    /// RAM only: the GPU-resident part of a pinned file, held a second time.
    pub pinned: f64,
}

impl Share {
    fn sum(&self) -> f64 {
        self.weights + self.kv + self.overhead + self.pinned
    }
}

/// The answer (`Placement`).
#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    /// `fits`, `tight`, `disk` (works, reads weights from the SSD), `wont-load`, `unknown`.
    pub verdict: &'static str,
    /// Why it will not load: `vram`, `ram`, `context-over-max` or `missing-metadata`.
    pub reason: Option<&'static str>,
    /// How far over, for `vram` and `ram`.
    pub short_by: f64,
    pub unified: bool,
    pub device_name: Option<String>,
    /// Graphics memory: its size, what other apps use, and what may be ours.
    pub vram_total: f64,
    pub vram_other: f64,
    pub vram_avail: f64,
    pub vram: Share,
    pub ram_total: f64,
    pub ram_other: f64,
    pub ram_avail: f64,
    pub ram: Share,
    /// Lookup tables paged from the file.
    pub disk_tables: f64,
    /// Mapped weights that do not fit in RAM and are read from the SSD as needed.
    pub disk_overflow: f64,
}

impl Plan {
    pub fn to_value(&self) -> Value {
        let share = |s: &Share| json!({ "weightsBytes": num(s.weights), "kvCacheBytes": num(s.kv), "overheadBytes": num(s.overhead), "pinnedBytes": num(s.pinned) });
        let mut o = Map::new();
        o.insert("verdict".into(), json!(self.verdict));
        if let Some(r) = self.reason {
            o.insert("reason".into(), json!(r));
            o.insert("shortByBytes".into(), num(self.short_by));
        }
        o.insert("unified".into(), json!(self.unified));
        o.insert("deviceName".into(), self.device_name.as_ref().map_or(Value::Null, |n| json!(n)));
        o.insert(
            "vram".into(),
            json!({ "totalBytes": num(self.vram_total), "otherBytes": num(self.vram_other), "availBytes": num(self.vram_avail), "model": share(&self.vram) }),
        );
        o.insert(
            "ram".into(),
            json!({ "totalBytes": num(self.ram_total), "otherBytes": num(self.ram_other), "availBytes": num(self.ram_avail), "model": share(&self.ram) }),
        );
        o.insert(
            "disk".into(),
            json!({ "tableBytes": num(self.disk_tables), "overflowBytes": num(self.disk_overflow) }),
        );
        o.insert("spareVramBytes".into(), num(jmax(0.0, self.vram_avail - self.vram.sum() - VRAM_MARGIN)));
        Value::Object(o)
    }

    fn ok(&self, allow_disk: bool) -> bool {
        matches!(self.verdict, "fits" | "tight") || (allow_disk && self.verdict == "disk")
    }
}

/// The largest context this model may be asked for.
fn max_context(facts: &ModelFacts) -> f64 {
    facts.max_context.filter(|m| *m > 0.0).unwrap_or(UNKNOWN_MAX_CONTEXT)
}

/// Place one load. `resident_vram` is what this model already holds on the GPU
/// (a reload): the free reading does not include it, but the new load gets it back.
pub fn place(facts: &ModelFacts, req: &Request, hw: &Hardware, resident_vram: f64) -> Plan {
    let device = hw.devices.iter().filter(|d| d.free.is_finite()).max_by(|a, b| a.free.total_cmp(&b.free));
    let unified = hw.unified && device.is_some();
    let run_on = if device.is_none() { RunOn::Cpu } else { req.run_on };
    let ram_free = if hw.ram_free.is_finite() { hw.ram_free } else { 0.0 };
    let mut plan = Plan {
        verdict: "fits",
        reason: None,
        short_by: 0.0,
        unified,
        device_name: device.map(|d| d.name.clone()),
        vram_total: device.map_or(0.0, |d| d.total),
        vram_other: device.map_or(0.0, |d| jmax(0.0, d.total - d.free - resident_vram)),
        vram_avail: device.map_or(0.0, |d| d.free + resident_vram),
        vram: Share::default(),
        ram_total: if hw.ram_total.is_finite() { hw.ram_total } else { 0.0 },
        ram_other: jmax(0.0, hw.ram_total - ram_free),
        ram_avail: jmax(0.0, ram_free - OS_RESERVE),
        ram: Share::default(),
        disk_tables: 0.0,
        disk_overflow: 0.0,
    };
    let fit_req = FitRequest {
        // Full-attention layers in a layout-read cache hold the whole pool once;
        // the uniform estimate is per slot, as Ollama allocates it.
        context_tokens: if facts.kv_layout.is_some() {
            req.context_per_session * req.sessions
        } else {
            req.context_per_session
        },
        parallel_slots: req.sessions,
        kv_cache_dtype: req.kv_cache_dtype.clone(),
        gpu_layer_fraction: 1.0,
    };
    let (Some(weights), Some(kv)) = (facts.weights.filter(|w| *w > 0.0), kv_cache_bytes(facts, &fit_req)) else {
        plan.verdict = "unknown";
        plan.reason = Some("missing-metadata");
        return plan;
    };
    if req.context_per_session > max_context(facts) && facts.max_context.is_some() {
        plan.verdict = "wont-load";
        plan.reason = Some("context-over-max");
        return plan;
    }
    let overhead = estimate_overhead_bytes(facts, &fit_req, None);
    let w = facts.weight_layout.unwrap_or_default();
    let layers = facts.layers.filter(|l| *l > 0.0).unwrap_or(1.0);
    let table = weights * w.table_share;
    let body = weights - table;
    let expert = weights * w.expert_share / layers;
    let ffn = weights * w.ffn_share / layers;
    let rest = jmax(0.0, body / layers - expert - ffn);

    // Lookup tables never go to the GPU: paged from the file, or held in RAM.
    let tables_paged = table > 0.0 && req.mmap && req.tables_on_disk;
    if tables_paged {
        plan.disk_tables = table;
    } else {
        plan.ram.weights += table;
    }

    if unified || run_on == RunOn::Gpu {
        plan.vram = Share { weights: body, kv, overhead, pinned: 0.0 };
    } else if run_on == RunOn::Cpu {
        plan.ram.weights += body;
        plan.ram.kv = kv;
        plan.ram.overhead = overhead;
    } else {
        let g = req.gpu_layers.min(layers);
        // The GPU holds the last `g` layers; the CPU options name the first N.
        let on_gpu = |cpu_first: f64| g.min(jmax(0.0, layers - cpu_first));
        let gpu_weights = g * rest
            + on_gpu(if w.is_moe() { req.cpu_moe_layers } else { 0.0 }) * expert
            + on_gpu(req.cpu_ffn_layers) * ffn;
        let gpu_kv = if req.kv_on_gpu { kv * g / layers } else { 0.0 };
        plan.vram = Share { weights: gpu_weights + req.moe_cache_bytes, kv: gpu_kv, overhead, pinned: 0.0 };
        plan.ram.weights += body - gpu_weights;
        plan.ram.kv = kv - gpu_kv;
        if body - gpu_weights > 0.0 {
            plan.ram.overhead = CPU_BUFFER;
        }
    }
    if req.pin && !unified {
        // mlock holds every mapped page, the GPU's copy and a paged table included.
        plan.ram.pinned = plan.vram.weights - req.moe_cache_bytes.min(plan.vram.weights) + plan.disk_tables;
        plan.disk_tables = 0.0;
    }

    if unified {
        // One pool: what the GPU may wire is the device's free figure.
        let need = plan.vram.sum() + plan.ram.sum();
        plan.ram_avail = plan.vram_avail;
        if need > plan.vram_avail {
            plan.verdict = "wont-load";
            plan.reason = Some("vram");
            plan.short_by = need - plan.vram_avail;
        } else if plan.vram_avail - need < VRAM_MARGIN {
            plan.verdict = "tight";
        }
        return plan;
    }
    let vram_need = plan.vram.sum();
    if vram_need > plan.vram_avail {
        plan.verdict = "wont-load";
        plan.reason = Some("vram");
        plan.short_by = vram_need - plan.vram_avail;
        return plan;
    }
    let ram_need = plan.ram.sum();
    if ram_need > plan.ram_avail {
        let over = ram_need - plan.ram_avail;
        // Mapped, unpinned weights can be read back from the file on demand.
        let pageable = if req.mmap && !req.pin { plan.ram.weights } else { 0.0 };
        if over <= pageable {
            plan.verdict = "disk";
            plan.disk_overflow = over;
        } else {
            plan.verdict = "wont-load";
            plan.reason = Some("ram");
            plan.short_by = over - pageable;
        }
        return plan;
    }
    if (device.is_some() && plan.vram_avail - vram_need < VRAM_MARGIN && vram_need > 0.0)
        || plan.ram_avail - ram_need < RAM_MARGIN
    {
        plan.verdict = "tight";
    }
    plan
}

fn gb(n: f64) -> String {
    if n >= GB {
        format!("{} GB", to_fixed(n / GB, 1))
    } else {
        format!("{} MB", nekko_js::number_to_string(jmax(0.0, js_round(n / MB))))
    }
}

fn tokens(n: f64) -> String {
    if n >= 1024.0 {
        format!("{}K", nekko_js::number_to_string(js_round(n / 1024.0)))
    } else {
        nekko_js::number_to_string(n)
    }
}

/// What the solver optimizes (`goal`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Goal {
    /// The lightest split at a useful context, then as much context as that
    /// split allows: the "Use recommended settings" button.
    Speed,
    /// The most context, then the lightest split that holds it: long coding sessions.
    Context,
    /// Keep the given context, precision and sessions; find the lightest split.
    Fill,
}

impl Goal {
    pub fn parse(s: Option<&str>) -> Self {
        match s {
            Some("context") => Goal::Context,
            Some("fill") => Goal::Fill,
            _ => Goal::Speed,
        }
    }
}

/// The lightest placement of `base` that fits: GPU only, then experts moved to
/// RAM one layer at a time, then feed-forward, then whole layers. Each step
/// moves more of the per-token work off the GPU than the last.
fn lightest(
    facts: &ModelFacts,
    hw: &Hardware,
    resident: f64,
    base: &Request,
    allow_disk: bool,
) -> Option<(Request, Plan)> {
    let layers = facts.layers.filter(|l| *l > 0.0).unwrap_or(1.0);
    let w = facts.weight_layout.unwrap_or_default();
    let try_at = |r: Request| {
        let p = place(facts, &r, hw, resident);
        p.ok(allow_disk).then_some((r, p))
    };
    if !hw.devices.iter().any(|d| d.free.is_finite()) {
        return None;
    }
    let gpu =
        Request { run_on: RunOn::Gpu, gpu_layers: layers, cpu_moe_layers: 0.0, cpu_ffn_layers: 0.0, ..base.clone() };
    if let Some(found) = try_at(gpu.clone()) {
        return Some(found);
    }
    if hw.unified {
        return None;
    }
    let hybrid = Request { run_on: RunOn::Hybrid, ..gpu };
    if w.is_moe() || w.ffn_share > 0.0 {
        for n in 1..=layers as u32 {
            let mut r = hybrid.clone();
            if w.is_moe() {
                r.cpu_moe_layers = n as f64
            } else {
                r.cpu_ffn_layers = n as f64
            }
            if let Some(found) = try_at(r) {
                return Some(found);
            }
        }
    }
    (1..layers as u32).rev().find_map(|g| try_at(Request { gpu_layers: g as f64, ..hybrid.clone() }))
}

/// How much of the model the GPU holds: more is faster.
fn gpu_share(p: &Plan) -> f64 {
    p.vram.weights
}

/// Solve for a goal. `Fill` keeps `base`'s context, precision and sessions.
pub fn solve(facts: &ModelFacts, hw: &Hardware, resident: f64, goal: Goal, base: &Request) -> (Request, Plan) {
    let max = max_context(facts);
    let mut stops: Vec<f64> = STOPS.iter().copied().filter(|s| *s <= max).collect();
    if stops.is_empty() {
        stops.push(max.floor().max(512.0));
    }
    let floor = stops.iter().copied().find(|s| *s <= USEFUL_CONTEXT).unwrap_or(stops[stops.len() - 1]);
    let at = |ctx: f64, dtype: &str| Request { context_per_session: ctx, kv_cache_dtype: dtype.into(), ..base.clone() };
    for allow_disk in [false, true] {
        let found = match goal {
            Goal::Fill => lightest(facts, hw, resident, base, allow_disk),
            Goal::Context => stops.iter().find_map(|&ctx| {
                ["f16", "q8_0"].iter().find_map(|d| lightest(facts, hw, resident, &at(ctx, d), allow_disk))
            }),
            Goal::Speed => {
                // GPU only at the most context it allows is as fast as it gets.
                let gpu_only = stops.iter().find_map(|&ctx| {
                    ["f16", "q8_0"].iter().find_map(|d| {
                        lightest(facts, hw, resident, &at(ctx, d), allow_disk).filter(|(r, _)| r.run_on == RunOn::Gpu)
                    })
                });
                gpu_only.or_else(|| {
                    // Otherwise the split that keeps most on the GPU at a useful
                    // context (the smaller cache wins when it keeps more), then
                    // grow the context while that split still fits.
                    let split = ["f16", "q8_0"]
                        .iter()
                        .filter_map(|d| lightest(facts, hw, resident, &at(floor, d), allow_disk))
                        .fold(None::<(Request, Plan)>, |best, x| match best {
                            Some(b) if gpu_share(&b.1) >= gpu_share(&x.1) => Some(b),
                            _ => Some(x),
                        })?;
                    stops.iter().filter(|c| **c >= floor).find_map(|&ctx| {
                        let r = Request { context_per_session: ctx, ..split.0.clone() };
                        let p = place(facts, &r, hw, resident);
                        p.ok(allow_disk).then_some((r, p))
                    })
                })
            }
        };
        if let Some(found) = found {
            return found;
        }
    }
    // Nothing on the GPU helps: the processor, with the most context RAM allows.
    let cpu = |ctx: f64| Request {
        run_on: RunOn::Cpu,
        context_per_session: ctx,
        kv_cache_dtype: "q8_0".into(),
        ..base.clone()
    };
    let ctxs: Vec<f64> = if goal == Goal::Fill { vec![base.context_per_session] } else { stops.clone() };
    for allow_disk in [false, true] {
        for &ctx in &ctxs {
            let p = place(facts, &cpu(ctx), hw, resident);
            if p.ok(allow_disk) {
                return (cpu(ctx), p);
            }
        }
    }
    let r = cpu(*ctxs.last().unwrap_or(&2048.0));
    let p = place(facts, &r, hw, resident);
    (r, p)
}

/// A recommendation with a sentence per choice (`runtime:recommend`). `base`
/// carries the drawer's current settings, which `Fill` keeps.
pub fn recommend(facts: &ModelFacts, hw: &Hardware, resident_vram: f64, goal: Goal, base: Option<&Request>) -> Value {
    let layers = facts.layers.filter(|l| *l > 0.0).unwrap_or(1.0);
    let max = max_context(facts);
    let has_gpu = hw.devices.iter().any(|d| d.free.is_finite());
    let probe = place(facts, &Request::base(layers), hw, resident_vram);
    if probe.verdict == "unknown" {
        return json!({
            "request": Request::base(layers).to_value(),
            "plan": probe.to_value(),
            "why": [{ "field": "Settings", "value": "Unknown", "sentence": "This file does not describe its layers, so any recommendation would be a guess. Load it and we'll measure what it takes." }],
        });
    }
    let (req, plan) = match (goal, base) {
        (Goal::Fill, Some(b)) => solve(facts, hw, resident_vram, goal, b),
        (Goal::Context, _) => solve(facts, hw, resident_vram, goal, &Request::base(layers)),
        _ => {
            // More sessions only when each still gets a full working context and room to spare.
            let want = max.min(65536.0);
            [4.0, 2.0]
                .iter()
                .map(|n| {
                    solve(facts, hw, resident_vram, Goal::Speed, &Request { sessions: *n, ..Request::base(layers) })
                })
                .find(|(r, p)| r.context_per_session >= want && p.verdict == "fits")
                .unwrap_or_else(|| solve(facts, hw, resident_vram, Goal::Speed, &Request::base(layers)))
        }
    };

    let mut why: Vec<Value> = Vec::new();
    let mut add = |field: &str, value: String, sentence: &str| {
        why.push(json!({ "field": field, "value": value, "sentence": sentence }));
    };
    match (req.run_on, hw.unified) {
        (_, true) => add(
            "Run on",
            "GPU".into(),
            "Your Mac shares one pool of memory between the GPU and the CPU, so the whole model runs on the GPU.",
        ),
        (RunOn::Gpu, _) => add(
            "Run on",
            "GPU only".into(),
            "The whole model fits in graphics memory, which is the fastest place to run it.",
        ),
        (RunOn::Cpu, _) => add(
            "Run on",
            "CPU only".into(),
            if has_gpu {
                "Not enough of it fits on the graphics card to help, so it runs on the processor."
            } else {
                "There is no graphics card to use, so it runs on the processor."
            },
        ),
        (RunOn::Hybrid, _) => add(
            "Run on",
            "Hybrid".into(),
            "It is too big for graphics memory alone, so the graphics card and system memory share it.",
        ),
    }
    if req.run_on == RunOn::Hybrid {
        let l = nekko_js::number_to_string(layers);
        if req.cpu_moe_layers > 0.0 {
            add(
                "How to split it",
                format!("Experts of {} of {l} layers in RAM", nekko_js::number_to_string(req.cpu_moe_layers)),
                "This model uses only a few of its experts for each word, so they can wait in system memory while the graphics card does the core work.",
            );
        } else if req.cpu_ffn_layers > 0.0 {
            add(
                "How to split it",
                format!("Feed-forward of {} of {l} layers in RAM", nekko_js::number_to_string(req.cpu_ffn_layers)),
                "The attention math and the context stay on the graphics card, which matters most for speed; the bulkiest part of some layers moves to system memory.",
            );
        } else {
            add(
                "How to split it",
                format!("{} of {l} layers on the GPU", nekko_js::number_to_string(req.gpu_layers)),
                "As many layers as fit go on the graphics card; the rest run on the processor.",
            );
        }
    }
    if plan.disk_tables > 0.0 {
        add(
            "Lookup table",
            format!("{} stays on your SSD", gb(plan.disk_tables)),
            "This model ships a large table it reads only a few KB of per word, so it is read from disk instead of filling memory.",
        );
    }
    add(
        "Context",
        format!("{} per session", tokens(req.context_per_session)),
        if req.context_per_session >= max {
            "The most this model supports, and it fits."
        } else {
            "The most that fits beside the model. Lower it to free memory."
        },
    );
    add(
        "Sessions at once",
        nekko_js::number_to_string(req.sessions),
        if req.sessions > 1.0 {
            "Room for agents and chats to answer at the same time, each with its full context."
        } else {
            "One at a time keeps the most memory for context on this machine."
        },
    );
    add(
        "Memory precision",
        if req.kv_cache_dtype == "f16" { "Most reliable".into() } else { "Balanced".into() },
        if req.kv_cache_dtype == "f16" {
            "There is room to store the conversation exactly."
        } else {
            "Stores the conversation more compactly so the context fits. The difference is rarely noticeable."
        },
    );
    add(
        "Keep in memory",
        "Keep loaded".into(),
        if req.run_on == RunOn::Cpu {
            "The model stays ready between messages."
        } else {
            "The model stays ready between messages. It still runs on the graphics card."
        },
    );
    if plan.verdict == "disk" {
        add(
            "Heads up",
            format!("Reads {} from your SSD", gb(plan.disk_overflow)),
            "Part of the model does not fit in memory and is read from disk as needed. It works; a slow drive makes it slow.",
        );
    }
    if plan.verdict == "wont-load" {
        add(
            "Heads up",
            "Doesn't fit".into(),
            "Even the smallest setup needs more memory than this machine has free. Close other apps or pick a smaller download.",
        );
    }
    json!({ "request": req.to_value(), "plan": plan.to_value(), "why": why })
}
