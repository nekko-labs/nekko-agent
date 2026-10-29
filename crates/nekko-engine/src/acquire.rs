//! What acquiring a model fetches, as plans the download queue runs: one
//! quantization of a catalog model, the companion files a model on disk is
//! missing, an image model's text encoders and VAE; and what a finished
//! download sets up (the GPU-first preset). Ports of the engine facade's
//! `modelDownloadPlan`, `sourceRepoFor`, `companionsPlan`,
//! `imageCompanionsPlan`, `finishedModelJobs`, `downloadedModel` and
//! `gpuFirstPreset`, and of `image-companions.ts`, held to them by
//! `tests/golden/downloads.json`.

use crate::capacity::{self, AutoFitInput, Hardware, PlanOptions};
use crate::catalog::hf_file_url;
use crate::folders::companions_dir;
use crate::library::{default_context_tokens, model_facts_for, model_modality};
use crate::{js_round, num};
use nekko_tools::nodefs;
use nekko_tools::path::native as path;
use regress::Regex;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::sync::OnceLock;

fn re(pattern: &str, flags: &str) -> Regex {
    Regex::with_flags(pattern, flags).expect("a valid built-in pattern")
}

fn test(r: &Regex, s: &str) -> bool {
    r.find(s).is_some()
}

/// A string field, or `""` as a template literal prints `undefined`/`null`...
/// only where the TS would print the value itself.
fn text(v: Option<&Value>) -> String {
    v.map(nekko_js::display).unwrap_or_else(|| "undefined".into())
}

fn last_segment(file: &str) -> &str {
    file.rsplit('/').next().unwrap_or(file)
}

/// `{ ok: false, message }`.
pub fn refusal(message: impl Into<String>) -> Value {
    json!({ "ok": false, "message": message.into() })
}

/* ------------------------------------------------------- catalog models */

/// The downloads one quantization of a catalog model takes (`modelDownloadPlan`):
/// `{ ok, message, main, extras, verifyGguf }`, or a refusal.
pub fn model_download_plan(
    model: &Value,
    model_id: &str,
    quant_label: &str,
    models_dir: &str,
    landed: &dyn Fn(&str) -> bool,
) -> Value {
    let quants = model.get("quants").and_then(Value::as_array);
    let quant = quants
        .and_then(|q| q.iter().find(|q| q.get("label").and_then(Value::as_str) == Some(quant_label)))
        .or_else(|| quants.and_then(|q| q.first()));
    let (Some(_), Some(quant)) = (model.as_object(), quant) else {
        return refusal("That model is no longer published.");
    };
    let name = text(model.get("name"));
    let label = text(quant.get("label"));
    let file = text(quant.get("file"));
    let mlx = quant.get("format").and_then(Value::as_str) == Some("mlx");
    let kind = if mlx {
        "mlx"
    } else {
        let tags: Vec<String> = model
            .get("tags")
            .and_then(Value::as_array)
            .map(|t| t.iter().map(|x| if x.is_null() { String::new() } else { nekko_js::display(x) }).collect())
            .unwrap_or_default();
        let pipeline = model.get("pipelineTag").filter(|p| !p.is_null()).map(nekko_js::display).unwrap_or_default();
        model_modality(None, Some(&format!("{name} {model_id} {} {pipeline} {file}", tags.join(" "))), false, None)
    };
    let repo_dir = model_id.replacen('/', "_", 1);
    let dest_for = |f: &str| path::join(&[models_dir, kind, &repo_dir, last_segment(f)]);
    let job_id = format!("model:{model_id}:{label}");
    let group_label = format!("{name} · {label}");
    let main = json!({
        "id": job_id,
        "kind": "model",
        "label": group_label,
        "target": model_id,
        "url": hf_file_url(model_id, &file),
        "dest": dest_for(&file),
        "group": job_id,
        "groupLabel": group_label,
        "file": file,
    });
    let mut extras = Vec::new();
    for extra in quant.get("extraFiles").and_then(Value::as_array).into_iter().flatten() {
        let extra = nekko_js::display(extra);
        let dest = dest_for(&extra);
        // Sidecars are shared across quants; one already on disk is not fetched again.
        if landed(&dest) {
            continue;
        }
        extras.push(json!({
            "id": format!("{job_id}:{extra}"),
            "kind": "model",
            "label": format!("{name} · {}", last_segment(&extra)),
            "target": model_id,
            "url": hf_file_url(model_id, &extra),
            "dest": dest,
            "group": job_id,
            "groupLabel": group_label,
            "file": extra,
        }));
    }
    json!({
        "ok": true,
        "message": format!("Downloading {name} ({label})."),
        "main": main,
        "extras": extras,
        "verifyGguf": !mlx,
    })
}

/// Which Hugging Face repo a library model came from, guessed from its id (`sourceRepoFor`).
pub fn source_repo_for(model: &Value) -> Option<String> {
    if let Some(repo) = nekko_js::truthy_str(model.get("sourceRepo")) {
        return Some(repo.to_string());
    }
    let id = model.get("id").map(nekko_js::display).unwrap_or_default();
    let segs: Vec<&str> = id.split('/').collect();
    let folder = model.get("folderId").filter(|f| nekko_js::truthy(Some(f)));
    let primary = |f: &Value| f.as_str() == Some(crate::library::PRIMARY_FOLDER_ID);
    if folder.is_some_and(|f| !primary(f)) && segs.len() >= 3 {
        return Some(format!("{}/{}", segs[1], segs[2]));
    }
    if folder.is_none_or(primary) && segs.len() >= 2 {
        let dir: Vec<u16> = segs[0].encode_utf16().collect();
        if let Some(i) = dir.iter().position(|u| *u == u16::from(b'_'))
            && i > 0
            && i < dir.len() - 1
        {
            return Some(format!(
                "{}/{}",
                String::from_utf16_lossy(&dir[..i]),
                String::from_utf16_lossy(&dir[i + 1..])
            ));
        }
    }
    None
}

/// The companion files to fetch for a model on disk (`companionsPlan`), given
/// what its repo ships (`found`, `null` when the repo could not be read).
pub fn companions_plan(
    model: &Value,
    repo: &str,
    found: &Value,
    models_dir: &str,
    landed: &dyn Fn(&str) -> bool,
) -> Value {
    let name = text(model.get("name"));
    if found.is_null() {
        return json!({
            "ok": false,
            "message": format!("Could not read the {repo} repo on Hugging Face. It may be private or renamed."),
            "requests": [],
        });
    }
    let mut wanted: Vec<String> = Vec::new();
    if let Some(p) = found.get("projector").filter(|p| nekko_js::truthy(Some(p))) {
        wanted.push(nekko_js::display(p));
    }
    for s in found.get("sidecars").and_then(Value::as_array).into_iter().flatten() {
        if nekko_js::truthy(Some(s)) {
            wanted.push(nekko_js::display(s));
        }
    }
    if wanted.is_empty() {
        return json!({ "ok": true, "message": format!("{repo} ships no companion files for {name}."), "requests": [] });
    }
    let id = text(model.get("id"));
    let model_path = text(model.get("path"));
    let model_dir = path::dirname(&model_path);
    let dest_dir = if model.get("managed") == Some(&Value::Bool(false)) {
        companions_dir(models_dir, &id)
    } else {
        model_dir.clone()
    };
    let mut requests = Vec::new();
    for file in wanted {
        let file_name = last_segment(&file).to_string();
        let dest = path::join(&[&dest_dir, &file_name]);
        // A file already beside the weights counts even when the destination is the companions dir.
        let beside = path::join(&[&model_dir, &file_name]);
        if landed(&dest) || (dest != beside && landed(&beside)) {
            continue;
        }
        requests.push(json!({
            "id": format!("companions:{id}:{file}"),
            "kind": "model",
            "label": format!("{name} · {file_name}"),
            "target": id,
            "url": hf_file_url(repo, &file),
            "dest": dest,
            "group": format!("companions:{id}"),
            "groupLabel": format!("{name} · companion files"),
            "file": file,
        }));
    }
    let queued = requests.len();
    let message = if queued > 0 {
        format!("Fetching {queued} companion file{} for {name} from {repo}.", if queued == 1 { "" } else { "s" })
    } else {
        format!("{name} already has every companion file {repo} ships.")
    };
    json!({ "ok": true, "message": message, "requests": requests })
}

/* ------------------------------------------------------ image companions */

/// The image companion sets (`IMAGE_COMPANION_SETS`), in the TS shape.
pub fn image_companion_sets() -> &'static Vec<Value> {
    static SETS: OnceLock<Vec<Value>> = OnceLock::new();
    SETS.get_or_init(|| {
        let flux2_vae = json!({ "role": "vae", "repo": "Comfy-Org/flux2-dev", "file": "split_files/vae/flux2-vae.safetensors", "saveAs": "vae-flux2.safetensors", "bytes": 336_213_556u64 });
        let sd3 = "Comfy-Org/stable-diffusion-3.5-fp8";
        let clip_l = json!({ "role": "clip_l", "repo": sd3, "file": "text_encoders/clip_l.safetensors", "saveAs": "clip_l.safetensors", "bytes": 246_144_152u64 });
        let t5 = json!({ "role": "t5xxl", "repo": sd3, "file": "text_encoders/t5xxl_fp8_e4m3fn.safetensors", "saveAs": "t5xxl_fp8_e4m3fn.safetensors", "bytes": 4_893_934_904u64 });
        vec![
            json!({
                "id": "flux2-klein-9b", "label": "FLUX.2 klein 9B", "defaults": { "steps": 4, "cfgScale": 1 },
                "files": [flux2_vae, { "role": "llm", "repo": "unsloth/Qwen3-8B-GGUF", "file": "Qwen3-8B-Q4_K_M.gguf", "saveAs": "llm-qwen3-8b-q4_k_m.gguf", "bytes": 5_027_784_512u64 }],
            }),
            json!({
                "id": "flux2-klein-4b", "label": "FLUX.2 klein 4B", "defaults": { "steps": 4, "cfgScale": 1 },
                "files": [flux2_vae, { "role": "llm", "repo": "unsloth/Qwen3-4B-GGUF", "file": "Qwen3-4B-Q4_K_M.gguf", "saveAs": "llm-qwen3-4b-q4_k_m.gguf", "bytes": 2_497_281_312u64 }],
            }),
            json!({
                "id": "sd3", "label": "Stable Diffusion 3.5", "defaults": { "steps": 28, "cfgScale": 4.5 },
                "files": [
                    clip_l,
                    { "role": "clip_g", "repo": sd3, "file": "text_encoders/clip_g.safetensors", "saveAs": "clip_g.safetensors", "bytes": 1_389_382_176u64 },
                    t5,
                    {
                        "role": "vae", "repo": "stabilityai/stable-diffusion-3.5-large", "file": "vae/diffusion_pytorch_model.safetensors", "saveAs": "vae-sd3.safetensors", "bytes": 167_666_902u64, "gated": true,
                        "fallback": { "role": "taesd", "repo": "madebyollin/taesd3", "file": "diffusion_pytorch_model.safetensors", "saveAs": "taesd-sd3.safetensors", "bytes": 9_848_636u64 },
                    },
                ],
            }),
            json!({
                "id": "flux1", "label": "FLUX.1", "defaults": { "steps": 20, "cfgScale": 1 },
                "files": [
                    clip_l,
                    t5,
                    {
                        "role": "vae", "repo": "black-forest-labs/FLUX.1-schnell", "file": "ae.safetensors", "saveAs": "vae-flux1.safetensors", "bytes": 335_304_388u64, "gated": true,
                        "fallback": { "role": "taesd", "repo": "madebyollin/taef1", "file": "diffusion_pytorch_model.safetensors", "saveAs": "taesd-flux1.safetensors", "bytes": 9_848_636u64 },
                    },
                ],
            }),
        ]
    })
}

/// Which set a model belongs to, from its architecture, name and path (`imageCompanionSetFor`).
pub fn image_companion_set_for(model: &Value) -> Option<Value> {
    let arch = model.get("architecture").filter(|a| !a.is_null());
    let joined = format!(
        "{} {} {}",
        arch.map(nekko_js::display).unwrap_or_default(),
        text(model.get("name")),
        text(model.get("path"))
    );
    let text = nekko_js::slice16(&joined, 1024).to_lowercase();
    let by_id = |id: &str| image_companion_sets().iter().find(|s| s["id"] == id).cloned();
    static FLUX2: OnceLock<Regex> = OnceLock::new();
    let flux2 = FLUX2.get_or_init(|| re(r"flux[._ -]?2", ""));
    if test(flux2, &text) && text.contains("klein") {
        static FOUR: OnceLock<Regex> = OnceLock::new();
        let four = FOUR.get_or_init(|| re(r"\b4b\b|[-_]4b[-_.]", ""));
        return by_id(if test(four, &text) { "flux2-klein-4b" } else { "flux2-klein-9b" });
    }
    // FLUX.2 dev pairs with a 24B Mistral encoder; no set until a small quant exists.
    if test(flux2, &text) {
        return None;
    }
    static SD3: OnceLock<Regex> = OnceLock::new();
    if arch.and_then(Value::as_str) == Some("sd3") || test(SD3.get_or_init(|| re(r"sd3|stable.diffusion.3", "")), &text)
    {
        return by_id("sd3");
    }
    static FLUX1: OnceLock<Regex> = OnceLock::new();
    if arch.and_then(Value::as_str) == Some("flux") || test(FLUX1.get_or_init(|| re(r"flux[._ -]?1", "")), &text) {
        let mut flux1 = by_id("flux1")?;
        // schnell is the 4-step distillation; dev wants the full schedule.
        if text.contains("schnell") {
            flux1["defaults"] = json!({ "steps": 4, "cfgScale": 1 });
        }
        return Some(flux1);
    }
    None
}

/// `<models>/.companions/image`.
pub fn image_companions_dir(models_dir: &str) -> String {
    path::join(&[models_dir, ".companions", "image"])
}

fn present(p: &str) -> bool {
    std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.len() > 0)
}

/// What a model's set has on disk (`imageCompanionStatus`), or `null`.
pub fn image_companion_status(model: &Value, dir: &str, beside: &Map<String, Value>, has_token: bool) -> Value {
    let Some(set) = image_companion_set_for(model) else { return Value::Null };
    let preset = model
        .get("preset")
        .and_then(|p| p.get("diffusion"))
        .filter(|d| !d.is_null())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let mut files = Vec::new();
    for f in set["files"].as_array().into_iter().flatten() {
        let role = text(f.get("role"));
        let own = preset.get(&role).filter(|v| !v.is_null()).or_else(|| beside.get(&role)).filter(|v| !v.is_null());
        let shared = path::join(&[dir, &text(f.get("saveAs"))]);
        let fallback = f.get("fallback").map(|fb| path::join(&[dir, &text(fb.get("saveAs"))]));
        let own_path = own.filter(|o| nekko_js::truthy(Some(o))).map(nekko_js::display);
        let found = match own_path {
            Some(o) if present(&o) => Some(o),
            _ if present(&shared) => Some(shared.clone()),
            _ => fallback.clone().filter(|fb| present(fb)),
        };
        // Without a token a gated file cannot be fetched: report what will be.
        let gated = f.get("gated") == Some(&Value::Bool(true));
        let fetches = if gated && !has_token && f.get("fallback").is_some() { &f["fallback"] } else { f };
        let fetches_self = std::ptr::eq(fetches, f);
        let mut o = Map::new();
        o.insert("role".into(), json!(role));
        o.insert("source".into(), json!(format!("{}/{}", text(fetches.get("repo")), text(fetches.get("file")))));
        o.insert("bytes".into(), fetches.get("bytes").cloned().unwrap_or(Value::Null));
        o.insert("gated".into(), json!(fetches_self && gated));
        if let Some(p) = &found {
            o.insert("path".into(), json!(p));
        }
        let using = match &found {
            Some(p) => fallback.as_deref() == Some(p.as_str()),
            None => !fetches_self,
        };
        o.insert("usingFallback".into(), json!(using));
        files.push(Value::Object(o));
    }
    let missing: f64 = files.iter().filter(|f| f.get("path").is_none()).filter_map(|f| f["bytes"].as_f64()).sum();
    json!({
        "setId": set["id"],
        "label": set["label"],
        "ready": files.iter().all(|f| f.get("path").is_some()),
        "files": files,
        "missingBytes": num(missing),
        "defaults": set["defaults"],
    })
    .as_object()
    .map(|o| {
        // The TS key order: setId, label, files, ready, missingBytes, defaults.
        let mut out = Map::new();
        for k in ["setId", "label", "files", "ready", "missingBytes", "defaults"] {
            out.insert(k.into(), o[k].clone());
        }
        Value::Object(out)
    })
    .unwrap_or(Value::Null)
}

/// Beside-the-weights files, found as sd.cpp users lay them out (`companionsBeside`).
pub fn companions_beside(model: &Value, dirs: &[String]) -> Map<String, Value> {
    static ROLES: OnceLock<Vec<(&'static str, Regex)>> = OnceLock::new();
    let roles = ROLES.get_or_init(|| {
        ["clip_l", "clip_g", "t5xxl", "vae", "llm", "taesd"]
            .into_iter()
            .map(|role| (role, re(&format!("^{}[_.-]", role.replacen('_', "[_-]", 1)), "i")))
            .collect()
    });
    static EXT: OnceLock<Regex> = OnceLock::new();
    let ext = EXT.get_or_init(|| re(r"\.(gguf|safetensors|sft)$", "i"));
    let mut found = Map::new();
    let first = path::dirname(&text(model.get("path")));
    for d in std::iter::once(&first).chain(dirs) {
        let names: Vec<String> =
            nodefs::read_dir(d).map(|e| e.into_iter().map(|e| e.name).collect()).unwrap_or_default();
        for (role, pattern) in roles {
            if found.contains_key(*role) {
                continue;
            }
            if let Some(file) = names.iter().find(|f| test(pattern, f) && test(ext, f)) {
                found.insert((*role).into(), json!(path::join(&[d, file])));
            }
        }
    }
    found
}

/// The text encoders and VAE to fetch for an image model (`imageCompanionsPlan`).
pub fn image_companions_plan(model: &Value, status: &Value, token: Option<&str>, models_dir: &str) -> Value {
    let name = text(model.get("name"));
    let (Some(set), false) = (image_companion_set_for(model), status.is_null()) else {
        return json!({
            "ok": false,
            "message": format!("No known text encoders for {name}. Set their paths in its image settings."),
            "requests": [],
        });
    };
    let dir = image_companions_dir(models_dir);
    let label = text(set.get("label"));
    let id = text(model.get("id"));
    let mut requests = Vec::new();
    let mut bytes = 0.0;
    let mut stood_in = String::new();
    for (i, file) in set["files"].as_array().into_iter().flatten().enumerate() {
        if status["files"].get(i).and_then(|f| f.get("path")).is_some_and(|p| nekko_js::truthy(Some(p))) {
            continue;
        }
        let gated = file.get("gated") == Some(&Value::Bool(true));
        let has_token = token.is_some_and(|t| !t.is_empty());
        let pick = if gated && !has_token && file.get("fallback").is_some() { &file["fallback"] } else { file };
        let own = std::ptr::eq(pick, file);
        if !own {
            stood_in = format!(
                " Its VAE needs a Hugging Face token with the {} license accepted, so the small TAESD decoder stands in (slightly softer detail).",
                text(file.get("repo"))
            );
        }
        let mut r = Map::new();
        r.insert("id".into(), json!(format!("image-companions:{}", text(pick.get("saveAs")))));
        r.insert("kind".into(), json!("model"));
        r.insert("label".into(), json!(format!("{label} · {}", text(pick.get("role")))));
        r.insert("target".into(), json!(id));
        r.insert("url".into(), json!(hf_file_url(&text(pick.get("repo")), &text(pick.get("file")))));
        r.insert("dest".into(), json!(path::join(&[&dir, &text(pick.get("saveAs"))])));
        r.insert("group".into(), json!(format!("image-companions:{id}")));
        r.insert("groupLabel".into(), json!(format!("{label} · text encoders and VAE")));
        r.insert("file".into(), pick.get("file").cloned().unwrap_or(Value::Null));
        r.insert("role".into(), pick.get("role").cloned().unwrap_or(Value::Null));
        if own && gated && has_token {
            r.insert("headers".into(), json!({ "Authorization": format!("Bearer {}", token.unwrap_or_default()) }));
        }
        requests.push(Value::Object(r));
        bytes += pick.get("bytes").and_then(Value::as_f64).unwrap_or(0.0);
    }
    let queued = requests.len();
    if queued == 0 {
        return json!({ "ok": true, "message": format!("{name} already has its text encoders and VAE."), "requests": requests });
    }
    json!({
        "ok": true,
        "message": format!(
            "Fetching {queued} file{} ({} GB) for {label}.{stood_in}",
            if queued == 1 { "" } else { "s" },
            nekko_js::to_fixed_unsigned_zero(bytes / 1e9, 1)
        ),
        "requests": requests,
    })
}

/* ------------------------------------------------- after a download lands */

/// The model jobs that have just finished (`finishedModelJobs`): main files
/// only, each once. `seen` carries every job's last state between calls.
pub fn finished_model_jobs(jobs: &[Value], seen: &mut HashMap<String, String>) -> Vec<Value> {
    let id_of = |j: &Value| j.get("id").map(nekko_js::display).unwrap_or_default();
    let present: std::collections::HashSet<String> = jobs.iter().map(id_of).collect();
    seen.retain(|id, _| present.contains(id));
    let finished = jobs
        .iter()
        .filter(|j| {
            j.get("kind").and_then(Value::as_str) == Some("model")
                && j.get("state").and_then(Value::as_str) == Some("done")
                && seen.get(&id_of(j)).map(String::as_str) != Some("done")
                // `model:<repo>:<quant>` is three segments; a companion's id appends the file.
                && id_of(j).split(':').count() == 3
                && nekko_js::truthy(j.get("dest"))
        })
        .cloned()
        .collect();
    for j in jobs {
        seen.insert(id_of(j), j.get("state").map(nekko_js::display).unwrap_or_default());
    }
    finished
}

/// The library row a finished download created, matched on where it landed (`downloadedModel`).
pub fn downloaded_model(list: &[Value], job: &Value) -> Option<Value> {
    let dest = path::resolve(&[&text(job.get("dest"))]);
    let parent = path::resolve(&[&path::dirname(&dest)]);
    list.iter()
        .find(|m| {
            let p = path::resolve(&[&text(m.get("path"))]);
            p == dest || p == parent
        })
        .cloned()
}

/// The preset a fresh download starts with (`gpuFirstPreset`): the planner's
/// best full-GPU answer; nothing without a GPU, or when the planner cannot
/// read the model or says it cannot run at all.
pub fn gpu_first_preset(model: &Value, hw: Option<&Hardware>, overhead_floor: f64) -> Option<Value> {
    let hw = hw.filter(|h| !h.devices.is_empty())?;
    let facts = model_facts_for(model);
    let result = capacity::auto_fit(&AutoFitInput {
        facts: &facts,
        hardware: hw,
        budget_fraction: 0.9,
        parallel_slots: None,
        max_context_tokens: Some(default_context_tokens(model.get("maxContext").and_then(Value::as_f64))),
        options: PlanOptions { overhead_floor: Some(overhead_floor), siblings: Vec::new() },
    });
    let verdict = result["plan"]["verdict"].as_str().unwrap_or_default();
    if verdict == "unknown" || verdict == "wont-load" {
        return None;
    }
    let req = &result["request"];
    let layers = model.get("layers").filter(|l| !l.is_null()).or_else(|| result["plan"].get("totalLayers")).cloned();
    let mut preset = Map::new();
    preset.insert("contextTokens".into(), req["contextTokens"].clone());
    preset.insert("kvCacheDtype".into(), req["kvCacheDtype"].clone());
    preset.insert("parallelSlots".into(), req["parallelSlots"].clone());
    if let Some(l) = layers {
        let fraction = req["gpuLayerFraction"].as_f64().unwrap_or(f64::NAN);
        preset.insert("gpuLayers".into(), num(js_round(nekko_js::to_number(Some(&l)) * fraction)));
    }
    preset.insert("budgetFraction".into(), json!(0.9));
    Some(Value::Object(preset))
}
