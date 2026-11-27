//! Replays the frozen TS library golden set (`golden/library.json`): the same
//! GGUF headers read the same, the same names get the same modality, the
//! same fixture tree lists, imports, deletes and reports the same rows, text
//! for text, and `library.json` ends up the same after every step.

use nekko_engine::capacity::Hardware;
use nekko_engine::folders::{companions_dir, folder_id, known_candidates};
use nekko_engine::library::{self, LibraryConfig};
use nekko_engine::{gguf, library::default_context_tokens, library::model_modality};
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};

fn golden() -> Value {
    serde_json::from_str(include_str!("golden/library.json")).unwrap()
}

/* ------------------------------------------------- the TS fixture builder */

fn ggstr(s: &str) -> Vec<u8> {
    let mut out = (s.len() as u64).to_le_bytes().to_vec();
    out.extend_from_slice(s.as_bytes());
    out
}

fn scalar(ty: &str, v: &Value) -> Vec<u8> {
    let f = v.as_f64().unwrap();
    match ty {
        "u8" | "bool" => vec![f as u8],
        "i8" => (f as i8).to_le_bytes().to_vec(),
        "u16" => (f as u16).to_le_bytes().to_vec(),
        "i16" => (f as i16).to_le_bytes().to_vec(),
        "u32" => (f as u32).to_le_bytes().to_vec(),
        "i32" => (f as i32).to_le_bytes().to_vec(),
        "f32" => (f as f32).to_le_bytes().to_vec(),
        "u64" => v.as_u64().unwrap_or(f as u64).to_le_bytes().to_vec(),
        "i64" => v.as_i64().unwrap_or(f as i64).to_le_bytes().to_vec(),
        "f64" => f.to_le_bytes().to_vec(),
        other => panic!("type {other}"),
    }
}

fn tag(ty: &str) -> u32 {
    match ty {
        "u8" => 0,
        "i8" => 1,
        "u16" => 2,
        "i16" => 3,
        "u32" => 4,
        "i32" => 5,
        "f32" => 6,
        "bool" => 7,
        "string" => 8,
        "u64" => 10,
        "i64" => 11,
        "f64" => 12,
        other => panic!("type {other}"),
    }
}

fn encode(v: &Value) -> Vec<u8> {
    let ty = v["type"].as_str().unwrap();
    let mut out = Vec::new();
    match ty {
        "string" => {
            out.extend(8u32.to_le_bytes());
            out.extend(ggstr(v["value"].as_str().unwrap()));
        }
        "strings" => {
            let items = v["value"].as_array().unwrap();
            out.extend(9u32.to_le_bytes());
            out.extend(8u32.to_le_bytes());
            out.extend((items.len() as u64).to_le_bytes());
            for s in items {
                out.extend(ggstr(s.as_str().unwrap()));
            }
        }
        "vocab" => {
            let count = v["count"].as_u64().unwrap();
            let prefix = v["prefix"].as_str().unwrap();
            out.extend(9u32.to_le_bytes());
            out.extend(8u32.to_le_bytes());
            out.extend(count.to_le_bytes());
            for i in 0..count {
                out.extend(ggstr(&format!("{prefix}{i}")));
            }
        }
        "u32s" => {
            let items = v["value"].as_array().unwrap();
            out.extend(9u32.to_le_bytes());
            out.extend(4u32.to_le_bytes());
            out.extend((items.len() as u64).to_le_bytes());
            for n in items {
                out.extend(scalar("u32", n));
            }
        }
        _ => {
            out.extend(tag(ty).to_le_bytes());
            out.extend(scalar(ty, &v["value"]));
        }
    }
    out
}

fn hex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

fn build(spec: &Value) -> Vec<u8> {
    if let Some(h) = spec.get("hex") {
        return hex(h.as_str().unwrap());
    }
    let pairs = spec["pairs"].as_array().unwrap();
    let mut out = Vec::new();
    out.extend((spec.get("magic").and_then(Value::as_u64).unwrap_or(0x4655_4747) as u32).to_le_bytes());
    out.extend((spec.get("version").and_then(Value::as_u64).unwrap_or(3) as u32).to_le_bytes());
    out.extend(0u64.to_le_bytes());
    out.extend((pairs.len() as u64).to_le_bytes());
    for pair in pairs {
        out.extend(ggstr(pair[0].as_str().unwrap()));
        out.extend(encode(&pair[1]));
    }
    out.extend([0u8; 64]);
    if let Some(n) = spec.get("truncate").and_then(Value::as_u64) {
        out.truncate(n as usize);
    }
    out
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nekko-lib-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Every string below `root` as `<root>/...` with `/` separators, as the TS recorded it.
fn norm(root: &str, v: &Value) -> Value {
    match v {
        Value::String(s) => Value::String(s.replace(root, "<root>").replace('\\', "/")),
        Value::Array(a) => Value::Array(a.iter().map(|x| norm(root, x)).collect()),
        Value::Object(m) => Value::Object(m.iter().map(|(k, x)| (k.clone(), norm(root, x))).collect()),
        other => other.clone(),
    }
}

fn denorm(root: &str, v: &Value) -> Value {
    match v {
        Value::String(s) => Value::String(s.replace("<root>", root)),
        Value::Array(a) => Value::Array(a.iter().map(|x| denorm(root, x)).collect()),
        Value::Object(m) => Value::Object(m.iter().map(|(k, x)| (k.clone(), denorm(root, x))).collect()),
        other => other.clone(),
    }
}

#[test]
fn reads_gguf_headers_as_the_host_does() {
    let g = golden();
    let dir = scratch("gguf");
    for case in g["gguf"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let p = dir.join(format!("{name}.gguf"));
        std::fs::write(&p, build(&case["spec"])).unwrap();
        let out = gguf::read_metadata(p.to_str().unwrap()).map_or(Value::Null, |m| m.to_value());
        assert_eq!(nekko_js::stringify(&out), case["out"].as_str().unwrap(), "{name}");
    }
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn guesses_modality_and_context_as_the_host_does() {
    let g = golden();
    for case in g["modality"].as_array().unwrap() {
        let i = &case["input"];
        let got = model_modality(
            i.get("architecture").and_then(Value::as_str),
            i.get("name").and_then(Value::as_str),
            nekko_js::truthy(i.get("hasProjector")),
            i.get("readable"),
        );
        assert_eq!(got, case["out"].as_str().unwrap(), "{i}");
    }
    for case in g["contexts"].as_array().unwrap() {
        let got = default_context_tokens(case.get("maxContext").and_then(Value::as_f64));
        assert_eq!(got, case["out"].as_f64().unwrap(), "{case}");
    }
}

#[test]
fn discovers_a_renamed_gguf_dflash_head_from_its_header() {
    let dir = scratch("gguf-dflash-discovery");
    let head = dir.join("renamed.gguf");
    std::fs::write(
        &head,
        build(&json!({ "pairs": [
            ["general.architecture", { "type": "string", "value": "dflash" }],
            ["dflash.block_size", { "type": "u32", "value": 8 }],
            ["dflash.selector_rank", { "type": "u32", "value": 256 }]
        ] })),
    )
    .unwrap();
    let cfg = LibraryConfig {
        models_dir: dir.to_string_lossy().into_owned(),
        folders: vec![],
        mlx_runnable: false,
        now: 1.0,
    };
    let rows = library::list(&cfg).unwrap();
    assert_eq!(rows.len(), 1, "{rows:?}");
    let row = &rows[0];
    assert_eq!(row["architecture"], "dflash");
    assert_eq!(row["modality"], "draft");
    assert!(nekko_engine::launch::unsupported_load_reason(row).unwrap().contains("not on its own"));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn finds_the_other_apps_folders_as_the_host_does() {
    let g = golden();
    for case in g["candidates"].as_array().unwrap() {
        let env = case["env"].as_object().unwrap().clone();
        let home = env.get("HOME").and_then(Value::as_str).unwrap_or_default().to_string();
        let lookup = move |k: &str| env.get(k).and_then(Value::as_str).map(str::to_string);
        let got: Vec<Value> =
            known_candidates(case["os"].as_str().unwrap(), &home, &lookup).iter().map(|c| c.to_value()).collect();
        assert_eq!(norm("\u{0}", &json!(got)), case["out"], "{} {}", case["os"], case["env"]);
    }
    for case in g["folderIds"].as_array().unwrap() {
        let got = folder_id(case.get("provider").and_then(Value::as_str), case["path"].as_str().unwrap());
        assert_eq!(got, case["out"].as_str().unwrap(), "{case}");
    }
    for case in g["companionKeys"].as_array().unwrap() {
        let got = companions_dir("", case["id"].as_str().unwrap()).replace('\\', "/");
        assert_eq!(got, case["out"].as_str().unwrap(), "{case}");
    }
}

#[test]
fn rates_gpu_fit_as_the_host_does() {
    let g = golden();
    for case in g["gpuFit"].as_array().unwrap() {
        let hw = Hardware::from_value(&case["hw"]);
        let got = library::gpu_fit_for(&case["model"], &hw, case.get("floor").and_then(Value::as_f64));
        assert_eq!(got, case["out"].as_str().unwrap(), "{}", case["model"]);
    }
}

fn fit_hw(total_gb: f64, free_gb: f64, unified: bool) -> Hardware {
    const GB: f64 = 1024.0 * 1024.0 * 1024.0;
    Hardware::from_value(&json!({
        "devices": [{"name": "GPU", "totalBytes": total_gb * GB, "freeBytes": free_gb * GB}],
        "unified": unified,
        "systemRamTotalBytes": 64.0 * GB,
        "systemRamFreeBytes": 32.0 * GB,
    }))
}

/// 6.3 GB of weights and buffers and 64 MB of KV per 1k tokens, as on a 12 GB laptop card.
fn fit_model(preset: Value) -> Value {
    json!({
        "id": "m", "name": "m", "path": "/m.gguf", "sizeBytes": 6.3 * 1024.0 * 1024.0 * 1024.0,
        "layers": 16, "kvHeads": 8, "headDim": 128, "maxContext": 131072, "addedAt": 0,
        "preset": preset,
    })
}

#[test]
fn rates_gpu_fit_on_an_idle_card() {
    // 11.9 GB card, 8.7 GB free: the 64k default context with an f16 cache
    // spills now and on an idle card.
    let hw = fit_hw(11.9, 8.7, false);
    let model = fit_model(json!({ "kvCacheDtype": "f16" }));
    assert_eq!(library::gpu_fit_for(&model, &hw, None), "partial");
    assert_eq!(library::gpu_fit_idle_for(&model, &hw, None), Some("partial"));
    // The engine's default q8_0 cache (#3325) is half the size: it still
    // spills beside the other apps, but fits whole once they let go.
    assert_eq!(library::gpu_fit_for(&fit_model(json!({})), &hw, None), "partial");
    assert_eq!(library::gpu_fit_idle_for(&fit_model(json!({})), &hw, None), Some("full"));
    // A 16k context spills beside the other apps but fits once they let go.
    let small = fit_model(json!({"contextTokens": 16384}));
    let hw = fit_hw(11.9, 5.0, false);
    assert_eq!(library::gpu_fit_for(&small, &hw, None), "partial");
    assert_eq!(library::gpu_fit_idle_for(&small, &hw, None), Some("full"));
    // The idle idea does not apply to unified memory or a machine without a GPU.
    assert_eq!(library::gpu_fit_idle_for(&model, &fit_hw(11.9, 8.7, true), None), None);
    let mut none = fit_hw(11.9, 8.7, false);
    none.devices.clear();
    assert_eq!(library::gpu_fit_idle_for(&model, &none, None), None);
    // Only partial rows carry the idle verdict.
    let rows = library::with_load_state(
        vec![model.clone(), small.clone()],
        &Default::default(),
        &Map::new(),
        Some(&fit_hw(11.9, 5.0, false)),
        None,
        &Default::default(),
    );
    assert_eq!((rows[0]["gpuFit"].as_str(), rows[0]["gpuFitIdle"].as_str()), (Some("partial"), Some("partial")));
    let rows = library::with_load_state(
        vec![small],
        &Default::default(),
        &Map::new(),
        Some(&fit_hw(11.9, 11.0, false)),
        None,
        &Default::default(),
    );
    assert_eq!(rows[0]["gpuFit"], "full");
    assert!(rows[0].get("gpuFitIdle").is_none());
}

fn write_tree(root: &Path, tree: &Map<String, Value>) {
    for (rel, spec) in tree {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        let bytes = if let Some(g) = spec.get("gguf") {
            build(g)
        } else if let Some(t) = spec.get("text") {
            t.as_str().unwrap().as_bytes().to_vec()
        } else {
            vec![0u8; spec["size"].as_u64().unwrap() as usize]
        };
        std::fs::write(p, bytes).unwrap();
    }
}

fn files(dir: &Path) -> Vec<String> {
    fn walk(dir: &Path, prefix: &str, out: &mut Vec<String>) {
        for e in std::fs::read_dir(dir).unwrap() {
            let e = e.unwrap();
            let name = e.file_name().to_string_lossy().into_owned();
            if e.file_type().unwrap().is_dir() {
                walk(&e.path(), &format!("{prefix}{name}/"), out);
            } else {
                out.push(format!("{prefix}{name}"));
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, "", &mut out);
    out.sort();
    out
}

/// A header with a name and the architecture the reader needs to accept it.
fn named_gguf(name: &str) -> Vec<u8> {
    build(&json!({ "pairs": [
        ["general.architecture", { "type": "string", "value": "llama" }],
        ["general.name", { "type": "string", "value": name }],
    ] }))
}

#[test]
fn names_a_model_by_its_file_when_the_header_name_is_generic() {
    let dir = scratch("names");
    let lm = dir.join("lmstudio");
    let files = [
        ("prism-ml/Ternary-Bonsai-2-27B-gguf/Ternary-Bonsai-2-27B-PTQ1_0.gguf", "Hf"),
        ("ConwayResearch/Underdog-Saluki-27B-1.0/Underdog-Saluki-27B-1.0-IQ2-mix.gguf", "Qwen3.8-27B GSQ-RCO"),
        ("loose/Some-Model-Q4_K_M.gguf", " models "),
    ];
    for (rel, name) in files {
        let p = lm.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, named_gguf(name)).unwrap();
    }
    let models = dir.join("models").to_string_lossy().into_owned();
    let folders = vec![json!({ "id": "lm", "path": lm.to_string_lossy(), "provider": "lmstudio", "enabled": true })];
    let cfg = LibraryConfig { models_dir: models, folders, mlx_runnable: false, now: 1.0 };
    let rows = library::list(&cfg).unwrap();
    let row = |file: &str| rows.iter().find(|r| r["file"].as_str().unwrap().ends_with(file)).unwrap().clone();

    let bonsai = row("Ternary-Bonsai-2-27B-PTQ1_0.gguf");
    assert_eq!(bonsai["name"], "Ternary-Bonsai-2-27B-PTQ1_0");
    assert_eq!(bonsai["sourceRepo"], "prism-ml/Ternary-Bonsai-2-27B-gguf");
    // A name that says something keeps winning, over the folder too: this
    // Qwen3.8 quant sits in a folder named for another model.
    let saluki = row("Underdog-Saluki-27B-1.0-IQ2-mix.gguf");
    assert_eq!(saluki["name"], "Qwen3.8-27B GSQ-RCO");
    assert!(saluki.get("sourceRepo").is_none());
    // Not the publisher/repo/file layout: no repo is guessed.
    let loose = row("Some-Model-Q4_K_M.gguf");
    assert_eq!(loose["name"], "Some-Model-Q4_K_M");
    assert!(loose.get("sourceRepo").is_none());

    // An index written before names were vetted is corrected, not kept.
    let index = Path::new(&cfg.models_dir).join("library.json");
    // So is a folder repo stored over a real header name.
    let mut stored: Value = serde_json::from_str(&std::fs::read_to_string(&index).unwrap()).unwrap();
    for m in stored["models"].as_object_mut().unwrap().values_mut() {
        let file = m["file"].as_str().unwrap().to_string();
        if file.ends_with("PTQ1_0.gguf") {
            m["name"] = json!("Hf");
        } else if file.ends_with("IQ2-mix.gguf") {
            m["sourceRepo"] = json!("ConwayResearch/Underdog-Saluki-27B-1.0");
        }
    }
    std::fs::write(&index, stored.to_string()).unwrap();
    let again = library::list(&cfg).unwrap();
    let fixed = again.iter().find(|r| r["file"].as_str().unwrap().ends_with("PTQ1_0.gguf")).unwrap();
    assert_eq!(fixed["name"], "Ternary-Bonsai-2-27B-PTQ1_0");
    let saluki = again.iter().find(|r| r["file"].as_str().unwrap().ends_with("IQ2-mix.gguf")).unwrap();
    assert!(saluki.get("sourceRepo").is_none());
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn lists_supported_mlx_cache_geometry_without_guessing() {
    let dir = scratch("mlx-cache-geometry");
    let model = dir.join("Hermes-MLX");
    std::fs::create_dir_all(&model).unwrap();
    std::fs::write(model.join("model.safetensors"), [0; 32]).unwrap();
    let write = |v: &Value| std::fs::write(model.join("config.json"), v.to_string()).unwrap();
    let cfg =
        LibraryConfig { models_dir: dir.to_string_lossy().into_owned(), folders: vec![], mlx_runnable: true, now: 1.0 };
    let mut config = json!({
        "model_type": "llama", "torch_dtype": "bfloat16", "num_hidden_layers": 80,
        "num_attention_heads": 64, "num_key_value_heads": 8, "head_dim": 128,
        "hidden_size": 8192, "max_position_embeddings": 131072,
    });
    write(&config);
    let row = library::list(&cfg).unwrap().remove(0);
    assert_eq!(row["mlxKvBytesPerToken"], 327680);
    assert_eq!(row["maxContext"], 131072);
    assert_eq!(row["sizeBytes"].as_f64(), Some(32.0));

    // A previously indexed directory uses its current config, and an exact
    // hidden-size division is MLX Llama's fallback when head_dim is omitted.
    config.as_object_mut().unwrap().remove("head_dim");
    write(&config);
    assert_eq!(library::list(&cfg).unwrap()[0]["mlxKvBytesPerToken"], 327680);
    for (key, value) in [
        ("num_key_value_heads", Value::Null),
        ("torch_dtype", Value::Null),
        ("hidden_size", json!(8193)),
        ("sliding_window", json!(4096)),
        ("layer_types", json!(["linear_attention", "full_attention"])),
        ("model_type", json!("qwen3_5")),
    ] {
        let mut unsupported = config.clone();
        unsupported[key] = value;
        write(&unsupported);
        assert!(library::list(&cfg).unwrap()[0].get("mlxKvBytesPerToken").is_none(), "{key}");
    }
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn a_build_downloaded_from_the_repo_lists_under_the_same_repo_as_the_blocked_file() {
    // The file in LM Studio's folder, and the Q2_0 the catalog download plan would land: the library must
    // see one repo for both, which is what puts them in one family on the Models page.
    let dir = scratch("same-repo");
    let lm = dir.join("lmstudio");
    let blocked = lm.join("prism-ml/Ternary-Bonsai-2-27B-gguf/Ternary-Bonsai-2-27B-PTQ1_0.gguf");
    std::fs::create_dir_all(blocked.parent().unwrap()).unwrap();
    std::fs::write(&blocked, named_gguf("Hf")).unwrap();

    let models = dir.join("models").to_string_lossy().into_owned();
    let model = json!({
        "id": "prism-ml/Ternary-Bonsai-2-27B-gguf", "name": "Ternary Bonsai 2 27B", "tags": ["chat"],
        "quants": [{ "label": "Q2_0", "file": "Ternary-Bonsai-2-27B-Q2_0.gguf", "sizeBytes": 7.63e9,
                     "extraFiles": ["Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf"] }],
    });
    let plan = nekko_engine::acquire::model_download_plan(
        &model,
        "prism-ml/Ternary-Bonsai-2-27B-gguf",
        "Q2_0",
        &models,
        &|_| false,
    );
    let dest = PathBuf::from(plan["main"]["dest"].as_str().unwrap());
    std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
    std::fs::write(&dest, named_gguf("Hf")).unwrap();

    let folders = vec![json!({ "id": "lm", "path": lm.to_string_lossy(), "provider": "lmstudio", "enabled": true })];
    let cfg = LibraryConfig { models_dir: models, folders, mlx_runnable: false, now: 1.0 };
    let rows = library::list(&cfg).unwrap();
    let repo_of = |end: &str| {
        let row = rows.iter().find(|r| r["file"].as_str().unwrap().ends_with(end)).unwrap();
        row["sourceRepo"].clone()
    };
    assert_eq!(repo_of("PTQ1_0.gguf"), json!("prism-ml/Ternary-Bonsai-2-27B-gguf"));
    assert_eq!(repo_of("Q2_0.gguf"), json!("prism-ml/Ternary-Bonsai-2-27B-gguf"));
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn lists_imports_deletes_and_reports_as_the_host_does() {
    let g = golden();
    let lib = &g["library"];
    let dir = scratch("tree");
    let root = dir.to_string_lossy().into_owned();
    write_tree(&dir, lib["tree"].as_object().unwrap());
    let models = dir.join("models").to_string_lossy().into_owned();
    // The projector fetched for `loose`, in our own companions store.
    let fetched = companions_dir(&models, "loose");
    std::fs::create_dir_all(&fetched).unwrap();
    std::fs::write(Path::new(&fetched).join("mmproj-loose-f16.gguf"), build(&g["gguf"][0]["spec"])).unwrap();

    let folders: Vec<Value> = denorm(&root, &lib["folders"]).as_array().unwrap().clone();
    let cfg =
        LibraryConfig { models_dir: models.clone(), folders, mlx_runnable: false, now: g["now"].as_f64().unwrap() };
    let index = || {
        let p = Path::new(&models).join("library.json");
        p.exists().then(|| {
            let text = std::fs::read_to_string(&p).unwrap();
            let parsed = nekko_js::js_order(serde_json::from_str::<Value>(&text).unwrap());
            // The daemon writes what JSON.stringify(index, null, 2) writes.
            assert_eq!(nekko_js::stringify_pretty(&parsed, "  "), text);
            nekko_js::stringify_pretty(&norm(&root, &parsed), "  ")
        })
    };
    for step in lib["steps"].as_array().unwrap() {
        let op = step["op"].as_str().unwrap();
        let args = denorm(&root, &step["args"]);
        let s = |i: usize| args[i].as_str().unwrap().to_string();
        let out: Value = match op {
            "list" => json!(library::list(&cfg).unwrap()),
            "find" => library::find(&cfg, &s(0)).unwrap().unwrap_or(Value::Null),
            "savePreset" => {
                library::save_preset(&cfg, &s(0), &args[1]).unwrap();
                Value::Null
            }
            "importFile" => library::import_file(&cfg, &s(0)).unwrap(),
            "folderReport" => json!(library::folder_report(&cfg).unwrap()),
            "probe" => {
                let (count, size) = library::probe(&s(0), args[1].as_str());
                json!({ "modelCount": count, "sizeBytes": size })
            }
            "remove" => library::remove(&cfg, &s(0)).unwrap(),
            "folders" | "seed" => {
                let env = args[0].as_object().unwrap().clone();
                let home = env["HOME"].as_str().unwrap().to_string();
                let lookup = move |k: &str| env.get(k).and_then(Value::as_str).map(str::to_string);
                let os = if cfg!(windows) {
                    "win32"
                } else if cfg!(target_os = "macos") {
                    "darwin"
                } else {
                    "linux"
                };
                let candidates = known_candidates(os, &home, &lookup);
                if op == "folders" {
                    library::folders_with_suggestions(&cfg, &candidates).unwrap()
                } else {
                    json!(library::seed_folder_list(&models, &candidates))
                }
            }
            other => panic!("unknown op {other}"),
        };
        assert_eq!(nekko_js::stringify(&norm(&root, &out)), step["out"].as_str().unwrap(), "{op} {}", step["args"]);
        if let Some(want) = step.get("index").and_then(Value::as_str) {
            assert_eq!(index().as_deref(), Some(want), "library.json after {op} {}", step["args"]);
        }
        if let Some(want) = step.get("files") {
            assert_eq!(json!(files(Path::new(&models))), *want, "files after {op} {}", step["args"]);
        }
        // `rm` of the vision model happens between the deletes and the last listing.
        if op == "remove" && step["args"][0] == "loose" {
            std::fs::remove_file(dir.join("models/vision/ggml-org_gemma-3-4b-it-gguf/gemma-3-4b-it-q4_k_m.gguf"))
                .unwrap();
        }
    }
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn discovers_mlx_dflash2_heads_from_the_config_not_the_folder_name() {
    let dir = scratch("mlx-dflash2-discovery");
    let head = dir.join("local-head");
    std::fs::create_dir_all(&head).unwrap();
    std::fs::write(head.join("model.safetensors"), [0; 32]).unwrap();
    let cfg =
        LibraryConfig { models_dir: dir.to_string_lossy().into_owned(), folders: vec![], mlx_runnable: true, now: 1.0 };
    let mut config = json!({ "model_type": "qwen3", "quantization": { "group_size": 64, "bits": 4 } });
    let write = |v: &Value| std::fs::write(head.join("config.json"), v.to_string()).unwrap();
    write(&config);
    assert_eq!(library::list(&cfg).unwrap()[0]["modality"], "chat");
    config["architectures"] = json!(["DFlash2DraftModel"]);
    config.as_object_mut().unwrap().remove("quantization");
    write(&config);
    let row = library::list(&cfg).unwrap().remove(0);
    assert_eq!(row["format"], "mlx");
    assert_eq!(row["modality"], "draft");
    assert_eq!(row["hasProjector"], false);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn imports_keep_external_dflash_heads_visible_by_id_without_copying_them() {
    let dir = scratch("external-dflash-import");
    let cfg = LibraryConfig {
        models_dir: dir.join("models").to_string_lossy().into_owned(),
        folders: vec![],
        mlx_runnable: false,
        now: 0.0,
    };
    let head = build(&json!({"pairs": [
        ["general.name", {"type":"string", "value":"Qwen3.8-27B-DFlash2"}],
        ["general.architecture", {"type":"string", "value":"dflash"}]
    ]}));
    let add = |sub: &str| {
        let p = dir.join(sub).join("head.gguf");
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, &head).unwrap();
        let added = library::import_file(&cfg, &p.to_string_lossy()).unwrap();
        assert_eq!(added["ok"], true);
        (p, added["model"]["id"].as_str().unwrap().to_string())
    };
    let (first, a) = add("one");
    let (second, b) = add("two");
    assert_ne!(a, b);
    assert!(!Path::new(&cfg.models_dir).join("head.gguf").exists());
    assert_eq!(library::list(&cfg).unwrap().len(), 2);
    for (path, id) in [(&first, &a), (&second, &b)] {
        let row = library::find(&cfg, id).unwrap().unwrap();
        assert_eq!(row["path"], path.to_string_lossy().as_ref());
        assert_eq!(row["name"], "Qwen3.8-27B-DFlash2");
        assert_eq!(row["architecture"], "dflash");
        assert_eq!(row["modality"], "draft");
    }
    library::save_preset(&cfg, &b, &json!({"contextTokens":2048})).unwrap();
    assert_eq!(library::import_file(&cfg, &second.to_string_lossy()).unwrap()["model"]["id"], b);
    assert_eq!(library::find(&cfg, &b).unwrap().unwrap()["preset"]["contextTokens"], 2048);
    std::fs::remove_file(first).unwrap();
    assert!(library::find(&cfg, &a).unwrap().is_none());
    std::fs::remove_dir_all(dir).unwrap();
}
