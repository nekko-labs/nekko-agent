//! The engine's services for the daemon, ported from `packages/host/src/engine`
//! one at a time and held to the TS by golden sets the host writes.

pub mod catalog;

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
