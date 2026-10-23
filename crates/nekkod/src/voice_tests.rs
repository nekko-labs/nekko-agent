use super::*;

fn wav(samples: usize) -> Vec<u8> {
    let data = samples * 2;
    let mut b = Vec::new();
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&((36 + data) as u32).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&16000u32.to_le_bytes());
    b.extend_from_slice(&32000u32.to_le_bytes());
    b.extend_from_slice(&2u16.to_le_bytes());
    b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(b"data");
    b.extend_from_slice(&(data as u32).to_le_bytes());
    b.resize(44 + data, 0);
    b
}

fn as_json(b: &[u8]) -> Value {
    json!(b)
}

#[test]
fn wav_checks_match_the_host() {
    let shape = "Voice audio must be a PCM WAV recording of at most 60 seconds.";
    let format = "Expected mono 16kHz 16-bit PCM WAV.";
    assert!(validate_wav(&as_json(&wav(100))).is_ok());
    assert_eq!(validate_wav(&json!("nope")).unwrap_err(), shape);
    assert_eq!(validate_wav(&as_json(&wav(0))).unwrap_err(), shape);
    assert_eq!(validate_wav(&as_json(&wav(16000 * 60 + 1))).unwrap_err(), shape);
    let mut bad = as_json(&wav(10));
    bad[50] = json!(256);
    assert_eq!(validate_wav(&bad).unwrap_err(), shape);
    bad[50] = json!(1.5);
    assert_eq!(validate_wav(&bad).unwrap_err(), shape);
    let mut stereo = wav(10);
    stereo[22] = 2;
    assert_eq!(validate_wav(&as_json(&stereo)).unwrap_err(), format);
    let mut short = wav(10);
    short.pop();
    assert_eq!(validate_wav(&as_json(&short)).unwrap_err(), format);
}

struct Rig {
    dir: PathBuf,
    voice: Arc<Voice>,
    base: String,
    _server: tokio::task::JoinHandle<()>,
}

impl Drop for Rig {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn sha(b: &[u8]) -> String {
    Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
}

/// A loopback "release host": the runtime archive at `/runtime.tar`, the
/// model at `/model.bin`, and `/stall`, which never finishes in time.
async fn rig(name: &str, model: Vec<u8>, settings: Value, break_model_hash: bool, stall_runtime: bool) -> Rig {
    let dir = std::env::temp_dir().join(format!("nekkod-voice-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let src = dir.join("src").join("bin");
    std::fs::create_dir_all(&src).unwrap();
    let exe = if cfg!(windows) { "whisper-server.exe" } else { "whisper-server" };
    std::fs::write(src.join(exe), b"fake").unwrap();
    let archive_path = dir.join("runtime.tar");
    let ok = std::process::Command::new("tar")
        .arg("-cf")
        .arg(&archive_path)
        .arg("-C")
        .arg(dir.join("src"))
        .arg("bin")
        .status()
        .unwrap()
        .success();
    assert!(ok, "tar builds the fixture archive");
    let archive = std::fs::read(&archive_path).unwrap();
    let runtime_hash = sha(&archive);
    let model_hash = if break_model_hash { "0".repeat(64) } else { sha(&model) };
    let app = axum::Router::new()
        .route("/runtime.tar", axum::routing::get(move || std::future::ready(archive.clone())))
        .route("/model.bin", axum::routing::get(move || std::future::ready(model.clone())))
        .route(
            "/stall",
            axum::routing::get(|| async {
                tokio::time::sleep(Duration::from_secs(60)).await;
                "late"
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let base = format!("http://127.0.0.1:{port}");
    let runtime_url = if stall_runtime { format!("{base}/stall") } else { format!("{base}/runtime.tar") };
    let sources = Sources {
        runtime: Some(("runtime.tar".into(), runtime_url, runtime_hash)),
        model: (format!("{base}/model.bin"), model_hash),
        speech_helper: None,
    };
    let settings: Arc<dyn Fn() -> Value + Send + Sync> = Arc::new(move || settings.clone());
    Rig { voice: Voice::new(dir.join("data").join("voice"), settings, sources), dir, base, _server: server }
}

async fn settle(voice: &Arc<Voice>) -> Value {
    for _ in 0..400 {
        let s = voice.status().await;
        if s["installing"] == json!(false) {
            return s;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("install never settled");
}

#[tokio::test]
async fn installs_a_verified_runtime_and_model() {
    let mut model = b"lmgg".to_vec();
    model.extend_from_slice(&[7u8; 1000]);
    let r = rig("install", model, json!({}), false, false).await;
    let first = r.voice.install(None).await.unwrap();
    assert_eq!(first["installing"], json!(true));
    let s = settle(&r.voice).await;
    assert_eq!(s.get("error"), None, "{s}");
    assert_eq!(
        (s["installed"].clone(), s["progress"].clone(), s["running"].clone()),
        (json!(true), json!(1), json!(false))
    );
    let keys: Vec<&str> = s.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        [
            "runtimePath",
            "modelPath",
            "installed",
            "installing",
            "progress",
            "running",
            "supported",
            "engine",
            "apple",
            "whisper"
        ]
    );
    assert_eq!(s["whisper"], json!({ "installed": true, "installing": false, "progress": 1 }));
    assert_eq!((s["engine"].clone(), s["apple"]["supported"].clone()), (json!("whisper"), json!(false)));
    let vdir = r.dir.join("data").join("voice");
    let record: Value = serde_json::from_slice(&std::fs::read(vdir.join("install.json")).unwrap()).unwrap();
    assert_eq!(record["version"], VERSION);
    assert!(is_file(Path::new(record["runtimePath"].as_str().unwrap())));
    assert!(vdir.join("THIRD-PARTY-NOTICES.txt").is_file());
    assert!(!vdir.join("runtime.tar").exists(), "the archive is removed");
    assert!(vdir.join(MODEL_FILE).is_file());

    // Uninstall deletes the managed folder.
    assert_eq!(r.voice.uninstall(None).await.unwrap(), Value::Null);
    assert!(!vdir.exists());
    assert_eq!(r.voice.status().await["installed"], json!(false));
    assert!(!r.base.is_empty());
}

#[tokio::test]
async fn a_bad_checksum_or_model_fails_the_install() {
    let r = rig("checksum", b"lmggxxxx".to_vec(), json!({}), true, false).await;
    r.voice.install(None).await.unwrap();
    assert_eq!(settle(&r.voice).await["error"], "Voice download checksum mismatch.");

    let r = rig("gguf", b"GGUFxxxx".to_vec(), json!({}), false, false).await;
    r.voice.install(None).await.unwrap();
    assert_eq!(settle(&r.voice).await["error"], "Choose a whisper.cpp GGML speech model (.bin), not an LLM GGUF.");
}

#[tokio::test]
async fn cancelling_stops_a_stalled_download() {
    let r = rig("cancel", b"lmgg".to_vec(), json!({}), false, true).await;
    r.voice.install(None).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(r.voice.status().await["installing"], json!(true));
    assert_eq!(r.voice.uninstall(None).await.unwrap_err(), "Stop voice work before uninstalling.");
    r.voice.cancel();
    assert_eq!(settle(&r.voice).await["error"], "Download cancelled. Click Download to retry.");
}

#[tokio::test]
async fn transcription_checks_come_first() {
    let audio = as_json(&wav(100));
    let r = rig("checks", b"lmgg".to_vec(), json!({ "voice": { "enabled": false } }), false, false).await;
    assert_eq!(r.voice.transcribe(&audio).await.unwrap_err(), "Voice is disabled in Settings.");
    let r = rig("checks2", b"lmgg".to_vec(), json!({ "voice": { "enabled": true } }), false, false).await;
    assert_eq!(
        r.voice.transcribe(&json!([1, 2])).await.unwrap_err(),
        "Voice audio must be a PCM WAV recording of at most 60 seconds."
    );
    assert_eq!(r.voice.transcribe(&audio).await.unwrap_err(), "Download Nekko Voice first.");
    let status = r.voice.status().await;
    assert_eq!((status["supported"].clone(), status.get("runtimePath")), (json!(true), None));
}

/// Apple's recognizer stands in as a shell script that answers like `nekko-speech`
/// and records what it was asked, so the arguments and the WAV hand-off are checked.
#[cfg(unix)]
fn apple_rig(name: &str, settings: Value, supported: bool) -> (Arc<Voice>, PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!("nekkod-apple-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("nekko-speech");
    let log = dir.join("calls.log");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\necho \"$@\" >> {log}\ncase \"$1\" in\n status) echo '{{\"supported\":{supported},\"installed\":{supported},\"locale\":\"en-US\"}}';;\n transcribe) [ -f \"$2\" ] || {{ echo '{{\"error\":\"no wav\"}}'; exit 1; }}; echo '{{\"text\":\" hello from apple \"}}';;\n install|uninstall) echo '{{\"installed\":true}}';;\n *) echo '{{\"error\":\"bad\"}}'; exit 1;;\nesac\n",
            log = log.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let settings: Arc<dyn Fn() -> Value + Send + Sync> = Arc::new(move || settings.clone());
    let sources = Sources { runtime: None, model: (String::new(), String::new()), speech_helper: Some(script) };
    (Voice::new(dir.join("data"), settings, sources), log)
}

#[cfg(unix)]
#[tokio::test]
async fn apple_is_the_default_engine_where_it_is_supported() {
    let (voice, log) = apple_rig("default", json!({ "voice": { "language": "en-GB" } }), true);
    let s = voice.status().await;
    assert_eq!(
        (s["engine"].clone(), s["installed"].clone(), s["installing"].clone()),
        (json!("apple"), json!(true), json!(false))
    );
    assert_eq!(s["apple"], json!({ "supported": true, "installed": true, "locale": "en-US", "installing": false }));
    assert_eq!(std::fs::read_to_string(&log).unwrap(), "status en-GB\n");
    // Polled again within the TTL: the helper is not run a second time.
    voice.status().await;
    assert_eq!(std::fs::read_to_string(&log).unwrap(), "status en-GB\n");
    let (voice, _) = apple_rig("unsupported", json!({}), false);
    assert_eq!(voice.status().await["engine"], json!("whisper"));
    let (voice, _) = apple_rig("chosen", json!({ "voice": { "engine": "whisper" } }), true);
    assert_eq!(voice.status().await["engine"], json!("whisper"));
}

#[cfg(unix)]
#[tokio::test]
async fn apple_transcribes_through_the_helper_and_cleans_up() {
    let (voice, log) = apple_rig("transcribe", json!({ "voice": { "enabled": true } }), true);
    assert_eq!(voice.transcribe(&as_json(&wav(1600))).await.unwrap(), json!("hello from apple"));
    let calls = std::fs::read_to_string(&log).unwrap();
    let line = calls.lines().find(|l| l.starts_with("transcribe ")).expect("a transcribe call");
    assert!(line.ends_with(" en"), "{line}");
    let wav_path = Path::new(line.split(' ').nth(1).unwrap());
    assert!(!wav_path.exists(), "the recording is removed after the run");
    let (voice, _) = apple_rig("disabled", json!({}), true);
    assert_eq!(voice.transcribe(&as_json(&wav(1600))).await.unwrap_err(), "Voice is disabled in Settings.");
}

#[cfg(unix)]
#[tokio::test]
async fn apple_install_and_uninstall_go_to_the_helper() {
    let (voice, log) = apple_rig("install", json!({}), true);
    let s = voice.install(Some("apple")).await.unwrap();
    assert_eq!(s["engine"], json!("apple"));
    let s = settle(&voice).await;
    assert_eq!(s.get("error"), None, "{s}");
    assert_eq!(voice.uninstall(Some("apple")).await.unwrap(), Value::Null);
    let calls = std::fs::read_to_string(&log).unwrap();
    assert!(calls.contains("install en\n") && calls.contains("uninstall en\n"), "{calls}");
}
