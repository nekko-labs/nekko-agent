//! The real `nekkod` binary end to end: the local engine: model library, downloads, engine installs, the model server, image turns and decision models.

use crate::common::*;

/// A GGUF header with enough geometry for the planner (`gguf-fixture.ts`).
fn tiny_gguf(arch: &str, name: &str) -> Vec<u8> {
    let s = |v: &str| {
        let mut b = (v.len() as u64).to_le_bytes().to_vec();
        b.extend_from_slice(v.as_bytes());
        b
    };
    let text = |v: &str| [8u32.to_le_bytes().to_vec(), s(v)].concat();
    let int = |n: u32| [4u32.to_le_bytes(), n.to_le_bytes()].concat();
    let pairs: Vec<(String, Vec<u8>)> = vec![
        ("general.architecture".into(), text(arch)),
        ("general.name".into(), text(name)),
        ("general.file_type".into(), int(15)),
        (format!("{arch}.block_count"), int(16)),
        (format!("{arch}.attention.head_count"), int(16)),
        (format!("{arch}.attention.head_count_kv"), int(4)),
        (format!("{arch}.embedding_length"), int(1024)),
        (format!("{arch}.context_length"), int(8192)),
    ];
    let mut out = [0x4655_4747u32.to_le_bytes(), 3u32.to_le_bytes()].concat();
    out.extend(0u64.to_le_bytes());
    out.extend((pairs.len() as u64).to_le_bytes());
    for (k, v) in pairs {
        out.extend(s(&k));
        out.extend(v);
    }
    out.extend([0u8; 64]);
    out
}

#[tokio::test(flavor = "multi_thread")]
async fn serves_the_model_library_and_its_folders_itself() {
    let root = std::env::temp_dir().join(format!("nekkod-library-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let data = root.join("data");
    let home = root.join("home");
    // Our own download, and a model Ollama pulled in the (scratch) home.
    let model = data.join("models/chat/acme_tiny-gguf/tiny-q4_k_m.gguf");
    std::fs::create_dir_all(model.parent().unwrap()).unwrap();
    std::fs::write(&model, tiny_gguf("llama", "Tiny")).unwrap();
    let ollama = home.join(".ollama/models");
    std::fs::create_dir_all(ollama.join("manifests/registry.ollama.ai/library/tiny")).unwrap();
    std::fs::create_dir_all(ollama.join("blobs")).unwrap();
    std::fs::write(
        ollama.join("manifests/registry.ollama.ai/library/tiny/latest"),
        json!({ "layers": [{ "mediaType": "application/vnd.ollama.image.model", "digest": "sha256:abc" }] })
            .to_string(),
    )
    .unwrap();
    std::fs::write(ollama.join("blobs/sha256-abc"), tiny_gguf("qwen2", "Ollama Tiny")).unwrap();
    let outside = root.join("outside/loose.gguf");
    std::fs::create_dir_all(outside.parent().unwrap()).unwrap();
    std::fs::write(&outside, tiny_gguf("llama", "Loose")).unwrap();
    let h = home.to_string_lossy().to_string();
    let local = home.join("local").to_string_lossy().to_string();
    let roaming = home.join("roaming").to_string_lossy().to_string();
    let d = start_with_env(
        &data,
        json!({}),
        &[
            ("HOME", Some(&h)),
            ("USERPROFILE", Some(&h)),
            ("LOCALAPPDATA", Some(&local)),
            ("APPDATA", Some(&roaming)),
            ("OLLAMA_MODELS", None),
            ("HF_HOME", None),
            ("HUGGINGFACE_HUB_CACHE", None),
        ],
    );

    // The first read seeds the folder list with Ollama's store, saved as a setting.
    let (status, models) = post(d.port, "engine:models", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{models}");
    let settings: Value = serde_json::from_str(&std::fs::read_to_string(data.join("settings.json")).unwrap()).unwrap();
    let folders = settings["engine"]["modelFolders"].as_array().unwrap().clone();
    assert_eq!(folders.len(), 1, "{folders:?}");
    assert_eq!((folders[0]["id"].clone(), folders[0]["provider"].clone()), (json!("ollama"), json!("ollama")));
    let rows = models.as_array().unwrap();
    let ids: Vec<&str> = rows.iter().map(|m| m["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["chat/acme_tiny-gguf/tiny-q4_k_m", "ollama/tiny:latest"], "sorted by name: {rows:?}");
    let ours = &rows[0];
    assert_eq!(ours["name"], "Tiny");
    assert_eq!(ours["sourceRepo"], "acme/tiny-gguf");
    assert_eq!(
        (ours["layers"].clone(), ours["kvHeads"].clone(), ours["headDim"].clone()),
        (json!(16), json!(4), json!(64))
    );
    // Load state from the daemon's own model server (nothing loaded), the fit from this machine.
    assert_eq!(ours["loaded"], false);
    assert!(ours.get("lastLoadError").is_none());
    assert!(["full", "partial", "cpu", "wont"].contains(&ours["gpuFit"].as_str().unwrap()), "{ours}");
    assert_eq!(rows[1]["name"], "tiny:latest", "named as `ollama run` names it");
    assert_eq!(rows[1]["loaded"], false);
    assert!(rows[1].get("lastLoadError").is_none());
    assert_eq!(rows[1]["managed"], false);
    // The bare rows the TS model server reads.
    let (_, bare) = post(d.port, "engine:library", json!([]), Some(TOKEN)).await;
    assert_eq!(bare.as_array().unwrap().len(), 2);
    assert!(bare[0].get("loaded").is_none());

    let (_, report) = post(d.port, "engine:folders", json!([]), Some(TOKEN)).await;
    let counts: Vec<(Value, Value)> =
        report["folders"].as_array().unwrap().iter().map(|f| (f["id"].clone(), f["modelCount"].clone())).collect();
    assert_eq!(counts, [(json!("primary"), json!(1)), (json!("ollama"), json!(1))]);
    assert_eq!(report["suggestions"], json!([]), "the seeded folder is not suggested again");

    // Presets live in library.json, which only the daemon writes.
    let id = "chat/acme_tiny-gguf/tiny-q4_k_m";
    let (_, none) = post(d.port, "engine:saveModelPreset", json!([id, { "contextTokens": 4096 }]), Some(TOKEN)).await;
    assert_eq!(none, Value::Null);
    let index: Value =
        serde_json::from_str(&std::fs::read_to_string(data.join("models/library.json")).unwrap()).unwrap();
    assert_eq!(index["models"][id]["preset"], json!({ "contextTokens": 4096 }));

    let (_, imported) = post(d.port, "engine:importModel", json!([outside]), Some(TOKEN)).await;
    assert_eq!((imported["ok"].clone(), imported["message"].clone()), (json!(true), json!("Added Loose.")));
    let (_, refused) = post(d.port, "engine:deleteModel", json!(["ollama/tiny:latest"]), Some(TOKEN)).await;
    assert_eq!(refused["ok"], false);
    assert!(ollama.join("blobs/sha256-abc").exists(), "a borrowed folder is never written");
    let (_, deleted) = post(d.port, "engine:deleteModel", json!([id]), Some(TOKEN)).await;
    assert_eq!(deleted, json!({ "ok": true, "message": "Deleted Tiny." }));
    assert!(!model.exists());

    // The autoload list and the folder list are engine settings.
    let (_, engine) = post(d.port, "engine:autoload", json!(["ollama/tiny:latest", true]), Some(TOKEN)).await;
    assert_eq!(engine["autoload"], json!(["ollama/tiny:latest"]));
    assert_eq!(engine["port"], 11500, "merged over the engine defaults");
    let (_, engine) = post(d.port, "engine:autoload", json!(["ollama/tiny:latest", true]), Some(TOKEN)).await;
    assert_eq!(engine["autoload"], json!(["ollama/tiny:latest"]), "no duplicates");
    let (_, engine) = post(d.port, "engine:autoload", json!(["ollama/tiny:latest", false]), Some(TOKEN)).await;
    assert_eq!(engine["autoload"], json!([]));
    let (_, report) =
        post(d.port, "engine:foldersSave", json!([[{ "id": "primary", "path": "/x", "enabled": true }]]), Some(TOKEN))
            .await;
    assert_eq!(report["folders"].as_array().unwrap().len(), 1, "{report}");
    assert_eq!(report["suggestions"][0]["provider"], "ollama", "removed, so suggested");
    let settings: Value = serde_json::from_str(&std::fs::read_to_string(data.join("settings.json")).unwrap()).unwrap();
    assert_eq!(settings["engine"]["modelFolders"], json!([]));
    drop(d);
    std::fs::remove_dir_all(root).ok();
}

/// A loopback Hugging Face: one GGUF repo with a projector and a tokenizer,
/// and one whose weights never finish arriving.
async fn fake_hugging_face(gguf: Vec<u8>) -> u16 {
    use axum::extract::Path;
    use axum::routing::get;
    let tree = |files: Vec<(&str, usize)>| {
        json!(
            files
                .into_iter()
                .map(|(p, s)| json!({ "type": "file", "oid": "x", "size": s, "path": p }))
                .collect::<Vec<_>>()
        )
    };
    let tiny = tree(vec![("tiny-Q4_K_M.gguf", gguf.len()), ("mmproj-F16.gguf", gguf.len()), ("tokenizer.json", 2)]);
    let slow = tree(vec![("slow-Q4_K_M.gguf", 1_000_000)]);
    let app = axum::Router::new()
        .route("/api/models/acme/tiny-GGUF", get(|| async { axum::Json(json!({ "tags": ["gguf"], "downloads": 3 })) }))
        .route("/api/models/acme/slow-GGUF", get(|| async { axum::Json(json!({ "tags": ["gguf"] })) }))
        .route("/api/models/acme/tiny-GGUF/tree/main", get(move || async move { axum::Json(tiny) }))
        .route("/api/models/acme/slow-GGUF/tree/main", get(move || async move { axum::Json(slow) }))
        .route(
            "/acme/{repo}/resolve/main/{file}",
            get(move |Path((repo, file)): Path<(String, String)>| {
                let gguf = gguf.clone();
                async move {
                    use axum::response::IntoResponse;
                    if repo == "slow-GGUF" {
                        // The first bytes, then nothing: a download to cancel.
                        let first = futures_util::stream::iter(vec![Ok::<_, std::io::Error>(vec![7u8; 4096])]);
                        let body = axum::body::Body::from_stream(first.chain(futures_util::stream::pending()));
                        return ([("content-length", "1000000")], body).into_response();
                    }
                    match file.as_str() {
                        "tokenizer.json" => b"{}".to_vec().into_response(),
                        _ => gguf.into_response(),
                    }
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    port
}

async fn job_until(port: u16, id: &str, done: impl Fn(&Value) -> bool) -> Value {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let (_, jobs) = post(port, "engine:downloads", json!([]), Some(TOKEN)).await;
        if let Some(j) = jobs.as_array().and_then(|a| a.iter().find(|j| j["id"] == id)).filter(|j| done(j)) {
            return j.clone();
        }
        assert!(Instant::now() < deadline, "{id} never got there: {jobs}");
        tokio::time::sleep(POLL).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn downloads_models_itself_and_merges_the_hosts_jobs() {
    let root = std::env::temp_dir().join(format!("nekkod-downloads-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let data = root.join("data");
    let home = root.join("home");
    std::fs::create_dir_all(&data).unwrap();
    // No other apps' folders to seed in this home.
    std::fs::write(data.join("settings.json"), r#"{"engine":{"modelFolders":[]}}"#).unwrap();
    let hf = fake_hugging_face(tiny_gguf("llama", "Tiny")).await;
    let h = home.to_string_lossy().to_string();
    let d = start_with_env(
        &data,
        json!({ "huggingFaceUrl": format!("http://127.0.0.1:{hf}") }),
        &[("HOME", Some(&h)), ("USERPROFILE", Some(&h)), ("OLLAMA_MODELS", None), ("HF_HOME", None)],
    );
    let mut events = ws(d.port, &format!("/api/events?token={TOKEN}"), Some("null")).await.unwrap();

    // One quantization, with its projector and tokenizer, from the catalog.
    let (status, started) =
        post(d.port, "engine:downloadModel", json!(["acme/tiny-GGUF", "Q4_K_M"]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{started}");
    assert_eq!(started["ok"], true, "{started}");
    let id = started["jobId"].as_str().unwrap().to_string();
    assert_eq!(id, "model:acme/tiny-GGUF:Q4_K_M");
    let done =
        job_until(d.port, &id, |j| j["state"] != "queued" && j["state"] != "downloading" && j["state"] != "verifying")
            .await;
    assert_eq!(done["state"], "done", "{done}");
    let weights = data.join("models/chat/acme_tiny-GGUF/tiny-Q4_K_M.gguf");
    assert!(weights.exists(), "{done}");
    assert!(!data.join("models/chat/acme_tiny-GGUF/tiny-Q4_K_M.gguf.part").exists());
    for extra in ["mmproj-F16.gguf", "tokenizer.json"] {
        job_until(d.port, &format!("{id}:{extra}"), |j| j["state"] == "done").await;
        assert!(data.join("models/chat/acme_tiny-GGUF").join(extra).exists(), "{extra}");
    }
    // The UI heard about it.
    let mut heard = false;
    while let Some(ev) = next_json(&mut events, Duration::from_secs(2)).await {
        if ev["channel"] == "downloads:updated"
            && ev["payload"].as_array().is_some_and(|a| a.iter().any(|j| j["id"] == id.as_str()))
        {
            heard = true;
            break;
        }
    }
    assert!(heard, "no downloads:updated event");
    // A finished model turns on autoStart, and the library lists it as a vision model.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let settings: Value =
            serde_json::from_str(&std::fs::read_to_string(data.join("settings.json")).unwrap()).unwrap();
        if settings["engine"]["autoStart"] == true {
            break;
        }
        assert!(Instant::now() < deadline, "autoStart was never turned on: {settings}");
        tokio::time::sleep(POLL).await;
    }
    let (_, models) = post(d.port, "engine:models", json!([]), Some(TOKEN)).await;
    let row =
        models.as_array().unwrap().iter().find(|m| m["id"] == "chat/acme_tiny-GGUF/tiny-Q4_K_M").cloned().unwrap();
    assert_eq!((row["sourceRepo"].clone(), row["modality"].clone()), (json!("acme/tiny-GGUF"), json!("vision")));

    // Its companions are already there; an image-only call answers null.
    let (_, companions) =
        post(d.port, "engine:downloadCompanions", json!(["chat/acme_tiny-GGUF/tiny-Q4_K_M"]), Some(TOKEN)).await;
    assert_eq!(companions["message"], "Tiny already has every companion file acme/tiny-GGUF ships.", "{companions}");
    let (_, image) =
        post(d.port, "engine:imageCompanions", json!(["chat/acme_tiny-GGUF/tiny-Q4_K_M"]), Some(TOKEN)).await;
    assert_eq!(image, Value::Null);
    let (_, missing) = post(d.port, "engine:downloadImageCompanions", json!(["nope"]), Some(TOKEN)).await;
    assert_eq!(missing, json!({ "ok": false, "message": "That model is not in the library." }));
    let (_, gone) = post(d.port, "engine:downloadModel", json!(["acme/missing-GGUF", "Q4_K_M"]), Some(TOKEN)).await;
    assert_eq!(gone, json!({ "ok": false, "message": "That model is no longer published." }));

    // A download cancelled midway keeps its partial file for a resume.
    let (_, slow) = post(d.port, "engine:downloadModel", json!(["acme/slow-GGUF", "Q4_K_M"]), Some(TOKEN)).await;
    let slow_id = slow["jobId"].as_str().unwrap().to_string();
    let receiving = job_until(d.port, &slow_id, |j| j["receivedBytes"].as_f64().unwrap_or(0.0) >= 4096.0).await;
    assert_eq!((receiving["state"].clone(), receiving["totalBytes"].clone()), (json!("downloading"), json!(1_000_000)));
    let (_, none) = post(d.port, "engine:cancelDownload", json!([slow_id]), Some(TOKEN)).await;
    assert_eq!(none, Value::Null);
    let cancelled = job_until(d.port, &slow_id, |j| j["state"] == "cancelled").await;
    assert_eq!(cancelled["message"], "Cancelled.");
    assert_eq!(std::fs::metadata(data.join("models/chat/acme_slow-GGUF/slow-Q4_K_M.gguf.part")).unwrap().len(), 4096);
    post(d.port, "engine:dismissDownload", json!([slow_id]), Some(TOKEN)).await;

    // A job the host pushed joins the list. The host's queue holds nothing now
    // (the runtime installs are here), so its controls are no-ops.
    let host_job = json!({ "id": "engine:llama:b9999-cuda", "kind": "engine", "label": "llama.cpp", "target": "b9999-cuda", "state": "downloading", "receivedBytes": 1, "startedAt": 9_999_999_999_999u64 });
    let (_, none) = post(d.port, "engine:hostDownloads", json!([[host_job]]), Some(TOKEN)).await;
    assert_eq!(none, Value::Null);
    let (_, jobs) = post(d.port, "engine:downloads", json!([]), Some(TOKEN)).await;
    let ids: Vec<&str> = jobs.as_array().unwrap().iter().map(|j| j["id"].as_str().unwrap()).collect();
    assert_eq!(ids[0], "engine:llama:b9999-cuda", "newest first: {ids:?}");
    assert!(!ids.contains(&slow_id.as_str()), "dismissed: {ids:?}");
    assert!(ids.contains(&id.as_str()));
    post(d.port, "engine:cancelDownload", json!(["engine:llama:b9999-cuda"]), Some(TOKEN)).await;
    post(d.port, "engine:dismissDownload", json!(["engine:llama:b9999-cuda"]), Some(TOKEN)).await;
    drop(events);
    drop(d);
    std::fs::remove_dir_all(root).ok();
}

/// A llama.cpp release archive for this machine's CPU build, made with the
/// system's own tar (bsdtar on Windows and macOS writes zip from the name).
fn engine_archive(dir: &std::path::Path) -> (String, &'static str, Vec<u8>) {
    let (build, name, exe) = if cfg!(windows) {
        ("win-x64-cpu", "llama-b11886-bin-win-cpu-x64.zip", "llama-server.exe")
    } else if cfg!(target_os = "macos") {
        ("macos-arm64-metal", "llama-b11886-bin-macos-arm64.tar.gz", "llama-server")
    } else if cfg!(target_arch = "aarch64") {
        ("linux-arm64-cpu", "llama-b11886-bin-ubuntu-arm64.tar.gz", "llama-server")
    } else {
        ("linux-x64-cpu", "llama-b11886-bin-ubuntu-x64.tar.gz", "llama-server")
    };
    let src = dir.join("archive-src/build/bin");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(src.join(exe), "not really llama-server").unwrap();
    let out = dir.join(name);
    let args: Vec<String> = if name.ends_with(".zip") {
        vec![
            "-a".into(),
            "-cf".into(),
            out.to_string_lossy().into(),
            "-C".into(),
            dir.join("archive-src").to_string_lossy().into(),
            "build".into(),
        ]
    } else {
        vec![
            "-czf".into(),
            out.to_string_lossy().into(),
            "-C".into(),
            dir.join("archive-src").to_string_lossy().into(),
            "build".into(),
        ]
    };
    let status = Command::new("tar").args(&args).stdin(Stdio::null()).status().expect("tar runs");
    assert!(status.success(), "tar {args:?}");
    (build.to_string(), name, std::fs::read(out).unwrap())
}

/// A loopback GitHub: the pinned llama.cpp release with one archive.
async fn fake_github(name: &'static str, archive: Vec<u8>) -> u16 {
    use axum::routing::get;
    use sha2::Digest;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let digest: String = sha2::Sha256::digest(&archive).iter().map(|b| format!("{b:02x}")).collect();
    let release = json!({
        "tag_name": "b11886",
        "assets": [{ "name": name, "browser_download_url": format!("http://127.0.0.1:{port}/dl/{name}"), "size": archive.len(), "digest": format!("sha256:{digest}") }],
    });
    let app = axum::Router::new()
        .route("/repos/ggml-org/llama.cpp/releases/tags/b11886", get(move || async move { axum::Json(release) }))
        .route(&format!("/dl/{name}"), get(move || async move { archive }));
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    port
}

#[tokio::test(flavor = "multi_thread")]
async fn installs_and_removes_the_engine_itself() {
    let root = std::env::temp_dir().join(format!("nekkod-installs-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let data = root.join("data");
    std::fs::create_dir_all(&data).unwrap();
    std::fs::write(data.join("settings.json"), r#"{"engine":{"modelFolders":[]}}"#).unwrap();
    let (build, name, archive) = engine_archive(&root);
    let gh = fake_github(name, archive).await;
    let d = start_with_env(&data, json!({ "githubApiUrl": format!("http://127.0.0.1:{gh}") }), &[]);

    let (_, preview) = post(d.port, "engine:installPreview", json!(["llama", build]), Some(TOKEN)).await;
    assert_eq!(
        (preview["version"].clone(), preview["files"][0]["name"].clone()),
        (json!("b11886"), json!(name)),
        "{preview}"
    );
    let (status, started) = post(d.port, "engine:install", json!([build, "llama"]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{started}");
    assert_eq!(started["message"], "Downloading llama.cpp b11886.", "{started}");
    let job =
        job_until(d.port, started["jobId"].as_str().unwrap(), |j| j["state"] == "done" || j["state"] == "failed").await;
    assert_eq!(job["state"], "done", "{job}");
    let exe = if cfg!(windows) { "llama-server.exe" } else { "llama-server" };
    let bin = data.join("engine").join(&build).join("build/bin").join(exe);
    assert!(bin.exists(), "unpacked: {job}");
    assert!(!data.join("engine").join(&build).join(name).exists(), "the archive is gone once unpacked");
    let record: Value =
        serde_json::from_str(&std::fs::read_to_string(data.join("engine/engine.json")).unwrap()).unwrap();
    assert_eq!((record["buildId"].clone(), record["version"].clone()), (json!(build), json!("b11886")));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&bin).unwrap().permissions().mode() & 0o777, 0o755);
    }

    let (_, detected) = post(d.port, "engine:detect", json!(["llama"]), Some(TOKEN)).await;
    assert_eq!(
        (detected["source"].clone(), detected["version"].clone()),
        (json!("managed"), json!("b11886")),
        "{detected}"
    );
    assert!(
        std::path::Path::new(detected["binPath"].as_str().unwrap())
            .ends_with(std::path::Path::new("build/bin").join(exe))
    );
    let (_, installed) = post(d.port, "engine:installedBin", json!([]), Some(TOKEN)).await;
    assert_eq!(installed, detected["binPath"]);
    let (_, installed) = post(d.port, "engine:installedBin", json!(["llama"]), Some(TOKEN)).await;
    assert_eq!(installed, detected["binPath"]);
    let (_, sd) = post(d.port, "engine:detect", json!(["diffusion"]), Some(TOKEN)).await;
    assert!(sd["available"].is_array(), "{sd}");
    // The tray's question, per runtime: the same answer `detect` gives.
    let (_, sd_bin) = post(d.port, "engine:installedBin", json!(["diffusion"]), Some(TOKEN)).await;
    assert_eq!(sd_bin, sd.get("binPath").cloned().unwrap_or(Value::Null), "{sd}");
    if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        let (_, mlx_bin) = post(d.port, "engine:installedBin", json!(["mlx"]), Some(TOKEN)).await;
        assert_eq!(mlx_bin, Value::Null);
    }
    let (_, mlx) = post(d.port, "engine:detect", json!(["mlx"]), Some(TOKEN)).await;
    if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        assert_eq!(mlx["reason"], "MLX runs on Apple Silicon Macs only.");
    }

    // The model server is asked whether it runs before files go.
    let (_, removed) = post(d.port, "engine:uninstall", json!(["llama"]), Some(TOKEN)).await;
    assert_eq!(removed, json!({ "ok": true, "message": "Removed the engine." }));
    assert!(!data.join("engine").join(&build).exists() && !data.join("engine/engine.json").exists());
    let (_, again) = post(d.port, "engine:uninstall", json!(["llama"]), Some(TOKEN)).await;
    assert_eq!(again["message"], "No managed engine is installed.");
    drop(d);
    std::fs::remove_dir_all(root).ok();
}

/// The stand-in `llama-server`, built beside this test if `cargo test` did not build examples.
fn fake_llama() -> std::path::PathBuf {
    let exe = format!("fake_llama_server{}", std::env::consts::EXE_SUFFIX);
    let deps = std::env::current_exe().unwrap().parent().unwrap().to_path_buf();
    let path = deps.parent().unwrap().join("examples").join(exe);
    if !path.is_file() {
        let target = deps.parent().unwrap().parent().unwrap();
        let ok = Command::new(env!("CARGO"))
            .args(["build", "-p", "nekkod", "--example", "fake_llama_server"])
            .env("CARGO_TARGET_DIR", target)
            .status()
            .unwrap()
            .success();
        assert!(ok, "the fake llama-server builds");
    }
    path
}

#[tokio::test(flavor = "multi_thread")]
async fn runs_the_model_server_itself() {
    let root = std::env::temp_dir().join(format!("nekkod-server-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let data = root.join("data");
    let model = data.join("models/chat/acme_tiny-gguf/tiny-q4_k_m.gguf");
    std::fs::create_dir_all(model.parent().unwrap()).unwrap();
    std::fs::write(&model, tiny_gguf("llama", "Tiny")).unwrap();
    let other = data.join("models/chat/acme_other-gguf/other-q4_k_m.gguf");
    std::fs::create_dir_all(other.parent().unwrap()).unwrap();
    std::fs::write(&other, tiny_gguf("qwen2", "Other")).unwrap();
    let port = free_port();
    let settings = json!({
        "engineBinPath": fake_llama(),
        "engine": { "port": port, "modelFolders": [], "maxLoaded": 1 },
    });
    std::fs::write(data.join("settings.json"), settings.to_string()).unwrap();
    let d = start_with_env(&data, json!({}), &[]);

    let (status, s) = post(d.port, "engine:status", json!([]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{s}");
    assert_eq!(
        (s["running"].clone(), s["install"]["source"].clone(), s["install"]["version"].clone()),
        (json!(false), json!("external"), json!("b4242"))
    );
    assert_eq!(s["port"], port);

    // Start: the daemon listens, and a provider entry points at the engine.
    let (_, started) = post(d.port, "engine:start", json!([]), Some(TOKEN)).await;
    assert_eq!(started, json!({ "ok": true, "message": format!("The engine is serving on port {port}.") }));
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(data.join("settings.json")).unwrap()).unwrap();
    let provider = saved["providers"].as_array().unwrap().iter().find(|p| p["kind"] == "llamacpp").cloned().unwrap();
    assert_eq!(
        (provider["id"].clone(), provider["baseUrl"].clone()),
        (json!("nekko-engine"), json!(format!("http://127.0.0.1:{port}/v1")))
    );

    // A load through the daemon's own policy, with the flags the binary knows.
    let id = "chat/acme_tiny-gguf/tiny-q4_k_m";
    let (_, loaded) = post(d.port, "engine:load", json!([id, { "contextTokens": 4096 }]), Some(TOKEN)).await;
    assert_eq!(loaded, json!({ "ok": true, "message": format!("Loaded {id}.") }), "{loaded}");
    let (_, s) = post(d.port, "engine:status", json!([]), Some(TOKEN)).await;
    assert_eq!(s["running"], true);
    assert_eq!(s["resident"][0]["id"], id);
    assert_eq!(s["resident"][0]["contextLength"], 4096);
    assert!(
        s["log"].as_array().unwrap().iter().any(|l| l
            .as_str()
            .unwrap()
            .ends_with(&format!("Loaded {id} on port {}.", ""))
            || l.as_str().unwrap().contains(&format!("Loaded {id} on port"))),
        "{s}"
    );
    let (_, models) = post(d.port, "engine:models", json!([]), Some(TOKEN)).await;
    let row = models.as_array().unwrap().iter().find(|m| m["id"] == id).cloned().unwrap();
    assert_eq!(row["loaded"], true);

    // The router serves it, and loads another on demand (evicting the first: one resident).
    let http = reqwest::Client::new();
    let list: Value =
        http.get(format!("http://127.0.0.1:{port}/v1/models")).send().await.unwrap().json().await.unwrap();
    let states: Vec<(Value, Value)> =
        list["data"].as_array().unwrap().iter().map(|m| (m["id"].clone(), m["state"].clone())).collect();
    assert!(states.contains(&(json!(id), json!("loaded"))), "{list}");
    let reply: Value = http
        .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
        .json(&json!({ "model": id, "messages": [{ "role": "user", "content": "hi" }] }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let said = reply["choices"][0]["message"]["content"].as_str().unwrap().to_string();
    assert!(
        said.contains("--ctx-size 4096") && said.contains("--cache-reuse 256") && said.contains("--spec-default"),
        "{said}"
    );
    assert!(!said.contains("--cache-ram"), "a flag the binary does not list is left out: {said}");
    let other_id = "chat/acme_other-gguf/other-q4_k_m";
    let reply: Value = http
        .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
        .json(&json!({ "model": other_id, "messages": [] }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(reply["model"], other_id, "{reply}");
    let (_, s) = post(d.port, "engine:status", json!([]), Some(TOKEN)).await;
    let resident: Vec<Value> = s["resident"].as_array().unwrap().iter().map(|r| r["id"].clone()).collect();
    assert_eq!(resident, [json!(other_id)], "{s}");

    // Residency and endpoint settings.
    let (_, ttl) = post(d.port, "engine:residentTtl", json!([other_id, 120]), Some(TOKEN)).await;
    assert_eq!(ttl, json!({ "ok": true, "message": format!("{other_id} now unloads after 120s idle.") }));
    let (_, next) = post(d.port, "engine:settings", json!([{ "apiKey": "sekret" }]), Some(TOKEN)).await;
    assert_eq!((next["apiKey"].clone(), next["port"].clone()), (json!("sekret"), json!(port)));
    let refused = http.get(format!("http://127.0.0.1:{port}/v1/models")).send().await.unwrap().status().as_u16();
    assert_eq!(refused, 401, "the listener was re-served with the key");
    let allowed = http
        .get(format!("http://127.0.0.1:{port}/v1/models"))
        .bearer_auth("sekret")
        .send()
        .await
        .unwrap()
        .status()
        .as_u16();
    assert_eq!(allowed, 200);
    let (_, image) = post(
        d.port,
        "engine:generateImage",
        json!([{ "modelId": other_id, "prompt": "x", "width": 100, "height": 512 }]),
        Some(TOKEN),
    )
    .await;
    assert_eq!(
        image["error"],
        "Use a prompt, dimensions from 256 to 2048 in multiples of 64, 1 to 100 steps and CFG from 0 to 30.",
        "{image}"
    );
    let (_, image) = post(
        d.port,
        "engine:generateImage",
        json!([{ "modelId": other_id, "prompt": "x", "width": 512, "height": 512 }]),
        Some(TOKEN),
    )
    .await;
    assert_eq!(image["error"], "Choose an image-generation model.", "{image}");

    let (_, unloaded) = post(d.port, "engine:unload", json!([other_id]), Some(TOKEN)).await;
    assert_eq!(unloaded["ok"], true);
    let (_, stopped) = post(d.port, "engine:stop", json!([]), Some(TOKEN)).await;
    assert_eq!(stopped, json!({ "ok": true, "message": "Stopped the engine." }));
    let (_, s) = post(d.port, "engine:status", json!([]), Some(TOKEN)).await;
    assert_eq!((s["running"].clone(), s["resident"].clone()), (json!(false), json!([])));
    assert!(http.get(format!("http://127.0.0.1:{port}/v1/models")).send().await.is_err(), "the listener is closed");
    drop(d);
    std::fs::remove_dir_all(root).ok();
}

/// The stand-in `sd-server`, built beside this test if `cargo test` did not build examples.
fn fake_sd() -> std::path::PathBuf {
    let exe = format!("fake_sd_server{}", std::env::consts::EXE_SUFFIX);
    let deps = std::env::current_exe().unwrap().parent().unwrap().to_path_buf();
    let path = deps.parent().unwrap().join("examples").join(exe);
    if !path.is_file() {
        let target = deps.parent().unwrap().parent().unwrap();
        let ok = Command::new(env!("CARGO"))
            .args(["build", "-p", "nekkod", "--example", "fake_sd_server"])
            .env("CARGO_TARGET_DIR", target)
            .status()
            .unwrap()
            .success();
        assert!(ok, "the fake sd-server builds");
    }
    path
}

#[tokio::test(flavor = "multi_thread")]
async fn the_daemon_runs_an_image_turn_on_its_model_server() {
    let root = std::env::temp_dir().join(format!("nekkod-image-turn-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let data = root.join("data");
    std::fs::create_dir_all(data.join("sessions")).unwrap();
    // An image model the library reads as one (its architecture), and the stand-in runtime.
    let model = data.join("models/image/acme_sd/tiny-sd.gguf");
    std::fs::create_dir_all(model.parent().unwrap()).unwrap();
    std::fs::write(&model, tiny_gguf("sd1", "Tiny SD")).unwrap();
    let sd_dir = data.join("engine/diffusion");
    std::fs::create_dir_all(&sd_dir).unwrap();
    std::fs::write(
        sd_dir.join("engine.json"),
        json!({ "buildId": "fake", "binPath": fake_sd(), "version": "fake" }).to_string(),
    )
    .unwrap();
    let port = free_port();
    std::fs::write(
        data.join("settings.json"),
        json!({ "engineBinPath": fake_llama(), "engine": { "port": port, "modelFolders": [] } }).to_string(),
    )
    .unwrap();
    let session = json!({ "id": "s_img", "title": "New chat", "messages": [], "createdAt": 1, "updatedAt": 1 });
    std::fs::write(data.join("sessions/s_img.json"), session.to_string()).unwrap();
    let d = start_with_env(&data, json!({}), &[]);
    let (_, models) = post(d.port, "engine:models", json!([]), Some(TOKEN)).await;
    let row = models.as_array().unwrap().iter().find(|m| m["modality"] == "image").cloned().expect("an image row");
    let id = row["id"].as_str().unwrap().to_string();
    let mut events = ws(d.port, &format!("/api/events?token={TOKEN}"), Some("null")).await.unwrap();

    let params = json!({ "modelId": id, "width": 512, "height": 768, "steps": 20, "cfgScale": 4.5, "seed": 42 });
    let opts = json!({ "sessionId": "s_img", "prompt": "  a calico cat  ", "params": params });
    let (status, body) = post(d.port, "chat:generateImage", json!([opts]), Some(TOKEN)).await;
    assert_eq!((status, body.clone()), (200, Value::Null), "{body}");
    let saved: Value =
        serde_json::from_str(&std::fs::read_to_string(data.join("sessions/s_img.json")).unwrap()).unwrap();
    assert_eq!(saved["title"], "a calico cat");
    assert_eq!((saved["chatType"].clone(), saved["modelId"].clone()), (json!("image"), json!(id)));
    assert_eq!(saved["imageParams"], params);
    let messages = saved["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0]["content"], "a calico cat");
    let reply = &messages[1];
    let image = reply["images"][0].as_str().unwrap_or_else(|| panic!("no image in the reply: {reply}"));
    // The stand-in drew the request it was sent: the trimmed prompt with the
    // steps, guidance and seed, and the size (`imageGenerationBody`).
    let drawn = image.strip_prefix("data:image/png;base64,").unwrap();
    let expected = "a calico cat\n<sd_cpp_extra_args>{\"sample_params\":{\"sample_steps\":20,\"guidance\":{\"txt_cfg\":4.5}},\"seed\":42}</sd_cpp_extra_args>|512x768";
    assert_eq!(drawn, fake_base64(expected.as_bytes()), "{reply}");
    assert_eq!(reply["generated"]["seed"], 42);
    assert_eq!(reply["generated"]["modelId"], json!(id));

    // The stages, then done: loading (the model was cold), generating.
    let mut stages = Vec::new();
    while let Some(ev) = next_json(&mut events, Duration::from_secs(2)).await {
        let p = &ev["payload"];
        if ev["channel"] == "agent:event" && p["sessionId"] == "s_img" {
            stages.push(format!("{}:{}", p["type"].as_str().unwrap(), p["label"].as_str().unwrap_or("")));
            if p["type"] == "done" {
                break;
            }
        }
    }
    assert_eq!(
        stages,
        [
            "image_status:Generating a 512×768 image",
            "image_status:Loading the image model",
            "image_status:Generating a 512×768 image",
            "done:",
        ],
        "{stages:?}"
    );

    // A seed of -1 records the one used; a stop while it draws ends the turn as stopped.
    let port2 = d.port;
    let slow = json!({ "sessionId": "s_img", "prompt": "slow fox", "params": { "modelId": id, "width": 256, "height": 256, "steps": 1, "cfgScale": 1, "seed": -1 } });
    let running = tokio::spawn(async move { post(port2, "chat:generateImage", json!([slow]), Some(TOKEN)).await });
    until("the image turn to be listed as running", Duration::from_secs(10), || async {
        let (_, running) = post(port2, "chat:running", json!([]), Some(TOKEN)).await;
        running.as_array().is_some_and(|r| r.contains(&json!("s_img"))).then_some(())
    })
    .await;
    let started = Instant::now();
    post(d.port, "chat:abort", json!(["s_img"]), Some(TOKEN)).await;
    let (status, _) = running.await.unwrap();
    assert_eq!(status, 200);
    assert!(started.elapsed() < Duration::from_secs(5));
    let saved: Value =
        serde_json::from_str(&std::fs::read_to_string(data.join("sessions/s_img.json")).unwrap()).unwrap();
    let last = saved["messages"].as_array().unwrap().last().unwrap().clone();
    assert_eq!(
        (last["content"].clone(), last["interrupted"].clone()),
        (json!("Stopped before the image finished."), json!(true))
    );
    let seed = saved["imageParams"]["seed"].clone();
    assert_eq!(seed, -1, "the chat keeps asking for a fresh seed");

    // A missing prompt is refused with the host's words, told to the chat.
    let (_, _) = post(
        d.port,
        "chat:generateImage",
        json!([{ "sessionId": "s_img", "prompt": " ", "params": params }]),
        Some(TOKEN),
    )
    .await;
    let mut refused = false;
    while let Some(frame) = next_json(&mut events, Duration::from_secs(5)).await {
        if frame["channel"] == "agent:event" && frame["payload"]["message"] == "Describe the image you want first." {
            refused = true;
            break;
        }
    }
    assert!(refused, "the chat was told why");
    post(d.port, "engine:stop", json!([]), Some(TOKEN)).await;
    drop(d);
    std::fs::remove_dir_all(root).ok();
}

fn fake_base64(bytes: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        for i in 0..4 {
            out.push(if i <= chunk.len() { T[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    out
}

/// A release of decision models on loopback: the English checkpoint's three small files as
/// published (their real bytes, so their pinned SHA-256s hold), a stand-in for everything
/// else, and counts of what was asked for. `tamper` serves a same-size `rl_agent_config.json`
/// with other bytes.
async fn fake_decision_release(tamper: bool) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
    use axum::extract::Path;
    use axum::routing::get;
    let fixtures = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/laya-en");
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let log = seen.clone();
    let app = axum::Router::new().route(
        "/download/decision-models-v1/{asset}",
        get(move |Path(asset): Path<String>| {
            let (fixtures, log) = (fixtures.clone(), log.clone());
            async move {
                use axum::response::IntoResponse;
                log.lock().unwrap().push(asset.clone());
                let file = asset.strip_prefix("laya-en.").unwrap_or(&asset);
                match std::fs::read(fixtures.join(file)) {
                    Ok(mut bytes) => {
                        if tamper && file == "rl_agent_config.json" {
                            bytes[2] ^= 1;
                        }
                        bytes.into_response()
                    }
                    // The tokenizer and the weights: bytes that are not the published ones.
                    Err(_) => b"not the published file".to_vec().into_response(),
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://127.0.0.1:{port}/download/decision-models-v1"), seen)
}

#[tokio::test(flavor = "multi_thread")]
async fn downloads_a_decision_model_from_its_release_through_the_queue_and_checks_every_file() {
    let root = std::env::temp_dir().join(format!("nekkod-decision-dl-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let data = root.join("data");
    let home = root.join("home");
    std::fs::create_dir_all(&data).unwrap();
    std::fs::write(data.join("settings.json"), r#"{"engine":{"modelFolders":[]}}"#).unwrap();
    let h = home.to_string_lossy().to_string();
    let dir = data.join("models").join("decision").join("laya-en");

    let (release, seen) = fake_decision_release(false).await;
    let d = start_with_env(
        &data,
        json!({ "decisionModelsUrl": release }),
        &[("HOME", Some(&h)), ("USERPROFILE", Some(&h)), ("OLLAMA_MODELS", None), ("HF_HOME", None)],
    );

    let (status, started) = post(d.port, "decisions:download", json!(["laya-en", "fp16"]), Some(TOKEN)).await;
    assert_eq!(status, 200, "{started}");
    assert_eq!(started, json!({ "ok": true, "message": "Downloading Laya (English) fp16 (0.85 GB)." }));
    let settled = |j: &Value| ["done", "failed", "cancelled"].contains(&j["state"].as_str().unwrap_or_default());
    // The three small files are the published ones: checked, and renamed into place.
    for file in ["tokenizer_config.json", "rl_agent_config.json", "config.json"] {
        let job = job_until(d.port, &format!("decision:laya-en:shared:{file}"), settled).await;
        assert_eq!(job["state"], "done", "{job}");
        assert_eq!(job["group"], "decision:laya-en:fp16");
        assert_eq!(job["groupLabel"], "Laya (English) · fp16");
        let want =
            std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/laya-en").join(file));
        assert_eq!(std::fs::read(dir.join(file)).ok(), want.ok(), "{file}");
    }
    // The others are not: refused before they are renamed, and nothing is left behind.
    for (id, file) in [
        ("decision:laya-en:shared:tokenizer.json", "tokenizer.json"),
        ("decision:laya-en:fp16:model_fp16.onnx", "model_fp16.onnx"),
    ] {
        let job = job_until(d.port, id, settled).await;
        assert_eq!(job["state"], "failed", "{job}");
        assert_eq!(job["message"], format!("{file} is not the published size."), "{job}");
        assert!(!dir.join(file).exists() && !dir.join(format!("{file}.part")).exists(), "{file} kept");
    }
    let mut asked = seen.lock().unwrap().clone();
    asked.sort();
    assert_eq!(
        asked,
        [
            "laya-en.config.json",
            "laya-en.model_fp16.onnx",
            "laya-en.rl_agent_config.json",
            "laya-en.tokenizer.json",
            "laya-en.tokenizer_config.json"
        ]
    );
    // An incomplete export is not a model yet.
    let (_, models) = post(d.port, "decisions:models", json!([]), Some(TOKEN)).await;
    assert_eq!(models, json!([]));
    // Asked again, only what is missing is fetched.
    seen.lock().unwrap().clear();
    let (_, again) = post(d.port, "decisions:download", json!(["laya-en", "fp16"]), Some(TOKEN)).await;
    assert_eq!(again["ok"], true, "{again}");
    job_until(d.port, "decision:laya-en:fp16:model_fp16.onnx", settled).await;
    job_until(d.port, "decision:laya-en:shared:tokenizer.json", settled).await;
    let mut asked = seen.lock().unwrap().clone();
    asked.sort();
    assert_eq!(asked, ["laya-en.model_fp16.onnx", "laya-en.tokenizer.json"]);
    // The decision files are not chat models: no autoStart, nothing in the library.
    let settings: Value = serde_json::from_str(&std::fs::read_to_string(data.join("settings.json")).unwrap()).unwrap();
    assert_ne!(settings["autoStart"], true, "{settings}");
    drop(d);

    // A file of the published size with other bytes is refused by its checksum.
    let _ = std::fs::remove_dir_all(&dir);
    let (tampered, _) = fake_decision_release(true).await;
    let d = start_with_env(
        &data,
        json!({ "decisionModelsUrl": tampered }),
        &[("HOME", Some(&h)), ("USERPROFILE", Some(&h)), ("OLLAMA_MODELS", None), ("HF_HOME", None)],
    );
    post(d.port, "decisions:download", json!(["laya-en", "int8"]), Some(TOKEN)).await;
    let job = job_until(d.port, "decision:laya-en:shared:rl_agent_config.json", settled).await;
    assert_eq!(job["state"], "failed", "{job}");
    assert_eq!(job["message"], "rl_agent_config.json is not the published file (checksum mismatch).");
    assert!(!dir.join("rl_agent_config.json").exists());
    let job = job_until(d.port, "decision:laya-en:shared:config.json", settled).await;
    assert_eq!(job["state"], "done", "{job}");
    drop(d);
    let _ = std::fs::remove_dir_all(&root);
}
