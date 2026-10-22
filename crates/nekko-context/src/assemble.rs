//! `assembleContext` and `renderContextBlock` (packages/core/src/context/assembler.ts).

use nekko_js as js;
use serde_json::{Map, Value, json};
use std::collections::HashSet;

#[derive(Default)]
pub struct AssembleInput<'a> {
    /// Files the user attached: (path, content).
    pub attached: Vec<(String, String)>,
    /// Guideline files from the workspace roots: (path, content).
    pub guidelines: Vec<(String, String)>,
    /// Indexes of the project rules left out of the context: (folder, text).
    pub rule_indexes: Vec<(String, String)>,
    /// Memory notes, as `parse_memory` returns them.
    pub memory: Vec<Value>,
    /// Connector snippets: (label, origin, body).
    pub connector_snippets: Vec<(String, String, String)>,
    /// Workspace search snippets: (relPath, path, body).
    pub index_snippets: Vec<(String, String, String)>,
    /// The transcript, so the window counts it.
    pub history: Option<&'a [Value]>,
    /// The base system prompt, counted but never rendered into the block.
    pub system_text: Option<&'a str>,
    pub context_window: Option<Value>,
    pub excluded: HashSet<String>,
    pub pinned: HashSet<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    pub id: String,
    pub source: &'static str,
    pub label: String,
    pub origin: String,
    pub tokens: u64,
    pub pinned: bool,
    pub included: bool,
    pub preview: String,
}

impl Item {
    /// The `ContextItem` object, keys in the TS order.
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id, "source": self.source, "label": self.label, "origin": self.origin,
            "tokens": self.tokens, "pinned": self.pinned, "included": self.included, "preview": self.preview,
        })
    }
}

pub struct Bundle {
    pub items: Vec<Item>,
    pub total_tokens: u64,
    pub context_window: Option<Value>,
    /// The full text behind each item, by id (never sent to the renderer).
    pub contents: Vec<(String, String)>,
}

impl Bundle {
    /// The `ContextBundle` the Context Inspector gets: no `contents`.
    pub fn to_json(&self) -> Value {
        let mut o = Map::new();
        o.insert("items".into(), Value::Array(self.items.iter().map(Item::to_json).collect()));
        o.insert("totalTokens".into(), json!(self.total_tokens));
        if let Some(w) = &self.context_window {
            o.insert("contextWindow".into(), w.clone());
        }
        Value::Object(o)
    }

    fn content(&self, id: &str) -> Option<&str> {
        // A Map: a later item with the same id replaced the earlier one.
        self.contents.iter().rev().find(|(k, _)| k == id).map(|(_, v)| v.as_str())
    }
}

/// `estimateTokens`.
fn tokens(text: &str) -> u64 {
    (js::len16(text).div_ceil(4)).max(1) as u64
}

/// `preview(text, 160)`: whitespace folded, trimmed, capped.
fn preview(text: &str) -> String {
    js::cap(js::trim(&js::fold_space(text)), 160)
}

/// `basename` in assembler.ts: the text after the last slash or backslash.
fn basename(p: &str) -> String {
    p.rsplit(['/', '\\']).next().unwrap_or(p).to_string()
}

fn field<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

/// `historyText` (context.ts), the same function the session summary uses.
fn history_text(m: &Value) -> String {
    let mut parts: Vec<String> = vec![field(m, "content").to_string()];
    for call in m.get("toolCalls").and_then(Value::as_array).into_iter().flatten() {
        parts.push(field(call, "name").to_string());
        if let Some(input) = call.get("input") {
            parts.push(js::stringify(input));
        }
    }
    let result = m.get("toolResult").and_then(|r| r.get("output")).and_then(Value::as_str).unwrap_or("");
    if !result.is_empty() {
        parts.push(result.to_string());
    }
    parts.retain(|p| !p.is_empty());
    parts.join("\n")
}

pub fn assemble(input: AssembleInput) -> Bundle {
    let mut items = Vec::new();
    let mut contents = Vec::new();
    let mut push = |source: &'static str, id: String, label: String, origin: String, content: &str| {
        let included = !input.excluded.contains(&id);
        let pinned = input.pinned.contains(&id);
        contents.push((id.clone(), content.to_string()));
        items.push(Item {
            id,
            source,
            label,
            origin,
            tokens: tokens(content),
            pinned,
            included,
            preview: preview(content),
        });
    };
    let mut fixed = Vec::new();
    if let Some(system) = input.system_text.filter(|s| !s.is_empty()) {
        fixed.push(Item {
            id: "system:base".into(),
            source: "system",
            label: "System prompt".into(),
            origin: "Nekko Agent".into(),
            tokens: tokens(system),
            pinned: false,
            included: true,
            preview: preview(system),
        });
    }
    if let Some(history) = input.history.filter(|h| !h.is_empty()) {
        let convo = history.iter().map(history_text).collect::<Vec<_>>().join("\n");
        let n = history.len();
        fixed.push(Item {
            id: "conversation".into(),
            source: "conversation",
            label: format!("Conversation ({n} message{})", if n == 1 { "" } else { "s" }),
            origin: "chat".into(),
            tokens: tokens(&convo),
            pinned: false,
            included: true,
            preview: preview(&convo),
        });
    }
    for (path, content) in &input.guidelines {
        push("guideline", format!("guideline:{path}"), basename(path), path.clone(), content);
    }
    for (root, text) in &input.rule_indexes {
        push("guideline", format!("guideline:rules:{root}"), "Project rules index".into(), root.clone(), text);
    }
    for (path, content) in &input.attached {
        push("attached-file", format!("file:{path}"), basename(path), path.clone(), content);
    }
    for m in &input.memory {
        let scope = field(m, "scope");
        push(
            "memory",
            format!("mem:{}", field(m, "id")),
            field(m, "title").to_string(),
            format!("memory/{scope}"),
            field(m, "body"),
        );
    }
    for (label, origin, body) in &input.connector_snippets {
        push("connector", format!("conn:{origin}"), label.clone(), origin.clone(), body);
    }
    for (rel, path, body) in &input.index_snippets {
        push("index-snippet", format!("idx:{path}"), rel.clone(), path.clone(), body);
    }
    fixed.extend(items);
    let total = fixed.iter().filter(|i| i.included).map(|i| i.tokens).sum();
    Bundle { items: fixed, total_tokens: total, context_window: input.context_window, contents }
}

/// `renderContextBlock`: the included sources, each under its header.
pub fn render_block(bundle: &Bundle) -> String {
    let mut parts = Vec::new();
    for item in bundle.items.iter().filter(|i| i.included) {
        if matches!(item.source, "system" | "conversation" | "skill") {
            continue;
        }
        let body = bundle.content(&item.id).unwrap_or(&item.preview);
        let header = match item.source {
            "guideline" => format!("# Guideline: {}", item.label),
            "memory" => format!("# Memory: {}", item.label),
            "connector" => format!("# {} ({})", item.label, item.origin),
            _ => format!("# File: {}", item.origin),
        };
        parts.push(format!("{header}\n{body}"));
    }
    parts.join("\n\n---\n\n")
}
