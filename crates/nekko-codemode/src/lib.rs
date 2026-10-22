//! Code mode: a chat's tools as code instead of as a tool list.
//!
//! With the tool list, every tool's JSON Schema rides along on every model
//! call, and every result comes back through the model's context, even the
//! ones it only needed to filter or pass along. In code mode the model is
//! offered two tools instead of the many it would otherwise see:
//!
//! - `search_tools` returns the TypeScript declarations of the tools that
//!   match a query, so a tool's schema enters the context only once, and only
//!   when the model asks for it;
//! - `run_code` runs an async JavaScript body in a QuickJS sandbox where each
//!   tool is `await tools.<name>(input)`. Loops, filtering and joins happen in
//!   the script; only what it returns reaches the model.
//!
//! The tools that talk to the user or change the chat itself (`ask_user`,
//! `update_plan`, the title, completion, sub-agents) stay direct calls: they
//! are what the transcript shows, and they are cheap.
//!
//! [`Tally`] keeps an estimate of what this saves, in the same ~4 characters a
//! token rule the rest of the app uses (`estimateTokens`).

pub mod decl;
pub mod run;

use serde_json::{Value, json};
use std::sync::Mutex;

pub use run::{CallRecord, Limits, Outcome};

pub const SEARCH_TOOLS: &str = "search_tools";
pub const RUN_CODE: &str = "run_code";

/// Tools that stay direct calls in code mode.
pub const DIRECT: &[&str] = &[
    "ask_user",
    "update_plan",
    "set_chat_title",
    "complete_session",
    "spawn_agent",
    "delegation_targets",
    "report_experiment",
    "report_artifact",
];

/// Above this many estimated tokens, `run_code`'s index lists names only.
const INDEX_BUDGET: u64 = 1_200;

/// `estimateTokens`: about four UTF-16 code units a token.
pub fn tokens(text: &str) -> u64 {
    (nekko_js::len16(text).div_ceil(4)).max(1) as u64
}

fn name(t: &Value) -> &str {
    t.get("name").and_then(Value::as_str).unwrap_or_default()
}

/// The turn's tools split into those offered directly and those code reaches.
pub fn split(tools: Vec<Value>) -> (Vec<Value>, Vec<Value>) {
    tools.into_iter().partition(|t| DIRECT.contains(&name(t)))
}

/// The tools a code-mode turn offers: the direct ones, then `search_tools`
/// and `run_code` when there is anything for code to call.
pub fn offer(direct: Vec<Value>, wrapped: &[Value]) -> Vec<Value> {
    if wrapped.is_empty() {
        return direct;
    }
    let mut tools = direct;
    let [search, run] = specs(wrapped);
    // Ahead of the chat tools, where the wrapped ones stood.
    let at = tools.iter().position(|t| name(t) == "update_plan").unwrap_or(tools.len());
    tools.splice(at..at, [search, run]);
    tools
}

/// `search_tools` and `run_code`, with `run_code` naming what it can call.
pub fn specs(wrapped: &[Value]) -> [Value; 2] {
    let search = json!({
        "name": SEARCH_TOOLS,
        "description": "Find the tools run_code can call and see their TypeScript signatures. Search before calling a tool you have not seen the signature of. An empty query lists every tool.",
        "parameters": { "type": "object", "properties": {
            "query": { "type": "string", "description": "Words to match against tool names and descriptions, e.g. \"github pull request\"." },
            "limit": { "type": "integer", "description": "Most tools to return. Default 8." },
        } },
    });
    let run = json!({
        "name": RUN_CODE,
        "description": format!(
            "Run JavaScript (not TypeScript) as the body of an async function. Call tools with `await tools.<name>(input)`: each returns the tool's output as a string (JSON.parse it when it is JSON) and throws a ToolError when the tool fails. Calls run one at a time. Use loops and filters to do several steps in one run, and `return` only what you need: the return value (JSON-encoded unless a string) and console.log lines are all you see. No network, files, modules or timers except through tools; each call is approved and guarded like a direct call. Tools:\n{}",
            index(wrapped)
        ),
        "parameters": { "type": "object", "required": ["code"], "properties": {
            "code": { "type": "string", "description": "The function body. Example: const hits = await tools.grep({ pattern: 'TODO' }); return hits.split('\\n').length;" },
        } },
    });
    [search, run]
}

/// One line a tool, with its first sentence while that stays small.
fn index(wrapped: &[Value]) -> String {
    let full: Vec<String> = wrapped.iter().map(|t| format!("- {}: {}", name(t), decl::summary(t, 100))).collect();
    let full = full.join("\n");
    if tokens(&full) <= INDEX_BUDGET {
        return full;
    }
    wrapped.iter().map(name).collect::<Vec<_>>().join(", ")
}

/// `search_tools`: the declarations of the best matches for `query`.
pub fn search(wrapped: &[Value], input: &Value) -> String {
    let query = input.get("query").and_then(Value::as_str).unwrap_or_default().to_lowercase();
    let limit = input.get("limit").and_then(Value::as_u64).filter(|n| *n > 0).unwrap_or(8).min(50) as usize;
    let terms: Vec<&str> = query.split(|c: char| !c.is_alphanumeric()).filter(|t| !t.is_empty()).collect();
    let mut scored: Vec<(usize, usize, &Value)> = wrapped
        .iter()
        .enumerate()
        .filter_map(|(i, t)| {
            if terms.is_empty() {
                return Some((0, i, t));
            }
            let n = name(t).to_lowercase();
            let d = t.get("description").and_then(Value::as_str).unwrap_or_default().to_lowercase();
            let score: usize = terms
                .iter()
                .map(|w| {
                    if n.contains(w) {
                        3
                    } else if d.contains(w) {
                        1
                    } else {
                        0
                    }
                })
                .sum();
            (score > 0).then_some((score, i, t))
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    let total = scored.len();
    if total == 0 {
        let names: Vec<&str> = wrapped.iter().map(name).collect();
        return format!("No tools match \"{query}\". Tools: {}", names.join(", "));
    }
    let shown: Vec<String> = scored.iter().take(limit).map(|(_, _, t)| decl::declaration(t)).collect();
    let more = if total > limit {
        format!("\n\n// {} more match; raise limit or narrow the query.", total - limit)
    } else {
        String::new()
    };
    format!("{}{more}", shown.join("\n\n"))
}

/// What code mode saved over one turn, as estimated tokens.
#[derive(Debug, Default)]
pub struct Tally(Mutex<Counts>);

#[derive(Debug, Default, Clone, Copy)]
struct Counts {
    wrapped: u64,
    /// Definitions not sent on each model call: the wrapped tools' specs less
    /// `search_tools` and `run_code`'s.
    schema_per_call: i64,
    runs: u64,
    tool_calls: u64,
    /// Results and call arguments the model did not read or write, less what
    /// the runs returned.
    results_kept_out: i64,
    /// What `search_tools` put into the context: code mode's own cost.
    search: u64,
}

impl Tally {
    /// A turn whose tool list was `wrapped` turned into `code_tools`.
    pub fn new(wrapped: &[Value], code_tools: &[Value]) -> Self {
        let size = |tools: &[Value]| tokens(&nekko_js::stringify(&Value::Array(tools.to_vec()))) as i64;
        Self(Mutex::new(Counts {
            wrapped: wrapped.len() as u64,
            schema_per_call: size(wrapped) - size(code_tools),
            ..Counts::default()
        }))
    }

    fn with(&self, f: impl FnOnce(&mut Counts)) {
        f(&mut self.0.lock().unwrap_or_else(|e| e.into_inner()));
    }

    pub fn searched(&self, output: &str) {
        self.with(|c| c.search += tokens(output));
    }

    pub fn ran(&self, outcome: &Outcome) {
        let read: u64 = outcome.calls.iter().map(|r| r.input_tokens + r.output_tokens).sum();
        self.with(|c| {
            c.runs += 1;
            c.tool_calls += outcome.calls.len() as u64;
            c.results_kept_out += read as i64 - tokens(&outcome.output) as i64;
        });
    }

    /// `turnStats.codeMode` for a turn of `model_calls` calls.
    pub fn summary(&self, model_calls: u64) -> Value {
        let c = *self.0.lock().unwrap_or_else(|e| e.into_inner());
        let schema = c.schema_per_call * model_calls as i64;
        let results = c.results_kept_out;
        json!({
            "toolsWrapped": c.wrapped,
            "schemaTokensPerCall": c.schema_per_call,
            "schemaTokensSaved": schema,
            "resultTokensSaved": results,
            "searchTokens": c.search,
            "tokensSaved": schema + results - c.search as i64,
            "runs": c.runs,
            "toolCalls": c.tool_calls,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool(name: &str, description: &str) -> Value {
        json!({ "name": name, "description": description, "parameters": { "type": "object", "required": ["path"], "properties": { "path": { "type": "string", "description": "Where, relative to the workspace, the long way round." } } } })
    }

    #[test]
    fn chat_tools_stay_direct_and_the_rest_go_behind_code() {
        let tools = vec![
            tool("read_file", "Read a file."),
            tool("grep", "Search."),
            json!({ "name": "update_plan" }),
            json!({ "name": "ask_user" }),
        ];
        let (direct, wrapped) = split(tools);
        assert_eq!(direct.iter().map(name).collect::<Vec<_>>(), ["update_plan", "ask_user"]);
        assert_eq!(wrapped.iter().map(name).collect::<Vec<_>>(), ["read_file", "grep"]);
        let offered = offer(direct, &wrapped);
        assert_eq!(
            offered.iter().map(name).collect::<Vec<_>>(),
            ["search_tools", "run_code", "update_plan", "ask_user"]
        );
        assert!(offered[1]["description"].as_str().unwrap().contains("- read_file: Read a file."));
        assert_eq!(offer(vec![json!({ "name": "ask_user" })], &[]).len(), 1);
    }

    #[test]
    fn a_long_index_lists_names_only() {
        let many: Vec<Value> =
            (0..300).map(|i| tool(&format!("mcp__gh__tool_{i}"), "Does a thing on GitHub. More words.")).collect();
        let [_, run] = specs(&many);
        let d = run["description"].as_str().unwrap();
        assert!(d.contains("mcp__gh__tool_0, mcp__gh__tool_1"));
        assert!(!d.contains("Does a thing"));
    }

    #[test]
    fn search_ranks_names_over_descriptions() {
        let tools = vec![
            tool("read_file", "Read a file."),
            tool("list_pulls", "List pull requests on GitHub."),
            tool("github_search", "Search code."),
        ];
        let out = search(&tools, &json!({ "query": "github" }));
        assert!(out.find("tools.github_search").unwrap() < out.find("tools.list_pulls").unwrap());
        assert!(!out.contains("read_file"));
        let out = search(&tools, &json!({ "query": "github", "limit": 1 }));
        assert!(out.contains("1 more match"));
        assert!(search(&tools, &json!({ "query": "zzz" })).starts_with("No tools match"));
        assert_eq!(search(&tools, &json!({})).matches("Promise<string>").count(), 3);
    }

    #[test]
    fn tally_counts_schema_per_call_and_results_kept_out() {
        let wrapped: Vec<Value> =
            (0..40).map(|i| tool(&format!("tool_{i}"), "A tool that does something useful with a path.")).collect();
        let code = specs(&wrapped);
        let tally = Tally::new(&wrapped, &code);
        tally.searched("tools.tool_1(input: { path: string }): Promise<string>;");
        tally.ran(&Outcome {
            output: "3".into(),
            is_error: false,
            calls: vec![CallRecord { name: "tool_1".into(), input_tokens: 10, output_tokens: 5_000, is_error: false }],
        });
        let s = tally.summary(4);
        let per_call = s["schemaTokensPerCall"].as_i64().unwrap();
        assert!(per_call > 1_000, "{s}");
        assert_eq!(s["schemaTokensSaved"].as_i64().unwrap(), per_call * 4);
        assert_eq!(s["resultTokensSaved"], json!(5_009));
        assert_eq!(s["tokensSaved"].as_i64().unwrap(), per_call * 4 + 5_009 - s["searchTokens"].as_i64().unwrap());
        assert_eq!(
            (s["runs"].clone(), s["toolCalls"].clone(), s["toolsWrapped"].clone()),
            (json!(1), json!(1), json!(40))
        );
    }
}
