//! `messaging-state.json`: the getUpdates offset and the chat to session
//! bindings, read as `loadState` reads them and written as
//! `writeJsonAtomic` writes them (`nekko_settings::write_json_atomic`).

use serde_json::{Map, Value, json};

/// The file's name in the data directory.
pub const FILE: &str = "messaging-state.json";

/// `loadState()`: `{ offset: 0, bindings: {}, ...file }`, or the clean state
/// when the file is missing or not JSON. The file is read as Node's
/// `readFileSync(p, 'utf8')` reads it: invalid UTF-8 replaced, a byte-order
/// mark kept (so `JSON.parse` fails on it and the state starts clean).
pub fn load(file: Option<&[u8]>) -> Map<String, Value> {
    let mut state = Map::new();
    state.insert("offset".into(), json!(0));
    state.insert("bindings".into(), json!({}));
    if let Some(bytes) = file
        && let Ok(parsed) = serde_json::from_str::<Value>(&String::from_utf8_lossy(bytes))
    {
        nekko_js::spread_into(&mut state, &nekko_js::js_order(parsed));
    }
    state
}

/// The file's text, as `JSON.stringify(state, null, 2)` writes it.
pub fn text(state: &Map<String, Value>) -> String {
    nekko_js::stringify_pretty(&Value::Object(state.clone()), "  ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corrupt_files_start_clean() {
        for f in [None, Some(&b""[..]), Some(&b"nope"[..]), Some(&b"\xEF\xBB\xBF{}"[..])] {
            assert_eq!(text(&load(f)), "{\n  \"offset\": 0,\n  \"bindings\": {}\n}");
        }
    }
}
