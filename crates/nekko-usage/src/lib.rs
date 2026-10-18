//! Usage, reply and quota accounting for the engine daemon (PF14).
//!
//! Ports of the TS host's `usage.ts`, `replies.ts`, `quota-history.ts`,
//! `usage-records.ts` and the pure half of `limits.ts`, plus `estimateCost`
//! from `@nekko-agent/shared`. Everything works on `serde_json::Value` with
//! JavaScript's rules (missing is `undefined`, arithmetic coerces, `NaN`
//! prints as `null`, integer-like keys sort first), so a line or a summary
//! comes out as the TS host would write it. Held to the TS functions by the
//! golden set `packages/host/src/usage.golden.test.ts` writes.

pub mod date;
pub mod limits;
pub mod pricing;
pub mod records;
pub mod summary;

use serde_json::{Map, Value};
use std::cmp::Ordering;
use std::sync::OnceLock;

pub use limits::{
    LimitsError, Problem, classify_limits_error, describe_anthropic_window, limits_backoff_ms, merge_windows,
    parse_anthropic_api_headers, parse_anthropic_headers, parse_anthropic_usage_json, parse_chatgpt_usage,
    parse_openrouter_key, parse_retry_after, sort_windows,
};
pub use pricing::{Tokens, estimate_cost, model_price};
pub use records::{quota_history_record, side_usage_record, turn_reply_record, turn_usage_record};
pub use summary::{UsageFiles, summarize_replies, usage_summary};

/// A number as a JSON value, `null` where JavaScript's `JSON.stringify`
/// would print `null` (`NaN`, the infinities).
pub fn num(f: f64) -> Value {
    serde_json::Number::from_f64(f).map_or(Value::Null, |n| {
        // Whole numbers stay integers, so a line prints `5`, never `5.0`.
        if f.fract() == 0.0 && f.abs() < 9_007_199_254_740_992.0 && !(f == 0.0 && f.is_sign_negative()) {
            Value::from(f as i64)
        } else {
            Value::Number(n)
        }
    })
}

/// `obj[key]` for a parsed JSON value: `None` is `undefined` (a missing key,
/// or a property read on a number, string or array).
pub fn get<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    match v {
        Value::Object(m) => m.get(key),
        _ => None,
    }
}

/// `String(v)` for a property key, `undefined` included.
pub fn key_of(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(v) => nekko_js::display(v),
    }
}

/// `a === b` for two property reads.
pub fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(Value::Object(_) | Value::Array(_)), Some(_)) => false,
        (Some(x), Some(y)) => x == y,
        _ => false,
    }
}

/// `x ?? 0` then used as a number.
pub fn or_zero(v: Option<&Value>) -> f64 {
    match v {
        None | Some(Value::Null) => 0.0,
        other => nekko_js::to_number(other),
    }
}

/// A canonical array index (`"0"`, `"7"`, not `"07"`): JavaScript lists those
/// keys first, in numeric order, whatever order they were added in.
fn array_index(k: &str) -> Option<u32> {
    if k.is_empty() || (k.len() > 1 && k.starts_with('0')) || !k.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    k.parse::<u32>().ok().filter(|&n| n != u32::MAX)
}

/// An object's keys in JavaScript's property order, all the way down: what
/// `JSON.stringify` of the TS object would print.
pub fn js_order(v: Value) -> Value {
    match v {
        Value::Object(m) => Value::Object(js_order_map(m)),
        Value::Array(a) => Value::Array(a.into_iter().map(js_order).collect()),
        other => other,
    }
}

fn js_order_map(m: Map<String, Value>) -> Map<String, Value> {
    let mut indexed: Vec<(u32, String, Value)> = Vec::new();
    let mut rest: Vec<(String, Value)> = Vec::new();
    for (k, v) in m {
        match array_index(&k) {
            Some(n) => indexed.push((n, k, js_order(v))),
            None => rest.push((k, js_order(v))),
        }
    }
    indexed.sort_by_key(|(n, _, _)| *n);
    indexed.into_iter().map(|(_, k, v)| (k, v)).chain(rest).collect()
}

/// `Object.entries(obj)` order for a parsed object.
pub fn js_entries(m: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut indexed: Vec<(u32, &String, &Value)> = Vec::new();
    let mut rest = Vec::new();
    for (k, v) in m {
        match array_index(k) {
            Some(n) => indexed.push((n, k, v)),
            None => rest.push((k, v)),
        }
    }
    indexed.sort_by_key(|(n, _, _)| *n);
    indexed.into_iter().map(|(_, k, v)| (k, v)).chain(rest).collect()
}

/// `a.localeCompare(b)`: V8 hands it to ICU's root collation.
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    use icu_collator::options::CollatorOptions;
    use icu_collator::{Collator, CollatorBorrowed};
    static C: OnceLock<Option<CollatorBorrowed<'static>>> = OnceLock::new();
    match C.get_or_init(|| Collator::try_new(Default::default(), CollatorOptions::default()).ok()).as_ref() {
        Some(c) => c.compare(a, b),
        None => a.cmp(b),
    }
}

/// `Math.round`: halves go up (toward +Infinity), unlike `f64::round`.
pub fn js_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

/// `parseFloat(s)`: the longest decimal prefix after leading whitespace.
pub fn parse_float(s: &str) -> f64 {
    let t = nekko_js::trim_start(s);
    let (sign, body) = match t.as_bytes().first() {
        Some(b'+') => (1.0, &t[1..]),
        Some(b'-') => (-1.0, &t[1..]),
        _ => (1.0, t),
    };
    if body.starts_with("Infinity") {
        return sign * f64::INFINITY;
    }
    let b = body.as_bytes();
    let mut i = 0;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let mut digits = i;
    if i < b.len() && b[i] == b'.' {
        let mut j = i + 1;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        digits += j - i - 1;
        if digits > 0 {
            i = j;
        }
    }
    if digits == 0 {
        return f64::NAN;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        let mut j = i + 1;
        if j < b.len() && (b[j] == b'+' || b[j] == b'-') {
            j += 1;
        }
        let start = j;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        if j > start {
            i = j;
        }
    }
    body[..i].parse::<f64>().map(|f| sign * f).unwrap_or(f64::NAN)
}

/// `parseInt(s, 10)`.
pub fn parse_int10(s: &str) -> f64 {
    let t = nekko_js::trim_start(s);
    let (sign, body) = match t.as_bytes().first() {
        Some(b'+') => (1.0, &t[1..]),
        Some(b'-') => (-1.0, &t[1..]),
        _ => (1.0, t),
    };
    let end = body.bytes().take_while(u8::is_ascii_digit).count();
    if end == 0 {
        return f64::NAN;
    }
    body[..end].parse::<f64>().map(|f| sign * f).unwrap_or(f64::NAN)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers_print_as_javascript_prints_them() {
        assert_eq!(num(5.0), json!(5));
        assert_eq!(num(0.5), json!(0.5));
        assert_eq!(num(f64::NAN), Value::Null);
        assert_eq!(nekko_js::stringify(&num(-0.0)), "0");
    }

    #[test]
    fn parse_float_and_int_take_prefixes() {
        assert_eq!(parse_float(" 0.2abc"), 0.2);
        assert_eq!(parse_float(".5"), 0.5);
        assert_eq!(parse_float("5."), 5.0);
        assert_eq!(parse_float("1e3x"), 1000.0);
        assert_eq!(parse_float("1ex"), 1.0);
        assert!(parse_float("x1").is_nan());
        assert!(parse_float(".").is_nan());
        assert_eq!(parse_float("-Infinityx"), f64::NEG_INFINITY);
        assert_eq!(parse_int10("17.9s"), 17.0);
        assert!(parse_int10("x").is_nan());
    }

    #[test]
    fn rounding_and_key_order_follow_javascript() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(0.49999999999999994), 0.0);
        let v = js_order(json!({ "b": 1, "7": 2, "a": { "10": 1, "2": 2, "x": 3 }, "07": 4 }));
        assert_eq!(serde_json::to_string(&v).unwrap(), r#"{"7":2,"b":1,"a":{"2":2,"10":1,"x":3},"07":4}"#);
    }
}
