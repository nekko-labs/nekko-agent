//! Machine probes for the engine daemon: `gpu:stats`, `system:stats` and
//! `machine:readiness`, ported from the TS host (`gpu.ts`, `system.ts`,
//! `readiness.ts` and core's `evaluateReadiness`). The parsers and the advisor
//! are held to the TS functions by `tests/golden/machine.json`, a frozen
//! record of the deleted TS behaviour.
//!
//! Also the hardware profile (`machine:profile`, `profile.rs`), the decode
//! speeds measured here (`measured.rs`) and the model recommendations made
//! against both (`machine:recommendations`, `recommend.rs`), and whether
//! someone is using the computer (`activity:state`, `activity.rs`).

pub mod activity;
pub mod measured;
pub mod nudges;
pub mod parse;
pub mod probe;
pub mod profile;
pub mod readiness;
pub mod recommend;
pub mod temps;

pub use parse::{GpuDevice, GpuStats};
pub use probe::Machine;
pub use profile::HardwareProfile;
pub use readiness::{MachineFacts, catalog, evaluate};
pub use recommend::{Recommendations, bundled_feed, recommend};

use serde_json::Value;

/// A number as a JSON value: whole numbers stay integers (`5`, never `5.0`),
/// and `NaN` and the infinities are `null`, as `JSON.stringify` prints them.
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
