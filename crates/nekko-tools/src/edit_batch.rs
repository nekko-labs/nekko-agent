//! Validate a batch in memory before any snapshot or file mutation. The
//! transaction covers validation, not concurrent writers or filesystem failure.

use serde_json::Value;

pub const MAX_EDITS: usize = 100;
pub const MAX_EDIT_BYTES: usize = 8 * 1024 * 1024;

pub fn apply_batch(text: &str, args: &Value) -> Result<String, String> {
    if args.get("old_string").is_some() || args.get("new_string").is_some() {
        return Err("Use either edits or old_string/new_string, not both.".into());
    }
    let edits = args
        .get("edits")
        .and_then(Value::as_array)
        .filter(|e| !e.is_empty() && e.len() <= MAX_EDITS)
        .ok_or("edits must be an array of 1 to 100 replacements.")?;
    if text.len() > MAX_EDIT_BYTES {
        return Err("Batch edit exceeds the 8 MiB text limit.".into());
    }
    let mut next = text.to_string();
    let mut bytes = 0usize;
    for (i, edit) in edits.iter().enumerate() {
        let old = edit
            .get("old_string")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| format!("Edit {}: old_string must be a non-empty string.", i + 1))?;
        let new = edit
            .get("new_string")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("Edit {}: new_string must be a string.", i + 1))?;
        bytes = bytes.saturating_add(old.len()).saturating_add(new.len());
        if bytes > MAX_EDIT_BYTES {
            return Err("Batch edit exceeds the 8 MiB replacement limit.".into());
        }
        let Some(start) = next.find(old) else {
            return Err(format!("Edit {}: old_string not found; no edits applied.", i + 1));
        };
        // Match the existing tool's non-overlapping uniqueness semantics.
        if next[start + old.len()..].contains(old) {
            return Err(format!("Edit {}: old_string matches multiple locations; no edits applied.", i + 1));
        }
        if next.len() - old.len() + new.len() > MAX_EDIT_BYTES {
            return Err("Batch edit exceeds the 8 MiB result limit.".into());
        }
        // Literal strings: `$&`, `$$` and backticks are source, not templates.
        next.replace_range(start..start + old.len(), new);
    }
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn dependent_edits_and_dollar_strings_are_literal() {
        let args = json!({"edits":[
            {"old_string":"α", "new_string":"β"},
            {"old_string":"β", "new_string":"$& $$ $` $'"}
        ]});
        assert_eq!(apply_batch("α\r\nend", &args).unwrap(), "$& $$ $` $'\r\nend");
    }

    #[test]
    fn malformed_missing_ambiguous_and_mixed_batches_fail() {
        for args in [
            json!({"edits":null}),
            json!({"edits":[]}),
            json!({"edits":[{"old_string":"", "new_string":"x"}]}),
            json!({"edits":[{"old_string":"a", "new_string":42}]}),
            json!({"edits":[{"old_string":"a"}]}),
            json!({"old_string":"a", "edits":[{"old_string":"a", "new_string":"b"}]}),
            json!({"edits":[{"old_string":"a", "new_string":"b"}, {"old_string":"missing", "new_string":"c"}]}),
            json!({"edits":vec![json!({"old_string":"a", "new_string":"b"}); 101]}),
        ] {
            assert!(apply_batch("a", &args).is_err(), "{args}");
        }
        assert!(apply_batch("aa", &json!({"edits":[{"old_string":"a", "new_string":"b"}]})).is_err());
        assert_eq!(apply_batch("a", &json!({"edits":[{"old_string":"a", "new_string":""}]})).unwrap(), "");
    }

    #[test]
    fn input_and_output_are_bounded() {
        let large = "x".repeat(MAX_EDIT_BYTES + 1);
        assert!(apply_batch(&large, &json!({"edits":[{"old_string":"x", "new_string":""}]})).is_err());
        assert!(apply_batch("a", &json!({"edits":[{"old_string":"a", "new_string":large}]})).is_err());
    }
}
