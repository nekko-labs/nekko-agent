//! Nekko Voice, served from the daemon: the whisper.cpp speech server's
//! install (a checksum-verified runtime archive and model, with progress),
//! its lifetime (started on the first transcription, stopped when idle) and
//! the transcriptions themselves. A port of `packages/host/src/engine/voice.ts`;
//! the daemon is the only writer of `<data>/voice` when it serves these.
//!
//! On macOS 26+ the default engine is Apple's on-device recognizer instead,
//! reached through `nekko-speech` (crates/nekkod/speech/nekko-speech.swift),
//! a one-shot command staged beside the daemon: no download, no server to
//! keep alive, and the language packs belong to the OS. `settings.voice.engine`
//! picks `apple` or `whisper`; the status answers for whichever is active.

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::Notify;

pub const CHANNELS: &[&str] =
    &["voice:status", "voice:install", "voice:cancel", "voice:uninstall", "voice:transcribe", "voice:stop"];

const VERSION: &str = "v1.9.2";
const MODEL_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en-q5_1.bin";
const MODEL_HASH: &str = "c77c5766f1cef09b6b7d47f21b546cbddd4157886b3b5d6d4f709e91e66c7c2b";
const MODEL_FILE: &str = "tiny.en-q5_1.bin";
const MAX_DOWNLOAD: usize = 150 * 1024 * 1024;
const MAX_WAV: usize = 44 + 16000 * 2 * 60;

/// The verified whisper.cpp release archives, by Node's `${platform}-${arch}`.
fn build() -> Option<(&'static str, &'static str)> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => {
            Some(("whisper-bin-x64.zip", "49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a"))
        }
        ("linux", "x86_64") => {
            Some(("whisper-bin-ubuntu-x64.tar.gz", "46811a3ecf584307480a220b9ef5ff81b7b22dc41577cbc274ce3afc61f753b1"))
        }
        ("linux", "aarch64") => Some((
            "whisper-bin-ubuntu-arm64.tar.gz",
            "7e26fa6a36d9174d5c0bf033ccbc026c3b5e569e2ee787058241346ef5392719",
        )),
        _ => None,
    }
}

const NOTICE: &str = "Nekko Voice uses Whisper Tiny.en Q5_1 (OpenAI) and whisper.cpp (ggml authors).\n\nMIT License\nCopyright (c) 2022 OpenAI\nCopyright (c) 2023-2026 The ggml authors\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the \"Software\"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\n";

/// Where the downloads come from; tests point these at a loopback server.
#[derive(Clone)]
pub struct Sources {
    pub runtime: Option<(String, String, String)>,
    pub model: (String, String),
    /// The `nekko-speech` command (Apple's recognizer); `None` where it was not staged.
    pub speech_helper: Option<PathBuf>,
}

impl Default for Sources {
    fn default() -> Self {
        let beside_exe = std::env::current_exe().ok().and_then(|e| Some(e.parent()?.join("nekko-speech")));
        Self {
            runtime: build().map(|(name, hash)| {
                (
                    name.to_string(),
                    format!("https://github.com/ggml-org/whisper.cpp/releases/download/{VERSION}/{name}"),
                    hash.to_string(),
                )
            }),
            model: (MODEL_URL.to_string(), MODEL_HASH.to_string()),
            speech_helper: std::env::var_os("NEKKO_SPEECH_PATH")
                .map(PathBuf::from)
                .or(beside_exe)
                .filter(|p| is_file(p)),
        }
    }
}

/// `validateVoiceWav`: mono 16 kHz 16-bit PCM, at most 60 seconds.
pub fn validate_wav(bytes: &Value) -> Result<Vec<u8>, String> {
    const SHAPE: &str = "Voice audio must be a PCM WAV recording of at most 60 seconds.";
    let list = bytes.as_array().ok_or(SHAPE)?;
    if list.len() < 46 || list.len() > MAX_WAV {
        return Err(SHAPE.into());
    }
    let b: Vec<u8> = list
        .iter()
        .map(|n| n.as_f64().filter(|f| f.fract() == 0.0 && (0.0..=255.0).contains(f)).map(|f| f as u8))
        .collect::<Option<_>>()
        .ok_or(SHAPE)?;
    let u16le = |i: usize| u16::from_le_bytes([b[i], b[i + 1]]);
    let u32le = |i: usize| u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]);
    if &b[0..4] != b"RIFF"
        || &b[8..12] != b"WAVE"
        || &b[12..16] != b"fmt "
        || u32le(16) != 16
        || u16le(20) != 1
        || u16le(22) != 1
        || u32le(24) != 16000
        || u16le(34) != 16
        || &b[36..40] != b"data"
        || u32le(40) as usize != b.len() - 44
    {
        return Err("Expected mono 16kHz 16-bit PCM WAV.".into());
    }
    Ok(b)
}

/// `validateVoiceModel`: a whisper.cpp GGML file starts with `lmgg`.
pub fn validate_model(path: &Path) -> Result<(), String> {
    use std::io::Read;
    let mut magic = [0u8; 4];
    let mut f =
        std::fs::File::open(path).map_err(|e| format!("Cannot open the speech model {}: {e}", path.display()))?;
    let n = f.read(&mut magic).map_err(|e| e.to_string())?;
    if n < 4 || u32::from_le_bytes(magic) != 0x6767_6d6c {
        return Err("Choose a whisper.cpp GGML speech model (.bin), not an LLM GGUF.".into());
    }
    Ok(())
}

#[derive(Default)]
struct State {
    installing: bool,
    progress: f64,
    error: Option<String>,
    busy: bool,
    apple: AppleState,
}

/// Apple's recognizer: installing is the language pack download; the helper's
/// `status` answer is kept for a few seconds because the UI polls every second.
#[derive(Default)]
struct AppleState {
    installing: bool,
    error: Option<String>,
    cached: Option<(Instant, String, Value)>,
}

const APPLE_STATUS_TTL: Duration = Duration::from_secs(5);

struct Server {
    child: tokio::process::Child,
    endpoint: String,
    key: String,
}

/// Cancellation for one install: a flag plus a wake-up for the waits.
#[derive(Default)]
struct Cancel {
    flag: AtomicBool,
    notify: Notify,
}

impl Cancel {
    fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }
    fn cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }
    /// Run `fut` unless cancelled first.
    async fn guard<T>(&self, fut: impl std::future::Future<Output = T>) -> Result<T, String> {
        if self.cancelled() {
            return Err("cancelled".into());
        }
        tokio::select! {
            v = fut => Ok(v),
            _ = self.notify.notified() => Err("cancelled".into()),
        }
    }
}

pub struct Voice {
    dir: PathBuf,
    settings: Arc<dyn Fn() -> Value + Send + Sync>,
    sources: Sources,
    http: reqwest::Client,
    state: Mutex<State>,
    cancel: Mutex<Option<Arc<Cancel>>>,
    server: tokio::sync::Mutex<Option<Server>>,
    /// Bumped by every transcription, so a stale idle timer stands down.
    generation: AtomicU64,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn is_file(p: &Path) -> bool {
    std::fs::metadata(p).is_ok_and(|m| m.is_file())
}

fn str_of(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string)
}

impl Voice {
    pub fn new(dir: PathBuf, settings: Arc<dyn Fn() -> Value + Send + Sync>, sources: Sources) -> Arc<Self> {
        Arc::new(Self {
            dir,
            settings,
            sources,
            http: reqwest::Client::new(),
            state: Mutex::default(),
            cancel: Mutex::default(),
            server: tokio::sync::Mutex::new(None),
            generation: AtomicU64::new(0),
        })
    }

    /// `settings().voice`, or an empty object.
    fn voice(&self) -> Value {
        match (self.settings)().get("voice") {
            Some(v @ Value::Object(_)) => v.clone(),
            _ => json!({}),
        }
    }

    /// The runtime and model the transcriptions use: the user's own paths
    /// first, then the managed install's record and model.
    fn paths(&self) -> (Option<String>, String) {
        let voice = self.voice();
        let record: Value = std::fs::read(self.dir.join("install.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or(Value::Null);
        let runtime = str_of(voice.get("runtimePath"))
            .or_else(|| record.get("runtimePath").and_then(Value::as_str).map(str::to_string));
        let model =
            str_of(voice.get("modelPath")).unwrap_or_else(|| self.dir.join(MODEL_FILE).to_string_lossy().into_owned());
        (runtime, model)
    }

    fn language(&self) -> String {
        str_of(self.voice().get("language")).unwrap_or_else(|| "en".into())
    }

    /// Run `nekko-speech` once and parse its one JSON line; a failure is its `error`.
    async fn helper(&self, args: &[&str], timeout: Duration) -> Result<Value, String> {
        let path = self.sources.speech_helper.as_ref().ok_or("Apple speech is not part of this build.")?;
        let mut cmd = tokio::process::Command::new(path);
        cmd.args(args).stdin(std::process::Stdio::null()).kill_on_drop(true);
        hide(&mut cmd);
        let out = tokio::time::timeout(timeout, cmd.output())
            .await
            .map_err(|_| "Apple speech did not answer in time.".to_string())?
            .map_err(|e| format!("Could not run nekko-speech: {e}"))?;
        let text = String::from_utf8_lossy(&out.stdout);
        let parsed: Option<Value> = text.lines().rev().find_map(|l| serde_json::from_str(l).ok());
        match parsed {
            Some(v) if out.status.success() => Ok(v),
            Some(v) => Err(str_of(v.get("error")).unwrap_or_else(|| "Apple speech failed.".into())),
            None => Err(format!("Apple speech failed: {}", String::from_utf8_lossy(&out.stderr).trim())),
        }
    }

    /// Apple's recognizer for the current language: supported, installed, installing, error.
    async fn apple_status(&self) -> Value {
        let lang = self.language();
        let fresh = lock(&self.state)
            .apple
            .cached
            .as_ref()
            .filter(|(at, l, _)| *l == lang && at.elapsed() < APPLE_STATUS_TTL)
            .map(|(_, _, v)| v.clone());
        let mut status = match fresh {
            Some(v) => v,
            None => {
                let v = match self.sources.speech_helper {
                    None => json!({ "supported": false, "installed": false }),
                    Some(_) => self
                        .helper(&["status", &lang], Duration::from_secs(10))
                        .await
                        .unwrap_or_else(|e| json!({ "supported": false, "installed": false, "reason": e })),
                };
                lock(&self.state).apple.cached = Some((Instant::now(), lang, v.clone()));
                v
            }
        };
        let st = lock(&self.state);
        status["installing"] = json!(st.apple.installing);
        if let Some(e) = &st.apple.error {
            status["error"] = json!(e);
        }
        status
    }

    fn forget_apple_status(&self) {
        lock(&self.state).apple.cached = None;
    }

    /// The active engine: the settings' choice, else Apple wherever it is supported.
    async fn engine(&self) -> &'static str {
        match str_of(self.voice().get("engine")).as_deref() {
            Some("apple") => "apple",
            Some("whisper") => "whisper",
            _ => {
                if nekko_js::truthy(self.apple_status().await.get("supported")) {
                    "apple"
                } else {
                    "whisper"
                }
            }
        }
    }

    /// `voice:status`, keys in the TS object's order; `installed`, `installing`
    /// and `error` speak for the active engine, `apple` for Apple's alone.
    pub async fn status(&self) -> Value {
        let (runtime, model) = self.paths();
        let apple = self.apple_status().await;
        let engine = self.engine().await;
        let whisper_installed = runtime.as_deref().is_some_and(|r| is_file(Path::new(r))) && is_file(Path::new(&model));
        let installed = if engine == "apple" { nekko_js::truthy(apple.get("installed")) } else { whisper_installed };
        let running = {
            let mut server = self.server.lock().await;
            let alive = server.as_mut().is_some_and(|s| matches!(s.child.try_wait(), Ok(None)));
            if !alive {
                *server = None;
            }
            alive
        };
        let supported = self.sources.runtime.is_some() || str_of(self.voice().get("runtimePath")).is_some();
        let st = lock(&self.state);
        let (installing, error) = if engine == "apple" {
            (st.apple.installing, st.apple.error.clone())
        } else {
            (st.installing, st.error.clone())
        };
        let mut o = Map::new();
        if let Some(r) = runtime {
            o.insert("runtimePath".into(), json!(r));
        }
        o.insert("modelPath".into(), json!(model));
        o.insert("installed".into(), json!(installed));
        o.insert("installing".into(), json!(installing));
        o.insert("progress".into(), crate_num(st.progress));
        if let Some(e) = error {
            o.insert("error".into(), json!(e));
        }
        o.insert("running".into(), json!(running));
        o.insert("supported".into(), json!(supported));
        o.insert("engine".into(), json!(engine));
        o.insert("apple".into(), apple);
        let mut whisper =
            json!({ "installed": whisper_installed, "installing": st.installing, "progress": crate_num(st.progress) });
        if let Some(e) = &st.error {
            whisper["error"] = json!(e);
        }
        o.insert("whisper".into(), whisper);
        Value::Object(o)
    }

    /// `voice:install apple`: the language pack download, in the background.
    async fn install_apple(self: &Arc<Self>) -> Result<Value, String> {
        {
            let mut st = lock(&self.state);
            if !st.apple.installing {
                st.apple.installing = true;
                st.apple.error = None;
                let me = self.clone();
                tokio::spawn(async move {
                    let lang = me.language();
                    let result = me.helper(&["install", &lang], Duration::from_secs(1800)).await;
                    let mut st = lock(&me.state);
                    st.apple.installing = false;
                    st.apple.error = result.err();
                    st.apple.cached = None;
                });
            }
        }
        Ok(self.status().await)
    }

    async fn uninstall_apple(&self) -> Result<Value, String> {
        if lock(&self.state).apple.installing {
            return Err("Wait for the language pack download to finish.".into());
        }
        let lang = self.language();
        self.helper(&["uninstall", &lang], Duration::from_secs(60)).await?;
        self.forget_apple_status();
        Ok(Value::Null)
    }

    /// Apple's recognizer reads a file: the recording is written beside the
    /// install, transcribed by one helper run, and removed.
    async fn transcribe_apple(&self, audio: Vec<u8>) -> Result<Value, String> {
        let io = |e: std::io::Error| e.to_string();
        tokio::fs::create_dir_all(&self.dir).await.map_err(io)?;
        let path = self.dir.join(format!("dictation-{:x}.wav", rand_u64()));
        tokio::fs::write(&path, &audio).await.map_err(io)?;
        let lang = self.language();
        let result = self.helper(&["transcribe", &path.to_string_lossy(), &lang], Duration::from_secs(120)).await;
        let _ = tokio::fs::remove_file(&path).await;
        Ok(json!(result?.get("text").and_then(Value::as_str).map(nekko_js::trim).unwrap_or_default()))
    }

    /// `voice:install`: starts the download in the background and answers at once.
    pub async fn install(self: &Arc<Self>, engine: Option<&str>) -> Result<Value, String> {
        if engine == Some("apple") {
            return self.install_apple().await;
        }
        if lock(&self.state).installing {
            return Ok(self.status().await);
        }
        let Some(runtime) = self.sources.runtime.clone() else {
            return Err("No verified downloadable speech server for this platform. Set a custom whisper-server path in Voice settings.".into());
        };
        let cancel = Arc::new(Cancel::default());
        *lock(&self.cancel) = Some(cancel.clone());
        {
            let mut st = lock(&self.state);
            st.installing = true;
            st.error = None;
            st.progress = 0.0;
        }
        let me = self.clone();
        tokio::spawn(async move {
            let result = me.run_install(&runtime, &cancel).await;
            let mut st = lock(&me.state);
            if let Err(e) = result {
                st.error =
                    Some(if cancel.cancelled() { "Download cancelled. Click Download to retry.".into() } else { e });
            }
            st.installing = false;
            drop(st);
            *lock(&me.cancel) = None;
        });
        Ok(self.status().await)
    }

    async fn run_install(&self, (name, url, hash): &(String, String, String), cancel: &Cancel) -> Result<(), String> {
        let io = |e: std::io::Error| e.to_string();
        tokio::fs::create_dir_all(&self.dir).await.map_err(io)?;
        let archive = self.dir.join(name);
        self.download(url, &archive, hash, cancel, 0.0).await?;
        let runtime = self.dir.join("runtime");
        tokio::fs::create_dir_all(&runtime).await.map_err(io)?;
        extract(&archive, &runtime, cancel).await?;
        let found = tokio::task::spawn_blocking({
            let runtime = runtime.clone();
            move || find_server(&runtime)
        })
        .await
        .ok()
        .flatten()
        .ok_or("Archive has no whisper-server binary.")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(&found, std::fs::Permissions::from_mode(0o755)).await.map_err(io)?;
        }
        let model = self.dir.join(MODEL_FILE);
        self.download(&self.sources.model.0, &model, &self.sources.model.1, cancel, 0.45).await?;
        validate_model(&model)?;
        tokio::fs::write(self.dir.join("THIRD-PARTY-NOTICES.txt"), NOTICE).await.map_err(io)?;
        if cancel.cancelled() {
            return Err("cancelled".into());
        }
        let record = json!({ "runtimePath": found.to_string_lossy(), "version": VERSION });
        tokio::fs::write(self.dir.join("install.json"), nekko_js::stringify(&record)).await.map_err(io)?;
        let _ = tokio::fs::remove_file(&archive).await;
        lock(&self.state).progress = 1.0;
        Ok(())
    }

    /// One verified download: capped, hashed, written beside its target and renamed in.
    async fn download(&self, url: &str, dest: &Path, hash: &str, cancel: &Cancel, offset: f64) -> Result<(), String> {
        let mut response = cancel.guard(nekko_net::send("models", self.http.get(url))).await?.map_err(|e| match e {
            nekko_net::Error::Http(e) => chain(&e),
            e => e.to_string(),
        })?;
        if !response.status().is_success() {
            return Err(format!("Download failed ({}).", response.status().as_u16()));
        }
        let total = response.content_length().unwrap_or(0) as f64;
        let mut data = Vec::new();
        let mut hasher = Sha256::new();
        while let Some(chunk) = cancel.guard(response.chunk()).await?.map_err(|e| e.to_string())? {
            if data.len() + chunk.len() > MAX_DOWNLOAD {
                return Err("Voice download exceeds size limit.".into());
            }
            hasher.update(&chunk);
            data.extend_from_slice(&chunk);
            let share = if total > 0.0 { (data.len() as f64 / total).min(1.0) } else { 0.0 };
            lock(&self.state).progress = offset + share * 0.45;
        }
        let digest: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
        if digest != hash {
            return Err("Voice download checksum mismatch.".into());
        }
        if cancel.cancelled() {
            return Err("cancelled".into());
        }
        let mut partial = dest.as_os_str().to_owned();
        partial.push(".partial");
        tokio::fs::write(&partial, &data).await.map_err(|e| e.to_string())?;
        tokio::fs::rename(&partial, dest).await.map_err(|e| e.to_string())
    }

    pub fn cancel(&self) {
        if let Some(c) = lock(&self.cancel).as_ref() {
            c.cancel();
        }
    }

    /// Stop the speech server (a settings change, the engine stopping, exit).
    pub async fn stop(&self) {
        if let Some(mut s) = self.server.lock().await.take() {
            let _ = s.child.start_kill();
            let _ = s.child.wait().await;
        }
    }

    pub async fn uninstall(&self, engine: Option<&str>) -> Result<Value, String> {
        if engine == Some("apple") {
            return self.uninstall_apple().await;
        }
        {
            let st = lock(&self.state);
            if st.installing || st.busy {
                return Err("Stop voice work before uninstalling.".into());
            }
        }
        self.stop().await;
        match tokio::fs::remove_dir_all(&self.dir).await {
            Ok(()) => Ok(Value::Null),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
            Err(e) => Err(e.to_string()),
        }
    }

    /// `voice:transcribe`: start the server if needed, send the recording, return its text.
    pub async fn transcribe(self: &Arc<Self>, wav: &Value) -> Result<Value, String> {
        if !nekko_js::truthy(self.voice().get("enabled")) {
            return Err("Voice is disabled in Settings.".into());
        }
        let audio = validate_wav(wav)?;
        {
            let mut st = lock(&self.state);
            if st.busy {
                return Err("Voice transcription is already running.".into());
            }
            st.busy = true;
        }
        if self.engine().await == "apple" {
            let result = self.transcribe_apple(audio).await;
            lock(&self.state).busy = false;
            return result;
        }
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let result = self.transcribe_inner(audio).await;
        lock(&self.state).busy = false;
        // Stop the server once it has sat idle for the configured time.
        // `voice?.idleSeconds ?? 60`, held to 10 s..10 min.
        let idle = match self.voice().get("idleSeconds") {
            None | Some(Value::Null) => 60.0,
            Some(v) => nekko_js::to_number(Some(v)),
        };
        let secs = if idle.is_nan() { 10.0 } else { idle.clamp(10.0, 600.0) };
        let me = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs_f64(secs)).await;
            if me.generation.load(Ordering::SeqCst) == generation && !lock(&me.state).busy {
                me.stop().await;
            }
        });
        result
    }

    async fn transcribe_inner(&self, audio: Vec<u8>) -> Result<Value, String> {
        let (runtime, model) = self.paths();
        let runtime = runtime.ok_or("Download Nekko Voice first.")?;
        validate_model(Path::new(&model))?;
        let voice = self.voice();
        // `${voice?.threads}`: a missing value prints `undefined`.
        let threads_text = voice.get("threads").map_or_else(|| "undefined".to_string(), nekko_js::display);
        let key = format!("{runtime}:{model}:{threads_text}");
        let mut server = self.server.lock().await;
        // Another runtime, model or thread count: restart with the new one.
        if server.as_ref().is_some_and(|s| s.key != key)
            && let Some(mut s) = server.take()
        {
            let _ = s.child.start_kill();
            let _ = s.child.wait().await;
        }
        if let Some(s) = server.as_mut()
            && !matches!(s.child.try_wait(), Ok(None))
        {
            *server = None;
        }
        if server.is_none() {
            let threads = match voice.get("threads") {
                None | Some(Value::Null) => 2.0,
                Some(v) => nekko_js::to_number(Some(v)),
            };
            let threads = 1f64.max(8f64.min(threads));
            *server = Some(start_server(&runtime, &model, threads, key).await?);
        }
        let endpoint = server.as_ref().map(|s| s.endpoint.clone()).unwrap_or_default();
        drop(server);

        let language = self.language();
        let boundary = format!("----nekkovoice{:x}", rand_u64());
        let mut body = Vec::new();
        let field = |body: &mut Vec<u8>, name: &str, value: &str| {
            body.extend_from_slice(
                format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n")
                    .as_bytes(),
            );
        };
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"voice.wav\"\r\nContent-Type: audio/wav\r\n\r\n"
            )
            .as_bytes(),
        );
        body.extend_from_slice(&audio);
        body.extend_from_slice(b"\r\n");
        field(&mut body, "response_format", "json");
        field(&mut body, "language", &language);
        field(&mut body, "temperature", "0");
        body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
        let response = self
            .http
            .post(format!("{endpoint}/inference"))
            .header("Content-Type", format!("multipart/form-data; boundary={boundary}"))
            .body(body)
            .timeout(Duration::from_secs(120))
            .send()
            .await
            .map_err(|e| chain(&e))?;
        if !response.status().is_success() {
            return Err(format!("Local transcription failed ({}).", response.status().as_u16()));
        }
        let result: Value = response.json().await.map_err(|e| e.to_string())?;
        Ok(json!(result.get("text").and_then(Value::as_str).map(nekko_js::trim).unwrap_or_default()))
    }

    pub async fn route(self: &Arc<Self>, channel: &str, args: &[Value]) -> Result<Value, String> {
        match channel {
            "voice:status" => Ok(self.status().await),
            "voice:install" => self.install(args.first().and_then(Value::as_str)).await,
            "voice:cancel" => {
                self.cancel();
                Ok(Value::Null)
            }
            "voice:uninstall" => self.uninstall(args.first().and_then(Value::as_str)).await,
            "voice:transcribe" => self.transcribe(args.first().unwrap_or(&Value::Null)).await,
            "voice:stop" => {
                self.stop().await;
                Ok(Value::Null)
            }
            other => Err(format!("{other} is not a voice channel")),
        }
    }
}

/// An error with its causes, so "error sending request" says why (DNS, TLS, refused).
fn chain(e: &dyn std::error::Error) -> String {
    let mut out = e.to_string();
    let mut cause = e.source();
    while let Some(c) = cause {
        out.push_str(&format!(": {c}"));
        cause = c.source();
    }
    out
}

fn crate_num(f: f64) -> Value {
    if f.fract() == 0.0 && f.is_finite() { json!(f as i64) } else { json!(f) }
}

fn rand_u64() -> u64 {
    let mut b = [0u8; 8];
    let _ = getrandom::fill(&mut b);
    u64::from_le_bytes(b)
}

/// `tar -xf archive -C dir` (bsdtar on Windows reads the zip too), 60 s at most.
async fn extract(archive: &Path, dir: &Path, cancel: &Cancel) -> Result<(), String> {
    let mut cmd = tokio::process::Command::new("tar");
    cmd.arg("-xf").arg(archive).arg("-C").arg(dir).stdin(std::process::Stdio::null()).kill_on_drop(true);
    hide(&mut cmd);
    let child = cmd.spawn().map_err(|e| format!("Could not run tar: {e}"))?;
    let out = cancel
        .guard(tokio::time::timeout(Duration::from_secs(60), child.wait_with_output()))
        .await?
        .map_err(|_| "Extracting the speech server timed out.".to_string())?
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("Command failed: tar -xf {} -C {}", archive.display(), dir.display()));
    }
    Ok(())
}

fn hide(cmd: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    crate::procgroup::on_child_spawn(cmd);
}

/// The first `whisper-server` (`.exe`) under `root`, depth first in directory order.
fn find_server(root: &Path) -> Option<PathBuf> {
    for entry in std::fs::read_dir(root).ok()?.flatten() {
        let path = entry.path();
        let kind = entry.file_type().ok()?;
        if kind.is_dir() {
            if let Some(found) = find_server(&path) {
                return Some(found);
            }
        } else if matches!(entry.file_name().to_str(), Some("whisper-server" | "whisper-server.exe")) {
            return Some(path);
        }
    }
    None
}

async fn free_port() -> Result<u16, String> {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    l.local_addr().map(|a| a.port()).map_err(|e| e.to_string())
}

/// Start `whisper-server` on a free loopback port and wait for `/health` (30 s at most).
async fn start_server(runtime: &str, model: &str, threads: f64, key: String) -> Result<Server, String> {
    let port = free_port().await?;
    let endpoint = format!("http://127.0.0.1:{port}");
    let mut cmd = tokio::process::Command::new(runtime);
    cmd.args([
        "-m",
        model,
        "--host",
        "127.0.0.1",
        "--port",
        &port.to_string(),
        "-ng",
        "-t",
        &nekko_js::number_to_string(threads),
    ])
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::null())
    .kill_on_drop(true);
    hide(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let http = reqwest::Client::new();
    for _ in 0..150 {
        if !matches!(child.try_wait(), Ok(None)) {
            return Err("Speech server exited. Check the runtime and model.".into());
        }
        let ok = http
            .get(format!("{endpoint}/health"))
            .timeout(Duration::from_millis(500))
            .send()
            .await
            .is_ok_and(|r| r.status().is_success());
        if ok {
            return Ok(Server { child, endpoint, key });
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let _ = child.start_kill();
    let _ = child.wait().await;
    Err("Speech server startup timed out.".into())
}

#[cfg(test)]
#[path = "voice_tests.rs"]
mod tests;
