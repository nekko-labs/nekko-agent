//! The engine's services for the daemon, ported from `packages/host/src/engine`
//! one at a time and held to the TS by golden sets the host writes.

pub mod acquire;
pub mod builds;
pub mod capacity;
pub mod catalog;
pub mod download;
pub mod folders;
pub mod gguf;
pub mod gpu_adapters;
pub mod install;
pub mod launch;
pub mod library;
pub mod mlx;
pub mod placement;
pub mod runtimes;
pub mod server;

use serde_json::Value;
use std::future::Future;
use std::pin::Pin;

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// A number as a JSON value: whole numbers stay integers, `NaN` is `null`.
pub fn num(f: f64) -> Value {
    serde_json::Number::from_f64(f).map_or(Value::Null, |n| {
        if f.fract() == 0.0 && f.abs() < 9_007_199_254_740_992.0 && !(f == 0.0 && f.is_sign_negative()) {
            Value::from(f as i64)
        } else {
            Value::Number(n)
        }
    })
}

/// `Math.round`: halves go up (toward +Infinity), unlike `f64::round`.
pub fn js_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

/// `Number.prototype.toFixed` for the values shown here: the exact decimal
/// value rounded half up (Rust's own formatting ties to even).
pub fn to_fixed(x: f64, digits: usize) -> String {
    if !x.is_finite() {
        return nekko_js::number_to_string(x);
    }
    let exact = format!("{:.1100}", x.abs());
    let (int, frac) = exact.split_once('.').unwrap_or((&exact, ""));
    let mut ds: Vec<u8> = int.bytes().chain(frac.bytes().take(digits)).map(|b| b - b'0').collect();
    if frac.as_bytes().get(digits).is_some_and(|d| *d >= b'5') {
        let mut i = ds.len();
        loop {
            if i == 0 {
                ds.insert(0, 1);
                break;
            }
            i -= 1;
            if ds[i] == 9 {
                ds[i] = 0;
            } else {
                ds[i] += 1;
                break;
            }
        }
    }
    let s: String = ds.iter().map(|d| char::from(b'0' + d)).collect();
    let (i, f) = s.split_at(s.len() - digits);
    let body = if digits == 0 { i.to_string() } else { format!("{i}.{f}") };
    if x < 0.0 && body.chars().any(|c| c != '0' && c != '.') { format!("-{body}") } else { body }
}
