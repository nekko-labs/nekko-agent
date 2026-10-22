//! The JavaScript object and file semantics the TS services rely on.

use serde_json::{Map, Value};
use std::path::Path;

/// A number as `JSON.stringify` prints it.
pub use nekko_js::num;

/// `Math.max(a, b)`: `NaN` if either is.
pub fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) }
}

/// `Object.assign(target, patch)` for a patch from JSON: a key keeps its
/// place if it exists, else goes last. `None` stands for `undefined`, which
/// `JSON.stringify` then leaves out, so the key is dropped.
pub fn assign(target: &mut Map<String, Value>, patch: &[(&str, Option<Value>)]) {
    for (k, v) in patch {
        match v {
            Some(v) => {
                target.insert((*k).to_string(), v.clone());
            }
            None => {
                target.shift_remove(*k);
            }
        }
    }
}

/// `Object.assign(target, patch)` with a JSON object patch.
pub fn assign_value(target: &mut Map<String, Value>, patch: &Value) {
    if let Some(p) = patch.as_object() {
        for (k, v) in p {
            target.insert(k.clone(), v.clone());
        }
    }
}

/// Write a JSON file as `writeFileSync(f, JSON.stringify(v, null, 2))` does,
/// but whole or not at all: a temp file beside it, renamed over it.
pub fn write_json(path: &Path, value: &Value) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut tag = [0u8; 8];
    let _ = getrandom::fill(&mut tag);
    let tag: String = tag.iter().map(|b| format!("{b:02x}")).collect();
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = path.with_file_name(format!(".{name}.{tag}.tmp"));
    std::fs::write(&tmp, nekko_js::stringify_pretty(value, "  "))?;
    let mut attempt = 0;
    loop {
        match std::fs::rename(&tmp, path) {
            Ok(()) => return Ok(()),
            // Windows refuses a rename over a file another process holds open; that clears in moments.
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied && attempt < 20 => {
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_millis(5 * attempt));
            }
            Err(e) => {
                let _ = std::fs::remove_file(&tmp);
                return Err(e);
            }
        }
    }
}

/// `JSON.parse(readFileSync(f))`, or `None` when missing or not JSON.
pub fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// `a - b` as a sort comparator: `NaN` counts as equal, as V8's sort treats it.
pub fn cmp_numbers(a: f64, b: f64) -> std::cmp::Ordering {
    a.partial_cmp(&b).unwrap_or(std::cmp::Ordering::Equal)
}

/// `/\bphrase\b/i` for an ASCII phrase (JavaScript's non-Unicode `\b` and
/// case folding never match a non-ASCII character against ASCII).
pub fn has_word_phrase(text: &str, phrase: &str) -> bool {
    let word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let (t, p) = (text.as_bytes(), phrase.as_bytes());
    if p.is_empty() || t.len() < p.len() {
        return false;
    }
    (0..=t.len() - p.len()).any(|i| {
        t[i..i + p.len()].eq_ignore_ascii_case(p)
            && (i == 0 || !word(t[i - 1]))
            && (i + p.len() == t.len() || !word(t[i + p.len()]))
    })
}

/// `writeJsonAtomic`: [`write_json`], owner-only where the platform has modes.
pub fn write_json_private(path: &Path, value: &Value) -> std::io::Result<()> {
    write_json(path, value)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn finds_a_whole_phrase_in_any_case() {
        assert!(has_word_phrase("The CONDITION MET now", "condition met"));
        assert!(has_word_phrase("condition met", "condition met"));
        assert!(!has_word_phrase("precondition met", "condition met"));
        assert!(!has_word_phrase("conditions met", "condition met"));
        assert!(!has_word_phrase("condition metal", "condition met"));
        assert!(has_word_phrase("é condition met.", "condition met"));
    }

    #[test]
    fn numbers_print_as_json_stringify_does() {
        assert_eq!(num(1.0), json!(1));
        assert_eq!(num(f64::NAN), Value::Null);
        assert!(js_max(60_000.0, f64::NAN).is_nan());
        assert_eq!(js_max(60_000.0, 1000.0), 60_000.0);
    }
}
