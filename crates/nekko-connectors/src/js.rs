//! The JavaScript semantics the connector code leans on: `encodeURIComponent`,
//! `URLSearchParams`, `new URL`, `Date`, `String()`, UTF-16 `slice`, `Math`.

use serde_json::{Map, Value};

/// `encodeURIComponent`.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `decodeURIComponent` of what `encodeURIComponent` produced.
pub fn decode_uri_component(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(b) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("zz"), 16)
        {
            out.push(b);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `new URLSearchParams(pairs).toString()`: the form encoding, space as `+`.
pub fn search_params(pairs: &[(&str, &str)]) -> String {
    let enc = |s: &str| {
        let mut out = String::new();
        for b in s.bytes() {
            match b {
                b' ' => out.push('+'),
                b if b.is_ascii_alphanumeric() || b"*-._".contains(&b) => out.push(b as char),
                b => out.push_str(&format!("%{b:02X}")),
            }
        }
        out
    };
    pairs.iter().map(|(k, v)| format!("{}={}", enc(k), enc(v))).collect::<Vec<_>>().join("&")
}

/// The parts of a WHATWG URL the connectors read.
pub struct JsUrl {
    pub protocol: String,
    pub hostname: String,
    pub host: String,
    pub pathname: String,
    pub origin: String,
}

/// `new URL(s)`, or `None` where it throws.
pub fn parse_url(s: &str) -> Option<JsUrl> {
    let u = url::Url::parse(s).ok()?;
    let hostname = u.host_str().unwrap_or("").to_string();
    let host = match u.port() {
        Some(p) => format!("{hostname}:{p}"),
        None => hostname.clone(),
    };
    let origin = u.origin().ascii_serialization();
    Some(JsUrl { protocol: format!("{}:", u.scheme()), hostname, host, pathname: u.path().to_string(), origin })
}

/// `String(v)` for a JSON value, `undefined` for an absent one.
pub fn string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(v) => nekko_js::display(v),
    }
}

/// `v ?? ''` as a string (`String(v)` when present and not null).
pub fn or_empty(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(v) => nekko_js::display(v),
    }
}

pub use nekko_js::slice16;

/// `new Date(v).getTime()`.
pub fn date_ms(v: Option<&Value>) -> f64 {
    nekko_usage::date::from_value(v)
}

/// `new Date(t).toISOString()`, or `None` where it throws (an invalid date).
pub fn iso_string(t: f64) -> Option<String> {
    let t = nekko_usage::date::time_clip(t);
    if t.is_nan() {
        return None;
    }
    let date = nekko_usage::date::iso_date(t)?;
    let ms = t.rem_euclid(86_400_000.0) as i64;
    let (h, m, s, milli) = (ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000);
    Some(format!("{date}T{h:02}:{m:02}:{s:02}.{milli:03}Z"))
}

pub use nekko_js::num;

/// `Math.max(...xs)` (`-Infinity` for none, `NaN` if any is).
pub fn max_of(xs: impl IntoIterator<Item = f64>) -> f64 {
    let mut m = f64::NEG_INFINITY;
    for x in xs {
        if x.is_nan() {
            return f64::NAN;
        }
        m = m.max(x);
    }
    m
}

/// An object literal: keys in order, `None` (undefined) left out as
/// `JSON.stringify` leaves it out.
pub fn obj(fields: Vec<(&str, Option<Value>)>) -> Value {
    let mut m = Map::new();
    for (k, v) in fields {
        if let Some(v) = v {
            m.insert(k.to_string(), v);
        }
    }
    Value::Object(m)
}

/// `{ ...base, key: value }`: the key keeps its place if `base` has it.
pub fn spread_with(base: Option<&Value>, extra: Vec<(&str, Value)>) -> Value {
    let mut m = base.and_then(Value::as_object).cloned().unwrap_or_default();
    for (k, v) in extra {
        m.insert(k.to_string(), v);
    }
    Value::Object(m)
}

/// `res.json()` for a body, with V8's message when it is not JSON.
pub fn parse_json(body: &str) -> Result<Value, String> {
    serde_json::from_str(body).map_err(|_| {
        if body.trim().is_empty() {
            "Unexpected end of JSON input".to_string()
        } else {
            format!(
                "Unexpected token '{}', \"{}\" is not valid JSON",
                body.trim().chars().next().unwrap_or(' '),
                slice16(body, 10)
            )
        }
    })
}

/// A path into a parsed JSON value, `a?.b?.c` style: `None` once a step is missing.
pub fn at<'a>(v: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut cur = v;
    for k in path {
        cur = cur.get(*k)?;
    }
    Some(cur)
}

/// A JSON value's array, `[]` when it is not one (`x ?? []`).
pub fn arr(v: Option<&Value>) -> Vec<Value> {
    v.and_then(Value::as_array).cloned().unwrap_or_default()
}

/// `(v ?? '').trim()` for a settings field.
pub fn setting(settings: Option<&Value>, key: &str) -> String {
    nekko_js::trim(&or_empty(settings.and_then(|s| s.get(key)))).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_strings_match_to_iso_string() {
        assert_eq!(iso_string(1_767_323_045_006.0).unwrap(), "2026-01-02T03:04:05.006Z");
        assert_eq!(iso_string(0.0).unwrap(), "1970-01-01T00:00:00.000Z");
        assert!(iso_string(f64::NAN).is_none());
    }

    #[test]
    fn search_params_encode_as_forms_do() {
        assert_eq!(search_params(&[("a", "b c&d"), ("e", "x/y")]), "a=b+c%26d&e=x%2Fy");
        assert_eq!(encode_uri_component("a b/ü"), "a%20b%2F%C3%BC");
        assert_eq!(decode_uri_component("grp%2Fproj"), "grp/proj");
    }
}
