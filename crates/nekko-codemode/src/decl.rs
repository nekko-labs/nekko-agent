//! A tool spec as a TypeScript declaration the model codes against.
//!
//! Models write better calls against a typed signature than against a JSON
//! Schema blob, and the declaration is shorter: `grep(input: { pattern:
//! string; path?: string }): Promise<string>` says what three lines of schema
//! say. Only the shape a model needs survives: types, optionality, enums and
//! descriptions; formats, bounds and defaults are folded into the comment.

use serde_json::Value;

/// How deep nested objects are spelled out before they become `object`.
const MAX_DEPTH: usize = 3;

/// `tools.name` when `name` is a JavaScript identifier, else `tools["name"]`.
pub fn accessor(name: &str) -> String {
    let mut chars = name.chars();
    let ident = chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '$')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$');
    if ident { format!("tools.{name}") } else { format!("tools[{}]", nekko_js::stringify(&Value::String(name.into()))) }
}

/// One tool's declaration: its description as a doc comment, then the call.
pub fn declaration(tool: &Value) -> String {
    let name = tool.get("name").and_then(Value::as_str).unwrap_or_default();
    let description = tool.get("description").and_then(Value::as_str).unwrap_or_default().trim();
    let params = tool.get("parameters").or_else(|| tool.get("input_schema")).unwrap_or(&Value::Null);
    let mut out = String::new();
    if !description.is_empty() {
        out.push_str(&doc(description, ""));
    }
    let input = ts_type(params, 0);
    let optional = params.get("required").and_then(Value::as_array).is_none_or(Vec::is_empty);
    out.push_str(&format!("{}(input{}: {input}): Promise<string>;", accessor(name), if optional { "?" } else { "" }));
    out
}

/// The first sentence of a description, capped: the one-line index entry.
pub fn summary(tool: &Value, max: usize) -> String {
    let d = tool.get("description").and_then(Value::as_str).unwrap_or_default();
    let d = nekko_js::fold_space(nekko_js::trim(d));
    let first = d.split_inclusive(". ").next().unwrap_or(&d).trim_end();
    nekko_js::cap(first, max)
}

fn doc(text: &str, indent: &str) -> String {
    let lines: Vec<&str> = text.lines().map(str::trim_end).collect();
    if lines.len() == 1 {
        return format!("{indent}/** {} */\n", lines[0].replace("*/", "*\\/"));
    }
    let mut out = format!("{indent}/**\n");
    for l in lines {
        out.push_str(&format!("{indent} * {}\n", l.replace("*/", "*\\/")));
    }
    out.push_str(&format!("{indent} */\n"));
    out
}

/// A JSON Schema as a TypeScript type.
fn ts_type(schema: &Value, depth: usize) -> String {
    if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        return values.iter().map(nekko_js::stringify).collect::<Vec<_>>().join(" | ");
    }
    if let Some(c) = schema.get("const") {
        return nekko_js::stringify(c);
    }
    for key in ["anyOf", "oneOf"] {
        if let Some(options) = schema.get(key).and_then(Value::as_array) {
            let mut seen: Vec<String> = Vec::new();
            for o in options {
                let t = ts_type(o, depth);
                if !seen.contains(&t) {
                    seen.push(t);
                }
            }
            return seen.join(" | ");
        }
    }
    let ty = match schema.get("type") {
        Some(Value::String(t)) => t.as_str(),
        // `["string", "null"]`: each, joined.
        Some(Value::Array(types)) => {
            return types
                .iter()
                .map(|t| {
                    let mut one = schema.clone();
                    one["type"] = t.clone();
                    ts_type(&one, depth)
                })
                .collect::<Vec<_>>()
                .join(" | ");
        }
        _ if schema.get("properties").is_some() => "object",
        _ => return "any".into(),
    };
    match ty {
        "string" => "string".into(),
        "number" | "integer" => "number".into(),
        "boolean" => "boolean".into(),
        "null" => "null".into(),
        "array" => {
            let item = schema.get("items").map_or_else(|| "any".to_string(), |i| ts_type(i, depth + 1));
            if item.contains(' ') { format!("Array<{item}>") } else { format!("{item}[]") }
        }
        "object" => object(schema, depth),
        _ => "any".into(),
    }
}

fn object(schema: &Value, depth: usize) -> String {
    let Some(props) = schema.get("properties").and_then(Value::as_object).filter(|p| !p.is_empty()) else {
        return "Record<string, any>".into();
    };
    if depth >= MAX_DEPTH {
        return "Record<string, any>".into();
    }
    let required: Vec<&str> = schema
        .get("required")
        .and_then(Value::as_array)
        .map(|r| r.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let indent = "  ".repeat(depth + 1);
    let mut out = String::from("{\n");
    for (key, prop) in props {
        if let Some(d) = prop_note(prop) {
            out.push_str(&doc(&d, &indent));
        }
        let key_ts = if accessor(key).starts_with("tools.") {
            key.clone()
        } else {
            nekko_js::stringify(&Value::String(key.clone()))
        };
        let opt = if required.contains(&key.as_str()) { "" } else { "?" };
        out.push_str(&format!("{indent}{key_ts}{opt}: {};\n", ts_type(prop, depth + 1)));
    }
    out.push_str(&"  ".repeat(depth));
    out.push('}');
    out
}

/// A property's description, with the schema facts a type cannot say.
fn prop_note(prop: &Value) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if let Some(d) = prop.get("description").and_then(Value::as_str).map(str::trim).filter(|d| !d.is_empty()) {
        parts.push(d.to_string());
    }
    if let Some(d) = prop.get("default") {
        parts.push(format!("Default: {}.", nekko_js::stringify(d)));
    }
    (!parts.is_empty()).then(|| parts.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn spells_a_schema_as_a_signature() {
        let grep = json!({
            "name": "grep",
            "description": "Search file contents.",
            "parameters": { "type": "object", "required": ["pattern"], "properties": {
                "pattern": { "type": "string", "description": "A regular expression." },
                "path": { "type": "string" },
                "limit": { "type": "integer", "default": 100 },
                "mode": { "enum": ["files", "lines"] },
                "globs": { "type": "array", "items": { "type": "string" } },
            } },
        });
        assert_eq!(
            declaration(&grep),
            "/** Search file contents. */\ntools.grep(input: {\n  /** A regular expression. */\n  pattern: string;\n  path?: string;\n  /** Default: 100. */\n  limit?: number;\n  mode?: \"files\" | \"lines\";\n  globs?: string[];\n}): Promise<string>;"
        );
    }

    #[test]
    fn quotes_names_that_are_not_identifiers() {
        assert_eq!(accessor("mcp__gh__search"), "tools.mcp__gh__search");
        assert_eq!(accessor("mcp__fs__read-file"), "tools[\"mcp__fs__read-file\"]");
        let bare = json!({ "name": "now", "parameters": { "type": "object", "properties": {} } });
        assert_eq!(declaration(&bare), "tools.now(input?: Record<string, any>): Promise<string>;");
    }

    #[test]
    fn summary_is_the_first_sentence() {
        let t = json!({ "description": "Read a file.  Lines are numbered. Big files are cut." });
        assert_eq!(summary(&t, 80), "Read a file.");
    }
}
