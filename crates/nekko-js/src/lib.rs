//! JavaScript semantics the Rust ports of the TS host depend on.
//!
//! The TS host decides what to send, store and show with JavaScript's rules: truthiness (`if (delta?.content)`), nullish coalescing
//! (`reasoning_content ?? reasoning`, where an empty string wins), `trim()`'s
//! whitespace set, `Number(...)` coercion, UTF-16 `.slice`, and
//! `JSON.stringify`'s number format for tool arguments. A port that must send
//! the same bytes and yield the same chunks has to use the same rules, so these
//! are ports of exactly those operations rather than Rust's nearest
//! equivalents (`char::is_whitespace` includes U+0085 and not U+FEFF;
//! `serde_json` prints `1e21` where JavaScript prints `1e+21`). Shared by the
//! providers, the session store, the turn context and the agent loop.

use serde_json::Value;

/// `s.length` in JavaScript: UTF-16 code units.
pub fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// ECMAScript `WhiteSpace` plus `LineTerminator`: what `trim()` removes.
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

/// `s.trim()`.
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// `s.trimStart()`.
pub fn trim_start(s: &str) -> &str {
    s.trim_start_matches(is_js_space)
}

/// A line terminator, which a regex `.` does not match.
pub fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `s.replace(/\s+/g, ' ')`.
pub fn fold_space(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_space = false;
    for c in s.chars() {
        if is_js_space(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

/// `s.length > n ? s.slice(0, n) + '…' : s`.
///
/// One divergence, on purpose: where JavaScript would cut a surrogate pair in
/// half and keep a lone high surrogate, this stops before the pair, since a
/// Rust string cannot hold half a character.
pub fn cap(s: &str, n: usize) -> String {
    if len16(s) <= n {
        return s.to_string();
    }
    let mut out = String::new();
    let mut used = 0;
    for c in s.chars() {
        let w = c.len_utf16();
        if used + w > n {
            break;
        }
        used += w;
        out.push(c);
    }
    out.push('…');
    out
}

/// `s.slice(0, n)` in UTF-16 code units.
///
/// One divergence, on purpose (the same one `nekko-store` makes): where
/// JavaScript would cut a surrogate pair in half, this stops before the pair,
/// since a Rust string cannot hold half a character.
pub fn slice16(s: &str, n: usize) -> &str {
    let mut used = 0;
    for (i, c) in s.char_indices() {
        let w = c.len_utf16();
        if used + w > n {
            return &s[..i];
        }
        used += w;
    }
    s
}

/// Is this value `null` or `undefined` (absent)?
pub fn nullish(v: Option<&Value>) -> bool {
    matches!(v, None | Some(Value::Null))
}

/// `a ?? b`.
pub fn coalesce<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    if nullish(a) { b } else { a }
}

/// JavaScript truthiness of a JSON value.
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// A truthy string, the shape nearly every `if (x) yield x` guards.
pub fn truthy_str(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// A number as JavaScript prints it (`String(n)`, and `JSON.stringify` for
/// finite values): ECMAScript's Number::toString, so shortest round-trip
/// digits, positional from 1e-6 up to 1e21 and an exponent with its sign
/// outside that (`0.000001`, `1e-7`, `1e+21`).
pub fn number_to_string(f: f64) -> String {
    if f.is_nan() {
        return "NaN".into();
    }
    if f.is_infinite() {
        return if f > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if f == 0.0 {
        return "0".into();
    }
    if f < 0.0 {
        return format!("-{}", number_to_string(-f));
    }
    // `{:e}` prints the shortest digits that round-trip, as `d.ddde<exp>`:
    // the digits are `digits`, and the value is 0.digits x 10^n.
    let sci = format!("{f:e}");
    let (mantissa, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let k = digits.len() as i64;
    let n = exp.parse::<i64>().unwrap_or(0) + 1;
    if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let sign = if e < 0 { '-' } else { '+' };
        let (head, rest) = digits.split_at(1);
        let frac = if rest.is_empty() { String::new() } else { format!(".{rest}") };
        format!("{head}{frac}e{sign}{}", e.abs())
    }
}

/// JavaScript holds every number as a double, so an integer past 2^53 prints
/// rounded (`12345678901234567890` is `12345678901234567000`).
fn json_number(n: &serde_json::Number) -> String {
    number_to_string(n.as_f64().unwrap_or(0.0))
}

/// `JSON.stringify(value)` for a value that came out of `JSON.parse`.
pub fn stringify(v: &Value) -> String {
    let mut out = String::new();
    write(v, &mut out);
    out
}

fn write(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&json_number(n)),
        // serde_json escapes the same set JSON.stringify does: quote,
        // backslash, and control characters (short forms where JSON has them).
        Value::String(s) => out.push_str(&serde_json::to_string(s).unwrap_or_default()),
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(x, out);
            }
            out.push(']');
        }
        Value::Object(o) => {
            out.push('{');
            for (i, (k, x)) in o.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k).unwrap_or_default());
                out.push(':');
                write(x, out);
            }
            out.push('}');
        }
    }
}

/// `JSON.stringify(value, null, indent)`: the same values as [`stringify`],
/// one member per line, nested `indent` deeper per level; empty arrays and
/// objects stay `[]` and `{}`.
pub fn stringify_pretty(v: &Value, indent: &str) -> String {
    let mut out = String::new();
    write_pretty(v, indent, 0, &mut out);
    out
}

fn write_pretty(v: &Value, indent: &str, depth: usize, out: &mut String) {
    let pad = |out: &mut String, d: usize| {
        out.push('\n');
        for _ in 0..d {
            out.push_str(indent);
        }
    };
    match v {
        Value::Array(a) if !a.is_empty() => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                pad(out, depth + 1);
                write_pretty(x, indent, depth + 1, out);
            }
            pad(out, depth);
            out.push(']');
        }
        Value::Object(o) if !o.is_empty() => {
            out.push('{');
            for (i, (k, x)) in o.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                pad(out, depth + 1);
                out.push_str(&serde_json::to_string(k).unwrap_or_default());
                out.push_str(": ");
                write_pretty(x, indent, depth + 1, out);
            }
            pad(out, depth);
            out.push('}');
        }
        other => write(other, out),
    }
}

/// A canonical array index (`"0"`, `"7"`, not `"07"`): JavaScript lists those
/// keys first, in numeric order, whatever order they were added in.
pub fn array_index(k: &str) -> Option<u32> {
    if k.is_empty() || (k.len() > 1 && k.starts_with('0')) || !k.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    k.parse::<u32>().ok().filter(|&n| n != u32::MAX)
}

/// An object's keys in JavaScript's property order, all the way down: what
/// `JSON.stringify` of the same object built in JavaScript would print.
pub fn js_order(v: Value) -> Value {
    match v {
        Value::Object(m) => {
            let mut indexed: Vec<(u32, String, Value)> = Vec::new();
            let mut rest: Vec<(String, Value)> = Vec::new();
            for (k, v) in m {
                match array_index(&k) {
                    Some(n) => indexed.push((n, k, js_order(v))),
                    None => rest.push((k, js_order(v))),
                }
            }
            indexed.sort_by_key(|(n, _, _)| *n);
            Value::Object(indexed.into_iter().map(|(_, k, v)| (k, v)).chain(rest).collect())
        }
        Value::Array(a) => Value::Array(a.into_iter().map(js_order).collect()),
        other => other,
    }
}

/// `{ ...target, ...source }` onto `target`, for any `source` JSON can hold:
/// an object's own keys, an array's or a string's indices (a string by UTF-16
/// unit), and nothing for `null`, numbers and booleans. Keys already present
/// keep their place and take the new value; the result is in JavaScript's
/// property order.
pub fn spread_into(target: &mut serde_json::Map<String, Value>, source: &Value) {
    match source {
        Value::Object(m) => {
            for (k, v) in m {
                target.insert(k.clone(), v.clone());
            }
        }
        Value::Array(a) => {
            for (i, v) in a.iter().enumerate() {
                target.insert(i.to_string(), v.clone());
            }
        }
        Value::String(s) => {
            for (i, u) in s.encode_utf16().enumerate() {
                target.insert(i.to_string(), Value::String(String::from_utf16_lossy(&[u])));
            }
        }
        _ => {}
    }
    if let Value::Object(m) = js_order(Value::Object(std::mem::take(target))) {
        *target = m;
    }
}

/// `x.toFixed(digits)` for `digits` up to 100: the exact value rounded half
/// away from zero (Rust's own `{:.2}` rounds an exact tie to even, so
/// `0.125` would print `0.12` where JavaScript prints `0.13`). NaN prints
/// `NaN`; from 1e21 up, the number's own string, as JavaScript does.
pub fn to_fixed(x: f64, digits: usize) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.abs() >= 1e21 || x.is_infinite() {
        return number_to_string(x);
    }
    // Every finite double has a terminating decimal expansion of at most 1074 places.
    let exact = format!("{:.1100}", x.abs());
    let (int_part, frac) = exact.split_once('.').unwrap_or((&exact, ""));
    let (kept, rest) = frac.split_at(digits.min(frac.len()));
    let mut digits_out: Vec<u8> = int_part.bytes().chain(kept.bytes()).map(|b| b - b'0').collect();
    if rest.as_bytes().first().is_some_and(|&b| b >= b'5') {
        let mut i = digits_out.len();
        loop {
            if i == 0 {
                digits_out.insert(0, 1);
                break;
            }
            i -= 1;
            if digits_out[i] == 9 {
                digits_out[i] = 0;
            } else {
                digits_out[i] += 1;
                break;
            }
        }
    }
    let text: String = digits_out.iter().map(|d| char::from(b'0' + d)).collect();
    let split = text.len() - kept.len();
    let mut out = String::new();
    // (-0.001).toFixed(2) is "-0.00": the sign survives rounding to zero.
    if x < 0.0 {
        out.push('-');
    }
    out.push_str(&text[..split]);
    if digits > 0 {
        out.push('.');
        out.push_str(&text[split..]);
    }
    out
}

/// A value as a template literal prints it (`${v}`).
pub fn display(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => json_number(n),
        Value::String(s) => s.clone(),
        Value::Array(a) => {
            a.iter().map(|x| if x.is_null() { String::new() } else { display(x) }).collect::<Vec<_>>().join(",")
        }
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `Number(v)`: `undefined` is NaN, `null` is 0, strings are parsed as
/// JavaScript's StringToNumber does (whitespace-trimmed, empty is 0, hex and
/// `Infinity` accepted, anything else NaN).
pub fn to_number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => string_to_number(s),
        // An array converts through its string form: `[]` is "", so 0.
        Some(a @ Value::Array(_)) => string_to_number(&display(a)),
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// StringToNumber: `Number(s)` for a string.
pub fn string_to_number(s: &str) -> f64 {
    let t = trim(s);
    if t.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(digits) = t.strip_prefix(prefix) {
            return if !digits.is_empty() && digits.chars().all(|c| c.is_digit(radix)) {
                digits.chars().fold(0.0, |acc, c| acc * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0)))
            } else {
                f64::NAN
            };
        }
    }
    let (sign, body) = match t.as_bytes()[0] {
        b'+' => (1.0, &t[1..]),
        b'-' => (-1.0, &t[1..]),
        _ => (1.0, t),
    };
    if body == "Infinity" {
        return sign * f64::INFINITY;
    }
    // A StrDecimalLiteral: digits, one optional dot, an optional exponent.
    // Rust's parser also takes `inf`, `nan` and friends, which JavaScript does
    // not, so the shape is checked before it is handed over.
    let b = body.as_bytes();
    let mut i = 0;
    let int_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let mut digits = i - int_start;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let frac_start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        digits += i - frac_start;
    }
    if digits == 0 {
        return f64::NAN;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let exp_start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == exp_start {
            return f64::NAN;
        }
    }
    if i != b.len() {
        return f64::NAN;
    }
    body.parse::<f64>().map(|f| sign * f).unwrap_or(f64::NAN)
}

/// JavaScript truthiness of a number.
pub fn truthy_number(n: f64) -> bool {
    n != 0.0 && !n.is_nan()
}

/// `JSON.parse(s)` when `s` is truthy, else `{}`, and `{}` on a parse error:
/// the providers' `safeParse`. Whatever parses is kept, object or not.
pub fn safe_parse(s: &str) -> Value {
    if s.is_empty() {
        return Value::Object(Default::default());
    }
    serde_json::from_str(s).unwrap_or_else(|_| Value::Object(Default::default()))
}

/// A string's bytes decoded as `TextDecoder('utf-8')` would decode them in
/// one piece: a leading BOM dropped, malformed sequences replaced. This is
/// `Response.text()`.
pub fn decode_text(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

/// `a.localeCompare(b)`: V8 hands it to ICU's root collation.
pub fn locale_compare(a: &str, b: &str) -> std::cmp::Ordering {
    use icu_collator::options::CollatorOptions;
    use icu_collator::{Collator, CollatorBorrowed};
    use std::sync::OnceLock;
    static C: OnceLock<Option<CollatorBorrowed<'static>>> = OnceLock::new();
    match C.get_or_init(|| Collator::try_new(Default::default(), CollatorOptions::default()).ok()).as_ref() {
        Some(c) => c.compare(a, b),
        None => a.cmp(b),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_fixed_rounds_as_javascript_does() {
        // What V8 prints for each, `x.toFixed(2)`.
        let cases = [
            (0.125, "0.13"),
            (12.345, "12.35"),
            (1.005, "1.00"),
            (-0.001, "-0.00"),
            (0.0, "0.00"),
            (99.995, "100.00"),
            (1e20 + 0.5, "100000000000000000000.00"),
            (2.5, "2.50"),
            (0.5, "0.50"),
        ];
        for (x, want) in cases {
            assert_eq!(to_fixed(x, 2), want, "{x}");
        }
        assert_eq!(to_fixed(f64::NAN, 2), "NaN");
        assert_eq!(to_fixed(2.5, 0), "3");
    }
    use serde_json::json;

    #[test]
    fn pretty_prints_like_json_stringify_with_two_spaces() {
        let v = json!({ "a": [], "b": {}, "c": [1, { "d": 1.5e21 }], "e": "x\"" });
        assert_eq!(
            stringify_pretty(&v, "  "),
            "{\n  \"a\": [],\n  \"b\": {},\n  \"c\": [\n    1,\n    {\n      \"d\": 1.5e+21\n    }\n  ],\n  \"e\": \"x\\\"\"\n}"
        );
        let ordered = js_order(json!({ "b": 1, "10": 2, "2": 3, "07": 4 }));
        assert_eq!(ordered.as_object().unwrap().keys().collect::<Vec<_>>(), ["2", "10", "b", "07"]);
    }

    #[test]
    fn measures_caps_and_folds_like_javascript() {
        assert_eq!(len16("a😀"), 3);
        assert_eq!(cap("abcdef", 3), "abc…");
        assert_eq!(cap("abc", 3), "abc");
        assert_eq!(cap("😀😀", 3), "😀…");
        assert_eq!(fold_space("a \n\t b\u{2028}c"), "a b c");
        assert!(truthy_number(1.0) && !truthy_number(0.0) && !truthy_number(f64::NAN));
        assert_eq!(string_to_number(" 12 "), 12.0);
    }

    #[test]
    fn stringifies_like_json_stringify() {
        let v: Value = serde_json::from_str(r#"{"b":1.0,"a":[1e21,0.1,-2,1e-7,"x\n\u0001"],"n":null}"#).unwrap();
        assert_eq!(stringify(&v), r#"{"b":1,"a":[1e+21,0.1,-2,1e-7,"x\n\u0001"],"n":null}"#);
        assert_eq!(stringify(&json!(1e16)), "10000000000000000");
    }

    #[test]
    fn prints_numbers_like_javascript() {
        // Each checked against node's String(x).
        let cases = [
            (0.0, "0"),
            (5.0, "5"),
            (-2.25, "-2.25"),
            (0.1, "0.1"),
            (0.000001, "0.000001"),
            (0.00001, "0.00001"),
            (1e-7, "1e-7"),
            (1.23e-18, "1.23e-18"),
            (123456789.125, "123456789.125"),
            (1e20, "100000000000000000000"),
            (1e21, "1e+21"),
            (2.5e25, "2.5e+25"),
        ];
        for (x, want) in cases {
            assert_eq!(number_to_string(x), want, "{x}");
        }
        assert_eq!(display(&json!(12345678901234567890u64)), "12345678901234567000");
        assert_eq!(stringify(&json!(9007199254740993u64)), "9007199254740992");
    }

    #[test]
    fn coerces_like_number() {
        assert!(to_number(None).is_nan());
        assert_eq!(to_number(Some(&Value::Null)), 0.0);
        assert_eq!(to_number(Some(&json!(""))), 0.0);
        assert_eq!(to_number(Some(&json!(" 0.000003 "))), 0.000003);
        assert_eq!(to_number(Some(&json!("0x1A"))), 26.0);
        assert_eq!(to_number(Some(&json!("-Infinity"))), f64::NEG_INFINITY);
        assert_eq!(to_number(Some(&json!(".5"))), 0.5);
        assert_eq!(to_number(Some(&json!("5."))), 5.0);
        for bad in ["inf", "nan", "1e", "1.2.3", "abc", "1_000", "."] {
            assert!(to_number(Some(&json!(bad))).is_nan(), "{bad}");
        }
        assert_eq!(to_number(Some(&json!(["7"]))), 7.0);
    }

    #[test]
    fn displays_like_a_template_literal() {
        assert_eq!(display(&json!("x")), "x");
        assert_eq!(display(&json!(3.0)), "3");
        assert_eq!(display(&json!({"a": 1})), "[object Object]");
        assert_eq!(display(&json!([1, null, "b"])), "1,,b");
    }

    #[test]
    fn slices_and_trims_like_javascript() {
        assert_eq!(slice16("abcdef", 3), "abc");
        assert_eq!(slice16("a😀b", 2), "a");
        assert_eq!(slice16("ab", 5), "ab");
        assert_eq!(trim("\u{FEFF}\u{A0} hi \u{3000}"), "hi");
        assert_eq!(trim("\u{85}hi"), "\u{85}hi");
    }

    #[test]
    fn coalesces_only_past_nullish() {
        let empty = json!("");
        let text = json!("t");
        assert_eq!(coalesce(Some(&empty), Some(&text)), Some(&empty));
        assert_eq!(coalesce(Some(&Value::Null), Some(&text)), Some(&text));
        assert_eq!(coalesce(None, None), None);
    }

    #[test]
    fn safe_parse_keeps_what_parses() {
        assert_eq!(safe_parse(""), json!({}));
        assert_eq!(safe_parse("{\"a\":1}"), json!({"a": 1}));
        assert_eq!(safe_parse("[1]"), json!([1]));
        assert_eq!(safe_parse("{bad"), json!({}));
    }
}
