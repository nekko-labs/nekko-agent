//! Where the other model apps keep their models, and the nekko-owned sidecar
//! store. Ports of `packages/host/src/engine/folders.ts` and `companions.ts`,
//! held to them by `tests/golden/library.json`.

use nekko_tools::path::native as path;
use serde_json::{Value, json};

/// One app's candidate folders, best first (`knownFolderCandidates`).
pub struct Candidate {
    pub provider: &'static str,
    pub paths: Vec<String>,
}

impl Candidate {
    pub fn to_value(&self) -> Value {
        json!({ "provider": self.provider, "paths": self.paths })
    }
}

/// `knownFolderCandidates(os)` for a home directory and an environment
/// (`process.env`, where an empty value counts as unset).
pub fn known_candidates(os: &str, home: &str, env: &dyn Fn(&str) -> Option<String>) -> Vec<Candidate> {
    let var = |k: &str| env(k).filter(|v| !v.is_empty());
    let j = |parts: &[&str]| path::join(parts);
    let win = os == "win32";
    let mac = os == "darwin";
    let local_app_data = || var("LOCALAPPDATA").unwrap_or_else(|| j(&[home, "AppData", "Local"]));
    let app_data = || var("APPDATA").unwrap_or_else(|| j(&[home, "AppData", "Roaming"]));

    let ollama = match var("OLLAMA_MODELS") {
        Some(dir) => vec![dir],
        None if win => vec![j(&[&local_app_data(), "Ollama", "models"]), j(&[home, ".ollama", "models"])],
        None => vec![j(&[home, ".ollama", "models"]), "/usr/share/ollama/.ollama/models".into()],
    };
    let lmstudio = vec![j(&[home, ".lmstudio", "models"]), j(&[home, ".cache", "lm-studio", "models"])];
    let gpt4all = if win {
        vec![j(&[&local_app_data(), "nomic.ai", "GPT4All"])]
    } else if mac {
        vec![j(&[home, "Library", "Application Support", "nomic.ai", "GPT4All"])]
    } else {
        vec![j(&[home, ".local", "share", "nomic.ai", "GPT4All"])]
    };
    let jan = if win {
        vec![j(&[&app_data(), "Jan", "data", "models"]), j(&[home, "jan", "models"])]
    } else if mac {
        vec![j(&[home, "Library", "Application Support", "Jan", "data", "models"]), j(&[home, "jan", "models"])]
    } else {
        vec![j(&[home, ".config", "Jan", "data", "models"]), j(&[home, "jan", "models"])]
    };
    let hf_cache = match (var("HF_HOME"), var("HUGGINGFACE_HUB_CACHE")) {
        (Some(hf), _) => vec![j(&[&hf, "hub"])],
        (None, Some(cache)) => vec![cache],
        _ => vec![j(&[home, ".cache", "huggingface", "hub"])],
    };
    let mut vllm = hf_cache.clone();
    vllm.push(j(&[home, ".cache", "vllm"]));
    vec![
        Candidate { provider: "ollama", paths: ollama },
        Candidate { provider: "lmstudio", paths: lmstudio },
        Candidate { provider: "jan", paths: jan },
        Candidate { provider: "gpt4all", paths: gpt4all },
        Candidate {
            provider: "llamacpp",
            paths: vec![j(&[home, ".cache", "llama.cpp"]), j(&[home, "llama.cpp", "models"])],
        },
        Candidate { provider: "huggingface", paths: hf_cache },
        // vLLM serves whatever is in the HF cache; the row says so.
        Candidate { provider: "vllm", paths: vllm },
        Candidate {
            provider: "koboldcpp",
            paths: vec![j(&[home, "koboldcpp", "models"]), j(&[home, ".koboldcpp", "models"])],
        },
        Candidate {
            provider: "textgenwebui",
            paths: vec![
                j(&[home, "text-generation-webui", "models"]),
                j(&[home, "text-generation-webui", "user_data", "models"]),
            ],
        },
        Candidate {
            provider: "localai",
            paths: vec![j(&[home, ".local", "share", "local-ai", "models"]), "/build/models".into()],
        },
        Candidate {
            provider: "bionic",
            paths: vec![j(&[home, ".bionic", "models"]), j(&[home, "bionic-gpt", "models"])],
        },
    ]
}

/// This machine's candidates: Node's `os.homedir()` and `process.env`.
pub fn machine_candidates() -> Vec<Candidate> {
    let os = if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    known_candidates(os, &home_dir(), &|k| std::env::var(k).ok())
}

/// `os.homedir()`, `.` when it is unset.
pub fn home_dir() -> String {
    Some(nekko_js::home_dir_string()).filter(|h| !h.is_empty()).unwrap_or_else(|| ".".into())
}

/// A stable id for a folder row (`folderId`).
pub fn folder_id(provider: Option<&str>, p: &str) -> String {
    if let Some(provider) = provider.filter(|p| !p.is_empty()) {
        return provider.to_string();
    }
    // `.replace(/[\\/]+/g, '-').replace(/[^A-Za-z0-9._-]/g, '').replace(/^-+|-+$/g, '').toLowerCase()`
    let mut dashed = String::new();
    let mut in_sep = false;
    for c in p.chars() {
        if c == '\\' || c == '/' {
            if !in_sep {
                dashed.push('-');
            }
            in_sep = true;
        } else {
            in_sep = false;
            dashed.push(c);
        }
    }
    let kept: String = dashed.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')).collect();
    let slug = kept.trim_matches('-').to_ascii_lowercase();
    let tail = &slug[slug.len().saturating_sub(48)..];
    format!("dir-{}", if tail.is_empty() { "custom" } else { tail })
}

/// A folder row for a known provider at a path (`knownFolder`).
pub fn known_folder(provider: &str, p: &str) -> Value {
    json!({ "id": folder_id(Some(provider), p), "path": p, "provider": provider, "enabled": true })
}

/// Where fetched sidecars live for a model we do not write beside
/// (`companionsDir`): `<models>/.companions/<first 12 hex of sha1(id)>`.
pub fn companions_dir(models_dir: &str, model_id: &str) -> String {
    path::join(&[models_dir, ".companions", &companions_key(model_id)])
}

/// The directory name of a model's sidecar store.
pub fn companions_key(model_id: &str) -> String {
    use sha1::{Digest, Sha1};
    let digest = Sha1::digest(model_id.as_bytes());
    digest.iter().take(6).map(|b| format!("{b:02x}")).collect()
}
