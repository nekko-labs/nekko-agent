//! Will this model fit, where will it run, and why: a port of core's capacity
//! planner (`kv.ts`, `plan.ts`, `suggest.ts`, `autofit.ts`), held to it by
//! `tests/golden/capacity.json`. Pure, like the TS: facts in, projection out.
//! Numbers follow JavaScript's (`NaN` propagates through `Math.max`/`min`).

use crate::{js_round, num, to_fixed};
use serde_json::{Map, Value, json};

const GB: f64 = 1024.0 * 1024.0 * 1024.0;
const MB: f64 = 1024.0 * 1024.0;
const HEADROOM_MARGIN_BYTES: f64 = 768.0 * MB;
const OS_RESERVE_BYTES: f64 = 2.0 * GB;
const OVERHEAD_FLOOR_BYTES: f64 = 256.0 * MB;
const GRAPH_CONTEXT_CAP: f64 = 8192.0;
const MAX_SUGGESTIONS: usize = 3;
const MIN_CONTEXT: f64 = 512.0;
const CONTEXT_STOPS: [f64; 7] = [131072.0, 65536.0, 32768.0, 16384.0, 8192.0, 4096.0, 2048.0];
/// llama.cpp's default `--ubatch-size`: a sliding-window layer holds its window plus one micro-batch.
const UBATCH_TOKENS: f64 = 512.0;
/// The sequences `llama-server` serves when it is not given `--parallel`
/// (`n_parallel = auto`, one unified cache), which is how the engine starts a
/// one-slot load.
const AUTO_SEQUENCES: f64 = 4.0;

/// `Math.max(a, b)`: `NaN` if either is.
pub fn jmax(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) }
}

/// `Math.min(a, b)`: `NaN` if either is.
pub fn jmin(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.min(b) }
}

/// JavaScript truthiness of an optional number.
fn truthy(n: Option<f64>) -> bool {
    n.is_some_and(|n| n != 0.0 && !n.is_nan())
}

/// The KV cache a GGUF really keeps, read layer by layer from its tensors
/// (`gguf.rs`), in cache elements (keys plus values) per token of context.
///
/// The uniform `layers x kvHeads x headDim` overstates modern models several
/// times over: a recurrent layer of a hybrid model keeps no cache, a
/// sliding-window layer stops growing at its window, and layers that share
/// another's cache add nothing. Gemma 4 12B at 32k: 992 MiB in llama.cpp,
/// about 51 GB by the uniform formula.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct KvLayout {
    /// Elements per token on the full-attention layers.
    pub full_per_token: f64,
    /// Elements per token on the sliding-window layers.
    pub sliding_per_token: f64,
    /// Their window, in tokens (0 when there are none).
    pub sliding_window: f64,
}

impl KvLayout {
    pub fn from_value(v: &Value) -> Option<Self> {
        let n = |k: &str| v.get(k).and_then(Value::as_f64);
        Some(Self {
            full_per_token: n("fullPerToken")?,
            sliding_per_token: n("slidingPerToken").unwrap_or(0.0),
            sliding_window: n("slidingWindow").unwrap_or(0.0),
        })
    }

    pub fn to_value(&self) -> Value {
        let mut o = Map::new();
        o.insert("fullPerToken".into(), num(self.full_per_token));
        if self.sliding_per_token > 0.0 {
            o.insert("slidingPerToken".into(), num(self.sliding_per_token));
            o.insert("slidingWindow".into(), num(self.sliding_window));
        }
        Value::Object(o)
    }
}

/// What the weights are made of, read from a GGUF's tensor table (`gguf.rs`),
/// as shares of every tensor byte it lists. This is what lets the placement
/// planner move a mixture-of-experts model's experts (most of its bytes, few
/// of its reads per token) to RAM, or page a lookup table from disk.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct WeightLayout {
    /// Routed expert tensors (`blk.N.ffn_*_exps`).
    pub expert_share: f64,
    /// Dense feed-forward tensors (`blk.N.ffn_{up,down,gate}`), for `--n-cpu-ffn`.
    pub ffn_share: f64,
    /// Lookup tables llama.cpp's `--lazy-mode` reads row by row from the file
    /// (n-gram and per-layer embeddings).
    pub table_share: f64,
    pub experts: Option<f64>,
    pub experts_used: Option<f64>,
}

impl WeightLayout {
    pub fn from_value(v: &Value) -> Option<Self> {
        let n = |k: &str| v.get(k).and_then(Value::as_f64);
        Some(Self {
            expert_share: n("expertShare")?,
            ffn_share: n("ffnShare").unwrap_or(0.0),
            table_share: n("tableShare").unwrap_or(0.0),
            experts: n("experts"),
            experts_used: n("expertsUsed"),
        })
    }

    pub fn to_value(&self) -> Value {
        let mut o = Map::new();
        o.insert("expertShare".into(), num(self.expert_share));
        o.insert("ffnShare".into(), num(self.ffn_share));
        o.insert("tableShare".into(), num(self.table_share));
        if let Some(e) = self.experts {
            o.insert("experts".into(), num(e));
        }
        if let Some(e) = self.experts_used {
            o.insert("expertsUsed".into(), num(e));
        }
        Value::Object(o)
    }

    pub fn is_moe(&self) -> bool {
        self.expert_share > 0.0
    }
}

/// What we know about a model, normalized across runtimes (`ModelFacts`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ModelFacts {
    pub id: String,
    pub weights: Option<f64>,
    pub layers: Option<f64>,
    pub kv_heads: Option<f64>,
    pub head_dim: Option<f64>,
    pub max_context: Option<f64>,
    /// Read from the GGUF when the engine holds the file; preferred over the
    /// uniform geometry above, and sized as `llama-server` allocates.
    pub kv_layout: Option<KvLayout>,
    /// Read from the GGUF too; only the placement planner uses it.
    pub weight_layout: Option<WeightLayout>,
}

impl ModelFacts {
    pub fn from_value(v: &Value) -> Self {
        let n = |k: &str| v.get(k).and_then(Value::as_f64);
        Self {
            id: v.get("id").map(nekko_js::display).unwrap_or_default(),
            weights: n("weightsBytes"),
            layers: n("layers"),
            kv_heads: n("kvHeads"),
            head_dim: n("headDim"),
            max_context: n("maxContext"),
            kv_layout: v.get("kvLayout").and_then(KvLayout::from_value),
            weight_layout: v.get("weightLayout").and_then(WeightLayout::from_value),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Device {
    pub name: String,
    pub total: f64,
    pub free: f64,
}

/// `HardwareFacts`, in bytes.
#[derive(Debug, Clone, PartialEq)]
pub struct Hardware {
    pub devices: Vec<Device>,
    pub unified: bool,
    pub ram_total: f64,
    pub ram_free: f64,
}

impl Hardware {
    pub fn from_value(v: &Value) -> Self {
        let n = |v: &Value, k: &str| v.get(k).and_then(Value::as_f64).unwrap_or(f64::NAN);
        Self {
            devices: v
                .get("devices")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .map(|d| Device {
                            name: d.get("name").map(nekko_js::display).unwrap_or_default(),
                            total: n(d, "totalBytes"),
                            free: n(d, "freeBytes"),
                        })
                        .collect()
                })
                .unwrap_or_default(),
            unified: v.get("unified").and_then(Value::as_bool).unwrap_or(false),
            ram_total: n(v, "systemRamTotalBytes"),
            ram_free: n(v, "systemRamFreeBytes"),
        }
    }
}

/// `FitRequest`. A field the caller left out is `NaN`, as JavaScript reads it.
#[derive(Debug, Clone, PartialEq)]
pub struct FitRequest {
    pub context_tokens: f64,
    pub parallel_slots: f64,
    pub kv_cache_dtype: String,
    pub gpu_layer_fraction: f64,
}

impl Default for FitRequest {
    /// `DEFAULT_FIT_REQUEST`.
    fn default() -> Self {
        Self { context_tokens: 8192.0, parallel_slots: 1.0, kv_cache_dtype: "f16".into(), gpu_layer_fraction: 1.0 }
    }
}

impl FitRequest {
    pub fn from_value(v: &Value) -> Self {
        let n = |k: &str| v.get(k).map_or(f64::NAN, |x| nekko_js::to_number(Some(x)));
        Self {
            context_tokens: n("contextTokens"),
            parallel_slots: n("parallelSlots"),
            kv_cache_dtype: v.get("kvCacheDtype").map(nekko_js::display).unwrap_or_else(|| "undefined".into()),
            gpu_layer_fraction: n("gpuLayerFraction"),
        }
    }

    pub fn to_value(&self) -> Value {
        json!({
            "contextTokens": num(self.context_tokens),
            "parallelSlots": num(self.parallel_slots),
            "kvCacheDtype": self.kv_cache_dtype,
            "gpuLayerFraction": num(self.gpu_layer_fraction),
        })
    }
}

/// `kvBytesPerElement`; `NaN` for a type it does not know (`undefined` in JS).
pub fn kv_bytes_per_element(dtype: &str) -> f64 {
    match dtype {
        "f16" => 2.0,
        "q8_0" | "fp8" => 1.0,
        "q4_0" => 0.5,
        _ => f64::NAN,
    }
}

/// `kvCacheBytes`: `None` when the geometry is unknown.
///
/// With a layout read from the file, as `llama-server` allocates it: the
/// full-attention layers hold the whole context once, however many slots
/// share it. Sliding-window layers hold a window per sequence: with one slot
/// the engine passes no `--parallel`, so the server runs four sequences over
/// one unified cache (`4 x window + ubatch` cells); with `--parallel N` each
/// slot keeps `window + ubatch` of its `context / N`. Checked against
/// llama-server b11429 on Gemma 4 12B at 32k: 1440 MiB of window cache
/// unified, 960 MiB with two slots.
///
/// Otherwise the uniform estimate, with a full cache per slot, which is what
/// Ollama allocates (`num_ctx` per parallel request).
pub fn kv_cache_bytes(facts: &ModelFacts, req: &FitRequest) -> Option<f64> {
    if let Some(l) = &facts.kv_layout {
        let slots = jmax(1.0, req.parallel_slots);
        let ctx = jmax(0.0, req.context_tokens);
        let window_cells = if l.sliding_window <= 0.0 {
            ctx
        } else if slots <= 1.0 {
            jmin(ctx, AUTO_SEQUENCES * l.sliding_window + UBATCH_TOKENS)
        } else {
            slots * jmin((ctx / slots).floor(), l.sliding_window + UBATCH_TOKENS)
        };
        let elements = l.full_per_token * ctx + l.sliding_per_token * window_cells;
        return Some(elements * kv_bytes_per_element(&req.kv_cache_dtype));
    }
    if !truthy(facts.layers) || !truthy(facts.kv_heads) || !truthy(facts.head_dim) {
        return None;
    }
    let slots = jmax(1.0, req.parallel_slots);
    let ctx = jmax(0.0, req.context_tokens);
    let (layers, kv_heads, head_dim) = (facts.layers?, facts.kv_heads?, facts.head_dim?);
    Some(2.0 * layers * kv_heads * head_dim * ctx * kv_bytes_per_element(&req.kv_cache_dtype) * slots)
}

/// `estimateOverheadBytes`.
pub fn estimate_overhead_bytes(facts: &ModelFacts, req: &FitRequest, floor: Option<f64>) -> f64 {
    let floor = floor.unwrap_or(OVERHEAD_FLOOR_BYTES);
    let per_token_graph = facts.layers.unwrap_or(32.0) * facts.head_dim.unwrap_or(128.0) * 4.0;
    let scaled = per_token_graph * jmin(jmax(0.0, req.context_tokens), GRAPH_CONTEXT_CAP);
    jmax(floor, OVERHEAD_FLOOR_BYTES) + scaled
}

/// `headDimOf`.
pub fn head_dim_of(embedding: Option<f64>, heads: Option<f64>) -> Option<f64> {
    if !truthy(embedding) || !truthy(heads) {
        return None;
    }
    let d = js_round(embedding? / heads?);
    (d.is_finite() && d > 0.0).then_some(d)
}

/// `PlanOptions`.
#[derive(Debug, Clone, Default)]
pub struct PlanOptions {
    pub overhead_floor: Option<f64>,
    pub siblings: Vec<ModelFacts>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Reason {
    pub code: &'static str,
    pub bytes: Option<f64>,
    pub share_pct: Option<f64>,
    pub detail: Option<String>,
}

fn reason(code: &'static str) -> Reason {
    Reason { code, bytes: None, share_pct: None, detail: None }
}

impl Reason {
    fn bytes(mut self, b: f64) -> Self {
        self.bytes = Some(b);
        self
    }
    fn share(mut self, s: f64) -> Self {
        self.share_pct = Some(s);
        self
    }
    fn detail(mut self, d: String) -> Self {
        self.detail = Some(d);
        self
    }
    fn to_value(&self) -> Value {
        let mut o = Map::new();
        o.insert("code".into(), json!(self.code));
        if let Some(b) = self.bytes {
            o.insert("bytes".into(), num(b));
        }
        if let Some(s) = self.share_pct {
            o.insert("sharePct".into(), num(s));
        }
        if let Some(d) = &self.detail {
            o.insert("detail".into(), json!(d));
        }
        Value::Object(o)
    }
}

/// `FitPlan`.
#[derive(Debug, Clone, PartialEq)]
pub struct FitPlan {
    pub verdict: &'static str,
    pub weights: f64,
    pub kv: f64,
    pub overhead: f64,
    pub required: f64,
    pub device_name: Option<String>,
    pub device_total: f64,
    pub device_free: f64,
    pub gpu_layers: Option<f64>,
    pub total_layers: Option<f64>,
    pub spill: f64,
    pub reasons: Vec<Reason>,
    pub suggestions: Vec<Value>,
}

impl FitPlan {
    /// Keys in the order the TS object is built: the shared base, the
    /// projection, then `gpuLayers`, which the planner adds last.
    pub fn to_value(&self) -> Value {
        let mut o = Map::new();
        o.insert("deviceName".into(), self.device_name.as_ref().map_or(Value::Null, |n| json!(n)));
        o.insert("deviceTotalBytes".into(), num(self.device_total));
        o.insert("deviceFreeBytes".into(), num(self.device_free));
        if let Some(t) = self.total_layers {
            o.insert("totalLayers".into(), num(t));
        }
        o.insert("verdict".into(), json!(self.verdict));
        o.insert("weightsBytes".into(), num(self.weights));
        o.insert("kvCacheBytes".into(), num(self.kv));
        o.insert("overheadBytes".into(), num(self.overhead));
        o.insert("requiredBytes".into(), num(self.required));
        o.insert("spillBytes".into(), num(self.spill));
        o.insert("reasons".into(), Value::Array(self.reasons.iter().map(Reason::to_value).collect()));
        o.insert("suggestions".into(), Value::Array(self.suggestions.clone()));
        if let Some(g) = self.gpu_layers {
            o.insert("gpuLayers".into(), num(g));
        }
        Value::Object(o)
    }
}

fn pct(part: f64, whole: f64) -> f64 {
    if whole > 0.0 { js_round((part / whole) * 1000.0) / 10.0 } else { 0.0 }
}

fn clamp01(n: f64) -> f64 {
    if !n.is_finite() { 1.0 } else { n.clamp(0.0, 1.0) }
}

/// `computeFit`: the projection, with no suggestions.
pub fn compute_fit(facts: &ModelFacts, req: &FitRequest, hw: &Hardware, opts: &PlanOptions) -> FitPlan {
    let mut reasons = Vec::new();
    // pickDevice: which single pool the plan is measured against.
    let (device, budget, device_total) = if hw.devices.is_empty() {
        reasons.push(reason("no-gpu"));
        (None, jmax(0.0, hw.ram_free - OS_RESERVE_BYTES), hw.ram_total)
    } else {
        if hw.devices.len() > 1 && !hw.unified {
            reasons.push(reason("multi-device-not-pooled").detail(hw.devices.len().to_string()));
        }
        if hw.unified {
            reasons.push(reason("unified-memory"));
        }
        let mut best = &hw.devices[0];
        for d in &hw.devices[1..] {
            if d.free > best.free {
                best = d;
            }
        }
        (Some(best), jmax(0.0, best.free * clamp01(req.gpu_layer_fraction)), best.total)
    };
    let mut plan = FitPlan {
        verdict: "fits",
        weights: 0.0,
        kv: 0.0,
        overhead: 0.0,
        required: 0.0,
        device_name: device.map(|d| d.name.clone()),
        device_total,
        device_free: budget,
        gpu_layers: None,
        total_layers: facts.layers,
        spill: 0.0,
        reasons: Vec::new(),
        suggestions: Vec::new(),
    };
    let ceiling =
        if hw.unified { jmax(budget, hw.ram_free) } else { budget + jmax(0.0, hw.ram_free - OS_RESERVE_BYTES) };

    let kv = kv_cache_bytes(facts, req);
    let mut missing = Vec::new();
    if !truthy(facts.weights) {
        missing.push("weights size");
    }
    if kv.is_none() {
        if !truthy(facts.layers) {
            missing.push("layer count");
        }
        if !truthy(facts.kv_heads) {
            missing.push("KV head count");
        }
        if !truthy(facts.head_dim) {
            missing.push("head dimension");
        }
    }
    if !missing.is_empty() {
        reasons.push(reason("missing-metadata").detail(missing.join(", ")));
        let weights_known = truthy(facts.weights);
        let w = facts.weights.unwrap_or(0.0);
        let overhead = estimate_overhead_bytes(facts, req, opts.overhead_floor);
        let known_floor = if weights_known { w + overhead } else { 0.0 };
        let doomed = known_floor > 0.0 && known_floor > ceiling;
        if doomed {
            reasons.push(reason("exceeds-total-memory").bytes(known_floor));
        }
        if weights_known && w > budget {
            reasons.push(reason("weights-exceed-device").bytes(w));
        }
        plan.verdict = if doomed { "wont-load" } else { "unknown" };
        plan.weights = facts.weights.unwrap_or(0.0);
        plan.kv = kv.unwrap_or(0.0);
        plan.overhead = if weights_known { overhead } else { 0.0 };
        plan.required = known_floor;
        plan.reasons = reasons;
        return plan;
    }

    let weights = facts.weights.unwrap_or(f64::NAN);
    let kv = kv.unwrap_or(f64::NAN);
    let overhead = estimate_overhead_bytes(facts, req, opts.overhead_floor);
    let required = weights + kv + overhead;
    plan.weights = weights;
    plan.kv = kv;
    plan.overhead = overhead;
    plan.required = required;

    if let Some(max) = facts.max_context.filter(|m| truthy(Some(*m)))
        && req.context_tokens > max
    {
        reasons.push(reason("context-over-max").bytes(kv).detail(nekko_js::number_to_string(max)));
        plan.verdict = "wont-load";
        plan.reasons = reasons;
        return plan;
    }
    if kv > weights * 0.5 {
        reasons.push(reason("kv-cache-dominates").bytes(kv).share(pct(kv, required)));
    }
    if weights > budget {
        reasons.push(reason("weights-exceed-device").bytes(weights));
    }
    if required > ceiling {
        reasons.push(reason("exceeds-total-memory").bytes(required));
        plan.verdict = "wont-load";
        plan.spill = required - budget;
        plan.gpu_layers = Some(0.0);
        plan.reasons = reasons;
        return plan;
    }
    if required <= budget {
        let leftover = budget - required;
        if leftover < HEADROOM_MARGIN_BYTES {
            reasons.push(reason("headroom-thin").bytes(leftover));
            plan.verdict = "tight";
        } else {
            plan.verdict = "fits";
        }
        plan.gpu_layers = if device.is_some() { facts.layers } else { Some(0.0) };
        plan.reasons = reasons;
        return plan;
    }
    plan.verdict = "spills";
    plan.spill = required - budget;
    let weight_budget = jmax(0.0, budget - kv - overhead);
    let share = if weights > 0.0 { jmin(1.0, weight_budget / weights) } else { 0.0 };
    plan.gpu_layers = match facts.layers {
        Some(l) if truthy(Some(l)) => Some(jmax(0.0, jmin(l, (l * share).floor()))),
        _ => None,
    };
    reasons.push(reason("partial-offload").bytes(plan.spill).share(pct(plan.spill, required)));
    plan.reasons = reasons;
    plan
}

/// `planFit`: the projection with the fixes that would improve it.
pub fn plan_fit(facts: &ModelFacts, req: &FitRequest, hw: &Hardware, opts: &PlanOptions) -> FitPlan {
    let mut plan = compute_fit(facts, req, hw, opts);
    plan.suggestions = suggest_fixes(facts, req, &plan, opts, &|candidate| compute_fit(facts, candidate, hw, opts));
    plan
}

fn format_tokens(n: f64) -> String {
    if n >= 1024.0 {
        format!("{}k", nekko_js::number_to_string(js_round(n / 1024.0)))
    } else {
        nekko_js::number_to_string(n)
    }
}

fn verdict_rank(v: &str) -> u8 {
    match v {
        "fits" => 4,
        "tight" => 3,
        "spills" => 2,
        "wont-load" => 1,
        _ => 0,
    }
}

fn good(v: &str) -> bool {
    v == "fits" || v == "tight"
}

/// `suggestFixes`.
fn suggest_fixes(
    facts: &ModelFacts,
    req: &FitRequest,
    plan: &FitPlan,
    opts: &PlanOptions,
    replan: &dyn Fn(&FitRequest) -> FitPlan,
) -> Vec<Value> {
    if plan.verdict == "fits" || plan.verdict == "unknown" {
        return Vec::new();
    }
    let format_bytes = |n: f64| {
        let gb = n / GB;
        if gb >= 1.0 {
            format!("{} GB", to_fixed(gb, 1))
        } else {
            format!("{} MB", nekko_js::number_to_string(js_round(n / MB)))
        }
    };
    let kv_delta = |to: &FitRequest| match (kv_cache_bytes(facts, req), kv_cache_bytes(facts, to)) {
        (Some(a), Some(b)) => jmax(0.0, a - b),
        _ => 0.0,
    };
    let is_better = |c: &FitPlan| verdict_rank(c.verdict) > verdict_rank(plan.verdict);
    let mut out: Vec<(f64, Value)> = Vec::new();

    // Largest context that fits, halving down from the request.
    let largest = {
        let ceiling = jmin(req.context_tokens, facts.max_context.unwrap_or(req.context_tokens));
        let mut ctx = ceiling;
        let with_ctx = |c: f64| FitRequest { context_tokens: c, ..req.clone() };
        if ctx < req.context_tokens && good(replan(&with_ctx(ctx)).verdict) {
            Some(ctx)
        } else {
            let mut found = None;
            while ctx > MIN_CONTEXT {
                ctx = (ctx / 2.0).floor();
                if good(replan(&with_ctx(ctx)).verdict) {
                    found = Some(ctx);
                    break;
                }
            }
            found
        }
    };
    if let Some(smaller) = largest
        && smaller < req.context_tokens
    {
        let saves = kv_delta(&FitRequest { context_tokens: smaller, ..req.clone() });
        out.push((
            saves,
            json!({
                "label": format!("Drop context to {} to fit", format_tokens(smaller)),
                "savesBytes": num(saves),
                "apply": { "contextTokens": num(smaller) },
            }),
        ));
    }
    if req.kv_cache_dtype == "f16" {
        let candidate = FitRequest { kv_cache_dtype: "q8_0".into(), ..req.clone() };
        let saves = kv_delta(&candidate);
        if saves > 0.0 && is_better(&replan(&candidate)) {
            out.push((
                saves,
                json!({
                    "label": format!("Use a q8_0 KV cache to save {}", format_bytes(saves)),
                    "savesBytes": num(saves),
                    "apply": { "kvCacheDtype": "q8_0" },
                }),
            ));
        }
    }
    if req.parallel_slots > 1.0 {
        let halved = jmax(1.0, (req.parallel_slots / 2.0).floor());
        let candidate = FitRequest { parallel_slots: halved, ..req.clone() };
        let saves = kv_delta(&candidate);
        if saves > 0.0 && is_better(&replan(&candidate)) {
            out.push((
                saves,
                json!({
                    "label": format!("Cut parallel slots to {} to save {}", nekko_js::number_to_string(halved), format_bytes(saves)),
                    "savesBytes": num(saves),
                    "apply": { "parallelSlots": num(halved) },
                }),
            ));
        }
    }
    // The largest sibling build that would fit where this one does not.
    if !opts.siblings.is_empty() && truthy(facts.weights) {
        let weights = facts.weights.unwrap_or(0.0);
        let room = plan.device_free - plan.kv - plan.overhead;
        let mut best: Option<&ModelFacts> = None;
        for s in opts.siblings.iter().filter(|s| {
            s.id != facts.id
                && truthy(s.weights)
                && s.weights.unwrap_or(0.0) < weights
                && s.weights.unwrap_or(0.0) <= room
        }) {
            if best.is_none_or(|b| s.weights.unwrap_or(0.0) > b.weights.unwrap_or(0.0)) {
                best = Some(s);
            }
        }
        if let Some(s) = best {
            let saves = facts.weights.unwrap_or(0.0) - s.weights.unwrap_or(0.0);
            out.push((saves, json!({ "label": format!("Load {} instead", s.id), "savesBytes": num(saves), "alternateModelId": s.id })));
        }
    }
    out.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    out.into_iter().take(MAX_SUGGESTIONS).map(|(_, v)| v).collect()
}

/// `autoFit`'s input.
pub struct AutoFitInput<'a> {
    pub facts: &'a ModelFacts,
    pub hardware: &'a Hardware,
    pub budget_fraction: f64,
    pub parallel_slots: Option<f64>,
    pub max_context_tokens: Option<f64>,
    pub options: PlanOptions,
}

/// `autoFit`: settings solved from one budget slider.
pub fn auto_fit(input: &AutoFitInput) -> Value {
    let facts = input.facts;
    let fraction = if input.budget_fraction.is_finite() { input.budget_fraction.clamp(0.1, 1.0) } else { 1.0 };
    let slots = jmax(1.0, input.parallel_slots.unwrap_or(1.0));
    let budget_hw = Hardware {
        devices: input
            .hardware
            .devices
            .iter()
            .map(|d| Device { free: (d.free * fraction).floor(), ..d.clone() })
            .collect(),
        ram_free: (input.hardware.ram_free * fraction).floor(),
        ..input.hardware.clone()
    };
    let ceiling = jmin(input.max_context_tokens.unwrap_or(f64::INFINITY), facts.max_context.unwrap_or(f64::INFINITY));
    let mut stops: Vec<f64> = CONTEXT_STOPS.iter().copied().filter(|c| *c <= ceiling).collect();
    if stops.is_empty() && ceiling.is_finite() {
        stops.push(jmax(512.0, ceiling.floor()));
    }
    let request = |ctx: f64, dtype: &str| FitRequest {
        context_tokens: ctx,
        parallel_slots: slots,
        kv_cache_dtype: dtype.into(),
        gpu_layer_fraction: 1.0,
    };

    let mut compromises: Vec<String> = Vec::new();
    let mut best: Option<(FitRequest, FitPlan)> = None;
    'outer: for &ctx in &stops {
        for dtype in ["f16", "q8_0"] {
            let req = request(ctx, dtype);
            let plan = compute_fit(facts, &req, &budget_hw, &input.options);
            if plan.verdict == "unknown" {
                return json!({
                    "request": req.to_value(),
                    "plan": plan.to_value(),
                    "headline": "We cannot tell what this model needs.",
                    "tradeoff": "This file does not publish its layer geometry, so any figure here would be invented. Load it and we'll measure what it actually takes.",
                    "compromises": [],
                });
            }
            if good(plan.verdict) {
                best = Some((req, plan));
                break 'outer;
            }
        }
    }
    if let Some((req, _)) = &best {
        if req.kv_cache_dtype != "f16" {
            compromises.push("Used a smaller KV cache element (q8_0) to keep this much context.".into());
        }
        if !stops.is_empty() && req.context_tokens < stops[0] {
            compromises.push(format!(
                "Context is {} rather than the model's {}, which would not fit in this budget.",
                format_tokens(req.context_tokens),
                format_tokens(stops[0])
            ));
        }
    }
    let (req, plan) = match best {
        Some(b) => b,
        None => {
            let mut req = request(stops.last().copied().unwrap_or(2048.0), "q8_0");
            let plan = compute_fit(facts, &req, &budget_hw, &input.options);
            if let (Some(g), Some(t)) = (plan.gpu_layers, plan.total_layers.filter(|t| truthy(Some(*t)))) {
                req.gpu_layer_fraction = if t > 0.0 { g / t } else { 0.0 };
            }
            compromises.push(if plan.verdict == "wont-load" {
                "This model does not fit on this machine even at the smallest context.".into()
            } else {
                "Part of the model will run on the CPU, which is much slower than the GPU.".into()
            });
            (req, plan)
        }
    };

    let format_bytes = |n: f64| {
        if n >= GB {
            format!("{} GB", to_fixed(n / GB, 1))
        } else {
            format!("{} MB", nekko_js::number_to_string(jmax(0.0, js_round(n / MB))))
        }
    };
    let ctx = format_tokens(req.context_tokens);
    let headline = if plan.verdict == "wont-load" {
        format!("Will not load at {ctx} of context.")
    } else if plan.device_name.is_none() {
        format!("{ctx} of context, on the CPU.")
    } else {
        let partial = match (plan.total_layers.filter(|t| truthy(Some(*t))), plan.gpu_layers) {
            (Some(t), Some(g)) if g < t => Some(format!(
                "{} of {} layers on the GPU",
                nekko_js::number_to_string(g),
                nekko_js::number_to_string(t)
            )),
            _ => None,
        };
        format!("{ctx} of context, {}.", partial.unwrap_or_else(|| "entirely on the GPU".into()))
    };
    let used = format_bytes(plan.required);
    let free = plan.device_free;
    let tradeoff = if plan.verdict == "wont-load" {
        format!("It needs about {used}, which is more than this machine has free.")
    } else {
        let leftover = jmax(0.0, free - plan.required);
        let pool = if input.hardware.unified {
            "memory"
        } else if plan.device_name.is_some() {
            "VRAM"
        } else {
            "RAM"
        };
        let outside = jmax(0.0, (free / jmax(fraction, 0.01)).floor() - free);
        format!("About {used} of {pool}, leaving {} for everything else.", format_bytes(leftover + outside))
    };
    json!({
        "request": req.to_value(),
        "plan": plan.to_value(),
        "headline": headline,
        "tradeoff": tradeoff,
        "compromises": compromises,
    })
}
