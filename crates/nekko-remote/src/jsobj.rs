//! A JavaScript object literal's key order, `undefined` included.
//!
//! `remote.ts` builds its config with spreads (`{ ...prev, enabled: true }`),
//! and a key whose value is `undefined` still holds its place: set later, it
//! prints where it was declared, not at the end. `JSON.stringify` skips it
//! while it is `undefined`. This keeps that order so `remote.json` matches.

use serde_json::{Map, Value};

#[derive(Clone, Debug, Default, PartialEq)]
pub struct JsObj(Vec<(String, Option<Value>)>);

impl JsObj {
    pub fn new() -> Self {
        Self::default()
    }

    /// Set a key, keeping its place if it exists (`undefined` included).
    pub fn set(&mut self, key: &str, value: Option<Value>) -> &mut Self {
        match self.0.iter_mut().find(|(k, _)| k == key) {
            Some(slot) => slot.1 = value,
            None => self.0.push((key.to_string(), value)),
        }
        self
    }

    pub fn with(mut self, key: &str, value: Option<Value>) -> Self {
        self.set(key, value);
        self
    }

    /// The value, `None` for absent or `undefined`.
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.0.iter().find(|(k, _)| k == key).and_then(|(_, v)| v.as_ref())
    }

    /// As `JSON.stringify` sees it: `undefined` keys left out.
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        for (k, v) in &self.0 {
            if let Some(v) = v {
                m.insert(k.clone(), v.clone());
            }
        }
        Value::Object(m)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_undefined_key_keeps_its_place() {
        let o =
            JsObj::new().with("a", Some(json!(1))).with("b", None).with("c", Some(json!(3))).with("b", Some(json!(2)));
        assert_eq!(nekko_js::stringify(&o.to_value()), r#"{"a":1,"b":2,"c":3}"#);
        let o = o.with("b", None);
        assert_eq!(nekko_js::stringify(&o.to_value()), r#"{"a":1,"c":3}"#);
    }
}
