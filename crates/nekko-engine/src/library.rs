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
use crate::num;
use nekko_tools::nodefs;
use nekko_tools::path::native as path;
use regress::Regex;
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

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
                r"^(sd\d?|sdxl|sd-?turbo|stable-?diffusion.*|flux.*|wuerstchen|pixart.*|ltxv.*|hidream.*|chroma.*|qwen-?image.*|z-?image.*|ovis-?image.*|wan\d.*|hunyuan.*(image|video).*|cogvideo.*)"
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
        if test(regex!(r"draft|eagle|medusa|lookahead|speculative"), arch) {
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
            } else if entry.is_file && ends_gguf(&entry.name) {
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

/// A row described before the KV layout was read gets it once, from its
/// header; everything else in the row (its name, preset, when it was added)
/// stays. `true` when the row changed.
fn add_kv_layout(stored: &mut Map<String, Value>, p: &str) -> bool {
    if stored.contains_key("kvLayout") || stored.get("readable") != Some(&Value::Bool(true)) {
        return false;
    }
    match gguf::read_metadata(p).and_then(|m| m.kv_layout) {
        Some(l) => {
            stored.insert("kvLayout".into(), l.to_value());
            true
        }
        None => false,
    }
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
    let meta_name = meta.and_then(|m| m.name.as_deref()).map(nekko_js::trim).filter(|n| !n.is_empty());
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
    put(&mut m, "sourceRepo", if typed { repo_from_typed_path(&root.path, p).map(Value::String) } else { None });
    m.insert("folderId".into(), root.id.clone());
    put(&mut m, "folderProvider", root.provider.clone());
    put(&mut m, "quantization", meta.and_then(|m| m.quantization.clone()).map(Value::String));
    put(&mut m, "parameterSize", meta.and_then(|m| m.parameter_size.clone()).map(Value::String));
    put(&mut m, "architecture", meta.and_then(|m| m.architecture.clone()).map(Value::String));
    put(&mut m, "layers", meta.and_then(|m| m.layers).map(num));
    put(&mut m, "kvHeads", meta.and_then(|m| m.kv_heads).map(num));
    put(&mut m, "headDim", meta.and_then(|m| m.head_dim).map(num));
    put(&mut m, "maxContext", meta.and_then(|m| m.max_context).map(num));
    put(&mut m, "kvLayout", meta.and_then(|m| m.kv_layout).map(|l| l.to_value()));
    m.insert("hasChatTemplate".into(), json!(meta.is_some_and(|m| m.chat_template.is_some())));
    m.insert("readable".into(), json!(meta.is_some()));
    m.insert("addedAt".into(), num(now));
    m
}

/* ---------------------------------------------------------------- Ollama */

/// One model Ollama has pulled: its `ollama run` name and the weights blob.
pub struct OllamaModel {
    pub name: String,
    pub path: String,
    pub size: f64,
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
        out.push(OllamaModel { name: ollama_name(&manifest_root, &file), path: blob, size });
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
    pub vision: bool,
    pub size: f64,
}

/// Whether a directory is an MLX model, and what it is (`readMlxModel`): a
/// `config.json` beside `.safetensors` weights, plus MLX's quantization block
/// or `mlx` in the folder's or its publisher's name.
pub fn read_mlx_model(dir: &str) -> Option<MlxInfo> {
    let entries: Vec<String> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    let weights: Vec<&String> = entries.iter().filter(|e| lower(e).ends_with(".safetensors")).collect();
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
    if !mlx_quant && !test(regex!("mlx"), &near) {
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
        vision: nekko_js::truthy(field(&config, "vision_config").as_ref()),
        size,
    })
}

/// MLX model folders under one root; a folder that is a model is not descended into.
fn scan_mlx_folder(root: &Root) -> Vec<(String, MlxInfo)> {
    fn walk(dir: &str, depth: u32, max: u32, out: &mut Vec<(String, MlxInfo)>) {
        let Ok(entries) = nodefs::read_dir(dir) else { return };
        if entries.iter().any(|e| e.is_file && e.name == "config.json")
            && let Some(info) = read_mlx_model(dir)
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
        let tmp = format!("{target}.{}.tmp", std::process::id());
        std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &target).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            e.to_string()
        })
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
        let files: Vec<(String, Option<String>)> = if root.is_ollama() {
            list_ollama(&root.path).into_iter().map(|m| (m.path, Some(m.name))).collect()
        } else {
            scan_folder(root).into_iter().filter(|p| !later_shard(p) && !is_projector(p)).map(|p| (p, None)).collect()
        };
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
            let id = claim(&mut stored, &mut seen_ids);
            index.models().insert(id, Value::Object(stored.clone()));
            let mut row = stored;
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
            row.insert("modality".into(), json!(if info.vision { "vision" } else { "chat" }));
            row.insert("hasProjector".into(), json!(info.vision));
            row.insert("mlxRunnable".into(), json!(cfg.mlx_runnable));
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
        let modality = row_modality(row, &name);
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
    let size = std::fs::metadata(p).map_or(0.0, |m| m.len() as f64);
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
    let stored = describe_with(&primary, p, None, Some(&meta), cfg.now);
    let id = stored.get("id").map(nekko_js::display).unwrap_or_default();
    index.models().insert(id, Value::Object(stored.clone()));
    index.write(cfg)?;
    let mut model = stored.clone();
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

/// Delete the file and its row; shards and projectors go with it (`remove`).
pub fn remove(cfg: &LibraryConfig, id: &str) -> Result<Value, String> {
    let Some(model) = find(cfg, id)? else {
        return Ok(reply(false, "That model is not in the library.".into()));
    };
    let name = model.get("name").map(nekko_js::display).unwrap_or_default();
    if model.get("managed") == Some(&Value::Bool(false)) {
        return Ok(reply(
            false,
            format!("{name} lives in a folder Nekko Agent only reads. Delete it in the app that downloaded it."),
        ));
    }
    let model_path = model.get("path").and_then(Value::as_str).unwrap_or_default().to_string();
    let primary = cfg.roots().remove(0);
    let companions: Vec<String> =
        scan_folder(&primary).into_iter().filter(|p| is_companion_of(p, &model_path)).collect();
    for p in std::iter::once(&model_path).chain(&companions) {
        // `rm(p, { force: true })`: a missing file is fine, a directory is not.
        match std::fs::symlink_metadata(p) {
            Ok(m) if m.is_dir() => {
                return Err(format!("Path is a directory: rm returned EISDIR (is a directory) {p}"));
            }
            Ok(_) => std::fs::remove_file(p).map_err(|e| e.to_string())?,
            Err(_) => {}
        }
    }
    let sidecars = companions_dir(&cfg.models_dir, id);
    if std::fs::symlink_metadata(&sidecars).is_ok() {
        std::fs::remove_dir_all(&sidecars).map_err(|e| e.to_string())?;
    }
    let mut index = Index::read(cfg);
    index.models().shift_remove(id);
    index.write(cfg)?;
    Ok(reply(true, format!("Deleted {name}.")))
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
        kv_cache_dtype: field("kvCacheDtype").map_or_else(|| "f16".to_string(), nekko_js::display),
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

/// `engine:models`: the library with load state, the last failure and the
/// GPU-fit verdict folded in. `hw` is `None` when no GPU probe answered.
pub fn with_load_state(
    rows: Vec<Value>,
    loaded: &HashSet<String>,
    errors: &Map<String, Value>,
    hw: Option<&Hardware>,
    overhead_floor: Option<f64>,
) -> Vec<Value> {
    rows.into_iter()
        .map(|row| {
            let id = row.get("id").map(nekko_js::display).unwrap_or_default();
            let fit = hw.map(|hw| gpu_fit_for(&row, hw, overhead_floor));
            let mut m = match row {
                Value::Object(m) => m,
                _ => Map::new(),
            };
            m.insert("loaded".into(), json!(loaded.contains(&id)));
            assign(&mut m, "lastLoadError", errors.get(&id).filter(|e| !e.is_null()).cloned());
            assign(&mut m, "gpuFit", fit.map(|f| json!(f)));
            Value::Object(m)
        })
        .collect()
}
