//! Replays the TS library's golden set (`library.golden.test.ts`): the same
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
