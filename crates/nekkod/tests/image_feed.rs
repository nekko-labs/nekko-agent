//! The picture recommendations (nekko-machine's feed) and the engine's
//! companion sets (nekko-engine's `acquire.rs`) describe the same files: a
//! recommended model, once downloaded, resolves to the set the feed names,
//! with the same text encoders and VAE at the same sizes, and can do what the
//! feed says. Otherwise a pick would download and then not start.

use nekko_engine::acquire;
use nekko_machine::bundled_feed;
use serde_json::{Value, json};

/// A model as the library lists a catalog download: `image/<owner>_<repo>/<file>`.
fn downloaded(repo: &str, file: &str) -> Value {
    let stem = file.rsplit('/').next().unwrap().trim_end_matches(".gguf");
    json!({
        "id": format!("image/{}/{stem}", repo.replace('/', "_")),
        "name": stem,
        "path": format!("/models/image/{}/{file}", repo.replace('/', "_")),
        "sizeBytes": 1,
        "addedAt": 0,
        "modality": "image",
    })
}

#[test]
fn every_recommended_picture_model_downloads_into_a_complete_companion_set() {
    let feed = bundled_feed();
    assert!(!feed.image_models.is_empty());
    for m in &feed.image_models {
        for q in &m.quants {
            let file = &q.files[0];
            let set = acquire::image_companion_set_for(&downloaded(&m.repo, file))
                .unwrap_or_else(|| panic!("{}/{file} resolves to no companion set", m.repo));
            assert_eq!(set["id"], json!(m.companion_set), "{}/{file}", m.repo);
            assert_eq!(set["capabilities"], json!(m.capabilities), "{}", m.id);

            let engine: Vec<(String, String, f64)> = set["files"]
                .as_array()
                .unwrap()
                .iter()
                .map(|f| {
                    (
                        f["repo"].as_str().unwrap().into(),
                        f["file"].as_str().unwrap().into(),
                        f["bytes"].as_f64().unwrap(),
                    )
                })
                .collect();
            let feed_files: Vec<(String, String, f64)> =
                m.companions.iter().map(|c| (c.repo.clone(), c.file.clone(), c.size_bytes)).collect();
            assert_eq!(feed_files, engine, "{}: the feed's companions differ from the engine's set", m.id);
            // Nothing the pick needs is behind a license gate.
            assert!(set["files"].as_array().unwrap().iter().all(|f| f["gated"] != json!(true)), "{}", m.id);
        }
    }
}
