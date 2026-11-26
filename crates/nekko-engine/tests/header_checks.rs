//! What a GGUF header says about whether this engine can run the file: a tensor
//! type llama.cpp does not know, and a header key that needs a newer llama.cpp.
//! Read from built headers, carried onto library rows (also rows indexed before
//! the checks existed), and turned into the engine's verdict.

use nekko_engine::capacity::Hardware;
use nekko_engine::gguf;
use nekko_engine::library::{self, LibraryConfig};
use nekko_engine::load_check::{EngineInUse, Source};
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};

fn ggstr(s: &str) -> Vec<u8> {
    let mut out = (s.len() as u64).to_le_bytes().to_vec();
    out.extend_from_slice(s.as_bytes());
    out
}

enum Kv {
    Str(&'static str, &'static str),
    U32(&'static str, u32),
}

/// A v3 header with these pairs and tensors (each one dimension of 256 elements).
fn gguf_bytes(pairs: &[Kv], tensors: &[(&str, u32)]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend(0x4655_4747u32.to_le_bytes());
    out.extend(3u32.to_le_bytes());
    out.extend((tensors.len() as u64).to_le_bytes());
    out.extend((pairs.len() as u64).to_le_bytes());
    for pair in pairs {
        match pair {
            Kv::Str(k, v) => {
                out.extend(ggstr(k));
                out.extend(8u32.to_le_bytes());
                out.extend(ggstr(v));
            }
            Kv::U32(k, v) => {
                out.extend(ggstr(k));
                out.extend(4u32.to_le_bytes());
                out.extend(v.to_le_bytes());
            }
        }
    }
    for (name, kind) in tensors {
        out.extend(ggstr(name));
        out.extend(1u32.to_le_bytes());
        out.extend(256u64.to_le_bytes());
        out.extend(kind.to_le_bytes());
        out.extend(0u64.to_le_bytes());
    }
    out.extend([0u8; 64]);
    out
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nekko-header-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn write(path: &Path, bytes: Vec<u8>) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, bytes).unwrap();
}

const HADAMARD: Kv = Kv::U32("prism.hadamard.version", 1);

#[test]
fn a_tensor_type_past_llama_cpps_is_recorded_and_the_newer_known_ones_are_sized() {
    let dir = scratch("types");
    let read = |name: &str, tensors: &[(&str, u32)]| {
        let p = dir.join(name);
        write(&p, gguf_bytes(&[Kv::Str("general.architecture", "qwen35")], tensors));
        gguf::read_metadata(&p.to_string_lossy()).unwrap()
    };
    // Types 40-43 (NVFP4, Q1_0, Q2_0, F8_E4M3) are llama.cpp's own at b12436: sized, none unknown.
    let known = read("known.gguf", &[("a.weight", 40), ("b.weight", 41), ("c.weight", 42), ("d.weight", 43)]);
    assert_eq!(known.unknown_weight_type, None);
    let layout = known.weight_layout.expect("every type here has a size");
    assert_eq!(layout.expert_share, 0.0);
    // Type 44 is GGML_TYPE_COUNT: llama.cpp refuses it ("invalid ggml type"). The first such type is kept,
    // and no weight shares are claimed for a table we cannot size.
    let foreign = read("foreign.gguf", &[("a.weight", 0), ("b.weight", 143), ("c.weight", 44)]);
    assert_eq!(foreign.unknown_weight_type, Some(143));
    assert!(foreign.weight_layout.is_none());
    assert_eq!(read("edge.gguf", &[("a.weight", 44)]).unknown_weight_type, Some(44));
    // The highest wins, whatever the order: a fork's type is not hidden by a near one before it.
    assert_eq!(read("mixed.gguf", &[("a.weight", 44), ("b.weight", 143)]).unknown_weight_type, Some(143));
    assert_eq!(read("last.gguf", &[("a.weight", 43)]).unknown_weight_type, None);
    // Neither is in the value the daemon sends when absent.
    assert!(known.to_value().get("unknownWeightType").is_none());
    assert_eq!(foreign.to_value()["unknownWeightType"], 143);
    // A table that cannot be read to its end still says what it showed before it ended.
    let mut cut = gguf_bytes(&[Kv::Str("general.architecture", "qwen35")], &[("a.weight", 143), ("b.weight", 0)]);
    cut.truncate(cut.len() - 6);
    let p = dir.join("cut.gguf");
    write(&p, cut);
    let meta = gguf::read_metadata(&p.to_string_lossy()).unwrap();
    assert_eq!(meta.unknown_weight_type, Some(143));
    assert!(meta.weight_layout.is_none());
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn the_hadamard_key_asks_for_llama_cpp_b11556() {
    let dir = scratch("hadamard");
    let p = dir.join("h.gguf");
    write(&p, gguf_bytes(&[Kv::Str("general.architecture", "qwen35"), HADAMARD], &[("a.weight", 0)]));
    let meta = gguf::read_metadata(&p.to_string_lossy()).unwrap();
    assert_eq!(meta.min_engine_build, Some(11556));
    assert_eq!(meta.to_value()["minEngineBuild"], 11556);
    // The layout is known too (no re-read was ever needed for it), and nothing is foreign.
    assert!(meta.weight_layout.is_some() && meta.unknown_weight_type.is_none());
    write(&p, gguf_bytes(&[Kv::Str("general.architecture", "qwen35")], &[("a.weight", 0)]));
    assert_eq!(gguf::read_metadata(&p.to_string_lossy()).unwrap().min_engine_build, None);
    std::fs::remove_dir_all(dir).ok();
}

/// An LM Studio folder holding PrismML's 1-bit build (tensor type 143, hadamard keys), a build with
/// known tensor types and hadamard keys, and an ordinary quant.
fn prism_folder(name: &str) -> (PathBuf, LibraryConfig) {
    let dir = scratch(name);
    let lm = dir.join("lmstudio");
    write(
        &lm.join("prism-ml/Ternary-Bonsai-2-27B-gguf/Ternary-Bonsai-2-27B-PTQ1_0.gguf"),
        gguf_bytes(
            &[Kv::Str("general.architecture", "qwen35"), Kv::U32("general.file_type", 143), HADAMARD],
            &[("token_embd.weight", 0), ("output.weight", 143)],
        ),
    );
    write(
        &lm.join("prism-ml/Ternary-Bonsai-2-27B-gguf/Ternary-Bonsai-2-27B-Q2_0.gguf"),
        gguf_bytes(
            &[Kv::Str("general.architecture", "qwen35"), Kv::U32("general.file_type", 41), HADAMARD],
            &[("token_embd.weight", 0), ("output.weight", 42)],
        ),
    );
    write(
        &lm.join("lmstudio-community/qwen3-8b-gguf/qwen3-8b-q4_k_m.gguf"),
        gguf_bytes(
            &[Kv::Str("general.architecture", "qwen3"), Kv::U32("general.file_type", 15)],
            &[("token_embd.weight", 12), ("output.weight", 0)],
        ),
    );
    let models = dir.join("models").to_string_lossy().into_owned();
    let folders = vec![json!({ "id": "lm", "path": lm.to_string_lossy(), "provider": "lmstudio", "enabled": true })];
    (dir, LibraryConfig { models_dir: models, folders, mlx_runnable: false, now: 1.0 })
}

fn row_ending(rows: &[Value], end: &str) -> Value {
    rows.iter().find(|r| r["file"].as_str().unwrap().ends_with(end)).unwrap().clone()
}

#[test]
fn listing_puts_the_header_facts_on_rows() {
    let (dir, cfg) = prism_folder("rows");
    let rows = library::list(&cfg).unwrap();

    // Tensor type 143 is past llama.cpp's own. No "type 143" quant: the file name's is used.
    let bonsai = row_ending(&rows, "PTQ1_0.gguf");
    assert_eq!((&bonsai["unknownWeightType"], &bonsai["minEngineBuild"]), (&json!(143), &json!(11556)));
    assert_eq!(bonsai["quantization"], "PTQ1_0");
    // The index's bookkeeping does not reach the row.
    assert!(bonsai.get("headerChecks").is_none());

    // Q2_0 is stock llama.cpp's type, so its weight layout is known, yet the hadamard key still asks for b11556.
    let q2 = row_ending(&rows, "Q2_0.gguf");
    assert!(q2.get("unknownWeightType").is_none() && q2.get("weightLayout").is_some(), "{q2}");
    assert_eq!((&q2["quantization"], &q2["minEngineBuild"]), (&json!("Q2_0"), &json!(11556)));

    let qwen = row_ending(&rows, "qwen3-8b-q4_k_m.gguf");
    assert!(qwen.get("unknownWeightType").is_none() && qwen.get("minEngineBuild").is_none());
    assert_eq!(qwen["quantization"], "Q4_K_M");
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn rows_indexed_before_the_header_checks_get_them_once() {
    let (dir, cfg) = prism_folder("refresh");
    library::list(&cfg).unwrap();

    // The index as an earlier version wrote it: "type 143" for the quant and none of the new fields.
    let index = Path::new(&cfg.models_dir).join("library.json");
    let mut stored: Value = serde_json::from_str(&std::fs::read_to_string(&index).unwrap()).unwrap();
    for m in stored["models"].as_object_mut().unwrap().values_mut() {
        let m = m.as_object_mut().unwrap();
        for k in ["headerChecks", "unknownWeightType", "minEngineBuild"] {
            m.remove(k);
        }
        if m["file"].as_str().unwrap().ends_with("PTQ1_0.gguf") {
            m.insert("quantization".into(), json!("type 143"));
        }
    }
    std::fs::write(&index, stored.to_string()).unwrap();

    let rows = library::list(&cfg).unwrap();
    let bonsai = row_ending(&rows, "PTQ1_0.gguf");
    assert_eq!((&bonsai["unknownWeightType"], &bonsai["minEngineBuild"]), (&json!(143), &json!(11556)));
    assert_eq!(bonsai["quantization"], "PTQ1_0");
    // The hadamard file's weight layout was already known, so nothing else would have re-read it: it is found too.
    let q2 = row_ending(&rows, "Q2_0.gguf");
    assert_eq!(q2["minEngineBuild"], 11556);
    assert!(q2.get("unknownWeightType").is_none());
    let on_disk: Value = serde_json::from_str(&std::fs::read_to_string(&index).unwrap()).unwrap();
    assert!(on_disk["models"].as_object().unwrap().values().all(|m| m["headerChecks"] == 1), "{on_disk}");

    // Marked, so the next listing does not open the files again: a file that changed behind the index's back is
    // not noticed, and the index is not rewritten.
    write(
        Path::new(q2["file"].as_str().unwrap()),
        gguf_bytes(&[Kv::Str("general.architecture", "qwen35")], &[("token_embd.weight", 0)]),
    );
    let before = std::fs::read_to_string(&index).unwrap();
    let again = library::list(&cfg).unwrap();
    assert_eq!(row_ending(&again, "Q2_0.gguf")["minEngineBuild"], 11556);
    assert_eq!(std::fs::read_to_string(&index).unwrap(), before);
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn reads_the_quant_from_a_file_name() {
    for (stem, quant) in [
        ("Ternary-Bonsai-2-27B-PTQ1_0", Some("PTQ1_0")),
        ("qwen3-4b-q4_k_m", Some("Q4_K_M")),
        ("Qwen3.8-2B-BF16", Some("BF16")),
        ("model.IQ2_XS", Some("IQ2_XS")),
        ("Underdog-Saluki-27B-1.0-IQ2-mix", None),
        ("plain", None),
    ] {
        assert_eq!(gguf::quant_from_file_name(stem).as_deref(), quant, "{stem}");
    }
}

#[test]
fn a_listing_carries_the_engines_verdict_and_drops_the_fit_it_makes_moot() {
    let (dir, cfg) = prism_folder("verdict");
    let rows = library::list(&cfg).unwrap();
    let hw = Hardware::from_value(&json!({
        "devices": [{ "name": "GPU", "totalBytes": 24e9, "freeBytes": 20e9 }],
        "unified": false, "systemRamTotalBytes": 64e9, "systemRamFreeBytes": 32e9,
    }));
    let list = |engine: &EngineInUse| {
        library::with_load_state(rows.clone(), &Default::default(), &Map::new(), Some(&hw), None, engine)
    };

    // The managed engine here is b11224.
    let managed = EngineInUse { source: Source::Managed, version: Some("b11224".into()) };
    let shown = list(&managed);
    let bonsai = row_ending(&shown, "PTQ1_0.gguf");
    assert_eq!(bonsai["loadCheck"]["level"], "blocked");
    assert!(bonsai["loadCheck"]["reason"].as_str().unwrap().contains("tensor type 143"));
    assert!(bonsai.get("gpuFit").is_none() && bonsai.get("gpuFitIdle").is_none());
    // The verdict names only the weight format, so the row says on its own that the engine is also too old.
    assert_eq!(bonsai["engineMeetsMinBuild"], false);
    let q2 = row_ending(&shown, "Q2_0.gguf");
    assert_eq!(q2["loadCheck"]["level"], "blocked");
    let why = q2["loadCheck"]["reason"].as_str().unwrap();
    assert!(why.contains("b11556") && why.contains("b11224") && why.contains("too old"), "{why}");
    assert!(q2.get("gpuFit").is_none());
    let qwen = row_ending(&shown, "qwen3-8b-q4_k_m.gguf");
    assert!(qwen.get("loadCheck").is_none() && qwen.get("gpuFit").is_some());
    assert!(qwen.get("engineMeetsMinBuild").is_none());

    // The pinned engine meets it, and the row says so.
    let current = list(&EngineInUse { source: Source::Managed, version: Some("b12436".into()) });
    assert_eq!(row_ending(&current, "PTQ1_0.gguf")["engineMeetsMinBuild"], true);

    // The same files under the user's own engine of unknown version: a warning each, and the fit stays.
    let shown = list(&EngineInUse { source: Source::External, version: None });
    for end in ["PTQ1_0.gguf", "Q2_0.gguf"] {
        let row = row_ending(&shown, end);
        assert_eq!(row["loadCheck"]["level"], "warning", "{end}");
        assert!(row.get("gpuFit").is_some(), "{end}");
    }
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn an_image_or_mlx_row_gets_no_llama_cpp_verdict() {
    // The model server's load gate skips these, so the listing must not say "Can't run here" for them.
    let engine = EngineInUse { source: Source::Managed, version: Some("b11224".into()) };
    let rows = vec![
        json!({ "id": "img", "name": "img", "path": "/img.gguf", "modality": "image", "unknownWeightType": 143, "minEngineBuild": 11556 }),
        json!({ "id": "mlx", "name": "mlx", "path": "/mlx", "format": "mlx", "unknownWeightType": 143, "minEngineBuild": 11556 }),
    ];
    for row in library::with_load_state(rows, &Default::default(), &Map::new(), None, None, &engine) {
        assert!(row.get("loadCheck").is_none() && row.get("engineMeetsMinBuild").is_none(), "{row}");
    }
}
