//! How a model is launched: the `llama-server`, `sd-server` and
//! `mlx_lm.server` command lines, the companion files a load finds (or a chat
//! template it extracts), the sentence a dead server's log becomes, and the
//! image request stable-diffusion.cpp takes. Ports of the pure half of
//! `packages/host/src/engine/server.ts`, `diffusion.ts`'s `diffusionArgs`,
//! `mlx.ts`'s `mlxArgs`, `vc-runtime.ts`'s messages, the shared
//! `unsupportedLoadReason`, and the engine facade's image, memory and
//! endpoint helpers, held to them by `tests/golden/server.json`.

use crate::acquire::{companions_beside, image_companion_set_for, image_companion_status};
use crate::library::model_modality;
use nekko_tools::nodefs;
use nekko_tools::path::native as path;
use regress::Regex;
use serde_json::{Map, Value, json};
use std::collections::HashSet;
use std::sync::OnceLock;

fn re(pattern: &str, flags: &str) -> Regex {
    Regex::with_flags(pattern, flags).expect("a valid built-in pattern")
}

macro_rules! regex {
    ($p:expr, $f:expr) => {{
        static R: OnceLock<Regex> = OnceLock::new();
        R.get_or_init(|| re($p, $f))
    }};
}

fn test(r: &Regex, s: &str) -> bool {
    r.find(s).is_some()
}

fn text(v: Option<&Value>) -> String {
    v.map(nekko_js::display).unwrap_or_else(|| "undefined".into())
}

fn str_of<'a>(m: &'a Value, k: &str) -> Option<&'a str> {
    m.get(k).and_then(Value::as_str)
}

/// `x !== undefined`: the key is there, `null` included.
fn defined<'a>(m: &'a Value, k: &str) -> Option<&'a Value> {
    m.get(k)
}

/// JavaScript truthiness of a field.
fn truthy(m: &Value, k: &str) -> bool {
    nekko_js::truthy(m.get(k))
}

/* ------------------------------------------------------------- llama.cpp */

/// Files a model needs beside its weights (`ModelCompanions`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Companions {
    pub mmproj: Option<String>,
    pub chat_template_file: Option<String>,
    pub draft_model: Option<String>,
}

impl Companions {
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        if let Some(p) = &self.mmproj {
            m.insert("mmproj".into(), json!(p));
        }
        if let Some(p) = &self.chat_template_file {
            m.insert("chatTemplateFile".into(), json!(p));
        }
        if let Some(p) = &self.draft_model {
            m.insert("draftModel".into(), json!(p));
        }
        Value::Object(m)
    }
}

/// The flags a `llama-server` build accepts, read from its `--help` (`probeFlags`).
pub fn known_flags(help: &str) -> HashSet<String> {
    regex!(r"--[a-z0-9][a-z0-9-]*", "").find_iter(help).map(|m| help[m.range()].to_string()).collect()
}

/// The `llama-server` command line for one load (`buildArgs`).
pub fn build_args(
    model: &Value,
    port: &str,
    params: &Value,
    companions: &Companions,
    supports: &dyn Fn(&str) -> bool,
    prompt_caching: bool,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "--model".into(),
        text(model.get("path")),
        "--alias".into(),
        text(model.get("id")),
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        port.into(),
    ];
    fn push(args: &mut Vec<String>, a: &str, v: String) {
        args.push(a.into());
        args.push(v);
    }
    if let Some(p) = &companions.mmproj {
        push(&mut args, "--mmproj", p.clone());
    }
    if let Some(p) = &companions.chat_template_file {
        push(&mut args, "--chat-template-file", p.clone());
        args.push("--jinja".into());
    }
    let p = params;
    if truthy(p, "contextTokens") {
        push(&mut args, "--ctx-size", text(p.get("contextTokens")));
    }
    let layers = nekko_js::to_number(model.get("layers"));
    if let Some(g) = defined(p, "gpuLayers") {
        // `gpuLayers` counts the model's transformer blocks, so asking for all of
        // them is a full offload here. llama.cpp counts the output layer as one
        // more and keeps it on the CPU unless asked for more layers than there
        // are blocks: `-ngl 36` on a 36-block Qwen3-8B left it there and
        // prefilled at 1531 tok/s against 2762 with it on the GPU (M5 Max,
        // llama-bench b11224). 999 rather than the count plus one, so a model
        // whose GGUF counts its blocks differently still loads whole.
        let full = g.is_number() && layers > 0.0 && nekko_js::to_number(Some(g)) >= layers;
        push(&mut args, "--n-gpu-layers", if full { "999".into() } else { nekko_js::display(g) });
    }
    let first_layers = |n: f64| (0..n as u32).map(|i| i.to_string()).collect::<Vec<_>>().join("|");
    if let Some(n) = p.get("cpuMoeLayers").and_then(Value::as_f64).filter(|n| *n >= 1.0) {
        if n >= layers && supports("--cpu-moe") {
            args.push("--cpu-moe".into());
        } else if n < layers && supports("--n-cpu-moe") {
            push(&mut args, "--n-cpu-moe", nekko_js::number_to_string(n.floor()));
        } else if n >= layers || !layers.is_finite() {
            push(&mut args, "--override-tensor", r"\.ffn_(up|down|gate|gate_up)_(ch|)exps\.=CPU".into());
        } else {
            push(
                &mut args,
                "--override-tensor",
                format!(r"blk\.({})\.ffn_(up|down|gate|gate_up)_(ch|)exps\.=CPU", first_layers(n)),
            );
        }
    }
    if let Some(n) = p.get("cpuFfnLayers").and_then(Value::as_f64).filter(|n| *n >= 1.0) {
        if supports("--n-cpu-ffn") {
            push(&mut args, "--n-cpu-ffn", nekko_js::number_to_string(n.floor()));
        } else {
            push(
                &mut args,
                "--override-tensor",
                format!(r"blk\.({})\.ffn_(up|down|gate|gate_up)\.=CPU", first_layers(n.min(layers))),
            );
        }
    }
    if let Some(mib) = p.get("moeCacheMiB").and_then(Value::as_f64).filter(|n| *n >= 1.0)
        && supports("--moe-cache-mib")
    {
        push(&mut args, "--moe-cache-mib", nekko_js::number_to_string(mib.floor()));
    }
    if p.get("kvOnGpu") == Some(&Value::Bool(false)) {
        args.push("--no-kv-offload".into());
    }
    if let Some(lazy) = p.get("lazyTables").and_then(Value::as_bool)
        && supports("--lazy-mode")
    {
        push(&mut args, "--lazy-mode", if lazy { "on" } else { "off" }.into());
    }
    // Placement we solved ourselves is passed as is: llama.cpp's `--fit`
    // (on by default) would otherwise re-place tensors behind the meter.
    let explicit = defined(p, "gpuLayers").is_some()
        || ["cpuMoeLayers", "cpuFfnLayers"].iter().any(|k| defined(p, k).is_some())
        || p.get("kvOnGpu") == Some(&Value::Bool(false));
    if explicit && supports("--fit") {
        push(&mut args, "--fit", "off".into());
    }
    if truthy(p, "parallelSlots") && nekko_js::to_number(p.get("parallelSlots")) > 1.0 {
        let slots = nekko_js::to_number(p.get("parallelSlots"));
        push(&mut args, "--parallel", text(p.get("parallelSlots")));
        // One shared pool any session can grow into, each capped at its share.
        if supports("--kv-unified") {
            args.push("--kv-unified".into());
            if truthy(p, "contextTokens") && supports("--kv-unified-per-slot") {
                let per = (nekko_js::to_number(p.get("contextTokens")) / slots).floor();
                push(&mut args, "--kv-unified-per-slot", nekko_js::number_to_string(per));
            }
        }
    }
    for (k, flag) in [
        ("batchSize", "--batch-size"),
        ("ubatchSize", "--ubatch-size"),
        ("threads", "--threads"),
        ("threadsBatch", "--threads-batch"),
    ] {
        if truthy(p, k) {
            push(&mut args, flag, text(p.get(k)));
        }
    }
    if truthy(p, "kvCacheDtype") && str_of(p, "kvCacheDtype") != Some("f16") {
        let kv = text(p.get("kvCacheDtype"));
        push(&mut args, "--cache-type-k", kv.clone());
        push(&mut args, "--cache-type-v", kv);
    }
    if defined(p, "flashAttention").is_some() {
        push(&mut args, "--flash-attn", if truthy(p, "flashAttention") { "on".into() } else { "off".into() });
    }
    let mmap_off = p.get("mmap") == Some(&Value::Bool(false));
    if supports("--load-mode") {
        let mode = if mmap_off {
            Some("none")
        } else if truthy(p, "mlock") {
            Some("mmap+mlock")
        } else {
            None
        };
        if let Some(mode) = mode {
            push(&mut args, "--load-mode", mode.into());
        }
    } else {
        if mmap_off {
            args.push("--no-mmap".into());
        }
        if truthy(p, "mlock") {
            args.push("--mlock".into());
        }
    }
    if truthy(p, "ropeFreqBase") {
        push(&mut args, "--rope-freq-base", text(p.get("ropeFreqBase")));
    }
    if truthy(p, "ropeFreqScale") {
        push(&mut args, "--rope-freq-scale", text(p.get("ropeFreqScale")));
    }
    if let Some(seed) = defined(p, "seed") {
        push(&mut args, "--seed", nekko_js::display(seed));
    }
    // Embedding models answer /v1/embeddings only in embedding mode.
    let embedding = str_of(model, "architecture").is_some_and(|a| !a.is_empty() && test(regex!("bert|embed", "i"), a));
    if embedding {
        args.push("--embedding".into());
        return args;
    }
    if supports("--cache-reuse") {
        args.push("--cache-reuse".into());
        args.push(if prompt_caching { "256" } else { "0" }.into());
    }
    if !prompt_caching && supports("--cache-ram") {
        args.push("--cache-ram".into());
        args.push("0".into());
    }
    if supports("--no-cache-idle-slots") {
        args.push("--no-cache-idle-slots".into());
    }
    if p.get("speculative") != Some(&Value::Bool(false)) && supports("--spec-default") {
        args.push("--spec-default".into());
        if let Some(draft) = &companions.draft_model
            && supports("--spec-draft-model")
        {
            for a in ["--spec-draft-model", draft, "--spec-draft-ngl", "all", "--spec-type", "draft-simple"] {
                args.push(a.into());
            }
        }
    }
    args
}

/// `mlx_lm.server`'s arguments for one load (`mlxArgs`).
pub fn mlx_args(model: &Value, port: &str, params: &Value, draft: Option<&str>) -> Vec<String> {
    let mut args = vec![
        "--model".into(),
        text(model.get("path")),
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        port.to_string(),
    ];
    if let Some(d) = draft.filter(|d| !d.is_empty())
        && params.get("speculative") != Some(&Value::Bool(false))
    {
        for a in ["--draft-model", d, "--num-draft-tokens", "3"] {
            args.push(a.into());
        }
    }
    args
}

/* ------------------------------------------------------------ companions */

fn exists(p: &str) -> bool {
    std::fs::metadata(p).is_ok()
}

fn names_in(dir: &str) -> Option<Vec<String>> {
    nodefs::read_dir(dir).ok().map(|e| e.into_iter().map(|e| e.name).collect())
}

/// The files a model needs beside its weights, at load time
/// (`resolveCompanions`); `Err` for a split model missing a shard.
pub fn resolve_companions(
    model: &Value,
    work_dir: Option<&str>,
    companions_dir: Option<&str>,
) -> Result<Companions, String> {
    let model_path = text(model.get("path"));
    let dir = path::dirname(&model_path);
    let file = path::basename(&model_path);
    let shard = regex!(r"-00001-of-(\d{5})\.gguf$", "i");
    if let Some(m) = shard.find(&file) {
        let digits = file[m.group(1).expect("captured")].to_string();
        let total = nekko_js::string_to_number(&digits) as u32;
        for n in 2..=total {
            let part = format!("{}-{n:05}-of-{digits}.gguf", &file[..m.start()]);
            if !exists(&path::join(&[&dir, &part])) {
                return Err(format!(
                    "{} is split into {total} files and {part} is missing. Re-download it so every piece lands.",
                    text(model.get("name"))
                ));
            }
        }
    }
    let Some(entries) = names_in(&dir) else { return Ok(Companions::default()) };
    let fetched: Vec<String> = companions_dir.and_then(names_in).unwrap_or_default();
    let is_mmproj = |e: &String| test(regex!("mmproj", "i"), e) && e.to_lowercase().ends_with(".gguf");
    let is_jinja = |e: &String| e.to_lowercase().ends_with(".jinja");
    let is_template = |e: &String| test(regex!(r"chat[-_]?template.*\.jinja$", "i"), e);

    let mut out = Companions::default();
    if let Some(p) = entries.iter().find(|e| is_mmproj(e)) {
        out.mmproj = Some(path::join(&[&dir, p]));
    } else if let (Some(p), Some(cd)) = (fetched.iter().find(|e| is_mmproj(e)), companions_dir) {
        out.mmproj = Some(path::join(&[cd, p]));
    }
    let local = entries.iter().find(|e| is_template(e)).or_else(|| entries.iter().find(|e| is_jinja(e)));
    let remote = fetched.iter().find(|e| is_template(e)).or_else(|| fetched.iter().find(|e| is_jinja(e)));
    if let Some(l) = local {
        out.chat_template_file = Some(path::join(&[&dir, l]));
    } else if let (Some(r), Some(cd)) = (remote, companions_dir) {
        out.chat_template_file = Some(path::join(&[cd, r]));
    } else if let Some(wd) = work_dir {
        out.chat_template_file = extract_template(&dir, &entries, &file, wd)
            .or_else(|| companions_dir.and_then(|cd| extract_template(cd, &fetched, &file, wd)));
    }
    Ok(out)
}

/// `chat_template` out of a repo's JSON config into a `.jinja` file (`extractTemplate`).
fn extract_template(dir: &str, entries: &[String], model_file: &str, work_dir: &str) -> Option<String> {
    for name in ["chat_template.json", "chat-template.json", "tokenizer_config.json"] {
        if !entries.iter().any(|e| e.to_lowercase() == name) {
            continue;
        }
        let Ok(bytes) = std::fs::read(path::join(&[dir, name])) else { continue };
        let Ok(parsed) = serde_json::from_str::<Value>(&String::from_utf8_lossy(&bytes)) else { continue };
        let template = match parsed.get("chat_template") {
            Some(Value::String(s)) => Some(s.clone()),
            Some(Value::Array(a)) => {
                a.iter().find_map(|t| t.get("template").and_then(Value::as_str).map(str::to_string))
            }
            _ => None,
        };
        let Some(template) = template.filter(|t| !t.is_empty()) else { continue };
        let stem = match regex!(r"\.gguf$", "i").find(model_file) {
            Some(m) => &model_file[..m.start()],
            None => model_file,
        };
        let dest = path::join(&[work_dir, &format!("{stem}.chat_template.jinja")]);
        if nodefs::mkdir_p(&path::dirname(&dest)).is_err() || std::fs::write(&dest, template).is_err() {
            continue;
        }
        return Some(dest);
    }
    None
}

/* ------------------------------------------------------ stable-diffusion */

const ROLES: [&str; 6] = ["clip_l", "clip_g", "t5xxl", "vae", "llm", "taesd"];

/// `sd-server`'s arguments for one image model (`diffusionArgs`).
pub fn diffusion_args(
    model: &Value,
    port: &str,
    owned: Option<&str>,
    shared: Option<&str>,
) -> Result<Vec<String>, String> {
    let preset = model
        .get("preset")
        .and_then(|p| p.get("diffusion"))
        .filter(|d| !d.is_null())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let mut paths: Map<String, Value> = Map::new();
    let beside = companions_beside(model, &owned.map(|o| vec![o.to_string()]).unwrap_or_default());
    if let Some(shared) = shared {
        let status = image_companion_status(model, shared, &Map::new(), false);
        for f in status.get("files").and_then(Value::as_array).into_iter().flatten() {
            if let Some(p) = f.get("path").filter(|p| nekko_js::truthy(Some(p))) {
                let role = if f.get("usingFallback") == Some(&Value::Bool(true)) {
                    "taesd".to_string()
                } else {
                    text(f.get("role"))
                };
                paths.insert(role, p.clone());
            }
        }
    }
    for (k, v) in beside {
        paths.insert(k, v);
    }
    for r in ROLES {
        if let Some(v) = preset.get(r).filter(|v| v.as_str().is_some_and(|s| !s.is_empty())) {
            paths.insert(r.into(), v.clone());
        }
    }
    let standalone_off = preset.get("standalone") == Some(&Value::Bool(false));
    let mut args = vec![
        if standalone_off { "--model" } else { "--diffusion-model" }.to_string(),
        text(model.get("path")),
        "--listen-ip".into(),
        "127.0.0.1".into(),
        "--listen-port".into(),
        port.to_string(),
    ];
    if let Some(family) = image_companion_set_for(model) {
        let has = |r: &str| paths.get(r).is_some_and(|v| nekko_js::truthy(Some(v)));
        let missing: Vec<String> = family["files"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|f| text(f.get("role")))
            .filter(|r| !(standalone_off && r == "vae"))
            .filter(|r| !(has(r) || (r == "vae" && has("taesd"))))
            .collect();
        if !missing.is_empty() {
            return Err(format!(
                "{} ({}) is missing {}. Download them from its image panel, or set their paths in image settings.",
                text(model.get("name")),
                text(family.get("label")),
                missing.join(", ")
            ));
        }
    }
    for key in ROLES {
        let Some(p) = paths.get(key).filter(|v| nekko_js::truthy(Some(v))).map(nekko_js::display) else { continue };
        if !std::fs::metadata(&p).is_ok_and(|m| m.is_file()) {
            return Err(format!("The {key} companion file does not exist: {p}"));
        }
        args.push(format!("--{key}"));
        args.push(p);
    }
    if truthy(&preset, "offloadToCpu") {
        args.push("--offload-to-cpu".into());
    }
    if truthy(&preset, "clipOnCpu") {
        args.push("--clip-on-cpu".into());
    }
    Ok(args)
}

/* ---------------------------------------------------------------- reasons */

/// Why a model cannot be loaded here (`unsupportedLoadReason`).
pub fn unsupported_load_reason(model: &Value) -> Option<String> {
    let name = model.get("name").filter(|n| !n.is_null()).map(nekko_js::display).unwrap_or_else(|| "This model".into());
    if str_of(model, "format") == Some("mlx") {
        return (!truthy(model, "mlxRunnable"))
            .then(|| format!("{name} is an MLX model, which runs on Apple Silicon Macs only."));
    }
    let modality = match model.get("modality").filter(|m| !m.is_null()) {
        Some(m) => nekko_js::display(m),
        None => model_modality(
            str_of(model, "architecture"),
            str_of(model, "name"),
            truthy(model, "hasProjector"),
            model.get("readable"),
        )
        .to_string(),
    };
    match modality.as_str() {
        "image" => Some(format!(
            "{name} is an image-generation model. The llama.cpp engine cannot serve it; it runs in stable-diffusion.cpp (the runtime LM Studio uses for image models)."
        )),
        "audio" => Some(format!(
            "{name} is a speech-recognition model, which llama.cpp cannot serve. It needs a speech engine such as whisper.cpp or parakeet.cpp."
        )),
        "draft" => Some(format!(
            "{name} is a speculative-decoding draft model. It can only run attached to its full model, not on its own."
        )),
        "unknown" => Some(format!(
            "{name} is not a readable GGUF{}, so the engine cannot serve it.",
            if model.get("readable") == Some(&Value::Bool(false)) {
                " (it may be an older GGML-format file)"
            } else {
                ""
            }
        )),
        _ => None,
    }
}

/// Whether an exit message says the process could not find a DLL (`isMissingDllExit`).
pub fn is_missing_dll_exit(message: Option<&str>) -> bool {
    message.is_some_and(|m| test(regex!(r"(?:-1073741515|3221225781|0xc0000135)\b", "i"), m))
}

/// What to tell a person whose engine died that way (`missingDllMessage`).
pub fn missing_dll_message(what: &str) -> String {
    format!(
        "{what} couldn't start because Windows is missing the Microsoft Visual C++ Runtime. Reinstall Nekko Agent, or install the runtime from https://aka.ms/vs/17/release/vc_redist.x64.exe (a 25 MB installer from Microsoft; you do not need Visual Studio)."
    )
}

/// A dead `llama-server`'s last output as a sentence that names the fix (`explainLoadError`).
pub fn explain_load_error(log: &[String]) -> String {
    let text = log.join("\n");
    let t = |p: &'static str| -> &'static Regex {
        // Each pattern compiled once, keyed by its text.
        static CACHE: OnceLock<std::sync::Mutex<std::collections::HashMap<&'static str, &'static Regex>>> =
            OnceLock::new();
        let cache = CACHE.get_or_init(Default::default);
        let mut c = cache.lock().unwrap();
        c.entry(p).or_insert_with(|| Box::leak(Box::new(re(p, "i"))))
    };
    if test(t(r"unknown (model )?arch|unsupported (model|arch)"), &text) {
        return "This engine build doesn't know this model's architecture. Update the engine under Models → Server, then try again.".into();
    }
    if test(t(r"bad magic|invalid magic|not a (valid )?gguf|gguf.*(version|format)|unsupported format"), &text) {
        return "The file isn't a GGUF this engine can read (it may be an older GGML-format model, or a different file type renamed .gguf).".into();
    }
    if test(t(r"mmproj|projector|clip model|clip_model"), &text) {
        return "This is a vision model and its projector file (mmproj-*.gguf) is missing next to the model. Fetch it from the model row, or re-download the model so the companion files come with it.".into();
    }
    if test(t(r"chat.?template|template.*not.*(supported|found)"), &text) {
        return "The model needs a chat template file and none was found. Re-download it (the template downloads with the model now) or pick a different build.".into();
    }
    if test(
        t(r"missing (required )?tensor|tensor .*missing|wrong number of tensors|check_tensor|unexpected tensor"),
        &text,
    ) {
        return "The file doesn't match what llama.cpp expects (a tensor is missing or unexpected). Re-download it, or pick a different build of the model.".into();
    }
    if test(
        t(
            r"out of memory|failed to allocate|insufficient|bad_alloc|CUDA_ERROR_OUT_OF_MEMORY|not enough (free )?memory",
        ),
        &text,
    ) {
        return "Not enough memory to load it. Lower the context size or GPU layers in the model's settings, or unload something else first.".into();
    }
    let group1 = |r: &Regex| r.find(&text).and_then(|m| m.group(1)).map(|g| text[g].to_string());
    let missing = group1(t(r#"(?:failed|unable|cannot|could not|error)[^\n]*(?:open|read|load|missing)[^\n'"`]*['"`]([^'"`\n]+\.(?:gguf|jinja|json|model|txt))['"`]"#))
        .or_else(|| group1(t(r#"(?:llama_model_load|error)[^\n]*(?:open|file)[^\n'"`]*['"`]([^'"`\n]+)['"`]"#)));
    let name = missing.map(|m| path::basename(nekko_js::trim(&m))).unwrap_or_default();
    if !name.is_empty() && name != "." {
        return format!(
            "A file the model needs is missing or unreadable: {name}. Re-download the model so its companion files come with it."
        );
    }
    let err_line = log.iter().find(|l| {
        test(t(r"error loading model|failed to load|unable to load|missing tensor|create_model"), l)
            && !test(t(r"cleaning up|exiting due to"), l)
    });
    if let Some(line) = err_line {
        let strip = |s: &str, p: &'static str| match t(p).find(s) {
            Some(m) => format!("{}{}", &s[..m.start()], &s[m.end()..]),
            None => s.to_string(),
        };
        let cleaned = strip(line, r"^[\d.\s]*(?:I|W|E)\s+\S+:\s*");
        let cleaned = strip(&cleaned, r"^llama_model_load[^:]*:\s*");
        let cleaned = strip(&cleaned, r"^error loading model[:\s]*");
        let cleaned = nekko_js::trim(&cleaned).to_string();
        if cleaned.encode_utf16().count() > 8 {
            let mut chars = cleaned.chars();
            let first = chars.next().map(|c| c.to_uppercase().collect::<String>()).unwrap_or_default();
            return format!("{first}{}", chars.as_str());
        }
    }
    let noise = t(r"cleaning up before exit|exiting due to|operator\(\)");
    let substantive: Vec<&String> = log.iter().filter(|l| !test(noise, l) && !nekko_js::trim(l).is_empty()).collect();
    let pool: Vec<&String> = if substantive.is_empty() { log.iter().collect() } else { substantive };
    pool[pool.len().saturating_sub(2)..].iter().map(|s| s.as_str()).collect::<Vec<_>>().join(" ")
}

/* ----------------------------------------------------- the engine facade */

/// One image request as stable-diffusion.cpp's server takes it, or why it is
/// refused (`imageGenerationBody`).
pub fn image_generation_body(request: &Value) -> Result<String, String> {
    let problem = || {
        "Use a prompt, dimensions from 256 to 2048 in multiples of 64, 1 to 100 steps and CFG from 0 to 30.".to_string()
    };
    // A destructuring default applies to `undefined` only.
    let or = |k: &str, d: Value| request.get(k).cloned().unwrap_or(d);
    let (steps, cfg, seed) = (or("steps", json!(28)), or("cfgScale", json!(4.5)), or("seed", json!(-1)));
    let int = |v: &Value| v.as_f64().is_some_and(|f| f.is_finite() && f.fract() == 0.0);
    let prompt = request.get("prompt").and_then(Value::as_str);
    let dims_ok = ["width", "height"].iter().all(|k| {
        request.get(*k).is_some_and(|v| {
            int(v) && (256.0..=2048.0).contains(&v.as_f64().unwrap()) && v.as_f64().unwrap() % 64.0 == 0.0
        })
    });
    let ok = prompt.is_some_and(|p| !nekko_js::trim(p).is_empty() && p.encode_utf16().count() <= 20_000)
        && dims_ok
        && int(&steps)
        && (1.0..=100.0).contains(&steps.as_f64().unwrap_or(0.0))
        && cfg.as_f64().is_some_and(|c| c.is_finite() && (0.0..=30.0).contains(&c))
        && int(&seed)
        && seed.as_f64().is_some_and(|s| s.abs() <= 9_007_199_254_740_991.0 && s >= -1.0);
    if !ok {
        return Err(problem());
    }
    let extra = nekko_js::stringify(
        &json!({ "sample_params": { "sample_steps": steps, "guidance": { "txt_cfg": cfg } }, "seed": seed }),
    );
    let mut body = Map::new();
    if let Some(m) = request.get("modelId") {
        body.insert("model".into(), m.clone());
    }
    let prompt = format!("{}\n<sd_cpp_extra_args>{extra}</sd_cpp_extra_args>", prompt.unwrap_or_default());
    body.insert("prompt".into(), json!(prompt));
    body.insert("size".into(), json!(format!("{}x{}", text(request.get("width")), text(request.get("height")))));
    body.insert("n".into(), json!(1));
    body.insert("output_format".into(), json!("png"));
    Ok(nekko_js::stringify(&Value::Object(body)))
}

/// The memory pool a model would be loaded into (`engineMemory`).
pub fn engine_memory(gpu: Option<&Value>, total_mem: f64) -> Value {
    match gpu.filter(|g| g.get("devices").and_then(Value::as_array).is_some_and(|d| !d.is_empty())) {
        Some(g) => json!({
            "budgetBytes": crate::num(nekko_js::to_number(g.get("totalMB")) * 1024.0 * 1024.0),
            "kind": if nekko_js::truthy(g.get("unified")) { "unified" } else { "vram" },
        }),
        None => json!({ "budgetBytes": crate::num(total_mem), "kind": "ram" }),
    }
}

/// Whether an engine settings change re-serves the listener (`reservesEndpoint`).
pub fn reserves_endpoint(patch: &Value) -> bool {
    ["port", "bind", "apiKey", "corsOrigins"].iter().any(|k| patch.get(*k).is_some())
}
