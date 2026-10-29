//! Where models come from: the curated starter list and Hugging Face search,
//! each repo's GGUF quants (split shards collapsed, projector and sidecar
//! files attached) or its MLX folder. A port of
//! `packages/host/src/engine/catalog.ts`, held to it by
//! `tests/golden/catalog.json`.

use crate::BoxFuture;
use regress::Regex;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const HF_API: &str = "https://huggingface.co/api";
const CACHE_TTL: Duration = Duration::from_secs(10 * 60);
const SIDECAR_MAX_BYTES: f64 = 64.0 * 1024.0 * 1024.0;

const QUANT_ORDER: [&str; 20] = [
    "IQ1", "IQ2", "Q2_K", "IQ3", "Q3_K_S", "Q3_K_M", "Q3_K_L", "Q4_0", "IQ4", "Q4_K_S", "Q4_K_M", "Q5_0", "Q5_K_S",
    "Q5_K_M", "Q6_K", "Q8_0", "MXFP4", "BF16", "F16", "F32",
];

fn quant_note(label: &str) -> Option<&'static str> {
    Some(match label {
        "Q3_K_M" => "Smallest useful size. Noticeably rougher.",
        "Q4_K_M" => "The usual choice: best balance of size and quality.",
        "Q5_K_M" => "A little larger, a little better.",
        "Q6_K" => "Close to full quality, much bigger.",
        "Q8_0" => "Effectively full quality. Large.",
        "F16" => "Unquantized. Very large.",
        _ => return None,
    })
}

const SIDECAR_FILES: [&str; 14] = [
    "chat_template.jinja",
    "chat_template.json",
    "chat-template.jinja",
    "tokenizer_config.json",
    "tokenizer.json",
    "tokenizer.model",
    "config.json",
    "generation_config.json",
    "special_tokens_map.json",
    "added_tokens.json",
    "merges.txt",
    "vocab.json",
    "preprocessor_config.json",
    "processor_config.json",
];

/// The starter list (`CURATED`), as the TS exports it.
pub fn curated_entries() -> &'static Vec<Value> {
    static C: OnceLock<Vec<Value>> = OnceLock::new();
    C.get_or_init(|| serde_json::from_str(include_str!("curated.json")).unwrap_or_default())
}

macro_rules! regex {
    ($pattern:expr, $flags:expr) => {{
        static R: OnceLock<Regex> = OnceLock::new();
        R.get_or_init(|| Regex::with_flags($pattern, $flags).expect("a valid built-in pattern"))
    }};
}

fn test(r: &Regex, s: &str) -> bool {
    r.find(s).is_some()
}

/// One answer from Hugging Face.
pub struct Reply {
    pub status: u16,
    pub body: String,
}

/// How the catalog reaches Hugging Face (a script in the tests).
pub trait Fetch: Send + Sync {
    /// `Err` is a network failure (`fetch` throwing).
    fn get(&self, url: String, headers: Vec<(&'static str, String)>) -> BoxFuture<Result<Reply, String>>;
}

/// Hugging Face over HTTPS.
pub struct HttpFetch(pub reqwest::Client);

impl Fetch for HttpFetch {
    fn get(&self, url: String, headers: Vec<(&'static str, String)>) -> BoxFuture<Result<Reply, String>> {
        let client = self.0.clone();
        Box::pin(async move {
            let mut req = client.get(url).timeout(Duration::from_secs(60));
            for (k, v) in headers {
                req = req.header(k, v);
            }
            let res = nekko_net::send("models", req).await.map_err(|e| e.to_string())?;
            let status = res.status().as_u16();
            let body = res.text().await.map_err(|e| e.to_string())?;
            Ok(Reply { status, body })
        })
    }
}

pub struct Catalog {
    fetch: Arc<dyn Fetch>,
    token: Box<dyn Fn() -> Option<String> + Send + Sync>,
    mlx: Box<dyn Fn() -> bool + Send + Sync>,
    cache: Mutex<HashMap<String, (Instant, Value)>>,
}

/// `encodeURIComponent`.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The URL a repo file is fetched from (`hfFileUrl`).
pub fn hf_file_url(repo_id: &str, file: &str) -> String {
    let path: Vec<String> = file.split('/').map(encode_uri_component).collect();
    format!("https://huggingface.co/{repo_id}/resolve/main/{}?download=true", path.join("/"))
}

/// `stripFrontMatter`: drop the YAML block a model card opens with.
pub fn strip_front_matter(markdown: &str) -> String {
    if !markdown.starts_with("---") {
        return nekko_js::trim(markdown).to_string();
    }
    let Some(close) = markdown.get(3..).and_then(|rest| rest.find("\n---")).map(|i| i + 3) else {
        return nekko_js::trim(markdown).to_string();
    };
    match markdown[close + 1..].find('\n') {
        None => String::new(),
        Some(i) => nekko_js::trim(&markdown[close + 1 + i + 1..]).to_string(),
    }
}

/// `...-Q4_K_M.gguf` -> `Q4_K_M`, falling back to the bare file name.
fn quant_label(file: &str) -> String {
    let base = file.rsplit('/').next().unwrap_or(file);
    let r = regex!(r"[-_.]((?:IQ|Q)\d+[A-Z0-9_]*|BF16|F16|F32|MXFP4[A-Z0-9_]*)\.gguf$", "i");
    if let Some(g) = r.find(base).and_then(|m| m.group(1)) {
        return base[g].to_uppercase();
    }
    regex_replace(regex!(r"\.gguf$", "i"), base, "")
}

fn rank(label: &str) -> usize {
    let upper = label.to_uppercase();
    QUANT_ORDER.iter().position(|q| upper.starts_with(q)).unwrap_or(QUANT_ORDER.len())
}

/// The first match replaced (a pattern without the `g` flag).
fn regex_replace(r: &Regex, s: &str, with: &str) -> String {
    match r.find(s) {
        Some(m) => format!("{}{with}{}", &s[..m.range().start], &s[m.range().end..]),
        None => s.to_string(),
    }
}

fn pretty_name(repo: &str) -> String {
    let stripped = regex_replace(regex!(r"[-_]?GGUF$", "i"), repo, "");
    nekko_js::trim(&stripped.replace(['-', '_'], " ")).to_string()
}

/// `Qwen2.5-7B-Instruct` -> `7B`. Display only.
fn param_hint(repo: &str) -> Option<String> {
    let r = regex!(r"(\d+(?:\.\d+)?[BM])(?![a-z])", "i");
    r.find(repo).and_then(|m| m.group(1)).map(|g| repo[g].to_uppercase())
}

fn capability_tags(hf_tags: &[String], repo: &str) -> Vec<&'static str> {
    let text = format!("{} {repo}", hf_tags.join(" ")).to_lowercase();
    let mut tags = Vec::new();
    tags.push(if test(regex!(r"embed|bge|e5-|gte-", ""), &text) { "embedding" } else { "chat" });
    if test(regex!(r"coder|code|starcoder|deepseek-?coder", ""), &text) {
        tags.push("code");
    }
    if test(regex!(r"reason|r1|qwq|thinking|gpt-oss", ""), &text) {
        tags.push("reasoning");
    }
    if test(regex!(r"vision|vl|multimodal|llava|gemma-3", ""), &text) {
        tags.push("vision");
    }
    tags
}

/// `row.tags ?? []` as strings.
fn tags_of(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).map(|a| a.iter().map(nekko_js::display).collect()).unwrap_or_default()
}

fn base_model_of(tags: &[String]) -> Option<String> {
    let t = tags.iter().find(|t| t.starts_with("base_model:"))?;
    let rest: Vec<&str> = t.split(':').skip(1).collect();
    Some(rest.join(":")).filter(|s| !s.is_empty())
}

fn license_of(tags: &[String]) -> Option<String> {
    tags.iter().find(|t| t.starts_with("license:")).map(|t| t["license:".len()..].to_string()).filter(|s| !s.is_empty())
}

fn as_time(v: Option<&Value>) -> Option<Value> {
    let s = v.filter(|v| nekko_js::truthy(Some(v)))?;
    let t = nekko_usage::date::parse(&nekko_js::display(s));
    t.is_finite().then(|| crate::num(t))
}

/// `a.localeCompare(b)` by path, as `parts.sort` does.
fn by_locale(a: &str, b: &str) -> std::cmp::Ordering {
    nekko_usage::locale_compare(a, b)
}

/// JavaScript's default sort: UTF-16 code units.
fn by_units(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

#[derive(Clone)]
struct TreeFile {
    is_dir: bool,
    path: Option<String>,
    size: f64,
}

fn tree_files(tree: &Value) -> Vec<TreeFile> {
    tree.as_array()
        .map(|a| {
            a.iter()
                .map(|f| TreeFile {
                    is_dir: f.get("type").and_then(Value::as_str) == Some("directory"),
                    path: f.get("path").and_then(Value::as_str).map(str::to_string),
                    size: f.get("size").and_then(Value::as_f64).unwrap_or(0.0),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The projector and the config/tokenizer sidecars a repo ships.
fn companions_of(tree: &[TreeFile]) -> (Option<String>, Vec<String>) {
    let projector = tree
        .iter()
        .find(|f| {
            !f.is_dir
                && f.path
                    .as_deref()
                    .is_some_and(|p| test(regex!("mmproj", "i"), p) && p.to_lowercase().ends_with(".gguf"))
        })
        .and_then(|f| f.path.clone());
    let sidecars = tree
        .iter()
        .filter(|f| {
            !f.is_dir
                && f.path.as_deref().is_some_and(|p| {
                    !p.is_empty() && SIDECAR_FILES.contains(&p.rsplit('/').next().unwrap_or("").to_lowercase().as_str())
                })
                && f.size <= SIDECAR_MAX_BYTES
        })
        .filter_map(|f| f.path.clone())
        .collect();
    (projector, sidecars)
}

/// `mlxQuant`: an MLX repo as one download, the whole folder.
pub fn mlx_quant(id: &str, tree: &Value, tagged_mlx: bool) -> Option<Value> {
    let mlx_file = regex!(
        r"(^|\/)(config\.json|generation_config\.json|.*\.safetensors|model\.safetensors\.index\.json|tokenizer[^/]*|special_tokens_map\.json|vocab\.(json|txt)|merges\.txt|[^/]*\.tiktoken|chat_template\.(json|jinja)|preprocessor_config\.json|processor_config\.json)$",
        "i"
    );
    let files: Vec<TreeFile> = tree_files(tree)
        .into_iter()
        .filter(|f| {
            !f.is_dir && f.path.as_deref().is_some_and(|p| !p.is_empty() && !p.contains('/') && test(mlx_file, p))
        })
        .collect();
    let mut weights: Vec<&TreeFile> =
        files.iter().filter(|f| f.path.as_deref().unwrap_or("").to_lowercase().ends_with(".safetensors")).collect();
    weights.sort_by(|a, b| b.size.partial_cmp(&a.size).unwrap_or(std::cmp::Ordering::Equal));
    if !files.iter().any(|f| f.path.as_deref() == Some("config.json"))
        || weights.is_empty()
        || !(tagged_mlx || test(regex!("mlx", "i"), id))
    {
        return None;
    }
    let main = weights[0].path.clone().unwrap_or_default();
    let name = nekko_js::slice16(id, 200);
    let bits =
        regex!(r"(?:^|\D)(\d{1,3})[-_]?bit", "i").find(name).and_then(|m| m.group(1)).map(|g| name[g].to_string());
    let label = match bits {
        Some(b) => format!("{b}bit"),
        None if test(regex!("bf16", "i"), name) => "BF16".into(),
        None if test(regex!("fp16|f16", "i"), name) => "FP16".into(),
        None => "MLX".into(),
    };
    let mut extra: Vec<String> = files.iter().filter_map(|f| f.path.clone()).filter(|p| *p != main).collect();
    extra.sort_by(|a, b| by_units(a, b));
    Some(json!({
        "label": label,
        "file": main,
        "sizeBytes": crate::num(files.iter().fold(0.0, |n, f| n + f.size)),
        "extraFiles": extra,
        "note": "MLX, for Apple Silicon",
        "format": "mlx",
    }))
}

/// Copy `from[key]` into `o` as `name` when present (a JSON `null` stays, as in JS).
fn copy(o: &mut Map<String, Value>, name: &str, from: Option<&Value>) {
    if let Some(v) = from {
        o.insert(name.into(), v.clone());
    }
}

impl Catalog {
    pub fn new(
        fetch: Arc<dyn Fetch>,
        token: Box<dyn Fn() -> Option<String> + Send + Sync>,
        mlx: Box<dyn Fn() -> bool + Send + Sync>,
    ) -> Self {
        Self { fetch, token, mlx, cache: Mutex::default() }
    }

    fn headers(&self) -> Vec<(&'static str, String)> {
        let mut h = vec![("accept", "application/json".to_string()), ("user-agent", "nekko-agent".to_string())];
        if let Some(t) = (self.token)().filter(|t| !t.is_empty()) {
            h.push(("authorization", format!("Bearer {t}")));
        }
        h
    }

    async fn get_json(&self, url: String) -> Option<Value> {
        let reply = self.fetch.get(url, self.headers()).await.ok()?;
        if !(200..300).contains(&reply.status) {
            return None;
        }
        serde_json::from_str(&reply.body).ok()
    }

    async fn tree_for(&self, id: &str) -> Option<Value> {
        self.get_json(format!("{HF_API}/models/{id}/tree/main?recursive=true")).await
    }

    /// A repo's GGUF files as quantization options (`quantsFor`).
    pub async fn quants_for(&self, id: &str, tags: Option<&[String]>, mlx_format: bool) -> Vec<Value> {
        let Some(tree_value) = self.tree_for(id).await else { return Vec::new() };
        let tree = tree_files(&tree_value);
        let ggufs: Vec<&TreeFile> = tree
            .iter()
            .filter(|f| !f.is_dir && f.path.as_deref().is_some_and(|p| p.to_lowercase().ends_with(".gguf")))
            .collect();
        let mlx = if (self.mlx)() {
            mlx_quant(id, &tree_value, tags.is_some_and(|t| t.iter().any(|x| x == "mlx")))
        } else {
            None
        };
        if mlx_format || ggufs.is_empty() {
            return mlx.into_iter().collect();
        }
        let mut groups: Vec<(String, Vec<(String, f64)>)> = Vec::new();
        for f in ggufs {
            let path = f.path.clone().unwrap_or_default();
            if test(regex!("mmproj", "i"), &path) {
                continue;
            }
            let group = regex_replace(regex!(r"-\d{5}-of-\d{5}\.gguf$", "i"), &path, ".gguf");
            match groups.iter_mut().find(|(g, _)| *g == group) {
                Some((_, list)) => list.push((path, f.size)),
                None => groups.push((group, vec![(path, f.size)])),
            }
        }
        let (projector, sidecars) = companions_of(&tree);
        let mut quants: Vec<(usize, Value)> = Vec::new();
        for (group, mut parts) in groups {
            parts.sort_by(|a, b| by_locale(&a.0, &b.0));
            let label = quant_label(&group);
            let mut extra: Vec<String> = parts[1..].iter().map(|p| p.0.clone()).collect();
            extra.extend(projector.clone());
            extra.extend(sidecars.iter().cloned());
            let mut o = Map::new();
            o.insert("label".into(), json!(label));
            o.insert("file".into(), json!(parts[0].0));
            o.insert("sizeBytes".into(), crate::num(parts.iter().fold(0.0, |n, p| n + p.1)));
            o.insert("extraFiles".into(), json!(extra));
            if let Some(note) = quant_note(&label) {
                o.insert("note".into(), json!(note));
            }
            quants.push((rank(&label), Value::Object(o)));
        }
        quants.sort_by_key(|(r, _)| *r);
        quants.into_iter().map(|(_, q)| q).chain(mlx).collect()
    }

    /// The starter list, with each repo's real files and sizes filled in.
    pub async fn curated(&self) -> Vec<Value> {
        let filled = futures_util::future::join_all(curated_entries().iter().map(|entry| async move {
            let id = entry.get("id").and_then(Value::as_str).unwrap_or_default();
            let quants = self.quants_for(id, None, false).await;
            let mut o = entry.as_object().cloned().unwrap_or_default();
            o.insert("quants".into(), json!(quants));
            (quants.is_empty(), Value::Object(o))
        }))
        .await;
        filled.into_iter().filter(|(empty, _)| !empty).map(|(_, v)| v).collect()
    }

    /// Free-text search over Hugging Face: GGUF repos, or MLX checkpoints.
    pub async fn search(&self, query: &str, limit: usize, mlx_format: bool) -> Vec<Value> {
        let q = nekko_js::trim(query);
        if q.is_empty() && !mlx_format {
            return self.curated().await;
        }
        let filter = if mlx_format { "filter=mlx&pipeline_tag=text-generation" } else { "filter=gguf" };
        let url = format!(
            "{HF_API}/models?{filter}&search={}&sort=downloads&direction=-1&limit={limit}&full=true",
            encode_uri_component(q)
        );
        let Some(Value::Array(rows)) = self.get_json(url).await else { return Vec::new() };
        let found = futures_util::future::join_all(rows.iter().take(limit).map(|row| async move {
            let id = nekko_js::coalesce(row.get("id"), row.get("modelId")).filter(|v| nekko_js::truthy(Some(v)))?;
            let id = nekko_js::display(id);
            let tags = row.get("tags").filter(|t| !t.is_null()).map(|_| tags_of(row.get("tags")));
            let quants = self.quants_for(&id, tags.as_deref(), mlx_format).await;
            if quants.is_empty() {
                return None;
            }
            let all_tags = tags.unwrap_or_default();
            let (owner, repo) = split_id(&id);
            let mut o = Map::new();
            o.insert("id".into(), json!(id));
            o.insert("name".into(), json!(pretty_name(repo.unwrap_or(&id))));
            o.insert("owner".into(), json!(owner));
            if let Some(p) = param_hint(repo.unwrap_or("")) {
                o.insert("parameterSize".into(), json!(p));
            }
            o.insert("tags".into(), json!(capability_tags(&all_tags, repo.unwrap_or(""))));
            o.insert("quants".into(), json!(quants));
            copy(&mut o, "downloads", row.get("downloads"));
            copy(&mut o, "likes", row.get("likes"));
            copy(&mut o, "updatedAt", as_time(row.get("lastModified")).as_ref());
            copy(&mut o, "createdAt", as_time(row.get("createdAt")).as_ref());
            copy(&mut o, "pipelineTag", row.get("pipeline_tag"));
            copy(&mut o, "baseModel", base_model_of(&all_tags).map(Value::String).as_ref());
            copy(&mut o, "hfTags", row.get("tags"));
            o.insert("gated".into(), json!(nekko_js::truthy(row.get("gated"))));
            Some(Value::Object(o))
        }))
        .await;
        found.into_iter().flatten().collect()
    }

    /// One repo's detail, including every GGUF it publishes (cached ten minutes).
    pub async fn model(&self, id: &str) -> Value {
        if let Some((at, v)) = self.cache.lock().unwrap_or_else(|e| e.into_inner()).get(id)
            && at.elapsed() < CACHE_TTL
        {
            return v.clone();
        }
        let info = self.get_json(format!("{HF_API}/models/{id}")).await;
        let info_tags = info.as_ref().and_then(|i| i.get("tags")).filter(|t| !t.is_null()).map(|t| tags_of(Some(t)));
        let quants = self.quants_for(id, info_tags.as_deref(), false).await;
        let value = if quants.is_empty() {
            Value::Null
        } else {
            let tags = info_tags.unwrap_or_default();
            let (owner, repo) = split_id(id);
            let field = |k: &str| info.as_ref().and_then(|i| i.get(k));
            let card = |k: &str| field("cardData").and_then(|c| c.get(k));
            let mut o = Map::new();
            o.insert("id".into(), json!(id));
            o.insert("name".into(), json!(pretty_name(repo.unwrap_or(id))));
            o.insert("owner".into(), json!(owner));
            if let Some(p) = param_hint(repo.unwrap_or("")) {
                o.insert("parameterSize".into(), json!(p));
            }
            copy(&mut o, "summary", card("summary"));
            o.insert("tags".into(), json!(capability_tags(&tags, repo.unwrap_or(""))));
            o.insert("quants".into(), json!(quants));
            copy(&mut o, "downloads", field("downloads"));
            copy(&mut o, "likes", field("likes"));
            copy(&mut o, "updatedAt", as_time(field("lastModified")).as_ref());
            copy(&mut o, "createdAt", as_time(field("createdAt")).as_ref());
            copy(&mut o, "pipelineTag", field("pipeline_tag"));
            let base = card("base_model")
                .filter(|v| !v.is_null())
                .cloned()
                .or_else(|| base_model_of(&tags).map(Value::String));
            copy(&mut o, "baseModel", base.as_ref());
            copy(&mut o, "hfTags", field("tags"));
            let license =
                card("license").filter(|v| !v.is_null()).cloned().or_else(|| license_of(&tags).map(Value::String));
            copy(&mut o, "license", license.as_ref());
            o.insert("gated".into(), json!(nekko_js::truthy(field("gated"))));
            Value::Object(o)
        };
        self.cache.lock().unwrap_or_else(|e| e.into_inner()).insert(id.to_string(), (Instant::now(), value.clone()));
        value
    }

    /// One model's own page: `model` plus its card.
    pub async fn detail(&self, id: &str) -> Value {
        let (base, card) = tokio::join!(self.model(id), self.readme(id));
        let Value::Object(mut o) = base else { return Value::Null };
        match card {
            Ok(Some(text)) => {
                o.insert("readme".into(), json!(text));
            }
            Ok(None) => {}
            Err(e) => {
                o.insert("readmeError".into(), json!(e));
            }
        }
        Value::Object(o)
    }

    /// The model card, front matter stripped; `Ok(None)` when there is none.
    async fn readme(&self, id: &str) -> Result<Option<String>, String> {
        match self.fetch.get(format!("https://huggingface.co/{id}/raw/main/README.md"), self.headers()).await {
            Err(_) => Err("Couldn't reach Hugging Face for the model card.".into()),
            Ok(r) if r.status == 404 => Ok(None),
            Ok(r) if !(200..300).contains(&r.status) => Err(format!("Hugging Face answered {}.", r.status)),
            Ok(r) => Ok(Some(strip_front_matter(&r.body))),
        }
    }

    /// The files a model on disk could be missing: its projector and small configs.
    pub async fn companions(&self, id: &str) -> Value {
        let Some(tree) = self.tree_for(id).await else { return Value::Null };
        let (projector, sidecars) = companions_of(&tree_files(&tree));
        let mut o = Map::new();
        if let Some(p) = projector {
            o.insert("projector".into(), json!(p));
        }
        o.insert("sidecars".into(), json!(sidecars));
        Value::Object(o)
    }

    /// `engine:catalog(query, format)`, as the host picks the call.
    pub async fn catalog(&self, query: &Value, format: &Value) -> Vec<Value> {
        if format == "mlx" {
            let q = if query.is_null() { String::new() } else { nekko_js::display(query) };
            return self.search(&q, 20, true).await;
        }
        if nekko_js::truthy(Some(query)) {
            self.search(&nekko_js::display(query), 20, false).await
        } else {
            self.curated().await
        }
    }
}

/// `const [owner, repo] = id.split('/')`.
fn split_id(id: &str) -> (&str, Option<&str>) {
    let mut parts = id.split('/');
    let owner = parts.next().unwrap_or(id);
    (owner, parts.next())
}
