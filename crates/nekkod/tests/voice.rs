//! The real daemon runs Nekko Voice itself: with no TS backend, a
//! transcription starts the speech server (a stand-in, `examples/fake_whisper.rs`,
//! taking whisper-server's arguments), sends it the recording as multipart, and
//! `voice:stop` ends it.

use serde_json::{Value, json};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

const TOKEN: &str = "voice-test-token-0123456789";

struct Daemon {
    child: Child,
    port: u16,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn start(data_dir: &std::path::Path) -> Daemon {
    let config = json!({ "token": TOKEN, "allowedOrigins": ["null"], "dataDir": data_dir });
    let mut child = Command::new(env!("CARGO_BIN_EXE_nekkod"))
        .arg("--config-stdin")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("nekkod starts");
    // The config is the first line of stdin; stdin stays open (its end stops the daemon).
    std::io::Write::write_all(child.stdin.as_mut().unwrap(), format!("{config}\n").as_bytes()).unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let line = lines.next().expect("a ready line").unwrap();
    let ready: Value = serde_json::from_str(line.strip_prefix("NEKKOD_READY ").expect("ready prefix")).unwrap();
    std::thread::spawn(move || for _ in lines {});
    Daemon { child, port: ready["port"].as_u64().unwrap() as u16 }
}

async fn post(port: u16, channel: &str, args: Value) -> (u16, Value) {
    let res = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}/api/{channel}"))
        .bearer_auth(TOKEN)
        .json(&json!({ "args": args }))
        .send()
        .await
        .unwrap();
    let status = res.status().as_u16();
    (status, res.json().await.unwrap_or(Value::Null))
}

/// The stand-in speech server, built beside this test if `cargo test` did not build examples.
fn fake_whisper() -> PathBuf {
    let exe = format!("fake_whisper{}", std::env::consts::EXE_SUFFIX);
    let deps = std::env::current_exe().unwrap().parent().unwrap().to_path_buf();
    let path = deps.parent().unwrap().join("examples").join(exe);
    if !path.is_file() {
        let target = deps.parent().unwrap().parent().unwrap();
        let ok = Command::new(env!("CARGO"))
            .args(["build", "-p", "nekkod", "--example", "fake_whisper"])
            .env("CARGO_TARGET_DIR", target)
            .status()
            .unwrap()
            .success();
        assert!(ok, "the fake whisper-server builds");
    }
    path
}

fn wav() -> Vec<u8> {
    let data = 3200usize;
    let mut b = Vec::new();
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&((36 + data) as u32).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    for v in [16u32.to_le_bytes().to_vec(), 1u16.to_le_bytes().to_vec(), 1u16.to_le_bytes().to_vec()] {
        b.extend_from_slice(&v);
    }
    b.extend_from_slice(&16000u32.to_le_bytes());
    b.extend_from_slice(&32000u32.to_le_bytes());
    b.extend_from_slice(&2u16.to_le_bytes());
    b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(b"data");
    b.extend_from_slice(&(data as u32).to_le_bytes());
    b.resize(44 + data, 0);
    b
}

#[tokio::test(flavor = "multi_thread")]
async fn a_transcription_runs_the_speech_server_in_the_daemon() {
    let dir = std::env::temp_dir().join(format!("nekkod-voice-it-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let model = dir.join("model.bin");
    std::fs::write(&model, b"lmgg-not-really-a-model").unwrap();
    let runtime = fake_whisper();
    let settings = json!({ "voice": { "enabled": true, "runtimePath": runtime, "modelPath": model, "language": "ja", "threads": 3, "idleSeconds": 10 } });
    std::fs::write(dir.join("settings.json"), settings.to_string()).unwrap();
    let d = start(&dir);

    let (status, s) = post(d.port, "voice:status", json!([])).await;
    assert_eq!(status, 200);
    assert_eq!(
        (s["installed"].clone(), s["running"].clone(), s["supported"].clone()),
        (json!(true), json!(false), json!(true)),
        "{s}"
    );

    let (status, text) = post(d.port, "voice:transcribe", json!([wav()])).await;
    assert_eq!(status, 200, "{text}");
    assert_eq!(
        text,
        json!("heard wav=true language=ja format=json temperature=0 threads=3 multipart=true"),
        "trimmed, with every field the host sends"
    );
    assert_eq!(post(d.port, "voice:status", json!([])).await.1["running"], json!(true));
    // A second recording reuses the running server.
    assert_eq!(post(d.port, "voice:transcribe", json!([wav()])).await.0, 200);

    let (status, body) = post(d.port, "voice:transcribe", json!([[1, 2, 3]])).await;
    assert_eq!(
        (status, body["error"].clone()),
        (400, json!("Voice audio must be a PCM WAV recording of at most 60 seconds."))
    );

    assert_eq!(post(d.port, "voice:stop", json!([])).await.0, 200);
    assert_eq!(post(d.port, "voice:status", json!([])).await.1["running"], json!(false));

    drop(d);
    let _ = std::fs::remove_dir_all(&dir);
}
