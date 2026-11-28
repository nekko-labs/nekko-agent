//! The models on this machine: `library.json` reconciled against the files
//! in our models folder and the folders other apps keep (LM Studio, Ollama's
//! manifests, a Hugging Face cache, MLX checkpoints). A port of
//! `packages/host/src/engine/library.ts`, `ollama.ts`, `mlx.ts`'s
//! `readMlxModel`, the engine facade's folder report, first-start seed and
//! GPU-fit verdict, and `modelModality`, held to them by
//! `tests/golden/library.json`.
//!
//! The files are the truth and the index is a cache: every listing re-reads
//! the folders, describes a file it has not seen from its GGUF header, and
//! drops rows whose file is gone. The daemon is the index's single writer;
//! its writes are atomic (the TS wrote in place).

use crate::capacity::{self, FitRequest, Hardware, ModelFacts, PlanOptions};
use crate::folders::{Candidate, companions_dir, companions_key, known_folder};
use crate::gguf::{self, GgufMetadata};
use crate::load_check::{EngineInUse, LoadCheck, engine_meets_min_build, load_check};
use crate::num;
use nekko_tools::nodefs;
use nekko_tools::path::native as path;
use regress::Regex;
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, OnceLock};
use std::time::SystemTime;

const INDEX_FILE: &str = "library.json";
/// The folder downloads land in. Its models keep bare, unprefixed ids.
pub const PRIMARY_FOLDER_ID: &str = "primary";
const OLLAMA_MODEL_LAYER: &str = "application/vnd.ollama.image.model";
/// `ENGINE_DEFAULT_CONTEXT`.
pub const ENGINE_DEFAULT_CONTEXT: f64 = 65_536.0;
#[cfg(windows)]
const SEP: &str = "\\";
#[cfg(not(windows))]
const SEP: &str = "/";

macro_rules! regex {
    ($pattern:expr) => {{
        static R: OnceLock<Regex> = OnceLock::new();
        R.get_or_init(|| Regex::with_flags($pattern, "i").expect("a valid built-in pattern"))
    }};
}

fn test(r: &Regex, s: &str) -> bool {
    r.find(s).is_some()
}

/* ------------------------------------------------------------- modality */

/// `modelModality`: what a model file is for, from its architecture, else
/// its name, else whether a projector sits beside it.
pub fn model_modality(
    architecture: Option<&str>,
    name: Option<&str>,
    has_projector: bool,
    readable: Option<&Value>,
) -> &'static str {
    let arch = architecture.unwrap_or("");
    let unreadable = readable == Some(&Value::Bool(false));
    if !arch.is_empty() {
        if test(
            regex!(
                r"^(sd\d?|sdxl|sd[-_]?turbo|stable[-_]?diffusion.*|flux.*|wuerstchen|pixart.*|ltxv.*|hidream.*|chroma.*|qwen[-_]?image.*|z[-_]?image.*|ovis[-_]?image.*|wan\d.*|hunyuan.*(image|video).*|cogvideo.*)"
            ),
            arch,
        ) {
            return "image";
        }
        if test(
            regex!(r"^(whisper.*|parakeet.*|moonshine.*|sense-?voice.*|wav2vec.*|hubert.*|seamless.*|zipformer.*)"),
            arch,
        ) {
            return "audio";
        }
        // A DFlash drafter's GGUF says `dflash`, with no "draft" in it.
        if test(regex!(r"draft|dflash|eagle|medusa|lookahead|speculative"), arch) {
            return "draft";
        }
        if test(embedding_archs(), arch) {
            return "embedding";
        }
        if test(vision_archs(), arch) {
            return "vision";
        }
    }
    if arch.is_empty() && !unreadable {
        let name = nekko_js::slice16(name.unwrap_or(""), 256);
        if test(
            regex!(
                r"(?:^|[ /_-])(?:sd[123](?:[. _-]|$)|sdxl|flux[. _-]|stable[-_ ]diffusion|qwen[-_ ]image|z[-_ ]image|hidream|chroma|text-to-image|image-to-image)"
            ),
            name,
        ) {
            return "image";
        }
        if test(regex!(r"embedding|feature-extraction|(?:^|[ /_-])bge[-_]"), name) {
            return "embedding";
        }
        if test(regex!(r"whisper|parakeet|automatic-speech-recognition"), name) {
            return "audio";
        }
        if test(vision_archs(), name) || test(regex!(r"image-text-to-text|\bvision\b"), name) {
            return "vision";
        }
    }
    if has_projector {
        return "vision";
    }
    if unreadable {
        if test(regex!(r"whisper|parakeet|moonshine|sense-?voice"), name.unwrap_or("")) {
            return "audio";
        }
        return "unknown";
    }
    "chat"
}

fn embedding_archs() -> &'static Regex {
    regex!(r"bert|embed|bge|gte-?|roberta|xlm-?roberta|nomic|jina-?v\d")
}

fn vision_archs() -> &'static Regex {
    regex!(
        r"llava|qwen\d*vl|gemma[3-9]|gemma3n|mllama|llama-?\d?.*vision|pixtral|moondream|minicpm-?v|internvl|deepseek.*(ocr|vl)|smolvlm|paligemma|idefics|phi-?\d*.*vision|kimi-?vl|glm-?\d*v|ovis|voxtral|ultravox|muse-?glimmer|nemotron.*omni"
    )
}

/// `modelModality` over a library row.
fn row_modality(row: &Map<String, Value>, name: &str) -> &'static str {
    model_modality(
        row.get("architecture").and_then(Value::as_str),
        Some(name),
        nekko_js::truthy(row.get("hasProjector")),
        row.get("readable"),
    )
}

/// `defaultContextTokens`: the trained context, capped at 64k.
pub fn default_context_tokens(max_context: Option<f64>) -> f64 {
    let trained = max_context.filter(|c| *c > 0.0).unwrap_or(ENGINE_DEFAULT_CONTEXT);
    trained.min(ENGINE_DEFAULT_CONTEXT)
}

/* ------------------------------------------------------------- the files */

fn exists(p: &str) -> bool {
    std::fs::metadata(p).is_ok()
}

fn size_of(p: &str) -> f64 {
    std::fs::metadata(p).map_or(0.0, |m| m.len() as f64)
}

fn is_dir(p: &str) -> bool {
    std::fs::metadata(p).is_ok_and(|m| m.is_dir())
}

fn lower(s: &str) -> String {
    s.to_lowercase()
}

/// `s.replace(/\.gguf$/i, '')`.
fn strip_gguf(s: &str) -> &str {
    match s.len().checked_sub(5) {
        Some(at) if s.is_char_boundary(at) && s[at..].eq_ignore_ascii_case(".gguf") => &s[..at],
        _ => s,
    }
}

fn ends_gguf(name: &str) -> bool {
    lower(name).ends_with(".gguf")
}

/// A later shard of a split model (`-00002-of-00005.gguf`).
fn later_shard(p: &str) -> bool {
    test(regex!(r"-\d{5}-of-\d{5}\.gguf$"), p) && !test(regex!(r"-00001-of-\d{5}\.gguf$"), p)
}

fn is_projector(p: &str) -> bool {
    test(regex!(r"mmproj"), &path::basename(p))
}

/// One folder to scan, resolved from settings.
#[derive(Clone)]
struct Root {
    id: Value,
    path: String,
    provider: Option<Value>,
    /// Only the primary folder is ours to write to.
    managed: bool,
}

impl Root {
    fn id_str(&self) -> String {
        nekko_js::display(&self.id)
    }

    fn is_ollama(&self) -> bool {
        self.provider.as_ref().and_then(Value::as_str) == Some("ollama")
    }
}

/// What the library reads its folders from.
#[derive(Clone)]
pub struct LibraryConfig {
    /// Where downloads land (`modelsDir`).
    pub models_dir: String,
    /// The other folders, as saved in the engine settings (`modelFolders`).
    pub folders: Vec<Value>,
    /// Whether MLX rows can run here (an Apple Silicon Mac).
    pub mlx_runnable: bool,
    /// `Date.now()`, for new rows.
    pub now: f64,
}

impl LibraryConfig {
    fn index_path(&self) -> String {
        path::join(&[&self.models_dir, INDEX_FILE])
    }

    /// Every folder to read, primary first, duplicates (by resolved path) dropped.
    fn roots(&self) -> Vec<Root> {
        let primary = path::resolve(&[&self.models_dir]);
        let mut seen = HashSet::from([lower(&primary)]);
        let mut out =
            vec![Root { id: json!(PRIMARY_FOLDER_ID), path: primary, provider: Some(json!("nekko")), managed: true }];
        for folder in &self.folders {
            let enabled = nekko_js::truthy(folder.get("enabled"));
            let Some(p) = folder.get("path").and_then(Value::as_str) else { continue };
            if !enabled || nekko_js::trim(p).is_empty() {
                continue;
            }
            let p = path::resolve(&[p]);
            if !seen.insert(lower(&p)) {
                continue;
            }
            out.push(Root {
                id: folder.get("id").cloned().unwrap_or(Value::Null),
                path: p,
                provider: folder.get("provider").cloned().filter(|v| !v.is_null()),
                managed: false,
            });
        }
        out
    }
}

/// Every `.gguf` under one folder; deeper for a borrowed folder than ours
/// (a Hugging Face cache files models three levels down).
fn scan_folder(root: &Root) -> Vec<String> {
    fn walk(dir: &str, depth: u32, max: u32, out: &mut Vec<String>) {
        let Ok(entries) = nodefs::read_dir(dir) else { return };
        for entry in entries {
            let full = path::join(&[dir, &entry.name]);
            if entry.is_dir && (entry.name == "blobs" || entry.name == ".companions") {
                continue;
            }
            if entry.is_dir && depth < max {
                walk(&full, depth + 1, max, out);
            } else if ends_gguf(&entry.name)
                && (entry.is_file || (Path::new(&full).is_file() && hf_snapshot_repo(&full).is_some()))
            {
                out.push(full);
            }
        }
    }
    let mut out = Vec::new();
    walk(&root.path, 0, if root.managed { 3 } else { 5 }, &mut out);
    out
}

/// A stable id: the path below its folder with `/` separators, prefixed with
/// the folder for everything outside our own (`idFor`).
fn id_for(root: &Root, p: &str) -> String {
    let full = path::resolve(&[p]);
    let prefix = if root.path.ends_with(SEP) { root.path.clone() } else { format!("{}{SEP}", root.path) };
    let full16: Vec<u16> = full.encode_utf16().collect();
    let prefix_len = prefix.encode_utf16().count();
    let rel = if lower(&full).starts_with(&lower(&prefix)) {
        String::from_utf16_lossy(full16.get(prefix_len..).unwrap_or_default())
    } else {
        path::basename(&full)
    };
    let clean = rel.replace('\\', "/");
    let clean = strip_gguf(&clean);
    if root.id == json!(PRIMARY_FOLDER_ID) { clean.to_string() } else { format!("{}/{clean}", root.id_str()) }
}

/// `relative(root, p).split(sep)`.
fn rel_parts(root: &str, p: &str) -> Vec<String> {
    path::relative(root, p).split(SEP).map(str::to_string).collect()
}

/// The repo a managed download came from: `<type>/<owner>_<repo>/<file>`.
fn repo_from_typed_path(root: &str, p: &str) -> Option<String> {
    let repo = rel_parts(root, p).get(1).cloned().unwrap_or_default();
    let units: Vec<u16> = repo.encode_utf16().collect();
    let i = units.iter().position(|u| *u == u16::from(b'_'))?;
    (i > 0).then(|| format!("{}/{}", String::from_utf16_lossy(&units[..i]), String::from_utf16_lossy(&units[i + 1..])))
}

/// A header name that says nothing about the model. llama.cpp's converter
/// takes `general.name` from the source folder, so a checkout called `hf`
/// yields "Hf". True when every word of the name is a generic folder word.
fn is_generic_name(name: &str) -> bool {
    const GENERIC: [&str; 8] = ["hf", "model", "models", "gguf", "main", "snapshot", "snapshots", "unknown"];
    let lowered = name.to_lowercase();
    let mut words = lowered.split(|c: char| !c.is_alphabetic()).filter(|w| !w.is_empty()).peekable();
    words.peek().is_some() && words.all(|w| GENERIC.contains(&w))
}

fn is_lmstudio(root: &Root) -> bool {
    root.provider.as_ref().and_then(Value::as_str) == Some("lmstudio")
}

/// LM Studio keeps `<root>/<publisher>/<repo>/<file>.gguf`, named after the
/// Hugging Face repo it was fetched from. Only a row named after its file (the
/// header had no usable name) takes it: a folder can be named for something
/// else, and a real header name says better what the model is.
fn lmstudio_repo(root: &Root, p: &str, shown: &str) -> Option<String> {
    if !is_lmstudio(root) || shown != strip_gguf(&path::basename(p)) {
        return None;
    }
    match rel_parts(&root.path, p).as_slice() {
        [publisher, repo, _file] if !publisher.is_empty() && !repo.is_empty() => Some(format!("{publisher}/{repo}")),
        _ => None,
    }
}

/// Rows indexed before names were vetted keep a meaningless "Hf", and LM Studio
/// rows may carry a folder repo over a real header name. Fix just those fields
/// so presets and the rest stay put.
fn refresh_naming(root: &Root, p: &str, stored: &mut Map<String, Value>) -> bool {
    let mut changed = false;
    if stored.get("name").and_then(Value::as_str).is_some_and(is_generic_name) {
        stored.insert("name".into(), json!(strip_gguf(&path::basename(p))));
        changed = true;
    }
    if is_lmstudio(root) {
        let shown = stored.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
        let repo = lmstudio_repo(root, p, &shown).map(Value::String);
        if stored.get("sourceRepo") != repo.as_ref() {
            assign(stored, "sourceRepo", repo);
            changed = true;
        }
    }
    changed
}

fn put(m: &mut Map<String, Value>, k: &str, v: Option<Value>) {
    if let Some(v) = v {
        m.insert(k.into(), v);
    }
}

/// `{ ...row, k: v }` where `v` may be `undefined`: an undefined value is
/// never printed, so the key goes.
fn assign(m: &mut Map<String, Value>, k: &str, v: Option<Value>) {
    match v {
        Some(v) => {
            m.insert(k.into(), v);
        }
        None => {
            m.shift_remove(k);
        }
    }
}

/// A row described before the KV or weight layout was read gets them once,
/// from its header; everything else in the row (its name, preset, when it was
/// added) stays. `true` when the row changed.
fn add_kv_layout(stored: &mut Map<String, Value>, p: &str) -> bool {
    let want_kv = !stored.contains_key("kvLayout");
    let want_weights = !stored.contains_key("weightLayout");
    if !(want_kv || want_weights) || stored.get("readable") != Some(&Value::Bool(true)) {
        return false;
    }
    // A header without the layout (an image or speech model) stays without
    // it, so it is read once per file version, not on every listing: the
    // listing is polled, and a big vocabulary makes each read up to 16 MiB.
    type FileVersion = (String, u64, Option<SystemTime>);
    static LACKING: LazyLock<Mutex<HashSet<FileVersion>>> = LazyLock::new(Default::default);
    let version = std::fs::metadata(p).ok().map(|m| (p.to_string(), m.len(), m.modified().ok()));
    if let Some(v) = &version
        && LACKING.lock().is_ok_and(|s| s.contains(v))
    {
        return false;
    }
    let Some(meta) = gguf::read_metadata(p) else { return false };
    let lacking = (want_kv && meta.kv_layout.is_none()) || (want_weights && meta.weight_layout.is_none());
    if lacking
        && let Some(v) = version
        && let Ok(mut s) = LACKING.lock()
    {
        s.insert(v);
    }
    let mut changed = false;
    if want_kv && let Some(l) = meta.kv_layout {
        stored.insert("kvLayout".into(), l.to_value());
        changed = true;
    }
    if want_weights && let Some(w) = meta.weight_layout {
        stored.insert("weightLayout".into(), w.to_value());
        changed = true;
    }
    changed
}

/// Which header checks a stored row has been through. Bump it when a check is
/// added (an unknown tensor type and a minimum engine build are the first):
/// rows below it are read once more, and then carry the answer in the index.
const HEADER_CHECKS: u64 = 2;

/// A row described before the header checks existed (or before the latest one)
/// gets their answers once, from its header, and is marked so it is not read
/// again. A file whose header will not read is remembered for this run only, so
/// the polled listing does not reopen it every time (as `add_kv_layout` does).
/// `true` when the row changed.
fn refresh_header_checks(stored: &mut Map<String, Value>, p: &str) -> bool {
    let done = stored.get("headerChecks").and_then(Value::as_u64).is_some_and(|n| n >= HEADER_CHECKS);
    if done || stored.get("readable") != Some(&Value::Bool(true)) {
        return false;
    }
    type FileVersion = (String, u64, Option<SystemTime>);
    static UNREAD: LazyLock<Mutex<HashSet<FileVersion>>> = LazyLock::new(Default::default);
    let version = std::fs::metadata(p).ok().map(|m| (p.to_string(), m.len(), m.modified().ok()));
    if let Some(v) = &version
        && UNREAD.lock().is_ok_and(|s| s.contains(v))
    {
        return false;
    }
    let Some(meta) = gguf::read_metadata(p) else {
        if let Some(v) = version
            && let Ok(mut s) = UNREAD.lock()
        {
            s.insert(v);
        }
        return false;
    };
    put_header_checks(stored, &meta);
    true
}

/// The header-derived facts the engine's load verdict reads, and the mark that says they were read.
fn put_header_checks(row: &mut Map<String, Value>, meta: &GgufMetadata) {
    assign(row, "unknownWeightType", meta.unknown_weight_type.map(|t| num(f64::from(t))));
    assign(row, "minEngineBuild", meta.min_engine_build.map(|b| num(f64::from(b))));
    assign(row, "companion", meta.lora.then(|| lora_companion(meta.adapter_base_repo.as_deref())));
    assign(row, "dependentWeights", (meta.dependent_adapter && !meta.lora).then_some(json!(true)));
    assign(row, "loraBaseRepo", meta.source_repo.as_ref().filter(|_| !meta.dependent_adapter).map(|r| json!(r)));
    row.insert("headerChecks".into(), num(HEADER_CHECKS as f64));
}

fn lora_companion(base_repo: Option<&str>) -> Value {
    match base_repo {
        Some(repo) => json!({ "kind": "lora", "baseRepo": repo }),
        None => json!({ "kind": "lora" }),
    }
}

pub(crate) fn dependent_weights(model: &Value) -> bool {
    model.get("companion").is_some_and(Value::is_object) || model["dependentWeights"] == true
}

/// A file may have changed since its index row was written. Do not turn
/// adapter weights into a standalone launch just because the row is stale.
pub(crate) fn gguf_is_dependent_now(model: &Value) -> bool {
    model["path"]
        .as_str()
        .is_some_and(|p| Path::new(p).is_file() && gguf::read_metadata(p).is_some_and(|m| m.dependent_adapter))
}

pub(crate) fn validate_lora_pair(base: &Value, adapter: &Value) -> Result<String, String> {
    let gguf = |m: &Value| m["format"].is_null() || m["format"] == "gguf";
    if !gguf(base) || !gguf(adapter) {
        return Err(
            "LoRA pairing is supported only for GGUF with llama.cpp; MLX adapters cannot be loaded here.".into()
        );
    }
    if dependent_weights(base)
        || !matches!(base["modality"].as_str(), Some("chat" | "vision" | "embedding"))
        || adapter.pointer("/companion/kind").and_then(Value::as_str) != Some("lora")
    {
        return Err("Choose a standalone GGUF base and a GGUF LoRA adapter from the library.".into());
    }
    let read = |m: &Value| {
        let p = m["path"].as_str()?;
        let file = Path::new(p);
        if !file.is_absolute() || !ends_gguf(p) || !file.is_file() {
            return None;
        }
        gguf::read_metadata(p).map(|meta| (p.to_string(), meta))
    };
    let Some((base_path, base_meta)) = read(base) else { return Err("The base GGUF is not readable.".into()) };
    let Some((adapter_path, adapter_meta)) = read(adapter) else {
        return Err("The adapter GGUF is not readable.".into());
    };
    if base_meta.dependent_adapter
        || !adapter_meta.lora
        || Path::new(&base_path).canonicalize().ok() == Path::new(&adapter_path).canonicalize().ok()
        || test(regex!(r"-\d{5}-of-\d{5}\.gguf$"), &adapter_path)
    {
        return Err("A LoRA load requires one standalone base file and one distinct, unsplit LoRA adapter file.".into());
    }
    let expected = adapter_meta
        .adapter_base_repo
        .as_deref()
        .filter(|repo| adapter.pointer("/companion/baseRepo").and_then(Value::as_str) == Some(*repo));
    let actual = base_meta.source_repo.as_deref().or_else(|| {
        (base["loraBaseRepoFromLayout"] == true)
            .then(|| base["loraBaseRepo"].as_str().and_then(gguf::repo_id))
            .flatten()
    });
    match (expected, actual) {
        (Some(expected), Some(actual)) if expected == actual => {}
        (Some(expected), Some(actual)) => {
            return Err(format!("This adapter requires the exact base repository {expected}, not {actual}."));
        }
        _ => return Err("Cannot verify the exact base repository for this LoRA pair.".into()),
    }
    if base_meta.architecture.is_none() || base_meta.architecture != adapter_meta.architecture {
        return Err("The GGUF LoRA adapter and base architectures do not match.".into());
    }
    if adapter_meta.unknown_weight_type.is_some() {
        return Err("This LoRA adapter uses a weight type not supported by stock llama.cpp.".into());
    }
    Ok(adapter_path)
}

/// Managed downloads and HF snapshots encode the distribution repository, not
/// a guess from the filename, model title or a third-party library's index.
fn layout_repo(root: &Root, p: &str) -> Option<String> {
    if root.is_ollama() {
        return None;
    }
    let parts = rel_parts(&root.path, p);
    let parts: Vec<_> = parts.iter().map(String::as_str).collect();
    if let [kind, dir, _] = parts.as_slice()
        && root.managed
        && matches!(*kind, "chat" | "vision" | "embedding" | "image" | "audio" | "draft" | "unknown")
    {
        let (owner, repo) = dir.split_once('_')?;
        // The managed folder scheme replaces the original slash with '_'.
        // Do not reverse an encoding with more than one possible split.
        if repo.contains('_')
            || !Path::new(p)
                .canonicalize()
                .ok()?
                .starts_with(Path::new(&root.path).join(kind).join(dir).canonicalize().ok()?)
        {
            return None;
        }
        let id = format!("{owner}/{repo}");
        return gguf::repo_id(&id).map(str::to_string);
    }
    hf_snapshot_repo(p)
}

fn hf_snapshot_repo(p: &str) -> Option<String> {
    let file = Path::new(p);
    let snapshot = file.parent()?;
    let snapshots = snapshot.parent()?;
    let cache = snapshots.parent()?;
    if snapshots.file_name()?.to_str()? != "snapshots" {
        return None;
    }
    let revision = snapshot.file_name()?.to_str()?;
    if revision.len() != 40 || !revision.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let resolved = file.canonicalize().ok()?;
    if !resolved.starts_with(snapshot.canonicalize().ok()?) && !resolved.starts_with(cache.join("blobs")) {
        return None;
    }
    let (owner, repo) = cache.file_name()?.to_str()?.strip_prefix("models--")?.split_once("--")?;
    let id = format!("{owner}/{repo}");
    gguf::repo_id(&id).map(str::to_string)
}

fn add_layout_repo(row: &mut Map<String, Value>, root: &Root, p: &str) {
    if !row.contains_key("loraBaseRepo")
        && row.get("readable") == Some(&json!(true))
        && !row.contains_key("companion")
        && !row.contains_key("dependentWeights")
        && let Some(repo) = layout_repo(root, p)
    {
        row.insert("loraBaseRepo".into(), json!(repo));
        row.insert("loraBaseRepoFromLayout".into(), json!(true));
    }
}

/// Rows indexed when an unknown `general.file_type` was shown as `type 143`:
/// take the quant from the file name, or show none.
fn refresh_quantization(p: &str, stored: &mut Map<String, Value>) -> bool {
    let raw = stored.get("quantization").and_then(Value::as_str).is_some_and(|q| {
        q.strip_prefix("type ").is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
    });
    if !raw {
        return false;
    }
    let from_name = gguf::quant_from_file_name(strip_gguf(&path::basename(p)));
    assign(stored, "quantization", from_name.map(Value::String));
    true
}

/// Read one file's header into a library row (`describe`).
fn describe(root: &Root, p: &str, name: Option<&str>, now: f64) -> Map<String, Value> {
    let meta = gguf::read_metadata(p);
    describe_with(root, p, name, meta.as_ref(), now)
}

fn describe_with(
    root: &Root,
    p: &str,
    name: Option<&str>,
    meta: Option<&GgufMetadata>,
    now: f64,
) -> Map<String, Value> {
    let file = path::basename(p);
    let id = match name.filter(|n| !n.is_empty()) {
        Some(n) => format!("{}/{n}", root.id_str()),
        None => id_for(root, p),
    };
    let meta_name =
        meta.and_then(|m| m.name.as_deref()).map(nekko_js::trim).filter(|n| !n.is_empty() && !is_generic_name(n));
    let shown =
        name.filter(|n| !n.is_empty()).or(meta_name).map_or_else(|| strip_gguf(&file).to_string(), str::to_string);
    let typed = root.managed
        && test(
            regex!(r"^(chat|vision|embedding|image|audio|draft|unknown)$"),
            &rel_parts(&root.path, p).first().cloned().unwrap_or_default(),
        );
    let mut m = Map::new();
    m.insert("id".into(), json!(id));
    m.insert("name".into(), json!(shown));
    m.insert("file".into(), json!(p));
    let source_repo = if typed { repo_from_typed_path(&root.path, p) } else { lmstudio_repo(root, p, &shown) };
    put(&mut m, "sourceRepo", source_repo.map(Value::String));
    m.insert("folderId".into(), root.id.clone());
    put(&mut m, "folderProvider", root.provider.clone());
    // A header without a known `general.file_type` still has its file name's quant (`...-PTQ1_0`).
    let quantization =
        meta.and_then(|m| m.quantization.clone()).or_else(|| gguf::quant_from_file_name(strip_gguf(&file)));
    put(&mut m, "quantization", quantization.filter(|_| meta.is_some()).map(Value::String));
    put(&mut m, "parameterSize", meta.and_then(|m| m.parameter_size.clone()).map(Value::String));
    put(&mut m, "architecture", meta.and_then(|m| m.architecture.clone()).map(Value::String));
    put(&mut m, "layers", meta.and_then(|m| m.layers).map(num));
    put(&mut m, "kvHeads", meta.and_then(|m| m.kv_heads).map(num));
    put(&mut m, "headDim", meta.and_then(|m| m.head_dim).map(num));
    put(&mut m, "maxContext", meta.and_then(|m| m.max_context).map(num));
    put(&mut m, "kvLayout", meta.and_then(|m| m.kv_layout).map(|l| l.to_value()));
    put(&mut m, "weightLayout", meta.and_then(|m| m.weight_layout).map(|w| w.to_value()));
    m.insert("hasChatTemplate".into(), json!(meta.is_some_and(|m| m.chat_template.is_some())));
    m.insert("readable".into(), json!(meta.is_some()));
    if let Some(meta) = meta {
        put_header_checks(&mut m, meta);
    }
    m.insert("addedAt".into(), num(now));
    m
}

/* ---------------------------------------------------------------- Ollama */

/// One model Ollama has pulled: its `ollama run` name and the weights blob.
pub struct OllamaModel {
    pub name: String,
    pub path: String,
    pub size: f64,
    manifest: String,
}

/// Every model in an Ollama store, read from its manifests (`listOllamaModels`).
pub fn list_ollama(root: &str) -> Vec<OllamaModel> {
    let manifest_root = path::join(&[root, "manifests"]);
    let blob_root = path::join(&[root, "blobs"]);
    if !is_dir(&manifest_root) || !is_dir(&blob_root) {
        return Vec::new();
    }
    fn walk(dir: &str, depth: u32, out: &mut Vec<String>) {
        // `<registry>/<namespace>/<model>/<tag>` is as deep as Ollama goes.
        if depth > 4 {
            return;
        }
        let Ok(entries) = nodefs::read_dir(dir) else { return };
        for entry in entries {
            let full = path::join(&[dir, &entry.name]);
            if entry.is_dir {
                walk(&full, depth + 1, out);
            } else if entry.is_file {
                out.push(full);
            }
        }
    }
    let mut files = Vec::new();
    walk(&manifest_root, 0, &mut files);
    let mut out = Vec::new();
    for file in files {
        let Some(manifest) = read_json(&file) else { continue };
        let digest = manifest
            .get("layers")
            .and_then(Value::as_array)
            .and_then(|l| l.iter().find(|l| l.get("mediaType").and_then(Value::as_str) == Some(OLLAMA_MODEL_LAYER)))
            .and_then(|l| l.get("digest"))
            .and_then(Value::as_str)
            .filter(|d| !d.is_empty());
        let Some(digest) = digest else { continue };
        let blob = path::join(&[&blob_root, &digest.replacen(':', "-", 1)]);
        let size = size_of(&blob);
        if size == 0.0 {
            continue;
        }
        out.push(OllamaModel { name: ollama_name(&manifest_root, &file), path: blob, size, manifest: file });
    }
    out.sort_by(|a, b| nekko_js::locale_compare(&a.name, &b.name));
    out
}

/// The manifest path back into the name `ollama run` takes (`modelName`).
pub fn ollama_name(manifest_root: &str, file: &str) -> String {
    let units: Vec<u16> = file.encode_utf16().collect();
    let skip = manifest_root.encode_utf16().count() + 1;
    let rel = String::from_utf16_lossy(units.get(skip..).unwrap_or_default()).replace('\\', "/");
    let mut parts: Vec<&str> = rel.split('/').filter(|p| !p.is_empty()).collect();
    let tag = parts.pop().unwrap_or("latest").to_string();
    if matches!(parts.first(), Some(&"registry.ollama.ai") | Some(&"ollama.com")) {
        parts.remove(0);
    }
    if parts.first() == Some(&"library") {
        parts.remove(0);
    }
    format!("{}:{tag}", parts.join("/"))
}

/// `JSON.parse(await readFile(p, 'utf8'))`, or `None`.
fn read_json(p: &str) -> Option<Value> {
    let bytes = std::fs::read(p).ok()?;
    serde_json::from_str(&String::from_utf8_lossy(&bytes)).ok().map(nekko_js::js_order)
}

/* ------------------------------------------------------------------- MLX */

/// What an MLX model folder is (`MlxModelInfo`).
pub struct MlxInfo {
    pub architecture: Option<String>,
    pub quantization: Option<String>,
    pub max_context: Option<Value>,
    pub kv_bytes_per_token: Option<u64>,
    pub vision: bool,
    pub dflash2: bool,
    companion: Option<Value>,
    dependent_weights: bool,
    pub size: f64,
}

/// The payload of one cached token in a dense Llama MLX model. The stock
/// mlx_lm server uses unquantized keys/values in the model's activation dtype.
/// Other layouts (including hybrid attention and vision) aren't modeled here.
fn mlx_kv_bytes_per_token(config: &Value) -> Option<u64> {
    if config.get("model_type")?.as_str()? != "llama"
        || ["vision_config", "text_config", "layer_types", "sliding_window", "use_sliding_window", "kv_quantization"]
            .iter()
            .any(|key| config.get(key).is_some_and(|v| !v.is_null() && v != &json!(false)))
    {
        return None;
    }
    let dtype = config.get("dtype").filter(|v| !v.is_null()).or_else(|| config.get("torch_dtype"))?;
    if !matches!(dtype.as_str()?, "float16" | "bfloat16") {
        return None;
    }
    let n = |key| config.get(key)?.as_u64().filter(|n| *n > 0);
    let heads = n("num_attention_heads")?;
    let kv_heads = n("num_key_value_heads")?;
    if !heads.is_multiple_of(kv_heads) {
        return None;
    }
    let dim = if config.get("head_dim").is_some_and(|v| !v.is_null()) {
        n("head_dim")?
    } else {
        let hidden = n("hidden_size")?;
        if !hidden.is_multiple_of(heads) {
            return None;
        }
        hidden / heads
    };
    // Two tensors, two bytes per element. Don't let corrupt metadata overflow.
    4u64.checked_mul(n("num_hidden_layers")?)?.checked_mul(kv_heads)?.checked_mul(dim)
}

/// Whether a directory is an MLX model, and what it is (`readMlxModel`): a
/// `config.json` beside `.safetensors` weights, plus MLX's quantization block,
/// `mlx` in the folder/publisher name, or the DFlash2 draft architecture that
/// mlx-vlm can load directly.
pub fn read_mlx_model(dir: &str) -> Option<MlxInfo> {
    let entries: Vec<String> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    let weights: Vec<&String> = entries.iter().filter(|e| lower(e).ends_with(".safetensors")).collect();
    let adapter_config = path::join(&[dir, "adapter_config.json"]);
    let adapter_weights =
        weights.iter().any(|w| matches!(lower(w).as_str(), "adapters.safetensors" | "adapter_model.safetensors"));
    if adapter_weights || (!weights.is_empty() && Path::new(&adapter_config).is_file()) {
        let config = read_json(&adapter_config).unwrap_or_default();
        let kind = config["fine_tune_type"].as_str().or_else(|| config["peft_type"].as_str());
        let lora = kind.map_or(adapter_weights, |k| k.eq_ignore_ascii_case("lora"));
        let base_repo = config["base_model_name_or_path"].as_str().and_then(gguf::repo_id);
        return Some(MlxInfo {
            architecture: None,
            quantization: None,
            max_context: None,
            kv_bytes_per_token: None,
            vision: false,
            dflash2: false,
            companion: lora.then(|| lora_companion(base_repo)),
            dependent_weights: !lora,
            size: weights.iter().map(|w| size_of(&path::join(&[dir, w]))).sum(),
        });
    }
    if !entries.iter().any(|e| e == "config.json") || weights.is_empty() {
        return None;
    }
    let config = read_json(&path::join(&[dir, "config.json"]))?;
    // `null.quantization` throws in the TS, which fails the whole listing; here it is skipped.
    if config.is_null() {
        return None;
    }
    let field = |v: &Value, k: &str| v.as_object().and_then(|o| o.get(k)).cloned();
    let quant =
        field(&config, "quantization").filter(|q| !q.is_null()).or_else(|| field(&config, "quantization_config"));
    let mlx_quant = quant.as_ref().filter(|q| nekko_js::truthy(Some(q))).is_some_and(|q| {
        field(q, "group_size").is_some_and(|g| g.is_number()) && field(q, "bits").is_some_and(|b| b.is_number())
    });
    let near: Vec<&str> = dir.split(['\\', '/']).filter(|s| !s.is_empty()).collect();
    let near = near[near.len().saturating_sub(2)..].join("/");
    let dflash2 = is_dflash2_config(&config);
    if !dflash2 && !mlx_quant && !test(regex!("mlx"), &near) {
        return None;
    }
    let size = weights.iter().map(|w| size_of(&path::join(&[dir, w]))).sum();
    let text = field(&config, "text_config").filter(|t| !t.is_null()).unwrap_or_else(|| json!({}));
    let max = field(&config, "max_position_embeddings")
        .filter(|m| !m.is_null())
        .or_else(|| field(&text, "max_position_embeddings"));
    Some(MlxInfo {
        architecture: field(&config, "model_type").and_then(|t| t.as_str().map(str::to_string)),
        quantization: if mlx_quant {
            quant
                .as_ref()
                .and_then(|q| field(q, "bits"))
                .and_then(|b| b.as_f64())
                .map(|b| format!("{}-bit", nekko_js::number_to_string(b)))
        } else {
            None
        },
        max_context: max.filter(Value::is_number),
        kv_bytes_per_token: mlx_kv_bytes_per_token(&config),
        vision: nekko_js::truthy(field(&config, "vision_config").as_ref()),
        dflash2,
        companion: None,
        dependent_weights: false,
        size,
    })
}

fn is_dflash2_config(config: &Value) -> bool {
    config.get("model_type").and_then(Value::as_str) == Some("dflash2")
        || config
            .get("architectures")
            .and_then(Value::as_array)
            .is_some_and(|a| a.iter().any(|v| v == "DFlash2DraftModel"))
}

/// Only the published stock Qwen3.8-27B pair is supported. The target shares
/// its architecture with other Qwen releases, so require a stock checkpoint
/// directory/repo name as well as the geometry specified by the head.
pub(crate) fn validate_mlx_dflash2_pair(target: &str, draft: &str) -> bool {
    let target_path = std::path::Path::new(target);
    let stock = |name: &str| {
        matches!(
            name,
            "Qwen3.8-27B" | "Qwen3.8-27B-4bit" | "Qwen3.8-27B-8bit" | "Qwen3.8-27B-MLX-8bit" | "Qwen3.8-27B-bf16"
        )
    };
    let named_stock = target_path.file_name().and_then(|n| n.to_str()).is_some_and(|name| {
        // Managed downloads use `<owner>_<repo>` instead of `<owner>/<repo>`.
        stock(name.strip_prefix("mlx-community_").unwrap_or(name))
    }) || target_path
        .parent()
        .filter(|p| p.ends_with("snapshots"))
        .and_then(|p| p.parent())
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .and_then(|n| n.strip_prefix("models--mlx-community--"))
        .is_some_and(stock);
    let (Some(target), Some(draft)) =
        (read_json(&path::join(&[target, "config.json"])), read_json(&path::join(&[draft, "config.json"])))
    else {
        return false;
    };
    let text = &target["text_config"];
    let head = &draft["dflash_config"];
    named_stock
        && target["model_type"] == "qwen3_5"
        && target["vision_config"].is_object()
        && text["hidden_size"] == 5120
        && text["num_hidden_layers"] == 64
        && text["vocab_size"] == 248320
        && is_dflash2_config(&draft)
        && draft["hidden_size"] == text["hidden_size"]
        && draft["num_target_layers"] == text["num_hidden_layers"]
        && draft["vocab_size"] == text["vocab_size"]
        && head["target_layer_ids"] == json!([5, 19, 33, 47, 61])
        && head["mask_token_id"] == 248070
        && head["block_size"] == 8
        && head["conv_kernel_size"] == 2
        && head["conv_group_size"] == 16
        && head["selector_rank"] == 256
        && head["selector_top_k"] == 16
}

/// MLX model folders under one root; a folder that is a model is not descended into.
fn scan_mlx_folder(root: &Root) -> Vec<(String, MlxInfo)> {
    fn walk(dir: &str, depth: u32, max: u32, out: &mut Vec<(String, MlxInfo)>) {
        let Ok(entries) = nodefs::read_dir(dir) else { return };
        if entries.iter().any(|e| {
            e.is_file
                && matches!(
                    e.name.as_str(),
                    "config.json" | "adapter_config.json" | "adapters.safetensors" | "adapter_model.safetensors"
                )
        }) && let Some(info) = read_mlx_model(dir)
        {
            out.push((dir.to_string(), info));
            return;
        }
        if depth >= max {
            return;
        }
        for entry in entries {
            if !entry.is_dir || entry.name == "blobs" || entry.name == ".companions" {
                continue;
            }
            walk(&path::join(&[dir, &entry.name]), depth + 1, max, out);
        }
    }
    let mut out = Vec::new();
    walk(&root.path, 0, if root.managed { 3 } else { 5 }, &mut out);
    out
}

/* ---------------------------------------------------------------- index */

/// `library.json`: `{ models: { [id]: row } }` plus whatever else it held.
struct Index {
    doc: Map<String, Value>,
}

impl Index {
    fn read(cfg: &LibraryConfig) -> Index {
        let fresh = || {
            let mut doc = Map::new();
            doc.insert("models".into(), json!({}));
            Index { doc }
        };
        match read_json(&cfg.index_path()) {
            Some(Value::Object(doc)) if doc.get("models").is_some_and(Value::is_object) => Index { doc },
            _ => fresh(),
        }
    }

    fn models(&mut self) -> &mut Map<String, Value> {
        match self.doc.get_mut("models") {
            Some(Value::Object(m)) => m,
            _ => unreachable!("an index always holds a models object"),
        }
    }

    fn write(&self, cfg: &LibraryConfig) -> Result<(), String> {
        nodefs::mkdir_p(&cfg.models_dir)?;
        let text = nekko_js::stringify_pretty(&nekko_js::js_order(Value::Object(self.doc.clone())), "  ");
        let target = cfg.index_path();
        nekko_js::fs::atomic_write(std::path::Path::new(&target), text.as_bytes(), Default::default())
            .map_err(|e| e.to_string())
    }
}

/* --------------------------------------------------------------- library */

/// Give a row an id no earlier row took: a model id is also an API model
/// name, so it has to stay unique (`-2`, `-3`, ... on a collision).
fn claim(stored: &mut Map<String, Value>, seen_ids: &mut HashSet<String>) -> String {
    let base = stored.get("id").map(nekko_js::display).unwrap_or_default();
    let mut id = base.clone();
    let mut n = 2;
    while seen_ids.contains(&id) {
        id = format!("{base}-{n}");
        n += 1;
    }
    if id != base {
        stored.insert("id".into(), json!(id));
    }
    seen_ids.insert(id.clone());
    id
}

/// The library, reconciled against disk (`list`): rows sorted by name.
pub fn list(cfg: &LibraryConfig) -> Result<Vec<Value>, String> {
    let mut index = Index::read(cfg);
    let mut by_file: HashMap<String, Map<String, Value>> = HashMap::new();
    for stored in index.models().values() {
        if let (Some(file), Some(obj)) = (stored.get("file").and_then(Value::as_str), stored.as_object()) {
            by_file.insert(file.to_string(), obj.clone());
        }
    }
    let roots = cfg.roots();
    let primary = &roots[0];
    // File imports adopt the file in place. They have a primary index row
    // but are not found by walking the managed models folder.
    let mut imports: Vec<_> = by_file
        .iter()
        .filter(|(file, stored)| {
            stored.get("folderId") == Some(&primary.id)
                && ends_gguf(file)
                && !later_shard(file)
                && !is_projector(file)
                && {
                    let rel = path::relative(&primary.path, file);
                    std::path::Path::new(&rel).is_absolute() || rel.split(SEP).next() == Some("..")
                }
        })
        .map(|(file, _)| (file.clone(), None))
        .collect();
    imports.sort();
    let mut out: Vec<Map<String, Value>> = Vec::new();
    let mut seen_ids: HashSet<String> = HashSet::new();
    let mut seen_paths: HashSet<String> = HashSet::new();
    let mut dirty = false;

    // Directories holding a projector, and models whose fetched sidecars include one.
    let mut projector_dirs: HashSet<String> = HashSet::new();
    let mut companion_ids: HashSet<String> = HashSet::new();
    for root in &roots {
        if root.is_ollama() {
            continue;
        }
        for p in scan_folder(root) {
            if is_projector(&p) {
                projector_dirs.insert(lower(&path::dirname(&p)));
            }
        }
    }
    let fetched = path::join(&[&cfg.models_dir, ".companions"]);
    if let Ok(keys) = std::fs::read_dir(&fetched) {
        for key in keys.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()) {
            let files = std::fs::read_dir(path::join(&[&fetched, &key]))
                .map(|r| {
                    r.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if files.iter().any(|f| test(regex!("mmproj"), f) && ends_gguf(f)) {
                companion_ids.insert(key);
            }
        }
    }

    for root in &roots {
        let mut files: Vec<(String, Option<String>)> = if root.is_ollama() {
            list_ollama(&root.path).into_iter().map(|m| (m.path, Some(m.name))).collect()
        } else {
            scan_folder(root).into_iter().filter(|p| !later_shard(p) && !is_projector(p)).map(|p| (p, None)).collect()
        };
        if root.managed {
            files.append(&mut imports);
        }
        for (p, name) in files {
            if seen_paths.contains(&lower(&p)) {
                continue;
            }
            let size = size_of(&p);
            if size == 0.0 {
                continue;
            }
            seen_paths.insert(lower(&p));
            let mut stored = match by_file.get(&p) {
                Some(s) if s.get("folderId") == Some(&root.id) => s.clone(),
                _ => {
                    dirty = true;
                    describe(root, &p, name.as_deref(), cfg.now)
                }
            };
            dirty |= add_kv_layout(&mut stored, &p);
            dirty |= refresh_header_checks(&mut stored, &p);
            dirty |= refresh_naming(root, &p, &mut stored);
            dirty |= refresh_quantization(&p, &mut stored);
            let id = claim(&mut stored, &mut seen_ids);
            index.models().insert(id, Value::Object(stored.clone()));
            let mut row = stored;
            // Index bookkeeping, not a fact about the model.
            row.shift_remove("headerChecks");
            add_layout_repo(&mut row, root, &p);
            row.insert("path".into(), json!(p));
            row.insert("sizeBytes".into(), num(size));
            row.insert("managed".into(), json!(root.managed));
            row.insert("folderId".into(), root.id.clone());
            assign(&mut row, "folderProvider", root.provider.clone());
            out.push(row);
        }
    }

    // MLX model folders: rows of their own, runnable on an Apple Silicon Mac.
    for root in &roots {
        if root.is_ollama() {
            continue;
        }
        for (dir, info) in scan_mlx_folder(root) {
            if !seen_paths.insert(lower(&dir)) {
                continue;
            }
            let mut stored = match by_file.get(&dir) {
                Some(s) if s.get("folderId") == Some(&root.id) => s.clone(),
                _ => {
                    dirty = true;
                    let mut m = Map::new();
                    m.insert("id".into(), json!(id_for(root, &dir)));
                    m.insert("name".into(), json!(path::basename(&dir)));
                    m.insert("file".into(), json!(dir));
                    m.insert("format".into(), json!("mlx"));
                    m.insert("folderId".into(), root.id.clone());
                    put(&mut m, "folderProvider", root.provider.clone());
                    put(&mut m, "architecture", info.architecture.clone().map(Value::String));
                    put(&mut m, "quantization", info.quantization.clone().map(Value::String));
                    put(&mut m, "maxContext", info.max_context.clone());
                    m.insert("readable".into(), json!(true));
                    m.insert("addedAt".into(), num(cfg.now));
                    m
                }
            };
            let id = claim(&mut stored, &mut seen_ids);
            index.models().insert(id, Value::Object(stored.clone()));
            let mut row = stored;
            row.insert("path".into(), json!(dir));
            row.insert("sizeBytes".into(), num(info.size));
            row.insert("managed".into(), json!(root.managed));
            row.insert("folderId".into(), root.id.clone());
            assign(&mut row, "folderProvider", root.provider.clone());
            assign(&mut row, "companion", info.companion);
            assign(&mut row, "dependentWeights", info.dependent_weights.then_some(json!(true)));
            let modality = if row.contains_key("companion") || info.dependent_weights {
                "unknown"
            } else if info.dflash2 {
                "draft"
            } else if info.vision {
                "vision"
            } else {
                "chat"
            };
            row.insert("modality".into(), json!(modality));
            row.insert("hasProjector".into(), json!(info.vision && !info.dflash2));
            row.insert("mlxRunnable".into(), json!(cfg.mlx_runnable));
            // Live metadata: existing index rows get this without a rescan/migration.
            put(&mut row, "mlxKvBytesPerToken", info.kv_bytes_per_token.map(|bytes| json!(bytes)));
            out.push(row);
        }
    }

    // Live modality facts: what kind of model this is, and whether a vision
    // model's projector is actually there.
    for row in &mut out {
        if row.get("format").and_then(Value::as_str) == Some("mlx") {
            continue;
        }
        let id = row.get("id").map(nekko_js::display).unwrap_or_default();
        let p = row.get("path").and_then(Value::as_str).unwrap_or_default();
        let has = projector_dirs.contains(&lower(&path::dirname(p))) || companion_ids.contains(&companions_key(&id));
        row.insert("hasProjector".into(), json!(has));
        let name = format!("{id} {}", row.get("name").map(nekko_js::display).unwrap_or_default());
        let modality = if row.contains_key("companion") || row.contains_key("dependentWeights") {
            "unknown"
        } else {
            row_modality(row, &name)
        };
        row.insert("modality".into(), json!(modality));
    }

    // Drop rows whose file is gone. A row for a folder that is merely
    // switched off stays: its file is still there.
    let stale: Vec<String> = index
        .models()
        .iter()
        .filter(|(id, _)| !seen_ids.contains(*id))
        .filter(|(_, stored)| {
            let file = stored.get("file").and_then(Value::as_str).unwrap_or_default();
            seen_paths.contains(&lower(file)) || !exists(file)
        })
        .map(|(id, _)| id.clone())
        .collect();
    for id in stale {
        index.models().shift_remove(&id);
        dirty = true;
    }
    if dirty {
        index.write(cfg)?;
    }
    out.sort_by(|a, b| {
        let name = |m: &Map<String, Value>| m.get("name").map(nekko_js::display).unwrap_or_default();
        nekko_js::locale_compare(&name(a), &name(b))
    });
    Ok(out.into_iter().map(Value::Object).collect())
}

/// One row by id (`find`).
pub fn find(cfg: &LibraryConfig, id: &str) -> Result<Option<Value>, String> {
    Ok(list(cfg)?.into_iter().find(|m| m.get("id").and_then(Value::as_str) == Some(id)))
}

fn reply(ok: bool, message: String) -> Value {
    json!({ "ok": ok, "message": message })
}

/// Adopt a GGUF that lives somewhere else, without copying it (`importFile`).
pub fn import_file(cfg: &LibraryConfig, p: &str) -> Result<Value, String> {
    let p = path::resolve(&[p]);
    let p = p.as_str();
    let size = size_of(p);
    if size == 0.0 {
        return Ok(reply(false, "That file does not exist.".into()));
    }
    if !ends_gguf(p) {
        return Ok(reply(false, "Nekko Agent runs GGUF files. Convert or download a GGUF build of this model.".into()));
    }
    let Some(meta) = gguf::read_metadata(p) else {
        return Ok(reply(false, "That file isn't a readable GGUF.".into()));
    };
    let mut index = Index::read(cfg);
    let primary = cfg.roots().remove(0);
    let mut stored = describe_with(&primary, p, None, Some(&meta), cfg.now);
    let mut taken = HashSet::new();
    for (id, row) in index.models().iter() {
        if row.get("file").and_then(Value::as_str) == Some(p) && row.get("folderId") == Some(&primary.id) {
            stored.insert("id".into(), json!(id));
            if let Some(preset) = row.get("preset") {
                stored.insert("preset".into(), preset.clone());
            }
        } else {
            taken.insert(id.clone());
        }
    }
    let id = claim(&mut stored, &mut taken);
    index.models().insert(id, Value::Object(stored.clone()));
    index.write(cfg)?;
    let mut model = stored.clone();
    model.shift_remove("headerChecks");
    add_layout_repo(&mut model, &primary, p);
    model.insert("path".into(), json!(p));
    model.insert("sizeBytes".into(), num(size));
    model.insert("managed".into(), json!(true));
    let name = stored.get("name").map(nekko_js::display).unwrap_or_default();
    Ok(json!({ "ok": true, "message": format!("Added {name}."), "model": model }))
}

/// A later shard or the projector of the same model (`isCompanionOf`).
fn is_companion_of(candidate: &str, primary: &str) -> bool {
    if candidate == primary {
        return false;
    }
    let stem = match regex!(r"-00001-of-\d{5}\.gguf$").find(primary) {
        Some(m) => &primary[..m.start()],
        None => strip_gguf(primary),
    };
    (candidate.starts_with(stem) && test(regex!(r"(-\d{5}-of-\d{5}\.gguf|mmproj.*\.gguf)$"), candidate))
        || candidate == format!("{stem}.chat_template.jinja")
}

/// Windows refuses to delete a file another process has open: a sharing
/// (32) or lock (33) violation. Other systems delete open files.
fn in_use(e: &std::io::Error) -> bool {
    cfg!(windows) && matches!(e.raw_os_error(), Some(32 | 33))
}

/// Only unlink entries whose parent stays in the selected model root. A
/// symlink to a weight can be unlinked without touching its shared target.
fn checked_entry(root: &Path, entry: &Path) -> Result<PathBuf, String> {
    let refused = || "Cannot safely delete these linked model files. Use the app that downloaded them.".to_string();
    let rel = entry.strip_prefix(root).map_err(|_| refused())?;
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let parent = root.join(rel.parent().ok_or_else(refused)?);
    if parent.canonicalize().map_err(|e| e.to_string())? != parent {
        return Err(refused());
    }
    let entry = root.join(rel);
    let metadata = std::fs::symlink_metadata(&entry).map_err(|e| e.to_string())?;
    if !(metadata.is_file() || metadata.file_type().is_symlink()) {
        return Err(refused());
    }
    Ok(entry)
}

/// A stale or missing confirmation may not unload or delete an external model.
pub fn can_delete(model: &Value, confirmed_path: Option<&str>) -> bool {
    (model.get("managed") != Some(&Value::Bool(false)) && model["format"] != "mlx")
        || confirmed_path.is_some_and(|p| model["path"].as_str() == Some(p))
}

/// Delete the selected model; do not mutate another app's shared sidecars.
pub fn remove(cfg: &LibraryConfig, id: &str, confirmed_path: Option<&str>) -> Result<Value, String> {
    let Some(model) = find(cfg, id)? else {
        return Ok(reply(false, "That model is not in the library.".into()));
    };
    let name = model.get("name").map(nekko_js::display).unwrap_or_default();
    let model_path = model.get("path").and_then(Value::as_str).unwrap_or_default();
    let external = model.get("managed") == Some(&Value::Bool(false));
    let mlx = model.get("format").and_then(Value::as_str) == Some("mlx");
    if !can_delete(&model, confirmed_path) {
        return Ok(reply(false, format!("Confirm the current location of {name} before deleting it.")));
    }
    let roots = cfg.roots();
    let mut manifest_only = false;
    let files = if external || mlx {
        let location = Path::new(model_path);
        let Some(root) =
            roots.iter().find(|root| model.get("folderId") == Some(&root.id) && location.starts_with(&root.path))
        else {
            return Ok(reply(false, "The model folder has changed. Refresh the library and try again.".into()));
        };
        let dir = Path::new(&root.path);
        if root.is_ollama() {
            // An Ollama tag may share every blob with other tags.
            let Some(entry) =
                list_ollama(&root.path).into_iter().find(|entry| entry.path == model_path && entry.name == name)
            else {
                return Ok(reply(false, "The Ollama tag has changed. Refresh the library and try again.".into()));
            };
            manifest_only = true;
            vec![checked_entry(dir, Path::new(&entry.manifest))?]
        } else if mlx {
            // The model is discoverable only with weights present. Leave the
            // directory, non-weight files, and any shared blob targets alone.
            let entries = std::fs::read_dir(location)
                .and_then(Iterator::collect::<Result<Vec<_>, _>>)
                .map_err(|e| e.to_string())?;
            entries
                .into_iter()
                .map(|entry| entry.path())
                .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("safetensors")))
                .map(|p| checked_entry(dir, &p))
                .collect::<Result<Vec<_>, _>>()?
        } else {
            let mut files = vec![checked_entry(dir, location)?];
            if let Some(split) = regex!(r"-00001-of-\d{5}\.gguf$").find(model_path) {
                let stem = &model_path[..split.start()];
                let count = &model_path[split.start() + "-00001-of-".len()..model_path.len() - ".gguf".len()];
                if let Ok(count) = count.parse::<u32>() {
                    for i in 2..=count {
                        let shard = format!("{stem}-{i:05}-of-{count:05}.gguf");
                        match std::fs::symlink_metadata(&shard) {
                            Ok(_) => files.push(checked_entry(dir, Path::new(&shard))?),
                            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                            Err(e) => return Err(e.to_string()),
                        }
                    }
                }
            }
            files
        }
    } else {
        std::iter::once(model_path.to_string())
            .chain(scan_folder(&roots[0]).into_iter().filter(|p| is_companion_of(p, model_path)))
            .map(PathBuf::from)
            .collect()
    };
    // Delete later shards first so a partial failure doesn't hide the row.
    for p in files.iter().rev() {
        // `rm(p, { force: true })`: a missing file is fine, a directory is not.
        match std::fs::symlink_metadata(p) {
            Ok(m) if m.is_dir() => {
                return Err(format!("Path is a directory: rm returned EISDIR (is a directory) {}", p.display()));
            }
            Ok(_) => match std::fs::remove_file(p) {
                Ok(()) => {}
                Err(e) if in_use(&e) => {
                    return Ok(reply(
                        false,
                        format!("{name} is open in another app. Close what is using it, then delete it again."),
                    ));
                }
                Err(e) => return Err(e.to_string()),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    let sidecars = companions_dir(&cfg.models_dir, id);
    if std::fs::symlink_metadata(&sidecars).is_ok() {
        std::fs::remove_dir_all(&sidecars).map_err(|e| e.to_string())?;
    }
    let mut index = Index::read(cfg);
    index.models().shift_remove(id);
    index.write(cfg)?;
    Ok(reply(
        true,
        if manifest_only {
            format!("Removed {name} from Ollama. Shared downloads were kept.")
        } else {
            format!("Deleted {name}.")
        },
    ))
}

/// Save per-model load settings (`savePreset`); an unknown id is ignored.
pub fn save_preset(cfg: &LibraryConfig, id: &str, preset: &Value) -> Result<(), String> {
    let mut index = Index::read(cfg);
    let Some(Value::Object(stored)) = index.models().get_mut(id) else { return Ok(()) };
    // `stored.preset = preset`: an undefined preset is not printed.
    if preset.is_null() {
        stored.insert("preset".into(), Value::Null);
    } else {
        stored.insert("preset".into(), preset.clone());
    }
    index.write(cfg)
}

/// What each configured folder holds (`folderReport`).
pub fn folder_report(cfg: &LibraryConfig) -> Result<Vec<Value>, String> {
    let models = list(cfg)?;
    let mut folders = vec![json!({
        "id": PRIMARY_FOLDER_ID,
        "path": cfg.models_dir,
        "provider": "nekko",
        "enabled": true,
        "primary": true,
    })];
    folders.extend(cfg.folders.iter().cloned());
    Ok(folders
        .into_iter()
        .map(|folder| {
            let id = folder.get("id").cloned().unwrap_or(Value::Null);
            let mine: Vec<&Value> = models.iter().filter(|m| m.get("folderId") == Some(&id)).collect();
            let mut out = match folder {
                Value::Object(m) => m,
                _ => Map::new(),
            };
            let exists = out.get("path").and_then(Value::as_str).is_some_and(exists);
            out.insert("exists".into(), json!(exists));
            out.insert("modelCount".into(), json!(mine.len()));
            let size: f64 = mine.iter().filter_map(|m| m.get("sizeBytes").and_then(Value::as_f64)).sum();
            out.insert("sizeBytes".into(), num(size));
            Value::Object(out)
        })
        .collect())
}

/// How many models a folder would contribute, before anyone adds it (`probe`).
pub fn probe(p: &str, provider: Option<&str>) -> (usize, f64) {
    let root =
        Root { id: json!("probe"), path: path::resolve(&[p]), provider: provider.map(|p| json!(p)), managed: false };
    let files: Vec<String> = if root.is_ollama() {
        list_ollama(&root.path).into_iter().map(|m| m.path).collect()
    } else {
        scan_folder(&root).into_iter().filter(|p| !later_shard(p) && !is_projector(p)).collect()
    };
    let size = files.iter().map(|f| size_of(f)).sum();
    (files.len(), size)
}

/// The folder list with the other apps' folders nobody added yet
/// (`folderReport` in the engine facade): one suggestion per app, the first
/// of its candidates that has models.
pub fn folders_with_suggestions(cfg: &LibraryConfig, candidates: &[Candidate]) -> Result<Value, String> {
    let configured = folder_report(cfg)?;
    let resolved_key = |p: &str| lower(&path::resolve(&[p]));
    let mut taken: HashSet<String> =
        configured.iter().map(|f| resolved_key(f.get("path").and_then(Value::as_str).unwrap_or_default())).collect();
    let mut suggestions = Vec::new();
    for candidate in candidates {
        for p in &candidate.paths {
            if taken.contains(&resolved_key(p)) {
                continue;
            }
            let (count, size) = probe(p, Some(candidate.provider));
            if count == 0 {
                continue;
            }
            taken.insert(resolved_key(p));
            suggestions.push(
                json!({ "provider": candidate.provider, "path": p, "modelCount": count, "sizeBytes": num(size) }),
            );
            break;
        }
    }
    Ok(json!({ "folders": configured, "suggestions": suggestions }))
}

/// The folders a first start adopts (`seedFolderList`): every known folder
/// on this machine with models in it, one per app.
pub fn seed_folder_list(models_dir: &str, candidates: &[Candidate]) -> Vec<Value> {
    let mut found = Vec::new();
    let mut taken = HashSet::from([lower(&path::resolve(&[models_dir]))]);
    for candidate in candidates {
        for p in &candidate.paths {
            let key = lower(&path::resolve(&[p]));
            if taken.contains(&key) || probe(p, Some(candidate.provider)).0 == 0 {
                continue;
            }
            taken.insert(key);
            found.push(known_folder(candidate.provider, p));
            break;
        }
    }
    found
}

/* ------------------------------------------------------------- GPU fit */

/// A library row in the planner's shape (`modelFactsFor`).
pub fn model_facts_for(m: &Value) -> ModelFacts {
    let mut facts = Map::new();
    facts.insert("id".into(), m.get("id").cloned().unwrap_or(Value::Null));
    for (to, from) in [
        ("weightsBytes", "sizeBytes"),
        ("layers", "layers"),
        ("kvHeads", "kvHeads"),
        ("headDim", "headDim"),
        ("maxContext", "maxContext"),
        ("kvLayout", "kvLayout"),
        ("weightLayout", "weightLayout"),
        ("format", "format"),
    ] {
        put(&mut facts, to, m.get(from).cloned());
    }
    ModelFacts::from_value(&Value::Object(facts))
}

/// Where the planner expects a model to run under its preset (`gpuFitFor`):
/// `full`, `partial`, `cpu`, `wont` or `unknown`.
pub fn gpu_fit_for(model: &Value, hw: &Hardware, overhead_floor: Option<f64>) -> &'static str {
    let Some(m) = model.as_object() else { return "unknown" };
    if m.get("format").and_then(Value::as_str) == Some("mlx") {
        return "unknown";
    }
    let modality = match m.get("modality").and_then(Value::as_str) {
        Some(x) => x.to_string(),
        None => row_modality(m, &m.get("name").map(nekko_js::display).unwrap_or_default()).to_string(),
    };
    if !matches!(modality.as_str(), "chat" | "vision" | "embedding") {
        return "unknown";
    }
    let preset = m.get("preset").filter(|p| p.is_object());
    // `preset.x ?? fallback`: absent and `null` both fall back.
    let field = |k: &str| preset.and_then(|p| p.get(k)).filter(|v| !v.is_null());
    let layers = m.get("layers").and_then(Value::as_f64).filter(|l| *l != 0.0 && !l.is_nan());
    // `preset.gpuLayers !== undefined`: a saved `null` counts, as zero layers.
    let fraction = match (preset.and_then(|p| p.get("gpuLayers")), layers) {
        (Some(g), Some(l)) => (nekko_js::to_number(Some(g)) / l).clamp(0.0, 1.0),
        _ => 1.0,
    };
    let req = FitRequest {
        context_tokens: field("contextTokens").map_or_else(
            || default_context_tokens(m.get("maxContext").and_then(Value::as_f64)),
            |v| nekko_js::to_number(Some(v)),
        ),
        parallel_slots: field("parallelSlots").map_or(1.0, |v| nekko_js::to_number(Some(v))),
        kv_cache_dtype: crate::launch::effective_kv(preset.unwrap_or(&Value::Null)),
        gpu_layer_fraction: fraction,
    };
    let plan =
        capacity::compute_fit(&model_facts_for(model), &req, hw, &PlanOptions { overhead_floor, siblings: Vec::new() });
    match plan.verdict {
        "unknown" => "unknown",
        "wont-load" => "wont",
        _ if hw.devices.is_empty() => "cpu",
        v if v == "spills" || fraction < 1.0 => "partial",
        _ => "full",
    }
}

/// `gpu_fit_for` on the same card with nothing else holding it: every device's
/// free memory is its total less the desktop reserve. `None` where that idea
/// does not apply (unified memory, or no GPU).
pub fn gpu_fit_idle_for(model: &Value, hw: &Hardware, overhead_floor: Option<f64>) -> Option<&'static str> {
    if hw.unified || hw.devices.is_empty() {
        return None;
    }
    let mut idle = hw.clone();
    for d in &mut idle.devices {
        d.free = (d.total - capacity::DESKTOP_GPU_RESERVE_BYTES).max(0.0);
    }
    Some(gpu_fit_for(model, &idle, overhead_floor))
}

/// `engine:models`: the library with load state, the last failure, what the
/// engine in use makes of each file (`loadCheck`, see [`crate::load_check`]) and
/// the GPU-fit verdict folded in. `hw` is `None` when no GPU probe answered.
/// A file the engine cannot load gets no fit: where it would sit is moot.
pub fn with_load_state(
    rows: Vec<Value>,
    loaded: &HashSet<String>,
    errors: &Map<String, Value>,
    hw: Option<&Hardware>,
    overhead_floor: Option<f64>,
    engine: &EngineInUse,
) -> Vec<Value> {
    rows.into_iter()
        .map(|row| {
            let id = row.get("id").map(nekko_js::display).unwrap_or_default();
            // The llama.cpp rules do not apply to an image or MLX model: the
            // server's load gate skips them too, so the row must not claim them.
            let llama = row.get("modality").and_then(Value::as_str) != Some("image")
                && row.get("format").and_then(Value::as_str) != Some("mlx");
            let check = llama.then(|| load_check(&row, engine)).flatten();
            let meets_min = llama.then(|| engine_meets_min_build(&row, engine)).flatten();
            let blocked = check.as_ref().is_some_and(LoadCheck::blocked);
            let fit = hw.filter(|_| !blocked).map(|hw| gpu_fit_for(&row, hw, overhead_floor));
            let idle = hw.filter(|_| fit == Some("partial")).and_then(|hw| gpu_fit_idle_for(&row, hw, overhead_floor));
            let mut m = match row {
                Value::Object(m) => m,
                _ => Map::new(),
            };
            m.insert("loaded".into(), json!(loaded.contains(&id)));
            assign(&mut m, "lastLoadError", errors.get(&id).filter(|e| !e.is_null()).cloned());
            assign(&mut m, "gpuFit", fit.map(|f| json!(f)));
            // A partial fit may only be the card being busy: say whether it
            // would fit with the card to itself.
            assign(&mut m, "gpuFitIdle", idle.map(|f| json!(f)));
            assign(&mut m, "loadCheck", check.map(|c| c.to_value()));
            assign(&mut m, "engineMeetsMinBuild", meets_min.map(Value::Bool));
            Value::Object(m)
        })
        .collect()
}
