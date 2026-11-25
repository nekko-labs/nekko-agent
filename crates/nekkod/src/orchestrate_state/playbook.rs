//! Reviewed editorial defaults for Orchestrate, not provider capability data.
//! Exact rows are adapter-scoped literal IDs. A recognizable spelling on a
//! different adapter, or an unlisted variant, never inherits exact status.

use nekko_agent::types::ProviderKind;
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Book {
    Grounded,
    Code,
    Visual,
    Triage,
    Review,
    ToolEvidence,
}

impl Book {
    /// One additional instruction per role. These are collaboration habits,
    /// not claims about context, tool support, or how a model reasons.
    fn guidance(self, worker: bool) -> &'static str {
        match (self, worker) {
            (Self::Grounded, false) => {
                "Specify which input each assignment should use and what observation would settle it."
            }
            (Self::Grounded, true) => {
                "Name the input that supports your finding and distinguish it from your interpretation."
            }
            (Self::Code, false) => {
                "Give code assignments a file or component boundary and a regression check; inspect the combined diff."
            }
            (Self::Code, true) => {
                "For code work, name the affected files and report the check you ran, or why it could not run."
            }
            (Self::Visual, false) => {
                "For visual work, ask for a specific region or feature to check and keep observations separate from interpretation."
            }
            (Self::Visual, true) => {
                "If an image is available, cite the visible detail and its location; call out anything you could not inspect."
            }
            (Self::Triage, false) => {
                "Frame triage around one decision with a short list of outcomes and an explicit uncertain outcome."
            }
            (Self::Triage, true) => {
                "For triage, report the selected outcome and the observation that supports it, or say it is uncertain."
            }
            (Self::Review, false) => {
                "Give each reviewer an acceptance criterion; resolve conflicting findings against the underlying evidence."
            }
            (Self::Review, true) => "Report which acceptance criteria were met and which still lack evidence.",
            (Self::ToolEvidence, false) => {
                "Specify which results need direct verification; separate worker claims from observed tool results."
            }
            (Self::ToolEvidence, true) => {
                "For tool-backed work, cite the relevant output and mark any proposed but unrun checks as unverified."
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Selection {
    Exact(Book),
    Family(Book),
    Neutral,
}

impl Selection {
    pub(super) fn render(self, worker: bool) -> String {
        let (label, book) = match self {
            Self::Exact(book) => ("curated exact ID", book),
            Self::Family(book) => ("inferred family", book),
            Self::Neutral => {
                let rule = if worker {
                    "Name any needed input or tool you were not given."
                } else {
                    "Scope assignments to available inputs; do not assume a model can use an input or tool."
                };
                return format!("\nBuilt-in model playbook (neutral fallback): {rule}");
            }
        };
        format!("\nBuilt-in model playbook ({label}): {}", book.guidance(worker))
    }
}

use Book::{Code, Grounded, Review, ToolEvidence, Triage, Visual};

// Bundled recommendation feed, not the live/downloaded feed. Router and
// coding tasks in that feed inform the book; modality advice is conditional.
const LOCAL_IDS: &[(Book, &[&str])] = &[
    (Grounded, &["qwen3.8-27b", "qwen3.6-35b-a3b"]),
    (ToolEvidence, &["gpt-oss-120b"]),
    (Visual, &["gemma-4-26b-a4b", "gemma-4-12b", "gemma-4-e4b", "qwen3.5-9b", "qwen3.5-4b"]),
    (Triage, &["qwen3.5-2b", "qwen3.5-0.8b"]),
    (Code, &["qwen3-coder-next", "qwen3-coder-30b-a3b", "devstral-small-2-24b"]),
];

// Anthropic Messages fallback catalogs. Group shared literal IDs without
// treating cloud-platform spellings as interchangeable.
const CLAUDE_COMMON: &[&str] = &[
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-sonnet-5-5",
    "claude-sonnet-5",
    "claude-fable-5-1",
    "claude-haiku-5-5",
];
const BEDROCK_IDS: &[&str] = &[
    "anthropic.claude-opus-5-5",
    "anthropic.claude-opus-5",
    "anthropic.claude-opus-4-8",
    "anthropic.claude-opus-4-7",
    "anthropic.claude-sonnet-5-5",
    "anthropic.claude-sonnet-5",
    "anthropic.claude-fable-5-1",
    "anthropic.claude-fable-5",
    "anthropic.claude-haiku-5-5",
    "anthropic.claude-haiku-4-5",
];

// Reviewed examples from the pricing snapshot / adapter sources. These
// adapters discover their catalog live; the examples are not default lists,
// and a match does not attest account access or the server's actual weights.
const OPENAI_IDS: &[(Book, &[&str])] = &[
    (
        ToolEvidence,
        &["gpt-5", "gpt-5-mini", "gpt-5.4", "gpt-6.1-sol", "gpt-4.1", "gpt-4o", "gpt-4o-mini", "o3", "o4-mini"],
    ),
    (Code, &["gpt-5.3-codex", "gpt-5.2-codex"]),
];
const CHATGPT_IDS: &[(Book, &[&str])] = &[(ToolEvidence, &["gpt-6.1-sol", "gpt-6-sol", "gpt-6-astra", "gpt-6-luna"])];
const OPENROUTER_IDS: &[(Book, &[&str])] = &[
    (Review, &["anthropic/claude-sonnet-5.5", "anthropic/claude-opus-5.5"]),
    (Triage, &["anthropic/claude-haiku-5.5"]),
    (ToolEvidence, &["openai/gpt-6.1-sol", "openai/gpt-5.4", "openai/gpt-5", "deepseek/deepseek-v4-pro"]),
    (Code, &["openai/gpt-5.3-codex", "mistralai/devstral-2512"]),
    (
        Visual,
        &[
            "google/gemini-2.5-pro",
            "google/gemini-2.5-flash",
            "google/gemini-3.1-pro-preview",
            "google/gemma-4-26b-a4b-it",
        ],
    ),
    (Grounded, &["qwen/qwen3.8-27b", "qwen/qwen3.6-35b-a3b", "meta-llama/llama-3.3-70b-instruct"]),
];
const GEMINI_IDS: &[(Book, &[&str])] = &[(Visual, &["gemini-2.5-pro", "gemini-2.5-flash", "gemini-3.1-pro-preview"])];

fn exact(rows: &[(Book, &[&str])], id: &str) -> Option<Book> {
    rows.iter().find_map(|(book, ids)| ids.contains(&id).then_some(*book))
}

// Managed GGUF downloads are served by the model server under a relative
// library ID, without .gguf (engine acquire.rs + library.rs). Only accept the
// feed's original repo and first file of each listed quant, not arbitrary
// folders, quantizations, filenames or shards. MLX/imports are name hints.
fn managed_local(id: &str) -> Option<Book> {
    if let Some(book) = exact(LOCAL_IDS, id) {
        return Some(book);
    }
    let (kind, path) = id.split_once('/')?;
    if !matches!(kind, "chat" | "vision") {
        return None;
    }
    let (folder, name) = path.split_once('/')?;
    for model in &nekko_machine::bundled_feed().models {
        if let Some(book) = exact(LOCAL_IDS, &model.id)
            && model.repo.replacen('/', "_", 1) == folder
            && model.quants.iter().any(|q| q.files.first().and_then(|f| f.strip_suffix(".gguf")) == Some(name))
        {
            return Some(book);
        }
    }
    None
}

#[derive(Clone, Copy)]
enum Catalog {
    Claude(ProviderKind),
    OpenAi,
    ChatGpt,
    OpenRouter,
    Gemini,
    ManagedLocal,
    Ollama,
    Compat,
    Discovered,
}

impl Catalog {
    fn for_provider(kind: ProviderKind, provider: &Value) -> Option<Self> {
        use ProviderKind::*;
        Some(match kind {
            Anthropic | Bedrock | Vertex | Foundry => Self::Claude(kind),
            Openai => Self::OpenAi,
            Chatgpt => Self::ChatGpt,
            Openrouter => Self::OpenRouter,
            Llamacpp => Self::ManagedLocal,
            Ollama => Self::Ollama,
            Lmstudio | Vllm => Self::Discovered,
            OpenaiCompat
                if nekko_turn::providers::provider_endpoint(provider).is_some_and(|url| {
                    url.scheme() == "https" && url.host_str() == Some("generativelanguage.googleapis.com")
                }) =>
            {
                Self::Gemini
            }
            // Ollama Cloud likewise has no fixed list; its tags match the local family rules.
            OpenaiCompat => Self::Compat,
            ClaudeCode => return None,
        })
    }

    fn exact(self, id: &str) -> Option<Book> {
        use ProviderKind::*;
        let claude = |extra: &[&str]| (CLAUDE_COMMON.contains(&id) || extra.contains(&id)).then(|| claude_book(id));
        match self {
            Self::Claude(Anthropic) => claude(&["claude-sonnet-4-6", "claude-fable-5-2", "claude-haiku-4-5-20251001"]),
            Self::Claude(Bedrock) => BEDROCK_IDS.contains(&id).then(|| claude_book(id)),
            Self::Claude(Vertex) => claude(&["claude-sonnet-4-6", "claude-haiku-4-5@20251001"]),
            Self::Claude(Foundry) => claude(&["claude-haiku-4-5"]),
            Self::Claude(_) | Self::Discovered | Self::Compat => None,
            Self::OpenAi => exact(OPENAI_IDS, id),
            Self::ChatGpt => exact(CHATGPT_IDS, id),
            Self::OpenRouter => exact(OPENROUTER_IDS, id),
            Self::Gemini => exact(GEMINI_IDS, id),
            Self::ManagedLocal => managed_local(id),
            // Literal /api/tags IDs exercised by the adapter catalog fixtures.
            Self::Ollama => ["llama3:8b", "qwen3:8b"].contains(&id).then_some(Grounded),
        }
    }

    fn family(self, id: &str) -> Option<Book> {
        match self {
            Self::Claude(ProviderKind::Bedrock) => {
                let id = ["us.", "eu.", "apac.", "au.", "jp.", "global."]
                    .into_iter()
                    .find_map(|region| id.strip_prefix(region))
                    .unwrap_or(id);
                claude_family(id.strip_prefix("anthropic.")?)
            }
            Self::Claude(_) => claude_family(id),
            Self::OpenAi | Self::ChatGpt => gpt_family(id),
            Self::Gemini => numbered(id.strip_prefix("models/").unwrap_or(id), "gemini-").then_some(Visual),
            Self::Compat => Self::OpenRouter
                .family(id)
                .or_else(|| gpt_family(id))
                .or_else(|| claude_family(id))
                .or_else(|| Self::Gemini.family(id))
                .or_else(|| local_family(id.rsplit('/').next()?)),
            Self::ManagedLocal | Self::Ollama | Self::Discovered => local_family(id.rsplit('/').next()?),
            Self::OpenRouter => {
                let (publisher, name) = id.split_once('/')?;
                match publisher {
                    "anthropic" => claude_family(name),
                    "openai" => gpt_family(name).or_else(|| prefix(name, "gpt-oss").then_some(ToolEvidence)),
                    "google" if numbered(name, "gemini-") => Some(Visual),
                    "google" | "qwen" | "deepseek" | "meta-llama" | "mistralai" => {
                        // Do not infer a family across publishers (e.g. `google/qwen3`).
                        let stem = match publisher {
                            "google" => "gemma",
                            "qwen" => "qwen",
                            "deepseek" => "deepseek-",
                            "meta-llama" => "llama",
                            _ => "devstral",
                        };
                        name.starts_with(stem).then(|| local_family(name)).flatten()
                    }
                    _ => None,
                }
            }
        }
    }
}

fn numbered(id: &str, stem: &str) -> bool {
    id.strip_prefix(stem).is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_digit()))
}

// Match a whole stem, not an incidental substring such as `my-qwen3`.
fn prefix(id: &str, stem: &str) -> bool {
    id.strip_prefix(stem).is_some_and(|rest| rest.is_empty() || rest.starts_with(['.', '-', ':', '_']))
}

fn claude_book(id: &str) -> Book {
    // A narrow triage checklist for the Haiku tier; no claims about performance.
    if id.strip_prefix("anthropic.").unwrap_or(id).starts_with("claude-haiku-") { Triage } else { Review }
}

fn claude_family(id: &str) -> Option<Book> {
    ["claude-opus-", "claude-sonnet-", "claude-haiku-", "claude-fable-", "claude-mythos-"]
        .into_iter()
        .any(|stem| numbered(id, stem))
        .then(|| claude_book(id))
}

fn gpt_family(id: &str) -> Option<Book> {
    (numbered(id, "gpt-") || ["o1", "o3", "o4"].into_iter().any(|stem| prefix(id, stem)))
        .then(|| if id.split(['-', ':']).any(|part| part == "codex") { Code } else { ToolEvidence })
}

fn local_family(id: &str) -> Option<Book> {
    [
        (Code, &["qwen3-coder", "devstral"][..]),
        (Visual, &["gemma4", "gemma-4"]),
        (ToolEvidence, &["gpt-oss", "deepseek-r1", "deepseek-v3", "deepseek-v4", "deepseek-chat", "deepseek-reasoner"]),
        (
            Grounded,
            &["qwen2.5", "qwen3", "gemma2", "gemma3", "gemma-2", "gemma-3", "llama3", "llama-3", "llama4", "llama-4"],
        ),
    ]
    .into_iter()
    .find_map(|(book, stems)| stems.iter().any(|stem| prefix(id, stem)).then_some(book))
}

/// Match only short, token-like admitted IDs. Inferred matches may use case
/// folding for filenames and tags. No request, new catalog lookup, or model
/// id/host interpolation is involved. Non-chat name markers skip inference.
const MAX_MATCH_BYTES: usize = 256;

pub(super) fn select(kind: ProviderKind, provider: &Value, id: &str) -> Option<Selection> {
    let catalog = Catalog::for_provider(kind, provider)?;
    if id.len() > MAX_MATCH_BYTES
        || id.split('/').any(|p| p.is_empty() || matches!(p, "." | ".."))
        || id.contains("://")
        || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.:/@".contains(&b))
    {
        return Some(Selection::Neutral);
    }
    if let Some(book) = catalog.exact(id) {
        return Some(Selection::Exact(book));
    }
    let id = id.to_ascii_lowercase();
    let non_chat = id
        .split(['-', '_', ':', '/', '.'])
        .any(|part| matches!(part, "image" | "embed" | "embedding" | "tts" | "audio" | "guard" | "rerank" | "asr"));
    Some(if non_chat { Selection::Neutral } else { catalog.family(&id).map_or(Selection::Neutral, Selection::Family) })
}

#[cfg(test)]
mod tests;
