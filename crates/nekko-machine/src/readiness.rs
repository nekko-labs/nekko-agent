//! The machine-readiness advisor (AN9b), a port of `evaluateReadiness` in
//! `packages/core/src/readiness/evaluate.ts` over `catalog.json` (recorded
//! from the deleted TS `OFFLINE_STACK_CATALOG`; edited by hand now). Catalog
//! entries stay JSON values, so a pick prints exactly as the TS one does.

use crate::num;
use serde_json::{Map, Value, json};
use std::sync::OnceLock;

/// What the OS plus the user's normal apps keep; the stack does not spend it.
const STACK_RESERVE_BYTES: f64 = 4.0 * 1024.0 * 1024.0 * 1024.0;

const STACK_ROLES: [&str; 4] = ["runtime", "intent", "stt", "tts"];

/// A GPU memory pool (`CapacityDevice`).
#[derive(Debug, Clone, PartialEq)]
pub struct Device {
    pub name: String,
    pub total_bytes: f64,
    pub free_bytes: f64,
}

/// `MachineFacts`.
#[derive(Debug, Clone, PartialEq)]
pub struct MachineFacts {
    pub platform: String,
    pub release: String,
    pub arch: String,
    pub cpu_features: Option<Vec<String>>,
    pub backends: Vec<String>,
    pub devices: Vec<Device>,
    pub unified: bool,
    pub ram_total: f64,
    pub ram_free: f64,
    pub disk_free: Option<f64>,
}

impl MachineFacts {
    /// Facts as JSON (`MachineFacts`), the shape the golden set records.
    pub fn from_value(v: &Value) -> Option<Self> {
        let strs = |v: &Value| -> Option<Vec<String>> {
            v.as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
        };
        let os = v.get("os")?;
        Some(Self {
            platform: os.get("platform")?.as_str()?.to_string(),
            release: os.get("release")?.as_str()?.to_string(),
            arch: os.get("arch")?.as_str()?.to_string(),
            cpu_features: strs(v.get("cpuFeatures")?),
            backends: strs(v.get("backends")?)?,
            devices: v
                .get("devices")?
                .as_array()?
                .iter()
                .filter_map(|d| {
                    Some(Device {
                        name: d.get("name")?.as_str()?.to_string(),
                        total_bytes: d.get("totalBytes")?.as_f64()?,
                        free_bytes: d.get("freeBytes")?.as_f64()?,
                    })
                })
                .collect(),
            unified: v.get("unified")?.as_bool()?,
            ram_total: v.get("systemRamTotalBytes")?.as_f64()?,
            ram_free: v.get("systemRamFreeBytes")?.as_f64()?,
            disk_free: v.get("diskFreeBytes")?.as_f64(),
        })
    }

    fn roomiest_total(&self) -> f64 {
        self.devices.iter().fold(0.0, |m, d| f64::max(m, d.total_bytes))
    }
}

/// The curated catalog, as the TS exports it.
pub fn catalog() -> &'static Value {
    static C: OnceLock<Value> = OnceLock::new();
    C.get_or_init(|| serde_json::from_str(include_str!("catalog.json")).unwrap_or(Value::Null))
}

/// A reason, keys in the order the TS object literal writes them.
fn reason(code: &str) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("code".into(), json!(code));
    m
}

fn reason_detail(code: &str, detail: String) -> Map<String, Value> {
    let mut m = reason(code);
    m.insert("detail".into(), json!(detail));
    m
}

fn reason_bytes(code: &str, bytes: f64) -> Map<String, Value> {
    let mut m = reason(code);
    m.insert("bytes".into(), num(bytes));
    m
}

fn strings(v: Option<&Value>) -> Option<Vec<&str>> {
    v?.as_array().map(|a| a.iter().map(|x| x.as_str().unwrap_or_default()).collect())
}

fn f(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64)
}

fn truthy(v: Option<&Value>) -> bool {
    nekko_js::truthy(v)
}

struct Candidate<'a> {
    index: usize,
    entry: &'a Value,
    unprobed: Vec<Map<String, Value>>,
}

#[derive(Clone)]
struct Placement {
    index: usize,
    on_gpu: bool,
}

fn role_priority(role: &str) -> u8 {
    match role {
        "intent" => 0,
        "stt" => 1,
        "tts" => 2,
        _ => 3,
    }
}

fn rank(verdict: &str) -> u8 {
    match verdict {
        "insufficient" => 0,
        "unverified" => 1,
        "compatible" => 2,
        _ => 3,
    }
}

fn roomiest(free: &[f64]) -> usize {
    let mut best = 0;
    for i in 1..free.len() {
        if free[i] > free[best] {
            best = i;
        }
    }
    best
}

type Reasons = Vec<Map<String, Value>>;

/// `classifyEntry`: hard gates exclude, probe gaps cap at `unverified`.
fn classify(e: &Value, facts: &MachineFacts, language: &str) -> (Reasons, Reasons) {
    let mut hard = Vec::new();
    let mut soft = Vec::new();
    let empty = json!({});
    let req = e.get("requires").filter(|r| r.is_object()).unwrap_or(&empty);

    if let Some(os) = strings(req.get("os"))
        && !os.contains(&facts.platform.as_str())
    {
        hard.push(reason_detail("unsupported-os", facts.platform.clone()));
    }
    if let Some(arch) = strings(req.get("arch"))
        && !arch.contains(&facts.arch.as_str())
    {
        hard.push(reason_detail("unsupported-arch", facts.arch.clone()));
    }
    if let Some(backends) = strings(req.get("backends"))
        && !backends.iter().any(|b| facts.backends.iter().any(|x| x == b))
    {
        hard.push(reason_detail("missing-backend", backends.join("|")));
    }
    if e.get("languages").and_then(Value::as_str) != Some("any") {
        let langs = strings(e.get("languages")).unwrap_or_default();
        if !langs.contains(&language) {
            hard.push(reason_detail("unsupported-language", language.to_string()));
        }
    }
    if let Some(wanted) = strings(req.get("cpuFeatures")).filter(|w| !w.is_empty()) {
        match &facts.cpu_features {
            None => soft.push(reason_detail("cpu-feature-unprobed", wanted.join(","))),
            Some(have) => {
                let missing: Vec<&str> = wanted.into_iter().filter(|w| !have.iter().any(|h| h == w)).collect();
                if !missing.is_empty() {
                    hard.push(reason_detail("missing-cpu-feature", missing.join(",")));
                }
            }
        }
    }
    if let Some(min) = f(req, "minRamBytes")
        && facts.ram_total < min
    {
        hard.push(reason_bytes("low-memory", min));
    }
    if let Some(min) = f(req, "minVramBytes")
        && facts.roomiest_total() < min
    {
        hard.push(reason_bytes("low-vram", min));
    }
    if let Some(min) = f(req, "minDiskBytes") {
        match facts.disk_free {
            None => soft.push(reason("disk-unprobed")),
            Some(free) if free < min => hard.push(reason_bytes("low-disk", min)),
            Some(_) => {}
        }
    }
    (hard, soft)
}

fn recommended_met(e: &Value, facts: &MachineFacts, on_gpu: bool) -> bool {
    let Some(rec) = e.get("recommended").filter(|r| truthy(Some(r))) else { return true };
    let prefers_gpu = truthy(e.get("prefersGpu"));
    if let Some(backends) = strings(rec.get("backends"))
        && !backends.iter().any(|b| facts.backends.iter().any(|x| x == b) && (!prefers_gpu || on_gpu || facts.unified))
    {
        return false;
    }
    if let Some(min) = f(rec, "minRamBytes")
        && facts.ram_total < min
    {
        return false;
    }
    if let Some(min) = f(rec, "minVramBytes")
        && facts.roomiest_total() < min
    {
        return false;
    }
    true
}

fn dedupe(reasons: Reasons) -> Reasons {
    let mut seen = std::collections::HashSet::new();
    reasons
        .into_iter()
        .filter(|r| {
            let detail = r.get("detail").map(nekko_js::display).unwrap_or_default();
            let code = r.get("code").and_then(Value::as_str).unwrap_or_default();
            seen.insert(format!("{code}|{detail}"))
        })
        .collect()
}

fn detail_with(detail: Option<&Value>, id: &str) -> String {
    match detail.and_then(Value::as_str).filter(|d| !d.is_empty()) {
        Some(d) => format!("{id}:{d}"),
        None => id.to_string(),
    }
}

/// `evaluateReadiness(facts, catalog, { language })` over the whole stack.
pub fn evaluate(facts: &MachineFacts, catalog: &Value, language: &str) -> Value {
    let roles = STACK_ROLES;
    let mut unknowns = Vec::new();
    if facts.cpu_features.is_none() {
        unknowns.push("cpu features");
    }
    if facts.disk_free.is_none() {
        unknowns.push("free disk");
    }

    let mut report_reasons: Reasons = Vec::new();
    if facts.unified {
        report_reasons.push(reason("unified-memory"));
    }
    if facts.devices.len() > 1 && !facts.unified {
        report_reasons.push(reason_detail("devices-not-pooled", facts.devices.len().to_string()));
    }

    let entries: Vec<&Value> =
        catalog.get("entries").and_then(Value::as_array).map(|a| a.iter().collect()).unwrap_or_default();

    // Per-role eligibility: hard gates exclude, unprobed gates cap.
    let mut eligible: Vec<(Vec<Candidate>, Reasons)> = Vec::new();
    for role in roles {
        let mut candidates = Vec::new();
        let mut failures = Vec::new();
        for (index, entry) in entries.iter().enumerate() {
            if entry.get("role").and_then(Value::as_str) != Some(role) {
                continue;
            }
            let (hard, soft) = classify(entry, facts, language);
            if hard.is_empty() {
                candidates.push(Candidate { index, entry, unprobed: soft });
            } else {
                let id = entry.get("id").map(nekko_js::display).unwrap_or_default();
                for mut r in hard {
                    let detail = detail_with(r.get("detail"), &id);
                    r.insert("detail".into(), json!(detail));
                    failures.push(r);
                }
            }
        }
        eligible.push((candidates, failures));
    }
    let role_index = |role: &str| roles.iter().position(|r| *r == role).unwrap_or(0);

    // Placement: devices are single pools, RAM accumulates what GPUs cannot
    // hold. The intent model places first; when a later role cannot place, the
    // intent pick is demoted and the stack retried.
    let mut picks: Vec<Option<Placement>> = vec![None; roles.len()];
    let mut exhausted = [false; 4];
    let mut device_free: Vec<f64> = facts.devices.iter().map(|d| d.free_bytes).collect();
    let mut ram_used = 0.0;

    let place_all = |intent_start: usize,
                     picks: &mut Vec<Option<Placement>>,
                     exhausted: &mut [bool; 4],
                     device_free: &mut Vec<f64>,
                     ram_used: &mut f64| {
        picks.iter_mut().for_each(|p| *p = None);
        exhausted.iter_mut().for_each(|x| *x = false);
        for (i, d) in facts.devices.iter().enumerate() {
            device_free[i] = d.free_bytes;
        }
        *ram_used = 0.0;
        let mut ordered: Vec<&str> = roles.to_vec();
        ordered.sort_by_key(|r| role_priority(r));
        for role in ordered {
            let ri = role_index(role);
            let candidates = &eligible[ri].0;
            let start = if role == "intent" { intent_start } else { 0 };
            let rest = candidates.get(start..).unwrap_or(&[]);
            let mut placed = None;
            for cand in rest {
                let e = cand.entry;
                let memory = f(e, "memoryBytes").unwrap_or(f64::NAN);
                if truthy(e.get("prefersGpu")) && !facts.unified && !device_free.is_empty() {
                    let idx = roomiest(device_free);
                    if device_free[idx] >= memory {
                        device_free[idx] -= memory;
                        placed = Some(Placement { index: cand.index, on_gpu: true });
                        break;
                    }
                }
                if facts.ram_free - *ram_used - STACK_RESERVE_BYTES >= memory {
                    *ram_used += memory;
                    placed = Some(Placement { index: cand.index, on_gpu: false });
                    break;
                }
            }
            if placed.is_some() {
                picks[ri] = placed;
            } else if !rest.is_empty() {
                exhausted[ri] = true;
            }
        }
    };

    let mut intent_start = 0;
    let intent = role_index("intent");
    loop {
        place_all(intent_start, &mut picks, &mut exhausted, &mut device_free, &mut ram_used);
        if !exhausted.iter().any(|x| *x) {
            break;
        }
        // Demotion only frees room: roles with no eligible candidate at all
        // cannot be helped by it.
        if (0..roles.len()).filter(|&r| picks[r].is_none()).all(|r| eligible[r].0.is_empty()) {
            break;
        }
        let intent_cands = &eligible[intent].0;
        let cur = picks[intent].as_ref().and_then(|p| intent_cands.iter().position(|c| c.index == p.index));
        match cur {
            Some(i) if i + 1 < intent_cands.len() => intent_start = i + 1,
            _ => break,
        }
    }

    let mut assessments: Vec<Value> = Vec::new();
    let mut verdicts: Vec<&str> = Vec::new();
    let mut picked: Vec<&Value> = Vec::new();
    for (ri, role) in roles.iter().enumerate() {
        let (candidates, failures) = &eligible[ri];
        let Some(placed) = &picks[ri] else {
            let mut reasons = dedupe(failures.clone());
            if exhausted[ri] {
                reasons.push(reason("low-memory"));
            }
            reasons.push(reason("no-candidate"));
            verdicts.push("insufficient");
            assessments.push(json!({
                "role": role,
                "verdict": "insufficient",
                "pick": null,
                "alternates": [],
                "reasons": reasons,
            }));
            continue;
        };
        let cand = candidates.iter().find(|c| c.index == placed.index).expect("a pick is one of its role's candidates");
        let entry = cand.entry;
        let mut reasons = cand.unprobed.clone();
        if truthy(entry.get("prefersGpu")) && !placed.on_gpu && !facts.unified {
            reasons.push(reason("cpu-only"));
        }
        if !truthy(entry.get("artifact").and_then(|a| a.get("sha256"))) {
            reasons.push(reason("artifact-unpinned"));
        }
        let meets = recommended_met(entry, facts, placed.on_gpu);
        if !meets {
            reasons.push(reason("below-recommended"));
        }
        let verdict = if !cand.unprobed.is_empty() {
            "unverified"
        } else if meets {
            "recommended"
        } else {
            "compatible"
        };
        verdicts.push(verdict);
        picked.push(entry);
        let alternates: Vec<&Value> = candidates.iter().filter(|c| c.index != placed.index).map(|c| c.entry).collect();
        assessments.push(json!({
            "role": role,
            "verdict": verdict,
            "pick": entry,
            "alternates": alternates,
            "reasons": reasons,
        }));
    }

    // Combined budget: what the picks cost together, disk included.
    let combined_memory = picked.iter().fold(0.0, |s, e| s + f(e, "memoryBytes").unwrap_or(f64::NAN));
    let combined_install = picked.iter().fold(0.0, |s, e| s + f(e, "installBytes").unwrap_or(f64::NAN));
    let ram_budget = (facts.ram_free - STACK_RESERVE_BYTES).max(0.0);
    let roomiest_device = facts.devices.iter().fold(0.0, |m, d| f64::max(m, d.free_bytes));
    let budget = if facts.unified { ram_budget } else { ram_budget + roomiest_device };

    if ram_used > ram_budget {
        report_reasons.push(reason_bytes("combined-exceeds-memory", ram_used));
    }
    if let Some(disk) = facts.disk_free
        && combined_install > disk
    {
        report_reasons.push(reason_bytes("combined-exceeds-disk", combined_install));
    }

    let mut verdict = "recommended";
    for v in verdicts {
        if rank(v) < rank(verdict) {
            verdict = v;
        }
    }
    if verdict != "insufficient" && facts.disk_free.is_some_and(|disk| combined_install > disk) {
        verdict = "insufficient";
    }

    json!({
        "verdict": verdict,
        "catalogVersion": catalog.get("version").cloned().unwrap_or(Value::Null),
        "roles": assessments,
        "combined": {
            "memoryBytes": num(combined_memory),
            "budgetBytes": num(budget),
            "installBytes": num(combined_install),
            "diskFreeBytes": facts.disk_free.map_or(Value::Null, num),
        },
        "reasons": dedupe(report_reasons),
        "unknowns": unknowns,
    })
}
