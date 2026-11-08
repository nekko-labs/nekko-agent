//! The tool definitions sent to the model, as `BUILTIN_TOOLS` in
//! `packages/core/src/agent/tools.ts` declares them (the ported subset).

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// A tool as the model sees it: `ToolSpec` from `providers/types.ts`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    /// JSON Schema for the input.
    pub parameters: Value,
}

/// The tools this crate executes, in `BUILTIN_TOOLS` order.
pub const PORTED_TOOLS: &[&str] = &["read_file", "write_file", "edit_file", "glob", "grep", "list_dir", "bash"];

/// Built-in tools that still run in the TS host: `browser` and `spawn_agent`
/// from `BUILTIN_TOOLS`, and the session-scoped extras (`ask_user`,
/// `update_plan`, `report_experiment`, `report_artifact`, `decide`).
pub const NOT_PORTED: &[&str] =
    &["browser", "spawn_agent", "ask_user", "update_plan", "report_experiment", "report_artifact", "decide"];

pub fn is_ported(name: &str) -> bool {
    PORTED_TOOLS.contains(&name)
}

fn spec(name: &str, description: &str, parameters: Value) -> ToolSpec {
    ToolSpec { name: name.into(), description: description.into(), parameters }
}

/// The specs for [`PORTED_TOOLS`], word for word.
pub fn builtin_tools() -> Vec<ToolSpec> {
    vec![
        spec(
            "read_file",
            "Read a file at an absolute or chat-project-relative path. Large files are truncated; use start_line and end_line (1-based, inclusive) to read later sections with line numbers.",
            json!({
                "type": "object",
                "properties": { "path": { "type": "string", "description": "Path to the file." },
                    "start_line": { "type": "integer", "minimum": 1, "description": "First line to read (1-based). Omit to read from the beginning." },
                    "end_line": { "type": "integer", "minimum": 1, "description": "Last line to read (inclusive). Defaults to 200 lines from start_line." } },
                "required": ["path"],
            }),
        ),
        spec(
            "write_file",
            "Create or overwrite a file with the given contents.",
            json!({
                "type": "object",
                "properties": { "path": { "type": "string" }, "content": { "type": "string" } },
                "required": ["path", "content"],
            }),
        ),
        spec(
            "edit_file",
            "Replace exact text in one file. Use old_string/new_string for one replacement, or edits for 1-100 ordered literal replacements validated together before writing. Never mix the two forms. Every search must be non-empty and unique at its step. A batch is limited to 8 MiB of input, replacements and result; validation failure writes nothing. This is not multi-file rollback or protection from concurrent writers.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "old_string": { "type": "string", "description": "Exact text to replace (must be unique)." },
                    "new_string": { "type": "string" },
                    "edits": {"type":"array","minItems":1,"maxItems":100,"description":"Ordered literal replacements; all must succeed before the file is written.","items":{"type":"object","properties":{"old_string":{"type":"string","minLength":1},"new_string":{"type":"string"}},"required":["old_string","new_string"]}},
                },
                "required": ["path"],
            }),
        ),
        spec(
            "glob",
            "Find files matching a glob pattern within the chat project or an explicit directory.",
            json!({
                "type": "object",
                "properties": { "pattern": { "type": "string", "description": "e.g. src/**/*.ts" }, "path": { "type": "string", "description": "Optional directory. Defaults to the chat project." } },
                "required": ["pattern"],
            }),
        ),
        spec(
            "grep",
            "Search file contents with a regular expression.",
            json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string" },
                    "path": { "type": "string", "description": "Optional file or directory to scope the search. Defaults to the chat project." },
                },
                "required": ["pattern"],
            }),
        ),
        spec(
            "list_dir",
            "List the entries of a directory.",
            json!({
                "type": "object",
                "properties": { "path": { "type": "string" } },
                "required": ["path"],
            }),
        ),
        spec(
            "bash",
            "Run a command in the chat project and wait for it. Windows uses cmd.exe, not Bash or PowerShell; wrap PowerShell commands with powershell -NoProfile -Command. Unix uses /bin/sh. Subject to guardrails, risky commands require user approval. Killed after 120 seconds: for a dev server, a watcher, or anything that keeps running, use start_process instead of backgrounding it yourself.",
            json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string" },
                    "cwd": { "type": "string", "description": "Optional working directory." },
                },
                "required": ["command"],
            }),
        ),
    ]
}
