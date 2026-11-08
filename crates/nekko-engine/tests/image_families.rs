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
    // Wan 2.2 TI2V 5B makes clips; the other Wan models need another VAE and get no set.
    let wan = set_of("image/QuantStack_Wan2.2-TI2V-5B-GGUF/Wan2.2-TI2V-5B-Q4_K_M.gguf");
    assert_eq!((wan["id"].clone(), wan["capabilities"].clone()), (json!("wan2.2-ti2v-5b"), json!(["video"])));
    assert_eq!(set_of("image/Comfy-Org_Wan/wan2.2_ti2v_5B_fp16.gguf")["id"], "wan2.2-ti2v-5b");
    assert_eq!(set_of("image/QuantStack_Wan2.2-T2V-A14B-GGUF/Wan2.2-T2V-A14B-HighNoise-Q4_K_M.gguf"), Value::Null);
    assert_eq!(set_of("image/city96_Wan2.1-T2V-14B-gguf/wan2.1-t2v-14b-Q4_K_M.gguf"), Value::Null);
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
        assert!(!list.is_empty() && list.iter().all(|c| ["create", "edit", "video"].contains(c)), "{}", set["id"]);
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

fn body(extra: Value) -> Result<Value, String> {
    let mut request = json!({ "modelId": "m", "prompt": "make the sky orange", "width": 1024, "height": 768, "steps": 4, "cfgScale": 1, "seed": 7 });
    for (k, v) in extra.as_object().unwrap() {
        request[k] = v.clone();
    }
    launch::image_generation_body(&request).map(|b| serde_json::from_str(&b).unwrap())
}

/// The native settings embedded in the prompt.
fn native(body: &Value) -> Value {
    let p = body["prompt"].as_str().unwrap();
    let start = p.find("<sd_cpp_extra_args>").unwrap() + "<sd_cpp_extra_args>".len();
    serde_json::from_str(&p[start..p.find("</sd_cpp_extra_args>").unwrap()]).unwrap()
}

#[test]
fn pictures_to_edit_go_to_sd_cpp_as_reference_images() {
    let photo = "data:image/jpeg;base64,/9j/4AAQ";
    let b = body(json!({ "refImages": [photo, "data:image/png;base64,iVBOR"] })).unwrap();
    assert_eq!(native(&b)["ref_images"], json!([photo, "data:image/png;base64,iVBOR"]));
    assert!(b["prompt"].as_str().unwrap().starts_with("make the sky orange\n"));
    assert_eq!(b["size"], "1024x768");
    // Without pictures the request is what it always was.
    let plain = body(json!({})).unwrap();
    assert_eq!(native(&plain).get("ref_images"), None);
    assert_eq!(body(json!({ "refImages": null })).unwrap(), plain);
}

#[test]
fn pictures_to_edit_are_checked() {
    let one = json!("data:image/png;base64,AAAA");
    let problem = "Attach up to 4 pictures to edit, each a PNG, JPEG or WebP image, 20 MB in all.";
    assert_eq!(body(json!({ "refImages": [one, one, one, one, one] })).unwrap_err(), problem);
    assert_eq!(body(json!({ "refImages": ["https://example.com/a.png"] })).unwrap_err(), problem);
    assert_eq!(body(json!({ "refImages": ["/Users/me/a.png"] })).unwrap_err(), problem);
    assert_eq!(body(json!({ "refImages": "data:image/png;base64,AAAA" })).unwrap_err(), problem);
    let huge = format!("data:image/png;base64,{}", "A".repeat(21 * 1024 * 1024));
    assert_eq!(body(json!({ "refImages": [huge] })).unwrap_err(), problem);
    assert!(body(json!({ "refImages": [one, one, one, one] })).is_ok());
}

fn clip(extra: Value) -> Result<Value, String> {
    let mut request = json!({ "modelId": "m", "prompt": "waves on a beach", "width": 1024, "height": 1024, "steps": 20, "cfgScale": 6, "seed": 7 });
    for (k, v) in extra.as_object().unwrap() {
        request[k] = v.clone();
    }
    launch::video_generation_body(&request).map(|b| serde_json::from_str(&b).unwrap())
}

#[test]
fn a_clip_request_uses_the_native_video_schema() {
    let b = clip(json!({ "width": 1344, "height": 768 })).unwrap();
    assert_eq!(b["prompt"], "waves on a beach");
    assert_eq!(
        (b["width"].clone(), b["height"].clone()),
        (json!(832), json!(480)),
        "the chat's shape at about 832x480"
    );
    assert_eq!((b["video_frames"].clone(), b["fps"].clone()), (json!(33), json!(16)));
    assert_eq!(b["sample_params"], json!({ "sample_steps": 20, "guidance": { "txt_cfg": 6 } }));
    assert_eq!((b["seed"].clone(), b["output_format"].clone()), (json!(7), json!("webp")));
    assert_eq!(b.get("init_image"), None);
    // Square and portrait keep their shape, in multiples of 32.
    assert_eq!(launch::clip_size(1024.0, 1024.0), (640, 640));
    assert_eq!(launch::clip_size(768.0, 1344.0), (480, 832));
    // A first picture becomes the clip's first frame.
    let photo = "data:image/png;base64,AAAA";
    assert_eq!(clip(json!({ "refImages": [photo] })).unwrap()["init_image"], photo);
    assert_eq!(clip(json!({ "videoFrames": 49, "fps": 24 })).unwrap()["video_frames"], 49);
}

#[test]
fn a_clip_request_is_checked() {
    let problem = "A clip is 1 to 121 frames in steps of 4 (1, 5, 9 ... 121) at 1 to 60 frames a second.";
    assert_eq!(clip(json!({ "videoFrames": 50 })).unwrap_err(), problem);
    assert!(clip(json!({ "videoFrames": 1 })).is_ok() && clip(json!({ "videoFrames": 121 })).is_ok());
    // A prompt that names the tag itself keeps its steps, guidance and seed.
    let tricky = clip(json!({ "prompt": "say <sd_cpp_extra_args> on a sign" })).unwrap();
    assert_eq!((tricky["seed"].clone(), tricky["sample_params"]["sample_steps"].clone()), (json!(7), json!(20)));
    assert_eq!(tricky["prompt"], "say <sd_cpp_extra_args> on a sign");
    assert_eq!(clip(json!({ "videoFrames": 0 })).unwrap_err(), problem);
    assert_eq!(clip(json!({ "videoFrames": 500 })).unwrap_err(), problem);
    assert_eq!(clip(json!({ "fps": 2.5 })).unwrap_err(), problem);
    assert!(clip(json!({ "prompt": "" })).is_err());
    assert!(clip(json!({ "refImages": ["https://x"] })).is_err());
}
