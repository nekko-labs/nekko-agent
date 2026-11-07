//! Image model families: which set a downloaded model resolves to, what it
//! can do, and that every set is complete enough to start (spec:
//! spec/models/photo-and-video-models.md).

use nekko_engine::{acquire, launch};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::path::PathBuf;

fn model(id: &str, path: &str) -> Value {
    let name = path.rsplit('/').next().unwrap().trim_end_matches(".gguf");
    json!({ "id": id, "name": name, "path": path, "sizeBytes": 1, "addedAt": 0, "modality": "image" })
}

fn set_of(path: &str) -> Value {
    acquire::image_companion_set_for(&model("m", path)).unwrap_or(Value::Null)
}

#[test]
fn real_file_names_resolve_to_their_family() {
    // File names as the repositories in sd.cpp's docs ship them.
    let cases = [
        ("image/leejet_Z-Image-Turbo-GGUF/z_image_turbo-Q4_K.gguf", "z-image", json!({ "steps": 8, "cfgScale": 1 })),
        ("image/unsloth_Z-Image-GGUF/z-image-Q4_K_M.gguf", "z-image", json!({ "steps": 20, "cfgScale": 5 })),
        (
            "image/unsloth_Qwen-Image-Edit-2511-GGUF/qwen-image-edit-2511-Q4_K_M.gguf",
            "qwen-image-edit",
            json!({ "steps": 20, "cfgScale": 2.5 }),
        ),
        (
            "image/QuantStack_Qwen-Image-Edit-2509-GGUF/Qwen-Image-Edit-2509-Q4_K_S.gguf",
            "qwen-image-edit",
            json!({ "steps": 20, "cfgScale": 2.5 }),
        ),
        (
            "image/QuantStack_Qwen-Image-GGUF/qwen-image-Q4_K_M.gguf",
            "qwen-image",
            json!({ "steps": 20, "cfgScale": 2.5 }),
        ),
        (
            "image/leejet_FLUX.2-klein-4B-GGUF/flux-2-klein-4b-Q4_0.gguf",
            "flux2-klein-4b",
            json!({ "steps": 4, "cfgScale": 1 }),
        ),
    ];
    for (path, id, defaults) in cases {
        let set = set_of(path);
        assert_eq!(set["id"], id, "{path}");
        assert_eq!(set["defaults"], defaults, "{path}");
    }
    // Qwen Image 2.1 needs a different encoder and VAE, and is research-licensed: no set.
    assert_eq!(set_of("image/leejet_Qwen-Image-2.1-GGUF/qwen_image_2.1-Q4_K.gguf"), Value::Null);
}

#[test]
fn families_say_what_they_can_do() {
    let caps = |path: &str| set_of(path)["capabilities"].clone();
    assert_eq!(caps("flux-2-klein-4b-Q4_0.gguf"), json!(["create", "edit"]));
    assert_eq!(caps("z_image_turbo-Q4_K.gguf"), json!(["create"]));
    assert_eq!(caps("qwen-image-edit-2511-Q4_K_M.gguf"), json!(["edit"]));
    assert_eq!(caps("qwen-image-Q4_K_M.gguf"), json!(["create"]));
    for set in acquire::image_companion_sets() {
        let list: Vec<&str> = set["capabilities"].as_array().unwrap().iter().map(|c| c.as_str().unwrap()).collect();
        assert!(!list.is_empty() && list.iter().all(|c| ["create", "edit"].contains(c)), "{}", set["id"]);
    }
}

#[test]
fn every_set_can_be_fetched_whole() {
    // A saveAs name is one file on disk: two sets may share it only for the same source.
    let mut by_name: HashMap<String, (String, String)> = HashMap::new();
    for set in acquire::image_companion_sets() {
        let files = set["files"].as_array().unwrap();
        assert!(!files.is_empty(), "{}", set["id"]);
        for f in files.iter().chain(files.iter().filter_map(|f| f.get("fallback"))) {
            for key in ["role", "repo", "file", "saveAs"] {
                assert!(f[key].as_str().is_some_and(|s| !s.is_empty()), "{} {key}", set["id"]);
            }
            assert!(f["bytes"].as_u64().is_some_and(|b| b > 0), "{} {}", set["id"], f["file"]);
            // Without a token a gated file must have something ungated to stand in.
            if f["gated"] == json!(true) {
                assert!(f.get("fallback").is_some(), "{} gated {} has no fallback", set["id"], f["file"]);
            }
            let source = (f["repo"].as_str().unwrap().to_string(), f["file"].as_str().unwrap().to_string());
            let prior = by_name.entry(f["saveAs"].as_str().unwrap().to_string()).or_insert_with(|| source.clone());
            assert_eq!(*prior, source, "saveAs {} reused for another file", f["saveAs"]);
        }
    }
}

struct Tmp(PathBuf);
impl Drop for Tmp {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).ok();
    }
}
fn tmp(tag: &str) -> Tmp {
    let p = std::env::temp_dir().join(format!("nekko-image-families-{tag}-{}", std::process::id()));
    std::fs::remove_dir_all(&p).ok();
    std::fs::create_dir_all(&p).unwrap();
    Tmp(p)
}
fn touch(p: &PathBuf) {
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, "x").unwrap();
}

#[test]
fn the_vision_encoder_is_not_taken_for_the_text_encoder() {
    let root = tmp("beside");
    let dir = root.0.join("image/qie");
    let weights = dir.join("qwen-image-edit-2511-Q4_K_M.gguf");
    for name in ["llm_vision-qwen2.5-vl-mmproj.gguf", "llm-qwen2.5-vl-7b.gguf"] {
        touch(&dir.join(name));
    }
    touch(&weights);
    let m = model("qie", weights.to_str().unwrap());
    let beside = acquire::companions_beside(&m, &[]);
    let name = |role: &str| beside[role].as_str().unwrap().rsplit(['/', '\\']).next().unwrap().to_string();
    assert_eq!(name("llm"), "llm-qwen2.5-vl-7b.gguf");
    assert_eq!(name("llm_vision"), "llm_vision-qwen2.5-vl-mmproj.gguf");
}

#[test]
fn qwen_image_edit_2511_starts_with_its_vision_encoder_and_switches() {
    let root = tmp("args");
    let models = root.0.join("models");
    let shared = acquire::image_companions_dir(models.to_str().unwrap());
    let weights = models.join("image/unsloth_Qwen-Image-Edit-2511-GGUF/qwen-image-edit-2511-Q4_K_M.gguf");
    touch(&weights);
    let m = model("qie", weights.to_str().unwrap());
    let set = acquire::image_companion_set_for(&m).unwrap();
    let save_as = |role: &str| {
        let f = set["files"].as_array().unwrap().iter().find(|f| f["role"] == role).unwrap();
        PathBuf::from(&shared).join(f["saveAs"].as_str().unwrap())
    };

    // Missing the vision half: refuses to start and says which file.
    touch(&save_as("vae"));
    touch(&save_as("llm"));
    let err = launch::diffusion_args(&m, "1234", None, Some(&shared)).unwrap_err();
    assert!(err.contains("llm_vision"), "{err}");
    let status = acquire::image_companion_status(&m, &shared, &Map::new(), false);
    assert_eq!(status["ready"], json!(false));
    assert_eq!(status["capabilities"], json!(["edit"]));

    touch(&save_as("llm_vision"));
    let args = launch::diffusion_args(&m, "1234", None, Some(&shared)).unwrap();
    let after = |flag: &str| args.iter().position(|a| a == flag).map(|i| args[i + 1].clone());
    assert_eq!(after("--llm_vision"), Some(save_as("llm_vision").to_string_lossy().into_owned()));
    assert_eq!(after("--flow-shift").as_deref(), Some("3"));
    assert_eq!(after("--sampling-method").as_deref(), Some("euler"));
    assert_eq!(after("--model-args").as_deref(), Some("qwen_image_zero_cond_t=true"));

    // The plan fetches nothing more once every file is there.
    let status = acquire::image_companion_status(&m, &shared, &Map::new(), false);
    assert_eq!(status["ready"], json!(true));
    let plan = acquire::image_companions_plan(&m, &status, None, models.to_str().unwrap());
    assert_eq!(plan["requests"], json!([]));
}

#[test]
fn qwen_image_edit_2509_skips_the_2511_switch() {
    let set = set_of("image/QuantStack_Qwen-Image-Edit-2509-GGUF/Qwen-Image-Edit-2509-Q4_K_S.gguf");
    assert!(!set["launchArgs"].as_array().unwrap().iter().any(|a| a == "--model-args"));
}
